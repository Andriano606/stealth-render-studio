// Юніт-тести людської поведінки (lib/human.js) на фейковій сторінці з детермінованим rng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanMove, humanClick, humanType, humanWander, humanPress, wanderCandidates } from '../lib/human.js';
import { mulberry32, rnd, rint } from '../lib/rng.js';

function fakePage() {
  const calls = [];
  return {
    calls,
    mouse: {
      async move(x, y, o) { calls.push(['move', x, y, o.steps]); },
      async down() { calls.push(['down']); },
      async up() { calls.push(['up']); },
      async wheel(dx, dy) { calls.push(['wheel', dx, dy]); },
    },
    keyboard: { async type(ch) { calls.push(['type', ch]); } },
    async waitForTimeout(ms) { calls.push(['wait', ms]); },
  };
}

test('rng: mulberry32 детермінований, rnd/rint у межах', () => {
  const a = mulberry32(7), b = mulberry32(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  const r = mulberry32(1);
  for (let i = 0; i < 200; i++) {
    const v = rnd(-22, 22, r); assert.ok(v >= -22 && v <= 22);
    const n = rint(2, 4, r); assert.ok(Number.isInteger(n) && n >= 2 && n <= 4);
  }
});

test('humanMove: кілька проміжних рухів і фінал РІВНО в ціль', async () => {
  const p = fakePage();
  const pos = await humanMove(p, { x: 0, y: 0 }, 500, 300, mulberry32(42));
  assert.deepEqual(pos, { x: 500, y: 300 });
  const moves = p.calls.filter((c) => c[0] === 'move');
  assert.ok(moves.length >= 3 && moves.length <= 5); // 2..4 хопи + фінальний
  assert.deepEqual(moves.at(-1).slice(1, 3), [500, 300]);
  // детермінізм: той самий seed → ті самі виклики
  const p2 = fakePage();
  await humanMove(p2, { x: 0, y: 0 }, 500, 300, mulberry32(42));
  assert.deepEqual(p2.calls, p.calls);
});

test('humanClick: рух, потім down → up (роздільно)', async () => {
  const p = fakePage();
  await humanClick(p, { x: 10, y: 10 }, 100, 200, mulberry32(3));
  const kinds = p.calls.map((c) => c[0]).filter((k) => k !== 'wait');
  assert.deepEqual(kinds.slice(-3), ['move', 'down', 'up']);
});

test('humanType: друкує посимвольно в правильному порядку (юнікод)', async () => {
  const p = fakePage();
  await humanType(p, 'Їжа 1', mulberry32(5));
  assert.deepEqual(p.calls.filter((c) => c[0] === 'type').map((c) => c[1]), ['Ї', 'ж', 'а', ' ', '1']);
});

test('humanWander: 1..3 скроли колесом у межах [-120, 280]', async () => {
  const p = fakePage();
  await humanWander(p, mulberry32(9));
  const wheels = p.calls.filter((c) => c[0] === 'wheel');
  assert.ok(wheels.length >= 1 && wheels.length <= 3);
  for (const w of wheels) assert.ok(w[2] >= -120 && w[2] <= 280);
});

test('humanMove single (Camoufox+humanize): рівно один mouse.move у ціль', async () => {
  const p = fakePage();
  const pos = await humanMove(p, { x: 0, y: 0 }, 300, 200, mulberry32(4), { single: true });
  assert.deepEqual(pos, { x: 300, y: 200 });
  const moves = p.calls.filter((c) => c[0] === 'move');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].slice(1, 3), [300, 200]);
});

test('humanPress: пауза → down → пауза → up у поточній позиції (без рухів)', async () => {
  const p = fakePage();
  await humanPress(p, mulberry32(5));
  assert.deepEqual(p.calls.map((c) => c[0]), ['wait', 'down', 'wait', 'up']);
});

test('wanderCandidates: точки в межах viewport, детерміновано', () => {
  const a = wanderCandidates(1280, 900, mulberry32(6)), b = wanderCandidates(1280, 900, mulberry32(6));
  assert.deepEqual(a, b);
  assert.ok(a.length >= 6);
  for (const p of a) assert.ok(p.x >= 0 && p.x < 1280 && p.y >= 0 && p.y < 900);
});

test('humanWander з нейтральною точкою: спершу миша туди, потім колесо; повертає позицію', async () => {
  const p = fakePage();
  const pos = await humanWander(p, mulberry32(9), { point: { x: 40, y: 450 }, from: { x: 300, y: 300 } });
  assert.deepEqual(pos, { x: 40, y: 450 });
  const kinds = p.calls.map((c) => c[0]).filter((k) => k !== 'wait');
  const firstWheel = kinds.indexOf('wheel');
  assert.ok(firstWheel > 0 && kinds.slice(0, firstWheel).every((k) => k === 'move'));
  assert.deepEqual(p.calls.filter((c) => c[0] === 'move').at(-1).slice(1, 3), [40, 450]);
});

test('behaviorOpts: humanize за профілем (дефолт увімк); fastPrefix — лише для префікса; singleMove — Camoufox+camoufoxHumanize', async () => {
  const { behaviorOpts } = await import('../lib/human.js');
  assert.deepEqual(behaviorOpts({}, 'replay'), { humanize: true, singleMove: false });
  assert.equal(behaviorOpts({ behavior: { humanize: false } }, 'act').humanize, false);
  const fp = { behavior: { humanize: true, fastPrefix: true } };
  assert.equal(behaviorOpts(fp, 'prefix').humanize, false);
  assert.equal(behaviorOpts(fp, 'act').humanize, true);
  assert.equal(behaviorOpts(fp, 'replay').humanize, true);
  assert.equal(behaviorOpts({ launch: { engine: 'camoufox' } }).singleMove, true);
  assert.equal(behaviorOpts({ launch: { engine: 'camoufox', camoufoxHumanize: false } }).singleMove, false);
  assert.equal(behaviorOpts({ launch: { engine: 'chromium' } }).singleMove, false);
});
