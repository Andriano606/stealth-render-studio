// transfer.js — експорт/імпорт ПРЕСЕТІВ і СЦЕНАРІЇВ (файл-бандл JSON, формат — lib/transfer.js).
//   initTransfer()            — кнопки хедера #importBtn / #exportBtn (увесь застосунок: усі пресети +
//                               усі сценарії), події 'ui:export' / 'ui:import'
//                               (їх шлють конфігуратор і меню ⋯ сценарію);
//   openExportDialog(opts)    — «📤 Експорт»: чекбокси пресетів (/presets) і сценаріїв (state.pages),
//                               «Включити файли кроків (N)» → GET /export (<a download>, як експорт конфігу);
//   openImportDialog()        — «📥 Імпорт»: файл (вибір або drag&drop) → parseBundle → прев'ю з планом
//                               (planImport проти поточних /presets і state.pages, миттєво при зміні
//                               стратегії) → завантаження вкладених файлів (/upload) + remap → POST /import;
//   exportPage(page)          — «📤 Експортувати сценарій» з меню ⋯ (одразу, без діалогу).
// Сервер АВТОРИТЕТНО перебудовує план (стан міг змінитися) — після імпорту показуємо ЙОГО звіт.
// Чиста логіка (exportHref, exportState, planPreview, planChip, fileStatus, uploadTargets, applyFileMap,
// buildImportRequest, importedFocusId, reportLines, base64ToBytes, selectionState, flushProblem,
// importMayHaveWritten, presetsTouched, importSnapshot, secretTextSteps) — без DOM, тести
// у test/transfer.ui.test.js. Логіку бандла НЕ дублюємо — усе з ../../lib/transfer.js.
import { $, h, clear } from './dom.js';
import { state, on, emit, isBusy } from './state.js';
import { api } from './api.js';
import { logLine } from './log.js';
import { toast } from './dialogs.js';
import { flushAllPages, flushPage, persistStatus } from './persist.js';
import { loadPages, focusPageCard } from './scenarios.js';
import {
  parseBundle, planImport, collectFileRefs, remapFileRefs, summarizeImport, CONFLICT_STRATEGIES, bundleProxyPublic,
} from '../../lib/transfer.js';
import { proxyLabel } from '../../lib/proxy.js';

// Файл імпорту, більший за це, навіть не читаємо (вкладені файли кроків — до 50 МБ у base64 ≈ 67 МБ).
export const IMPORT_FILE_MAX = 100 * 1024 * 1024;

export const STRATEGY_LABELS = Object.freeze({
  rename: 'Перейменувати (рекомендовано)',
  replace: 'Замінити існуючий',
  skip: 'Пропустити',
});

// ---------- Чиста логіка ----------

// sel: 'all' | масив id | null/[] (нічого). → значення параметра запиту.
function idsParam(sel) {
  if (sel === 'all') return 'all';
  return (Array.isArray(sel) ? sel : []).map((x) => String(x)).filter(Boolean).join(',');
}

// URL GET /export. Усі параметри є завжди (порожній = нічого цього виду; proxy=1 — додати проксі цілим).
export function exportHref({ presets, pages, files = true, proxy = false } = {}) {
  const q = new URLSearchParams();
  q.set('presets', idsParam(presets));
  q.set('pages', idsParam(pages));
  q.set('files', files ? '1' : '0');
  q.set('proxy', proxy ? '1' : '0');
  return '/export?' + q.toString();
}

// Вибір → параметр: усе вибране (і список не порожній) → 'all', інакше масив id у порядку списку.
export function selectionParam(allIds, selected) {
  const ids = (allIds || []).filter((id) => selected.has(id));
  if (ids.length && ids.length === (allIds || []).length) return 'all';
  return ids;
}

// Стан «усі/жодного» блоку: 'all' | 'none' | 'some' (для aria-checked='mixed').
export function selectionState(allIds, selected) {
  const n = (allIds || []).filter((id) => selected.has(id)).length;
  if (!n) return 'none';
  return n === (allIds || []).length ? 'all' : 'some';
}

// Кнопка «📤 Завантажити»: вимкнена з поясненням, якщо нічого не вибрано.
export function exportState({ presets = 0, pages = 0, files = 0, includeFiles = true, proxy = false } = {}) {
  if (!presets && !pages && !proxy) return { disabled: true, reason: 'Вибери хоча б один пресет, сценарій або проксі.' };
  const parts = [];
  if (presets) parts.push('пресетів: ' + presets);
  if (pages) parts.push('сценаріїв: ' + pages);
  if (pages && files) parts.push(includeFiles ? 'файлів: ' + files : 'без файлів кроків');
  if (proxy) parts.push('проксі (з логіном і паролем)');
  return { disabled: false, reason: 'У файл піде — ' + parts.join(', ') + '.' };
}

// Скільки файлів кроків у вибраних сценаріях (unique за fileId).
export function countPageFiles(pages, selected) {
  return collectFileRefs((pages || []).filter((p) => selected.has(p.id))).length;
}

// Чип статусу елемента прев'ю: {cls, text, title}.
export function planChip(item, { kind = 'scenarios', presetsDb = true, selected = true } = {}) {
  if (!selected) return { cls: 'off', text: 'не вибрано', title: 'Не імпортується' };
  if (kind === 'proxy') {
    if (!item) return { cls: 'off', text: '—', title: '' };
    if (item.reason === 'identical') return { cls: 'same', text: '= такий самий — без змін', title: 'Поточний проксі вже такий (сервер, логін, bypass, тумблер)' };
    if (item.action === 'replace') return { cls: 'replace', text: 'замінить поточний проксі', title: 'Проксі буде замінено цілком (з логіном і паролем) — перезапуск браузера' };
    return { cls: 'new', text: 'новий (зараз без проксі)', title: 'Проксі буде налаштовано — перезапуск браузера' };
  }
  if (kind === 'presets' && !presetsDb) return { cls: 'skip', text: 'БД недоступна — пропуск', title: 'Пресети зберігаються лише в БД' };
  if (!item) return { cls: 'off', text: '—', title: '' };
  const what = kind === 'presets' ? 'пресет' : 'сценарій';
  if (item.action === 'skip' && item.reason === 'identical') {
    return { cls: 'same', text: '= такий самий є — пропуск', title: 'Такий самий ' + what + ' (назва і зміст) уже є — дубліката не буде' };
  }
  if (item.action === 'skip') return { cls: 'skip', text: 'пропуск', title: what[0].toUpperCase() + what.slice(1) + ' з такою назвою вже є — стратегія «Пропустити»' };
  if (item.action === 'replace') return { cls: 'replace', text: 'замінить існуючий', title: 'Існуючий ' + what + ' «' + item.name + '» буде перезаписано' };
  if (item.action === 'create' && item.reason === 'duplicate_in_bundle') {
    return { cls: 'rename', text: 'дубль у файлі → «' + item.name + '»', title: 'У файлі кілька елементів з однаковою назвою — цей отримає нову назву' };
  }
  if (item.action === 'create' && item.reason === 'renamed') {
    return { cls: 'rename', text: 'конфлікт назви → «' + item.name + '»', title: what[0].toUpperCase() + what.slice(1) + ' з такою назвою вже є (інший зміст) — імпортується під новою назвою' };
  }
  return { cls: 'new', text: 'новий', title: 'Буде створено' };
}

// Прев'ю імпорту. План будується ЛИШЕ для вибраних елементів (як на сервері: select → planImport).
//   bundle — з parseBundle; existingPresets — з /presets; existingPages — state.pages;
//   selected: {presets: Set<index>, scenarios: Set<index>}; onConflict: {presets, scenarios}.
// → {presets: [row], scenarios: [row], counts, canImport, reason}
//   row: {index, name, selected, plan, chip}
// Підпис проксі в діалогах експорту/імпорту: адреса (+ логін), стан тумблера — окремо. Без пароля.
export function proxyTitle(px) {
  if (!px || !px.server) return '—';
  // publicProxy (діалог експорту) пароля не має — лише hasPassword.
  const withPw = { ...px, password: px.password || (px.hasPassword ? '•' : ''), enabled: true };
  return proxyLabel(withPw) + (px.enabled === false ? ' · тумблер вимкнено' : '');
}

// Проксі з файлу проти поточного (на клієнті пароля немає — порівнюємо publicProxy; сервер перевіряє
// повністю, з паролем). → plan-item або null (у файлі проксі немає).
export function planProxyPreview(bundleProxy, currentPublic) {
  const inc = bundleProxyPublic(bundleProxy);
  if (!inc) return null;
  if (stableJsonLocal(inc) === stableJsonLocal(currentPublic || null)) return { action: 'skip', reason: 'identical' };
  return currentPublic && currentPublic.server ? { action: 'replace', reason: 'replaced' } : { action: 'create', reason: 'new' };
}
const stableJsonLocal = (v) => JSON.stringify(v && typeof v === 'object' ? Object.keys(v).sort().reduce((a, k) => { a[k] = v[k]; return a; }, {}) : v);

export function planPreview({ bundle, existingPresets = [], existingPages = [], selected, onConflict = {}, presetsDb = true, currentProxy = null }) {
  const b = bundle || { presets: [], scenarios: [] };
  const sel = selected || { presets: new Set(), scenarios: new Set() };
  const one = (kind, items, existing) => {
    const idx = items.map((_x, i) => i).filter((i) => sel[kind].has(i));
    const usable = kind === 'presets' && !presetsDb ? [] : idx;
    const plan = planImport(existing, usable.map((i) => items[i]), { onConflict: onConflict[kind] || 'rename', kind });
    const byIndex = new Map(plan.map((p) => [usable[p.index], { ...p, index: usable[p.index] }]));
    return items.map((it, i) => {
      const p = byIndex.get(i) || null;
      const isSel = sel[kind].has(i);
      return { index: i, name: it.name, selected: isSel, plan: p, chip: planChip(p, { kind, presetsDb, selected: isSel }) };
    });
  };
  const presets = one('presets', b.presets || [], existingPresets);
  const scenarios = one('scenarios', b.scenarios || [], existingPages);
  let proxy = null;
  if (b.proxy) {
    const isSel = !!sel.proxy;
    const plan = planProxyPreview(b.proxy, currentProxy);
    proxy = { label: proxyTitle(b.proxy), hasPassword: !!b.proxy.password, selected: isSel, plan, chip: planChip(plan, { kind: 'proxy', selected: isSel }) };
  }
  const counts = { create: 0, replace: 0, skip: 0 };
  for (const r of [...presets, ...scenarios, ...(proxy ? [proxy] : [])]) {
    if (!r.selected) continue;
    const a = r.plan ? r.plan.action : 'skip';
    counts[a] = (counts[a] || 0) + 1;
  }
  const todo = counts.create + counts.replace;
  let reason = '';
  if (!presets.some((r) => r.selected) && !scenarios.some((r) => r.selected) && !(proxy && proxy.selected)) reason = 'Вибери хоча б один пресет, сценарій або проксі.';
  else if (!todo) reason = 'Нічого імпортувати: усе вибране вже є або пропускається.';
  else {
    const p = [];
    if (counts.create) p.push('нових: ' + counts.create);
    if (counts.replace) p.push('замін: ' + counts.replace);
    if (counts.skip) p.push('пропусків: ' + counts.skip);
    reason = 'Буде ' + p.join(', ') + '.';
  }
  return { presets, scenarios, proxy, counts, canImport: todo > 0, reason };
}

// Індекси сценаріїв, для яких треба завантажити й підмінити файли: вибрані й НЕ пропущені.
// (Пропущений «такий самий» сценарій лишаємо з оригінальними fileId — інакше сервер не впізнав
// би його як однаковий і створив би дубль.)
export function uploadTargets(preview) {
  return (preview ? preview.scenarios : []).filter((r) => r.selected && r.plan && r.plan.action !== 'skip').map((r) => r.index);
}

// Файли кроків вибраних сценаріїв: upload — з вмістом (вкладені), missing — потребуватимуть перевибору.
//   missing[].why: 'too_large' | 'missing' | 'not_included'.
export function fileStatus(bundle, scenarioIdx) {
  const b = bundle || {};
  const pick = (scenarioIdx || []).map((i) => (b.scenarios || [])[i]).filter(Boolean);
  const refs = collectFileRefs(pick);
  const byId = new Map((b.files || []).map((f) => [f.fileId, f]));
  const upload = [], missing = [];
  for (const r of refs) {
    const f = byId.get(r.fileId);
    if (f && typeof f.data === 'string' && f.data) upload.push({ fileId: r.fileId, filename: f.filename || r.filename || 'file', size: f.size || 0, data: f.data });
    else missing.push({ fileId: r.fileId, filename: (f && f.filename) || r.filename || r.fileId, why: f && f.skipped === 'too_large' ? 'too_large' : f && f.missing ? 'missing' : 'not_included' });
  }
  return { upload, missing };
}

const WHY = { too_large: 'завеликий, не вкладено', missing: 'не знайдено під час експорту', not_included: 'не вкладено у файл' };
export function missingFileText(m) {
  return 'Файл «' + m.filename + '» ' + (WHY[m.why] || WHY.not_included) + ' — крок файлу потребуватиме перевибору файлу.';
}

// Підміна fileId лише в сценаріях з індексами idx (решта — як є).
export function applyFileMap(scenarios, map, idx) {
  const set = new Set(idx || []);
  return (scenarios || []).map((s, i) => (set.has(i) ? remapFileRefs([s], map)[0] : s));
}

// Тіло POST /import: бандл БЕЗ files[] (файли вже завантажено через /upload і підмінено; сервер сам
// попереджає про відсутні файли — лише для сценаріїв, що імпортуються, з назвою сценарію. Записи
// files[] з missing/skipped лише дублювали б ці попередження і ще й для НЕвибраних сценаріїв).
export function buildImportRequest({ bundle, selected, onConflict, fileMap = {}, remapIdx = [], dryRun = false }) {
  const b = bundle || {};
  const sortIdx = (s) => [...(s || [])].sort((x, y) => x - y);
  const out = {
    bundle: {
      format: b.format, version: b.version, exportedAt: b.exportedAt,
      presets: b.presets || [],
      scenarios: applyFileMap(b.scenarios || [], fileMap, remapIdx),
      files: [],
    },
    select: { presets: sortIdx(selected && selected.presets), scenarios: sortIdx(selected && selected.scenarios), proxy: !!(selected && selected.proxy) },
    onConflict: {
      presets: CONFLICT_STRATEGIES.includes(onConflict && onConflict.presets) ? onConflict.presets : 'rename',
      scenarios: CONFLICT_STRATEGIES.includes(onConflict && onConflict.scenarios) ? onConflict.scenarios : 'rename',
    },
  };
  if (b.proxy) out.bundle.proxy = b.proxy;
  if (dryRun) out.dryRun = true;
  return out;
}

// Куди поставити фокус після імпорту: id першого створеного/заміненого сценарію або null.
export function importedFocusId(report) {
  const it = ((report && report.scenarios) || []).find((x) => (x.action === 'create' || x.action === 'replace') && x.id != null);
  return it ? it.id : null;
}

// Рядки логу по кожному елементу звіту сервера.
export function reportLines(report) {
  const out = [];
  const one = (items, what) => {
    for (const it of items || []) {
      const orig = it.originalName != null ? String(it.originalName) : it.name;
      if (it.action === 'create') out.push(what + ' «' + it.name + '» створено' + (it.name !== orig ? ' (у файлі — «' + orig + '», назва була зайнята)' : ''));
      else if (it.action === 'replace') out.push(what + ' «' + it.name + '» замінено');
      else if (it.reason === 'identical') out.push(what + ' «' + orig + '» пропущено — такий самий уже є');
      else if (it.reason === 'no_db') out.push(what + ' «' + orig + '» не імпортовано — БД недоступна');
      else out.push(what + ' «' + orig + '» пропущено (назва зайнята)');
    }
  };
  one(report && report.presets, 'Пресет');
  one(report && report.scenarios, 'Сценарій');
  const px = report && report.proxy;
  if (px) {
    const lbl = px.label ? ' ' + px.label : '';
    if (px.action === 'create' || px.action === 'replace') out.push('Проксі' + lbl + ' застосовано' + (px.relaunched ? ' (браузер перезапущено)' : ''));
    else if (px.reason === 'identical') out.push('Проксі' + lbl + ' — такий самий, без змін');
    else if (px.reason === 'not_selected') out.push('Проксі з файлу не імпортовано (не вибрано)');
    else out.push('Проксі з файлу не імпортовано');
  }
  return out;
}

// Після flushAllPages: чи лишились НЕзбережені зміни (PUT /pages падає — 413 на великому сценарії, 5xx…).
// → текст проблеми або null. Імпорт тоді не починаємо: loadPages() після нього замінив би локальні
// правки серверною версією, а повтор із черги persist мовчки переPUTив би вже її.
export function flushProblem(st) {
  if (!st || !st.failed) return null;
  const msg = st.lastError && st.lastError.message ? ' (' + st.lastError.message + ')' : '';
  return 'Не вдалося зберегти поточні зміни сценаріїв: ' + countText(st.failed, ['сценарій', 'сценарії', 'сценаріїв']) + msg + '.';
}

// Помилка POST /import: чи міг сервер уже щось записати? 4xx — ні (валідація до запису);
// 5xx, мережа, таймаут клієнта (сервер дописує далі) — так → треба перечитати стан.
export function importMayHaveWritten(err) {
  const st = err && Number(err.status);
  return !(st >= 400 && st < 500);
}

// Чи змінились пресети (звіт сервера): є create/replace → перечитати конфігуратор і чип.
export function presetsTouched(report) {
  return ((report && report.presets) || []).some((x) => x && (x.action === 'create' || x.action === 'replace'));
}

// Знімок вибору і стратегій на момент старту імпорту (UI під час роботи на них уже не впливає).
export function importSnapshot(selected, onConflict) {
  const sel = selected || {};
  return {
    selected: { presets: new Set(sel.presets || []), scenarios: new Set(sel.scenarios || []), proxy: !!sel.proxy },
    onConflict: { ...(onConflict || {}) },
  };
}

// Текстові кроки, схожі на введення пароля (за ціллю: локатори/опис/CSS містять password/пароль).
// Тип поля в цілі не зберігається, тож це евристика для попередження в діалозі експорту.
// → [{page, rec, index}] (index — номер кроку в Дії, з 1).
const SECRET_RE = /password|passwd|\bpass\b|пароль|secret|секрет/i;
export function secretTextSteps(pages) {
  const out = [];
  for (const p of pages || []) {
    for (const r of (p && Array.isArray(p.recs) ? p.recs : [])) {
      (r && Array.isArray(r.subs) ? r.subs : []).forEach((x, i) => {
        if (!x || x.type !== 'text' || !x.target) return;
        const locs = Array.isArray(x.target.locs) ? x.target.locs : [];
        const hay = [x.target.desc, ...locs.flatMap((l) => (l && typeof l === 'object' ? Object.values(l) : []))]
          .filter((v) => typeof v === 'string').join(' ');
        if (SECRET_RE.test(hay)) out.push({ page: p.name, rec: r.name, index: i + 1 });
      });
    }
  }
  return out;
}

// base64 → Uint8Array (atob є і в браузері, і в Node 20).
export function base64ToBytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const plural = (n, forms) => {
  const m10 = n % 10, m100 = n % 100;
  return forms[m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2];
};
export const countText = (n, forms) => n + ' ' + plural(n, forms);
const stepsOf = (s) => (s.recs || []).reduce((a, r) => a + ((r.subs || []).length), 0);
const engineOf = (body) => {
  if (!body) return '';
  if (body.clear) return 'голий Playwright';
  const e = body.launch && body.launch.engine;
  return e === 'camoufox' ? '🦊 Camoufox' : e === 'chromium' ? '🧩 Chromium' : '';
};

// ---------- DOM ----------
let seq = 0;

function download(href) {
  const a = h('a', { href, download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}

// Модалка зі спільною поведінкою: Esc/✕/фон закривають (якщо не locked()), фокус — на opener.
// Під час locked() діалог не закривається навіть подвійним Esc (Chrome CloseWatcher шле
// нескасовний cancel) — відкриваємо його знову. Файл, кинутий будь-куди в діалог, браузер не
// відкриває (інакше застосунок вивантажився б); onDropFile(file) — якщо задано.
function modal({ title, cls, locked = () => false, onDropFile = null }) {
  const id = 'tr' + (++seq);
  const opener = document.activeElement;
  const openerId = opener && opener.id;
  const dlg = h('dialog', { class: 'modal tr-modal ' + (cls || ''), 'aria-labelledby': id + '_t' });
  const body = h('div', { class: 'dlg-body tr-body' });
  const foot = h('div', { class: 'modal-foot tr-foot' });
  const close = () => { if (!locked()) dlg.close(); };
  dlg.append(h('div', { class: 'modal-inner' },
    h('div', { class: 'modal-head' },
      h('h2', { id: id + '_t', text: title }),
      h('button', { type: 'button', class: 'x', 'aria-label': 'Закрити', text: '✕', on: { click: close } })),
    body, foot));
  dlg.addEventListener('cancel', (e) => { if (locked()) e.preventDefault(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('dragover', (e) => e.preventDefault());
  dlg.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && onDropFile && !locked()) onDropFile(f);
  });
  let focusAfter = null;
  const closed = [];
  dlg.addEventListener('close', () => {
    if (locked() && dlg.isConnected) { dlg.showModal(); return; }
    for (const fn of closed) { try { fn(); } catch (_e) { /* обробник не ламає закриття */ } }
    dlg.remove();
    let t = typeof focusAfter === 'function' ? focusAfter() : null;
    if (!t) t = opener && document.contains(opener) ? opener : (openerId ? $(openerId) : null);
    if (t && typeof t.focus === 'function') t.focus();
  });
  ($('dialogs') || document.body).appendChild(dlg);
  dlg.showModal();
  return { dlg, body, foot, id, setFocusAfter(fn) { focusAfter = fn; }, onClose(fn) { closed.push(fn); } };
}

// Блок списку з чекбоксами й «усі/жодного». items: [{key, label, meta, chip?}].
function checkList({ id, title, items, selected, onChange, empty, chipFor }) {
  const allKeys = items.map((x) => x.key);
  const st = selectionState(allKeys, selected);
  const box = h('fieldset', { class: 'tr-block', id });
  box.appendChild(h('legend', { class: 'tr-legend' }, title,
    items.length ? h('span', { class: 'tr-count', text: ' · ' + allKeys.filter((k) => selected.has(k)).length + '/' + items.length }) : null));
  if (!items.length) { box.appendChild(h('p', { class: 'tr-empty', text: empty })); return box; }
  const all = h('input', { type: 'checkbox', id: id + '_all', checked: st === 'all' });
  all.indeterminate = st === 'some';
  all.addEventListener('change', () => {
    if (st === 'all') selected.clear(); else for (const k of allKeys) selected.add(k);
    onChange(id + '_all');
  });
  box.appendChild(h('label', { class: 'tr-item tr-all', for: id + '_all' }, all, h('span', { text: 'усі / жодного' })));
  const ul = h('ul', { class: 'tr-list' });
  items.forEach((it, i) => {
    const cid = id + '_' + i;
    const cb = h('input', { type: 'checkbox', id: cid, checked: selected.has(it.key) });
    cb.addEventListener('change', () => { if (cb.checked) selected.add(it.key); else selected.delete(it.key); onChange(cid); });
    const chip = chipFor ? chipFor(it) : null;
    ul.appendChild(h('li', null, h('label', { class: 'tr-item', for: cid }, cb,
      h('span', { class: 'tr-name' }, h('span', { class: 'tr-title', text: it.label }), it.meta ? h('span', { class: 'tr-meta', text: it.meta }) : null),
      chip ? h('span', { class: 'tr-chip ' + chip.cls, title: chip.title, text: chip.text }) : null)));
  });
  box.appendChild(ul);
  return box;
}

// Після перерендеру — повернути фокус на той самий контрол (за id), без прокрутки (позицію
// відновлює keepScroll).
function refocus(fid) { if (!fid) return; const el = $(fid); if (el) el.focus({ preventScroll: true }); }

// Перерендер списків (clear + нові .tr-list) скидав прокрутку на верх — запамʼятати і відновити:
// .tr-list за id блоку (fieldset) і саму прокрутну область діалогу.
function keepScroll(root, rerender) {
  const lists = new Map();
  for (const el of root.querySelectorAll('.tr-block')) {
    const ul = el.querySelector('.tr-list');
    if (el.id && ul) lists.set(el.id, ul.scrollTop);
  }
  const top = root.scrollTop;
  rerender();
  for (const [id, y] of lists) {
    const ul = root.querySelector('#' + CSS.escape(id) + ' .tr-list');
    if (ul) ul.scrollTop = y;
  }
  root.scrollTop = top;
}

// ---------- Експорт ----------
// opts.presets / opts.pages: 'all' | 'none' | масив id — що вибрано наперед.
export async function openExportDialog(opts = {}) {
  const { dlg, body, foot } = modal({ title: '📤 Експорт пресетів, сценаріїв і проксі', cls: 'tr-export' });
  body.appendChild(h('p', { class: 'tr-loading', text: 'завантаження…' }));
  await flushAllPages(); // сервер віддає збережене — спершу дописуємо чергу (збій перевіряє кнопка)
  let presets = [], presetsDb = true;
  try { const d = await api.getPresets(); presets = d.presets || []; presetsDb = d.db !== false; } catch (_e) { presets = []; }
  let proxyPub = null; // проксі профілю (без пароля — лише hasPassword); у файл піде з паролем (сервер)
  try { const prof = await api.getProfile(); proxyPub = prof.proxy || null; } catch (_e) { proxyPub = null; }
  if (!dlg.open) return;
  let includeProxy = opts.proxy === true && !!proxyPub;
  const pages = state.pages.slice();
  const pre = (v, ids) => new Set(v === 'none' ? [] : Array.isArray(v) ? ids.filter((x) => v.includes(x)) : ids);
  const selP = pre(opts.presets, presets.map((p) => p.id));
  const selS = pre(opts.pages, pages.map((p) => p.id));
  let includeFiles = opts.files !== false;

  const btn = h('button', { type: 'button', class: 'btn btn-primary', id: 'trExportGo', text: '📤 Завантажити' });
  const hint = h('span', { class: 'tr-hint', id: 'trExportHint', 'aria-live': 'polite' });
  btn.setAttribute('aria-describedby', 'trExportHint');
  foot.append(hint,
    h('button', { type: 'button', class: 'btn btn-ghost', text: 'Скасувати', on: { click: () => dlg.close() } }),
    btn);

  const render = (fid) => keepScroll(body, () => renderNow(fid));
  const renderNow = (fid) => {
    clear(body);
    body.appendChild(h('p', { class: 'dlg-msg', text: 'Файл .json можна імпортувати на іншій машині (📥). Конфіг браузера (поза пресетами) і cookies не експортуються; проксі — окремим пунктом нижче. Текст кроків (зокрема введені паролі) потрапляє у файл як є.' }));
    const secret = secretTextSteps(pages.filter((p) => selS.has(p.id)));
    if (secret.length) {
      body.appendChild(h('p', { class: 'tr-warns', role: 'note', text: '⚠ Схоже, у вибраних сценаріях є введення пароля (' + secret.slice(0, 3).map((x) => '«' + x.page + '» · «' + x.rec + '», крок ' + x.index).join('; ') + (secret.length > 3 ? '…' : '') + ') — цей текст буде у файлі відкритим текстом.' }));
    }
    body.appendChild(checkList({
      id: 'trExP', title: 'Пресети', selected: selP, onChange: render,
      empty: presetsDb ? 'Пресетів немає.' : 'БД недоступна — пресетів немає, експортувати нічого.',
      items: presets.map((p) => ({ key: p.id, label: p.name, meta: [engineOf(p.body), p.builtin ? 'вбудований' : ''].filter(Boolean).join(' · ') })),
    }));
    body.appendChild(checkList({
      id: 'trExS', title: 'Сценарії', selected: selS, onChange: render,
      empty: 'Сценаріїв немає.',
      items: pages.map((p) => ({ key: p.id, label: p.name, meta: countText(p.recs.length, ['Дія', 'Дії', 'Дій']) + ' · ' + p.url })),
    }));
    const nFiles = countPageFiles(pages, selS);
    const fcb = h('input', { type: 'checkbox', id: 'trExFiles', checked: includeFiles && nFiles > 0, disabled: !nFiles });
    fcb.addEventListener('change', () => { includeFiles = fcb.checked; render('trExFiles'); });
    body.appendChild(h('label', { class: 'tr-item tr-files', for: 'trExFiles' }, fcb,
      h('span', null, 'Включити файли кроків ', h('span', { class: 'tr-meta', text: nFiles ? '(' + countText(nFiles, ['файл', 'файли', 'файлів']) + ', base64, до 50 МБ сумарно)' : '(у вибраних сценаріях немає кроків-файлів)' }))));
    // Проксі — незалежно від пресетів: окремий пункт, усі налаштування з логіном і паролем.
    const pxBox = h('fieldset', { class: 'tr-block', id: 'trExProxy' }, h('legend', { class: 'tr-legend', text: '🔀 Проксі' }));
    if (proxyPub) {
      const pcb = h('input', { type: 'checkbox', id: 'trExProxyCb', checked: includeProxy });
      pcb.addEventListener('change', () => { includeProxy = pcb.checked; render('trExProxyCb'); });
      pxBox.appendChild(h('label', { class: 'tr-item', for: 'trExProxyCb' }, pcb,
        h('span', { class: 'tr-name' }, h('span', { class: 'tr-title', text: 'Включити проксі' }),
          h('span', { class: 'tr-meta', text: proxyTitle(proxyPub) + ' · незалежно від пресетів, разом із логіном і паролем' }))));
      if (includeProxy && proxyPub.hasPassword) {
        pxBox.appendChild(h('p', { class: 'tr-warns', role: 'note', text: '⚠ Пароль проксі буде у файлі відкритим текстом — не пересилай файл стороннім.' }));
      }
    } else {
      pxBox.appendChild(h('p', { class: 'tr-empty', text: 'Проксі не налаштовано (⚙ → 🔀 Проксі).' }));
    }
    body.appendChild(pxBox);
    const st = exportState({ presets: selP.size, pages: selS.size, files: nFiles, includeFiles: includeFiles && nFiles > 0, proxy: includeProxy });
    btn.disabled = st.disabled;
    hint.textContent = st.reason;
    hint.classList.toggle('warn', st.disabled);
    refocus(fid);
  };
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    await flushAllPages();
    const problem = flushProblem(persistStatus());
    const href = exportHref({
      presets: selectionParam(presets.map((p) => p.id), selP),
      pages: selectionParam(pages.map((p) => p.id), selS),
      files: includeFiles,
      proxy: includeProxy,
    });
    download(href);
    const what = [selP.size ? countText(selP.size, ['пресет', 'пресети', 'пресетів']) : '', selS.size ? countText(selS.size, ['сценарій', 'сценарії', 'сценаріїв']) : '', includeProxy ? 'проксі' : ''].filter(Boolean).join(' і ');
    logLine('info', '📤 Експорт: ' + what + (selS.size ? (includeFiles ? ' (з файлами кроків)' : ' (без файлів кроків)') : '') + ' → .json');
    if (problem) {
      logLine('warn', '⚠️ ' + problem + ' У файлі — остання ЗБЕРЕЖЕНА версія сценаріїв.');
      toast('Експорт завантажується: ' + what + '. ⚠ ' + problem + ' У файлі — остання збережена версія.', { kind: 'warn', timeout: 10000 });
    } else {
      toast('Експорт завантажується: ' + what + '.', { kind: 'ok' });
    }
    dlg.close();
  });
  render();
  const first = body.querySelector('input:not(:disabled)') || btn;
  if (first) first.focus();
}

// «📤 Експортувати сценарій» з меню ⋯ — одразу файл (сценарій + його файли, без пресетів).
export async function exportPage(page) {
  if (!page) return;
  const saved = await flushPage(page);
  download(exportHref({ presets: [], pages: [page.id], files: true }));
  logLine('info', '📤 Експорт сценарію «' + page.name + '» → .json');
  if (saved === false) {
    logLine('warn', '⚠️ Сценарій «' + page.name + '»: незбережені зміни не потрапили у файл — у ньому остання ЗБЕРЕЖЕНА версія.');
    toast('Експорт сценарію «' + page.name + '» завантажується. ⚠ Останні зміни не збережено — у файлі остання збережена версія.', { kind: 'warn', timeout: 10000 });
  } else {
    toast('Експорт сценарію «' + page.name + '» завантажується.', { kind: 'ok' });
  }
}

// ---------- Імпорт ----------
export async function openImportDialog() {
  let working = false;
  let loadFile = null;
  const { dlg, body, foot, setFocusAfter, onClose } = modal({
    title: '📥 Імпорт пресетів, сценаріїв і проксі', cls: 'tr-import', locked: () => working, onDropFile: (f) => loadFile(f),
  });
  let parsed = null;          // {bundle, warnings, fileName}
  let existingPresets = [], presetsDb = true;
  let currentProxy = null;    // проксі профілю (publicProxy, без пароля) — для чипа прев'ю
  const selected = { presets: new Set(), scenarios: new Set(), proxy: false };
  const onConflict = { presets: 'rename', scenarios: 'rename' };
  let preview = null;
  let errorText = '';
  // Файли кроків, уже завантажені в цьому діалозі (оригінальний fileId → {fileId, filename}): повтор
  // після збою не вантажить їх знову з новими fileId (інакше «такий самий» сценарій став би копією).
  let uploaded = {};

  const goBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'trImportGo', text: '📥 Імпортувати', disabled: true });
  const hint = h('span', { class: 'tr-hint', id: 'trImportHint', 'aria-live': 'polite' });
  goBtn.setAttribute('aria-describedby', 'trImportHint');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Скасувати', on: { click: () => { if (!working) dlg.close(); } } });
  foot.append(hint, cancelBtn, goBtn);

  const fileInput = h('input', { type: 'file', id: 'trImportFile', accept: '.json,application/json', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const pickBtn = h('button', { type: 'button', class: 'btn btn-secondary', id: 'trImportPick', text: '📂 Обрати файл…', on: { click: () => fileInput.click() } });
  const drop = h('div', { class: 'tr-drop', id: 'trImportDrop' },
    h('span', { class: 'tr-drop-ico', 'aria-hidden': 'true', text: '📥' }),
    h('span', { class: 'tr-drop-text', text: 'Перетягни сюди файл stealth-bundle-….json або' }),
    pickBtn, fileInput);
  const alertEl = h('div', { class: 'tr-alert', role: 'alert' });
  const content = h('div', { class: 'tr-content' });
  body.append(drop, alertEl, content);

  const busyNow = () => isBusy();
  const renderFoot = () => {
    if (working) { goBtn.disabled = true; return; }
    if (!parsed) { goBtn.disabled = true; hint.textContent = 'Обери файл експорту (.json).'; hint.classList.remove('warn'); return; }
    if (busyNow()) { goBtn.disabled = true; hint.textContent = 'Іде прогін або запис — дочекайся завершення.'; hint.classList.add('warn'); return; }
    goBtn.disabled = !preview.canImport;
    hint.textContent = preview.reason;
    hint.classList.toggle('warn', !preview.canImport);
  };

  const strategyGroup = (kind, label) => {
    const name = 'trStrat_' + kind;
    return h('fieldset', { class: 'tr-strat' },
      h('legend', { text: label }),
      CONFLICT_STRATEGIES.map((s) => {
        const rid = name + '_' + s;
        const r = h('input', { type: 'radio', name, id: rid, value: s, checked: onConflict[kind] === s });
        r.addEventListener('change', () => { if (r.checked) { onConflict[kind] = s; render(rid); } });
        return h('label', { class: 'tr-radio', for: rid }, r, h('span', { text: STRATEGY_LABELS[s] }));
      }));
  };

  const render = (fid) => keepScroll(body, () => renderNow(fid));
  const renderNow = (fid) => {
    alertEl.textContent = errorText;
    alertEl.hidden = !errorText;
    clear(content);
    if (!parsed) { renderFoot(); refocus(fid); return; }
    const b = parsed.bundle;
    preview = planPreview({ bundle: b, existingPresets, existingPages: state.pages, selected, onConflict, presetsDb, currentProxy });
    content.appendChild(h('p', { class: 'tr-file' }, h('b', { text: parsed.fileName }),
      b.exportedAt ? ' · експортовано ' + new Date(b.exportedAt).toLocaleString('uk-UA') : null));

    // Попередження parseBundle про файли — для ВСІХ файлів бандла; показуємо натомість fileStatus —
    // лише для вибраних сценаріїв (інакше той самий файл згадувався б двічі).
    const warns = parsed.warnings.filter((w) => !/^Файл «/.test(w));
    const fs = fileStatus(b, [...selected.scenarios]);
    for (const m of fs.missing) warns.push(missingFileText(m));
    if (b.presets.length && !presetsDb) warns.push('БД недоступна — пресети не імпортуються (лише сценарії, у памʼять сервера).');
    if (warns.length) {
      content.appendChild(h('ul', { class: 'tr-warns', 'aria-label': 'Попередження' }, warns.map((w) => h('li', { text: '⚠ ' + w }))));
    }

    const byKind = (kind) => new Map(preview[kind].map((r) => [r.index, r]));
    if (b.presets.length) {
      const rows = byKind('presets');
      content.appendChild(checkList({
        id: 'trImP', title: 'Пресети', selected: selected.presets, onChange: render,
        items: b.presets.map((p, i) => ({ key: i, label: p.name, meta: engineOf(p.body) })),
        chipFor: (it) => rows.get(it.key).chip,
      }));
      if (presetsDb) content.appendChild(strategyGroup('presets', 'Якщо пресет з такою назвою вже є (і відрізняється):'));
    }
    if (b.scenarios.length) {
      const rows = byKind('scenarios');
      content.appendChild(checkList({
        id: 'trImS', title: 'Сценарії', selected: selected.scenarios, onChange: render,
        items: b.scenarios.map((s, i) => ({
          key: i, label: s.name,
          meta: countText(s.recs.length, ['Дія', 'Дії', 'Дій']) + ', ' + countText(stepsOf(s), ['крок', 'кроки', 'кроків']) + (s.url ? ' · ' + s.url : ''),
        })),
        chipFor: (it) => rows.get(it.key).chip,
      }));
      content.appendChild(strategyGroup('scenarios', 'Якщо сценарій з такою назвою вже є (і відрізняється):'));
    }
    if (preview.proxy) {
      const px = preview.proxy;
      const pcb = h('input', { type: 'checkbox', id: 'trImProxyCb', checked: px.selected });
      pcb.addEventListener('change', () => { selected.proxy = pcb.checked; render('trImProxyCb'); });
      content.appendChild(h('fieldset', { class: 'tr-block', id: 'trImProxy' },
        h('legend', { class: 'tr-legend', text: '🔀 Проксі' }),
        h('label', { class: 'tr-item', for: 'trImProxyCb' }, pcb,
          h('span', { class: 'tr-name' }, h('span', { class: 'tr-title', text: px.label }),
            h('span', { class: 'tr-meta', text: 'незалежно від пресетів · замінить проксі цілком' + (px.hasPassword ? ' (з логіном і паролем)' : '') + ' · перезапуск браузера' })),
          h('span', { class: 'tr-chip ' + px.chip.cls, title: px.chip.title, text: px.chip.text }))));
    }
    content.appendChild(h('p', { class: 'tr-note', text: 'Однакові (та сама назва і зміст) не дублюються. Сервер ще раз перевірить конфлікти під час імпорту — підсумок покаже, що зроблено насправді.' }));
    renderFoot();
    refocus(fid);
  };

  const refreshPresets = async () => {
    try { const d = await api.getPresets(); existingPresets = d.presets || []; presetsDb = d.db !== false; } catch (_e) { existingPresets = []; }
    try { const prof = await api.getProfile(); currentProxy = prof.proxy || null; } catch (_e) { currentProxy = null; }
  };

  loadFile = async (file) => {
    if (!file || working) return;
    errorText = ''; parsed = null; uploaded = {};
    if (file.size > IMPORT_FILE_MAX) {
      errorText = '❌ Файл завеликий (' + Math.round(file.size / 1048576) + ' МБ, максимум ' + Math.round(IMPORT_FILE_MAX / 1048576) + ' МБ).';
      render(); return;
    }
    let text;
    try { text = await file.text(); } catch (e) { errorText = '❌ Не вдалося прочитати файл: ' + e.message; render(); return; }
    const r = parseBundle(text);
    if (!r.ok) { errorText = '❌ ' + r.error; render(); return; }
    await refreshPresets();
    parsed = { bundle: r.bundle, warnings: r.warnings, fileName: file.name };
    selected.presets = new Set(r.bundle.presets.map((_x, i) => i));
    selected.scenarios = new Set(r.bundle.scenarios.map((_x, i) => i));
    selected.proxy = !!r.bundle.proxy;
    render();
    const first = content.querySelector('input:not(:disabled)');
    if (first) first.focus();
  };

  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; loadFile(f); });
  // drop ловить сам діалог (modal → onDropFile) — тут лише підсвітка зони.
  drop.addEventListener('dragover', () => drop.classList.add('over'));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', () => drop.classList.remove('over'));
  const offBusy = on('busy', () => { if (dlg.open) renderFoot(); });
  onClose(offBusy);

  goBtn.addEventListener('click', async () => {
    if (goBtn.disabled || working || !parsed || busyNow()) return;
    working = true;
    dlg.setAttribute('aria-busy', 'true');
    body.inert = true; // не лише pointer-events: клавіатура теж не змінює вибір/стратегію посеред імпорту
    renderFoot();
    cancelBtn.disabled = true;
    const say = (t) => { hint.textContent = t; hint.classList.remove('warn'); };
    const snap = importSnapshot(selected, onConflict);
    let res = null, sent = false;
    try {
      // Зміни сценаріїв, що ще в черзі збереження, мають потрапити на сервер ДО імпорту:
      // сервер будує план проти свого стану, а після імпорту список перечитується з нього.
      say('Зберігаю поточні зміни…');
      await flushAllPages();
      const problem = flushProblem(persistStatus());
      if (problem) throw new Error(problem + ' Спершу натисни «Не збережено · повторити» — інакше імпорт затер би ці зміни.');
      const b = parsed.bundle;
      const remapIdx = uploadTargets(preview);
      const { upload } = fileStatus(b, remapIdx);
      const fileMap = {};
      const fileWarns = [];
      for (let i = 0; i < upload.length; i++) {
        const f = upload[i];
        if (uploaded[f.fileId]) { fileMap[f.fileId] = uploaded[f.fileId]; continue; }
        say('Завантажую файли кроків ' + (i + 1) + '/' + upload.length + '…');
        try {
          const d = await api.upload(new File([base64ToBytes(f.data)], f.filename, { type: 'application/octet-stream' }));
          fileMap[f.fileId] = uploaded[f.fileId] = { fileId: d.fileId, filename: d.filename || f.filename };
        } catch (e) {
          fileWarns.push('Файл «' + f.filename + '» не завантажено (' + e.message + ') — крок файлу потребуватиме перевибору.');
        }
      }
      say('Імпортую…');
      sent = true;
      res = await api.importBundle(buildImportRequest({ bundle: b, selected: snap.selected, onConflict: snap.onConflict, fileMap, remapIdx }));
      const summary = res.summary || summarizeImport(res);
      logLine('info', '📥 ' + summary + ' (файл «' + parsed.fileName + '»)');
      for (const l of reportLines(res)) logLine('info', '   ' + l);
      // Про відсутні файли кроків (не вкладено / завеликі) попереджає сервер — по кожному сценарію;
      // причину (завеликий тощо) видно в прев'ю. Тут — лише збої завантаження з цього клієнта.
      const warns = [...(res.warnings || []), ...fileWarns];
      for (const w of warns) logLine('warn', '⚠️ ' + w);
      toast(summary + (warns.length ? ' Попереджень: ' + warns.length + ' (див. лог).' : ''), { kind: warns.length ? 'warn' : 'ok', timeout: 8000 });
    } catch (e) {
      errorText = '❌ Імпорт не вдався: ' + e.message;
      // Сервер міг уже записати (5xx / таймаут клієнта / мережа) — перечитати стан, щоб сайдбар і
      // прев'ю не трималися старих сценаріїв (пізніший PUT старого X затер би заміну).
      if (sent && importMayHaveWritten(e)) {
        errorText += ' Імпорт міг виконатися частково — список оновлено, перевір прев\'ю перед повтором.';
        await loadPages().catch(() => {});
        await refreshPresets();
        emit('presets:changed');
      }
      working = false;
      body.inert = false;
      dlg.removeAttribute('aria-busy');
      cancelBtn.disabled = false;
      logLine('error', errorText);
      if (!dlg.isConnected || !dlg.open) { toast(errorText, { kind: 'error', timeout: 10000 }); return; }
      render();
      alertEl.scrollIntoView && alertEl.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Оновити все, що могло змінитися: список сценаріїв (з сервера) і пресети (конфігуратор + чип —
    // лише якщо пресети справді змінились: зайвий renderAll конфігуратора скидає його прокрутку).
    await loadPages();
    if (presetsTouched(res)) emit('presets:changed');
    working = false;
    body.inert = false;
    const focusId = importedFocusId(res);
    // Фокус: перший імпортований сценарій; якщо під діалогом ще відкрита модалка (конфігуратор) —
    // повертаємось на кнопку, з якої відкрили (сайдбар під модалкою недосяжний).
    setFocusAfter(() => (focusId != null && !document.querySelector('dialog[open]') ? focusPageCard(focusId) : null));
    dlg.close();
  });

  render();
  pickBtn.focus();
}

// ---------- Ініціалізація ----------
export function initTransfer() {
  const imp = $('importBtn'), exp = $('exportBtn');
  if (imp) imp.addEventListener('click', () => { if (!isBusy()) openImportDialog(); });
  if (exp) exp.addEventListener('click', () => openExportDialog({ presets: 'all', pages: 'all', proxy: true }));
  const sync = () => {
    if (imp) {
      imp.disabled = isBusy();
      imp.title = isBusy() ? 'Імпорт недоступний під час прогону чи запису' : 'Імпорт пресетів, сценаріїв і проксі з файлу (.json)';
    }
  };
  on('busy', sync);
  sync();
  on('ui:export', (opts) => openExportDialog(opts || {}));
  on('ui:export-page', (page) => exportPage(page));
  on('ui:import', () => { if (!isBusy()) openImportDialog(); else toast('Імпорт недоступний під час прогону чи запису.', { kind: 'warn' }); });
}
