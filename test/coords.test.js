// Юніт-тести логіки координат/скролу (lib/coords.js).
// Запуск: npm test  (вбудований node:test, без зовнішніх залежностей).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rectDistance, detectDeviceGids, coordScale, toDocCoords, scrollTargetFor,
  isSolidHit, nearestRect,
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
