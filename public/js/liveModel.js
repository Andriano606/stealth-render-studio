// liveModel.js — ЧИСТА логіка живого запису (без DOM під час імпорту; тестується в node:test).
// Використовують recorder.js (UI) і live-client.js (HTTP-клієнт сесії).
//   viewToPage(clientX, clientY, box, vp)  — точка на показаному скриншоті → CSS px viewport сесії
//                                            (від content-box <img>, а НЕ border-box);
//   viewPct(vx, vy, vp)                    — позиція в % для оверлея (маркери, ripple, бокс);
//   markersInView(marks, vp, url)          — номери записаних кліків, видимі в поточному скріні;
//   normalizeWheel(e, vpH)                 — deltaMode (рядки/сторінки) → пікселі;
//   createWindowCoalescer(...)             — збирає дельти колеса/жесту за вікно 120 мс → один scroll;
//   createTextBuffer(...)                  — буфер друкованих символів (textBufferReduce), скидання
//                                            після 400 мс простою або перед кліком/клавішею/скролом;
//   mergeActs(a, b) / enqueueAct(q, act)   — злиття сусідніх scroll/text у черзі (ліміт 10);
//   prefixPlan(page, recIds, opts)         — префікс для POST /live (flattenScenario) + мапа для бейджів;
//   planStart(page, {mode, recId})         — що відкривати/куди писати для режимів запису;
//   chainSideEffects(page, recIds)         — кроки з побічним ефектом (сабміт) у ланцюгу;
//   classifyLiveError(err)                 — 410/409/429/503/504 → вид помилки для UI;
//   beforeInputToKey(inputType, data)      — мобільна клавіатура (beforeinput) → крок/клавіша;
//   inspectDefault({engine, finePointer})  — підсвітка під курсором за замовчуванням;
//   defaultZoom1(stored, coarse, narrow)   — чи вмикати «1:1» за замовчуванням (дотик + вузький екран);
//   shouldHintZoom(scale, zoomOn, shown)   — показати підказку «Дрібно? Увімкни 1:1»;
//   pickMarkers(marks, {recent, minDist})  — маркери кліків без нагромаджень, старі — блідіші;
//   canResync({phase, resyncing})          — ⟲ не повторюється, поки попередній ще йде;
//   undoIndex(subs)                        — індекс останнього ПІДТВЕРДЖЕНОГО кроку (↶);
//   applyActResult(subs, sub, res, body)   — що зробити з рядком «…⏳» після відповіді дії;
//   resolveReattach(pages, saved, counter) — куди повертатись після перезавантаження вкладки;
//   raceIdle(idleP, forceP)                — 'idle' | 'timeout' | 'forced' (⏹ Готово чекає дію).
import { flattenScenario, textBufferReduce, flushTextBuffer, isSideEffectStep } from '../../lib/steps.js';
import { isEditableKind } from '../../lib/locators.js';
import { nextRecName } from './scenarioModel.js';

// ---------- Координати ----------
// box: {left, top, clientLeft, clientTop, clientWidth, clientHeight, padL?, padT?, padR?, padB?}
//      (getBoundingClientRect() + clientLeft/Top/Width/Height <img>). vp: {w, h} — viewport
//      сесії в CSS px (= px скриншота, бо scale:'css'). Поза зображенням → null.
export function viewToPage(clientX, clientY, box, vp) {
  if (!box || !vp || !(vp.w > 0) || !(vp.h > 0)) return null;
  const padL = box.padL || 0, padT = box.padT || 0, padR = box.padR || 0, padB = box.padB || 0;
  const cw = (box.clientWidth || 0) - padL - padR, ch = (box.clientHeight || 0) - padT - padB;
  if (!(cw > 0) || !(ch > 0)) return null;
  const lx = clientX - box.left - (box.clientLeft || 0) - padL;
  const ly = clientY - box.top - (box.clientTop || 0) - padT;
  if (lx < 0 || ly < 0 || lx >= cw || ly >= ch) return null;
  const x = Math.min(vp.w - 1, Math.max(0, Math.round(lx * vp.w / cw)));
  const y = Math.min(vp.h - 1, Math.max(0, Math.round(ly * vp.h / ch)));
  return { x, y };
}

// Масштаб «екранні px → CSS px сесії» (для жестів: вміст іде за пальцем).
export function viewScale(box, vp) {
  const cw = box && box.clientWidth;
  return cw > 0 && vp && vp.w > 0 ? vp.w / cw : 1;
}

// Позиція точки viewport у відсотках від зображення (оверлей розтягнуто на content-box).
export function viewPct(vx, vy, vp) {
  if (!vp || !(vp.w > 0) || !(vp.h > 0)) return null;
  return { left: (vx / vp.w) * 100, top: (vy / vp.h) * 100 };
}
// Бокс у viewport px → відсотки (для підсвітки під курсором).
export function boxPct(box, vp) {
  if (!box || !vp || !(vp.w > 0) || !(vp.h > 0)) return null;
  return { left: (box.x / vp.w) * 100, top: (box.y / vp.h) * 100, width: (box.w / vp.w) * 100, height: (box.h / vp.h) * 100 };
}

// marks: [{n, x, y, url}] — x/y у px ДОКУМЕНТА (як у кроці). Видимі в поточному
// скріні (той самий URL без #hash, усередині viewport) → [{n, vx, vy}].
const noHash = (u) => String(u || '').split('#')[0];
export function markersInView(marks, vp, url) {
  if (!Array.isArray(marks) || !vp) return [];
  const out = [];
  for (const m of marks) {
    if (!m || m.x == null || m.y == null) continue;
    if (url != null && m.url != null && noHash(m.url) !== noHash(url)) continue;
    const vx = m.x - (vp.scrollX || 0), vy = m.y - (vp.scrollY || 0);
    if (vx < 0 || vy < 0 || vx >= vp.w || vy >= vp.h) continue;
    out.push({ n: m.n, vx, vy });
  }
  return out;
}

// ---------- Колесо / жести ----------
export function normalizeWheel(e, vpH = 900) {
  const k = e && e.deltaMode === 1 ? 40 : e && e.deltaMode === 2 ? (vpH || 900) : 1;
  return { dx: Math.round((Number(e && e.deltaX) || 0) * k), dy: Math.round((Number(e && e.deltaY) || 0) * k) };
}

// Фіксоване вікно: перше add() запускає таймер на delay мс, по ньому — onFlush({dx, dy, vx, vy})
// із сумою дельт і ОСТАННЬОЮ точкою. flush() — скинути негайно (перед кліком/клавішею).
export function createWindowCoalescer({ delay = 120, onFlush, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let acc = null, t = null;
  const flush = () => {
    if (t != null) { clearTimer(t); t = null; }
    const a = acc; acc = null;
    if (a && (a.dx || a.dy)) onFlush(a);
    return a;
  };
  return {
    add({ dx = 0, dy = 0, vx, vy } = {}) {
      if (!acc) acc = { dx: 0, dy: 0, vx, vy };
      acc.dx += dx; acc.dy += dy;
      if (vx != null) acc.vx = vx;
      if (vy != null) acc.vy = vy;
      if (t == null) t = setTimer(flush, delay);
    },
    flush,
    cancel() { if (t != null) { clearTimer(t); t = null; } acc = null; },
    get pending() { return acc; },
  };
}

// ---------- Буфер тексту ----------
// input(x) — результат keyToStep / рядок-клавіша / keydown-подібний обʼєкт.
// onEmit(steps) — кроки до відправки (text з шаблоном, key); onChange(buf) — для показу.
export function createTextBuffer({ idleMs = 400, onEmit, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let buf = '', t = null;
  const stop = () => { if (t != null) { clearTimer(t); t = null; } };
  const flush = () => {
    stop();
    const r = flushTextBuffer(buf);
    const had = buf !== '';
    buf = r.buf;
    if (had) onChange(buf);
    if (r.emit.length) onEmit(r.emit);
    return r.emit;
  };
  return {
    input(x) {
      const before = buf;
      const r = textBufferReduce(buf, x);
      buf = r.buf;
      if (r.emit.length) { stop(); onEmit(r.emit); }
      if (buf !== before) onChange(buf);
      if (buf) { stop(); t = setTimer(flush, idleMs); }
      return r.emit;
    },
    // Буквальний текст (вставка з буфера обміну, мобільна клавіатура): дописати і (опційно) одразу скинути.
    append(text, { now = false } = {}) {
      if (!text) return [];
      buf += String(text);
      onChange(buf);
      if (now) return flush();
      stop(); t = setTimer(flush, idleMs);
      return [];
    },
    flush,
    clear() { stop(); const had = buf !== ''; buf = ''; if (had) onChange(buf); },
    get value() { return buf; },
  };
}

// ---------- Черга дій ----------
// Зливаємо лише сусідні однотипні записувані дії: scroll (суми дельт, остання точка)
// і text (конкатенація шаблонів). Решта — по одній, у порядку.
export function mergeActs(a, b) {
  if (!a || !b || a.type !== b.type || (a.rec !== false) !== (b.rec !== false)) return null;
  if (a.type === 'scroll') {
    return { ...a, dx: (Number(a.dx) || 0) + (Number(b.dx) || 0), dy: (Number(a.dy) || 0) + (Number(b.dy) || 0),
      vx: b.vx != null ? b.vx : a.vx, vy: b.vy != null ? b.vy : a.vy };
  }
  if (a.type === 'text') return { ...a, text: String(a.text || '') + String(b.text || '') };
  return null;
}

// queue: [{body, ...}] (лише очікуючі, без тієї, що в польоті). Повертає
// {queue, merged, dropped, item}: merged — act злито з останнім елементом; dropped — черга повна.
export function enqueueAct(queue, item, max = 10) {
  const q = Array.isArray(queue) ? queue.slice() : [];
  const last = q[q.length - 1];
  if (last && last.kind === 'act' && item.kind === 'act') {
    const m = mergeActs(last.body, item.body);
    if (m) { const merged = { ...last, body: m }; q[q.length - 1] = merged; return { queue: q, merged: true, dropped: false, item: merged }; }
  }
  if (q.length >= max) return { queue: q, merged: false, dropped: true, item: null };
  q.push(item);
  return { queue: q, merged: false, dropped: false, item };
}

// ---------- Префікс і план ----------
// Підмножина Дій сценарію (у порядку сценарію) → план префікса для POST /live:
// {flat (кроки), map:[{rec, subIdxs, recPos}] (для бейджів ▶/✓/✗), recs, total, results}
// (results — для runner.applyRunEvent: стратегія/мс/помилка кожного кроку префікса).
// Невідправлені (pending) кроки сюди потрапляти не мають — викликач спершу чекає порожню чергу.
export function prefixPlan(page, recIds, { skipMoves = true } = {}) {
  const ids = new Set((recIds || []).map(String));
  const recs = ((page && page.recs) || []).filter((r) => ids.has(String(r.id)));
  const fl = flattenScenario({ url: page && page.url, recs }, null, { skipMoves });
  const byId = new Map(recs.map((r) => [String(r.id), r]));
  const map = fl.map.map((m) => ({ rec: byId.get(String(m.recId)), subIdxs: m.subIdxs, recPos: m.recPos }));
  return { flat: fl.flat, map, recs, total: fl.flat.length, results: new Array(fl.flat.length).fill(null) };
}

// mode: 'append' — продовжити з кінця сценарію (префікс = усі Дії) у НОВУ Дію;
//       'fromStart' — лише URL, нова Дія в кінці;
//       'appendTo' — префікс = Дії до recId включно, нові кроки дописуються в неї.
// → {baseRecIds (Дії префікса без поточної), newRec: bool, recId}. Невідома Дія → throw.
export function planStart(page, { mode = 'append', recId } = {}) {
  const recs = (page && page.recs) || [];
  if (mode === 'appendTo') {
    const idx = recs.findIndex((r) => String(r.id) === String(recId));
    if (idx < 0) throw new Error('Дію ' + recId + ' не знайдено у сценарії');
    return { baseRecIds: recs.slice(0, idx).map((r) => r.id), newRec: false, recId: recs[idx].id };
  }
  if (mode === 'fromStart') return { baseRecIds: [], newRec: true, recId: null };
  return { baseRecIds: recs.map((r) => r.id), newRec: true, recId: null };
}

export function chainSideEffects(page, recIds) {
  const ids = new Set((recIds || []).map(String));
  let n = 0;
  for (const r of (page && page.recs) || []) {
    if (!ids.has(String(r.id))) continue;
    for (const s of r.subs || []) if (s && !s.pending && !s.disabled && isSideEffectStep(s)) n++;
  }
  return n;
}

// ---------- Помилки сесії ----------
// err — ApiError ({status, body:{code, reason}}) або подія {event:'error', code, reason}.
// → {kind: 'closed'|'busy'|'limit'|'queue'|'unavailable'|'invalid'|'network'|'error', reason}
export function classifyLiveError(err) {
  const status = err && (err.status || (err.body && err.body.status)) || 0;
  const body = (err && err.body) || err || {};
  const code = body.code || (err && err.code) || '';
  const reason = body.reason || null;
  if (status === 410 || code === 'session_closed') return { kind: 'closed', reason: reason || 'сесію закрито' };
  if (status === 504 || code === 'act_timeout') return { kind: 'closed', reason: reason || 'дія зависла — сесію закрито' };
  if (status === 409 || code === 'session_busy') return { kind: 'busy', reason };
  if (code === 'session_queue_full') return { kind: 'queue', reason };
  if (status === 429 || code === 'too_many_sessions') return { kind: 'limit', reason };
  if (status === 503) return { kind: 'unavailable', reason };
  if (status >= 400 && status < 500) return { kind: 'invalid', reason };
  if (!status && err && (err.name === 'TypeError' || /fetch|network/i.test(String(err.message || '')))) return { kind: 'network', reason };
  return { kind: 'error', reason };
}

// ---------- Клавіатура (мобільна) ----------
// beforeinput.inputType → вхід для буфера: {type:'text', text} | 'Backspace' | 'Enter' | null.
export function beforeInputToKey(inputType, data) {
  switch (inputType) {
    case 'insertText':
    case 'insertReplacementText':
    case 'insertFromPaste':
    case 'insertFromDrop':
      return data ? { type: 'text', text: String(data) } : null;
    case 'deleteContentBackward':
    case 'deleteWordBackward':
      return 'Backspace';
    case 'insertLineBreak':
    case 'insertParagraph':
      return 'Enter';
    default:
      return null;
  }
}

// Ціль кроку — редагована (тоді на мобільному піднімаємо екранну клавіатуру).
export function isEditableStep(step) {
  return !!(step && step.target && isEditableKind(step.target.kind));
}

// Підсвітка під курсором: лише точний вказівник (миша), не Camoufox (повільний hit-test).
export function inspectDefault({ engine, finePointer } = {}) {
  return !!finePointer && engine !== 'camoufox';
}

// ---------- Масштаб живого кадру ----------
// Збережений вибір користувача ('1'/'0') має пріоритет; без нього — «1:1» лише на дотиковому
// вузькому екрані (там 1280-px viewport у масштабі ~0.3 — поля по ~10 px, тап не влучає).
export function defaultZoom1(stored, coarse, narrow) {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return !!(coarse && narrow);
}
// Підказку показуємо один раз за сесію, коли кадр дрібний (< 0.5) і «1:1» вимкнено.
export const ZOOM_HINT_SCALE = 0.5;
export function shouldHintZoom(scale, zoomOn, shown) {
  return !zoomOn && !shown && Number.isFinite(scale) && scale > 0 && scale < ZOOM_HINT_SCALE;
}

// ---------- Маркери кліків ----------
// marks: [{n, vx, vy}] у порядку запису (вже відфільтровані markersInView). Новіший маркер
// «поглинає» старіші ближче за minDist px viewport (дропдаун: опція і поле під нею; повторні
// кліки), останні recent — яскраві, решта — old (блідіші, без номера).
export function pickMarkers(marks, { recent = 3, minDist = 24 } = {}) {
  const list = Array.isArray(marks) ? marks.filter((m) => m && Number.isFinite(m.vx) && Number.isFinite(m.vy)) : [];
  const kept = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (kept.some((k) => Math.hypot(k.vx - m.vx, k.vy - m.vy) < minDist)) continue;
    kept.push(m);
  }
  kept.reverse();
  const out = [];
  const newest = [...list].slice(-recent);
  for (const m of kept) out.push({ ...m, old: !newest.includes(m) });
  return out;
}

// ---------- Стан рекордера ----------
export function canResync({ phase, resyncing } = {}) {
  return !!phase && phase !== 'opening' && !resyncing;
}

export function undoIndex(subs) {
  const a = Array.isArray(subs) ? subs : [];
  for (let i = a.length - 1; i >= 0; i--) if (a[i] && !a[i].pending) return i;
  return -1;
}

// Відповідь /act для рядка-заглушки sub у subs:
//   {op:'remove', index}         — дія не вдалась / нічого не записано / не записуємо (rec:false);
//   {op:'replace', index, step}  — заглушку замінити підтвердженим кроком;
//   {op:'push', index, step}     — заглушки вже немає (напр. ↶ або злиття) → дописати в кінець;
//   {op:'none', index:-1}        — нічого не робити.
export function applyActResult(subs, sub, res, body = {}) {
  const a = Array.isArray(subs) ? subs : [];
  const i = sub ? a.indexOf(sub) : -1;
  const ok = !!res && res.ok !== false;
  if (!ok || !res.step || body.rec === false) return i >= 0 ? { op: 'remove', index: i } : { op: 'none', index: -1 };
  const step = { ...res.step };
  if (i >= 0) return { op: 'replace', index: i, step };
  return { op: 'push', index: a.length, step };
}

// saved: {sid, pageId, recId, baseRecIds, mode, engine} (sessionStorage).
// → {page|null, rec|null, isNew, recId, recCounter, name, baseRecIds, mode}
export function resolveReattach(pages, saved, recCounter = 0) {
  const s = saved || {};
  const page = (pages || []).find((p) => String(p.id) === String(s.pageId)) || null;
  const counter = Number(recCounter) || 0;
  if (!page) return { page: null, rec: null, isNew: false, recId: null, recCounter: counter, name: null, baseRecIds: [], mode: s.mode || 'appendTo' };
  const recs = page.recs || [];
  let rec = recs.find((r) => String(r.id) === String(s.recId)) || null;
  let recId = rec ? rec.id : null, next = counter, name = rec ? rec.name : null;
  if (!rec) {
    recId = Math.max(counter + 1, Number(s.recId) || 0);
    next = Math.max(counter, recId);
    name = nextRecName(page);
  }
  const baseRecIds = (s.baseRecIds || []).filter((id) => recs.some((r) => String(r.id) === String(id)) && String(id) !== String(recId));
  return { page, rec, isNew: !rec, recId, recCounter: next, name, baseRecIds, mode: s.mode || 'appendTo' };
}

// Чекання черги дій перед закриттям: перемагає те, що раніше —
// idleP (whenIdle → true/false за таймаутом) або forceP («Закрити все одно»).
export async function raceIdle(idleP, forceP) {
  const r = await Promise.race([
    Promise.resolve(idleP).then((v) => (v ? 'idle' : 'timeout'), () => 'timeout'),
    forceP ? Promise.resolve(forceP).then(() => 'forced') : new Promise(() => {}),
  ]);
  return r;
}
