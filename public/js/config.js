// config.js — конфігуратор (<dialog id="cfgDialog">), пресети, чип активного конфігу в хедері
// і fingerprint реального браузера.
//   initConfig()            — кнопки ⚙/чип, закриття (Esc/✕/фон) з охороною незбережених змін;
//   openConfig()            — завантажує /profile + /presets, відкриває модалку;
//   ensureCurrentPreset()   — перед ▶ Старт: НІЧОГО не застосовує, лише повертає назву конфігу для
//                             логу; розбіжність із запамʼятованим пресетом → попередження + «● змінено»;
//   syncFingerprint()       — при старті UI: захоплює fingerprint ЛИШЕ якщо в профілі його немає
//                             (і активний пресет не «голий»); явна дія — «Захопити з мого браузера»;
//   updateHeaderChip()      — «🧩 Chromium · 📋 Ashby» / «… · кастом» / «… · 📋 Ashby ● змінено».
// Кнопки футера: «Застосувати» (draft → профіль; відрізняється від пресета → режим «кастом»),
// «💾 Оновити пресет «X»» (записати в пресет + застосувати), «➕ Зберегти як новий пресет».
// Під час застосування — busy-оверлей; launchError/помилки — у плашці всередині модалки.
// Чисті функції (configSig, subsetEq, presetMatches, makeDraft, setPath, draftBody,
// captureFingerprint, shouldAutoCapture, engineName, configStatus, chipInfo, changedCats,
// needsRelaunch, footerState) експортуються для тестів.
// Draft-модель: значення не губляться при перемиканні категорій; «Застосувати» застосовує.
import { $, h, clear, escapeHtml } from './dom.js';
import { state, on, storage } from './state.js';
import { api } from './api.js';
import { logLine, logRunSep, setLive } from './log.js';
import { confirmDialog, promptDialog, toast } from './dialogs.js';

// ---------- Чиста логіка ----------
export const CATS = [
  { key: 'engine', label: '🧩 Рушій' },
  { key: 'launch', label: '🚀 Запуск' },
  { key: 'stealth', label: '🕵️ Stealth' },
  { key: 'behavior', label: '🧍 Поведінка' },
  { key: 'fingerprint', label: '🧬 Fingerprint' },
  { key: 'cookies', label: '🍪 Cookies' },
];

// Підпис конфігу для порівняння draft із пресетом (що саме контролюють пресети).
export const configSig = (d) => JSON.stringify({ launch: d.launch, stealth: d.stealth, behavior: d.behavior, fingerprint: d.fingerprint });

// Чи всі поля part збігаються з target (часткове порівняння).
export function subsetEq(part, target) {
  if (!part) return true;
  for (const k of Object.keys(part)) {
    if (JSON.stringify(part[k]) !== JSON.stringify((target || {})[k])) return false;
  }
  return true;
}

export function presetMatches(body, prof) {
  if (!body || !prof) return false;
  if (body.clear) {
    const d = prof.defaults || {};
    return subsetEq(d.launch, prof.launch) && subsetEq(d.stealth, prof.stealth) && subsetEq(d.behavior, prof.behavior) && !prof.fingerprint;
  }
  return subsetEq(body.launch, prof.launch) && subsetEq(body.stealth, prof.stealth) && subsetEq(body.behavior, prof.behavior)
    && (body.fingerprint === undefined || JSON.stringify(body.fingerprint) === JSON.stringify(prof.fingerprint));
}

export function makeDraft(d) {
  d = d || {};
  return {
    // siteIsolationDisabled: профіль без поля = як раніше (ізоляцію вимкнено), див. lib/engine.js launchArgs.
    launch: Object.assign({ engine: 'chromium', headless: true, siteIsolationDisabled: true, stealthPlugin: false, persistent: false }, d.launch || {}),
    stealth: Object.assign({ webdriver: false, windowChrome: false }, d.stealth || {}),
    behavior: Object.assign({ humanize: false, prepareScroll: true, fastPrefix: false }, d.behavior || {}),
    fingerprint: d.fingerprint ? JSON.parse(JSON.stringify(d.fingerprint)) : null,
    cookiesCount: d.cookiesCount || 0,
    hasFingerprint: !!d.fingerprint,
  };
}

// Тіло POST /profile із draft.
export const draftBody = (d) => ({ launch: d.launch, stealth: d.stealth, behavior: d.behavior, fingerprint: d.fingerprint });

export function setPath(obj, path, val) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}

// Задекларовані параметри цього (справжнього) браузера. Обʼєкти інʼєктуються для тестів.
export function captureFingerprint(nav = globalThis.navigator, win = globalThis, intl = globalThis.Intl) {
  const scr = (win && win.screen) || {};
  return {
    userAgent: nav.userAgent,
    locale: nav.language || (nav.languages && nav.languages[0]) || 'en-US',
    languages: nav.languages ? Array.from(nav.languages) : undefined,
    timezoneId: intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: nav.platform,
    vendor: nav.vendor,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    deviceScaleFactor: win.devicePixelRatio,
    screen: { width: scr.width, height: scr.height, colorDepth: scr.colorDepth },
  };
}

// Автозахоплення при старті: лише якщо в профілі fingerprint немає і запамʼятований
// пресет не вимагає «без fingerprint» (Clear all / явне fingerprint:null) —
// інакше кожне перезавантаження UI змінювало б умови тесту.
// Автоматизований браузер (Playwright/headless, напр. скрипт-скріншот UI) НЕ захоплюємо:
// інакше в профіль потрапить «HeadlessChrome» UA і фейковий екран — прямий маячок бота.
export function isAutomatedBrowser(nav = globalThis.navigator) {
  if (!nav) return false;
  return nav.webdriver === true || /Headless/i.test(String(nav.userAgent || ''));
}

export function shouldAutoCapture(profile, activePreset, nav = globalThis.navigator) {
  if (!profile || profile.fingerprint) return false;
  if (isAutomatedBrowser(nav)) return false;
  const b = activePreset && activePreset.body;
  if (b && (b.clear || b.fingerprint === null)) return false;
  return true;
}

export const engineName = (launch) => ((launch && launch.engine) === 'camoufox' ? '🦊 Camoufox' : '🧩 Chromium');

// Стан конфігу відносно пресетів (для чипа в хедері й логу прогону):
//   mode 'preset'  — профіль збігається з пресетом (запамʼятованим або будь-яким);
//   mode 'changed' — є запамʼятований пресет, але профіль від нього відрізняється
//                    (змінено поза конфігуратором) — НЕ повертаємо мовчки, лише позначаємо;
//   mode 'custom'  — пресет не обрано й жоден не збігається;
//   mode 'none'    — пресетів немає (без БД).
export function configStatus(profile, presets, savedId) {
  const engine = engineName(profile && profile.launch);
  if (!presets || !presets.length) return { mode: 'none', engine, presetName: null, text: engine };
  const saved = presets.find((p) => p.id === savedId);
  const match = saved && presetMatches(saved.body, profile) ? saved : presets.find((p) => presetMatches(p.body, profile));
  if (match) return { mode: 'preset', engine, presetName: match.name, presetId: match.id, text: engine + ' · ' + match.name };
  if (saved) return { mode: 'changed', engine, presetName: saved.name, presetId: saved.id, text: engine + ' · ' + saved.name + ' ● змінено' };
  return { mode: 'custom', engine, presetName: null, text: engine + ' · кастом' };
}

// Підпис чипа: {text, custom} (сумісний API поверх configStatus).
export function chipInfo(profile, presets, savedId) {
  const st = configStatus(profile, presets, savedId);
  return { text: st.text, custom: st.mode === 'custom' || st.mode === 'changed' };
}

// Які шляхи draft належать категорії (для позначки «●» на вкладці зі змінами).
export const CAT_PATHS = {
  engine: ['launch.engine', 'launch.camoufoxHumanize', 'launch.camoufoxGeoip'],
  launch: ['launch'],
  stealth: ['stealth'],
  behavior: ['behavior'],
  fingerprint: ['fingerprint'],
  cookies: [],
};
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const ENGINE_KEYS = new Set(['engine', 'camoufoxHumanize', 'camoufoxGeoip']);

// Множина категорій, у яких draft відрізняється від застосованого (applied — теж draft).
export function changedCats(draft, applied) {
  const out = new Set();
  if (!draft || !applied) return out;
  const neq = (a, b) => JSON.stringify(a == null ? null : a) !== JSON.stringify(b == null ? null : b);
  for (const [cat, paths] of Object.entries(CAT_PATHS)) {
    for (const p of paths) {
      if (p === 'launch') {
        const keys = new Set([...Object.keys(draft.launch || {}), ...Object.keys(applied.launch || {})]);
        for (const k of keys) if (!ENGINE_KEYS.has(k) && neq(draft.launch[k], (applied.launch || {})[k])) out.add(cat);
      } else if (neq(getPath(draft, p), getPath(applied, p))) out.add(cat);
    }
  }
  return out;
}

// Чи потребує зміна перезапуску браузера (зміна launch-прапорців; сервер вирішує
// остаточно, тут — для попередження «прогін/жива сесія буде перервана»).
// body — тіло POST /profile (draft-тіло або тіло пресета), applied — поточний профіль.
export function needsRelaunch(body, applied) {
  if (!body) return false;
  if (body.clear) {
    const d = (applied && applied.defaults) || {};
    return !subsetEq(d.launch, applied && applied.launch);
  }
  return !subsetEq(body.launch, applied && applied.launch);
}

// Тексти футера конфігуратора: {apply, hint, update, saveNew} — що зробить кожна кнопка.
//   unsaved   — є незастосовані зміни; dirty — draft відрізняється від активного пресета;
//   activeName — назва активного пресета або null; presetsDb — чи можна зберігати пресети.
export function footerState({ unsaved, dirty, activeName, presetsDb }) {
  const s = { apply: 'Застосувати', applyDisabled: !unsaved, hint: '', update: null, saveNew: null };
  if (!unsaved && !dirty) s.hint = activeName ? 'Активний пресет «' + activeName + '», змін немає.' : 'Незастосованих змін немає.';
  else if (dirty && activeName) {
    s.hint = 'Відрізняється від пресета «' + activeName + '». «Застосувати» — без зміни пресета (режим «кастом»).';
    if (presetsDb) s.update = '💾 Оновити пресет «' + activeName + '»';
  } else if (unsaved) s.hint = 'Є незастосовані зміни.';
  if (presetsDb && (dirty || (unsaved && !activeName))) s.saveNew = '➕ Зберегти як новий пресет';
  return s;
}

// ---------- Стан модалки ----------
let dlg, cfgNav, cfgPresets, cfgBody, saveBtn, updBtn, newBtn, hintEl, alertEl, busyEl, resetBtn;
let cfgState = null, draft = null, activeCat = 'engine';
let presets = [], activePresetId = null; // пресети з БД + активний (вибраний користувачем)
let presetsDb = true;
let busy = false;

const savedPresetId = () => Number(storage.get('activePresetId')) || null;
const activePreset = () => presets.find((p) => p.id === activePresetId) || null;
const draftProf = () => (draft ? { ...draft, defaults: (cfgState && cfgState.defaults) || {} } : null);
// draft відрізняється від активного пресета (те, що пресет контролює).
const isDirty = () => { const p = activePreset(); return !!(p && draft && !presetMatches(p.body, draftProf())); };
const hasUnsaved = () => !!(draft && cfgState && configSig(draft) !== configSig(makeDraft(cfgState)));
const liveSessions = () => (state.health && state.health.sessions) || 0;

export function initConfig() {
  dlg = $('cfgDialog');
  cfgNav = $('cfgNav');
  cfgPresets = $('cfgPresets');
  cfgBody = $('cfgBody');
  saveBtn = $('cfgSave');
  updBtn = $('cfgUpdatePreset');
  newBtn = $('cfgSaveNew');
  hintEl = $('cfgHint');
  alertEl = $('cfgAlert');
  busyEl = $('cfgBusy');
  resetBtn = $('cfgReset');
  $('cfgBtn').addEventListener('click', openConfig);
  $('hdrConfigChip').addEventListener('click', openConfig);
  $('cfgClose').addEventListener('click', guardedClose);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); guardedClose(); }); // Esc
  dlg.addEventListener('click', (e) => { if (e.target === dlg) guardedClose(); }); // клік по фону
  cfgBody.addEventListener('input', onInput);
  cfgBody.addEventListener('click', onBodyClick);
  cfgNav.addEventListener('keydown', onNavKey);
  saveBtn.addEventListener('click', onSave);
  if (updBtn) updBtn.addEventListener('click', () => { const p = activePreset(); if (p) savePreset(p); });
  if (newBtn) newBtn.addEventListener('click', createPreset);
  resetBtn.addEventListener('click', () => {
    const clearP = presets.find((p) => p.body && p.body.clear);
    applyPreset(clearP || { id: null, name: '🧹 Clear all', body: { clear: true } });
  });
  // Health (живі сесії) змінює попередження про перезапуск — оновлюємо футер.
  on('health', () => { if (dlg.open) renderFooter(); });
}

async function guardedClose() {
  if (busy) return; // під час застосування не закриваємо (результат ще не відомий)
  if (hasUnsaved()) {
    const ok = await confirmDialog({
      title: 'Незбережені зміни',
      message: 'У конфігураторі є незастосовані зміни. Закрити без збереження?',
      okText: 'Закрити без збереження', danger: true,
    });
    if (!ok) return;
  }
  dlg.close();
}

export async function loadPresets() {
  try { const d = await api.getPresets(); presets = d.presets || []; presetsDb = d.db !== false; }
  catch (_e) { presets = []; }
  return presets;
}

export async function openConfig() {
  if (!dlg.open) dlg.showModal();
  showAlert('');
  clear(cfgNav); cfgBody.textContent = 'завантаження…';
  try {
    cfgState = await api.getProfile();
    draft = makeDraft(cfgState);
    await loadPresets();
    // Підсвічуємо ОСТАННІЙ вибраний пресет (localStorage). Якщо профіль від нього вже
    // відрізняється — пресет позначено «●», а не застосовано мовчки.
    const saved = savedPresetId();
    activePresetId = presets.some((p) => p.id === saved) ? saved : null;
    renderAll();
    const sel = cfgNav.querySelector('[aria-selected="true"]');
    if (sel) sel.focus();
  } catch (e) { cfgBody.textContent = 'Помилка: ' + e.message; }
}

function renderAll() { renderPresets(); renderNav(); renderCategory(); renderFooter(); }

function renderPresets() {
  clear(cfgPresets);
  cfgPresets.appendChild(h('span', { class: 'pre-label', text: 'Пресети:' }));
  if (!presets.length) {
    cfgPresets.appendChild(h('span', { class: 'pre-empty', text: presetsDb ? 'немає' : 'БД недоступна — пресетів немає' }));
  }
  const dirty = isDirty();
  for (const p of presets) {
    const active = p.id === activePresetId;
    cfgPresets.appendChild(h('button', {
      type: 'button',
      class: 'pre-btn' + (p.body && p.body.clear ? ' clear' : '') + (active ? ' active' : '') + (active && dirty ? ' dirty' : ''),
      'aria-pressed': active ? 'true' : 'false',
      disabled: busy,
      title: (active && dirty ? 'Змінено відносно пресета — клік поверне пресет. ' : 'Застосувати пресет. ') + (p.builtin ? '' : '(кастомний)'),
      text: p.name + (active && dirty ? ' ●' : ''),
      on: { click: () => applyPreset(p) },
    }));
  }
}

function renderNav() {
  clear(cfgNav);
  const changed = draft && cfgState ? changedCats(draft, makeDraft(cfgState)) : new Set();
  for (const c of CATS) {
    const sel = c.key === activeCat;
    const ch = changed.has(c.key);
    cfgNav.appendChild(h('button', {
      type: 'button', class: 'nav-item' + (ch ? ' changed' : ''), role: 'tab', 'aria-selected': sel ? 'true' : 'false',
      'aria-controls': 'cfgBody', id: 'cfgTab_' + c.key, tabindex: sel ? '0' : '-1', dataset: { cat: c.key },
      title: ch ? 'Є незастосовані зміни' : null,
      on: { click: () => selectCat(c.key) },
    }, c.label, ch ? h('span', { class: 'nav-dot', 'aria-label': '(змінено)', text: '●' }) : null));
  }
  cfgBody.setAttribute('aria-labelledby', 'cfgTab_' + activeCat);
  // На мобільному категорії — горизонтальні чипи: тримаємо активну на виду.
  const sel = cfgNav.querySelector('[aria-selected="true"]');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function selectCat(key, focus) {
  activeCat = key;
  renderNav(); renderCategory();
  cfgBody.scrollTop = 0;
  if (focus) { const b = cfgNav.querySelector('[data-cat="' + key + '"]'); if (b) b.focus(); }
}

// Стрілки (і ↑↓, і ←→ — меню вертикальне на десктопі й горизонтальне на мобільному), Home/End.
function onNavKey(e) {
  const keys = CATS.map((c) => c.key);
  let i = keys.indexOf(activeCat);
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = (i + 1) % keys.length;
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
  else if (e.key === 'Home') i = 0;
  else if (e.key === 'End') i = keys.length - 1;
  else return;
  e.preventDefault();
  selectCat(keys[i], true);
}

function renderFooter() {
  const ap = activePreset();
  const f = footerState({ unsaved: hasUnsaved(), dirty: isDirty(), activeName: ap ? ap.name : null, presetsDb });
  let hint = f.hint;
  if (draft && cfgState && needsRelaunch(draftBody(draft), cfgState) && (state.running || state.recording || liveSessions())) {
    hint = '⚠️ Зміна параметрів запуску перезапустить браузер — поточний прогін/жива сесія обірвуться.';
  }
  hintEl.textContent = hint;
  hintEl.classList.toggle('warn', hint.startsWith('⚠️'));
  saveBtn.textContent = busy ? 'Застосовую…' : f.apply;
  saveBtn.disabled = busy || f.applyDisabled;
  saveBtn.title = f.applyDisabled ? 'Немає незастосованих змін' : 'Застосувати зміни до браузера' + (isDirty() ? ' (без зміни пресета)' : '');
  updBtn.hidden = !f.update; if (f.update) { updBtn.textContent = f.update; updBtn.disabled = busy; }
  newBtn.hidden = !f.saveNew; if (f.saveNew) { newBtn.textContent = f.saveNew; newBtn.disabled = busy; }
  resetBtn.disabled = busy;
}

// Поки застосовуємо — у статусі тікає лічильник секунд, щоб було видно, що процес живий.
let busyTimer = null;
export function busyLabel(text, sec) { return (text || 'Застосовую…') + (sec >= 1 ? ' ' + sec + ' с' : ''); }
function setBusy(isOn, text) {
  busy = isOn;
  dlg.classList.toggle('busy', isOn);
  dlg.setAttribute('aria-busy', isOn ? 'true' : 'false');
  busyEl.hidden = !isOn;
  if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
  if (isOn) {
    const el = busyEl.querySelector('.busy-text');
    const t0 = Date.now();
    el.textContent = busyLabel(text, 0);
    busyTimer = setInterval(() => { el.textContent = busyLabel(text, Math.floor((Date.now() - t0) / 1000)); }, 1000);
  }
  renderPresets(); renderFooter();
}

function showAlert(text, kind = 'error') {
  if (!alertEl) return;
  alertEl.hidden = !text;
  alertEl.className = 'cfg-alert ' + kind;
  alertEl.textContent = text || '';
}

const hintHtml = (hint) => (hint ? `<span class="def">${hint}</span>` : '');
const fid = (path) => 'cf_' + path.replace(/\./g, '_');
const chk = (lbl, path, on, hint) => `<div class="cfg-row chk"><label><input type="checkbox" data-p="${path}" ${on ? 'checked' : ''}> ${lbl}</label>${hintHtml(hint)}</div>`;
const txt = (lbl, path, v, hint) => `<div class="cfg-row"><label for="${fid(path)}">${lbl}</label><input type="text" id="${fid(path)}" data-p="${path}" value="${escapeHtml(v == null ? '' : v)}">${hintHtml(hint)}</div>`;
const num = (lbl, path, v, hint) => `<div class="cfg-row"><label for="${fid(path)}">${lbl}</label><input type="number" id="${fid(path)}" data-p="${path}" value="${v == null ? '' : escapeHtml(v)}">${hintHtml(hint)}</div>`;

function renderCategory() {
  if (!draft) return;
  const L = draft.launch, st = draft.stealth, b = draft.behavior, fp = draft.fingerprint || {}, sc = fp.screen || {};
  const isCfx = L.engine === 'camoufox';
  const cfxNote = '<div class="cat-desc">🦊 Зараз обрано Camoufox — ці опції діють лише для Chromium. Camoufox має власний антидетект/fingerprint у рушії.</div>';
  let html = '';
  if (activeCat === 'engine') {
    html = '<h3>Рушій</h3><div class="cat-desc">Зміна = перезапуск браузера.</div>';
    const cur = isCfx ? 'camoufox' : 'chromium';
    html +=
      `<label class="engine-opt${cur === 'chromium' ? ' sel' : ''}"><input type="radio" name="eng" data-p="launch.engine" value="chromium"${cur === 'chromium' ? ' checked' : ''}>` +
      '<span><b>🧩 Chromium</b> <span class="def">(за замовчуванням)</span><br><span class="def">Швидко, для звичайних сайтів. Теплий пул контекстів, усі stealth-опції нижче.</span></span></label>' +
      `<label class="engine-opt${cur === 'camoufox' ? ' sel' : ''}"><input type="radio" name="eng" data-p="launch.engine" value="camoufox"${cur === 'camoufox' ? ' checked' : ''}>` +
      '<span><b>🦊 Camoufox</b> <span class="def">(Firefox-антидетект)</span><br><span class="def">Повільніше, але проходить жорсткий Cloudflare. Без CDP (Juggler), fingerprint у C++. Ігнорує Chromium-опції.</span></span></label>';
    // Опції Camoufox — лише коли обрано Camoufox.
    if (isCfx) {
      html += '<div style="margin-top:8px"><div class="cat-desc">Опції Camoufox:</div>';
      html += chk('humanize (рухи курсора в рушії)', 'launch.camoufoxHumanize', L.camoufoxHumanize !== false, 'для Cloudflare не потрібно (перевірено).');
      html += chk('geoip (timezone/locale під IP)', 'launch.camoufoxGeoip', L.camoufoxGeoip !== false, 'для Cloudflare не потрібно (перевірено).');
      html += '</div>';
    } else {
      html += '<div class="cat-desc" style="margin-top:8px">Chromium-опції — у вкладках «Запуск», «Stealth», «Fingerprint».</div>';
    }
  } else if (activeCat === 'launch') {
    html = '<h3>Запуск браузера</h3><div class="cat-desc">Зміна більшості = перезапуск браузера.</div>';
    html += chk('headless', 'launch.headless', L.headless !== false, 'дефолт: true (діє і для Camoufox).');
    if (isCfx) { html += cfxNote; } else {
      html += chk('новий headless (--headless=new)', 'launch.newHeadless', L.newHeadless !== false, 'майже як справжній Chrome. Вимкнути = старий headless (детектованіший).');
      html += chk('--disable-blink-features=AutomationControlled', 'launch.automationControlled', L.automationControlled !== false, 'прибирає сигнал автоматизації на рівні рушія.');
      html += chk('реальний GPU (ANGLE Metal)', 'launch.realGpu', L.realGpu !== false, 'справжні пікселі Canvas/WebGL замість софтверного SwiftShader.');
      html += chk('вимкнути ізоляцію сайтів (site-per-process)', 'launch.siteIsolationDisabled', L.siteIsolationDisabled !== false, 'крос-доменні iframe (напр. Ashby) рендеряться в одному процесі й потрапляють у fullPage-скрин. Дефолт Playwright: ізоляція увімкнена.');
      html += chk('stealth-plugin (playwright-extra)', 'launch.stealthPlugin', L.stealthPlugin !== false, 'десятки анти-детект патчів.');
    }
  } else if (activeCat === 'stealth') {
    html = '<h3>Stealth (JS-доповнення)</h3><div class="cat-desc">Наші ручні правки на рівні сторінки (Chromium).</div>';
    if (isCfx) { html += cfxNote; } else {
      html += chk('navigator.webdriver = false', 'stealth.webdriver', st.webdriver, 'на прототипі (не own-property). Дефолт Playwright: true.');
      html += chk('додати window.chrome', 'stealth.windowChrome', st.windowChrome, 'runtime/loadTimes/csi/app. Дефолт: відсутній у headless.');
      html += chk('outerWidth/Height = реальні', 'stealth.outerWindow', st.outerWindow, 'у headless вони 0 — явний маячок.');
      html += chk('permissions.query узгоджений', 'stealth.permissions', st.permissions, 'як у справжнього браузера.');
      html += chk('видаляти window.__pwInitScripts', 'stealth.pwInitScripts', st.pwInitScripts, 'прямий підпис Playwright (створює addInitScript).');
    }
  } else if (activeCat === 'behavior') {
    html = '<h3>Поведінка при відтворенні</h3><div class="cat-desc">Як виконуються записані дії (діє для обох рушіїв).</div>';
    html += chk('людські рухи миші й затримки', 'behavior.humanize', b.humanize !== false, 'криві рухи, паузи «на роздуми», друк по буквах, скроли — і у відтворенні, і в діях живої сесії. Дефолт: миттєво.');
    html += chk('autoScroll перед відтворенням (legacy-координати)', 'behavior.prepareScroll', b.prepareScroll !== false, 'прокрутка донизу й назад (як у рендері), щоб lazy-верстка збіглась зі скрином запису. Лише для старих координатних кліків; з humanize — колесом миші. Видно сторінці (scroll-події).');
    html += chk('швидкий префікс живої сесії', 'behavior.fastPrefix', b.fastPrefix === true, 'відтворювати префікс без humanize (швидше). У лозі сесії позначається «префікс: швидкий».');
  } else if (activeCat === 'fingerprint') {
    html = '<h3>Fingerprint ' + (draft.fingerprint ? '<span class="cfg-badge">задано</span>' : '<span class="def">(не задано)</span>') + '</h3>';
    if (isCfx) { html += cfxNote; } else {
      html += '<div class="cat-desc">Задекларовані параметри браузера (Chromium). Автоматично захоплюються з твого браузера лише один раз — коли в профілі їх немає; відредаговані значення більше не перезаписуються.</div>';
      html += '<div class="cfg-actions">' +
        '<button type="button" class="btn btn-secondary btn-small" data-act="fp-capture">🧲 Захопити з мого браузера</button>' +
        (draft.fingerprint ? '<button type="button" class="btn btn-ghost btn-small" data-act="fp-clear">🧹 Очистити fingerprint</button>' : '') +
        '</div>';
      html += txt('User-Agent', 'fingerprint.userAgent', fp.userAgent);
      html += txt('locale', 'fingerprint.locale', fp.locale);
      html += txt('timezoneId', 'fingerprint.timezoneId', fp.timezoneId);
      html += txt('platform', 'fingerprint.platform', fp.platform);
      html += txt('vendor', 'fingerprint.vendor', fp.vendor);
      html += num('hardwareConcurrency', 'fingerprint.hardwareConcurrency', fp.hardwareConcurrency);
      html += num('deviceMemory', 'fingerprint.deviceMemory', fp.deviceMemory);
      html += num('deviceScaleFactor', 'fingerprint.deviceScaleFactor', fp.deviceScaleFactor);
      html += num('screen width', 'fingerprint.screen.width', sc.width);
      html += num('screen height', 'fingerprint.screen.height', sc.height);
      html += num('screen colorDepth', 'fingerprint.screen.colorDepth', sc.colorDepth);
    }
  } else if (activeCat === 'cookies') {
    html = '<h3>Cookies</h3><div class="cat-desc">Підставлені cookies/storageState (Chromium).</div>';
    html += `<div class="cfg-row"><label>підставлено</label><span>${draft.cookiesCount || 0} шт.</span>` +
      (draft.cookiesCount ? ' <button type="button" class="btn btn-ghost btn-small" data-act="ck-clear">очистити</button>' : '') + '</div>';
  }
  cfgBody.innerHTML = html;
}

// Живе оновлення draft при зміні будь-якого поля (делегування на cfgBody).
function onInput(e) {
  const p = e.target.dataset.p; if (!p || !draft) return;
  let val;
  if (e.target.type === 'checkbox') val = e.target.checked;
  else if (e.target.type === 'number') { const v = e.target.value.trim(); val = v === '' ? undefined : Number(v); }
  else val = e.target.value; // text і radio (у radio value = рядок рушія)
  setPath(draft, p, val);
  if (p === 'launch.engine') renderCategory(); // підсвітити вибраний варіант
  renderPresets(); renderNav(); renderFooter(); // «●» на пресеті/вкладці + кнопки футера
  // renderNav перестворює кнопки — фокус лишається в полі (воно в cfgBody, не в nav).
}

async function onBodyClick(e) {
  const btn = e.target.closest && e.target.closest('[data-act]');
  if (!btn || !draft || busy) return;
  const act = btn.dataset.act;
  if (act === 'fp-capture') {
    draft.fingerprint = captureFingerprint();
    renderCategory(); renderPresets(); renderNav(); renderFooter();
    showAlert('Fingerprint захоплено в чернетку — натисни «Застосувати».', 'info');
  } else if (act === 'fp-clear') {
    draft.fingerprint = null;
    renderCategory(); renderPresets(); renderNav(); renderFooter();
  } else if (act === 'ck-clear') {
    try {
      const d = await api.postProfile({ cookies: null });
      draft.cookiesCount = d.cookiesCount || 0;
      if (cfgState) cfgState.cookiesCount = draft.cookiesCount;
      renderCategory();
    } catch (err) { showAlert('❌ Cookies не очищено: ' + err.message); logLine('error', '❌ Cookies не очищено: ' + err.message); }
  }
}

// Підтвердження, якщо зміна перезапустить браузер посеред прогону/живої сесії.
async function confirmRelaunch(body) {
  if (!needsRelaunch(body, cfgState)) return true;
  if (!state.running && !state.recording && !liveSessions()) return true;
  return confirmDialog({
    title: 'Перезапуск браузера',
    message: 'Ця зміна перезапустить браузер: поточний прогін і живі сесії запису буде перервано. Продовжити?',
    okText: 'Перезапустити', danger: true,
  });
}

// «Застосувати»: draft → профіль. Якщо відрізняється від активного пресета — режим
// «кастом» (activePresetId знімається), щоб ніщо не «повертало» пресет мовчки.
async function onSave() {
  if (!draft || busy) return;
  const body = draftBody(draft);
  if (!await confirmRelaunch(body)) return;
  const wasDirty = isDirty();
  const d = await applyProfile(body, 'Конфіг');
  if (!d) return;
  if (wasDirty) {
    activePresetId = null;
    storage.remove('activePresetId');
    logLine('info', '⚙ Конфіг відрізняється від пресета — далі працюємо в режимі «кастом».');
    renderAll();
    updateHeaderChip(d);
  }
  if (!d.launchError) dlg.close();
}

// POST /profile → оновлює draft/модалку, лог і чип. null при помилці (модалка лишається відкритою).
async function applyProfile(body, note) {
  const relaunch = needsRelaunch(body, cfgState);
  setLive((note || 'Застосовую конфіг') + '…', false, true);
  setBusy(true, relaunch ? 'Перезапускаю браузер…' : 'Застосовую…');
  showAlert('');
  let d;
  try {
    d = await api.postProfile(body);
  } catch (e) {
    const msg = e.status === 409 ? 'Браузер зайнятий — дочекайся завершення прогону. (' + e.message + ')' : e.message;
    logLine('error', '❌ Конфіг не застосовано: ' + msg);
    setLive('❌ Конфіг не застосовано: ' + msg, false);
    showAlert('❌ Конфіг не застосовано: ' + msg);
    return null;
  } finally {
    setBusy(false);
  }
  cfgState = d; draft = makeDraft(d);
  if (dlg && dlg.open) renderAll();
  logRunSep((note || 'Конфіг оновлено') + (d.relaunched ? ' (браузер перезапущено)' : ''));
  logLine('info', '⚙ рушій=' + d.launch.engine + ', webdriver=' + (d.stealth.webdriver ? 'false' : 'default') + ', stealthPlugin=' + d.launch.stealthPlugin + ', humanize=' + d.behavior.humanize);
  updateHeaderChip(d);
  if (d.launchError) {
    logLine('error', '❌ Браузер не запустився: ' + d.launchError);
    setLive('❌ Помилка запуску браузера: ' + d.launchError, false);
    showAlert('❌ Конфіг збережено, але браузер не запустився: ' + d.launchError + '. Зміни налаштування (напр. рушій) і застосуй ще раз.');
    return d;
  }
  setLive((note || 'Конфіг') + ' застосовано' + (d.relaunched ? ' (перезапуск)' : '') + '.', false);
  return d;
}

async function applyPreset(p) {
  if (!p || busy) return;
  if (hasUnsaved()) {
    const ok = await confirmDialog({
      title: 'Застосувати пресет?',
      message: 'Пресет «' + p.name + '» замінить незастосовані зміни в конфігураторі.',
      okText: 'Застосувати пресет',
    });
    if (!ok) return;
  }
  if (!await confirmRelaunch(p.body)) return;
  const d = await applyProfile(p.body, 'Пресет «' + p.name + '»');
  if (!d) return;
  activePresetId = p.id || null;
  if (p.id) storage.set('activePresetId', String(p.id)); else storage.remove('activePresetId');
  renderAll();
  updateHeaderChip(d);
}

// «💾 Оновити пресет «X»»: записати draft у пресет І застосувати.
async function savePreset(p) {
  if (busy) return;
  const body = draftBody(draft);
  if (!await confirmRelaunch(body)) return;
  try {
    await api.updatePreset(p.id, body);
    await loadPresets();
  } catch (e) {
    showAlert('❌ Пресет не збережено: ' + e.message);
    logLine('error', '❌ Пресет не збережено: ' + e.message);
    return;
  }
  activePresetId = p.id; storage.set('activePresetId', String(p.id));
  const d = await applyProfile(body, 'Пресет «' + p.name + '» оновлено');
  if (d && !d.launchError) { toast('Пресет «' + p.name + '» оновлено й застосовано.', { kind: 'ok' }); dlg.close(); }
}

// «➕ Зберегти як новий пресет»: створити з draft, зробити активним і застосувати.
async function createPreset() {
  if (busy) return;
  const name = await promptDialog({
    title: 'Новий пресет', label: 'Назва пресета', value: '⭐ Мій пресет', required: true, okText: 'Створити й застосувати',
    validate: (v) => (presets.some((p) => p.name === String(v).trim()) ? 'Пресет із такою назвою вже є' : ''),
  });
  if (!name || !name.trim()) return;
  const body = draftBody(draft);
  if (!await confirmRelaunch(body)) return;
  let r;
  try {
    r = await api.createPreset(name.trim(), body);
    await loadPresets();
  } catch (e) {
    showAlert('❌ Пресет не створено: ' + e.message);
    logLine('error', '❌ Пресет не створено: ' + e.message);
    return;
  }
  if (r && r.id) { activePresetId = r.id; storage.set('activePresetId', String(r.id)); }
  const d = await applyProfile(body, 'Пресет «' + name.trim() + '» створено');
  if (d && !d.launchError) { toast('Створено пресет «' + name.trim() + '».', { kind: 'ok' }); dlg.close(); }
}

// Перед ▶ Старт: НІЧОГО не застосовуємо (раніше тут мовчки поверталися зміни користувача).
// Лише повідомляємо, на якому конфігу піде прогін; розбіжність із запамʼятованим
// пресетом — попередження в лог і «● змінено» на чипі. → рядок для логу.
export async function ensureCurrentPreset() {
  try {
    await loadPresets();
    const prof = await api.getProfile();
    const st = configStatus(prof, presets, savedPresetId());
    renderChip(st);
    if (st.mode === 'changed') {
      logLine('warn', '⚠️ Конфіг відрізняється від пресета «' + st.presetName + '» — прогін піде на ПОТОЧНОМУ конфігу. ' +
        'Щоб повернути пресет, обери його в ⚙ Конфігураторі.');
      return st.presetName + ' ● змінено (поточний конфіг)';
    }
    return st.mode === 'preset' ? st.presetName : st.mode === 'custom' ? 'кастом' : st.engine;
  } catch (_e) { return '—'; }
}

export async function syncFingerprint() {
  try {
    const prof = await api.getProfile();
    if (prof.fingerprint) { updateHeaderChip(prof); return false; }
    if (!presets.length) await loadPresets();
    const active = presets.find((x) => x.id === savedPresetId()) || null;
    if (!shouldAutoCapture(prof, active)) { updateHeaderChip(prof); return false; }
    const d = await api.postProfile({ fingerprint: captureFingerprint() });
    logLine('fp', '🧬 Fingerprint захоплено з цього браузера (у профілі його не було).');
    updateHeaderChip(d);
    return true;
  } catch (e) {
    logLine('warn', '⚠️ Профіль недоступний: ' + e.message);
    renderChip(null);
    return false;
  }
}

const CHIP_HINT = {
  preset: 'Активний пресет',
  changed: 'Конфіг змінено відносно пресета (не застосовано мовчки)',
  custom: 'Кастомний конфіг (жоден пресет не збігається)',
  none: 'Пресетів немає (БД недоступна)',
};

function renderChip(st) {
  const chip = $('hdrConfigChip');
  if (!chip) return;
  clear(chip);
  if (!st) { chip.textContent = '⚙ —'; chip.dataset.mode = 'error'; return; }
  chip.dataset.mode = st.mode;
  chip.classList.toggle('custom', st.mode === 'custom' || st.mode === 'changed');
  // '🧩 Chromium' → іконка + назва (на вузькому екрані лишається тільки іконка).
  const sp = st.engine.indexOf(' ');
  chip.appendChild(h('span', { class: 'chip-eng' },
    h('span', { class: 'chip-eng-ico', 'aria-hidden': 'true', text: sp > 0 ? st.engine.slice(0, sp) : '' }),
    h('span', { class: 'chip-eng-name', text: sp > 0 ? st.engine.slice(sp) : st.engine })));
  if (st.mode !== 'none') {
    chip.appendChild(h('span', { class: 'chip-sep', 'aria-hidden': 'true', text: '·' }));
    chip.appendChild(h('span', { class: 'chip-preset', text: st.mode === 'custom' ? 'кастом' : st.presetName }));
  }
  if (st.mode === 'changed') chip.appendChild(h('span', { class: 'chip-badge' }, '●', h('span', { class: 'chip-badge-text', text: ' змінено' })));
  const label = 'Активний конфіг: ' + st.text + '. ' + CHIP_HINT[st.mode] + '. Відкрити конфігуратор';
  chip.title = label;
  chip.setAttribute('aria-label', label);
}

export async function updateHeaderChip(profile) {
  try {
    const prof = profile || await api.getProfile();
    if (!presets.length) await loadPresets();
    renderChip(configStatus(prof, presets, savedPresetId()));
  } catch (_e) { renderChip(null); }
}
