// scenarios.js — сайдбар «Сценарій → Дія → крок» (#pagesEl) і дії над ними.
//   Картка сценарію: назва/URL, ▶ Старт / ⏹ Стоп, ⏺ Записати (▾ «з початку»), ⋯ меню
//     (перейменувати, змінити URL, дублювати, видалити — з підтвердженням і «Скасувати»).
//   Дія: згортання, ▶ до цієї Дії, ⏺ Дописати, ⋯ (перейменувати inline, 📎 файл,
//     ⚡ Оптимізувати, показати рухи, видалити з «Скасувати»).
//   Крок: іконка + stepLabel + чип здоровʼя (🎯/⚠/📍) + після прогону бейдж стратегії
//     з мс; ✎ вбудований редактор (stepEditor.js), ⏸ вимкнути, ↑↓, ✕ (з «Скасувати»).
//     Збій: текст помилки, мініатюра failShot (клік — збільшити), швидкі виправлення
//     «📍 лише координати» (target.pick = -1) і «необовʼязковий».
//   Legacy-рухи згорнуті в рядок «+N рухів».
// Рендер — keyed: кожна картка/Дія/рядок має свій вузол і «підпис» стану; перебудовується
// лише вузол, чий підпис змінився (без innerHTML усього сайдбару на кожну подію), фокус
// зберігається (data-fk). Не частіше за кадр.
// Прогін — runner.js; збереження — persist.js (debounce + черга + бейдж «Не збережено»);
// запис — recorder.js (recorder.start({page, mode, recId}) / recorder.finish()).
//   initScenarios(), loadPages(), renderPages(), runPage(pageId, uptoRecId), persistPage(page).
import { $, h, clear } from './dom.js';
import { state, on, emit, isBusy, createExpandStore } from './state.js';
import { api } from './api.js';
import { logLine, setLive } from './log.js';
import { formDialog, confirmDialog, toast } from './dialogs.js';
import { activeScreen } from './viewer.js';
import * as recorder from './recorder.js';
import { validateUrl, pagesFromApi, maxId, nextPageId, guardUndo, subsStamp, subsUnchanged } from './scenarioModel.js';
import { stepLabel, stepIcon, compactMoves, newStepId, pagePayload, formatDelay, mergeTextSteps, nextVisibleIndex } from '../../lib/steps.js';
import { runScenario, stopRun, strategyBadge } from './runner.js';
import { initPersist, persistPage, deletePageRemote, markNoDb } from './persist.js';
import { openStepEditor, healthChip, groupRows, moveStep, pluralUk } from './stepEditor.js';

export { persistPage };

let pagesEl, newPageBtn, fileInput;
let expand = null;
let fileTarget = null; // {page, rec}
let renderQueued = false;

// UI-стан сайдбару (не зберігається в БД).
const ui = {
  renaming: null,          // {kind: 'p'|'r', id}
  editing: null,           // обʼєкт кроку з відкритим редактором
  showMoves: new Set(),    // id Дій, де рухи показано поштучно
};

// Стабільні ключі для обʼєктів кроків (у legacy немає id).
const keys = new WeakMap();
let keySeq = 0;
function keyOf(o) {
  let k = keys.get(o);
  if (!k) { k = 'k' + (++keySeq); keys.set(o, k); }
  return k;
}

const recCount = (n) => n + ' ' + pluralUk(n, ['крок', 'кроки', 'кроків']);

export function initScenarios() {
  pagesEl = $('pagesEl');
  newPageBtn = $('newPageBtn');
  fileInput = $('fileInput');
  expand = createExpandStore();
  ensureStylesheet();
  initPersist();

  if (newPageBtn) newPageBtn.addEventListener('click', newPage);
  if (fileInput) fileInput.addEventListener('change', onFileChosen);
  on('pages', scheduleRender);
  on('busy', scheduleRender);
  // Рекордер повідомляє про зміни сценарію (кожен підтверджений крок, нова Дія, ⏹ Готово) —
  // дебаунс-збереження робить persist.js.
  on('page:changed', (ev) => {
    const page = (ev && ev.page) || state.pages.find((p) => ev && String(p.id) === String(ev.pageId));
    if (page) persistPage(page);
  });
  // Після прогону: Дії зі збоями / запасним шляхом — розгорнути, перший такий рядок — у поле зору.
  on('run:finished', onRunFinished);
  // «⟲ Повторити» з картки помилки у переглядачі.
  on('ui:run', (ev) => { if (ev && ev.pageId != null) runPage(ev.pageId); });
  // Старт прогону/запису закриває відкриті «Скасувати»-тости (індекси кроків уже в роботі).
  on('busy', () => { if (isBusy()) closeUndoToasts(); });
  initFollowRecording();
  renderPages();
}

// scenarios.css підключаємо тут (index.html — спільна розмітка; див. knownGaps).
function ensureStylesheet() {
  if (document.querySelector('link[data-css="scenarios"]') || document.querySelector('link[href$="/css/scenarios.css"]')) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href: '/css/scenarios.css', 'data-css': 'scenarios' }));
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  raf(() => { renderQueued = false; renderPages(); });
}

function changed(page) {
  emit('pages');
  if (page) persistPage(page);
}

// ---------- Завантаження ----------
export async function loadPages() {
  try {
    const d = await api.getPages();
    state.pages = pagesFromApi(d.pages, expand);
    state.pageCounter = maxId(state.pages);
    state.recCounter = maxId(state.pages.flatMap((p) => p.recs));
    state.db = !!d.db;
    if (!d.db) markNoDb();
    setLive(d.db ? 'Сценарії завантажено з БД.' : d.memory ? 'БД не підключена — сценарії в памʼяті сервера (зникнуть після його перезапуску).' : 'БД не підключена — зміни лише в памʼяті цієї вкладки.', false);
  } catch (e) {
    setLive('Не вдалося завантажити сценарії: ' + e.message, false);
    logLine('error', '❌ GET /pages: ' + e.message);
  }
  emit('pages');
  emit('screens'); // порожній стан переглядача залежить від наявності сценаріїв
}

// ---------- Keyed-рендер ----------
// Замінює вузол, зберігаючи фокус (за data-fk).
function replaceNode(oldEl, newEl) {
  const ae = document.activeElement;
  const fk = ae && oldEl.contains(ae) && ae.dataset ? ae.dataset.fk : null;
  oldEl.replaceWith(newEl);
  if (fk) { const t = newEl.querySelector('[data-fk="' + CSS.escape(fk) + '"]'); if (t) t.focus({ preventScroll: true }); }
}

// Слот: вузол, який перебудовується лише при зміні підпису.
function makeSlot(parent) {
  const ph = document.createComment('slot');
  parent.appendChild(ph);
  return {
    el: ph, sig: undefined,
    set(sig, build) {
      if (sig === this.sig) return;
      const el = build() || document.createComment('slot');
      if (this.el.nodeType === 8) this.el.replaceWith(el); else replaceNode(this.el, el);
      this.el = el; this.sig = sig;
    },
  };
}

// Синхронізує дітей container зі списком items (порядок, додавання, видалення).
function syncList(container, cache, items, keyFn, makeView) {
  const seen = new Set();
  let i = 0;
  for (const item of items) {
    const k = keyFn(item);
    seen.add(k);
    let v = cache.get(k);
    if (!v) { v = makeView(item); cache.set(k, v); }
    v.update(item);
    const at = container.children[i];
    if (at !== v.el) container.insertBefore(v.el, at || null);
    i++;
  }
  for (const [k, v] of cache) if (!seen.has(k)) { v.el.remove(); cache.delete(k); }
  while (container.children.length > i) container.lastElementChild.remove();
}

const pageViews = new Map();

export function renderPages() {
  if (!pagesEl) return;
  if (newPageBtn) newPageBtn.disabled = isBusy();
  if (!state.pages.length) {
    pageViews.clear();
    if (!pagesEl.querySelector('.sc-empty')) { clear(pagesEl); pagesEl.appendChild(emptyState()); }
    return;
  }
  // Ключ — обʼєкт (не id): після перезавантаження списку замикання карток не застарівають.
  syncList(pagesEl, pageViews, state.pages, keyOf, makePageView);
  followRunningRow();
  followRecordingRow();
}

function emptyState() {
  return h('div', { class: 'sc-empty none' },
    h('p', { class: 'sc-empty-title', text: 'Немає сценаріїв.' }),
    h('ol', { class: 'sc-steps-howto' },
      h('li', null, h('b', { text: 'Створи сценарій' }), ' — стартовий URL сторінки, яку перевіряєш.'),
      h('li', null, h('b', { text: '⏺ Записуй' }), ' — клікай і друкуй у живому браузері; кожна дія стає кроком.'),
      h('li', null, h('b', { text: '▶ Відтвори' }), ' — сценарій пройде з поточним конфігом, побачиш фінальний скрін і лог.')),
    h('button', { type: 'button', class: 'btn btn-primary', text: '➕ Створити перший сценарій', on: { click: newPage } }));
}

// Під час прогону на десктопі тримаємо поточний крок у полі зору сайдбару.
function followRunningRow() {
  if (!state.running || !globalThis.matchMedia || !globalThis.matchMedia('(min-width: 900px)').matches) return;
  const li = pagesEl.querySelector('.subs li.running');
  if (li && li !== followRunningRow.last) { followRunningRow.last = li; li.scrollIntoView({ block: 'nearest' }); }
}

// Під час ЗАПИСУ на десктопі: при старті — Дія, що пишеться, у поле зору; далі новий
// (pending або щойно підтверджений) рядок тримаємо видимим — поки користувач сам не гортає
// сайдбар (тоді чекаємо, доки він повернеться до низу Дії).
export const followRec = { rec: null, n: -1, manual: false, prog: false };
// root — контейнер сайдбару (#pagesEl); параметр — для тестів із фейковим DOM.
export function followRecordingRow(root = pagesEl) {
  const desk = globalThis.matchMedia && globalThis.matchMedia('(min-width: 900px)').matches;
  if (!root || !state.recording || !state.curRec || !desk) { followRec.rec = null; return; }
  const recEl = root.querySelector('.rec.rec-on');
  if (!recEl) return;
  const n = (state.curRec.subs || []).length;
  const last = () => recEl.querySelector('.subs li:last-child');
  const scrollTo = (el) => {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    followRec.prog = true;
    el.scrollIntoView({ block: 'nearest' });
    const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    raf(() => { followRec.prog = false; });
  };
  if (followRec.rec !== state.curRec) { // запис щойно почався / ＋ Нова Дія / повернення після reload
    followRec.rec = state.curRec; followRec.n = n; followRec.manual = false;
    scrollTo(last() || recEl);
    return;
  }
  if (n !== followRec.n || recEl.querySelector('.subs li.pending')) {
    followRec.n = n;
    if (!followRec.manual) scrollTo(last());
  }
}
function initFollowRecording() {
  const scroller = pagesEl;
  if (!scroller || !scroller.addEventListener) return;
  const manual = () => { if (state.recording) followRec.manual = true; };
  scroller.addEventListener('wheel', manual, { passive: true });
  scroller.addEventListener('touchstart', manual, { passive: true });
  scroller.addEventListener('keydown', (e) => { if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) manual(); });
  scroller.addEventListener('scroll', () => {
    if (followRec.prog || !followRec.manual || !state.recording) return;
    const recEl = pagesEl.querySelector('.rec.rec-on');
    const li = recEl && recEl.querySelector('.subs li:last-child');
    if (!li) return;
    const r = li.getBoundingClientRect(), c = scroller.getBoundingClientRect();
    if (r.bottom <= c.bottom + 2 && r.top >= c.top - 2) followRec.manual = false; // повернувся до низу Дії
  }, { passive: true });
}

// ---------- Кнопки ----------
function op(txt, label, { cls = '', fk = null, disabled = false, onClick, extra = {} } = {}) {
  return h('button', {
    type: 'button', class: 'op' + (cls ? ' ' + cls : ''), 'aria-label': label, title: label,
    disabled: !!disabled, text: txt, 'data-fk': fk, on: disabled || !onClick ? null : { click: onClick }, ...extra,
  });
}
function menuBtn(label, fk, items, disabled) {
  const b = op('⋯', label, { cls: 'more', fk, disabled, extra: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
  if (!disabled) b.addEventListener('click', () => openMenu(b, items()));
  return b;
}

// ---------- Сценарій ----------
function makePageView(page) {
  const el = h('article', { class: 'page sc-card', 'aria-label': 'Сценарій' });
  const head = makeSlot(el);
  const info = makeSlot(el);
  const actions = makeSlot(el);
  const body = h('div', { class: 'page-recs' });
  el.appendChild(body);
  const recViews = new Map();
  return {
    el,
    update(p) {
      const busy = isBusy();
      const running = !!(state.running && state.run && state.run.pageId === p.id);
      const stopping = running && !!state.run.stopping;
      const recHere = state.recording && state.curPage === p;
      const renaming = ui.renaming && ui.renaming.kind === 'p' && ui.renaming.id === p.id;
      el.className = 'page sc-card' + (p.running ? ' page-run' : '') + (recHere ? ' page-rec' : '');
      el.setAttribute('aria-label', 'Сценарій «' + p.name + '»');
      head.set(JSON.stringify([p.name, p.expanded, p.recs.length, busy, renaming]), () => pageHead(p, busy, renaming));
      info.set(JSON.stringify([p.url, p.lastRun ? [p.lastRun.text, p.lastRun.status, p.lastRun.ms] : null]), () => pageInfo(p));
      actions.set(JSON.stringify([busy, running, stopping, recHere, !!(state.run && state.run.runId), state.recording]), () => pageActions(p, { busy, running, stopping, recHere }));
      body.hidden = !p.expanded;
      if (p.expanded) {
        if (!p.recs.length) {
          recViews.clear();
          if (!body.querySelector('.sc-norecs')) { clear(body); body.appendChild(h('div', { class: 'sc-norecs', text: 'Ще немає Дій. Натисни «⏺ Записати», щоб записати першу.' })); }
        } else syncList(body, recViews, p.recs, keyOf, (r) => makeRecView(p, r));
      }
    },
  };
}

function pageHead(p, busy, renaming) {
  return h('div', { class: 'page-head' },
    h('button', {
      type: 'button', class: 'tg', 'aria-expanded': p.expanded ? 'true' : 'false', 'data-fk': 'p' + p.id + '-tg',
      'aria-label': (p.expanded ? 'Згорнути' : 'Розгорнути') + ' сценарій «' + p.name + '»',
      text: p.expanded ? '▾' : '▸', on: { click: () => toggleExpand('p', p) },
    }),
    renaming
      ? renameInput(p.name, 'Назва сценарію', (v) => { p.name = v; changed(p); })
      : h('button', { type: 'button', class: 'pname', text: p.name, title: 'Згорнути/розгорнути (подвійний клік — перейменувати)', 'data-fk': 'p' + p.id + '-name',
        on: { click: () => toggleExpand('p', p), dblclick: (e) => { e.preventDefault(); if (!isBusy()) startRename('p', p.id); } } }),
    h('span', { class: 'pcount', text: p.recs.length + ' ' + pluralUk(p.recs.length, ['Дія', 'Дії', 'Дій']) }),
    menuBtn('Меню сценарію «' + p.name + '»', 'p' + p.id + '-menu', () => [
      { label: '✎ Перейменувати', onClick: () => startRename('p', p.id) },
      { label: '🔗 Змінити URL', onClick: () => editUrl(p) },
      { label: '⧉ Дублювати', onClick: () => duplicatePage(p) },
      { label: '✕ Видалити сценарій', danger: true, onClick: () => deletePage(p) },
    ], busy));
}

const LASTRUN_ICON = { ok: '✓ ', degraded: '⚠ ', stopped: '⏹ ', failed: '✗ ', error: '✗ ' };
function pageInfo(p) {
  const lr = p.lastRun;
  return h('div', { class: 'page-info' },
    h('div', { class: 'page-url', title: p.url }, h('span', { 'aria-hidden': 'true', text: '🔗 ' }), p.url),
    lr ? h('div', { class: 'sc-lastrun ' + lr.status, role: 'note' },
      h('span', { 'aria-hidden': 'true', text: LASTRUN_ICON[lr.status] || '✗ ' }),
      'Останній прогін: ' + lr.text + (lr.ms ? ' · ' + (lr.ms / 1000).toFixed(1) + ' с' : '')) : null);
}

function pageActions(p, { busy, running, stopping, recHere }) {
  const fk = 'p' + p.id;
  const runBtn = running
    ? h('button', { type: 'button', class: 'btn btn-small sc-stop', 'data-fk': fk + '-run', disabled: stopping,
      'aria-label': 'Зупинити прогін (фінальний скрін усе одно буде)', title: 'Зупинити прогін (фінальний скрін усе одно буде)',
      text: stopping ? '⏹ Зупиняю…' : '⏹ Стоп', on: { click: () => stopRun() } })
    : h('button', { type: 'button', class: 'btn btn-small sc-run', 'data-fk': fk + '-run', disabled: busy,
      'aria-label': 'Запустити послідовність: відкрити URL і відтворити всі Дії', title: 'Відкрити стартовий URL і відтворити всі Дії',
      text: '▶ Старт', on: { click: () => runPage(p.id) } });
  let recBtns;
  if (recHere) {
    recBtns = [h('button', { type: 'button', class: 'btn btn-small sc-recstop', 'data-fk': fk + '-rec', text: '⏹ Зупинити запис',
      'aria-label': 'Зупинити запис', on: { click: stopRecording } })];
  } else {
    const dis = state.running || state.recording;
    const more = h('button', { type: 'button', class: 'btn btn-small sc-rec sc-rec-more', 'data-fk': fk + '-recmore', disabled: dis,
      'aria-label': 'Інші варіанти запису', title: 'Інші варіанти запису', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: '▾' });
    if (!dis) more.addEventListener('click', () => openMenu(more, [
      { label: '⏺ Продовжити з кінця (нова Дія)', onClick: () => startRecording(p, 'append') },
      { label: '⏮ З початку (лише URL, нова Дія)', onClick: () => startRecording(p, 'fromStart') },
    ]));
    recBtns = [h('span', { class: 'sc-split' },
      h('button', { type: 'button', class: 'btn btn-small sc-rec', 'data-fk': fk + '-rec', disabled: dis,
        'aria-label': 'Запис нової Дії (продовжити з кінця сценарію)', title: 'Записати нову Дію в живому браузері (спершу відтвориться весь сценарій)',
        text: '⏺ Записати', on: { click: () => startRecording(p, 'append') } }),
      more)];
  }
  return h('div', { class: 'page-actions' }, runBtn, recBtns);
}

// ---------- Дія ----------
function makeRecView(page, rec) {
  const el = h('section', { class: 'rec' });
  const head = makeSlot(el);
  const ul = h('ul', { class: 'subs', 'aria-label': 'Кроки' });
  el.appendChild(ul);
  const rows = new Map();
  return {
    el,
    update(r) {
      const busy = isBusy();
      const renaming = ui.renaming && ui.renaming.kind === 'r' && ui.renaming.id === r.id;
      const recHere = !!(r.isRecording || (state.recording && state.curRec === r));
      el.className = 'rec' + (recHere ? ' rec-on' : '') + (r.running ? ' rec-run' : '');
      el.setAttribute('aria-label', 'Дія «' + r.name + '»');
      const failed = r.subs.filter((a) => a && a.status === 'failed').length;
      const fallback = r.subs.filter((a) => a && a.fallback && a.status === 'done').length;
      head.set(JSON.stringify([r.name, r.expanded, r.subs.length, busy, renaming, recHere, !!r.running, r.runCur, r.runTotal, failed, fallback, state.running, state.recording]),
        () => recHead(page, r, { busy, renaming, failed, fallback }));
      ul.hidden = !r.expanded;
      if (!r.expanded) return;
      const showMoves = ui.showMoves.has(r.id);
      const rowsModel = groupRows(r.subs, showMoves);
      const moveCount = showMoves ? r.subs.filter((a) => a && a.type === 'move').length : 0;
      const items = [];
      if (!r.subs.length) items.push({ kind: 'empty' });
      if (showMoves && moveCount) items.push({ kind: 'hidemoves', count: moveCount });
      items.push(...rowsModel);
      const rowKey = (it) => (it.kind === 'step' ? keyOf(r.subs[it.si]) : it.kind === 'moves' ? 'm' + keyOf(r.subs[it.sis[0]]) : it.kind);
      syncList(ul, rows, items, rowKey, (it) => makeRowView(page, r, it));
    },
  };
}

function recHead(page, r, { busy, renaming, failed, fallback = 0 }) {
  const fk = 'r' + r.id;
  const meta = r.running
    ? (r.runCur || 0) + '/' + (r.runTotal != null ? r.runTotal : r.subs.length)
    : recCount(r.subs.length) + (failed ? ' · ✗' + failed : '') + (fallback ? ' · ⚠' + fallback : '');
  const canAppend = !state.running && !state.recording;
  return h('div', { class: 'rec-head' },
    h('button', {
      type: 'button', class: 'tg', 'aria-expanded': r.expanded ? 'true' : 'false', 'data-fk': fk + '-tg',
      'aria-label': (r.expanded ? 'Згорнути' : 'Розгорнути') + ' Дію «' + r.name + '»',
      text: r.expanded ? '▾' : '▸', on: { click: () => toggleExpand('r', r) },
    }),
    renaming
      ? renameInput(r.name, 'Назва Дії', (v) => { r.name = v; changed(page); })
      : h('button', { type: 'button', class: 'name', text: r.name, title: 'Згорнути/розгорнути (подвійний клік — перейменувати)', 'data-fk': fk + '-name',
        on: { click: () => toggleExpand('r', r), dblclick: (e) => { e.preventDefault(); if (!isBusy()) startRename('r', r.id); } } }),
    h('span', { class: 'meta' + (failed && !r.running ? ' has-fail' : !failed && fallback && !r.running ? ' has-warn' : ''), text: meta,
      title: fallback && !r.running ? fallback + ' ' + pluralUk(fallback, ['крок', 'кроки', 'кроків']) + ' пройшли запасним шляхом (📍 координати / 🧲 snap) — локатор не спрацював' : null }),
    op('▶', 'Виконати до цієї Дії включно', { cls: 'run', fk: fk + '-run', disabled: busy, onClick: () => runPage(page.id, r.id) }),
    op('⏺', 'Дописати кроки в цю Дію (спершу відтвориться сценарій до неї)', { cls: 'rec-more', fk: fk + '-append', disabled: !canAppend, onClick: () => startRecording(page, 'appendTo', r.id) }),
    menuBtn('Меню Дії «' + r.name + '»', fk + '-menu', () => {
      const opt = compactMoves(r.subs);
      const saved = r.subs.length - opt.subs.length;
      const moves = r.subs.filter((a) => a && a.type === 'move').length;
      return [
        { label: '✎ Перейменувати', onClick: () => startRename('r', r.id) },
        { label: '📎 Додати файл для завантаження', onClick: () => addFileToRec(page, r) },
        { label: '⚡ Оптимізувати' + (saved ? ' (−' + saved + ')' : ' — нічого прибирати'), disabled: !saved, onClick: () => optimizeRec(page, r) },
        moves ? { label: ui.showMoves.has(r.id) ? '🖱️ Сховати рухи' : '🖱️ Показати рухи (' + moves + ')', onClick: () => toggleMoves(r) } : null,
        { label: '✕ Видалити Дію', danger: true, onClick: () => deleteRec(page, r) },
      ];
    }, busy));
}

// ---------- Рядки кроків ----------
function makeRowView(page, rec, item) {
  let el = null, sig;
  const view = {
    get el() { return el; },
    update(it) {
      const busy = isBusy();
      let s;
      if (it.kind === 'step') {
        const a = rec.subs[it.si];
        s = 'S' + JSON.stringify([it.si, busy, ui.editing === a, stepSig(a), rec.subs.length, neighborSig(rec, it.si, a)]);
      } else if (it.kind === 'moves') {
        s = 'M' + JSON.stringify([it.sis[0], it.count, busy, it.sis.map((si) => (rec.subs[si] || {}).status || '').join(',')]);
      } else s = it.kind + JSON.stringify([it.count, busy]);
      if (s === sig && el) return;
      sig = s;
      const n = it.kind === 'step' ? stepRow(page, rec, it.si, busy)
        : it.kind === 'moves' ? movesRow(page, rec, it, busy)
          : it.kind === 'hidemoves' ? h('li', { class: 'sc-moves-toggle' }, h('button', { type: 'button', class: 'linkish', 'data-fk': 'hm' + rec.id, text: '🖱️ Сховати ' + it.count + ' ' + pluralUk(it.count, ['рух', 'рухи', 'рухів']), on: { click: () => toggleMoves(rec) } }))
            : h('li', { class: 'empty', text: rec.isRecording ? 'Запис… кроки зʼявлятимуться тут' : 'порожньо' });
      if (el) replaceNode(el, n);
      el = n;
    },
  };
  return view;
}

// Від сусіда залежить кнопка ⤵ (обʼєднати текст): її стан мусить оновлюватись, коли
// наступний видимий крок змінюється / зникає / показуються рухи.
function neighborSig(rec, si, a) {
  if (!a || a.type !== 'text') return '';
  const j = nextVisibleIndex(rec.subs, si, { hideMoves: !ui.showMoves.has(rec.id) });
  const b = j >= 0 ? rec.subs[j] : null;
  return b && b.type === 'text' ? stepSig(b) : '-';
}

function stepSig(a) {
  if (!a || typeof a !== 'object') return String(a);
  const { failShot, ...rest } = a;
  return JSON.stringify(rest) + (failShot ? '#' + failShot.length : '');
}

const STATUS_BADGE = { running: '▶', done: '✓', failed: '✗', skipped: '⏭', pending: '⏳' };
const STATUS_TEXT = { running: 'виконується', done: 'успішно', failed: 'помилка', skipped: 'пропущено', pending: 'очікує' };
const FALLBACK_TEXT = 'успішно (запасний шлях)';

function stepRow(page, rec, si, busy) {
  const a = rec.subs[si];
  if (!a || typeof a !== 'object') return h('li', { class: 'invalid', text: '⚠ некоректний крок #' + (si + 1) });
  const k = keyOf(a);
  const status = a.pending ? 'pending' : a.status;
  const fb = status === 'done' && a.fallback;
  const cls = [status, fb ? 'fallback' : '', a.disabled ? 'disabled' : '', ui.editing === a ? 'editing' : ''].filter(Boolean).join(' ');
  const hc = healthChip(a);
  const sb = (a.status === 'done' || a.status === 'failed') ? strategyBadge(a.strategy, a.ms) : null;
  const label = stepLabel(a);
  const icon = stepIcon(a);
  // Legacy-підписи вже починаються з емодзі («👆 клік …») — без дубля іконки.
  const showIcon = !/^\p{Extended_Pictographic}/u.test(label);
  const meta = [
    hc ? h('span', { class: 'hchip ' + hc.cls, title: hc.label, 'aria-label': hc.label, role: 'img', text: hc.icon }) : null,
    a.disabled ? h('span', { class: 'tag', text: '⏸ вимкнено' }) : null,
    a.optional ? h('span', { class: 'tag', title: 'Необовʼязковий: якщо ціль не знайдено — крок пропускається', text: 'необов.' }) : null,
    a.waitResponse ? h('span', { class: 'tag', title: 'Після кліку чекає відповідь сервера', text: '⏳ відповідь' }) : null,
    formatDelay(a.delayAfter) ? h('span', { class: 'tag' + (a.pausing ? ' pausing' : ''), title: a.pausing ? 'Зараз триває пауза після цього кроку' : 'Пауза після виконання кроку (✎ — змінити)', text: '⏱ ' + formatDelay(a.delayAfter) + (a.pausing ? ' · пауза…' : '') }) : null,
    sb ? h('span', { class: 'strat ' + sb.cls, title: sb.title, 'aria-label': sb.title, text: sb.text }) : null,
    a.healed ? h('span', { class: 'tag healed', title: 'Основний локатор не спрацював — ціль знайдено альтернативним. Варто перевибрати ціль у ✎.', text: '🩹 alt' }) : null,
  ].filter(Boolean);
  const acts = !busy ? h('span', { class: 'acts' },
    op('✎', 'Редагувати крок', { fk: k + '-edit', onClick: () => editStep(page, rec, a) }),
    mergeOp(page, rec, a, si, k),
    op(a.disabled ? '▶' : '⏸', a.disabled ? 'Увімкнути крок' : 'Вимкнути крок (пропускати при відтворенні)', { fk: k + '-dis', onClick: () => toggleDisabled(page, a) }),
    op('↑', 'Перемістити вище', { fk: k + '-up', disabled: si === 0, onClick: () => reorder(page, rec, a, -1) }),
    op('↓', 'Перемістити нижче', { fk: k + '-down', disabled: si === rec.subs.length - 1, onClick: () => reorder(page, rec, a, 1) }),
    op('✕', 'Видалити крок', { fk: k + '-del', onClick: () => deleteStep(page, rec, a) })) : null;
  const li = h('li', { class: cls || null, 'data-si': String(si) },
    h('div', { class: 'row-main' },
      h('span', { class: 'n', text: String(si + 1) }),
      showIcon ? h('span', { class: 'ico', 'aria-hidden': 'true', text: icon }) : null,
      h('span', { class: 'desc', text: label }),
      h('span', { class: 'badge', role: status ? 'img' : null, 'aria-label': status ? (fb ? FALLBACK_TEXT : STATUS_TEXT[status] || status) : null, title: fb ? 'Локатор не спрацював — пройдено запасним шляхом. Варто перевибрати ціль у ✎.' : null, text: status ? (fb ? '⚠' : STATUS_BADGE[status] || '') : '' })),
    meta.length || acts ? h('div', { class: 'row-meta' }, meta, acts) : null);

  if (a.error && (a.status === 'failed' || a.status === 'skipped')) {
    const hasXY = Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)) && a.x != null && a.y != null;
    const canCoords = a.target && a.target.pick !== -1 && hasXY;
    li.appendChild(h('div', { class: 'err' + (a.status === 'skipped' ? ' soft' : '') },
      h('span', { class: 'err-text', text: a.error }),
      a.failShot ? h('button', { type: 'button', class: 'failshot', 'aria-label': 'Збільшити знімок у момент збою', title: 'Знімок у момент збою — клік, щоб збільшити',
        on: { click: () => showShot(a.failShot, 'Збій: ' + stepLabel(a)) } }, h('img', { src: a.failShot, alt: '', loading: 'lazy' })) : null,
      !busy && a.status === 'failed' && (canCoords || !a.optional) ? h('span', { class: 'fixes' },
        canCoords ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: '📍 лише координати', title: 'Не шукати локатор — клікати за записаними координатами',
          on: { click: () => quickFix(page, a, 'coords') } }) : null,
        !a.optional ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'необовʼязковий', title: 'Якщо ціль не знайдено — пропускати крок',
          on: { click: () => quickFix(page, a, 'optional') } }) : null) : null));
  }

  return li;
}

// ✎ — редагування кроку в окремій модалці. Поки модалка відкрита, рядок підсвічено
// (ui.editing). Якщо крок за цей час зник/замінився (запис, undo) — зміни не застосовуємо.
async function editStep(page, rec, a) {
  if (isBusy() || ui.editing) return;
  const si = rec.subs.indexOf(a);
  if (si < 0) return;
  ui.editing = a; emit('pages');
  let next = null;
  try {
    next = await openStepEditor(a, { title: 'Крок ' + (si + 1) + ' · «' + rec.name + '»', subtitle: stepLabel(a) });
  } finally {
    if (ui.editing === a) ui.editing = null;
  }
  const idx = rec.subs.indexOf(a);
  if (!next) { emit('pages'); focusLater(keyOf(a) + '-edit'); return; }
  if (idx < 0 || isBusy()) { emit('pages'); setLive('Крок змінився, поки був відкритий редактор — зміни не застосовано.', false); return; }
  keys.set(next, keyOf(a));
  rec.subs[idx] = next;
  changed(page);
  focusLater(keyOf(a) + '-edit');
  setLive('Крок ' + (idx + 1) + ' у «' + rec.name + '» змінено.', false);
}

// ⤵ — обʼєднати текстовий крок із наступним видимим текстовим кроком.
// Кнопка є лише коли наступний видимий крок — теж текст; неактивна (з поясненням),
// якщо злиття неможливе (різні поля, вимкнений крок…).
function mergeOp(page, rec, a, si, k) {
  if (!a || a.type !== 'text') return null;
  const hideMoves = !ui.showMoves.has(rec.id);
  const j = nextVisibleIndex(rec.subs, si, { hideMoves });
  if (j < 0 || !rec.subs[j] || rec.subs[j].type !== 'text') return null;
  const res = mergeTextSteps(rec.subs, si, { hideMoves });
  const lost = res.ok && res.droppedDelay ? ' — пауза ⏱ ' + formatDelay(res.droppedDelay, { plus: false }) + ' між ними буде прибрана' : '';
  return op('⤵', res.ok ? 'Обʼєднати з наступним кроком тексту в один крок' + lost : 'Не можна обʼєднати: ' + res.reason,
    { fk: k + '-merge', disabled: !res.ok, onClick: () => mergeWithNext(page, rec, a) });
}

function mergeWithNext(page, rec, a) {
  if (isBusy()) return;
  const si = rec.subs.indexOf(a);
  if (si < 0) return;
  const res = mergeTextSteps(rec.subs, si, { hideMoves: !ui.showMoves.has(rec.id) });
  if (!res.ok) { setLive('Не можна обʼєднати: ' + res.reason, false); return; }
  const before = rec.subs;
  keys.set(res.step, keyOf(a));
  rec.subs = res.subs;
  const stamp = subsStamp(rec);
  if (ui.editing && !rec.subs.includes(ui.editing)) ui.editing = null;
  changed(page);
  focusLater(keyOf(res.step) + '-edit');
  const lost = res.droppedDelay ? ' (пауза ⏱ ' + formatDelay(res.droppedDelay, { plus: false }) + ' між ними прибрана)' : '';
  undoToast('Обʼєднано: ' + stepLabel(res.step) + lost, () => {
    // Дію відтоді змінено (перестановка, видалення, ✎…) — відкат затер би ці зміни.
    if (!subsUnchanged(rec, stamp)) { setLive('«' + rec.name + '» вже змінено — скасування обʼєднання неможливе.', false); return; }
    rec.subs = before;
    changed(page);
    focusLater(keyOf(a) + '-merge');
  });
}

function movesRow(page, rec, it, busy) {
  const sts = it.sis.map((si) => (rec.subs[si] || {}).status).filter(Boolean);
  const allSkipped = sts.length === it.count && sts.every((s) => s === 'skipped');
  const label = '+' + it.count + ' ' + pluralUk(it.count, ['рух', 'рухи', 'рухів']) + ' миші';
  return h('li', { class: 'moves-row' + (allSkipped ? ' skipped' : '') },
    h('span', { class: 'n', text: String(it.sis[0] + 1) }),
    h('button', { type: 'button', class: 'linkish', 'data-fk': 'mv' + rec.id + '_' + it.sis[0], 'aria-expanded': 'false',
      'aria-label': 'Показати ' + label + ' (legacy-запис)', title: 'Legacy-записи рухів миші — при відтворенні пропускаються',
      text: '🖱️ ' + label, on: { click: () => toggleMoves(rec) } }),
    allSkipped ? h('span', { class: 'badge', role: 'img', 'aria-label': 'пропущено', text: '⏭' }) : null,
    !busy ? h('button', { type: 'button', class: 'linkish opt', text: '⚡ прибрати', title: 'Оптимізувати Дію: прибрати рухи і злити посимвольний текст',
      on: { click: () => optimizeRec(page, rec) } }) : null);
}

function focusLater(fk, fallbackEl) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = fk ? pagesEl.querySelector('[data-fk="' + CSS.escape(fk) + '"]') : null;
    if (el) el.focus();
    else if (fallbackEl && document.contains(fallbackEl)) fallbackEl.focus();
  }));
}

// fk сусіднього елемента (наступного, інакше попереднього) у РЕНДЕРІ — до видалення,
// щоб фокус не падав на <body>. sel — селектор кнопки всередині сусіда.
function neighborFk(el, sel) {
  if (!el) return null;
  for (const n of [el.nextElementSibling, el.previousElementSibling]) {
    const b = n && n.querySelector && n.querySelector(sel);
    if (b && b.dataset.fk) return b.dataset.fk;
  }
  return null;
}
const rowOf = (fk) => { const b = pagesEl.querySelector('[data-fk="' + CSS.escape(fk) + '"]'); return b ? b.closest('li') : null; };

// «Скасувати»-тости: під час прогону/запису відновлення зсунуло б індекси кроків.
const undoToasts = new Set();
function undoToast(text, onUndo, extra = {}) {
  const t = toast(text, {
    actionText: 'Скасувати', ...extra,
    onAction: guardUndo(onUndo, { isBusy, onBlocked: (msg) => { toast(msg, { kind: 'warn' }); setLive(msg, false); } }),
  });
  for (const x of undoToasts) if (!x.el || !x.el.isConnected) undoToasts.delete(x);
  undoToasts.add(t);
  return t;
}
function closeUndoToasts() { for (const t of undoToasts) { try { t.close(); } catch (_e) { /* */ } } undoToasts.clear(); }

function onRunFinished({ page } = {}) {
  if (!page || !state.pages.includes(page)) return;
  let first = null;
  for (const r of page.recs || []) {
    if ((r.subs || []).some((a) => a && (a.status === 'failed' || (a.fallback && a.status === 'done')))) {
      if (!r.expanded) { r.expanded = true; expand.set('r', r.id, true); }
      first = first || r;
    }
  }
  if (!first) return;
  if (!page.expanded) { page.expanded = true; expand.set('p', page.id, true); }
  emit('pages');
  const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  raf(() => raf(() => {
    const li = pagesEl.querySelector('.subs li.failed') || pagesEl.querySelector('.subs li.fallback');
    if (li && li.offsetParent && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }));
}

// ---------- Inline-перейменування ----------
function startRename(kind, id) {
  ui.renaming = { kind, id };
  emit('pages');
  focusLater('rename-' + kind + id);
}

function renameInput(value, label, commit) {
  const kind = ui.renaming.kind, id = ui.renaming.id;
  let done = false;
  const inp = h('input', { type: 'text', class: 'rename', 'aria-label': label, 'data-fk': 'rename-' + kind + id, maxlength: '200' });
  inp.value = value;
  const finish = (save) => {
    if (done) return;
    done = true;
    ui.renaming = null;
    const v = inp.value.trim();
    if (save && v && v !== value) commit(v); else emit('pages');
    focusLater((kind === 'p' ? 'p' : 'r') + id + '-name');
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  requestAnimationFrame(() => { if (document.contains(inp)) { inp.focus(); inp.select(); } });
  return inp;
}

function toggleExpand(kind, obj) {
  obj.expanded = !obj.expanded;
  expand.set(kind, obj.id, obj.expanded);
  emit('pages');
}

function toggleMoves(rec) {
  if (ui.showMoves.has(rec.id)) ui.showMoves.delete(rec.id); else ui.showMoves.add(rec.id);
  emit('pages');
}

// ---------- Меню (⋯) ----------
let menuState = null;
function closeMenu(focusAnchor) {
  if (!menuState) return;
  const { el, anchor, onDoc, onKey } = menuState;
  menuState = null;
  el.remove();
  document.removeEventListener('pointerdown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onDoc);
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (focusAnchor && document.contains(anchor)) anchor.focus();
  }
}

function openMenu(anchor, items) {
  const wasOpenFor = menuState && menuState.anchor;
  closeMenu();
  if (wasOpenFor === anchor) return; // повторний клік — закрити
  const list = items.filter(Boolean);
  const el = h('div', { class: 'sc-menu', role: 'menu' },
    list.map((it) => h('button', {
      type: 'button', role: 'menuitem', class: 'sc-menu-item' + (it.danger ? ' danger' : ''), disabled: !!it.disabled, text: it.label,
      // Фокус спершу на ⋯ — тоді діалог (URL/видалення) поверне його туди, а не на <body>.
      on: { click: () => { closeMenu(true); it.onClick(); } },
    })));
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth, mh = el.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const left = Math.max(8, Math.min(r.right - mw, vw - mw - 8));
  const top = r.bottom + 4 + mh > vh - 8 && r.top - 4 - mh > 8 ? r.top - 4 - mh : r.bottom + 4;
  el.style.left = left + 'px';
  el.style.top = Math.max(8, top) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  const btns = () => [...el.querySelectorAll('.sc-menu-item:not(:disabled)')];
  const onDoc = (e) => { if (e.type === 'resize' || (!el.contains(e.target) && e.target !== anchor)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key === 'Tab') {
      // Пункт меню (у кінці <body>) зникає — фокус на ⋯, а Tab продовжує від нього (без preventDefault).
      const a = menuState && menuState.anchor;
      closeMenu();
      if (a && document.contains(a)) a.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const b = btns(); if (!b.length) return;
      const i = b.indexOf(document.activeElement);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? b.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length;
      b[n].focus();
    }
  };
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onDoc);
  menuState = { el, anchor, onDoc, onKey };
  const first = btns()[0];
  if (first) first.focus();
}

// ---------- Знімок збою ----------
function showShot(src, title) {
  const dlg = h('dialog', { class: 'modal shot-modal', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('h2', { text: title }),
      h('button', { type: 'button', class: 'x', 'aria-label': 'Закрити', text: '✕', on: { click: () => dlg.close() } })),
    h('div', { class: 'shot-body' }, h('img', { src, alt: title })));
  const prev = document.activeElement;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { dlg.remove(); if (prev && document.contains(prev)) prev.focus(); });
  ($('dialogs') || document.body).appendChild(dlg);
  dlg.showModal();
}

// ---------- Операції над сценаріями ----------
const urlField = (value) => ({
  name: 'url', label: 'Стартовий URL', value, placeholder: 'https://example.com', type: 'url',
  hint: 'Можна без https:// — додасться автоматично.', required: true, requiredMsg: 'Вкажи стартовий URL', validate: validateUrl,
});

async function newPage() {
  if (isBusy()) return;
  const n = state.pages.length + 1;
  const def = (activeScreen() || {}).url || '';
  const r = await formDialog({
    title: 'Новий сценарій', okText: 'Створити',
    message: 'Сценарій = стартова сторінка + послідовність Дій, які ти запишеш і відтвориш.',
    fields: [urlField(def), { name: 'name', label: 'Назва', value: 'Сценарій ' + n }],
  });
  if (!r || isBusy()) return;
  state.pageCounter = nextPageId(state.pageCounter);
  const page = { id: state.pageCounter, name: r.name.trim() || 'Сценарій ' + n, url: r.url.trim(), expanded: true, recs: [] };
  expand.set('p', page.id, true);
  state.pages.push(page);
  emit('screens');
  changed(page);
  setLive('Створено «' + page.name + '». Далі: «⏺ Записати» — або «▶ Старт», щоб просто відкрити сторінку.', false);
  focusLater('p' + page.id + '-rec');
}

async function editUrl(p) {
  const r = await formDialog({ title: 'Стартовий URL', okText: 'Зберегти', fields: [urlField(p.url)] });
  if (!r) return;
  const url = r.url.trim();
  if (url && url !== p.url) { p.url = url; changed(p); }
}

function cloneRecs(recs) {
  return recs.map((r) => ({
    id: ++state.recCounter,
    name: r.name,
    expanded: false,
    subs: (r.subs || []).map((a) => {
      const c = JSON.parse(JSON.stringify(a));
      if (c && typeof c === 'object' && c.id != null) c.id = newStepId();
      return c;
    }),
  }));
}

function duplicatePage(p) {
  if (isBusy()) return;
  const src = pagePayload(p); // без тимчасових полів
  state.pageCounter = nextPageId(state.pageCounter);
  const copy = { id: state.pageCounter, name: p.name + ' (копія)', url: src.url, expanded: true, recs: cloneRecs(src.recs) };
  const idx = state.pages.indexOf(p);
  state.pages.splice(idx + 1, 0, copy);
  expand.set('p', copy.id, true);
  changed(copy);
  setLive('Створено копію «' + copy.name + '».', false);
}

async function deletePage(p) {
  const ok = await confirmDialog({
    title: 'Видалити сценарій?',
    message: '«' + p.name + '» і всі його Дії (' + p.recs.length + ') буде видалено.',
    okText: 'Видалити', danger: true,
  });
  if (!ok || isBusy()) return;
  const idx = state.pages.indexOf(p);
  if (idx < 0) return;
  const card = pagesEl.querySelector('[data-fk="p' + p.id + '-tg"]');
  const nfk = neighborFk(card && card.closest('article'), '.page-head .tg');
  state.pages.splice(idx, 1);
  emit('pages'); emit('screens');
  focusLater(nfk, newPageBtn);
  const del = deletePageRemote(p.id).catch((e) => { logLine('error', '❌ Сценарій #' + p.id + ' не видалено з БД: ' + e.message); });
  undoToast('Сценарій «' + p.name + '» видалено.', async () => {
    await del;
    if (state.pages.includes(p)) return;
    state.pages.splice(Math.min(idx, state.pages.length), 0, p);
    emit('screens');
    changed(p); // повторний PUT відновлює запис у БД
    setLive('Сценарій «' + p.name + '» відновлено.', false);
    focusLater('p' + p.id + '-tg');
  });
}

// ---------- Операції над Діями ----------
// Більше REC_CONFIRM_MIN кроків — спершу підтвердження (Дія може мати сотні кроків).
const REC_CONFIRM_MIN = 4;
async function deleteRec(page, rec) {
  if (isBusy()) return;
  if (rec.subs.length >= REC_CONFIRM_MIN) {
    const ok = await confirmDialog({
      title: 'Видалити Дію?', message: '«' + rec.name + '» (' + recCount(rec.subs.length) + ') буде видалено.',
      okText: 'Видалити', danger: true,
    });
    if (!ok || isBusy()) return;
  }
  const idx = page.recs.indexOf(rec);
  if (idx < 0) return;
  const head = pagesEl.querySelector('[data-fk="r' + rec.id + '-tg"]');
  const nfk = neighborFk(head && head.closest('section.rec'), '.rec-head .tg');
  page.recs.splice(idx, 1);
  changed(page);
  focusLater(nfk || 'p' + page.id + '-tg');
  undoToast('Дію «' + rec.name + '» (' + recCount(rec.subs.length) + ') видалено.', () => {
    if (!state.pages.includes(page) || page.recs.includes(rec)) return;
    page.recs.splice(Math.min(idx, page.recs.length), 0, rec);
    changed(page);
    focusLater('r' + rec.id + '-tg');
  });
}

function optimizeRec(page, rec) {
  if (isBusy()) return;
  const res = compactMoves(rec.subs);
  const removed = rec.subs.length - res.subs.length;
  if (!removed) { setLive('«' + rec.name + '»: нічого оптимізувати.', false); return; }
  const before = rec.subs;
  const after = res.subs;
  rec.subs = after;
  const stamp = subsStamp(rec);
  if (ui.editing && !rec.subs.includes(ui.editing)) ui.editing = null;
  changed(page);
  const parts = [];
  if (res.movesRemoved) parts.push('прибрано ' + res.movesRemoved + ' ' + pluralUk(res.movesRemoved, ['рух', 'рухи', 'рухів']));
  if (res.textMerged) parts.push(res.textMerged + ' символьних кроків злито в текст');
  const msg = '⚡ «' + rec.name + '»: ' + parts.join(', ') + ' (−' + removed + ' ' + pluralUk(removed, ['крок', 'кроки', 'кроків']) + ').';
  logLine('info', msg);
  undoToast(msg, () => {
    // Дію відтоді змінено (новий запис, редагування) — відкат затер би ці зміни.
    if (!subsUnchanged(rec, stamp)) { setLive('«' + rec.name + '» вже змінено — скасування оптимізації неможливе.', false); return; }
    rec.subs = before;
    if (ui.editing && !rec.subs.includes(ui.editing)) ui.editing = null;
    changed(page);
  }, { timeout: 12000 });
}

// ---------- Операції над кроками ----------
function toggleDisabled(page, a) {
  if (a.disabled) delete a.disabled; else a.disabled = true;
  changed(page);
}

function reorder(page, rec, a, dir) {
  const si = rec.subs.indexOf(a);
  const j = moveStep(rec.subs, si, dir, { hideMoves: !ui.showMoves.has(rec.id) });
  if (j < 0) return;
  changed(page);
  focusLater(keyOf(a) + (dir < 0 ? '-up' : '-down'));
}

function deleteStep(page, rec, a) {
  const si = rec.subs.indexOf(a);
  if (si < 0) return;
  const nfk = neighborFk(rowOf(keyOf(a) + '-del'), '[data-fk$="-del"]');
  rec.subs.splice(si, 1);
  if (ui.editing === a) ui.editing = null;
  changed(page);
  focusLater(nfk || 'r' + rec.id + '-tg');
  undoToast('Крок «' + stepLabel(a) + '» видалено.', () => {
    if (!state.pages.includes(page) || !page.recs.includes(rec) || rec.subs.includes(a)) return;
    rec.subs.splice(Math.min(si, rec.subs.length), 0, a);
    changed(page);
    focusLater(keyOf(a) + '-del');
  });
}

function quickFix(page, a, kind) {
  if (kind === 'coords' && a.target) a.target = { ...a.target, pick: -1 };
  if (kind === 'optional') a.optional = true;
  changed(page);
  setLive(kind === 'coords' ? 'Крок тепер клікає за координатами (без пошуку локатора).' : 'Крок позначено необовʼязковим.', false);
}

// ---------- Запис ----------
// recorder.start({page, mode, recId}) — mode: 'append' (продовжити з кінця, нова Дія),
// 'fromStart' (лише URL, нова Дія), 'appendTo' (дописати в Дію recId).
function startRecording(page, mode, recId) {
  if (state.running || state.recording) return;
  const r = recId != null ? page.recs.find((x) => x.id === recId) : null;
  if (r) { r.expanded = true; expand.set('r', r.id, true); }
  page.expanded = true; expand.set('p', page.id, true);
  Promise.resolve(recorder.start({ page, mode, recId })).catch((e) => {
    setLive('Запис не стартував: ' + ((e && e.message) || e), false);
    logLine('error', '❌ Запис: ' + ((e && e.message) || e));
  }).finally(() => emit('pages'));
}

function stopRecording() {
  Promise.resolve(recorder.finish()).finally(() => emit('pages'));
}

// ---------- Файл (крок type: 'file') ----------
function addFileToRec(page, rec) {
  if (!fileInput) return;
  fileTarget = { page, rec };
  fileInput.value = '';
  fileInput.click();
}

async function onFileChosen() {
  const f = fileInput.files[0];
  const tgt = fileTarget; fileTarget = null;
  if (!f || !tgt) return;
  const { page, rec } = tgt;
  setLive('Завантажую файл «' + f.name + '» (' + (f.size / 1048576).toFixed(1) + ' МБ)…', false, true);
  try {
    const d = await api.upload(f);
    if (!d.ok) { setLive('Помилка завантаження: ' + (d.error || ''), false); return; }
    rec.expanded = true;
    rec.subs.push({ type: 'file', fileId: d.fileId, filename: d.filename });
    changed(page);
    setLive('Файл «' + d.filename + '» додано до «' + rec.name + '».', false);
  } catch (e) { setLive('Помилка завантаження: ' + e.message, false); logLine('error', '❌ Файл не завантажено: ' + e.message); }
}

// ---------- Прогін ----------
export async function runPage(pageId, uptoRecId) {
  const page = state.pages.find((p) => p.id === pageId);
  if (!page || isBusy()) return null;
  closeMenu();
  ui.editing = null;
  return runScenario(page, uptoRecId); // legacy-рухи миші завжди пропускаються
}
