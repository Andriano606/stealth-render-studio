// Експорт/імпорт ПРЕСЕТІВ і СЦЕНАРІЇВ (файл-бандл JSON) — спільний, ЧИСТИЙ, ізоморфний модуль.
// Без імпортів Node: сервер (routes/transfer.js) і фронтенд (/lib/transfer.js) ділять код.
//
// Формат бандла:
//   { format: 'stealth-render-studio/bundle', version: 1, exportedAt: ISO,
//     presets:   [{ name, body }],
//     scenarios: [{ name, url, recs: [{ name, subs: [...кроки як є (v2/legacy)...] }] }],
//     files:     [{ fileId, filename, size, data: base64|null, missing?: true, skipped?: 'too_large' }],
//     proxy?:    { server, username?, password?, bypass?, enabled? } }   ← ОКРЕМО від пресетів, з паролем
// Проксі — середовище, а не пресет (lib/proxy.js): у тіло пресета не входить (PRESET_BODY_KEYS), але
// глобальний експорт може перенести його цілим (з логіном і паролем) — поле `proxy` бандла, лише за вибором.
// Без id пресетів/сценаріїв/Дій (на імпорті — нові), без builtin, без runtime-полів UI. id КРОКІВ лишаються.
//
// Конфлікти назв на імпорті — planImport: однаковий зміст → пропуск (дубліката не створюємо),
// інший зміст → стратегія 'rename' (за замовчуванням, «X (2)») | 'replace' | 'skip'.
import { stripTransient } from './steps.js';
import { normalizeProxy, publicProxy } from './proxy.js';

export const BUNDLE_FORMAT = 'stealth-render-studio/bundle';
export const BUNDLE_VERSION = 1;
export const NAME_MAX = 80;

// Ліміти вмісту бандла (захист від сміття/випадкових гігантських файлів).
export const MAX_PRESETS = 500;
export const MAX_SCENARIOS = 500;
export const MAX_RECS = 1000;      // Дій у сценарії
export const MAX_STEPS = 2000;     // кроків у Дії
export const MAX_FILES = 1000;
export const MAX_DEPTH = 40;       // вкладеність JSON у body/кроках
export const REC_NAME_MAX = 200;
export const SCENARIO_NAME_MAX = 200; // як maxlength перейменування сценарію в UI (scenarios.js)
export const CONFLICT_STRATEGIES = Object.freeze(['rename', 'replace', 'skip']);

// Ключі, які НІКОЛИ не копіюються (захист від prototype pollution: JSON.parse створює
// own-властивість «__proto__», а присвоєння out['__proto__'] = … змінило б прототип).
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Білий список ключів тіла пресета — те, що кладе в пресет сам UI (draftBody: launch/stealth/behavior/
// fingerprint) + clear:true («🧹 Clear all»). cookies/storageState тощо НЕ переносяться: applyProfilePatch
// записав би їх у профіль (чужа сесія або стерті власні cookies) — ні на імпорті, ні на експорті.
export const PRESET_BODY_KEYS = Object.freeze(['launch', 'stealth', 'behavior', 'fingerprint', 'clear']);

// Символ NUL (\u0000) Postgres не приймає ні в text, ні в jsonb — такий бандл відхиляємо цілком
// (інакше імпорт падав би посеред запису).
const hasNul = (s) => typeof s === 'string' && s.includes('\u0000');

// ---------- Назви і порівняння ----------
// Пробіли стиснуто, обрізано (як validatePresetName у routes/presets.js).
export function normName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// JSON без залежності від порядку ключів (Postgres JSONB переставляє ключі); undefined-поля пропускаються.
export function stableJson(v) {
  const norm = (o) => (o && typeof o === 'object'
    ? (Array.isArray(o) ? o.map(norm) : Object.keys(o).sort().reduce((a, k) => { if (o[k] !== undefined) a[k] = norm(o[k]); return a; }, {}))
    : o);
  return JSON.stringify(norm(v === undefined ? null : v));
}
export const sameValue = (a, b) => stableJson(a) === stableJson(b);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Глибока JSON-копія без небезпечних ключів. Не-JSON значення (функції, undefined, NaN/Infinity)
// поводяться як у JSON.stringify. Глибше за MAX_DEPTH — null і ctx.tooDeep = true.
function sanitize(v, ctx = {}, depth = 0) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string') { if (hasNul(v)) ctx.nul = true; return v; }
  if (t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : null;
  if (t !== 'object') return undefined;
  if (depth >= MAX_DEPTH) { ctx.tooDeep = true; return null; }
  if (Array.isArray(v)) return v.map((x) => { const c = sanitize(x, ctx, depth + 1); return c === undefined ? null : c; });
  const out = {};
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) { ctx.unsafe = true; continue; }
    if (hasNul(k)) ctx.nul = true;
    const c = sanitize(v[k], ctx, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

// Тіло пресета за білим списком PRESET_BODY_KEYS (clear — лише true). → { body, dropped: [ключі] }.
export function presetBody(body, ctx = {}) {
  const src = isPlainObject(body) ? body : {};
  const out = {}, dropped = [];
  for (const k of Object.keys(src)) {
    if (UNSAFE_KEYS.has(k)) { ctx.unsafe = true; continue; }
    if (!PRESET_BODY_KEYS.includes(k)) { dropped.push(k); continue; }
    if (k === 'clear') { if (src.clear === true) out.clear = true; else if (src.clear != null && src.clear !== false) dropped.push(k); continue; }
    const c = sanitize(src[k], ctx, 1);
    if (c !== undefined) out[k] = c;
  }
  return { body: out, dropped };
}

// ---------- Очищення для експорту ----------
export function cleanPreset(p) {
  const src = p || {};
  return { name: normName(src.name), body: presetBody(src.body).body };
}

// Те саме правило, що pagePayload (lib/steps.js): без кроків pending:true (плейсхолдер «…⏳» живого
// запису, ще не підтверджений), без TRANSIENT_FIELDS кроку (status/strategy/ms/error/failShot/healed/
// fallback/pausing — стан прогону) і з білим списком полів Дії/сценарію (id, expanded, lastRun — геть).
export function cleanScenario(page) {
  const src = page || {};
  return {
    name: normName(src.name),
    url: typeof src.url === 'string' ? src.url : '',
    recs: (Array.isArray(src.recs) ? src.recs : []).filter(isPlainObject).map((r) => ({
      name: normName(r.name),
      subs: (Array.isArray(r.subs) ? r.subs : [])
        .filter((x) => isPlainObject(x) && x.pending !== true)
        .map((x) => sanitize(stripTransient(x))),
    })),
  };
}

// Зміст для порівняння «той самий?» (назва — окремо).
function presetContent(p) { return isPlainObject(p && p.body) ? p.body : {}; }
function scenarioContent(p) { const c = cleanScenario(p); return { url: c.url, recs: c.recs }; }

// ---------- Файли кроків ----------
const isFileRef = (s) => isPlainObject(s) && s.type === 'file' && typeof s.fileId === 'string' && s.fileId !== '';

// [{fileId, filename}] з кроків type:'file' — унікальні за fileId (перший filename виграє).
export function collectFileRefs(scenarios) {
  const seen = new Map();
  for (const p of scenarios || []) {
    for (const r of (p && Array.isArray(p.recs) ? p.recs : [])) {
      for (const s of (r && Array.isArray(r.subs) ? r.subs : [])) {
        if (isFileRef(s) && !seen.has(s.fileId)) seen.set(s.fileId, { fileId: s.fileId, filename: typeof s.filename === 'string' ? s.filename : '' });
      }
    }
  }
  return [...seen.values()];
}

// Нові сценарії з підміненими fileId/filename (map: {oldFileId: {fileId, filename}}); решта — як є.
export function remapFileRefs(scenarios, map) {
  const m = map || {};
  return (scenarios || []).map((p) => ({
    ...p,
    recs: (p && Array.isArray(p.recs) ? p.recs : []).map((r) => ({
      ...r,
      subs: (r && Array.isArray(r.subs) ? r.subs : []).map((s) => {
        if (!isFileRef(s) || !hasOwn(m, s.fileId) || !isPlainObject(m[s.fileId])) return s;
        const to = m[s.fileId];
        return { ...s, fileId: String(to.fileId), filename: to.filename != null ? String(to.filename) : s.filename };
      }),
    })),
  }));
}

function cleanFile(f) {
  const src = f || {};
  const out = {
    fileId: String(src.fileId == null ? '' : src.fileId),
    filename: String(src.filename == null ? '' : src.filename),
    size: Number.isFinite(src.size) && src.size >= 0 ? src.size : 0,
    data: typeof src.data === 'string' ? src.data : null,
  };
  if (src.missing === true) out.missing = true;
  if (typeof src.skipped === 'string' && src.skipped) out.skipped = src.skipped;
  return out;
}

// Проксі для бандла: усі налаштування разом із паролем (нормалізовані). Немає/порожній → null.
export function cleanBundleProxy(proxy) {
  const r = normalizeProxy(proxy);
  return r.error || !r.proxy ? null : r.proxy;
}

// ---------- Бандл ----------
// proxy — лише якщо його явно експортують (поле зʼявляється в бандлі тільки тоді).
export function buildBundle({ presets = [], scenarios = [], files = [], exportedAt, proxy } = {}) {
  const b = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: exportedAt || new Date().toISOString(),
    presets: (presets || []).map(cleanPreset),
    scenarios: (scenarios || []).map(cleanScenario),
    files: (files || []).map(cleanFile),
  };
  const px = cleanBundleProxy(proxy);
  if (px) b.proxy = px;
  return b;
}

// Повне порівняння проксі (з паролем і станом тумблера), без порядку ключів.
export const sameProxyFull = (a, b) => sameValue(cleanBundleProxy(a), cleanBundleProxy(b));

// План для проксі з бандла: current — profile.proxy (повний, на сервері), incoming — bundle.proxy.
// → null (у файлі проксі немає) | {action:'skip', reason:'identical'|'not_selected'} |
//   {action:'replace'|'create', reason:'replaced'|'new'}. Застосування = заміна проксі ЦІЛКОМ.
export function planProxy(current, incoming, { selected = true } = {}) {
  if (!incoming) return null;
  if (!selected) return { action: 'skip', reason: 'not_selected' };
  if (sameProxyFull(current, incoming)) return { action: 'skip', reason: 'identical' };
  return current && current.server ? { action: 'replace', reason: 'replaced' } : { action: 'create', reason: 'new' };
}

// Тіло patch для applyProfilePatch: рівно те, що у файлі (без пароля у файлі — пароль прибирається,
// а не лишається старий; стан тумблера — явно).
export function proxyImportPatch(px) {
  const p = cleanBundleProxy(px);
  if (!p) return null;
  return { server: p.server, username: p.username || '', password: p.password || '', bypass: p.bypass || '', enabled: p.enabled !== false };
}

// Що показати про проксі з бандла (без пароля): publicProxy.
export const bundleProxyPublic = (px) => publicProxy(cleanBundleProxy(px));

// Назва з бандла: рядок 1..max після normName; довша — обрізається з попередженням.
// Пресети — NAME_MAX (80, як validatePresetName), сценарії — SCENARIO_NAME_MAX (200, як UI), інакше
// довга назва сценарію обрізалась би на імпорті і той самий сценарій щоразу ставав би копією.
function parseName(v, what, warnings, max = NAME_MAX) {
  if (typeof v !== 'string') return { error: what + ': назва має бути рядком' };
  if (hasNul(v)) return { error: NUL_ERROR };
  let name = normName(v);
  if (!name) return { error: what + ': назва не може бути порожньою' };
  if (name.length > max) {
    name = name.slice(0, max).trimEnd();
    warnings.push(what + ': назву обрізано до ' + max + ' символів («' + name + '»)');
  }
  return { name };
}

const fail = (error) => ({ ok: false, error });
const NUL_ERROR = 'Файл містить недопустимий символ NUL (\\u0000) — такі дані не можна зберегти';

// Рядок JSON або обʼєкт → { ok:true, bundle, warnings } | { ok:false, error }. Повертає НОВИЙ очищений обʼєкт.
export function parseBundle(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw.replace(/^﻿/, '')); } catch (_e) { return fail('Файл не є коректним JSON'); }
  }
  if (!isPlainObject(raw) || raw.format !== BUNDLE_FORMAT) return fail('Це не файл експорту Stealth Render Studio');
  const ver = raw.version;
  if (!Number.isInteger(ver) || ver < 1) return fail('Невідома версія формату файлу експорту');
  if (ver > BUNDLE_VERSION) return fail('Файл створено новішою версією застосунку (формат v' + ver + ', підтримується до v' + BUNDLE_VERSION + ') — онови застосунок');

  const arr = (k) => (raw[k] === undefined || raw[k] === null ? [] : raw[k]);
  const inPresets = arr('presets'), inScenarios = arr('scenarios'), inFiles = arr('files');
  if (!Array.isArray(inPresets)) return fail('Поле «presets» має бути масивом');
  if (!Array.isArray(inScenarios)) return fail('Поле «scenarios» має бути масивом');
  if (!Array.isArray(inFiles)) return fail('Поле «files» має бути масивом');
  if (inPresets.length > MAX_PRESETS) return fail('Забагато пресетів у файлі: ' + inPresets.length + ' (максимум ' + MAX_PRESETS + ')');
  if (inScenarios.length > MAX_SCENARIOS) return fail('Забагато сценаріїв у файлі: ' + inScenarios.length + ' (максимум ' + MAX_SCENARIOS + ')');
  if (inFiles.length > MAX_FILES) return fail('Забагато файлів у бандлі: ' + inFiles.length + ' (максимум ' + MAX_FILES + ')');

  const warnings = [];
  const ctx = {};

  const presets = [];
  for (let i = 0; i < inPresets.length; i++) {
    const p = inPresets[i], what = 'Пресет №' + (i + 1);
    if (!isPlainObject(p)) return fail(what + ': очікувався обʼєкт');
    const n = parseName(p.name, what, warnings);
    if (n.error) return fail(n.error);
    if (!isPlainObject(p.body)) return fail(what + ' «' + n.name + '»: налаштування (body) мають бути обʼєктом');
    const pb = presetBody(p.body, ctx);
    if (pb.dropped.length) warnings.push('Пресет «' + n.name + '»: поля ' + pb.dropped.join(', ') + ' проігноровано (у пресет переносяться лише ' + PRESET_BODY_KEYS.join('/') + ')');
    presets.push({ name: n.name, body: pb.body });
  }

  const scenarios = [];
  for (let i = 0; i < inScenarios.length; i++) {
    const p = inScenarios[i], what = 'Сценарій №' + (i + 1);
    if (!isPlainObject(p)) return fail(what + ': очікувався обʼєкт');
    const n = parseName(p.name, what, warnings, SCENARIO_NAME_MAX);
    if (n.error) return fail(n.error);
    const label = what + ' «' + n.name + '»';
    if (p.url !== undefined && p.url !== null && typeof p.url !== 'string') return fail(label + ': URL має бути рядком');
    if (hasNul(p.url)) return fail(NUL_ERROR);
    const recsIn = p.recs === undefined || p.recs === null ? [] : p.recs;
    if (!Array.isArray(recsIn)) return fail(label + ': Дії (recs) мають бути масивом');
    if (recsIn.length > MAX_RECS) return fail(label + ': забагато Дій (' + recsIn.length + ', максимум ' + MAX_RECS + ')');
    const recs = [];
    for (let j = 0; j < recsIn.length; j++) {
      const r = recsIn[j];
      if (!isPlainObject(r)) return fail(label + ', Дія №' + (j + 1) + ': очікувався обʼєкт');
      const subsIn = r.subs === undefined || r.subs === null ? [] : r.subs;
      if (!Array.isArray(subsIn)) return fail(label + ', Дія №' + (j + 1) + ': кроки (subs) мають бути масивом');
      if (subsIn.length > MAX_STEPS) return fail(label + ', Дія №' + (j + 1) + ': забагато кроків (' + subsIn.length + ', максимум ' + MAX_STEPS + ')');
      const subs = [];
      for (let k = 0; k < subsIn.length; k++) {
        if (!isPlainObject(subsIn[k])) return fail(label + ', Дія №' + (j + 1) + ', крок №' + (k + 1) + ': очікувався обʼєкт');
        if (subsIn[k].pending === true) continue; // непідтверджений крок живого запису — не імпортуємо
        subs.push(sanitize(stripTransient(subsIn[k]), ctx));
      }
      if (hasNul(r.name)) return fail(NUL_ERROR);
      let rname = typeof r.name === 'string' ? normName(r.name) : '';
      if (!rname) rname = 'Дія ' + (j + 1);
      if (rname.length > REC_NAME_MAX) rname = rname.slice(0, REC_NAME_MAX).trimEnd();
      recs.push({ name: rname, subs });
    }
    scenarios.push({ name: n.name, url: typeof p.url === 'string' ? p.url : '', recs });
  }

  const files = [];
  for (let i = 0; i < inFiles.length; i++) {
    const f = inFiles[i], what = 'Файл №' + (i + 1);
    if (!isPlainObject(f)) return fail(what + ': очікувався обʼєкт');
    if (typeof f.fileId !== 'string' || !f.fileId) return fail(what + ': fileId має бути непорожнім рядком');
    if (f.filename !== undefined && typeof f.filename !== 'string') return fail(what + ': імʼя файлу має бути рядком');
    if (f.data !== undefined && f.data !== null && typeof f.data !== 'string') return fail(what + ': вміст (data) має бути рядком base64 або null');
    if (hasNul(f.fileId) || hasNul(f.filename)) return fail(NUL_ERROR);
    const file = cleanFile(f);
    files.push(file);
    if (file.data == null && (file.missing || file.skipped)) {
      const why = file.skipped === 'too_large' ? 'завеликий, не вкладено' : file.missing ? 'не знайдено під час експорту' : 'не вкладено';
      warnings.push('Файл «' + (file.filename || file.fileId) + '» ' + why + ' — крок файлу потребуватиме перевибору файлу');
    }
  }

  if (ctx.nul) return fail(NUL_ERROR);
  if (ctx.tooDeep) return fail('Файл має занадто глибоку вкладеність даних (понад ' + MAX_DEPTH + ' рівнів)');

  // Проксі (необовʼязково): некоректний — не валимо весь імпорт, а пропускаємо з попередженням.
  let proxy = null;
  if (raw.proxy !== undefined && raw.proxy !== null) {
    const pxIn = raw.proxy;
    if (isPlainObject(pxIn) && Object.values(pxIn).some(hasNul)) return fail(NUL_ERROR);
    const r = normalizeProxy(isPlainObject(pxIn) ? { ...pxIn, password: pxIn.password == null ? '' : pxIn.password } : pxIn);
    if (r.error) warnings.push('Проксі у файлі некоректний (' + r.error + ') — пропущено');
    else if (r.proxy) { proxy = r.proxy; if (r.warning) warnings.push('Проксі: ' + r.warning); }
  }
  if (!presets.length && !scenarios.length && !proxy) warnings.push('У файлі немає ні пресетів, ні сценаріїв');

  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    presets, scenarios, files,
  };
  if (proxy) bundle.proxy = proxy;
  return { ok: true, bundle, warnings };
}

// ---------- Унікальні назви ----------
// «X» → «X (2)», «X (3)»…; «X (4)» → «X (5)»… Результат ≤ max символів (обрізається основа, не суфікс).
// Вільна назва повертається як є (після normName). Порівняння — через normName (регістр ВРАХОВУЄТЬСЯ).
export function uniqueName(name, taken, max = NAME_MAX) {
  const set = new Set();
  for (const t of taken || []) set.add(normName(t));
  const clean = normName(name);
  const first = clean.length > max ? clean.slice(0, max).trimEnd() : clean;
  if (first && !set.has(first)) return first;
  let base = clean, n = 2;
  const m = /^(.*\S) \((\d{1,9})\)$/.exec(clean);
  if (m) { base = m[1]; n = Number(m[2]) + 1; }
  for (;; n++) {
    const suffix = ' (' + n + ')';
    const room = Math.max(0, max - suffix.length);
    const head = base.length > room ? base.slice(0, room).trimEnd() : base;
    const cand = normName(head + suffix);
    if (!set.has(cand)) return cand;
  }
}

// ---------- План імпорту ----------
// existing: [{id, name, …}], incoming: [{name, …}] (уже після parseBundle).
// → [{ index, action: 'create'|'replace'|'skip', name, originalName, targetId?, reason }]
//   reason: 'new' | 'identical' | 'renamed' | 'replaced' | 'skipped' | 'duplicate_in_bundle'.
// kind: 'presets'|'preset' → зміст = body; інакше ('scenarios'|'scenario') → {url, recs[{name, subs}]}.
// Без kind — виводиться з елементів (є body → пресет).
export function planImport(existing, incoming, { onConflict = 'rename', same, kind } = {}) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const strategy = CONFLICT_STRATEGIES.includes(onConflict) ? onConflict : 'rename';
  let isPreset;
  if (kind) isPreset = /^preset/.test(String(kind));
  else isPreset = [...inc, ...ex].some((x) => x && hasOwn(x, 'body'));
  const contentOf = isPreset ? presetContent : scenarioContent;
  const maxName = isPreset ? NAME_MAX : SCENARIO_NAME_MAX;
  const uniq = (n, t) => uniqueName(n, t, maxName);
  const eq = typeof same === 'function' ? same : (a, b) => sameValue(contentOf(a), contentOf(b));

  const byName = new Map(); // normName → [існуючі]
  for (const e of ex) {
    const n = normName(e && e.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(e);
  }
  const taken = new Set(byName.keys());     // зайняті назви: існуючі + сплановані
  const seen = new Map();                   // назва з бандла → перший такий елемент бандла
  const replaced = new Set();               // існуючі, які вже перезапише запланований replace
  const out = [];

  inc.forEach((item, index) => {
    const originalName = item && item.name;
    const n = normName(originalName);
    const olds = byName.get(n) || [];
    let row;
    // «Такий самий є» — лише серед існуючих, які НЕ буде перезаписано: інакше зміст, що був і в
    // існуючому, і в бандлі, після replace попереднього елемента не лишився б ніде.
    if (olds.some((o) => !replaced.has(o) && eq(o, item))) {
      row = { action: 'skip', name: n, reason: 'identical' };
    } else if (olds.length && strategy === 'skip') {
      row = { action: 'skip', name: n, reason: 'skipped' };
    } else if (seen.has(n) && eq(seen.get(n), item)) {
      row = { action: 'skip', name: n, reason: 'identical' };
    } else if (seen.has(n) || (!olds.length && taken.has(n))) {
      // Друга з тією самою назвою в бандлі (або назва, яку вже зайняло перейменування) — лише нова назва:
      // той самий існуючий елемент двічі не замінюємо.
      row = { action: 'create', name: uniq(n, taken), reason: seen.has(n) ? 'duplicate_in_bundle' : 'renamed' };
    } else if (olds.length && strategy === 'replace') {
      row = { action: 'replace', name: n, targetId: olds[0].id, reason: 'replaced' };
      replaced.add(olds[0]);
    } else if (olds.length) {
      row = { action: 'create', name: uniq(n, taken), reason: 'renamed' };
    } else {
      row = { action: 'create', name: n, reason: 'new' };
    }
    if (!seen.has(n)) seen.set(n, item);
    if (row.action !== 'skip') taken.add(row.name);
    const res = { index, action: row.action, name: row.name, originalName };
    if (row.targetId !== undefined) res.targetId = row.targetId;
    res.reason = row.reason;
    out.push(res);
  });
  return out;
}

// ---------- Підсумок ----------
// report: { presets: [plan-items], scenarios: [plan-items] } (reason 'no_db' — пресети без БД).
// → «Імпортовано: пресетів 2 (1 перейменовано), сценаріїв 3; пропущено однакових: 1; замінено: 1».
export function summarizeImport(report) {
  const r = report || {};
  const kinds = [['presets', 'пресетів'], ['scenarios', 'сценаріїв']];
  const parts = [];
  let identical = 0, skipped = 0, replaced = 0, noDb = 0, any = false;
  for (const [key, label] of kinds) {
    const items = Array.isArray(r[key]) ? r[key] : [];
    if (!items.length) continue;
    any = true;
    let done = 0, renamed = 0;
    for (const it of items) {
      if (it.action === 'create' || it.action === 'replace') done++;
      if (it.action === 'create' && (it.reason === 'renamed' || it.reason === 'duplicate_in_bundle')) renamed++;
      if (it.action === 'replace') replaced++;
      if (it.action === 'skip') {
        if (it.reason === 'identical') identical++;
        else if (it.reason === 'no_db') noDb++;
        else skipped++;
      }
    }
    parts.push(label + ' ' + done + (renamed ? ' (' + renamed + ' перейменовано)' : ''));
  }
  const px = r.proxy;
  const pxDone = !!(px && (px.action === 'create' || px.action === 'replace'));
  if (pxDone) parts.push('проксі');
  if (!any && !px) return 'Нічого не імпортовано: файл порожній';
  if (!parts.length) return 'Нічого не імпортовано' + (px && px.reason === 'identical' ? ': проксі такий самий' : '');
  let s = 'Імпортовано: ' + parts.join(', ');
  if (px && px.reason === 'identical') s += '; проксі такий самий';
  if (identical) s += '; пропущено однакових: ' + identical;
  if (skipped) s += '; пропущено через конфлікт назви: ' + skipped;
  if (replaced) s += '; замінено: ' + replaced;
  if (noDb) s += '; пресети не імпортовано (БД недоступна): ' + noDb;
  return s;
}

// ---------- Назва файлу експорту ----------
const localDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const slugOf = (s, re) => normName(s).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  .replace(re, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40).replace(/-+$/, '');

// stealth-bundle-<presets|scenarios|all|назва-одного>-<локальна дата>.json
// → { filename (UTF-8, для filename*), asciiFilename (ASCII-безпечний запасний для filename="…") }.
// Один елемент (1 сценарій без пресетів або 1 пресет без сценаріїв) → його назва; лише пресети →
// «presets»; лише сценарії → «scenarios»; інакше → «all». ASCII-варіант назви без латиниці → «preset»/«scenario».
export function bundleFilename(bundle, now = new Date()) {
  const presets = (bundle && Array.isArray(bundle.presets)) ? bundle.presets : [];
  const scenarios = (bundle && Array.isArray(bundle.scenarios)) ? bundle.scenarios : [];
  let what, ascii;
  const one = presets.length + scenarios.length === 1 ? (presets[0] || scenarios[0]) : null;
  if (one) {
    const kind = presets.length ? 'preset' : 'scenario';
    what = slugOf(one && one.name, /[^\p{L}\p{N}]+/gu) || kind;
    ascii = slugOf(String((one && one.name) || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''), /[^a-zA-Z0-9]+/g) || kind;
  } else {
    what = ascii = presets.length && !scenarios.length ? 'presets' : scenarios.length && !presets.length ? 'scenarios' : 'all';
  }
  const date = localDate(now);
  return { filename: 'stealth-bundle-' + what + '-' + date + '.json', asciiFilename: 'stealth-bundle-' + ascii + '-' + date + '.json' };
}
