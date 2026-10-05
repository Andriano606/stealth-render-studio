// Юніт-тести детекції Cloudflare-челенджу (lib/nav.js isChallenge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChallenge, waitPastCloudflare } from '../lib/nav.js';

test('isChallenge: DOM-маркер → так, незалежно від тексту', () => {
  assert.equal(isChallenge('', '', true), true);
});

test('isChallenge: текстові ознаки в title/body (кілька мов)', () => {
  assert.equal(isChallenge('Just a moment...', '', false), true);
  assert.equal(isChallenge('', 'Checking your browser before accessing', false), true);
  assert.equal(isChallenge('Трохи зачекайте…', '', false), true);
  assert.equal(isChallenge('', 'Performing security verification', false), true);
});

test('isChallenge: звичайна сторінка → ні (у т.ч. null/undefined)', () => {
  assert.equal(isChallenge('Staff DevOps Engineer', 'Apply now', false), false);
  assert.equal(isChallenge(null, undefined, undefined), false);
});

// Фейкова сторінка: title/body задаються послідовністю станів.
function fakePage(states) {
  let i = 0;
  const cur = () => states[Math.min(i, states.length - 1)];
  return {
    calls: [],
    async title() { return cur().title; },
    async evaluate(fn) { return String(fn).includes('querySelector') ? !!cur().marker : cur().body; },
    mouse: { async move() {}, async wheel() {} },
    async waitForTimeout() { i++; },
  };
}

test('waitPastCloudflare: без челенджу → passed, wasChallenge=false', async () => {
  const r = await waitPastCloudflare(fakePage([{ title: 'Ok', body: 'hello' }]), 5000, { rng: () => 0.5 });
  assert.deepEqual(r, { passed: true, wasChallenge: false });
});

test('waitPastCloudflare: челендж зникає і зʼявляється контент → passed', async () => {
  const page = fakePage([
    { title: 'Just a moment...', body: '' },
    { title: 'Just a moment...', body: '', marker: true },
    { title: 'Jobs', body: 'x'.repeat(200) },
  ]);
  const r = await waitPastCloudflare(page, 5000, { rng: () => 0.5 });
  assert.deepEqual(r, { passed: true, wasChallenge: true });
});

test('waitPastCloudflare: челендж не зникає → таймаут, passed=false', async () => {
  const page = fakePage([{ title: 'Just a moment...', body: '' }]);
  const r = await waitPastCloudflare(page, 30, { rng: () => 0.5 });
  assert.deepEqual(r, { passed: false, wasChallenge: true });
});

test('wheelChunk / sweepAtBottom: порція 60–90% viewport (≥120 px); низ документа з допуском 2 px', async () => {
  const { wheelChunk, sweepAtBottom } = await import('../lib/nav.js');
  assert.equal(wheelChunk(1000, () => 0), 600);
  assert.equal(wheelChunk(1000, () => 0.999), 900);
  assert.equal(wheelChunk(50, () => 0), 120);
  assert.equal(sweepAtBottom({ scrollY: 3100, h: 900, sh: 4000 }), true);
  assert.equal(sweepAtBottom({ scrollY: 3098, h: 900, sh: 4000 }), true);
  assert.equal(sweepAtBottom({ scrollY: 3000, h: 900, sh: 4000 }), false);
});

// Фейкова сторінка з документом, що «догружається» внизу (lazy): колесо реально скролить.
function wheelWorld({ sh = 3000, grow = 0, h = 900, neutral = true, stuck = false } = {}) {
  const w = { y: 0, sh, wheels: [], moves: [], waits: 0, grew: false };
  const page = {
    mouse: {
      async move(x, y) { w.moves.push([x, y]); },
      async wheel(_dx, dy) { w.wheels.push(dy); if (!stuck) w.y = Math.max(0, Math.min(w.sh - h, w.y + dy)); if (!w.grew && grow && w.y + h >= w.sh - 2) { w.grew = true; w.sh += grow; } },
    },
    async waitForTimeout() { w.waits++; },
  };
  const deps = {
    async measure() { return { w: 1280, h, sh: w.sh, scrollY: w.y }; },
    async pickNeutralPoint(_p, pts) { return neutral ? pts[0] : null; },
    async waitScrollSettle() { return { settled: true, scrollY: w.y }; },
  };
  return { w, page, deps };
}

test('wheelSweep: колесом донизу (з догрузкою) і назад угору порціями; рух миші в нейтральну точку', async () => {
  const { wheelSweep } = await import('../lib/nav.js');
  const { w, page, deps } = wheelWorld({ grow: 1200 });
  const ok = await wheelSweep(page, { rng: () => 0.5, deps });
  assert.equal(ok, true);
  assert.equal(w.y, 0);                         // повернулись угору
  assert.equal(w.sh, 4200);                     // догрузка внизу врахована (дійшли до нового низу)
  assert.ok(w.wheels.some((d) => d > 0) && w.wheels.some((d) => d < 0));
  assert.ok(w.wheels.filter((d) => d < 0).length >= 2, 'угору — порціями, а не стрибком: ' + w.wheels);
  assert.ok(w.wheels.every((d) => Math.abs(d) <= 2 * 900));
  assert.equal(w.moves.length, 1);
});

test('wheelSweep: немає нейтральної точки або колесо не крутить документ → false (запасний autoScroll)', async () => {
  const { wheelSweep } = await import('../lib/nav.js');
  let x = wheelWorld({ neutral: false });
  assert.equal(await wheelSweep(x.page, { rng: () => 0.5, deps: x.deps }), false);
  assert.equal(x.w.wheels.length, 0);
  x = wheelWorld({ stuck: true });
  assert.equal(await wheelSweep(x.page, { rng: () => 0.5, deps: x.deps }), false);
  assert.ok(x.w.wheels.length <= 4);
});

test('AUTOSCROLL_FN: режим replay (eager:false) НЕ мутує DOM (loading/src); render (eager:true) — форсує lazy', async () => {
  const vm = await import('vm');
  const { AUTOSCROLL_FN } = await import('../lib/nav.js');
  const mk = () => {
    const img = { loading: 'lazy', dataset: { src: '/a.png' }, src: '' };
    const document = {
      scrollingElement: { scrollHeight: 1000 },
      querySelectorAll: (sel) => (sel === '*' ? [] : [img]),
    };
    const window = { innerHeight: 900, scrollTo() {} };
    const ctx = vm.createContext({ document, window, getComputedStyle: () => ({}), setTimeout: (f) => setImmediate(f) });
    return { img, ctx };
  };
  let { img, ctx } = mk();
  await vm.runInContext('(' + AUTOSCROLL_FN + ')({ eager: false })', ctx);
  assert.deepEqual([img.loading, img.src], ['lazy', '']);
  ({ img, ctx } = mk());
  await vm.runInContext('(' + AUTOSCROLL_FN + ')({ eager: true })', ctx);
  assert.deepEqual([img.loading, img.src], ['eager', '/a.png']);
});
