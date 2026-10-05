// Тести HTTP-клієнта живої сесії (public/js/live-client.js) з фейковим fetch/таймерами:
// відкриття через NDJSON, черга дій (одна в польоті, злиття, ліміт), опитування лише
// коли вкладка видима і черга порожня (з ?h=hash), 409-повтор, 410 → closed,
// sessionStorage + attach, sendBeacon, close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient, readSavedSession, LIVE_STORE_KEY } from '../public/js/live-client.js';

const memStore = () => {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), m };
};
function fakeTimers() {
  let seq = 0;
  const q = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { q.delete(id); },
    async run(filter = () => true) {
      const all = [...q.entries()].filter(([, t]) => filter(t));
      for (const [id] of all) q.delete(id);
      for (const [, t] of all) await t.fn();
    },
    get list() { return [...q.values()]; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ndRes = (events) => new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200 });
const LIVE_EV = { event: 'live', sid: 'S1', engine: 'chromium', vp: { w: 1280, h: 900, scrollX: 0, scrollY: 0 }, shot: 'data:image/jpeg;base64,AA', hash: 'h1', url: 'http://fx/a', title: 'A' };

// fetch-фейк: handler(url, init) → Response | Promise<Response>; лог викликів.
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const c = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    return handler(c);
  };
  f.calls = calls;
  return f;
}

function mk(handler, extra = {}) {
  const timers = fakeTimers();
  const store = memStore();
  const events = [];
  const fetchImpl = fakeFetch(handler);
  let visible = true;
  const beacons = [];
  const client = createLiveClient({
    fetchImpl, store, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    isVisible: () => visible, beacon: (u) => { beacons.push(u); return true; },
    onEvent: (type, p) => events.push([type, p]), retryMs: 5, ...extra,
  });
  return { client, timers, store, events, fetchImpl, beacons, setVisible: (v) => { visible = v; } };
}

test('open: NDJSON-потік → live; sid у sessionStorage; snap-подія; старт опитування', async () => {
  const seen = [];
  const t = mk((c) => (c.url === '/live' ? ndRes([{ event: 'session', sid: 'S1' }, { event: 'status', text: 'x' }, LIVE_EV]) : jsonRes(200, {})));
  const live = await t.client.open({ url: 'http://fx/a', actions: [{ type: 'click' }], recId: 7 }, (e) => seen.push(e.event), { meta: { pageId: 1, recId: 7 } });
  assert.equal(live.sid, 'S1');
  assert.deepEqual(seen, ['session', 'status', 'live']);
  assert.deepEqual(t.fetchImpl.calls[0].body, { url: 'http://fx/a', actions: [{ type: 'click' }], recId: 7 });
  assert.equal(t.client.sid, 'S1');
  assert.equal(t.client.hash, 'h1');
  assert.equal(t.client.engine, 'chromium');
  const snap = t.events.find(([k]) => k === 'snap')[1];
  assert.equal(snap.shot, LIVE_EV.shot);
  const saved = readSavedSession(t.store);
  assert.equal(saved.sid, 'S1');
  assert.equal(saved.pageId, 1);
  assert.equal(saved.recId, 7);
  assert.equal(t.timers.list.length, 1, 'опитування заплановано');
  assert.equal(t.timers.list[0].ms, 1500);
});

test('open: подія error у потоці → ApiError (closed за кодом); sessionStorage прибрано', async () => {
  const t = mk(() => ndRes([{ event: 'session', sid: 'S2' }, { event: 'error', message: 'Сесію закрито під час відкриття: config changed', code: 'session_closed', reason: 'config changed' }]));
  await assert.rejects(t.client.open({ url: 'x' }), (e) => e.status === 410 && e.body.reason === 'config changed');
  assert.equal(readSavedSession(t.store), null);
  assert.equal(t.client.closed, true);
});

test('open: 429 до початку потоку → ApiError 429', async () => {
  const t = mk(() => jsonRes(429, { ok: false, error: 'Забагато живих сесій', code: 'too_many_sessions' }));
  await assert.rejects(t.client.open({ url: 'x' }), (e) => e.status === 429 && /Забагато/.test(e.message));
});

async function opened(handler, extra) {
  const t = mk((c) => (c.url === '/live' ? ndRes([{ event: 'session', sid: 'S1' }, LIVE_EV]) : handler(c)), extra);
  await t.client.open({ url: 'http://fx/a' });
  return t;
}

test('черга: одна дія в польоті, решта чекають; h і k у тілі; відповідь оновлює hash/vp', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const t = await opened(async (c) => {
    if (c.url.endsWith('/act')) {
      n++;
      if (n === 1) await gate;
      return jsonRes(200, { ok: true, step: { id: 's' + n, type: c.body.type }, hash: 'h' + (n + 1), vp: { w: 1280, h: 900, scrollX: 0, scrollY: n * 10 }, url: 'http://fx/a', logs: [{ kind: 'info', text: 'l' + n }] });
    }
    return jsonRes(200, {});
  });
  const p1 = t.client.act({ type: 'click', vx: 1, vy: 2 });
  const p2 = t.client.act({ type: 'key', key: 'Enter' });
  await tick();
  const acts = () => t.fetchImpl.calls.filter((c) => c.url.endsWith('/act'));
  assert.equal(acts().length, 1, 'друга чекає, поки перша в польоті');
  assert.equal(t.client.busy, true);
  assert.deepEqual(t.events.filter(([k]) => k === 'busy').map(([, v]) => v), [true]);
  assert.equal(acts()[0].body.h, 'h1');
  assert.equal(acts()[0].body.rec, true);
  assert.ok(acts()[0].body.k > 0);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.step.id, 's1');
  assert.equal(r2.step.id, 's2');
  assert.equal(acts()[1].body.h, 'h2', 'друга дія шле hash після першої');
  assert.equal(t.client.hash, 'h3');
  assert.equal(t.client.vp.scrollY, 20);
  assert.equal(t.client.busy, false);
  assert.deepEqual(t.events.filter(([k]) => k === 'busy').map(([, v]) => v), [true, false]);
  assert.equal(t.events.filter(([k]) => k === 'logs').length, 2);
});

test('черга: сусідні text/scroll зливаються в один запит; обидва проміси отримують відповідь', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await opened(async (c) => {
    if (c.url.endsWith('/act')) { if (c.body.type === 'click') await gate; return jsonRes(200, { ok: true, step: { type: c.body.type, text: c.body.text } }); }
    return jsonRes(200, {});
  });
  const pc = t.client.act({ type: 'click', vx: 1, vy: 1 });
  const a = t.client.enqueueAct({ type: 'text', text: 'ab' }, { sub: 'A' });
  const b = t.client.enqueueAct({ type: 'text', text: 'c' }, { sub: 'B' });
  assert.equal(a.merged, false);
  assert.equal(b.merged, true);
  assert.equal(b.item.meta.sub, 'A', 'метадані першого елемента лишаються');
  assert.equal(b.item.body.text, 'abc');
  release();
  await pc;
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  assert.equal(ra, rb);
  const texts = t.fetchImpl.calls.filter((c) => c.url.endsWith('/act') && c.body.type === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].body.text, 'abc');
});

test('черга: понад 10 очікуючих → dropped і відхилення', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await opened(async (c) => { if (c.url.endsWith('/act')) { await gate; return jsonRes(200, { ok: true }); } return jsonRes(200, {}); });
  const ps = [];
  for (let i = 0; i < 11; i++) ps.push(t.client.act({ type: 'click', vx: i, vy: i }));
  const extra = t.client.act({ type: 'click', vx: 99, vy: 99 });
  await assert.rejects(extra, (e) => e.status === 429 && e.body.code === 'client_queue_full');
  assert.equal(t.events.filter(([k]) => k === 'dropped').length, 1);
  release();
  await Promise.all(ps);
});

test('409 (сесія ще відкривається) → повтор; 410 → closed, черга відхилена, storage прибрано', async () => {
  let n = 0;
  const t = await opened((c) => {
    if (c.url.endsWith('/act')) {
      n++;
      if (n === 1) return jsonRes(409, { ok: false, error: 'busy', code: 'session_busy' });
      if (n === 2) return jsonRes(200, { ok: true, step: { type: 'click' } });
      return jsonRes(410, { ok: false, error: 'Сесію закрито: config changed', code: 'session_closed', reason: 'config changed' });
    }
    return jsonRes(200, {});
  });
  const p1 = t.client.act({ type: 'click', vx: 1, vy: 1 });
  await tick(); await t.timers.run((x) => x.ms === 5); // пауза повтору
  const r1 = await p1;
  assert.equal(r1.ok, true);
  const p2 = t.client.act({ type: 'key', key: 'a' });
  const p3 = t.client.act({ type: 'key', key: 'b' });
  await assert.rejects(p2, (e) => e.status === 410);
  await assert.rejects(p3, (e) => e.status === 410);
  const closed = t.events.filter(([k]) => k === 'closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0][1].reason, 'config changed');
  assert.equal(t.client.closed, true);
  assert.equal(readSavedSession(t.store), null);
  await assert.rejects(t.client.act({ type: 'click', vx: 1, vy: 1 }), (e) => e.status === 410);
  assert.equal(t.timers.list.filter((x) => x.ms === 1500).length, 0, 'опитування зупинено');
});

test('опитування: лише коли вкладка видима і черга порожня; ?h=hash; configChanged → подія', async () => {
  const t = await opened((c) => {
    if (c.url.includes('/shot')) return jsonRes(200, { ok: true, hash: 'h1', vp: LIVE_EV.vp, url: 'http://fx/a', title: 'A', configChanged: true, logs: [] });
    return jsonRes(200, {});
  });
  t.setVisible(false);
  await t.timers.run();
  assert.equal(t.fetchImpl.calls.filter((c) => c.url.includes('/shot')).length, 0, 'прихована вкладка — без запитів');
  assert.equal(t.timers.list.length, 1, 'але таймер перепланувався');
  t.setVisible(true);
  await t.timers.run();
  const shots = t.fetchImpl.calls.filter((c) => c.url.includes('/shot'));
  assert.equal(shots.length, 1);
  assert.equal(shots[0].url, '/live/S1/shot?h=h1');
  assert.deepEqual(t.events.filter(([k]) => k === 'config').map(([, v]) => v), [true]);
  const snaps = t.events.filter(([k]) => k === 'snap');
  assert.equal(snaps.at(-1)[1].shot, undefined, 'без shot, коли хеш не змінився');
});

test('опитування: 410 → closed з причиною', async () => {
  const t = await opened((c) => (c.url.includes('/shot') ? jsonRes(410, { ok: false, error: 'x', code: 'session_closed', reason: 'дія зависла' }) : jsonRes(200, {})));
  await t.timers.run();
  assert.deepEqual(t.events.filter(([k]) => k === 'closed').map(([, v]) => v.reason), ['дія зависла']);
  assert.equal(t.timers.list.length, 0);
});

test('nav: у тій самій черзі (POST /live/:sid/nav з action/url/h)', async () => {
  const t = await opened((c) => jsonRes(200, { ok: true, hash: 'h9', url: 'http://fx/b' }));
  const r = await t.client.nav('goto', 'http://fx/b');
  assert.equal(r.ok, true);
  const nav = t.fetchImpl.calls.find((c) => c.url === '/live/S1/nav');
  assert.deepEqual(nav.body, { action: 'goto', url: 'http://fx/b', h: 'h1' });
  assert.equal(t.client.url, 'http://fx/b');
  await t.client.nav('back');
  assert.deepEqual(t.fetchImpl.calls.at(-1).body, { action: 'back', h: 'h9' });
});

test('inspect: лише коли черга порожня; інакше null без запиту', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await opened(async (c) => {
    if (c.url.includes('/inspect')) return jsonRes(200, { ok: true, box: { x: 1, y: 2, w: 3, h: 4 }, desc: 'кнопка' });
    if (c.url.endsWith('/act')) { await gate; return jsonRes(200, { ok: true }); }
    return jsonRes(200, {});
  });
  const r = await t.client.inspect(10.4, 20.6);
  assert.equal(r.desc, 'кнопка');
  assert.equal(t.fetchImpl.calls.at(-1).url, '/live/S1/inspect?x=10&y=21');
  const p = t.client.act({ type: 'click', vx: 1, vy: 1 });
  assert.equal(await t.client.inspect(1, 1), null);
  release(); await p;
});

test('whenIdle, close (DELETE, без події closed), beaconClose', async () => {
  const t = await opened((c) => jsonRes(200, { ok: true }));
  assert.equal(await t.client.whenIdle(), true);
  assert.equal(t.client.beaconClose(), true);
  assert.deepEqual(t.beacons, ['/live/S1/close']);
  assert.ok(readSavedSession(t.store), 'після beacon запис лишається — для спроби reattach');
  await t.client.close();
  assert.equal(t.fetchImpl.calls.at(-1).method, 'DELETE');
  assert.equal(t.fetchImpl.calls.at(-1).url, '/live/S1');
  assert.equal(t.events.filter(([k]) => k === 'closed').length, 0);
  assert.equal(readSavedSession(t.store), null);
  assert.equal(t.client.beaconClose(), false, 'закрита сесія — без beacon');
});

test('attach: GET /shot без h → snap + опитування; 410 → помилка і очищення', async () => {
  const t = mk((c) => (c.url === '/live/S5/shot' ? jsonRes(200, { ok: true, hash: 'z', shot: 'data:x', vp: LIVE_EV.vp, url: 'u' }) : jsonRes(410, { ok: false, error: 'x', code: 'session_closed', reason: 'закрито клієнтом' })));
  const r = await t.client.attach('S5', { pageId: 3, recId: 4, engine: 'camoufox' });
  assert.equal(r.hash, 'z');
  assert.equal(t.client.sid, 'S5');
  assert.equal(t.client.engine, 'camoufox');
  assert.equal(readSavedSession(t.store).pageId, 3);
  t.client.setMeta({ recId: 9 });
  assert.equal(readSavedSession(t.store).recId, 9);
  const t2 = mk(() => jsonRes(410, { ok: false, error: 'x', code: 'session_closed', reason: 'закрито клієнтом' }));
  t2.store.set(LIVE_STORE_KEY, JSON.stringify({ sid: 'S6' }));
  await assert.rejects(t2.client.attach('S6', {}), (e) => e.status === 410 && e.body.reason === 'закрито клієнтом');
  assert.equal(readSavedSession(t2.store), null);
});

test('readSavedSession: битий JSON / без sid → null', () => {
  const s = memStore();
  assert.equal(readSavedSession(s), null);
  s.set(LIVE_STORE_KEY, '{bad');
  assert.equal(readSavedSession(s), null);
  s.set(LIVE_STORE_KEY, JSON.stringify({ pageId: 1 }));
  assert.equal(readSavedSession(s), null);
});

test('close(): DELETE лише після опитування /shot, що вже в польоті; застарілий кадр після close не емітиться', async () => {
  let releaseShot;
  const shotGate = new Promise((r) => { releaseShot = r; });
  const order = [];
  const t = mk(async (c) => {
    if (c.url === '/live') return ndRes([{ event: 'session', sid: 'S1' }, LIVE_EV]);
    if (c.url.startsWith('/live/S1/shot')) { order.push('shot:start'); await shotGate; order.push('shot:end'); return jsonRes(200, { ok: true, hash: 'h2', shot: 'data:new', vp: LIVE_EV.vp, url: 'http://fx/b' }); }
    if (c.method === 'DELETE') { order.push('delete'); return jsonRes(200, { ok: true, closed: true }); }
    return jsonRes(200, {});
  });
  await t.client.open({ url: 'http://fx/a' });
  const pollRun = t.timers.run(); // tick() → GET /shot (висить)
  await tick();
  assert.deepEqual(order, ['shot:start']);
  const closeP = t.client.close();
  await tick(); await tick();
  assert.deepEqual(order, ['shot:start'], 'DELETE чекає на опитування в польоті');
  const snapsBefore = t.events.filter(([k]) => k === 'snap').length;
  releaseShot();
  assert.equal(await closeP, true);
  await pollRun;
  assert.deepEqual(order, ['shot:start', 'shot:end', 'delete']);
  assert.equal(t.events.filter(([k]) => k === 'snap').length, snapsBefore, 'після close — без snap');
  assert.equal(t.events.some(([k]) => k === 'closed'), false, 'явне закриття — без події closed');
});

test('close(): дія в польоті завершилась після close → її проміс розвʼязано, але snap не емітиться', async () => {
  let releaseAct;
  const gate = new Promise((r) => { releaseAct = r; });
  const t = mk(async (c) => {
    if (c.url === '/live') return ndRes([{ event: 'session', sid: 'S1' }, LIVE_EV]);
    if (c.url === '/live/S1/act') { await gate; return jsonRes(200, { ok: true, step: { id: 's1' }, hash: 'h9', shot: 'data:late' }); }
    return jsonRes(200, { ok: true });
  });
  await t.client.open({ url: 'http://fx/a' });
  const { promise } = t.client.enqueueAct({ type: 'click', vx: 1, vy: 1 });
  await tick();
  const n = t.events.filter(([k]) => k === 'snap').length;
  await t.client.close();
  releaseAct();
  const res = await promise;
  assert.equal(res.step.id, 's1');
  assert.equal(t.events.filter(([k]) => k === 'snap').length, n);
});
