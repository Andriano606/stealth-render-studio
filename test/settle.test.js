// Юніт-тести очікувань (lib/settle.js): мережевий спокій на фейковому емітері + годиннику,
// заспокоєння прокрутки на фейковій сторінці.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createNetTracker, waitQuiet, waitScrollSettle } from '../lib/settle.js';

function fakeClock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    async sleep(ms) {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const nx = timers.shift(); t = nx.at; nx.fn();
      }
      t = until;
    },
    at(ms, fn) { timers.push({ at: t + ms, fn }); },
  };
}

function setup() {
  const em = new EventEmitter();
  const clock = fakeClock();
  const tr = createNetTracker(em, { now: clock.now });
  return { em, clock, tr, wq: (o) => waitQuiet(tr, o, clock) };
}

test('waitQuiet: тиша → повертається після minMs', async () => {
  const { wq } = setup();
  const r = await wq({ minMs: 150, quietMs: 300, maxMs: 2500 });
  assert.equal(r.quiet, true);
  assert.ok(r.ms >= 150 && r.ms < 200, String(r.ms));
});

test('waitQuiet: запит у польоті → чекаємо його + quietMs', async () => {
  const { em, clock, wq } = setup();
  const req = {};
  clock.at(20, () => em.emit('request', req));
  clock.at(700, () => em.emit('requestfinished', req));
  const r = await wq({ minMs: 150, quietMs: 300, maxMs: 2500 });
  assert.equal(r.quiet, true);
  assert.ok(r.ms >= 1000 && r.ms <= 1060, String(r.ms));
});

test('waitQuiet: requestfailed теж завершує запит', async () => {
  const { em, clock, wq } = setup();
  const req = {};
  clock.at(0, () => em.emit('request', req));
  clock.at(400, () => em.emit('requestfailed', req));
  const r = await wq({});
  assert.equal(r.quiet, true);
  assert.ok(r.ms >= 700 && r.ms < 800, String(r.ms));
});

test('waitQuiet: безкінечна активність → обмеження maxMs', async () => {
  const { em, clock, wq } = setup();
  for (let k = 0; k < 100; k++) clock.at(k * 100, () => em.emit('request', {}));
  const r = await wq({ minMs: 150, quietMs: 300, maxMs: 2500 });
  assert.equal(r.quiet, false);
  assert.ok(r.ms >= 2500 && r.ms < 2600);
});

test('waitQuiet: «довгожителі» (long-poll/SSE) старші за 3с ігноруються', async () => {
  const { em, clock, tr, wq } = setup();
  em.emit('request', { sse: true }); // ніколи не завершиться
  assert.equal(tr.pending(3000), 1);
  await clock.sleep(3500);
  assert.equal(tr.pending(3000), 0);
  const r = await wq({ minMs: 150, quietMs: 300, maxMs: 2500 });
  assert.equal(r.quiet, true);
  assert.ok(r.ms < 200);
});

test('waitQuiet: свіжий довгий запит тримає до своїх 3с, потім ігнорується', async () => {
  const { em, clock, wq } = setup();
  clock.at(0, () => em.emit('request', {}));
  const r = await wq({ minMs: 150, quietMs: 300, maxMs: 5000, ignoreOlderMs: 3000 });
  assert.equal(r.quiet, true);
  assert.ok(r.ms >= 3000 && r.ms < 3100, String(r.ms));
});

test('waitQuiet: signal.aborted → одразу вихід; без трекера — лише minMs', async () => {
  const { wq, clock } = setup();
  const ac = new AbortController(); ac.abort();
  const r = await waitQuiet(null, {}, { ...clock, signal: ac.signal });
  assert.equal(r.aborted, true);
  const r2 = await waitQuiet(null, { minMs: 100 }, clock);
  assert.equal(r2.quiet, true);
  await wq({});
});

test('createNetTracker: dispose знімає слухачі', () => {
  const { em, tr } = setup();
  assert.equal(em.listenerCount('request'), 1);
  tr.dispose();
  assert.equal(em.listenerCount('request'), 0);
  assert.equal(em.listenerCount('requestfinished'), 0);
  assert.equal(em.listenerCount('requestfailed'), 0);
});

test('waitScrollSettle: чекає, доки scrollY однаковий 2 кадри поспіль', async () => {
  const seq = [0, 400, 900, 1300, 1500, 1500, 1500];
  let i = 0;
  const page = { async evaluate() { return seq[Math.min(i++, seq.length - 1)]; } };
  const r = await waitScrollSettle(page, { maxMs: 1000 });
  assert.deepEqual([r.settled, r.scrollY], [true, 1500]);
  assert.equal(i, 6);
});

test('waitScrollSettle: ліміт часу та помилка evaluate', async () => {
  let t = 0, y = 0;
  const now = () => t;
  const page = { async evaluate() { t += 16; return (y += 10); } };
  const r = await waitScrollSettle(page, { maxMs: 100 }, { now });
  assert.equal(r.settled, false);
  assert.ok(r.ms >= 100);
  const bad = { async evaluate() { throw new Error('Execution context was destroyed'); } };
  const r2 = await waitScrollSettle(bad, {});
  assert.equal(r2.settled, false);
});

test('waitScrollSettle: minMs — не вірити раннім однаковим вимірам (колесо стартує із затримкою)', async () => {
  let t = 0;
  const ys = [0, 0, 0, 120, 240, 280, 280];
  let i = 0;
  const page = { async evaluate() { t += 20; return ys[Math.min(i++, ys.length - 1)]; } };
  const r = await waitScrollSettle(page, { minMs: 100, maxMs: 1000 }, { now: () => t });
  assert.equal(r.scrollY, 280);
});
