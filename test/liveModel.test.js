// Тести чистої логіки живого запису (public/js/liveModel.js): координати від content-box,
// маркери, колесо/жести, буфер тексту, злиття дій у черзі, префікс/план, помилки сесії.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewToPage, viewScale, viewPct, boxPct, markersInView, normalizeWheel, createWindowCoalescer,
  createTextBuffer, mergeActs, enqueueAct, prefixPlan, planStart, chainSideEffects,
  classifyLiveError, beforeInputToKey, isEditableStep, inspectDefault,
  defaultZoom1, shouldHintZoom, pickMarkers, canResync, undoIndex, applyActResult, resolveReattach, raceIdle,
} from '../public/js/liveModel.js';
import { keyToStep } from '../lib/steps.js';

// Фейкові таймери: run() виконує всі заплановані.
function fakeTimers() {
  let seq = 0;
  const q = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; q.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { q.delete(id); },
    run() { const all = [...q.entries()]; q.clear(); for (const [, t] of all) t.fn(); },
    get size() { return q.size; },
    lastMs() { const all = [...q.values()]; return all.length ? all[all.length - 1].ms : null; },
  };
}

// <img> 640×450 на екрані, рамка 1px, сесія 1280×900 → масштаб 2.
const box = { left: 100, top: 50, clientLeft: 1, clientTop: 1, clientWidth: 640, clientHeight: 450 };
const vp = { w: 1280, h: 900, scrollX: 0, scrollY: 500 };

test('viewToPage: від content-box (рамка не зсуває), масштаб до CSS px viewport', () => {
  assert.deepEqual(viewToPage(101, 51, box, vp), { x: 0, y: 0 });
  assert.deepEqual(viewToPage(101 + 320, 51 + 225, box, vp), { x: 640, y: 450 });
  // точка на рамці (border-box, але не content-box) → поза зображенням
  assert.equal(viewToPage(100.5, 60, box, vp), null);
  assert.equal(viewToPage(101 + 640, 60, box, vp), null);
  // padding теж відраховується
  const padded = { ...box, padL: 10, padT: 10, padR: 10, padB: 10, clientWidth: 660, clientHeight: 470 };
  assert.deepEqual(viewToPage(111, 61, padded, vp), { x: 0, y: 0 });
  // без розміру / viewport → null
  assert.equal(viewToPage(200, 200, { ...box, clientWidth: 0 }, vp), null);
  assert.equal(viewToPage(200, 200, box, null), null);
});

test('viewToPage: останній піксель обмежено w-1/h-1', () => {
  const p = viewToPage(101 + 639.9, 51 + 449.9, box, vp);
  assert.deepEqual(p, { x: 1279, y: 899 });
});

test('viewScale / viewPct / boxPct', () => {
  assert.equal(viewScale(box, vp), 2);
  assert.equal(viewScale({ clientWidth: 0 }, vp), 1);
  assert.deepEqual(viewPct(640, 450, vp), { left: 50, top: 50 });
  assert.equal(viewPct(1, 1, { w: 0, h: 0 }), null);
  assert.deepEqual(boxPct({ x: 128, y: 90, w: 256, h: 45 }, vp), { left: 10, top: 10, width: 20, height: 5 });
});

test('markersInView: документні координати → viewport, лише видимі й на тому ж URL', () => {
  const marks = [
    { n: 1, x: 100, y: 600, url: 'http://a/p#x' },  // видимий (scrollY 500 → vy 100)
    { n: 2, x: 100, y: 300, url: 'http://a/p' },    // вище viewport
    { n: 3, x: 100, y: 1500, url: 'http://a/p' },   // нижче
    { n: 4, x: 100, y: 700, url: 'http://a/other' }, // інша сторінка
    { n: 5, x: null, y: 1 },
  ];
  assert.deepEqual(markersInView(marks, vp, 'http://a/p'), [{ n: 1, vx: 100, vy: 100 }]);
  assert.deepEqual(markersInView(null, vp, 'x'), []);
});

test('normalizeWheel: пікселі / рядки / сторінки', () => {
  assert.deepEqual(normalizeWheel({ deltaX: 0, deltaY: 120, deltaMode: 0 }), { dx: 0, dy: 120 });
  assert.deepEqual(normalizeWheel({ deltaX: 1, deltaY: 3, deltaMode: 1 }), { dx: 40, dy: 120 });
  assert.deepEqual(normalizeWheel({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 900), { dx: 0, dy: -900 });
});

test('createWindowCoalescer: дельти за вікно 120 мс → один scroll з останньою точкою', () => {
  const t = fakeTimers();
  const out = [];
  const co = createWindowCoalescer({ delay: 120, onFlush: (a) => out.push(a), setTimer: t.setTimer, clearTimer: t.clearTimer });
  co.add({ dx: 0, dy: 100, vx: 10, vy: 20 });
  co.add({ dx: 5, dy: 50, vx: 11, vy: 21 });
  assert.equal(t.size, 1, 'одне вікно, не дебаунс на кожну подію');
  assert.equal(t.lastMs(), 120);
  t.run();
  assert.deepEqual(out, [{ dx: 5, dy: 150, vx: 11, vy: 21 }]);
  co.add({ dy: 10 });
  co.flush(); // негайне скидання (перед кліком)
  assert.equal(out.length, 2);
  assert.equal(t.size, 0);
  co.add({ dy: 0 }); co.flush(); // нульова дельта не відправляється
  assert.equal(out.length, 2);
  co.add({ dy: 7 }); co.cancel(); t.run();
  assert.equal(out.length, 2, 'cancel відкидає накопичене');
});

test('createTextBuffer: друковані символи буферизуються, скидаються одним text через 400 мс простою', () => {
  const t = fakeTimers();
  const sent = [], shown = [];
  const tb = createTextBuffer({ idleMs: 400, onEmit: (s) => sent.push(...s), onChange: (b) => shown.push(b), setTimer: t.setTimer, clearTimer: t.clearTimer });
  for (const k of 'ab{c') tb.input(keyToStep({ key: k }));
  assert.equal(tb.value, 'ab{c');
  assert.equal(shown.at(-1), 'ab{c', 'буфер показується inline');
  assert.equal(sent.length, 0);
  assert.equal(t.lastMs(), 400);
  t.run();
  assert.deepEqual(sent, [{ type: 'text', v: 2, text: 'ab{{c' }], 'літерал «{» екранується в шаблоні');
  assert.equal(tb.value, '');
  assert.equal(shown.at(-1), '');
});

test('createTextBuffer: Backspace редагує невідісланий буфер; Enter скидає текст ПЕРЕД клавішею', () => {
  const t = fakeTimers();
  const sent = [];
  const tb = createTextBuffer({ onEmit: (s) => sent.push(...s), setTimer: t.setTimer, clearTimer: t.clearTimer });
  tb.input(keyToStep({ key: 'h' })); tb.input(keyToStep({ key: 'i' })); tb.input(keyToStep({ key: 'x' }));
  tb.input('Backspace');
  assert.equal(tb.value, 'hi');
  tb.input(keyToStep({ key: 'Enter' }));
  assert.deepEqual(sent, [{ type: 'text', v: 2, text: 'hi' }, { type: 'key', key: 'Enter' }]);
  assert.equal(t.size, 0, 'таймер простою скасовано');
  // Backspace при порожньому буфері — це вже клавіша сторінки
  tb.input('Backspace');
  assert.deepEqual(sent.at(-1), { type: 'key', key: 'Backspace' });
});

test('createTextBuffer: append (вставка) з now → одразу один text; flush/clear', () => {
  const t = fakeTimers();
  const sent = [];
  const tb = createTextBuffer({ onEmit: (s) => sent.push(...s), setTimer: t.setTimer, clearTimer: t.clearTimer });
  tb.input(keyToStep({ key: 'a' }));
  tb.append('{d} paste', { now: true });
  assert.deepEqual(sent, [{ type: 'text', v: 2, text: 'a{{d} paste' }]);
  tb.append('zz');
  assert.equal(tb.value, 'zz');
  tb.clear();
  t.run();
  assert.equal(sent.length, 1, 'clear не відправляє');
  assert.deepEqual(tb.flush(), []);
});

test('mergeActs: зливає лише scroll+scroll і text+text з однаковим rec', () => {
  assert.deepEqual(mergeActs({ type: 'scroll', dx: 0, dy: 100, vx: 1, vy: 2, rec: false }, { type: 'scroll', dx: 3, dy: 50, vx: 5, vy: 6, rec: false }),
    { type: 'scroll', dx: 3, dy: 150, vx: 5, vy: 6, rec: false });
  assert.deepEqual(mergeActs({ type: 'text', text: 'ab', rec: true }, { type: 'text', text: '{d}', rec: true }), { type: 'text', text: 'ab{d}', rec: true });
  assert.equal(mergeActs({ type: 'text', text: 'a', rec: true }, { type: 'text', text: 'b', rec: false }), null);
  assert.equal(mergeActs({ type: 'click', vx: 1, vy: 1 }, { type: 'click', vx: 1, vy: 1 }), null);
  assert.equal(mergeActs({ type: 'key', key: 'Enter' }, { type: 'key', key: 'Enter' }), null);
});

test('enqueueAct: злиття з останнім очікуючим, ліміт 10 → dropped, nav не зливається', () => {
  const act = (body) => ({ kind: 'act', body });
  let r = enqueueAct([], act({ type: 'scroll', dy: 10 }));
  assert.equal(r.queue.length, 1);
  r = enqueueAct(r.queue, act({ type: 'scroll', dy: 20 }));
  assert.equal(r.merged, true);
  assert.equal(r.queue.length, 1);
  assert.equal(r.queue[0].body.dy, 30);
  r = enqueueAct(r.queue, { kind: 'nav', body: { action: 'reload' } });
  r = enqueueAct(r.queue, act({ type: 'scroll', dy: 5 }));
  assert.equal(r.queue.length, 3, 'scroll після nav — окремо (порядок)');
  let q = [];
  for (let i = 0; i < 10; i++) q = enqueueAct(q, act({ type: 'click', vx: i, vy: i }), 10).queue;
  const full = enqueueAct(q, act({ type: 'click', vx: 99, vy: 99 }), 10);
  assert.equal(full.dropped, true);
  assert.equal(full.queue.length, 10);
  const mergedEvenIfFull = enqueueAct([...q.slice(0, 9), act({ type: 'text', text: 'a' })], act({ type: 'text', text: 'b' }), 10);
  assert.equal(mergedEvenIfFull.merged, true, 'злиття не займає нового місця');
});

const page = {
  id: 1, url: 'http://fx/live.html',
  recs: [
    { id: 10, name: 'Дія 10', subs: [{ type: 'move', x: 1, y: 1 }, { type: 'click', x: 5, y: 6 }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    { id: 11, name: 'Дія 11', subs: [{ id: 's_1', v: 2, type: 'click', x: 1, y: 2, target: { desc: 'кнопка «Submit Application»', locs: [], pick: -1 } }] },
    { id: 12, name: 'Дія 12', subs: [{ id: 's_2', v: 2, type: 'key', key: 'Enter' }] },
  ],
};

test('planStart: append / fromStart / appendTo', () => {
  assert.deepEqual(planStart(page, { mode: 'append' }), { baseRecIds: [10, 11, 12], newRec: true, recId: null });
  assert.deepEqual(planStart(page, { mode: 'fromStart' }), { baseRecIds: [], newRec: true, recId: null });
  assert.deepEqual(planStart(page, { mode: 'appendTo', recId: 11 }), { baseRecIds: [10], newRec: false, recId: 11 });
  assert.throws(() => planStart(page, { mode: 'appendTo', recId: 99 }), /не знайдено/);
});

test('prefixPlan: підмножина Дій у порядку сценарію, рухи пропущено, legacy-текст злито, мапа на справжні Дії', () => {
  const p = prefixPlan(page, [11, 10], { skipMoves: true });
  assert.equal(p.total, 3);
  assert.deepEqual(p.flat.map((s) => s.type), ['click', 'text', 'click']);
  assert.equal(p.flat[1].text, 'ab');
  assert.equal(p.map[0].rec, page.recs[0]);
  assert.deepEqual(p.map[1].subIdxs, [2, 3]);
  assert.equal(p.map[2].rec, page.recs[1]);
  assert.deepEqual(p.recs.map((r) => r.id), [10, 11]);
  assert.equal(prefixPlan(page, [], {}).total, 0);
  assert.equal(prefixPlan(page, [10], { skipMoves: false }).flat[0].type, 'move');
});

test('chainSideEffects: рахує сабміт-кроки лише в ланцюгу, без pending/disabled', () => {
  assert.equal(chainSideEffects(page, [10]), 0);
  assert.equal(chainSideEffects(page, [10, 11]), 1);
  const p2 = { recs: [{ id: 1, subs: [{ type: 'click', waitResponse: true }, { type: 'click', waitResponse: true, pending: true }, { type: 'click', waitResponse: true, disabled: true }] }] };
  assert.equal(chainSideEffects(p2, [1]), 1);
});

test('classifyLiveError: 410/504 → closed з причиною; 409 busy; 429 limit/queue; 503; мережа', () => {
  const e = (status, body) => ({ status, body, message: 'x' });
  assert.deepEqual(classifyLiveError(e(410, { code: 'session_closed', reason: 'config changed' })), { kind: 'closed', reason: 'config changed' });
  assert.equal(classifyLiveError({ event: 'error', code: 'session_closed', reason: 'r' }).kind, 'closed');
  assert.equal(classifyLiveError(e(504, { code: 'act_timeout', reason: 'дія зависла' })).kind, 'closed');
  assert.equal(classifyLiveError(e(409, { code: 'session_busy' })).kind, 'busy');
  assert.equal(classifyLiveError(e(429, { code: 'too_many_sessions' })).kind, 'limit');
  assert.equal(classifyLiveError(e(429, { code: 'session_queue_full' })).kind, 'queue');
  assert.equal(classifyLiveError(e(503, {})).kind, 'unavailable');
  assert.equal(classifyLiveError(e(400, {})).kind, 'invalid');
  assert.equal(classifyLiveError(Object.assign(new TypeError('Failed to fetch'), {})).kind, 'network');
  assert.equal(classifyLiveError(e(500, {})).kind, 'error');
});

test('beforeInputToKey: мобільна клавіатура → текст / Backspace / Enter', () => {
  assert.deepEqual(beforeInputToKey('insertText', 'й'), { type: 'text', text: 'й' });
  assert.deepEqual(beforeInputToKey('insertFromPaste', 'abc'), { type: 'text', text: 'abc' });
  assert.equal(beforeInputToKey('insertText', ''), null);
  assert.equal(beforeInputToKey('deleteContentBackward'), 'Backspace');
  assert.equal(beforeInputToKey('insertLineBreak'), 'Enter');
  assert.equal(beforeInputToKey('formatBold'), null);
});

test('isEditableStep / inspectDefault', () => {
  assert.equal(isEditableStep({ target: { kind: 'input' } }), true);
  assert.equal(isEditableStep({ target: { kind: 'button' } }), false);
  assert.equal(isEditableStep(null), false);
  assert.equal(inspectDefault({ engine: 'chromium', finePointer: true }), true);
  assert.equal(inspectDefault({ engine: 'camoufox', finePointer: true }), false, 'Camoufox — вимкнено за замовчуванням');
  assert.equal(inspectDefault({ engine: 'chromium', finePointer: false }), false, 'дотик — без hover');
});

// ---------- Стан рекордера (раніше покритий лише e2e) ----------
test('defaultZoom1: збережений вибір має пріоритет; дефолт — лише дотик + вузький', () => {
  assert.equal(defaultZoom1('1', false, false), true);
  assert.equal(defaultZoom1('0', true, true), false);
  assert.equal(defaultZoom1(null, true, true), true);
  assert.equal(defaultZoom1(null, true, false), false);
  assert.equal(defaultZoom1(null, false, true), false);
});

test('shouldHintZoom: дрібний кадр без 1:1 — один раз', () => {
  assert.equal(shouldHintZoom(0.29, false, false), true);
  assert.equal(shouldHintZoom(0.29, true, false), false);
  assert.equal(shouldHintZoom(0.29, false, true), false);
  assert.equal(shouldHintZoom(0.8, false, false), false);
  assert.equal(shouldHintZoom(NaN, false, false), false);
  assert.equal(shouldHintZoom(0, false, false), false);
});

test('pickMarkers: новіший поглинає близькі старіші; останні 3 — яскраві', () => {
  const m = (n, vx, vy) => ({ n, vx, vy });
  const out = pickMarkers([m(1, 10, 10), m(2, 200, 200), m(3, 400, 100), m(4, 205, 210), m(5, 600, 600), m(6, 800, 100)]);
  assert.deepEqual(out.map((x) => x.n), [1, 3, 4, 5, 6]); // №2 під №4 (дропдаун/повторний клік) — прибрано
  assert.deepEqual(out.filter((x) => !x.old).map((x) => x.n), [4, 5, 6]);
  assert.deepEqual(pickMarkers([]), []);
  assert.deepEqual(pickMarkers(null), []);
  assert.equal(pickMarkers([m(1, 0, 0)])[0].old, false);
  assert.deepEqual(pickMarkers([m(1, 0, 0), m(2, 100, 0)], { recent: 1 }).map((x) => x.old), [true, false]);
});

test('canResync: не під час відкриття і не двічі поспіль', () => {
  assert.equal(canResync({ phase: 'live' }), true);
  assert.equal(canResync({ phase: 'closed' }), true);
  assert.equal(canResync({ phase: 'opening' }), false);
  assert.equal(canResync({ phase: 'live', resyncing: true }), false);
  assert.equal(canResync({}), false);
});

test('undoIndex: останній підтверджений, pending пропускаємо', () => {
  assert.equal(undoIndex([]), -1);
  assert.equal(undoIndex([{ pending: true }]), -1);
  assert.equal(undoIndex([{}, { pending: true }, { pending: true }]), 0);
  assert.equal(undoIndex([{}, {}]), 1);
  assert.equal(undoIndex(null), -1);
});

test('applyActResult: заглушка → замінити / прибрати / дописати', () => {
  const pend = { type: 'click', pending: true };
  const subs = [{ id: 'a' }, pend];
  const r1 = applyActResult(subs, pend, { ok: true, step: { id: 'b', type: 'click' } });
  assert.deepEqual(r1, { op: 'replace', index: 1, step: { id: 'b', type: 'click' } });
  assert.deepEqual(applyActResult(subs, pend, { ok: false, error: 'x' }), { op: 'remove', index: 1 });
  assert.deepEqual(applyActResult(subs, pend, { ok: true, step: null }), { op: 'remove', index: 1 });
  assert.deepEqual(applyActResult(subs, pend, { ok: true, step: { id: 'c' } }, { rec: false }), { op: 'remove', index: 1 });
  // Заглушку вже прибрано (↶ / злиття) → дописати в кінець.
  assert.deepEqual(applyActResult([{ id: 'a' }], pend, { ok: true, step: { id: 'd' } }), { op: 'push', index: 1, step: { id: 'd' } });
  assert.deepEqual(applyActResult([{ id: 'a' }], pend, { ok: false }), { op: 'none', index: -1 });
  assert.deepEqual(applyActResult([], null, null), { op: 'none', index: -1 });
  // Крок — копія (мутація результату не чіпає відповідь).
  const res = { ok: true, step: { id: 'e' } };
  assert.notEqual(applyActResult([pend], pend, res).step, res.step);
});

test('resolveReattach: сценарій / Дія / нова Дія з назвою в межах сценарію / базові Дії', () => {
  const page = { id: 7, recs: [{ id: 3, name: 'Дія 1' }, { id: 9, name: 'Логін' }] };
  assert.equal(resolveReattach([page], { pageId: 99, recId: 3 }, 10).page, null);
  const ex = resolveReattach([page], { pageId: 7, recId: 9, baseRecIds: [3, 9, 42], mode: 'append' }, 10);
  assert.equal(ex.page, page);
  assert.equal(ex.rec, page.recs[1]);
  assert.equal(ex.isNew, false);
  assert.deepEqual(ex.baseRecIds, [3]); // без поточної і неіснуючої
  assert.equal(ex.mode, 'append');
  const n1 = resolveReattach([page], { pageId: 7, recId: 50, baseRecIds: [3, 9] }, 10);
  assert.equal(n1.isNew, true);
  assert.equal(n1.recId, 50);
  assert.equal(n1.recCounter, 50);
  assert.equal(n1.name, 'Дія 3'); // max(«Дія 1»)+1 = 2, але не менше recs.length+1 = 3
  assert.deepEqual(n1.baseRecIds, [3, 9]);
  assert.equal(n1.mode, 'appendTo');
  const n2 = resolveReattach([page], { pageId: 7, recId: 5 }, 10);
  assert.equal(n2.recId, 11);
  assert.equal(n2.recCounter, 11);
});

test('raceIdle: idle / timeout / forced', async () => {
  assert.equal(await raceIdle(Promise.resolve(true), null), 'idle');
  assert.equal(await raceIdle(Promise.resolve(false), null), 'timeout');
  assert.equal(await raceIdle(new Promise(() => {}), Promise.resolve()), 'forced');
  assert.equal(await raceIdle(Promise.reject(new Error('x')), null), 'timeout');
});
