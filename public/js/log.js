// log.js — лог-консоль (#console) і рядок статусу (#live).
//   initLog()               — привʼязка до DOM: фільтри-чипи за видом, копіювання, очищення, згортання;
//   logLine(kind, text)     — рядок (kind: info/nav/browser/context/fp/stealth/cookies/shot/warn/error;
//                             'run-sep' = початок нової групи прогону, як logRunSep);
//   logRunSep(label)        — нова згортна група прогону (попередні згортаються);
//   logMany([{kind,text}]);
//   setLive(text, playing, spinning) — статус «що відбувається зараз»;
//   setConsoleCollapsed(bool) → попередній стан — згорнути/розгорнути консоль (LIVE на десктопі).
// Тексти рядків і статусу чистяться від ANSI-кодів / «Call log» Playwright (lib/errText.js).
// Автопрокрутка — лише якщо користувач і так був унизу; інакше зʼявляється «↓ нові рядки».
// Обсяг обмежено (MAX_LINES/MAX_GROUPS) — найстаріші групи видаляються.
// Чисті функції (LOG_GROUPS, kindGroup, groupMeta, formatCopy) — для тестів; DOM під час імпорту не чіпаємо.
import { $, h, clear, copyText } from './dom.js';
import { emit, storage } from './state.js';
import { cleanError } from '../../lib/errText.js';

// Рядок логу: лише якщо є «сміття» Playwright (ANSI / Call log) — інакше як є (багаторядкові ок).
const tidy = (s) => (/\x1b\[|\[\d{1,2}m|Call log:/.test(s) ? cleanError(s, 2000) : s);

// Групи фільтрів (чипи). Колір чипа = колір рядків цього виду — заразом легенда.
export const LOG_GROUPS = [
  { key: 'error', label: 'Помилки', kinds: ['error', 'warn'] },
  { key: 'nav', label: 'Навігація', kinds: ['nav', 'shot'] },
  { key: 'browser', label: 'Браузер', kinds: ['browser', 'context'] },
  { key: 'stealth', label: 'Антидетект', kinds: ['stealth', 'fp', 'cookies'] },
  { key: 'info', label: 'Інфо', kinds: ['info'] },
];
export const MAX_LINES = 4000;
export const MAX_GROUPS = 40;

export function kindGroup(kind) {
  for (const g of LOG_GROUPS) if (g.kinds.includes(kind)) return g.key;
  return 'info';
}

// Підсумок групи прогону: «12:03:44 · 23 рядки · ✗ 2».
export function groupMeta({ time, lines, errors }) {
  const n = lines || 0;
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'рядок' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'рядки' : 'рядків';
  return [time, n + ' ' + word, errors ? '✗ ' + errors : ''].filter(Boolean).join(' · ');
}

// entries: [{type:'group', title} | {type:'line', group, text, time}], hidden: Set груп.
// Повертає текст для буфера (приховані фільтром рядки не копіюються).
export function formatCopy(entries, hidden = new Set()) {
  const out = [];
  for (const e of entries) {
    if (e.type === 'group') out.push('── ' + e.title + ' ──');
    else if (!hidden.has(e.group)) out.push((e.time ? '[' + e.time + '] ' : '') + e.text);
  }
  return out.join('\n');
}

export const timeStr = (d = new Date()) => d.toTimeString().slice(0, 8);

// ---------- DOM ----------
let body = null, liveEl = null, chipsEl = null, jumpBtn = null, copyBtn = null;
let curGroup = null; // {el, linesEl, metaEl, lines, errors, time}
let lineCount = 0;
let hidden = new Set();
const counts = Object.fromEntries(LOG_GROUPS.map((g) => [g.key, 0]));

export function initLog() {
  body = $('consoleBody');
  liveEl = $('live');
  chipsEl = $('consoleFilters');
  jumpBtn = $('consoleJump');
  copyBtn = $('consoleCopy');
  const consoleEl = $('console');
  try { hidden = new Set(JSON.parse(storage.get('logHidden') || '[]')); } catch (_e) { hidden = new Set(); }
  applyHidden();
  renderChips();

  $('consoleClear').addEventListener('click', clearLog);
  if (copyBtn) copyBtn.addEventListener('click', onCopy);
  if (jumpBtn) jumpBtn.addEventListener('click', () => { body.scrollTop = body.scrollHeight; jumpBtn.hidden = true; });
  body.addEventListener('scroll', () => { if (jumpBtn && atBottom()) jumpBtn.hidden = true; }, { passive: true });
  const tog = $('consoleToggle');
  tog.addEventListener('click', () => applyCollapsed(!consoleEl.classList.contains('collapsed')));
}

function applyCollapsed(collapsed) {
  const consoleEl = $('console'), tog = $('consoleToggle');
  if (!consoleEl || !tog) return;
  consoleEl.classList.toggle('collapsed', collapsed);
  tog.textContent = collapsed ? '▸' : '▾';
  tog.setAttribute('aria-expanded', String(!collapsed));
  tog.setAttribute('aria-label', collapsed ? 'Розгорнути логи' : 'Згорнути логи');
}
export function setConsoleCollapsed(collapsed) {
  const consoleEl = $('console');
  if (!consoleEl) return false;
  const prev = consoleEl.classList.contains('collapsed');
  applyCollapsed(!!collapsed);
  return prev;
}

function renderChips() {
  if (!chipsEl) return;
  clear(chipsEl);
  for (const g of LOG_GROUPS) {
    const on = !hidden.has(g.key);
    chipsEl.appendChild(h('button', {
      type: 'button', class: 'lchip g-' + g.key, 'aria-pressed': on ? 'true' : 'false',
      title: (on ? 'Сховати: ' : 'Показати: ') + g.label + ' (' + g.kinds.join(', ') + ')',
      on: { click: () => toggleGroup(g.key) },
    },
    h('span', { class: 'sw', 'aria-hidden': 'true' }),
    g.label,
    counts[g.key] ? h('span', { class: 'n', text: String(counts[g.key]) }) : null));
  }
}

function toggleGroup(key) {
  if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
  storage.set('logHidden', JSON.stringify([...hidden]));
  applyHidden();
  renderChips();
}
function applyHidden() { if (body) body.dataset.hide = [...hidden].join(' '); }

const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 24;

function clearLog() {
  clear(body);
  curGroup = null; lineCount = 0;
  for (const k of Object.keys(counts)) counts[k] = 0;
  if (jumpBtn) jumpBtn.hidden = true;
  renderChips();
}

function startGroup(label) {
  if (!body) { console.log('[log] ── ' + label + ' ──'); return; }
  const stick = atBottom();
  // Попередні групи згортаємо — на виду лише поточний прогін (історія лишається).
  for (const d of body.querySelectorAll(':scope > details.run')) d.open = false;
  const time = timeStr();
  const metaEl = h('span', { class: 'run-meta' });
  const linesEl = h('div', { class: 'run-lines' });
  const el = h('details', { class: 'run', open: true },
    h('summary', { class: 'run-sum' }, h('span', { class: 'run-title', text: label }), metaEl),
    linesEl);
  body.appendChild(el);
  curGroup = { el, linesEl, metaEl, lines: 0, errors: 0, time };
  metaEl.textContent = groupMeta(curGroup);
  trim();
  if (stick) body.scrollTop = body.scrollHeight;
}

// Обмеження обсягу: видаляємо найстаріші групи/рядки.
function trim() {
  let gc = body.querySelectorAll(':scope > details.run').length;
  while (body.firstChild && body.firstChild !== (curGroup && curGroup.el) && (lineCount > MAX_LINES || gc > MAX_GROUPS)) {
    const first = body.firstChild;
    if (first.matches && first.matches('details.run')) { lineCount -= first.querySelectorAll('.ln').length; gc--; }
    else if (first.classList && first.classList.contains('ln')) lineCount--;
    first.remove();
  }
  // Поточна група сама переросла ліміт — ріжемо її найстаріші рядки.
  while (lineCount > MAX_LINES && curGroup && curGroup.linesEl.firstChild) { curGroup.linesEl.firstChild.remove(); lineCount--; }
}

export function logLine(kind, text) {
  kind = kind || 'info';
  const s = tidy(String(text == null ? '' : text));
  if (kind === 'run-sep') { logRunSep(s.replace(/^─+\s*|\s*─+$/g, '')); return; }
  if (!body) { (kind === 'error' ? console.error : console.log)('[log]', s); return; }
  const stick = atBottom();
  const g = kindGroup(kind);
  const time = timeStr();
  const ln = h('div', { class: 'ln ' + kind, dataset: { g, t: time }, text: s });
  (curGroup ? curGroup.linesEl : body).appendChild(ln);
  lineCount++;
  counts[g]++;
  if (curGroup) {
    curGroup.lines++;
    if (kind === 'error') { curGroup.errors++; curGroup.el.classList.add('has-err'); }
    curGroup.metaEl.textContent = groupMeta(curGroup);
  }
  if (lineCount > MAX_LINES) trim();
  if (stick) body.scrollTop = body.scrollHeight;
  else if (jumpBtn) jumpBtn.hidden = false;
  scheduleChips();
  emit('log', { kind });
}

// Лічильники на чипах — не частіше разу на кадр (рядки летять пачками).
let chipsQueued = false;
function scheduleChips() {
  if (chipsQueued) return;
  chipsQueued = true;
  const raf = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 16));
  raf(() => { chipsQueued = false; renderChips(); });
}

export function logRunSep(label) { startGroup(String(label == null ? '' : label)); }
export function logMany(arr) { (arr || []).forEach((l) => logLine(l.kind, l.text)); }

function collectEntries() {
  const out = [];
  for (const el of body.querySelectorAll('.run-title, .ln')) {
    if (el.classList.contains('run-title')) out.push({ type: 'group', title: el.textContent });
    else out.push({ type: 'line', group: el.dataset.g, text: el.textContent, time: el.dataset.t });
  }
  return out;
}

async function onCopy() {
  const ok = await copyText(formatCopy(collectEntries(), hidden));
  if (!copyBtn) return;
  const prev = copyBtn.dataset.label || copyBtn.textContent;
  copyBtn.dataset.label = prev;
  copyBtn.textContent = ok ? '✓ скопійовано' : '✗ не вдалось';
  setTimeout(() => { copyBtn.textContent = copyBtn.dataset.label; }, 1500);
}

export function setLive(text, playing, spinning) {
  if (!liveEl) return;
  liveEl.className = 'live' + (playing ? ' playing' : '') + (spinning && !playing ? ' spinning' : '');
  clear(liveEl);
  if (playing || spinning) liveEl.appendChild(h('span', { class: 'dot', 'aria-hidden': 'true' }));
  liveEl.appendChild(h('span', { class: 'live-text', text: tidy(String(text == null ? '' : text)) }));
}
