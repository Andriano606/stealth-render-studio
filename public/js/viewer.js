// viewer.js — переглядач результатів у #viewer: таби скрінів (#tabs) і показ активного
// скріна (#resultView). Скріни лише для перегляду (запис — у recorder.js; він слухає
// події на #resultView делегуванням, тож заміна <img> його не ламає).
//   initViewer()                         — підписка на 'screens' і перша відмальовка;
//   addScreen(label, src, url, opts)     — новий скрін стає активним. src: data:-URL, Blob або URL.
//        data:/Blob перетворюються на blob:-URL (у DOM не тримаємо мегабайтні base64-рядки);
//        opts: {ok, stopped, failed, scenario, upto, total} — якщо не передано, виводиться з
//        поточного прогону (state.run → сценарій, «до Дії N», к-сть помилок).
//        Ліміт MAX_SCREENS: найстаріші видаляються, їхні blob:-URL відкликаються.
//   closeScreen(id), closeAllScreens(), activeScreen(), currentShotImg().
// Клік по скріну (поза записом) — масштаб «по ширині» ↔ «1:1»; «↗» відкриває у новій вкладці.
// Під час прогону над переглядом — смуга «▶ Виконується «X» · крок 3/8 · Дія — підпис»,
// попередній скрін притлумлено; збій до першого скріна (URL недоступний) — картка помилки з
// «⟲ Повторити» (emit 'ui:run'), а не онбординг. Онбординг — лише коли сценаріїв ще немає.
// Чисті функції (pushScreen, splitScreens, dataUrlToBlob, deriveRunMeta, screenTitle,
// screenStatus, runBanner, placeholderMode) — без DOM, тестуються в node:test.
import { $, h, clear } from './dom.js';
import { state, on, emit } from './state.js';
import { stepLabel, formatDelay } from '../../lib/steps.js';

export const MAX_SCREENS = 12;

// ---------- Чиста логіка ----------
// Новий першим, обрізання до ліміту (сумісний API).
export function pushScreen(list, screen, max = MAX_SCREENS) {
  return splitScreens(list, screen, max).kept;
}
// Те саме + що випало (щоб відкликати blob:-URL).
export function splitScreens(list, screen, max = MAX_SCREENS) {
  const out = [screen, ...(list || [])];
  return { kept: out.slice(0, max), dropped: out.slice(max) };
}

// 'data:image/jpeg;base64,…' → Blob (синхронно, без fetch). Не data:-URL → null.
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,/.exec(String(dataUrl || ''));
  if (!m) return null;
  const payload = String(dataUrl).slice(m[0].length);
  const type = m[1] || 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(payload)], { type });
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Метадані з поточного прогону: Дії з прапорцем running — це ланцюг прогону.
// → {scenario, upto, uptoName, total, failed} або null.
export function deriveRunMeta(pages, run) {
  if (!run) return null;
  const page = (pages || []).find((p) => p.id === run.pageId);
  if (!page) return null;
  const recs = page.recs || [];
  let upto = 0, failed = 0, uptoName = '';
  recs.forEach((r, i) => {
    if (!r.running) return;
    upto = i + 1;
    uptoName = r.name || '';
    for (const a of r.subs || []) if (a && a.status === 'failed') failed++;
  });
  return { scenario: page.name, upto, uptoName, total: recs.length, failed };
}

// «Сценарій · до «Назва»» / «· усі Дії (N)» / «· «Назва»» (одна Дія) / «· лише URL»;
// назва Дії — та сама, що в сайдбарі (порядковий номер — лише для старих скрінів без назви).
export function screenTitle(s) {
  const raw = String((s && s.label) || '').replace(/^🎬\s*/, '');
  if (!s || !s.scenario) return raw || 'Скрін';
  const nm = s.uptoName ? '«' + s.uptoName + '»' : null;
  let part;
  if (!s.upto) part = 'лише URL';
  else if (s.total && s.upto >= s.total) part = s.total === 1 ? (nm || 'Дія 1') : 'усі Дії (' + s.total + ')';
  else part = 'до ' + (nm || 'Дії ' + s.upto);
  return s.scenario + ' · ' + part;
}

// 'failed' | 'stopped' | 'degraded' (усе пройшло, але частина — запасним шляхом 📍/🧲) | 'ok'.
export function screenStatus(s) {
  if (!s) return 'ok';
  if (s.ok === false || s.failed > 0) return 'failed';
  if (s.stopped) return 'stopped';
  if (s.degraded > 0) return 'degraded';
  return 'ok';
}

export const STATUS_TEXT = { ok: 'успішно', failed: 'є помилки', stopped: 'зупинено', degraded: '⚠ запасний шлях' };

// Смуга «що виконується» під час прогону: {scenario, recName, cur, total, label, stopping} або null.
// Під час ⏱ паузи після кроку (plan.pause) — cur = крок, після якого пауза, + pause (мс) і next (що далі).
export function runBanner(pages, run) {
  if (!run || !run.plan) return null;
  const page = (pages || []).find((p) => p.id === run.pageId);
  if (!page) return null;
  const plan = run.plan;
  const total = plan.total || 0;
  let i = -1;
  const pz = plan.pause && plan.map[plan.pause.index] ? plan.pause : null;
  if (pz) i = pz.index;
  else for (let k = 0; k < total; k++) {
    const m = plan.map[k];
    const a = m && m.rec && m.rec.subs ? m.rec.subs[m.subIdxs[0]] : null;
    if (a && a.status === 'running') { i = k; break; }
  }
  if (i < 0) { const done = (plan.results || []).filter(Boolean).length; i = Math.min(done, total - 1); }
  const m = i >= 0 ? plan.map[i] : null;
  return {
    scenario: page.name, total, cur: total ? i + 1 : 0,
    recName: m && m.rec ? m.rec.name : '', label: i >= 0 && plan.flat[i] ? stepLabel(plan.flat[i]) : '',
    stopping: !!run.stopping,
    ...(pz ? { pause: pz.ms, next: plan.flat[i + 1] ? stepLabel(plan.flat[i + 1]) : '' } : {}),
  };
}
export function runBannerText(b) {
  if (!b) return '';
  if (b.stopping) return '⏹ Зупиняю «' + b.scenario + '»…';
  if (!b.total) return '▶ Виконується «' + b.scenario + '» — відкриваю URL…';
  if (b.pause) return '⏱ «' + b.scenario + '» · пауза ' + formatDelay(b.pause, { plus: false }) + ' після кроку ' + b.cur + '/' + b.total + (b.next ? ' — далі: ' + b.next : ' — далі: фінальний скрин');
  return '▶ Виконується «' + b.scenario + '» · крок ' + b.cur + '/' + b.total + (b.recName ? ' · ' + b.recName : '') + (b.label ? ' — ' + b.label : '');
}

// Що показати, коли активного скріна немає: 'onboarding' (сценаріїв ще немає) |
// 'error' (останній прогін упав до скріна) | 'hint' (є сценарії — коротка підказка).
export function placeholderMode(pages, runError) {
  if (runError) return 'error';
  return (pages || []).length ? 'hint' : 'onboarding';
}

// ---------- DOM ----------
let tabsEl = null, viewEl = null, countEl = null, bannerEl = null;
let shownId = null; // який скрін зараз у #resultView (щоб не перемальовувати <img> даремно)
let zoomFull = false;
let runError = null; // {pageId, name, error} — прогін упав, а скріна немає
let runScreens = 0;  // скрінів, доданих під час поточного прогону

export function initViewer() {
  tabsEl = $('tabs');
  viewEl = $('resultView');
  countEl = $('tabsCount');
  // Смуга прогону — поза #resultView (showActive його очищає).
  bannerEl = h('div', { class: 'run-banner', hidden: true, 'aria-hidden': 'true' });
  if (viewEl && viewEl.parentNode) viewEl.parentNode.insertBefore(bannerEl, viewEl);
  on('screens', render);
  let wasRunning = false;
  on('busy', () => {
    renderTabs(); // кнопки закриття вимикаються під час запису
    if (state.running && !wasRunning) { // старт прогону: стара картка помилки більше не актуальна
      runScreens = 0;
      if (runError) { runError = null; shownId = null; showActive(); }
    }
    wasRunning = !!state.running;
    renderRunBanner();
  });
  on('pages', renderRunBanner);
  on('screens:added', () => { runScreens++; if (runError) { runError = null; shownId = null; } });
  on('run:finished', ({ page, summary, screen } = {}) => {
    if (!page || !summary || summary.status !== 'error' || screen || runScreens) return;
    runError = { pageId: page.id, name: page.name, error: summary.error || summary.text };
    shownId = null;
    // Показати картку помилки замість старого скріна.
    state.activeScreenId = null;
    emit('screens');
  });
  tabsEl.addEventListener('scroll', updateTabsFade, { passive: true });
  tabsEl.addEventListener('keydown', onTabsKey);
  viewEl.addEventListener('click', onViewClick);
  const closeAll = $('tabsCloseAll');
  if (closeAll) closeAll.addEventListener('click', closeAllScreens);
  if (globalThis.ResizeObserver) new ResizeObserver(updateTabsFade).observe(tabsEl);
  render();
}

function toObjectUrl(src) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return { url: URL.createObjectURL(src), owned: true };
  if (typeof src === 'string' && src.startsWith('data:')) {
    try {
      const blob = dataUrlToBlob(src);
      if (blob) return { url: URL.createObjectURL(blob), owned: true };
    } catch (_e) { /* битий base64 — покажемо як є */ }
  }
  return { url: String(src || ''), owned: false };
}
// Відкликаємо з невеликою затримкою: <img>, щойно замінений у DOM, міг ще не дочитати blob.
function revoke(s) {
  if (!s || !s.owned || !s.src) return;
  const u = s.src;
  setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_e) { /* */ } }, 3000);
}

export function addScreen(label, src, url, opts = {}) {
  const id = ++state.screenSeq;
  const meta = deriveRunMeta(state.pages, state.run) || {};
  const stopped = opts.stopped != null ? !!opts.stopped : /⏹\s*$/.test(String(label || ''));
  const { url: objUrl, owned } = toObjectUrl(src);
  const screen = {
    id, label: String(label || ''), src: objUrl, owned, url: url || '',
    time: new Date().toTimeString().slice(0, 5),
    scenario: opts.scenario != null ? opts.scenario : meta.scenario,
    upto: opts.upto != null ? opts.upto : meta.upto,
    total: opts.total != null ? opts.total : meta.total,
    uptoName: opts.uptoName != null ? opts.uptoName : (meta.uptoName || ''),
    failed: opts.failed != null ? opts.failed : (meta.failed || 0),
    degraded: opts.degraded || 0,
    ok: opts.ok,
    stopped,
  };
  const { kept, dropped } = splitScreens(state.screens, screen);
  dropped.forEach(revoke);
  state.screens = kept;
  state.activeScreenId = id;
  zoomFull = false;
  emit('screens');
  emit('screens:added', { id, status: screenStatus(screen) });
  return id;
}

export function closeScreen(id) {
  const idx = state.screens.findIndex((s) => s.id === id);
  if (idx < 0) return;
  revoke(state.screens[idx]);
  state.screens = state.screens.filter((s) => s.id !== id);
  if (state.activeScreenId === id) {
    const next = state.screens[Math.min(idx, state.screens.length - 1)];
    state.activeScreenId = next ? next.id : null;
  }
  emit('screens');
}

export function closeAllScreens() {
  if (state.recording) return;
  state.screens.forEach(revoke);
  state.screens = [];
  state.activeScreenId = null;
  emit('screens');
}

export function activeScreen() { return state.screens.find((s) => s.id === state.activeScreenId) || null; }

export function currentShotImg() { return viewEl ? viewEl.querySelector('img.shot') : null; }

function selectScreen(id, focus) {
  runError = null;
  state.activeScreenId = id;
  zoomFull = false;
  emit('screens');
  if (focus) {
    const b = tabsEl.querySelector('[data-sid="' + id + '"]');
    if (b) b.focus();
  }
}

function render() { renderTabs(); showActive(); }

function renderRunBanner() {
  if (!bannerEl) return;
  const b = state.running ? runBanner(state.pages, state.run) : null;
  bannerEl.hidden = !b;
  bannerEl.textContent = b ? runBannerText(b) : '';
  bannerEl.title = bannerEl.textContent;
  if (viewEl) viewEl.classList.toggle('is-running', !!b);
}

function renderTabs() {
  if (!tabsEl) return;
  clear(tabsEl);
  const closeAll = $('tabsCloseAll');
  if (closeAll) { closeAll.hidden = state.screens.length < 2; closeAll.disabled = state.recording; }
  if (countEl) countEl.textContent = state.screens.length ? state.screens.length + '/' + MAX_SCREENS : '';
  if (!state.screens.length) { tabsEl.appendChild(h('span', { class: 'empty', text: 'Скрінів поки немає' })); updateTabsFade(); return; }
  for (const s of state.screens) {
    const active = s.id === state.activeScreenId;
    const title = screenTitle(s);
    const st = screenStatus(s);
    const tip = [title, STATUS_TEXT[st] + (s.failed ? ' (' + s.failed + ')' : ''), s.time, s.url].filter(Boolean).join('\n');
    tabsEl.appendChild(h('div', { class: 'tab st-' + st + (active ? ' active' : ''), role: 'presentation' },
      h('button', {
        type: 'button', class: 'tab-btn', role: 'tab', 'aria-selected': active ? 'true' : 'false',
        'aria-controls': 'resultView', tabindex: active ? '0' : '-1', title: tip, dataset: { sid: String(s.id) },
        on: { click: () => selectScreen(s.id) },
      },
      h('span', { class: 'sdot', 'aria-hidden': 'true' }),
      h('span', { class: 'visually-hidden', text: STATUS_TEXT[st] + ': ' }),
      h('span', { class: 'tab-title', text: title }),
      h('span', { class: 'tab-time', text: s.time || '' })),
      h('button', {
        type: 'button', class: 'tab-close', 'aria-label': 'Закрити скрін «' + title + '»', title: 'Закрити',
        disabled: state.recording, text: '✕',
        on: { click: () => closeScreen(s.id) },
      })));
  }
  const act = tabsEl.querySelector('.tab.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTabsFade();
}

// Стрілки ←/→, Home/End між табами (roving tabindex).
function onTabsKey(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  if (!e.target.closest || !e.target.closest('.tab-btn')) return;
  const ids = state.screens.map((s) => s.id);
  if (!ids.length) return;
  let i = ids.indexOf(state.activeScreenId);
  if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
  else if (e.key === 'ArrowRight') i = Math.min(ids.length - 1, i + 1);
  else if (e.key === 'Home') i = 0;
  else i = ids.length - 1;
  e.preventDefault();
  selectScreen(ids[i], true);
}

// Індикатори «є ще таби ліворуч/праворуч» на вузьких екранах.
function updateTabsFade() {
  if (!tabsEl) return;
  const max = tabsEl.scrollWidth - tabsEl.clientWidth;
  tabsEl.classList.toggle('fade-l', tabsEl.scrollLeft > 2);
  tabsEl.classList.toggle('fade-r', max - tabsEl.scrollLeft > 2);
}

function showActive() {
  if (!viewEl) return;
  const s = activeScreen();
  if (s && shownId === s.id && viewEl.querySelector('img.shot')) { applyZoom(); return; }
  shownId = s ? s.id : null;
  clear(viewEl);
  if (!s) { viewEl.appendChild(emptyState()); return; }
  const title = screenTitle(s);
  const st = screenStatus(s);
  viewEl.appendChild(h('div', { class: 'shot-bar' },
    h('span', { class: 'sdot st-' + st, 'aria-hidden': 'true' }),
    h('div', { class: 'shot-info' },
      h('div', { class: 'shot-title', text: title }),
      h('div', { class: 'shot-sub', text: [STATUS_TEXT[st] + (s.failed ? ': ' + s.failed : ''), s.time, s.url].filter(Boolean).join(' · ') })),
    h('button', {
      type: 'button', class: 'btn btn-secondary btn-small', id: 'shotZoom', 'aria-pressed': 'false',
      on: { click: () => { zoomFull = !zoomFull; applyZoom(); } },
    }),
    h('a', {
      class: 'btn btn-secondary btn-small', href: s.src, target: '_blank', rel: 'noopener',
      'aria-label': 'Відкрити скрін у новій вкладці', title: 'Відкрити в новій вкладці', text: '↗',
    }),
    h('a', {
      class: 'btn btn-secondary btn-small', href: s.src, download: 'screen-' + s.id + '.jpg',
      'aria-label': 'Завантажити скрін', title: 'Завантажити', text: '⬇',
    })));
  viewEl.appendChild(h('div', { class: 'shot-wrap' },
    h('img', { class: 'shot', src: s.src, alt: 'Скрін: ' + title, draggable: 'false' })));
  applyZoom();
}

function applyZoom() {
  const img = currentShotImg();
  const btn = $('shotZoom');
  if (img) img.classList.toggle('full', zoomFull);
  if (btn) {
    btn.textContent = zoomFull ? '↔ По ширині' : '🔍 1:1';
    btn.setAttribute('aria-pressed', zoomFull ? 'true' : 'false');
    btn.title = zoomFull ? 'Вмістити по ширині' : 'Справжній розмір (1:1)';
  }
}

// Клік по скріну — перемикання масштабу (окрім режиму запису по скріну).
function onViewClick(e) {
  if (state.recording) return;
  if (!e.target.matches || !e.target.matches('img.shot')) return;
  zoomFull = !zoomFull;
  applyZoom();
}

function emptyState() {
  const mode = placeholderMode(state.pages, runError && state.pages.some((p) => p.id === runError.pageId) ? runError : null);
  const toScenarios = h('button', {
    type: 'button', class: 'btn btn-secondary mobile-only', text: '📋 До сценаріїв',
    on: { click: () => emit('ui:pane', 'scenarios') },
  });
  if (mode === 'error') {
    const e = runError;
    return h('div', { class: 'placeholder ph-error', role: 'note' },
      h('p', { class: 'ph-title', text: '✗ «' + e.name + '»: прогін не дійшов до скріна' }),
      h('p', { class: 'ph-err', text: e.error || 'помилка' }),
      h('div', { class: 'ph-acts' },
        h('button', { type: 'button', class: 'btn btn-primary', text: '⟲ Повторити', disabled: state.running || state.recording,
          on: { click: () => emit('ui:run', { pageId: e.pageId }) } }),
        toScenarios));
  }
  if (mode === 'hint') {
    return h('div', { class: 'placeholder' },
      h('p', { class: 'ph-title', text: 'Немає відкритого скріна.' }),
      h('p', { class: 'ph-hint' },
        h('span', { class: 'desk-only', text: 'Натисни ▶ Старт або ⏺ Записати у сценарії праворуч.' }),
        h('span', { class: 'mob-only', text: 'Натисни ▶ Старт або ⏺ Записати у панелі «Сценарії».' })),
      toScenarios);
  }
  return h('div', { class: 'placeholder' },
    h('p', { class: 'ph-title', text: 'Тут зʼявиться скрін результату.' }),
    h('ol', null,
      h('li', null, h('b', { text: 'Створи сценарій' }), ' — «➕ Новий сценарій», стартовий URL.'),
      h('li', null, h('b', { text: '⏺ Запиши Дію' }), ' — тут відкриється жива сторінка: клікай і друкуй, кожна дія стає кроком.'),
      h('li', null, h('b', { text: '▶ Старт' }), ' — сценарій відтвориться з поточним конфігом, тут буде фінальний скрін.')),
    toScenarios);
}
