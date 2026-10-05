// app.js — точка входу UI (<script type="module" src="/js/app.js">) і оболонка застосунку.
// Порядок: лог → переглядач → рекордер → конфігуратор → сайдбар → оболонка; потім
// fingerprint (лише якщо в профілі його немає) і завантаження сценаріїв.
// Відповідальність модулів:
//   api.js        — HTTP + NDJSON-стрім;          state.js    — сховище стану й шина подій;
//   log.js        — консоль і статус;              viewer.js   — таби скрінів/результат (#viewer);
//   scenarios.js  — сайдбар (keyed-рендер);        stepEditor.js — рядки кроків і вбудований редактор;
//   runner.js     — прогін ▶ (/replay) і підсумок;  persist.js  — збереження (debounce, черга, бейдж);
//   recorder.js   — живий запис (LIVE-панель);     live-client.js / liveModel.js — HTTP і чиста логіка сесії;
//   config.js     — конфігуратор/пресети/чип;      dialogs.js  — <dialog>-діалоги й тости;
//   dom.js        — h()/escape/copyText;           scenarioModel.js — валідація URL, id, модель з /pages.
// Оболонка (тут):
//   • < 900 px — одна панель за раз: «Сценарії» | «Перегляд» | «Логи» (нижня навігація,
//     висота 100dvh, бейджі «новий скрін» / «помилки»); emit('ui:pane', name) перемикає;
//     коли зʼявляється живий перегляд (#liveHost) або починається запис — «Перегляд».
//   • ≥ 900 px — дві панелі; ширину сайдбара можна тягнути (памʼятається).
//   • Health: опитування /health → бейджі в хедері («лише в памʼяті», «● LIVE ×N», сервер недоступний).
// Чисті функції (healthBadges, clampSidebarWidth, PANES) — для тестів; boot() лише в браузері.
import { $, h, clear } from './dom.js';
import { state, on, emit, storage } from './state.js';
import { initLog, logLine } from './log.js';
import { initViewer } from './viewer.js';
import { initRecorder } from './recorder.js';
import { initConfig, syncFingerprint } from './config.js';
import { initScenarios, loadPages } from './scenarios.js';

export const PANES = ['scenarios', 'viewer', 'logs'];
export const HEALTH_MS = 8000;
export const SIDEBAR_MIN = 280;
export const SIDEBAR_MAX = 640;

// Бейджі хедера зі стану /health. h: {ok, db, sessions, poolReady, poolSize, active} | {ok:false} | null.
export function healthBadges(hl) {
  if (!hl) return [];
  if (hl.ok === false) {
    return [{ key: 'down', kind: 'danger', icon: '⚠', label: 'сервер недоступний', title: 'Немає відповіді від сервера' + (hl.error ? ': ' + hl.error : ''), text: '⚠ сервер недоступний' }];
  }
  const out = [];
  if (hl.db === false) {
    out.push({ key: 'db', kind: 'warn', icon: '💾', label: 'лише в памʼяті', title: 'БД недоступна — сценарії не збережуться після перезапуску сервера' });
  }
  if (hl.sessions > 0) {
    out.push({ key: 'live', kind: 'live', icon: '●', label: 'LIVE' + (hl.sessions > 1 ? ' ×' + hl.sessions : ''), title: 'Відкритих живих сесій запису: ' + hl.sessions });
  }
  if (hl.poolSize > 0 && !hl.poolReady && !hl.active) {
    out.push({ key: 'pool', kind: 'info', icon: '⏳', label: 'браузер готується', title: 'Пул контекстів ще наповнюється (перший запуск/перезапуск браузера)' });
  }
  return out.map((b) => ({ ...b, text: b.icon + ' ' + b.label }));
}

// Ширина сайдбара: [SIDEBAR_MIN, min(SIDEBAR_MAX, 60% вікна)]; NaN → null (дефолт із CSS).
export function clampSidebarWidth(w, viewportW) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return null;
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor((viewportW || 1440) * 0.6)));
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(max, n)));
}

// ---------- Оболонка (DOM) ----------
let mqNarrow = null;
const isNarrow = () => !!(mqNarrow && mqNarrow.matches);

function initShell() {
  mqNarrow = globalThis.matchMedia ? matchMedia('(max-width: 899.98px)') : null;
  const saved = storage.get('pane');
  setPane(PANES.includes(saved) ? saved : 'scenarios', { remember: false });
  for (const b of document.querySelectorAll('#paneNav [data-pane]')) {
    b.addEventListener('click', () => setPane(b.dataset.pane, { focus: false }));
  }
  $('paneNav').addEventListener('keydown', onPaneNavKey);
  on('ui:pane', (name) => { if (PANES.includes(name)) setPane(name); });

  // Бейджі нижньої навігації: новий скрін / помилки в лозі, поки панель не на виду.
  on('screens:added', (ev) => { if (isNarrow() && currentPane() !== 'viewer') setNavBadge('viewer', ev && ev.status === 'failed' ? 'err' : 'dot'); });
  on('log', (ev) => { if (ev && ev.kind === 'error' && isNarrow() && currentPane() !== 'logs') bumpLogBadge(); });

  // Живий перегляд або запис — одразу «Перегляд» (там відбувається дія).
  const liveHost = $('liveHost');
  if (liveHost && globalThis.MutationObserver) {
    new MutationObserver(() => { if (!liveHost.hidden && isNarrow()) setPane('viewer'); })
      .observe(liveHost, { attributes: true, attributeFilter: ['hidden'] });
  }
  let wasRecording = false;
  on('busy', () => {
    if (state.recording && !wasRecording && isNarrow()) setPane('viewer');
    wasRecording = state.recording;
  });

  initResizer();
  initHealth();
}

const currentPane = () => document.body.dataset.pane || 'scenarios';

function setPane(name, { remember = true, focus = false } = {}) {
  document.body.dataset.pane = name;
  for (const b of document.querySelectorAll('#paneNav [data-pane]')) {
    const sel = b.dataset.pane === name;
    b.setAttribute('aria-selected', sel ? 'true' : 'false');
    b.tabIndex = sel ? 0 : -1;
    if (sel) { clearNavBadge(name); if (focus) b.focus(); }
  }
  if (remember) storage.set('pane', name);
}

function onPaneNavKey(e) {
  let i = PANES.indexOf(currentPane());
  if (e.key === 'ArrowRight') i = (i + 1) % PANES.length;
  else if (e.key === 'ArrowLeft') i = (i - 1 + PANES.length) % PANES.length;
  else if (e.key === 'Home') i = 0;
  else if (e.key === 'End') i = PANES.length - 1;
  else return;
  e.preventDefault();
  setPane(PANES[i], { focus: true });
}

let logErrs = 0;
function setNavBadge(pane, kind, text) {
  const b = document.querySelector('#paneNav [data-pane="' + pane + '"] .nav-badge');
  if (!b) return;
  b.hidden = false;
  b.className = 'nav-badge ' + kind;
  b.textContent = text || '';
  b.setAttribute('aria-label', kind === 'err' ? 'є помилки' : 'нове');
}
function clearNavBadge(pane) {
  const b = document.querySelector('#paneNav [data-pane="' + pane + '"] .nav-badge');
  if (b) { b.hidden = true; b.textContent = ''; }
  if (pane === 'logs') logErrs = 0;
}
function bumpLogBadge() { logErrs++; setNavBadge('logs', 'err', logErrs > 99 ? '99+' : String(logErrs)); }

// ---------- Ширина сайдбара (≥ 900 px) ----------
function initResizer() {
  const handle = $('sbResizer');
  if (!handle) return;
  const apply = (w) => {
    const v = clampSidebarWidth(w, innerWidth);
    if (v == null) document.documentElement.style.removeProperty('--sidebar-w');
    else document.documentElement.style.setProperty('--sidebar-w', v + 'px');
    handle.setAttribute('aria-valuenow', String(v || currentWidth()));
    return v;
  };
  const currentWidth = () => { const sb = $('paneScenarios'); return sb ? Math.round(sb.getBoundingClientRect().width) : 340; };
  apply(storage.get('sidebarW'));
  handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
  handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));
  let startX = 0, startW = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true; startX = e.clientX; startW = currentWidth();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => { if (dragging) apply(startW + (startX - e.clientX)); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    storage.set('sidebarW', String(currentWidth()));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { storage.remove('sidebarW'); apply(null); });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 60 : 20;
    let w = currentWidth();
    if (e.key === 'ArrowLeft') w += step; else if (e.key === 'ArrowRight') w -= step; else return;
    e.preventDefault();
    const v = apply(w);
    if (v) storage.set('sidebarW', String(v));
  });
  addEventListener('resize', () => { const s = storage.get('sidebarW'); if (s) apply(s); });
}

// ---------- Health ----------
let healthTimer = null;
async function pollHealth() {
  let hl;
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    hl = r.ok ? await r.json() : { ok: false, error: 'HTTP ' + r.status };
  } catch (e) { hl = { ok: false, error: e.message }; }
  const prev = state.health;
  state.health = hl;
  renderHealth(hl);
  if (prev && prev.ok !== false && hl.ok === false) logLine('error', '❌ Сервер недоступний: ' + (hl.error || ''));
  if (prev && prev.ok === false && hl.ok !== false) logLine('info', '✓ Звʼязок із сервером відновлено.');
  emit('health', hl);
}

function renderHealth(hl) {
  const el = $('hdrHealth');
  if (!el) return;
  clear(el);
  for (const b of healthBadges(hl)) {
    el.appendChild(h('span', { class: 'hbadge ' + b.kind, title: b.title, 'aria-label': b.title, dataset: { key: b.key } },
      h('span', { class: 'hb-ico', 'aria-hidden': 'true', text: b.icon }),
      h('span', { class: 'hb-label', text: b.label })));
  }
}

function initHealth() {
  const tick = () => { if (!document.hidden) pollHealth(); };
  pollHealth();
  healthTimer = setInterval(tick, HEALTH_MS);
  document.addEventListener('visibilitychange', tick);
  // Початок/кінець прогону чи запису — оновити одразу (живі сесії, БД).
  on('busy', () => setTimeout(tick, 300));
}

function boot() {
  initLog();
  initViewer();
  initRecorder();
  initConfig();
  initScenarios();
  initShell();
  window.addEventListener('unhandledrejection', (e) => {
    logLine('error', '❌ ' + ((e.reason && e.reason.message) || e.reason));
  });
  syncFingerprint();
  loadPages();
}

// Лише в браузері: модуль можна імпортувати в node:test заради чистих функцій.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
