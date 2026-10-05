// Тести циклу відтворення (lib/replay.js) без браузера: «фейковий світ» з геометрією
// сторінки (скрол, елементи в документі, фіксовані елементи) + інʼєкція dom/clock.
// Частина — характеризація на РЕАЛЬНИХ legacy-даних (анонімізований зріз сценаріїв).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { EventEmitter } from 'events';
import { runReplay, replayActions, pauseAfter } from '../lib/replay.js';
import { scrollPlan, nearestRect } from '../lib/coords.js';
import { mulberry32, rint } from '../lib/rng.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-scenario.json', import.meta.url), 'utf8'));

// Як runPage у UI (public/js/scenarioModel.js → flattenScenario): пласкі під-дії з gid = id Дії.
function flatten(recs, { skipMoves }) {
  const flat = [];
  for (const rec of recs) for (const a of rec.subs) {
    if (skipMoves && a.type === 'move') continue;
    flat.push({ ...a, gid: rec.id });
  }
  return flat;
}

// Фейковий годинник із плануванням подій (sleep просуває час і запускає таймери).
function fakeClock() {
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    async sleep(ms) {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const nx = timers[0];
        if (!nx || nx.at > until) break;
        timers.shift(); t = nx.at; nx.fn();
      }
      t = until;
    },
    at(ms, fn) { timers.push({ at: t + ms, fn }); },
  };
  return clock;
}

// Світ: viewport, документ, елементи (doc-координати; fixed — у координатах viewport).
function fakeWorld(opts = {}) {
  const w = {
    vw: 1280, vh: 900, dpr: 2, sw: 1265, pageH: 6000, scrollY: 0,
    topInset: 0, bottomInset: 0,
    els: [], // { id, x, y, w, h, tag, interactive, fixed }
    focusEditable: true, fileInputs: 0,
    scrolls: [], presses: [], moves: [], typed: [], keys: [], evaluates: 0,
    onFirstMoveAfterScroll: null,
    ...opts,
  };
  // sticky: { stick } — елемент «прилипає», коли scrollY > stick (його viewport-y = y − min(scrollY, stick)).
  const vyOf = (e) => (e.fixed ? e.y : e.sticky ? e.y - Math.min(w.scrollY, e.sticky.stick) : e.y - w.scrollY);
  const at = (vx, vy) => {
    // фіксовані і sticky — поверх
    for (const e of w.els) if ((e.fixed || e.sticky) && vx >= e.x && vx <= e.x + e.w && vy >= vyOf(e) && vy <= vyOf(e) + e.h) return e;
    const dy = vy + w.scrollY;
    let best = null;
    for (const e of w.els) if (!e.fixed && !e.sticky && vx >= e.x && vx <= e.x + e.w && dy >= e.y && dy <= e.y + e.h) best = e; // пізніший — глибший
    return best;
  };
  w.at = at;
  w.dom = {
    async measure() { return { w: w.vw, h: w.vh, dpr: w.dpr, sw: w.sw, sh: w.pageH, scrollY: w.scrollY, topInset: w.topInset, bottomInset: w.bottomInset }; },
    async readScrollY() { return w.scrollY; },
    async scrollDocTo(_p, docY, { m } = {}) {
      const plan = scrollPlan(docY, w.scrollY, w.vh, w.pageH, { topInset: w.topInset, bottomInset: w.bottomInset });
      if (plan.scroll) { w.scrolls.push(plan.scrollY); w.scrollY = plan.scrollY; w.justScrolled = true; }
      return { scrollY: w.scrollY, scrolled: plan.scroll, m };
    },
    async elementAt(_p, vx, vy) {
      if (vx < 0 || vy < 0 || vx >= w.vw || vy >= w.vh) return null;
      const e = at(vx, vy);
      if (!e) return { tag: 'BODY', interactive: false, text: '' };
      return { tag: e.tag || 'DIV', interactive: !!e.interactive, fixed: !!e.fixed, sticky: !!e.sticky, text: e.id, frame: 'main' };
    },
    async snapToClickable(_p, vx, vy, maxDist = 60) {
      const rects = w.els.filter((e) => e.interactive).map((e) => ({ x: e.x, y: vyOf(e), w: e.w, h: e.h }));
      return nearestRect(vx, vy, rects, maxDist);
    },
    async waitScrollSettle() { return { settled: true, scrollY: w.scrollY }; },
    async pickNeutralPoint(_p, pts) { return pts[0]; },
    async focusIsEditable() { return w.focusEditable; },
    async collectFileInputs() {
      return Array.from({ length: w.fileInputs }, (_, i) => ({ async setInputFiles(p) { w.files = [i, p]; } }));
    },
  };
  return w;
}

function fakePage(w) {
  const em = new EventEmitter();
  const mainFrame = { name: 'main', async evaluate() { return 100; } };
  let mouse = { x: 0, y: 0 };
  const page = Object.assign(em, {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
    async waitForTimeout() {},
    async waitForLoadState(s) { w.loadStates = (w.loadStates || []).concat(s); },
    async title() { return 'T'; },
    async evaluate(fn) { return String(fn).includes('querySelector') ? false : 'body'; },
    isClosed: () => false,
    mouse: {
      async move(x, y) {
        if (w.justScrolled && w.onFirstMoveAfterScroll) { w.justScrolled = false; w.onFirstMoveAfterScroll(w); }
        mouse = { x, y }; w.moves.push([x, y]);
      },
      async down() {},
      async up() {
        const hit = w.at(mouse.x, mouse.y);
        w.presses.push({ vx: mouse.x, vy: mouse.y, docY: mouse.y + w.scrollY, id: hit ? hit.id : null, page: page.tag });
        if (w.onPress) w.onPress(page, mouse);
      },
      async click() { throw new Error('mouse.click не має викликатись (down/up після hit-test)'); },
      async wheel(dx, dy) { w.wheels = (w.wheels || 0) + 1; w.scrollY = Math.max(0, w.scrollY + dy); },
    },
    keyboard: {
      async type(t) { w.typed.push(t); },
      async press(k) { w.keys.push(k); if (w.onKey) w.onKey(page, k); },
    },
  });
  page.tag = 'p0';
  return page;
}

async function run(actions, { world, humanize = false, resolveUpload, signal, ctx, clock } = {}) {
  const w = world || fakeWorld();
  const page = fakePage(w);
  if (ctx) page.context = () => ctx;
  const events = [];
  const c = clock || fakeClock();
  const res = await runReplay(page, actions, {
    send: (e) => events.push(e), humanize, signal,
    resolveUpload: resolveUpload || (() => '/uploads/x/cv.pdf'),
    rng: mulberry32(1), dom: w.dom, clock: c,
  });
  return { w, page, events, res, logs: events.filter((e) => e.event === 'log').map((e) => e.text) };
}

// ---------- характеризація на legacy-даних ----------

test('legacy: на кожну під-дію — action, потім done-action, по порядку; done-action має strategy/ms', async () => {
  const actions = flatten(fixture.recs, { skipMoves: false });
  const { events, res } = await run(actions, { world: fakeWorld({ fileInputs: 1 }) });
  const steps = events.filter((e) => e.event === 'action' || e.event === 'done-action');
  assert.equal(steps.length, actions.length * 2);
  steps.forEach((e, k) => {
    assert.equal(e.index, Math.floor(k / 2));
    assert.equal(e.event, k % 2 ? 'done-action' : 'action');
  });
  assert.equal(res.replayed, actions.length);
  const dones = steps.filter((e) => e.event === 'done-action');
  for (const d of dones) { assert.equal(typeof d.ms, 'number'); assert.ok('strategy' in d); }
  dones.filter((d) => actions[d.index].type === 'click').forEach((d) => assert.ok(['coord', 'snap'].includes(d.strategy)));
});

// Очікувані CSS-координати натискань — ЛІТЕРАЛИ, виведені вручну з фікстури (не через
// toDocCoords, інакше тест перевіряв би реалізацію саму проти себе). Світ: scrollW=1265,
// DPR 2. Записи з sw=2530 → ×(1265/2530 = 0.5), Math.round (.5 — угору); Дія 9 без sw — CSS як є.
const LEGACY_EXPECTED = [ // [gid, cssX, docY]
  [9, 991, 719],
  [31, 715, 144], // 1430,287 @ sw 2530
  [32, 559, 414], [32, 518, 517], [32, 525, 621], [32, 534, 1006],
  [32, 499, 1132], [32, 507, 1286], [32, 469, 1405], [32, 513, 1830],
  [32, 471, 2147], [32, 468, 2306], [32, 467, 2692],
];

test('legacy: кожне натискання лягає РІВНО в записані doc-координати (літерали; sw-масштаб і CSS як є)', async () => {
  const actions = flatten(fixture.recs, { skipMoves: true });
  const clicks = actions.filter((a) => a.type === 'click');
  assert.equal(clicks.length, LEGACY_EXPECTED.length, 'фікстура змінилась — онови LEGACY_EXPECTED свідомо');
  const w = fakeWorld();
  // контрол 10×10 під кожною ОЧІКУВАНОЮ точкою: дрейф → промах/snap → не той id
  LEGACY_EXPECTED.forEach(([, x, y], k) => w.els.push({ id: 'c' + k, x: x - 5, y: y - 5, w: 10, h: 10, interactive: true, tag: 'BUTTON' }));
  const { w: ww } = await run(actions, { world: w });
  assert.equal(ww.presses.length, LEGACY_EXPECTED.length);
  LEGACY_EXPECTED.forEach(([gid, x, y], k) => {
    assert.equal(clicks[k].gid, gid);
    assert.equal(ww.presses[k].vx, x, 'клік ' + k + ' x');
    assert.equal(ww.presses[k].docY, y, 'клік ' + k + ' y');
    assert.equal(ww.presses[k].id, 'c' + k);
  });
});

test('legacy без sw: Дія в device-просторі (макс. X > viewport×1.3) → ÷DPR (рухи враховуються)', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'dev', x: 1118, y: 3092, w: 10, h: 10, interactive: true, tag: 'BUTTON' });
  const acts = [{ type: 'move', x: 2400, y: 6000, gid: 99 }, { type: 'click', x: 2246, y: 6194, gid: 99 }];
  const r = await run(acts, { world: w });
  assert.equal(r.w.presses[0].vx, 1123);
  assert.equal(r.w.presses[0].docY, 3097);
  assert.equal(r.w.presses[0].id, 'dev');
  assert.ok(r.logs.some((t) => /device-просторі/.test(t)));
});

test('legacy: масштаб не ламається, коли живий scrollWidth без скролбару (1280 замість 1265)', async () => {
  const a = { type: 'click', x: 1000, y: 5854, sw: 2530, sh: 6186, gid: 31 };
  const w = fakeWorld({ sw: 1280 }); // --hide-scrollbars / Camoufox / сторінка ще коротка
  const { w: ww } = await run([a], { world: w });
  assert.equal(ww.presses[0].docY, 2927); // а не 2961 (= ×1280/2530)
});

test('legacy: текст — рандом digit/letter, шаблон {d}, звичайний як є; клавіші', async () => {
  const actions = flatten(fixture.recs, { skipMoves: true });
  const { w } = await run(actions);
  const texts = actions.filter((a) => a.type === 'text');
  assert.equal(w.typed.length, texts.length);
  texts.forEach((a, k) => {
    if (a.random === 'digit') assert.match(w.typed[k], /^[0-9]$/);
    else if (a.random === 'letter') assert.match(w.typed[k], /^[a-z]$/);
    else assert.equal(w.typed[k], a.text);
  });
  assert.deepEqual(w.keys, actions.filter((a) => a.type === 'key').map((a) => a.key));
  const t2 = await run([{ type: 'text', text: 'id{d}{d}-{{x}' }]);
  assert.match(t2.w.typed[0], /^id[0-9]{2}-\{x\}$/);
});

// ---------- прокрутка ----------

test('рухи не скролять: точка поза viewport — пропуск (skipped), у viewport — рух', async () => {
  const { w, events } = await run([
    { type: 'move', x: 100, y: 3000 }, { type: 'move', x: 100, y: 300 },
  ]);
  assert.deepEqual(w.scrolls, []);
  const d = events.filter((e) => e.event === 'done-action');
  assert.equal(d[0].skipped, true);
  assert.equal(d[1].skipped, undefined);
  assert.deepEqual(w.moves, [[100, 300]]);
});

test('клік у безпечній смузі viewport — БЕЗ прокрутки (не закриваємо відкритий дропдаун)', async () => {
  const w = fakeWorld({ scrollY: 1000 });
  w.els.push({ id: 'opt', x: 0, y: 1400, w: 300, h: 30, interactive: true });
  const r = await run([{ type: 'click', x: 100, y: 1410 }], { world: w });
  assert.deepEqual(r.w.scrolls, []);
  assert.equal(r.w.presses[0].id, 'opt');
});

test('фіксована шапка: ціль у смузі під шапкою → скрол у вільну зону, клік у ціль', async () => {
  const w = fakeWorld({ scrollY: 1000, topInset: 120 });
  w.els.push({ id: 'header', x: 0, y: 0, w: 1280, h: 120, fixed: true, tag: 'HEADER' });
  w.els.push({ id: 'target', x: 50, y: 1090, w: 200, h: 30, interactive: true, tag: 'BUTTON' });
  const r = await run([{ type: 'click', x: 100, y: 1100 }], { world: w });
  assert.equal(r.w.scrolls.length, 1);
  assert.equal(r.w.presses[0].id, 'target');
});

test('фіксований банер у першому екрані (docY<innerH) — клік без прокрутки', async () => {
  const w = fakeWorld({ scrollY: 0, pageH: 3000 });
  w.els.push({ id: 'accept', x: 1000, y: 840, w: 200, h: 60, fixed: true, interactive: true, tag: 'BUTTON' });
  w.els.push({ id: 'content', x: 0, y: 0, w: 1280, h: 3000, tag: 'DIV' });
  const r = await run([{ type: 'click', x: 1100, y: 870 }], { world: w });
  assert.deepEqual(r.w.scrolls, []);
  assert.equal(r.w.presses[0].id, 'accept');
  assert.ok(r.logs.some((t) => /Фіксований елемент/.test(t)));
});

test('sticky-сайдбар на прокрученій сторінці НЕ перехоплює клік першого екрана (регресія)', async () => {
  // Сайдбар position:sticky; top:20 (природний top 200) → прилипає при scrollY > 180.
  const w = fakeWorld({ scrollY: 0, pageH: 4000 });
  ['L0', 'L1', 'L2', 'L3', 'L4'].forEach((id, k) => w.els.push({ id, x: 0, y: 200 + k * 50, w: 200, h: 50, interactive: true, tag: 'A', sticky: { stick: 180 } }));
  w.els.push({ id: 'low', x: 300, y: 2400, w: 200, h: 50, interactive: true, tag: 'BUTTON' });
  const r = await run([{ type: 'click', x: 400, y: 2425 }, { type: 'click', x: 100, y: 230 }], { world: w });
  assert.deepEqual(r.w.presses.map((p) => p.id), ['low', 'L0']);
  assert.ok(!r.logs.some((t) => /Фіксований елемент/.test(t)), r.logs.join('\n'));
});

test('fixed-банер на ПРОКРУЧЕНІЙ сторінці (після роздивляння) — і далі клік без прокрутки', async () => {
  const w = fakeWorld({ scrollY: 700, pageH: 3000 });
  w.els.push({ id: 'accept', x: 1000, y: 840, w: 200, h: 60, fixed: true, interactive: true, tag: 'BUTTON' });
  w.els.push({ id: 'content', x: 0, y: 0, w: 1280, h: 3000, tag: 'DIV' });
  const r = await run([{ type: 'click', x: 1100, y: 870 }], { world: w });
  assert.deepEqual(r.w.scrolls, []);
  assert.equal(r.w.presses[0].id, 'accept');
});

test('прокрутка змінилась під час руху (scroll anchoring) → точку перераховано перед натисканням', async () => {
  // Запис зроблено на повній верстці: ціль на doc 3000. На відтворенні блок над
  // viewport (200px) ще не догрузився: ціль поки на 2800, а на 3000 — «below».
  const w = fakeWorld({ scrollY: 0 });
  w.els.push({ id: 'target', x: 50, y: 2790, w: 200, h: 20, interactive: true, tag: 'BUTTON' });
  w.els.push({ id: 'below', x: 50, y: 2990, w: 200, h: 20, interactive: true, tag: 'BUTTON' });
  // Під час руху миші блок догрузився: браузер (scroll anchoring) зсунув scrollY на +200,
  // вміст на екрані лишився на місці, doc-координати всього нижче +200 (ціль → 3000).
  w.onFirstMoveAfterScroll = (ww) => {
    ww.scrollY += 200;
    for (const e of ww.els) e.y += 200;
  };
  const r = await run([{ type: 'click', x: 100, y: 3000 }], { world: w });
  assert.ok(r.logs.some((t) => /Прокрутка змінилась/.test(t)));
  assert.equal(r.w.presses[0].docY, 3000);
  assert.equal(r.w.presses[0].id, 'target'); // без перерахунку влучили б у doc 3200 — повз
});

// ---------- snap ----------

test('snap: content → лише ≤24px; empty → ≤60px; interactive → довіряємо', async () => {
  // content (DIV-обгортка) з кнопкою за 20px → snap
  let w = fakeWorld();
  w.els.push({ id: 'wrap', x: 0, y: 0, w: 1280, h: 900, tag: 'DIV' });
  w.els.push({ id: 'btn', x: 120, y: 100, w: 100, h: 30, interactive: true, tag: 'BUTTON' });
  let r = await run([{ type: 'click', x: 100, y: 115 }], { world: w });
  assert.equal(r.w.presses[0].id, 'btn');
  assert.equal(r.events.find((e) => e.event === 'done-action').strategy, 'snap');
  // content з кнопкою за 40px → НЕ тягнемо (сусіднє поле в щільній формі)
  w = fakeWorld();
  w.els.push({ id: 'wrap', x: 0, y: 0, w: 1280, h: 900, tag: 'DIV' });
  w.els.push({ id: 'btn', x: 140, y: 100, w: 100, h: 30, interactive: true, tag: 'BUTTON' });
  r = await run([{ type: 'click', x: 100, y: 115 }], { world: w });
  assert.equal(r.w.presses[0].id, 'wrap');
  assert.equal(r.events.find((e) => e.event === 'done-action').strategy, 'coord');
  // порожнеча (BODY) з кнопкою за 40px → snap
  w = fakeWorld();
  w.els.push({ id: 'btn', x: 140, y: 100, w: 100, h: 30, interactive: true, tag: 'BUTTON' });
  r = await run([{ type: 'click', x: 100, y: 115 }], { world: w });
  assert.equal(r.w.presses[0].id, 'btn');
  // інтерактивна опція поряд з іншою кнопкою → не чіпаємо
  w = fakeWorld();
  w.els.push({ id: 'other', x: 0, y: 140, w: 100, h: 30, interactive: true });
  w.els.push({ id: 'opt', x: 0, y: 100, w: 100, h: 30, interactive: true });
  r = await run([{ type: 'click', x: 50, y: 115 }], { world: w });
  assert.equal(r.w.presses[0].id, 'opt');
});

// ---------- очікування після кліку ----------

test('після кліку: waitQuiet чекає завершення запиту (Node-side), а не фіксований сон', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'b', x: 0, y: 0, w: 100, h: 100, interactive: true });
  const clock = fakeClock();
  w.onPress = (page) => {
    const req = {};
    clock.at(10, () => page.emit('request', req));
    clock.at(900, () => page.emit('requestfinished', req));
  };
  const r = await run([{ type: 'click', x: 50, y: 50 }], { world: w, clock });
  const d = r.events.find((e) => e.event === 'done-action');
  assert.ok(d.ms >= 900 + 300, 'ms=' + d.ms);
  assert.ok(d.ms < 2500, 'ms=' + d.ms);
});

test('після кліку: тихо → мінімальна пауза (150 мс), не 350', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'b', x: 0, y: 0, w: 100, h: 100, interactive: true });
  const r = await run([{ type: 'click', x: 50, y: 50 }], { world: w });
  const d = r.events.find((e) => e.event === 'done-action');
  assert.ok(d.ms >= 150 && d.ms < 300, 'ms=' + d.ms);
});

test('клік спричинив навігацію головного фрейму → domcontentloaded + Cloudflare-перевірка', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'link', x: 0, y: 0, w: 100, h: 100, interactive: true });
  w.onPress = (page) => page.emit('framenavigated', page.mainFrame());
  const r = await run([{ type: 'click', x: 50, y: 50 }], { world: w });
  assert.ok(r.logs.some((t) => /навігацію/.test(t)));
  assert.ok(w.loadStates.includes('domcontentloaded'));
});

test('Enter, що відправляє форму (навігація), теж чекає завантаження', async () => {
  const w = fakeWorld();
  w.onKey = (page) => page.emit('framenavigated', page.mainFrame());
  const r = await run([{ type: 'key', key: 'Enter' }], { world: w });
  assert.ok(r.logs.some((t) => /навігацію/.test(t)));
});

// ---------- роздивляння ----------

test('humanize: роздивляння після відкриття і перед 4-м кліком лише якщо попередній крок не залежний', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'b', x: 0, y: 0, w: 1280, h: 6000, interactive: true });
  const clicks = [1, 2, 3, 4].map((k) => ({ type: 'click', x: 100, y: 100 * k }));
  let r = await run(clicks, { world: w, humanize: true });
  assert.equal(r.logs.filter((t) => /Роздивляння \(/.test(t)).length, 1); // лише після відкриття
  assert.ok(r.logs.some((t) => /Людська поведінка/.test(t)));
  // перед 4-м кліком був файл (не залежний крок) → роздивляння
  const w2 = fakeWorld({ fileInputs: 1 });
  w2.els.push({ id: 'b', x: 0, y: 0, w: 1280, h: 6000, interactive: true });
  r = await run([clicks[0], clicks[1], clicks[2], { type: 'file', fileId: 'f', filename: 'cv.pdf' }, clicks[3]], { world: w2, humanize: true });
  assert.equal(r.logs.filter((t) => /Роздивляння \(/.test(t)).length, 2);
  assert.ok(r.logs.some((t) => /перед кліком #4/.test(t)));
});

test('humanize: рухи між opener і опцією НЕ скидають заборону роздивляння (рух не змінює prevType)', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'b', x: 0, y: 0, w: 1280, h: 6000, interactive: true });
  const c = (k) => ({ type: 'click', x: 100, y: 100 * k });
  const mv = (x, y) => ({ type: 'move', x, y });
  // клік #3 — opener дропдауна, далі записані рухи миші (один — поза viewport, skipped), клік #4 — опція
  const r = await run([c(1), c(2), c(3), mv(150, 320), mv(100, 3000), mv(200, 350), c(4)], { world: w, humanize: true });
  const d = r.events.filter((e) => e.event === 'done-action');
  assert.equal(d[3].skipped, undefined, 'рух має реально виконатися (у viewport)');
  assert.equal(d[4].skipped, true);
  assert.equal(d[5].skipped, undefined);
  assert.ok(!r.logs.some((t) => /перед кліком #4/.test(t)), r.logs.join('\n'));
  assert.equal(r.logs.filter((t) => /Роздивляння \(/.test(t)).length, 1); // лише після відкриття
});

test('humanize: кліки — через рух, hit-test і down/up (не mouse.click)', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'b', x: 50, y: 50, w: 100, h: 100, interactive: true });
  const r = await run([{ type: 'click', x: 100, y: 100 }], { world: w, humanize: true });
  assert.equal(r.w.presses[0].id, 'b');
});

// ---------- файли, текст, діалоги, попапи, переривання ----------

test('file: файл не знайдено / немає поля / підставлено в input', async () => {
  const file = [{ type: 'file', fileId: '00000000-0000-4000-8000-000000000000', filename: 'cv.pdf', gid: 1 }];
  const r1 = await run(file, { resolveUpload: () => null });
  const d1 = r1.events.find((e) => e.event === 'done-action');
  assert.deepEqual([d1.ok, d1.error], [false, 'файл не знайдено на сервері']);
  assert.equal(r1.res.replayed, 0);
  const r2 = await run(file);
  assert.equal(r2.events.find((e) => e.event === 'done-action').error, 'на сторінці немає поля для файлу');
  const r3 = await run(file, { world: fakeWorld({ fileInputs: 2 }) });
  assert.equal(r3.events.find((e) => e.event === 'done-action').ok, true);
  assert.deepEqual(r3.w.files, [0, '/uploads/x/cv.pdf']);
  assert.ok(r3.logs.some((t) => /Файл підставлено/.test(t)));
});

test('текст без фокусу → попередження один раз на серію символів', async () => {
  const r = await run([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], { world: fakeWorld({ focusEditable: false }) });
  assert.equal(r.logs.filter((t) => /Текст без фокусу/.test(t)).length, 1);
  assert.deepEqual(r.w.typed, ['a', 'b']);
});

test('діалог (alert/confirm) приймається і логується', async () => {
  const w = fakeWorld();
  let accepted = false;
  w.onKey = (page) => page.emit('dialog', { type: () => 'confirm', message: () => 'Точно?', accept: async () => { accepted = true; } });
  const r = await run([{ type: 'key', key: 'Enter' }], { world: w });
  await new Promise((res) => setImmediate(res));
  assert.equal(accepted, true);
  assert.ok(r.logs.some((t) => /Діалог confirm «Точно\?» → прийнято/.test(t)));
});

test('попап: нова вкладка → наступні дії йдуть у неї; результат містить поточну сторінку', async () => {
  const w = fakeWorld();
  w.els.push({ id: 'open', x: 0, y: 0, w: 100, h: 100, interactive: true });
  const ctx = new EventEmitter();
  const w2 = fakeWorld();
  const popup = fakePage(w2); popup.tag = 'popup';
  w.onPress = () => ctx.emit('page', popup);
  const r = await run([{ type: 'click', x: 50, y: 50 }, { type: 'key', key: 'Tab' }], { world: w, ctx });
  assert.equal(r.res.page, popup);
  assert.deepEqual(w2.keys, ['Tab']);
  assert.deepEqual(w.keys, []);
  assert.ok(r.logs.some((t) => /нова вкладка/.test(t)));
});

test('переривання (signal): цикл зупиняється після поточної дії', async () => {
  const ac = new AbortController();
  const w = fakeWorld();
  w.onKey = (_p, k) => { if (k === 'B') ac.abort(); };
  const r = await run(['A', 'B', 'C', 'D'].map((key) => ({ type: 'key', key })), { world: w, signal: ac.signal });
  assert.deepEqual(w.keys, ['A', 'B']);
  assert.equal(r.res.aborted, true);
  assert.equal(r.events.filter((e) => e.event === 'action').length, 2);
});

test('невідомий тип і disabled — пропуск із логом, не падіння', async () => {
  const r = await run([{ type: 'teleport' }, { type: 'key', key: 'A', disabled: true }]);
  const d = r.events.filter((e) => e.event === 'done-action');
  assert.deepEqual(d.map((e) => [e.ok, e.skipped]), [[true, true], [true, true]]);
  assert.deepEqual(r.w.keys, []);
});

test('replayActions (сумісність) повертає число', async () => {
  const w = fakeWorld();
  const n = await replayActions(fakePage(w), [{ type: 'key', key: 'A' }], { send() {}, humanize: false, dom: w.dom, clock: fakeClock(), resolveUpload: () => null });
  assert.equal(n, 1);
});

test('pauseAfter: рухи ~0, текст→текст як між літерами, інакше людська/мінімальна', () => {
  const r = (a, b) => rint(a, b, mulberry32(2));
  assert.equal(pauseAfter({ type: 'move' }, { type: 'click' }, false, r), 0);
  assert.ok(pauseAfter({ type: 'move' }, { type: 'click' }, true, r) <= 60);
  assert.equal(pauseAfter({ type: 'text' }, { type: 'text' }, false, r), 25);
  assert.equal(pauseAfter({ type: 'text' }, { type: 'text' }, true, r), 0);
  assert.equal(pauseAfter({ type: 'click' }, { type: 'text' }, false, r), 80);
  const h = pauseAfter({ type: 'click' }, { type: 'click' }, true, r);
  assert.ok(h >= 350 && h <= 1100);
  assert.equal(pauseAfter({ type: 'click' }, undefined, true, r), 0);
});

// ---------- Пауза після кроку (delayAfter) ----------
test('delayAfter: додається до звичайної паузи між кроками, з логом', async () => {
  const base = await run([{ type: 'key', key: 'A' }, { type: 'key', key: 'B' }], { clock: fakeClock() });
  const c = fakeClock(); // віртуальний час: порівнюємо з тим самим прогоном без паузи
  const t0 = c.now();
  const r = await run([{ type: 'key', key: 'A', delayAfter: 1500 }, { type: 'key', key: 'B' }], { clock: c });
  const baseClock = fakeClock();
  await run([{ type: 'key', key: 'A' }, { type: 'key', key: 'B' }], { clock: baseClock });
  assert.equal(c.now() - t0 - baseClock.now(), 1500, 'рівно +1500 мс віртуального часу');
  assert.ok(r.logs.some(t => /⏱ Пауза 1500 мс після кроку #1/.test(t)), r.logs.join('\n'));
  assert.ok(!base.logs.some(t => /⏱ Пауза/.test(t)));
});

test('delayAfter: діє і після останнього кроку (перед фінальним скрином)', async () => {
  const c = fakeClock(); const b = fakeClock();
  await run([{ type: 'key', key: 'A', delayAfter: 700 }], { clock: c });
  await run([{ type: 'key', key: 'A' }], { clock: b });
  assert.equal(c.now() - b.now(), 700);
});

test('delayAfter: подія pause {index, ms} у стрімі — після done-action кроку і лише коли пауза є', async () => {
  const r = await run([{ type: 'key', key: 'A' }, { type: 'key', key: 'B', delayAfter: 1200 }, { type: 'key', key: 'C' }], { clock: fakeClock() });
  const pauses = r.events.filter(e => e.event === 'pause');
  assert.deepEqual(pauses, [{ event: 'pause', index: 1, ms: 1200 }]);
  const k = r.events.indexOf(pauses[0]);
  const prevStep = r.events.slice(0, k).filter(e => e.event === 'action' || e.event === 'done-action').pop();
  assert.deepEqual([prevStep.event, prevStep.index], ['done-action', 1]);
  const nextStep = r.events.slice(k).find(e => e.event === 'action');
  assert.equal(nextStep.index, 2);
});

test('delayAfter: пропущений крок (skipped) — без події pause і без паузи', async () => {
  const c = fakeClock(), b = fakeClock();
  const r = await run([{ type: 'move', x: 100, y: 3000, delayAfter: 900 }, { type: 'key', key: 'B' }], { clock: c });
  await run([{ type: 'move', x: 100, y: 3000 }, { type: 'key', key: 'B' }], { clock: b });
  assert.equal(r.events.find(e => e.event === 'done-action' && e.index === 0).skipped, true);
  assert.equal(r.events.filter(e => e.event === 'pause').length, 0);
  assert.equal(c.now(), b.now());
});

test('delayAfter: вимкнений крок — без паузи', async () => {
  const c = fakeClock(); const b = fakeClock();
  const r = await run([{ type: 'key', key: 'A', disabled: true, delayAfter: 5000 }, { type: 'key', key: 'B' }], { clock: c });
  await run([{ type: 'key', key: 'A', disabled: true }, { type: 'key', key: 'B' }], { clock: b });
  assert.equal(c.now(), b.now());
  assert.ok(!r.logs.some(t => /⏱ Пауза/.test(t)));
  assert.equal(r.events.filter(e => e.event === 'pause').length, 0);
});

test('delayAfter: сміттєве значення ігнорується, завелике обрізається до 60 с', async () => {
  const c1 = fakeClock(), c2 = fakeClock(), b = fakeClock();
  await run([{ type: 'key', key: 'A', delayAfter: 'oops' }], { clock: c1 });
  await run([{ type: 'key', key: 'A', delayAfter: 10 * 60000 }], { clock: c2 });
  await run([{ type: 'key', key: 'A' }], { clock: b });
  assert.equal(c1.now(), b.now());
  assert.equal(c2.now() - b.now(), 60000);
});

test('delayAfter: Стоп під час паузи перериває її одразу', async () => {
  const ac = new AbortController();
  const c = fakeClock();
  // віртуальний годинник: abort приходить через 100 мс після початку паузи
  const origSleep = c.sleep.bind(c);
  let armed = false;
  c.sleep = async (ms) => { if (ms >= 30000 && !armed) { armed = true; ac.abort(); } return origSleep(Math.min(ms, 100)); };
  const r = await run([{ type: 'key', key: 'A', delayAfter: 30000 }, { type: 'key', key: 'B' }], { clock: c, signal: ac.signal });
  assert.equal(r.res.aborted, true);
  assert.equal(r.events.filter(e => e.event === 'action').length, 1, 'крок B не почався');
});
