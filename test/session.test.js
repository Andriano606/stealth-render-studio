// SessionStore (lib/session.js) з фейковим годинником: ліміти/429, витіснення
// найстаршої простійної, TTL-sweep, порядок run, 409 під час prefix, 410 з причиною,
// closeAll з причинами, надгробки на 10 хв.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, SESSION_DEFAULTS } from '../lib/session.js';

function setup(opts = {}) {
  let t = 1000;
  const closed = [];
  let n = 0;
  const store = createSessionStore({
    now: () => t,
    newId: () => 's' + (++n),
    closer: async (s, reason) => { closed.push([s.sid, reason]); },
    log: { error() {} },
    ...opts,
  });
  return { store, closed, tick: (ms) => { t += ms; }, now: () => t };
}

const rejects = async (p, status, code) => {
  try { await p; } catch (e) { assert.equal(e.status, status); if (code) assert.equal(e.code, code); return e; }
  assert.fail('очікувалась помилка ' + status);
};

test('дефолти: max 2, простій 5 хв, витіснення після 60 с, надгробки 10 хв', () => {
  assert.equal(SESSION_DEFAULTS.max, 2);
  assert.equal(SESSION_DEFAULTS.idleMs, 300000);
  assert.equal(SESSION_DEFAULTS.evictIdleMs, 60000);
  assert.equal(SESSION_DEFAULTS.tombstoneMs, 600000);
});

test('create: стан prefix, поля збережено, size; markReady → ready', async () => {
  const { store } = setup();
  const s = await store.create({ engine: 'chromium', profileSig: 'abc' });
  assert.equal(s.sid, 's1');
  assert.equal(s.state, 'prefix');
  assert.equal(s.engine, 'chromium');
  assert.deepEqual(s.pending, { chooser: null, select: null });
  assert.equal(store.size, 1);
  store.markReady('s1');
  assert.equal(store.get('s1').state, 'ready');
});

test('ліміт: третя сесія → 429, якщо інші активні (простій ≤ 60 с)', async () => {
  const { store, tick } = setup();
  await store.create(); await store.create();
  store.markReady('s1'); store.markReady('s2');
  tick(59000);
  const e = await rejects(store.create(), 429, 'too_many_sessions');
  assert.equal(e.body.code, 'too_many_sessions');
  assert.equal(store.size, 2);
});

test('ліміт: витісняється НАЙСТАРША за простоєм (> 60 с), причина в надгробку', async () => {
  const { store, closed, tick } = setup();
  await store.create(); store.markReady('s1');
  tick(1000);
  await store.create(); store.markReady('s2');
  tick(70000);
  store.get('s2'); // s2 щойно «жива» (keep-alive) — простій s1 більший
  tick(1000);
  // s2 простоює лише 1 с → не кандидат; s1 простоює 71 с → витісняємо
  const s3 = await store.create();
  assert.equal(s3.sid, 's3');
  assert.deepEqual(closed.map((c) => c[0]), ['s1']);
  assert.match(store.reasonOf('s1'), /витіснено/);
  assert.equal(store.size, 2);
});

test('ліміт: зайнята (run виконується) або prefix-сесія не витісняється', async () => {
  const { store, tick } = setup();
  await store.create(); // s1 — лишається в prefix
  await store.create(); store.markReady('s2');
  let release;
  const p = store.run('s2', () => new Promise((r) => { release = r; }));
  tick(120000);
  await rejects(store.create(), 429);
  release();
  await p;
  await new Promise((r) => setImmediate(r));
  tick(61000);
  const s3 = await store.create();
  assert.equal(s3.sid, 's3');
  assert.equal(store.get('s1').state, 'prefix');
});

test('паралельні create при повному сховищі не перевищують ліміт', async () => {
  const { store, tick } = setup();
  await store.create(); await store.create();
  store.markReady('s1'); store.markReady('s2');
  tick(61000);
  const res = await Promise.allSettled([store.create(), store.create(), store.create()]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(store.size, 2);
});

test('run: дії виконуються строго по черзі, у порядку надходження; помилка не рве ланцюг', async () => {
  const { store } = setup();
  await store.create(); store.markReady('s1');
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = store.run('s1', async () => { order.push('a+'); await delay(20); order.push('a-'); return 1; });
  const b = store.run('s1', async () => { order.push('b+'); throw new Error('bad'); });
  const c = store.run('s1', async () => { order.push('c+'); await delay(5); order.push('c-'); return 3; });
  assert.equal(await a, 1);
  await assert.rejects(b, /bad/);
  assert.equal(await c, 3);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'c+', 'c-']);
});

test('run: 409 поки prefix (allowPrefix — дозволяє), 410 для невідомої', async () => {
  const { store } = setup();
  await store.create();
  const e = await rejects(store.run('s1', async () => 1), 409, 'session_busy');
  assert.equal(e.body.code, 'session_busy');
  assert.equal(await store.run('s1', async () => 7, { allowPrefix: true }), 7);
  const g = await rejects(store.run('nope', async () => 1), 410, 'session_closed');
  assert.match(g.body.reason, /невідома/);
});

test('close: 410 з причиною; дія в черзі після close — 410; close ідемпотентний', async () => {
  const { store, closed } = setup();
  await store.create(); store.markReady('s1');
  let release;
  const first = store.run('s1', () => new Promise((r) => { release = r; }));
  const queued = store.run('s1', async () => 'не має виконатись');
  await new Promise((r) => setImmediate(r)); // перша дія вже стартувала
  assert.equal(await store.close('s1', 'закрито клієнтом'), true);
  assert.equal(await store.close('s1', 'вдруге'), false);
  release('ok');
  assert.equal(await first, 'ok');
  const e = await rejects(queued, 410, 'session_closed');
  assert.equal(e.body.reason, 'закрито клієнтом');
  await rejects(store.run('s1', async () => 1), 410);
  assert.throws(() => store.require('s1'), (x) => x.status === 410 && x.body.reason === 'закрито клієнтом');
  assert.equal(store.get('s1'), null);
  assert.deepEqual(closed, [['s1', 'закрито клієнтом']]);
});

test('closeAll: усі сесії з однією причиною (напр. config changed)', async () => {
  const { store, closed } = setup();
  await store.create(); await store.create();
  assert.equal(await store.closeAll('config changed'), 2);
  assert.equal(store.size, 0);
  assert.deepEqual(closed.map((c) => c[1]), ['config changed', 'config changed']);
  assert.equal(store.reasonOf('s1'), 'config changed');
  assert.equal(store.reasonOf('s2'), 'config changed');
});

test('sweep: простій > 5 хв закриває сесію; keep-alive (get) продовжує життя; prefix не чіпаємо', async () => {
  const { store, closed, tick } = setup();
  await store.create(); store.markReady('s1');
  await store.create(); store.markReady('s2');
  tick(200000);
  store.get('s2'); // keep-alive
  tick(150000);    // s1: 350 с простою, s2: 150 с
  assert.equal(await store.sweep(), 1);
  assert.deepEqual(closed.map((c) => c[0]), ['s1']);
  assert.match(store.reasonOf('s1'), /простій/);
  assert.ok(store.get('s2'));
});

test('надгробки зберігаються 10 хв, потім — «невідома сесія»', async () => {
  const { store, tick } = setup();
  await store.create(); store.markReady('s1');
  await store.close('s1', 'config changed');
  tick(599000); await store.sweep();
  assert.equal(store.reasonOf('s1'), 'config changed');
  tick(2000); await store.sweep();
  assert.equal(store.reasonOf('s1'), null);
  const e = await rejects(store.run('s1', async () => 1), 410);
  assert.match(e.body.reason, /невідома/);
});

test('дефолтний closer кличе s.dispose(reason); помилка closer не ламає close', async () => {
  const errors = [];
  const store = createSessionStore({ log: { error: (...a) => errors.push(a.join(' ')) } });
  const got = [];
  const s = await store.create();
  s.dispose = async (r) => { got.push(r); throw new Error('boom'); };
  assert.equal(await store.close(s.sid, 'test'), true);
  assert.deepEqual(got, ['test']);
  assert.equal(errors.length, 1);
});

test('start/stop: таймер sweep — unref (не тримає процес), повторний start не дублює', () => {
  const { store } = setup();
  store.start(10);
  store.start(10);
  store.stop();
  store.stop();
});

// ---------- межа часу дії (зависла сторінка не тримає слот вічно) ----------

function timers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; list.push(h); return h; },
    clearTimer: (h) => { if (h) h.live = false; },
    fire: () => { for (const h of list.splice(0)) if (h.live) h.fn(); },
  };
}

test('run: дія зависла довше timeoutMs → 504 act_timeout, сесію закрито з причиною, слот звільнено', async () => {
  const tm = timers();
  const { store, closed } = setup({ setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const s1 = await store.create(); store.markReady(s1.sid);
  const s2 = await store.create(); store.markReady(s2.sid);
  const hung = store.run(s1.sid, () => new Promise(() => {}), { timeoutMs: 1000 });
  const queued = store.run(s1.sid, async () => 'never');
  await new Promise((r) => setImmediate(r));
  assert.equal(tm.list[0].ms, 1000);
  tm.fire();
  const e = await rejects(hung, 504, 'act_timeout');
  assert.match(e.body.reason, /зависла/);
  await rejects(queued, 410, 'session_closed'); // дія в черзі за завислою — 410, сторінки не чіпає
  assert.ok(closed.some(([sid, r]) => sid === s1.sid && /зависла/.test(r)));
  assert.equal(store.size, 1);
  await store.create(); // місце звільнилось (раніше — 429 назавжди)
});

test('run: дефолтна межа = actTimeoutMs; вчасна дія — таймер знято, сесія жива', async () => {
  const tm = timers();
  const { store, closed } = setup({ setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  const s = await store.create(); store.markReady(s.sid);
  assert.equal(await store.run(s.sid, async () => 7), 7);
  assert.equal(tm.list[0].ms, SESSION_DEFAULTS.actTimeoutMs);
  assert.equal(tm.list[0].live, false);
  tm.fire();
  assert.equal(closed.length, 0);
  assert.equal(store.size, 1);
});

test('sweep: зайнята сесія з дією, що пережила межу (таймер загубився) → закрито; timeoutMs Infinity — ніколи', async () => {
  const { store, closed, tick } = setup({ setTimer: () => null, clearTimer: () => {} });
  const a = await store.create(); store.markReady(a.sid);
  const b = await store.create(); store.markReady(b.sid);
  store.run(a.sid, () => new Promise(() => {}), { timeoutMs: 1000 }).catch(() => {});
  store.run(b.sid, () => new Promise(() => {}), { timeoutMs: Infinity }).catch(() => {});
  await new Promise((r) => setImmediate(r));
  tick(1000 + SESSION_DEFAULTS.sweepMs + 1);
  assert.equal(await store.sweep(), 1);
  assert.deepEqual(closed.map(([sid]) => sid), [a.sid]);
  tick(3600000);
  await store.sweep();
  assert.ok(store.get(b.sid), 'довгий прогін без межі не закривається sweep-ом, поки зайнятий');
});

test('run: черга сесії обмежена maxQueue → 429 session_queue_full', async () => {
  const { store } = setup({ maxQueue: 2, setTimer: () => null, clearTimer: () => {} });
  const s = await store.create(); store.markReady(s.sid);
  store.run(s.sid, () => new Promise(() => {})).catch(() => {});
  store.run(s.sid, async () => 1).catch(() => {});
  await rejects(store.run(s.sid, async () => 1), 429, 'session_queue_full');
});

test('run: дія впала «сирою» помилкою, бо сесію закрили посеред неї → 410 session_closed (не 500); статусні помилки — як є', async () => {
  const { store } = setup();
  await store.create(); store.markReady('s1');
  let fail;
  const p = store.run('s1', () => new Promise((_r, rej) => { fail = rej; }));
  await new Promise((r) => setImmediate(r));
  await store.close('s1', 'закрито клієнтом');
  fail(new Error('page.screenshot: Target page, context or browser has been closed'));
  const e = await rejects(p, 410, 'session_closed');
  assert.equal(e.body.reason, 'закрито клієнтом');
  // Помилка зі статусом (валідація 4xx) не підміняється навіть після закриття.
  await store.create(); store.markReady('s2');
  let fail2;
  const p2 = store.run('s2', () => new Promise((_r, rej) => { fail2 = rej; }));
  await new Promise((r) => setImmediate(r));
  await store.close('s2', 'x');
  fail2(Object.assign(new Error('bad'), { status: 400 }));
  await rejects(p2, 400);
  // Жива сесія: сира помилка лишається сирою (без статусу).
  await store.create(); store.markReady('s3');
  await assert.rejects(store.run('s3', async () => { throw new Error('boom'); }), (x) => x.message === 'boom' && !x.status);
});
