// Юніт-тести логіки координат/скролу (lib/coords.js).
// Запуск: npm test  (вбудований node:test, без зовнішніх залежностей).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rectDistance, detectDeviceGids, coordScale, toDocCoords, scrollTargetFor,
  isSolidHit, nearestRect, recordScale, scrollPlan, needsScroll, scrollSettled,
  classifyHit, decideSnap, preferFixedHit, shouldWander, INTERACTIVE_SEL,
} from '../lib/coords.js';

test('rectDistance: точка всередині → 0', () => {
  assert.equal(rectDistance(50, 50, { x: 0, y: 0, w: 100, h: 100 }), 0);
  assert.equal(rectDistance(0, 0, { x: 0, y: 0, w: 100, h: 100 }), 0); // на межі
});

test('rectDistance: по горизонталі/вертикалі/діагоналі', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(rectDistance(110, 50, r), 10); // праворуч на 10
  assert.equal(rectDistance(50, 118, r), 18); // нижче на 18 (кейс дрейфу submit)
  assert.equal(rectDistance(103, 104, r), 5);  // діагональ 3-4-5
});

test('detectDeviceGids: CSS-Дія не device, широка Дія — device', () => {
  const actions = [
    // Дія 1 (gid=1): усі X у межах viewport → CSS
    { type: 'click', x: 698, gid: 1 }, { type: 'move', x: 500, gid: 1 },
    // Дія 2 (gid=2): X виходить за viewport (до 2246) → device
    { type: 'click', x: 935, gid: 2 }, { type: 'click', x: 2246, gid: 2 },
  ];
  const set = detectDeviceGids(actions, 1280);
  assert.equal(set.has(1), false);
  assert.equal(set.has(2), true);
});

test('detectDeviceGids: порожні/без gid ігноруються', () => {
  assert.equal(detectDeviceGids([], 1280).size, 0);
  assert.equal(detectDeviceGids([{ type: 'text', text: 'a', gid: 1 }], 1280).size, 0);
});

test('coordScale: sw дає точний DPR-незалежний масштаб', () => {
  // записано на 2530-широкому скриншоті, сторінка відтворення 1265 CSS → ÷2
  assert.equal(coordScale({ x: 2246, sw: 2530 }, { scrollW: 1265, dpr: 1, deviceGids: new Set() }), 1265 / 2530);
  // навіть якщо поточний DPR інший — масштаб від sw, не від dpr
  assert.equal(coordScale({ x: 100, sw: 1265 }, { scrollW: 1265, dpr: 2, deviceGids: new Set() }), 1);
});

test('coordScale: без sw — евристика device-gid ÷dpr, інакше 1', () => {
  const dev = new Set([2]);
  assert.equal(coordScale({ x: 2246, gid: 2 }, { scrollW: 1265, dpr: 2, deviceGids: dev }), 0.5);
  assert.equal(coordScale({ x: 698, gid: 1 }, { scrollW: 1265, dpr: 2, deviceGids: dev }), 1);
  assert.equal(coordScale({ x: 698 }, { scrollW: 1265, dpr: 2, deviceGids: dev }), 1);
});

test('toDocCoords: submit із device-простору лягає всередину viewport', () => {
  // реальний кейс: submit записано x=2246 (за межами 1280) на sw=2530
  const d = toDocCoords({ x: 2246, y: 6194, sw: 2530 }, { scrollW: 1265, dpr: 1, deviceGids: new Set() });
  assert.equal(d.x, 1123); // 2246 * 1265/2530 = 1123 — в межах сторінки
  assert.equal(d.y, 3097);
});

test('toDocCoords: CSS-клік (вкладка) лишається на місці', () => {
  const d = toDocCoords({ x: 698, y: 141, gid: 1 }, { scrollW: 1265, dpr: 2, deviceGids: new Set() });
  assert.deepEqual(d, { x: 698, y: 141 });
});

test('scrollTargetFor: ціль у середині — центрується', () => {
  const { scrollY, viewportY } = scrollTargetFor(2000, 900, 4000);
  assert.equal(scrollY, 1550);      // 2000 - 450
  assert.equal(viewportY, 450);     // у центрі viewport
});

test('scrollTargetFor: ціль біля низу — scroll обмежується, клік лишається в межах', () => {
  const pageH = 3267, innerH = 900;
  const { scrollY, viewportY } = scrollTargetFor(3100, innerH, pageH); // submit внизу
  assert.equal(scrollY, pageH - innerH); // 2367 — макс. прокрутка
  assert.equal(viewportY, 3100 - 2367);  // 733 — у межах [0, innerH]
  assert.ok(viewportY >= 0 && viewportY <= innerH);
});

test('scrollTargetFor: ціль зверху — без від’ємного scroll', () => {
  const { scrollY, viewportY } = scrollTargetFor(100, 900, 4000);
  assert.equal(scrollY, 0);
  assert.equal(viewportY, 100);
});

test('scrollTargetFor: коротка сторінка (скрол не потрібен)', () => {
  const { scrollY, viewportY } = scrollTargetFor(500, 900, 800);
  assert.equal(scrollY, 0);         // maxScroll=0
  assert.equal(viewportY, 500);
});

test('isSolidHit: реальний елемент → true, порожнеча/нема → false', () => {
  // опція дропдауна-<div> вважається влучною (НЕ знімати snap-ом)
  assert.equal(isSolidHit({ tag: 'DIV', text: 'Linkedin' }), true);
  assert.equal(isSolidHit({ tag: 'SPAN', text: 'Submit Application' }), true);
  assert.equal(isSolidHit({ tag: 'INPUT', type: 'email' }), true);
  assert.equal(isSolidHit({ tag: 'BODY' }), false); // порожнеча форми
  assert.equal(isSolidHit({ tag: 'html' }), false);
  assert.equal(isSolidHit(null), false);
});

test('nearestRect: рятує промах до найближчого контрола в радіусі', () => {
  const rects = [
    { x: 400, y: 100, w: 668, h: 46 }, // кнопка Submit
    { x: 400, y: 300, w: 300, h: 40 }, // інше поле
  ];
  // клік на 18px нижче кнопки (дрейф) → притягує до центра кнопки
  const s = nearestRect(700, 164, rects, 60);
  assert.deepEqual({ x: s.x, y: s.y }, { x: 734, y: 123 });
  assert.equal(s.d, 18);
});

test('nearestRect: поза радіусом → null (не притягуємо навмання)', () => {
  const rects = [{ x: 0, y: 0, w: 50, h: 20 }];
  assert.equal(nearestRect(500, 500, rects, 60), null);
});

test('nearestRect: ігнорує надто великі/малі прямокутники', () => {
  const rects = [
    { x: 0, y: 0, w: 2, h: 2 },        // надто малий
    { x: 0, y: 0, w: 3000, h: 50 },    // надто широкий (ширше viewport)
    { x: 100, y: 100, w: 200, h: 40 }, // валідний
  ];
  const s = nearestRect(110, 110, rects, 60);
  assert.equal(s.x, 200); // центр валідного (100+200/2)
});

// ---------- P0: масштаб, прокрутка, hit-класифікація, snap, роздивляння ----------

test('recordScale: прилипає до DPR — скролбар 1265 vs 1280 не дає дрейфу', () => {
  assert.equal(recordScale(2530, 1265), 0.5);
  assert.equal(recordScale(2530, 1280), 0.5);   // --hide-scrollbars / Camoufox / ще короткий документ
  assert.equal(recordScale(2560, 1280), 0.5);
  assert.equal(recordScale(1265, 1280), 1);
  assert.equal(recordScale(1280, 1265), 1);
  assert.equal(recordScale(3840, 1280), 1 / 3);
  assert.equal(recordScale(1920, 1280), 1 / 1.5);
});

test('recordScale: не схоже на DPR → сире відношення; некоректні дані → 1', () => {
  assert.equal(recordScale(2000, 1100), 1100 / 2000); // 1.818 — далеко від 1.75 і 2
  assert.equal(recordScale(0, 1280), 1);
  assert.equal(recordScale(2530, 0), 1);
});

test('coordScale: явний a.dpr має пріоритет над sw', () => {
  assert.equal(coordScale({ x: 1, sw: 2530, dpr: 2 }, { scrollW: 1265 }), 0.5);
  assert.equal(coordScale({ x: 1, dpr: 1 }, { scrollW: 1265, dpr: 2, deviceGids: new Set([1]) }), 1);
  // нові записи (CSS-координати, sw = scrollWidth) → 1
  assert.equal(coordScale({ x: 1, sw: 1265 }, { scrollW: 1280 }), 1);
});

test('scrollPlan: ціль уже в безпечній смузі → НЕ скролимо', () => {
  const p = scrollPlan(1400, 1000, 900, 6000);
  assert.deepEqual(p, { scroll: false, scrollY: 1000, viewportY: 400 });
  assert.equal(needsScroll(1400, 1000, 900, 6000), false);
});

test('scrollPlan: вище/нижче смуги → центруємо; межі смуги (margin 80)', () => {
  assert.deepEqual(scrollPlan(1050, 1000, 900, 6000), { scroll: true, scrollY: 600, viewportY: 450 });
  assert.deepEqual(scrollPlan(1850, 1000, 900, 6000), { scroll: true, scrollY: 1400, viewportY: 450 });
  assert.equal(needsScroll(1080, 1000, 900, 6000), false); // рівно на межі
  assert.equal(needsScroll(1820, 1000, 900, 6000), false);
  assert.equal(needsScroll(1079, 1000, 900, 6000), true);
});

test('scrollPlan: обмеження вгорі та внизу; коротка сторінка; ціль уже в найближчій позиції', () => {
  assert.deepEqual(scrollPlan(30, 500, 900, 6000), { scroll: true, scrollY: 0, viewportY: 30 });
  assert.deepEqual(scrollPlan(5980, 0, 900, 6000), { scroll: true, scrollY: 5100, viewportY: 880 });
  assert.deepEqual(scrollPlan(850, 0, 900, 880), { scroll: false, scrollY: 0, viewportY: 850 }); // maxScroll 0
  // біля низу вже на максимумі — повторний скрол не потрібен
  assert.equal(scrollPlan(5980, 5100, 900, 6000).scroll, false);
});

test('scrollPlan: фіксована шапка/футер звужують смугу і зсувають центр', () => {
  // без шапки 1100 у смузі; з шапкою 120 — ні (було б під шапкою)
  assert.equal(needsScroll(1100, 1000, 900, 6000), false);
  const p = scrollPlan(1100, 1000, 900, 6000, { topInset: 120 });
  assert.equal(p.scroll, true);
  assert.equal(p.viewportY, 120 + (900 - 120) / 2); // центр вільної зони
  assert.equal(needsScroll(1780, 1000, 900, 6000, { bottomInset: 100 }), true);
});

test('scrollSettled: два однакові виміри поспіль; дробові в межах 0.5px', () => {
  assert.equal(scrollSettled([]), false);
  assert.equal(scrollSettled([100]), false);
  assert.equal(scrollSettled([0, 300, 600]), false);
  assert.equal(scrollSettled([0, 600, 600]), true);
  assert.equal(scrollSettled([600, 600.4]), true);
  assert.equal(scrollSettled([600, 601, 601, 601], 3), true);
  assert.equal(scrollSettled([600, 600, 601], 3), false);
});

test('classifyHit: empty / interactive / content', () => {
  assert.equal(classifyHit(null), 'empty');
  assert.equal(classifyHit({ tag: 'BODY' }), 'empty');
  assert.equal(classifyHit({ tag: 'html' }), 'empty');
  assert.equal(classifyHit({ tag: 'IFRAME' }), 'empty'); // фрейм ще не відрендерився
  assert.equal(classifyHit({ tag: 'SPAN', interactive: true }), 'interactive'); // SPAN у кнопці
  assert.equal(classifyHit({ tag: 'DIV', pointer: true }), 'interactive');
  assert.equal(classifyHit({ tag: 'DIV', optionLike: true }), 'interactive'); // опція-<div> дропдауна
  assert.equal(classifyHit({ tag: 'DIV' }), 'content');
  assert.equal(classifyHit({ tag: 'H2', text: 'Privacy' }), 'content');
  assert.equal(classifyHit({ tag: 'P' }), 'content');
});

test('decideSnap: interactive → trust; empty ≤60; content лише ≤24', () => {
  const near = (d) => ({ x: 10, y: 20, d });
  assert.deepEqual(decideSnap('interactive', near(5)), { action: 'trust' });
  assert.deepEqual(decideSnap('empty', near(55)), { action: 'snap', to: { x: 10, y: 20 }, d: 55 });
  assert.deepEqual(decideSnap('empty', near(61)), { action: 'none' });
  assert.deepEqual(decideSnap('empty', null), { action: 'none' });
  assert.deepEqual(decideSnap('content', near(24)), { action: 'snap', to: { x: 10, y: 20 }, d: 24 });
  assert.deepEqual(decideSnap('content', near(30)), { action: 'trust' });
  assert.deepEqual(decideSnap('content', null), { action: 'trust' });
  assert.deepEqual(decideSnap('content', near(30), { contentRadius: 40 }).action, 'snap');
});

test('preferFixedHit: лише інтерактивний fixed у першому екрані', () => {
  assert.equal(preferFixedHit(870, 900, { tag: 'BUTTON', interactive: true, fixed: true }), true);
  assert.equal(preferFixedHit(950, 900, { tag: 'BUTTON', interactive: true, fixed: true }), false);
  assert.equal(preferFixedHit(870, 900, { tag: 'DIV', fixed: true }), false); // фон банера
  assert.equal(preferFixedHit(870, 900, { tag: 'BUTTON', interactive: true }), false);
  assert.equal(preferFixedHit(870, 900, null), false);
});

test('preferFixedHit: sticky довіряємо лише при scrollY=0; fixed — за будь-якого scrollY', () => {
  const sticky = { tag: 'A', interactive: true, sticky: true };
  assert.equal(preferFixedHit(230, 900, sticky, 1975), false); // «прилиплий» сайдбар на прокрученій сторінці
  assert.equal(preferFixedHit(230, 900, sticky, 0), true);
  assert.equal(preferFixedHit(230, 900, sticky), true);       // дефолт scrollY = 0
  // кукі-банер (fixed) на прокрученій (напр. після роздивляння) сторінці — і далі без прокрутки
  assert.equal(preferFixedHit(860, 900, { tag: 'BUTTON', interactive: true, fixed: true }, 700), true);
});

test('shouldWander: детермінований розклад, ніколи після залежного кроку', () => {
  assert.equal(shouldWander({ humanize: false, phase: 'open' }), false);
  assert.equal(shouldWander({ humanize: true, phase: 'open' }), true);
  assert.equal(shouldWander({ humanize: true, clickNo: 1 }), false);
  assert.equal(shouldWander({ humanize: true, clickNo: 3, prevType: 'file' }), false);
  assert.equal(shouldWander({ humanize: true, clickNo: 4, prevType: null }), true);
  assert.equal(shouldWander({ humanize: true, clickNo: 4, prevType: 'file' }), true);
  assert.equal(shouldWander({ humanize: true, clickNo: 8, prevType: 'scroll' }), true);
  for (const t of ['click', 'key', 'text', 'select']) assert.equal(shouldWander({ humanize: true, clickNo: 4, prevType: t }), false, t);
  assert.equal(shouldWander({ humanize: true, clickNo: 4, prevType: 'click', prevNavigated: true }), true); // нова сторінка
  assert.equal(shouldWander({ humanize: true, clickNo: 4, every: 0 }), false);
});

test('INTERACTIVE_SEL: валідний CSS-список з ролями, contenteditable і label', () => {
  for (const s of ['button', 'label', '[role=option]', '[role=combobox]', '[contenteditable]:not([contenteditable=false])', 'a[href]']) {
    assert.ok(INTERACTIVE_SEL.split(', ').includes(s), s);
  }
});
