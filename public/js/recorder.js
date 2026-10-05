// recorder.js — ЖИВИЙ запис Дії (synth.md §7): сервер тримає відкриту сторінку (POST /live),
// тут — її viewport-скриншот з оверлеєм і пересилання вводу (клік/клавіатура/колесо/жести).
// Кожна записана дія повертає крок v2 із семантичною ціллю → дописується в поточну Дію.
// Скріни в табах тепер лише результати (запис по статичному скріні прибрано).
//
// Публічне API (кнопки сайдбару — scenarios.js):
//   initRecorder()                                  — DOM (#recToolbar, #liveHost), pagehide, reattach;
//   start({page, mode, recId}) → Promise<bool>      — 'append' (з кінця сценарію, нова Дія),
//                                                     'fromStart' (лише URL, нова Дія),
//                                                     'appendTo' (дописати в Дію recId);
//   finish() → Promise<{page, rec, saved}>          — ⏹ Готово (порожню Дію відкидає, закриває сесію,
//                                                     додає таб з останнім кадром);
//   newRec(), resync(), undoLast(), isActive()      — дії тулбару (також доступні ззовні);
//   recorder = {start, finish, newRec, resync, undoLast, isActive}
//   startRec(page) / stopRec()                      — сумісність зі старим сайдбаром;
//   shotPoint(e, img)                               — чиста (сумісність): точка → px зображення з кліпом.
// Стан: state.recording/curPage/curRec (як і раніше) + state.live (див. кінець state.js).
// Збереження: подія 'page:changed' {page, pageId, reason} — дебаунс-збереження робить scenarios.js.
// Чиста логіка — liveModel.js, HTTP — live-client.js (обидва з тестами).
import { $, h, clear } from './dom.js';
import { state, on, emit, storage } from './state.js';
import { logLine, logMany, logRunSep, setLive, setConsoleCollapsed } from './log.js';
import { addScreen } from './viewer.js';
import { confirmDialog, toast } from './dialogs.js';
import { api } from './api.js';
import { ensureCurrentPreset } from './config.js';
import { applyRunEvent } from './runner.js';
import { createLiveClient, readSavedSession } from './live-client.js';
import {
  viewToPage, viewScale, viewPct, boxPct, markersInView, normalizeWheel, createWindowCoalescer,
  createTextBuffer, prefixPlan, planStart, chainSideEffects, classifyLiveError, beforeInputToKey,
  isEditableStep, inspectDefault, defaultZoom1, shouldHintZoom, pickMarkers, canResync, undoIndex,
  applyActResult, resolveReattach, raceIdle,
} from './liveModel.js';
import { nextRecName } from './scenarioModel.js';
import { keyToStep, stepLabel, isSideEffectStep } from '../../lib/steps.js';
import { humanError } from '../../lib/errText.js';
import { pluralUk } from './stepEditor.js';

const TEXT_IDLE_MS = 400;
// ⏹ Готово / ⟲ чекають дію в польоті не менше серверної межі дії (ACT_TIMEOUTS.act 60 с)
// + скриншот; раніше — лише «⏹ Закрити все одно» (інакше сабміт губився б мовчки).
const ACT_WAIT_MS = 75000;
const KBD_HINT_MS = 3000;
const MARK_RECENT = 3;
const WHEEL_MS = 120;
const INSPECT_MS = 250;
// Cmd/Ctrl-комбінації, які пересилаємо в сторінку; решта (Cmd+R, Cmd+T, Cmd+L…) лишається браузеру.
const FORWARD_COMBO = /^(?:ControlOrMeta|Control\+Meta)\+(?:Alt\+)?(?:Shift\+)?(?:a|c|x|z|y|Enter|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/;

let els = null;     // DOM
let rs = null;      // активний запис
let client = null;  // live-client поточної сесії
let textBuf = null, wheel = null;
let suppressClickUntil = 0;
let hoverPt = null, inspectT = null, inspectSeq = 0;
let twoFinger = null;
let pasteSeen = false;
let lastPointer = false; // останній ввід — вказівник (тоді LIVE фокусує кадр; з клавіатури — ⏹ Готово)
let consoleWasCollapsed = null;

const now = () => Date.now();
const media = (q) => { try { return !!(globalThis.matchMedia && globalThis.matchMedia(q).matches); } catch (_e) { return false; } };
const desktop = () => media('(min-width: 900px)');
const coarse = () => media('(pointer: coarse)');
const finePointer = () => media('(hover: hover) and (pointer: fine)');
const engineLabel = (e) => (e === 'camoufox' ? '🦊 Camoufox' : e ? '🧩 Chromium' : '…');
const confirmedCount = (rec) => (rec ? rec.subs.filter((x) => x && !x.pending).length : 0);

// ---------- Ініціалізація ----------
export function initRecorder() {
  ensureStylesheet();
  els = { viewer: $('viewer'), toolbar: $('recToolbar'), host: $('liveHost') };
  if (!els.viewer || !els.toolbar || !els.host) return;
  buildToolbar();
  buildHost();
  textBuf = createTextBuffer({ idleMs: TEXT_IDLE_MS, onEmit: emitTyped, onChange: renderTyping });
  wheel = createWindowCoalescer({ delay: WHEEL_MS, onFlush: sendScroll });
  // pagehide: спершу поставити сценарій у чергу збереження (persist.js шле keepalive-PUT
  // лише для id, що вже в черзі; recorder ініціалізується раніше за persist — порядок слухачів
  // гарантує, що id там буде), потім закрити сесію beacon-ом.
  globalThis.addEventListener('pagehide', () => {
    if (rs && rs.page) emit('page:changed', { page: rs.page, pageId: rs.page.id, reason: 'live-step' });
    if (client) client.beaconClose();
  });
  document.addEventListener('pointerdown', () => { lastPointer = true; }, true);
  document.addEventListener('keydown', (e) => { if (!els.stage || (e.target !== els.stage && e.target !== els.ime)) lastPointer = false; }, true);
  document.addEventListener('visibilitychange', () => { if (client && document.visibilityState === 'visible') client.poke(); });
  // Видалення кроку з сайдбару під час запису → підказка «⟲ відновити стан».
  on('pages', () => {
    if (!rs) return;
    const n = confirmedCount(rs.rec);
    if (n < rs.known) showUndoHint();
    rs.known = n;
    renderMarkers();
    renderRecent();
    updateToolbar();
  });
  tryReattachWhenReady();
}

// recorder.css підключаємо самі (index.html не чіпаємо — без збірки).
function ensureStylesheet() {
  if (document.querySelector('link[data-recorder-css]')) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href: '/css/recorder.css', 'data-recorder-css': '' }));
}

// short — коротший видимий підпис (aria-label лишається повним).
function tb(icon, label, cls, fn, { toggle = false, title, short } = {}) {
  return h('button', {
    type: 'button', class: 'rt-btn' + (cls ? ' ' + cls : ''), 'aria-label': label, title: title || label,
    'aria-pressed': toggle ? 'false' : null, on: { click: fn },
  }, h('span', { class: 'ic', 'aria-hidden': 'true', text: icon }), h('span', { class: 'lbl', 'aria-hidden': short ? 'true' : null, text: short || label }));
}

function buildToolbar() {
  const t = els.toolbar;
  clear(t);
  els.badge = h('span', { class: 'rt-live', role: 'status', 'aria-live': 'polite', text: '● LIVE' });
  els.engine = h('span', { class: 'rt-engine', title: 'Рушій сесії', text: '…' });
  els.title = h('span', { class: 'rt-title' });
  els.urlInput = h('input', {
    type: 'text', class: 'rt-url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Адреса сторінки (Enter — перейти)', placeholder: 'https://…',
  });
  const urlForm = h('form', { class: 'rt-urlform', role: 'search', on: { submit: (e) => { e.preventDefault(); navGoto(); } } }, els.urlInput);
  els.back = tb('◀', 'Назад', 'icon', () => doNav('back'));
  els.fwd = tb('▶', 'Вперед', 'icon', () => doNav('forward'));
  els.reload = tb('⟳', 'Перезавантажити', 'icon', () => doNav('reload'));
  els.pause = tb('⏸', 'Пауза запису', '', togglePause, { toggle: true, title: 'Пауза запису: дії йдуть у сторінку, але не записуються (напр. пройти Cloudflare вручну)' });
  els.wait = tb('⏳', 'Чекати відповідь', '', toggleWait, { toggle: true, title: 'Наступний клік чекає відповідь сервера (для кнопки сабміту)' });
  els.file = tb('📎', 'Файл', '', () => askFile(false), { title: 'Підставити файл у поле завантаження' });
  els.scrollRec = tb('↕', 'Скроли', '', toggleScrollRec, { toggle: true, title: 'Записувати прокрутку як кроки (за замовчуванням — ні)' });
  els.inspect = tb('🔍', 'Підсвітка', '', toggleInspect, { toggle: true, title: 'Підсвічувати елемент під курсором' });
  els.kbd = tb('⌨', 'Клавіатура', 'kbd-only', () => focusIme(true), { title: 'Показати екранну клавіатуру' });
  els.zoom = tb('⤢', 'Масштаб 1:1', 'zoom-only', toggleZoom, { toggle: true, short: '1:1', title: 'Показати сторінку 1:1 (прокрутка всередині перегляду) — точніші тапи на вузькому екрані' });
  els.undo = tb('↶', 'Видалити останній', '', undoLast, { title: 'Видалити останній записаний крок' });
  els.resync = tb('⟲', 'Відновити стан', '', resync, { title: 'Перевідкрити сесію: відтворити ланцюг Дій заново' });
  els.newRec = tb('＋', 'Нова Дія', '', newRec, { title: 'Завершити поточну Дію і почати нову в цій самій сесії' });
  els.done = tb('⏹', 'Готово', 'done', () => { finish(); }, { title: 'Зберегти Дію і закрити сесію' });
  t.append(
    h('div', { class: 'rt-row rt-head' }, els.badge, els.engine, els.title),
    h('div', { class: 'rt-row rt-nav' }, els.back, els.fwd, els.reload, urlForm),
    h('div', { class: 'rt-row rt-acts' },
      h('div', { class: 'rt-group', role: 'group', 'aria-label': 'Режими' }, els.pause, els.wait, els.scrollRec, els.inspect, els.kbd, els.zoom),
      h('div', { class: 'rt-group', role: 'group', 'aria-label': 'Кроки' }, els.file, els.undo, els.resync),
      h('div', { class: 'rt-group rt-end', role: 'group', 'aria-label': 'Дія' }, els.newRec, els.done)));
}

function buildHost() {
  const host = els.host;
  clear(host);
  els.banners = h('div', { class: 'live-banners', 'aria-live': 'polite' });
  els.img = h('img', { class: 'live-shot', alt: 'Жива сторінка', draggable: 'false', hidden: true });
  els.overlay = h('div', { class: 'live-overlay', 'aria-hidden': 'true' });
  els.hover = h('div', { class: 'live-hover', hidden: true }, h('span', { class: 'live-hover-lbl' }));
  els.typing = h('div', { class: 'live-typing', hidden: true });
  els.marks = h('div', { class: 'live-marks' });
  els.overlay.append(els.hover, els.marks, els.typing);
  els.frame = h('div', { class: 'live-frame' }, els.img, els.overlay);
  els.opening = h('div', { class: 'live-opening', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'spin', 'aria-hidden': 'true' }),
    els.openTitle = h('div', { class: 'live-open-title' }),
    els.openStatus = h('div', { class: 'live-open-status' }),
    els.openProg = h('div', { class: 'live-open-prog' }));
  els.hint = h('div', { class: 'live-kbd-hint', id: 'liveKbdHint', text: '⌨ клавіатура (і Tab) → сторінка · Shift+Esc — вийти' });
  // Прихований input: на дотикових екранах піднімає екранну клавіатуру, коли ціль редагована.
  // tabindex=-1 — фокус лише з коду (⌨ Клавіатура / тап по полю), не пастка для Tab.
  els.ime = h('input', {
    class: 'live-ime', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    'aria-label': 'Ввід тексту в живу сторінку (Shift+Esc — вийти)', enterkeyhint: 'send', tabindex: '-1',
  });
  els.ime.value = ' ';
  els.stage = h('div', {
    class: 'live-stage', tabindex: '0', role: 'application',
    'aria-label': 'Жива сторінка: клік — клік у сторінці, клавіатура — ввід у сторінку, колесо — прокрутка',
    'aria-describedby': 'liveKbdHint',
  }, els.frame, els.opening, els.hint, els.ime);
  els.fileInput = h('input', { type: 'file', hidden: true, on: { change: onFileChosen } });
  // < 900 px список кроків — в іншій панелі; тут — останні кроки поточної Дії (CSS ховає на десктопі).
  els.recent = h('div', { class: 'live-recent', 'aria-label': 'Останні записані кроки' });
  host.append(els.banners, els.stage, els.recent, els.fileInput);
  // «1:1» за замовчуванням — лише дотик + вузький екран (збережений вибір має пріоритет;
  // дефолт не записуємо — його пише тільки toggleZoom).
  if (defaultZoom1(storage.get('liveZoom1'), coarse(), media('(max-width: 899px)'))) els.stage.classList.add('zoom-1');
  els.stage.addEventListener('focus', showKbdHint);

  els.frame.addEventListener('click', onFrameClick);
  els.frame.addEventListener('mousemove', onFrameMove);
  els.frame.addEventListener('mouseleave', () => { hoverPt = null; inspectSeq++; hideHover(); });
  els.stage.addEventListener('wheel', onWheel, { passive: false });
  els.stage.addEventListener('keydown', onStageKey);
  els.stage.addEventListener('paste', onPaste);
  els.frame.addEventListener('touchstart', onTouchStart, { passive: false });
  els.frame.addEventListener('touchmove', onTouchMove, { passive: false });
  els.frame.addEventListener('touchend', onTouchEnd);
  els.frame.addEventListener('touchcancel', onTouchEnd);
  els.ime.addEventListener('keydown', onImeKey);
  els.ime.addEventListener('beforeinput', onImeBeforeInput);
  els.ime.addEventListener('compositionend', onImeComposition);
  els.ime.addEventListener('paste', onPaste);
  els.img.addEventListener('load', () => { renderMarkers(); maybeHintZoom(); });
}

// Підказка про клавіатуру — кілька секунд після фокуса кадру (не весь запис поверх сторінки).
let hintT = null, hintAt = 0;
function showKbdHint() {
  if (now() - hintAt < 10000) return;
  hintAt = now();
  els.stage.classList.add('hint-on');
  clearTimeout(hintT);
  hintT = setTimeout(() => { if (els) els.stage.classList.remove('hint-on'); }, KBD_HINT_MS);
}

// Кадр дрібний (масштаб < 0.5, «1:1» вимкнено) → один раз за сесію підказати «1:1».
function maybeHintZoom() {
  if (!rs || rs.phase !== 'live' || !els.img.clientWidth) return;
  const k = 1 / viewScale({ clientWidth: els.img.clientWidth }, curVp());
  if (!shouldHintZoom(k, els.stage.classList.contains('zoom-1'), rs.zoomHintShown)) return;
  rs.zoomHintShown = true;
  showBanner('zoom', 'Дрібно? Увімкни 1:1 для точних тапів.', [{ label: '🔍 1:1', primary: true, fn: () => { hideBanner('zoom'); if (!els.stage.classList.contains('zoom-1')) toggleZoom(); } }], 'info');
}

// ---------- Режими UI ----------
function enterLiveUI() {
  els.viewer.classList.add('live-mode');
  // Десктоп: консоль згортаємо до заголовка — кадр живої сторінки вміщається повністю
  // (попередній стан повертаємо після ⏹ Готово).
  if (desktop() && consoleWasCollapsed == null) consoleWasCollapsed = setConsoleCollapsed(true);
  els.toolbar.hidden = false;
  els.host.hidden = false;
  els.img.hidden = true;
  els.img.removeAttribute('src');
  clear(els.marks); clear(els.banners);
  hideHover(); renderTyping('');
  renderRecent();
  updateToolbar();
}
function exitLiveUI() {
  els.viewer.classList.remove('live-mode');
  if (consoleWasCollapsed != null) { setConsoleCollapsed(consoleWasCollapsed); consoleWasCollapsed = null; }
  if (document.activeElement === els.ime) els.ime.blur();
  els.toolbar.hidden = true;
  els.host.hidden = true;
  closePopover();
  clear(els.banners);
}

function setPhase(phase) {
  if (!rs) return;
  rs.phase = phase;
  els.stage.dataset.phase = phase;
  els.opening.hidden = phase !== 'opening';
  if (phase !== 'live' && document.activeElement === els.ime) els.ime.blur();
  publish();
  updateToolbar();
}

function setOpening(title, status, prog) {
  if (title != null) els.openTitle.textContent = title;
  if (status != null) els.openStatus.textContent = status;
  if (prog != null) els.openProg.textContent = prog;
}

function publish() {
  state.live = rs ? {
    phase: rs.phase, sid: client ? client.sid : null, engine: rs.engine, paused: rs.paused,
    waitNext: rs.waitNext, pageId: rs.page.id, recId: rs.rec.id,
  } : null;
  emit('live', state.live);
}

function updateToolbar() {
  if (!els || !rs) return;
  const live = rs.phase === 'live';
  const busy = !!(client && client.busy);
  els.badge.textContent = rs.phase === 'opening' ? '◌ Відкриваю…' : rs.phase === 'closed' ? '○ Сесію закрито' : rs.paused ? '⏸ ПАУЗА' : '● LIVE';
  els.badge.className = 'rt-live ' + (rs.phase === 'live' ? (rs.paused ? 'paused' : 'on') : rs.phase);
  els.engine.textContent = engineLabel(rs.engine);
  els.title.textContent = '⏺ «' + rs.rec.name + '» · ' + rs.page.name;
  els.title.title = 'Запис у Дію «' + rs.rec.name + '» сценарію «' + rs.page.name + '»';
  for (const b of [els.back, els.fwd, els.reload, els.file, els.urlInput]) b.disabled = !live;
  setPressed(els.pause, rs.paused);
  setPressed(els.wait, rs.waitNext);
  setPressed(els.scrollRec, rs.recScroll);
  setPressed(els.inspect, !!rs.inspectOn);
  setPressed(els.zoom, els.stage.classList.contains('zoom-1'));
  els.pause.disabled = !live;
  els.wait.disabled = !live;
  els.inspect.disabled = !live;
  els.kbd.disabled = !live;
  els.undo.disabled = busy || !!rs.resyncing || !confirmedCount(rs.rec);
  els.resync.disabled = !canResync(rs);
  els.newRec.disabled = !live || !!rs.resyncing || !confirmedCount(rs.rec);
  els.done.disabled = !!rs.finishing;
  // Дія ще виконується (напр. сабміт із ⏳) — видно на ⏹ Готово, але кнопка лишається активною.
  els.done.title = busy ? 'Зберегти Дію і закрити сесію (дочекається дії, що виконується)' : 'Зберегти Дію і закрити сесію';
  els.frame.classList.toggle('busy', busy);
}
function setPressed(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.classList.toggle('on', !!on); }

// Банери над живим переглядом: key — один на тип (config/closed/file/undo/error).
function showBanner(key, text, actions = [], kind = 'info', { autoHideMs = 0 } = {}) {
  hideBanner(key);
  const b = h('div', { class: 'live-banner ' + kind, dataset: { key }, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'txt', text }),
    actions.map((a) => h('button', { type: 'button', class: 'btn btn-small ' + (a.primary ? 'btn-primary' : 'btn-ghost'), text: a.label, on: { click: a.fn } })),
    h('button', { type: 'button', class: 'x', 'aria-label': 'Сховати повідомлення', text: '✕', on: { click: () => hideBanner(key) } }));
  els.banners.appendChild(b);
  if (autoHideMs) setTimeout(() => { if (b.isConnected) b.remove(); }, autoHideMs);
  return b;
}
function hideBanner(key) {
  for (const b of [...els.banners.children]) if (b.dataset.key === key) b.remove();
}

// ---------- Старт / сесія ----------
export async function start({ page, mode = 'append', recId } = {}) {
  if (!els || !page || rs || state.running || state.recording) return false;
  let plan;
  try { plan = planStart(page, { mode, recId }); } catch (e) { setLive('Помилка: ' + e.message, false); return false; }
  let rec;
  if (plan.newRec) {
    const id = ++state.recCounter; // id — глобальний (reattach, saved.recId); назва — в межах сценарію
    rec = { id, name: nextRecName(page), subs: [], expanded: true };
    page.recs.push(rec);
  } else rec = page.recs.find((r) => String(r.id) === String(plan.recId));
  rec.isRecording = true; rec.expanded = true; page.expanded = true;
  state.recording = true; state.curPage = page; state.curRec = rec;
  rs = {
    page, rec, mode, baseRecIds: plan.baseRecIds.slice(), newRecIds: new Set(plan.newRec ? [rec.id] : []),
    phase: 'opening', paused: false, waitNext: false, recScroll: storage.get('liveRecScroll') === '1',
    inspectOn: null, marks: [], engine: null, lastShot: null, lastClickPt: null, known: confirmedCount(rec),
    gen: 0, ac: null, finishing: null, resyncing: false, zoomHintShown: false,
  };
  enterLiveUI();
  setPhase('opening');
  setOpening('Відкриваю ' + page.url + '…', '', '');
  emit('busy'); emit('pages');
  if (!(await confirmChain())) { await finish({ cancelled: true }); return false; }
  return openSession();
}

// Підтвердження перед відтворенням ланцюга з сабмітом (етичне обмеження: не спамимо форми).
async function confirmChain() {
  const s = rs;
  if (!s) return false;
  const ids = [...s.baseRecIds, s.rec.id];
  const n = chainSideEffects(s.page, ids);
  if (!n) return true;
  const ok = await confirmDialog({
    title: 'Ланцюг відправить форму',
    message: 'Префікс містить ' + n + ' крок(и) з побічним ефектом (сабміт або «чекати відповідь»). '
      + 'Відтворення справді відправить форму ще раз. Продовжити?',
    okText: 'Так, відтворити', danger: true,
  });
  return ok && rs === s;
}

async function openSession() {
  const s = rs;
  if (!s) return false;
  const gen = ++s.gen;
  hideBanner('closed'); hideBanner('config'); hideBanner('error');
  setPhase('opening');
  const ids = [...s.baseRecIds, s.rec.id];
  const plan = prefixPlan(s.page, ids); // legacy-рухи миші пропускаються
  setOpening('Відкриваю ' + s.page.url + '…', 'Синхронізую конфіг…', '');
  let preset = '';
  try { preset = await ensureCurrentPreset(); } catch (e) { preset = '⚠️ ' + e.message; }
  if (rs !== s || gen !== s.gen) return false;
  logRunSep('⏺ Запис «' + s.rec.name + '» у «' + s.page.name + '» — префікс ' + nSteps(plan.total));
  logLine('info', '⚙ Пресет: ' + preset);
  for (const r of plan.recs) {
    r.running = true; r.runCur = 0;
    r.runTotal = plan.map.filter((m) => m.rec === r).length;
    for (const a of r.subs) if (a && typeof a === 'object' && !a.pending) { delete a.status; delete a.error; }
  }
  emit('pages');
  const prog = plan.total ? 'відтворюю ' + nSteps(plan.total) + ' (' + nRecs(plan.recs.filter((r) => r.runTotal).length) + ')' : 'лише відкриття URL';
  setOpening(null, 'Чекаю вільний слот браузера…', prog);
  const c = createLiveClient({ onEvent: (t, p) => { if (client === c) onClientEvent(t, p); } });
  client = c;
  if (s.ac) { try { s.ac.abort(); } catch (_e) { /* */ } }
  s.ac = new AbortController();
  try {
    const live = await c.open({ url: s.page.url, actions: plan.flat, recId: s.rec.id }, (ev) => onOpenEvent(s, plan, ev), {
      signal: s.ac.signal, meta: { pageId: s.page.id, recId: s.rec.id, baseRecIds: s.baseRecIds, mode: s.mode },
    });
    if (rs !== s || gen !== s.gen || client !== c) { c.close(); return false; }
    s.engine = live.engine || null;
    if (s.inspectOn == null) s.inspectOn = inspectDefault({ engine: s.engine, finePointer: finePointer() });
    setPhase('live');
    logLine('info', '● LIVE: клікай по сторінці, друкуй, крути колесо — кроки записуються в «' + s.rec.name + '».');
    setLiveIdle();
    // Старт мишею/тапом — фокус на кадр (друк одразу йде в сторінку); з клавіатури — на
    // ⏹ Готово, щоб наступний Tab не записався кроком.
    try { (lastPointer ? els.stage : els.done).focus({ preventScroll: true }); } catch (_e) { /* */ }
    return true;
  } catch (e) {
    if (rs !== s || gen !== s.gen) return false;
    if (client === c) client = null;
    if (e && e.name === 'AbortError') return false;
    const k = classifyLiveError(e);
    const msg = k.kind === 'limit' ? 'Забагато живих сесій одночасно (максимум 2) — заверши запис в іншій вкладці.'
      : k.kind === 'unavailable' ? 'Усі слоти браузера зайняті — спробуй за хвилину.'
        : 'Сесію не відкрито: ' + (humanError(e) || 'помилка');
    logLine('error', '❌ ' + msg);
    setLive('❌ ' + msg, false);
    setPhase('closed');
    showBanner('error', msg, [{ label: '⟲ Спробувати ще', fn: resync, primary: true }, { label: '⏹ Скасувати', fn: () => finish() }], 'error');
    return false;
  } finally {
    for (const r of plan.recs) r.running = false;
    emit('pages');
  }
}

function onOpenEvent(s, plan, ev) {
  if (rs !== s || !ev) return;
  switch (ev.event) {
    case 'log': logLine(ev.kind, ev.text); break;
    case 'status': setOpening(null, ev.text || '…'); break;
    case 'action':
    case 'done-action': {
      const r = applyRunEvent(plan, ev);
      if (ev.event === 'action') setOpening(null, null, 'відтворюю ' + nSteps(plan.total) + ' · ' + (ev.index + 1) + '/' + plan.total);
      if (r && ev.event === 'done-action' && !ev.ok && !ev.skipped && ev.error) logLine('warn', '⚠️ Префікс, «' + r.rec.name + '», крок ' + (ev.index + 1) + ': ' + ev.error);
      emit('pages');
      break;
    }
    case 'error': logLine('error', '❌ ' + (humanError(ev.message) || 'помилка відкриття')); break;
    default: break;
  }
}

function onClientEvent(type, p) {
  if (!rs) return;
  switch (type) {
    case 'snap': {
      if (p.vp) rs.vp = p.vp;
      if (p.shot) { rs.lastShot = p.shot; els.img.src = p.shot; els.img.hidden = false; }
      if (p.url != null && document.activeElement !== els.urlInput) els.urlInput.value = p.url;
      rs.url = p.url;
      renderMarkers();
      break;
    }
    case 'logs': logMany(p); break;
    case 'config':
      if (p) showBanner('config', 'Конфіг змінено після відкриття сесії — вона працює зі старим.', [{ label: '⟲ Перевідкрити', fn: resync, primary: true }], 'warn');
      else hideBanner('config');
      break;
    case 'closed': onSessionClosed(p.reason); break;
    case 'busy': updateToolbar(); break;
    case 'dropped': logLine('warn', '⚠️ Забагато дій у черзі — дію пропущено. Зачекай, поки сторінка відповість.'); break;
    case 'net': setLive('⚠️ Немає звʼязку з сервером…', false); break;
    default: break;
  }
}

function onSessionClosed(reason) {
  if (!rs) return;
  textBuf.clear(); wheel.cancel();
  closePopover(); hideHover();
  const stale = rs.rec.subs.filter((x) => x && x.pending);
  for (const sub of stale) removeSub(rs.rec, sub);
  if (stale.length) emit('page:changed', { page: rs.page, pageId: rs.page.id, reason: 'live-step' });
  setPhase('closed');
  const msg = 'Сесію закрито (' + (reason || 'невідомо') + '). Записані кроки збережено.';
  logLine('warn', '⚠️ ' + msg);
  setLive('⚠️ ' + msg, false);
  showBanner('closed', msg, [{ label: '⟲ Відновити', fn: resync, primary: true }, { label: '⏹ Готово', fn: () => finish() }], 'warn');
  emit('pages');
}

// Дочекатись дій у черзі перед закриттям сесії: банер «⏳ Чекаю завершення дії…» з
// «⏹ Закрити все одно». → 'idle' | 'timeout' | 'forced' | 'gone' (запис уже інший).
async function waitForQueue(s) {
  if (!client || client.closed || !client.busy) return 'idle';
  let force;
  const forceP = new Promise((r) => { force = r; });
  showBanner('wait', '⏳ Чекаю завершення дії (напр. відповіді сервера на сабміт)…',
    [{ label: '⏹ Закрити все одно', fn: () => force() }], 'info');
  setLive('⏳ Чекаю завершення дії перед закриттям сесії…', false, true);
  const r = await raceIdle(client.whenIdle(ACT_WAIT_MS), forceP);
  if (els) hideBanner('wait');
  if (rs !== s) return 'gone';
  if (r !== 'idle') {
    const lost = s.rec.subs.filter((x) => x && x.pending);
    const risky = lost.filter((x) => x.waitResponse || isSideEffectStep(x));
    const msg = '⚠️ Дію перервано до відповіді сервера — ' + (lost.length ? nSteps(lost.length) + ' НЕ записано' : 'крок може бути не записано')
      + (risky.length || lost.length ? ', хоча сайт міг її виконати (напр. форму відправлено).' : '.');
    logLine('warn', msg);
    toast(msg, { kind: 'warn', timeout: 12000 });
  }
  return r;
}

// ⟲ Відновити стан: перевідкрити сесію з префіксом «базові Дії + поточна».
// Single-flight: повторний клік, поки йде попередній, — ігнорується (інакше дві сесії і
// подвійне відтворення префікса, можливо з сабмітом).
export async function resync() {
  const s = rs;
  if (!s || !canResync(s)) return;
  s.resyncing = true;
  updateToolbar();
  try {
    flushInputs();
    if (client && !client.closed && client.busy) {
      const r = await waitForQueue(s);
      if (r === 'gone') return;
    }
    if (!(await confirmChain())) return;
    if (rs !== s) return;
    const old = client;
    client = null;
    if (old && !old.closed) await old.close();
    closePopover();
    if (rs !== s) return;
    await openSession();
  } finally {
    s.resyncing = false;
    if (rs === s) updateToolbar();
  }
}

// ＋ Нова Дія: поточну закриваємо (зберігаємо), нову вставляємо одразу після неї, сесія та сама.
export async function newRec() {
  const s = rs;
  if (!s || s.phase !== 'live') return;
  flushInputs();
  await client.whenIdle(10000);
  if (rs !== s) return;
  if (!confirmedCount(s.rec)) { showBanner('info', 'Поточна Дія порожня — спершу запиши кроки.', [], 'info', { autoHideMs: 4000 }); return; }
  s.rec.isRecording = false;
  s.baseRecIds.push(s.rec.id);
  const id = ++state.recCounter;
  const rec = { id, name: nextRecName(s.page), subs: [], expanded: true, isRecording: true };
  const idx = s.page.recs.indexOf(s.rec);
  s.page.recs.splice(idx + 1, 0, rec);
  s.newRecIds.add(rec.id);
  s.rec = rec; state.curRec = rec; s.marks = []; s.known = 0;
  if (client) client.setMeta({ recId: rec.id, baseRecIds: s.baseRecIds });
  logLine('info', '＋ Нова Дія «' + rec.name + '» — у тій самій сесії');
  emit('page:changed', { page: s.page, pageId: s.page.id, reason: 'new-rec' });
  emit('pages');
  publish(); updateToolbar(); renderMarkers();
}

// ⏹ Готово: дописати буфери, дочекатись черги, закрити сесію, таб з останнім кадром.
export async function finish({ cancelled = false } = {}) {
  const s = rs;
  if (!s) return { page: null, rec: null, saved: false };
  if (s.finishing) return s.finishing;
  s.finishing = (async () => {
    updateToolbar();
    // Фокус був у тулбарі/кадрі (або вже на <body>) — після виходу з LIVE повернемо його на таб результату.
    const ae = document.activeElement;
    const restoreFocus = !ae || ae === document.body || els.toolbar.contains(ae) || els.host.contains(ae);
    if (s.phase === 'live') flushInputs(); else { textBuf.clear(); wheel.cancel(); }
    if (!cancelled && client && !client.closed) await waitForQueue(s);
    if (s.ac) { try { s.ac.abort(); } catch (_e) { /* */ } }
    closePopover();
    const c = client; client = null;
    const lastUrl = c ? c.url : s.url;
    if (c && !c.closed) await c.close();
    let changed = false;
    for (const rec of s.page.recs) {
      if (!rec) continue;
      const before = rec.subs.length;
      rec.subs = rec.subs.filter((x) => !(x && x.pending));
      if (rec.subs.length !== before) changed = true;
      rec.isRecording = false; rec.running = false;
    }
    // Порожні Дії, створені цим записом, не зберігаємо.
    const emptyNew = s.page.recs.filter((r) => s.newRecIds.has(r.id) && !r.subs.length);
    if (emptyNew.length) s.page.recs = s.page.recs.filter((r) => !emptyNew.includes(r));
    const saved = s.rec.subs.length > 0 && !emptyNew.includes(s.rec);
    if (!cancelled && s.lastShot) addScreen('Запис «' + s.rec.name + '» · ' + s.page.name, s.lastShot, lastUrl || s.page.url, { ok: true });
    rs = null;
    state.recording = false; state.curPage = null; state.curRec = null;
    exitLiveUI();
    publish();
    setLive(cancelled ? 'Запис скасовано.' : saved ? 'Збережено «' + s.rec.name + '» (' + nSteps(s.rec.subs.length) + ').' : 'Порожню Дію не збережено.', false);
    if (!cancelled) logLine('info', '⏹ Запис завершено' + (saved ? ': «' + s.rec.name + '», ' + nSteps(s.rec.subs.length) : ''));
    emit('busy'); emit('pages');
    if (saved || changed || s.newRecIds.size > emptyNew.length) emit('page:changed', { page: s.page, pageId: s.page.id, reason: 'finish' });
    if (restoreFocus) focusAfterFinish(s.page);
    return { page: s.page, rec: s.rec, saved };
  })();
  return s.finishing;
}

export function isActive() { return !!rs; }

// Після ⏹ Готово: таб щойно доданого скріна (на вузькому екрані сайдбар у іншій панелі),
// інакше — «⏺ Записати» цього сценарію.
function focusAfterFinish(page) {
  const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  raf(() => raf(() => {
    const ae = document.activeElement;
    if (ae && ae !== document.body && !(els.toolbar.contains(ae) || els.host.contains(ae))) return; // користувач уже деінде
    const vis = (el) => el && el.offsetParent !== null;
    const tab = document.querySelector('#tabs [role="tab"][aria-selected="true"]');
    const rec = document.querySelector('[data-fk="p' + page.id + '-rec"]');
    const t = vis(tab) ? tab : vis(rec) ? rec : null;
    if (t) try { t.focus(); } catch (_e) { /* */ }
  }));
}

const nSteps = (n) => n + ' ' + pluralUk(n, ['крок', 'кроки', 'кроків']);
const nRecs = (n) => n + ' ' + pluralUk(n, ['Дія', 'Дії', 'Дій']);

// Рядок статусу під час живого запису (крапка «грає» малюється самим setLive).
function setLiveIdle() {
  if (rs && rs.phase === 'live') setLive('LIVE — запис «' + rs.rec.name + '» у «' + rs.page.name + '»', true);
}

// ---------- Дії ----------
const live = () => !!(rs && rs.phase === 'live' && client && !client.closed);

function removeSub(rec, sub) {
  if (!rec || !sub) return;
  const i = rec.subs.indexOf(sub);
  if (i >= 0) rec.subs.splice(i, 1);
}

// Відправка дії: pendingSub — рядок «…⏳» у списку кроків (лише коли записуємо).
function doAct(body, pendingSub) {
  if (!live()) return null;
  const rec = rs.rec;
  const meta = pendingSub ? { sub: pendingSub, rec } : { rec };
  const { promise, merged, item } = client.enqueueAct(body, meta);
  if (merged) {
    // Злито з попередньою дією в черзі (текст/скрол) — оновлюємо її рядок, новий не додаємо.
    if (item && item.meta && item.meta.sub && body.type === 'text') item.meta.sub.text = item.body.text;
    emit('pages');
    return promise;
  }
  if (!item) return promise; // черга повна
  if (pendingSub) { rec.subs.push(pendingSub); emit('pages'); }
  promise.then((res) => onActResult(body, res, item.meta), (err) => onActError(body, err, item.meta));
  return promise;
}

function onActResult(body, res, meta) {
  const sub = meta && meta.sub;
  const rec = meta && meta.rec;
  if (!rs) { if (rec && sub) removeSub(rec, sub); return; } // запис уже завершено — заглушку прибираємо
  if (res && res.ok === false) {
    const msg = '❌ ' + actName(body) + ': ' + (humanError(res.error) || 'не вдалося');
    logLine('error', msg);
    showBanner('error', msg, [], 'error', { autoHideMs: 6000 });
  }
  const r = applyActResult(rec ? rec.subs : [], sub, res, body);
  if (r.op === 'remove') rec.subs.splice(r.index, 1);
  else if (r.op === 'replace' || r.op === 'push') {
    const step = r.step;
    rec.subs.splice(r.index, r.op === 'replace' ? 1 : 0, step);
    if (rec === rs.rec) rs.known = confirmedCount(rec);
    if (step.type === 'click' || step.type === 'select') rs.marks.push({ step, url: res.url || rs.url });
    rs.lastStep = step;
    // Кожен підтверджений крок — одразу в чергу збереження (persist.js дебаунсить і зливає),
    // навіть якщо черга дій ще не порожня: інакше перезавантаження вкладки їх губить.
    emit('page:changed', { page: rs.page, pageId: rs.page.id, reason: 'live-step' });
  }
  if (res && res.step) rs.lastStep = res.step;
  if (body.type === 'file') setLiveIdle();
  if (res && res.needSelect) openSelect(res.needSelect.options || [], body);
  if (res && res.needFile) askFile(true);
  if (res && body.type === 'click' && coarse() && isEditableStep(res.step)) focusIme(false);
  emit('pages');
  renderMarkers();
  updateToolbar();
}

function onActError(body, err, meta) {
  if (meta) removeSub(meta.rec, meta.sub);
  if (!rs) return;
  if (body.type === 'file') setLiveIdle();
  const k = classifyLiveError(err);
  if (k.kind !== 'closed') {
    const msg = '❌ ' + actName(body) + ': ' + (humanError(err) || 'помилка');
    logLine('error', msg);
    showBanner('error', msg, [], 'error', { autoHideMs: 6000 });
  }
  emit('pages');
  updateToolbar();
}

function actName(b) {
  return { click: 'клік', text: 'текст', key: 'клавіша', scroll: 'прокрутка', file: 'файл', select: 'вибір' }[b.type] || b.type;
}

function flushInputs() { if (wheel) wheel.flush(); if (textBuf) textBuf.flush(); }

// Точка події на скриншоті → CSS px viewport (content-box <img>).
function pointFromEvent(e) {
  const img = els.img;
  if (!rs || img.hidden || !img.naturalWidth) return null;
  const r = img.getBoundingClientRect();
  const vp = rs.vp && rs.vp.w ? rs.vp : { w: img.naturalWidth, h: img.naturalHeight };
  return viewToPage(e.clientX, e.clientY, {
    left: r.left, top: r.top, clientLeft: img.clientLeft, clientTop: img.clientTop,
    clientWidth: img.clientWidth, clientHeight: img.clientHeight,
  }, vp);
}
const curVp = () => (rs && rs.vp && rs.vp.w ? rs.vp : { w: els.img.naturalWidth || 1280, h: els.img.naturalHeight || 900, scrollX: 0, scrollY: 0 });

function onFrameClick(e) {
  if (!live()) return;
  if (now() < suppressClickUntil) return;
  if (e.target && e.target.closest && e.target.closest('.live-popover')) return;
  const pt = pointFromEvent(e);
  if (!pt) return;
  closePopover();
  flushInputs();
  ripple(pt);
  hideHover(); inspectSeq++;
  rs.lastClickPt = pt;
  const rec = !rs.paused;
  const body = { type: 'click', vx: pt.x, vy: pt.y, rec };
  if (rs.waitNext) { body.waitResponse = true; rs.waitNext = false; updateToolbar(); publish(); }
  const vp = curVp();
  const pending = rec ? {
    type: 'click', v: 2, x: Math.round(pt.x + (vp.scrollX || 0)), y: Math.round(pt.y + (vp.scrollY || 0)),
    pending: true, status: 'running', target: { desc: '…⏳', locs: [], pick: -1, frame: null },
  } : null;
  if (pending && body.waitResponse) pending.waitResponse = true;
  doAct(body, pending);
  if (!coarse()) { try { els.stage.focus({ preventScroll: true }); } catch (_e) { /* */ } }
}

// Друк: кроки з буфера (text — шаблон; key) → дії.
function emitTyped(steps) {
  if (!live()) return;
  const rec = !rs.paused;
  for (const st of steps) {
    if (st.type === 'text') doAct({ type: 'text', text: st.text, rec }, rec ? { type: 'text', v: 2, text: st.text, pending: true, status: 'running' } : null);
    else if (st.type === 'key') doAct({ type: 'key', key: st.key, rec }, rec ? { type: 'key', v: 2, key: st.key, pending: true, status: 'running' } : null);
  }
}

function sendScroll(a) {
  if (!live()) return;
  const dx = Math.round(a.dx), dy = Math.round(a.dy);
  if (!dx && !dy) return;
  const rec = !rs.paused && rs.recScroll;
  const body = { type: 'scroll', dx, dy, rec };
  if (a.vx != null && a.vy != null) { body.vx = Math.round(a.vx); body.vy = Math.round(a.vy); }
  doAct(body, rec ? { type: 'scroll', v: 2, dx, dy, pending: true, status: 'running' } : null);
}

// Shift+Esc — вийти з живого перегляду клавіатурою (без пастки фокусу) — і з кадру, і з IME.
const isExitKey = (e) => e.key === 'Escape' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
function exitKeyboard(e) {
  e.preventDefault(); e.stopPropagation();
  flushInputs();
  if (document.activeElement === els.ime) els.ime.blur();
  els.done.focus();
}
function onStageKey(e) {
  if (e.target !== els.stage || !live() || e.isComposing) return;
  if (isExitKey(e)) { exitKeyboard(e); return; }
  const st = keyToStep(e);
  if (!st) return;
  if (st.type === 'paste') { pasteFallback(); return; } // подія paste прийде сама (не блокуємо)
  if (st.type === 'key' && /^(?:ControlOrMeta|Control\+Meta)\+/.test(st.key) && !FORWARD_COMBO.test(st.key)) return;
  e.preventDefault();
  wheel.flush();
  textBuf.input(st);
}

function onPaste(e) {
  if (!live()) return;
  const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  e.preventDefault();
  pasteSeen = true;
  if (!text) return;
  wheel.flush();
  textBuf.append(text, { now: true });
}
// Якщо подія paste не прийшла (рідко) — читаємо буфер обміну через Clipboard API.
function pasteFallback() {
  pasteSeen = false;
  setTimeout(() => {
    if (pasteSeen || !live()) return;
    const cb = globalThis.navigator && globalThis.navigator.clipboard;
    if (!cb || typeof cb.readText !== 'function') return;
    cb.readText().then((t) => { if (t && live()) { wheel.flush(); textBuf.append(t, { now: true }); } }, () => {
      logLine('warn', '⚠️ Немає доступу до буфера обміну — встав текст іще раз.');
    });
  }, 120);
}

function onWheel(e) {
  if (!live()) return;
  e.preventDefault();
  const pt = pointFromEvent(e);
  const { dx, dy } = normalizeWheel(e, curVp().h);
  if (!dx && !dy) return;
  textBuf.flush();
  hideHover();
  wheel.add({ dx, dy, vx: pt ? pt.x : undefined, vy: pt ? pt.y : undefined });
}

// Дотик: тап = клік (подія click), два пальці = колесо (вміст іде за пальцями).
const centroid = (tl) => ({ x: (tl[0].clientX + tl[1].clientX) / 2, y: (tl[0].clientY + tl[1].clientY) / 2 });
function onTouchStart(e) {
  if (!live() || e.touches.length !== 2) return;
  e.preventDefault();
  twoFinger = centroid(e.touches);
  suppressClickUntil = now() + 600;
}
function onTouchMove(e) {
  if (!live() || e.touches.length !== 2 || !twoFinger) return;
  e.preventDefault();
  const c = centroid(e.touches);
  const img = els.img;
  const k = viewScale({ clientWidth: img.clientWidth }, curVp());
  const pt = pointFromEvent({ clientX: c.x, clientY: c.y });
  textBuf.flush();
  wheel.add({ dx: -(c.x - twoFinger.x) * k, dy: -(c.y - twoFinger.y) * k, vx: pt ? pt.x : undefined, vy: pt ? pt.y : undefined });
  twoFinger = c;
  suppressClickUntil = now() + 600;
}
function onTouchEnd(e) { if (!e.touches || e.touches.length < 2) twoFinger = null; }

// Прихований input (мобільна клавіатура): текст — через beforeinput, службові клавіші — keydown.
function focusIme(explicit) {
  if (!live()) return;
  els.ime.value = ' ';
  try { els.ime.focus({ preventScroll: true }); } catch (_e) { /* */ }
  if (explicit) logLine('info', '⌨ Друкуй — текст іде у сфокусоване поле сторінки.');
}
function onImeKey(e) {
  if (isExitKey(e)) { exitKeyboard(e); return; }
  if (!live() || e.isComposing) return;
  const st = keyToStep(e);
  if (!st || st.type === 'text' || st.type === 'paste') return; // текст прийде через beforeinput/paste
  if (st.type === 'key' && /^(?:ControlOrMeta|Control\+Meta)\+/.test(st.key) && !FORWARD_COMBO.test(st.key)) return;
  e.preventDefault();
  wheel.flush();
  textBuf.input(st);
}
function onImeBeforeInput(e) {
  if (!live()) return;
  if (e.inputType === 'insertCompositionText') return; // IME — дочекаємось compositionend
  const k = beforeInputToKey(e.inputType, e.data);
  if (!k) return;
  e.preventDefault();
  wheel.flush();
  if (typeof k === 'object') textBuf.append(k.text);
  else textBuf.input(k);
}
function onImeComposition(e) {
  if (!live()) return;
  if (e.data) textBuf.append(e.data);
  els.ime.value = ' ';
}

// ---------- Підсвітка під курсором (/live/:sid/inspect) ----------
function onFrameMove(e) {
  if (!live() || !rs.inspectOn) return;
  hoverPt = pointFromEvent(e);
  if (inspectT) return;
  inspectT = setTimeout(runInspect, INSPECT_MS);
}
async function runInspect() {
  inspectT = null;
  const pt = hoverPt;
  if (!pt || !live() || !rs.inspectOn || client.busy) return;
  const my = ++inspectSeq;
  const r = await client.inspect(pt.x, pt.y);
  if (my !== inspectSeq || !rs || !rs.inspectOn) return;
  if (r && r.box) showHover(r.box, r.desc); else hideHover();
}
function showHover(box, desc) {
  const p = boxPct(box, curVp());
  if (!p) return hideHover();
  Object.assign(els.hover.style, { left: p.left + '%', top: p.top + '%', width: p.width + '%', height: p.height + '%' });
  els.hover.firstChild.textContent = desc || '';
  els.hover.hidden = false;
}
function hideHover() { if (els && els.hover) els.hover.hidden = true; }

// ---------- Оверлей ----------
function ripple(pt) {
  const p = viewPct(pt.x, pt.y, curVp());
  if (!p) return;
  const r = h('span', { class: 'live-ripple', style: { left: p.left + '%', top: p.top + '%' } });
  els.overlay.appendChild(r);
  setTimeout(() => r.remove(), 700);
}

function renderMarkers() {
  if (!els || !rs) return;
  clear(els.marks);
  const vp = rs.vp;
  if (!vp) return;
  const subs = rs.rec.subs;
  const marks = rs.marks
    .map((m) => ({ n: subs.indexOf(m.step) + 1, x: m.step.x, y: m.step.y, url: m.url }))
    .filter((m) => m.n > 0);
  // Кільця з номером збоку (не накривають підпис кнопки); старі — бліді, накладені — прибрано.
  for (const m of pickMarkers(markersInView(marks, vp, rs.url), { recent: MARK_RECENT })) {
    const p = viewPct(m.vx, m.vy, vp);
    els.marks.appendChild(h('span', { class: 'live-mark' + (m.old ? ' old' : ''), dataset: { n: String(m.n) }, style: { left: p.left + '%', top: p.top + '%' } }));
  }
}

// Останні 3 кроки Дії (мобільний LIVE): підпис + «⏳» для ще не підтверджених.
const RECENT_N = 3;
function renderRecent() {
  if (!els || !els.recent) return;
  clear(els.recent);
  if (!rs) return;
  const subs = rs.rec.subs.filter((x) => x && typeof x === 'object');
  const total = subs.filter((x) => !x.pending).length;
  els.recent.appendChild(h('div', { class: 'lr-head' },
    h('span', { text: '«' + rs.rec.name + '»: ' + total + ' ' + pluralUk(total, ['крок', 'кроки', 'кроків']) }),
    h('button', { type: 'button', class: 'linkish', text: '📋 усі', 'aria-label': 'Показати всі кроки (панель «Сценарії»)', on: { click: () => emit('ui:pane', 'scenarios') } })));
  if (!subs.length) { els.recent.appendChild(h('div', { class: 'lr-empty', text: 'Тапни елемент на сторінці — він стане кроком.' })); return; }
  const start = Math.max(0, subs.length - RECENT_N);
  const ol = h('ol', { class: 'lr-list', start: String(start + 1) });
  for (const a of subs.slice(start)) {
    ol.appendChild(h('li', { class: a.pending ? 'pending' : null }, (a.pending ? '⏳ ' : '') + stepLabel(a)));
  }
  els.recent.appendChild(ol);
}

function renderTyping(buf) {
  if (!els || !els.typing) return;
  if (!buf) { els.typing.hidden = true; els.typing.textContent = ''; return; }
  els.typing.textContent = '⌨ «' + buf + '▌»';
  const pt = rs && rs.lastClickPt;
  const p = pt ? viewPct(pt.x, pt.y, curVp()) : null;
  Object.assign(els.typing.style, p ? { left: p.left + '%', top: p.top + '%' } : { left: '8px', top: '' });
  els.typing.classList.toggle('anchored', !!p);
  els.typing.hidden = false;
}

// ---------- <select>: поповер з опціями ----------
let popover = null;
function openSelect(options, clickBody) {
  closePopover();
  if (!live()) return;
  const vp = curVp();
  const p = viewPct(clickBody.vx || 0, clickBody.vy || 0, vp) || { left: 10, top: 10 };
  const list = h('div', { class: 'live-pop-list', role: 'listbox', 'aria-label': 'Значення списку' },
    options.map((o) => h('button', {
      type: 'button', role: 'option', class: 'live-pop-opt' + (o.selected ? ' sel' : ''),
      'aria-selected': o.selected ? 'true' : 'false', text: (o.label || o.value || '—') + (o.selected ? '  ✓' : ''),
      on: { click: (e) => { e.stopPropagation(); chooseOption(o); } },
    })));
  popover = h('div', {
    class: 'live-popover', role: 'dialog', 'aria-label': 'Обери значення списку',
    style: { left: 'min(' + p.left + '%, calc(100% - 260px))', top: 'min(' + p.top + '%, calc(100% - 120px))' },
    on: { keydown: onPopoverKey, click: (e) => e.stopPropagation() },
  },
  h('div', { class: 'live-pop-head' }, h('span', { text: '🔽 Обери значення' }),
    h('button', { type: 'button', class: 'x', 'aria-label': 'Скасувати вибір', text: '✕', on: { click: () => closePopover(true) } })),
  options.length ? list : h('div', { class: 'live-pop-empty', text: 'Список порожній' }));
  els.frame.appendChild(popover);
  const first = popover.querySelector('.live-pop-opt.sel') || popover.querySelector('.live-pop-opt');
  if (first) first.focus();
}
function onPopoverKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const opts = [...popover.querySelectorAll('.live-pop-opt')];
    const i = opts.indexOf(document.activeElement);
    const n = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length];
    if (n) n.focus();
  }
  e.stopPropagation();
}
function chooseOption(o) {
  closePopover(true);
  if (!live()) return;
  const rec = !rs.paused;
  doAct({ type: 'select', value: o.value, rec }, rec ? { type: 'select', v: 2, value: o.value, label: o.label, pending: true, status: 'running' } : null);
}
function closePopover(refocus) {
  if (!popover) return;
  popover.remove();
  popover = null;
  if (refocus && els.stage) { try { els.stage.focus({ preventScroll: true }); } catch (_e) { /* */ } }
}

// ---------- Файл ----------
function askFile(fromPage) {
  if (!live()) return;
  if (fromPage) {
    showBanner('file', '📎 Сторінка відкрила вибір файлу — обери файл.', [{ label: '📎 Обрати файл', fn: () => openPicker(), primary: true }], 'info');
  }
  openPicker();
}
function openPicker() {
  els.fileInput.value = '';
  try { els.fileInput.click(); } catch (_e) { /* без user activation — лишається кнопка в банері */ }
}
async function onFileChosen() {
  const f = els.fileInput.files && els.fileInput.files[0];
  if (!f || !live()) return;
  hideBanner('file');
  setLive('Завантажую файл «' + f.name + '» (' + (f.size / 1048576).toFixed(1) + ' МБ)…', false, true);
  try {
    const d = await api.upload(f);
    if (!d || !d.ok) throw new Error((d && d.error) || 'помилка завантаження');
    if (!live()) return;
    const rec = !rs.paused;
    doAct({ type: 'file', fileId: d.fileId, filename: d.filename, rec },
      rec ? { type: 'file', v: 2, fileId: d.fileId, filename: d.filename, pending: true, status: 'running' } : null);
    setLive('LIVE — файл «' + d.filename + '» підставляю…', true);
  } catch (e) {
    logLine('error', '❌ Файл не завантажено: ' + e.message);
    setLive('❌ Файл не завантажено: ' + e.message, false);
  }
}

// ---------- Тулбар ----------
function doNav(action, url) {
  if (!live()) return;
  flushInputs();
  closePopover();
  rs.lastClickPt = null;
  client.nav(action, url).then((res) => {
    if (res && res.ok === false) logLine('error', '❌ ' + action + ': ' + humanError(res.error));
    if (rs && rs.rec.subs.some((x) => !x.pending)) logLine('info', 'ℹ️ Навігацію (' + action + ') не записано як крок — при відтворенні її не буде.');
  }, (e) => { if (classifyLiveError(e).kind !== 'closed') logLine('error', '❌ ' + action + ': ' + humanError(e)); });
}
function navGoto() {
  const u = els.urlInput.value.trim();
  if (!u) return;
  doNav('goto', u);
  try { els.stage.focus({ preventScroll: true }); } catch (_e) { /* */ }
}
function togglePause() {
  if (!rs) return;
  flushInputs();
  rs.paused = !rs.paused;
  logLine('info', rs.paused ? '⏸ Пауза запису: дії йдуть у сторінку, але не записуються.' : '⏺ Запис продовжено.');
  publish(); updateToolbar();
}
function toggleWait() { if (!rs) return; rs.waitNext = !rs.waitNext; publish(); updateToolbar(); }
function toggleScrollRec() {
  if (!rs) return;
  rs.recScroll = !rs.recScroll;
  storage.set('liveRecScroll', rs.recScroll ? '1' : '0');
  updateToolbar();
}
function toggleZoom() {
  const on = els.stage.classList.toggle('zoom-1');
  storage.set('liveZoom1', on ? '1' : '0');
  if (on) hideBanner('zoom');
  else (globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16)))(maybeHintZoom);
  updateToolbar();
  renderMarkers();
}
function toggleInspect() {
  if (!rs) return;
  rs.inspectOn = !rs.inspectOn;
  if (!rs.inspectOn) { inspectSeq++; hideHover(); }
  updateToolbar();
}

// ↶ Видалити останній записаний крок.
export function undoLast() {
  const s = rs;
  if (!s || (client && client.busy)) return;
  const subs = s.rec.subs;
  const i = undoIndex(subs);
  if (i < 0) return;
  const [removed] = subs.splice(i, 1);
  s.known = confirmedCount(s.rec);
  logLine('info', '↶ Видалено крок: ' + stepLabel(removed));
  showUndoHint();
  emit('page:changed', { page: s.page, pageId: s.page.id, reason: 'undo' });
  emit('pages');
  renderMarkers(); updateToolbar();
}
function showUndoHint() {
  if (!rs || rs.phase !== 'live') return;
  showBanner('undo', 'Крок видалено, але сторінка вже змінилась.', [{ label: '⟲ Відновити стан', fn: resync }], 'info', { autoHideMs: 10000 });
}

// ---------- Повернення після перезавантаження ----------
function tryReattachWhenReady() {
  const saved = readSavedSession();
  if (!saved) return;
  let done = false;
  const off = on('pages', () => {
    if (done || state.db == null) return; // чекаємо завершення loadPages()
    done = true;
    setTimeout(() => { off(); reattach(saved); }, 0);
  });
}

async function reattach(saved) {
  if (rs || state.running || state.recording) return;
  const r = resolveReattach(state.pages, saved, state.recCounter);
  const page = r.page;
  if (!page) {
    const c = createLiveClient({});
    try { await c.attach(saved.sid, saved); } catch (_e) { return; }
    await c.close();
    logLine('warn', '⚠️ Живу сесію ' + saved.sid + ' закрито: її сценарію більше немає.');
    return;
  }
  let rec = r.rec;
  const isNew = r.isNew;
  if (isNew) {
    state.recCounter = r.recCounter;
    rec = { id: r.recId, name: r.name, subs: [], expanded: true };
    page.recs.push(rec);
  }
  rec.isRecording = true; rec.expanded = true; page.expanded = true;
  state.recording = true; state.curPage = page; state.curRec = rec;
  const base = r.baseRecIds;
  rs = {
    page, rec, mode: r.mode, baseRecIds: base, newRecIds: new Set(isNew ? [rec.id] : []),
    phase: 'opening', paused: false, waitNext: false, recScroll: storage.get('liveRecScroll') === '1',
    inspectOn: null, marks: [], engine: saved.engine || null, lastShot: null, lastClickPt: null, known: confirmedCount(rec),
    gen: 0, ac: null, finishing: null, resyncing: false, zoomHintShown: false,
  };
  enterLiveUI();
  setPhase('opening');
  setOpening('Повертаюсь до сесії запису…', '', '');
  emit('busy'); emit('pages');
  const c = createLiveClient({ onEvent: (t, p) => { if (client === c) onClientEvent(t, p); } });
  client = c;
  try {
    await c.attach(saved.sid, { pageId: page.id, recId: rec.id, baseRecIds: base, mode: rs.mode, engine: saved.engine });
    if (client !== c || !rs) return;
    rs.inspectOn = inspectDefault({ engine: rs.engine, finePointer: finePointer() });
    setPhase('live');
    logLine('info', '🔁 Повернувся до живої сесії ' + saved.sid + ' («' + rec.name + '»).');
    setLiveIdle();
  } catch (e) {
    if (client === c) client = null;
    if (!rs) return;
    const k = classifyLiveError(e);
    setPhase('closed');
    const msg = 'Попередню сесію запису закрито' + (k.reason ? ' (' + k.reason + ')' : '') + '. Кроки збережено.';
    logLine('warn', '⚠️ ' + msg);
    showBanner('closed', msg, [{ label: '⟲ Відновити', fn: resync, primary: true }, { label: '⏹ Готово', fn: () => finish() }], 'warn');
  }
}

// ---------- Сумісність і зведене API ----------
// Старий сайдбар: «⏺ Запис нової Дії» / «⏹ Зупинити запис».
export function startRec(page) {
  start({ page, mode: 'append' });
  return !!(rs && rs.page === page);
}
export function stopRec() {
  const page = state.curPage, rec = state.curRec;
  const saved = !!(rec && rec.subs.some((x) => x && !x.pending));
  finish();
  return { page, rec, saved };
}

// Чиста: точка події → пікселі зображення з ОБМЕЖЕННЯМ межами (content-box, без рамки).
// Лишено для сумісності (test/frontend.test.js); живий запис використовує viewToPage (liveModel.js).
export function shotPoint(e, img) {
  const rect = img.getBoundingClientRect();
  const cw = img.clientWidth || rect.width, ch = img.clientHeight || rect.height;
  const sx = img.naturalWidth / cw, sy = img.naturalHeight / ch;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  return {
    x: clamp(Math.round((e.clientX - rect.left - (img.clientLeft || 0)) * sx), img.naturalWidth - 1),
    y: clamp(Math.round((e.clientY - rect.top - (img.clientTop || 0)) * sy), img.naturalHeight - 1),
    sw: img.naturalWidth, sh: img.naturalHeight,
  };
}

export const recorder = { start, finish, newRec, resync, undoLast, isActive };
