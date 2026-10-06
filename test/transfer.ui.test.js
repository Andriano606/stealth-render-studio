// Чиста логіка UI експорту/імпорту (public/js/transfer.js): URL експорту, стан кнопки, прев'ю плану
// з чипами, файли кроків (що вантажити / що перевибрати), підміна fileId лише для імпортованих,
// тіло POST /import, фокус і рядки звіту. Без DOM і браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportHref, selectionParam, selectionState, exportState, countPageFiles, planChip, planPreview,
  uploadTargets, fileStatus, missingFileText, applyFileMap, buildImportRequest, importedFocusId,
  reportLines, base64ToBytes, countText, STRATEGY_LABELS,
  flushProblem, importMayHaveWritten, presetsTouched, importSnapshot, secretTextSteps,
} from '../public/js/transfer.js';
import { createPersistQueue } from '../public/js/persist.js';
import { buildBundle, parseBundle, CONFLICT_STRATEGIES } from '../lib/transfer.js';
import { createApi } from '../public/js/api.js';

const fileStep = (fileId, filename = 'cv.pdf') => ({ id: 's-' + fileId, type: 'file', fileId, filename });
const page = (id, name, extra = {}) => ({
  id, name, url: 'https://ex.com/' + id, expanded: true,
  recs: [{ id: id * 10, name: 'Дія 1', expanded: false, subs: [{ id: 'c' + id, type: 'click', x: 1, y: 2 }] }],
  ...extra,
});
const sets = (p = [], s = []) => ({ presets: new Set(p), scenarios: new Set(s) });

// ---------- експорт ----------
test('exportHref: обидва параметри завжди; all / список id / порожньо; files 1|0', () => {
  assert.equal(exportHref({ presets: 'all', pages: 'all' }), '/export?presets=all&pages=all&files=1');
  assert.equal(exportHref({ presets: [], pages: [17], files: true }), '/export?presets=&pages=17&files=1');
  assert.equal(exportHref({ presets: [1, 2], pages: null, files: false }), '/export?presets=1%2C2&pages=&files=0');
  assert.equal(exportHref(), '/export?presets=&pages=&files=1');
});

test('selectionParam / selectionState: усі → all, частина → id у порядку списку, жодного', () => {
  const ids = [3, 1, 2];
  assert.equal(selectionParam(ids, new Set([1, 2, 3])), 'all');
  assert.deepEqual(selectionParam(ids, new Set([2, 3])), [3, 2]);
  assert.deepEqual(selectionParam(ids, new Set()), []);
  assert.deepEqual(selectionParam([], new Set()), []); // порожній список — не «all»
  assert.equal(selectionState(ids, new Set([1, 2, 3])), 'all');
  assert.equal(selectionState(ids, new Set([1])), 'some');
  assert.equal(selectionState(ids, new Set()), 'none');
});

test('exportState: порожній вибір — вимкнено з поясненням; інакше підсумок', () => {
  const off = exportState({ presets: 0, pages: 0 });
  assert.equal(off.disabled, true);
  assert.match(off.reason, /Вибери/);
  const on1 = exportState({ presets: 2, pages: 1, files: 3, includeFiles: true });
  assert.equal(on1.disabled, false);
  assert.match(on1.reason, /пресетів: 2, сценаріїв: 1, файлів: 3/);
  assert.match(exportState({ pages: 1, files: 2, includeFiles: false }).reason, /без файлів кроків/);
});

test('countPageFiles: унікальні fileId лише у вибраних сценаріях', () => {
  const a = page(1, 'A'); a.recs[0].subs.push(fileStep('f1'), fileStep('f1'), fileStep('f2'));
  const b = page(2, 'B'); b.recs[0].subs.push(fileStep('f3'));
  assert.equal(countPageFiles([a, b], new Set([1])), 2);
  assert.equal(countPageFiles([a, b], new Set([1, 2])), 3);
  assert.equal(countPageFiles([a, b], new Set()), 0);
});

// ---------- прев'ю імпорту ----------
test('planChip: тексти для кожного варіанта плану', () => {
  assert.equal(planChip({ action: 'create', reason: 'new', name: 'X' }).text, 'новий');
  assert.equal(planChip({ action: 'skip', reason: 'identical', name: 'X' }).text, '= такий самий є — пропуск');
  assert.equal(planChip({ action: 'create', reason: 'renamed', name: 'X (2)' }).text, 'конфлікт назви → «X (2)»');
  assert.match(planChip({ action: 'create', reason: 'duplicate_in_bundle', name: 'X (2)' }).text, /дубль у файлі → «X \(2\)»/);
  assert.equal(planChip({ action: 'replace', reason: 'replaced', name: 'X', targetId: 1 }).text, 'замінить існуючий');
  assert.equal(planChip({ action: 'skip', reason: 'skipped', name: 'X' }).text, 'пропуск');
  assert.equal(planChip(null, { selected: false }).text, 'не вибрано');
  assert.match(planChip({ action: 'create', reason: 'new' }, { kind: 'presets', presetsDb: false }).text, /БД недоступна/);
  // cls — для кольору чипа
  assert.equal(planChip({ action: 'replace' }).cls, 'replace');
  assert.equal(planChip({ action: 'create', reason: 'renamed', name: 'Y' }).cls, 'rename');
});

function sampleBundle() {
  return parseBundle(buildBundle({
    presets: [
      { name: '📋 Ashby', body: { launch: { engine: 'chromium' } } },       // такий самий є
      { name: 'Мій', body: { launch: { engine: 'camoufox' } } },             // конфлікт (інший зміст)
      { name: 'Новий', body: {} },
    ],
    scenarios: [page(1, 'Сценарій 1'), page(2, 'Сценарій 2', { url: 'https://other.com' }), page(3, 'Свіжий')],
  })).bundle;
}
const existingPresets = [
  { id: 5, name: '📋 Ashby', body: { launch: { engine: 'chromium' } }, builtin: true },
  { id: 6, name: 'Мій', body: { launch: { engine: 'chromium' } } },
];
// Поточні сценарії з runtime-полями (lastRun, expanded, status кроку) — вони НЕ мають заважати збігу.
const existingPages = () => {
  const p1 = page(1, 'Сценарій 1', { lastRun: { status: 'ok' } });
  p1.recs[0].subs[0].status = 'done';
  return [p1, page(2, 'Сценарій 2')];
};

test('planPreview: rename за замовчуванням — новий / однаковий / конфлікт → «X (2)»', () => {
  const b = sampleBundle();
  const pv = planPreview({ bundle: b, existingPresets, existingPages: existingPages(), selected: sets([0, 1, 2], [0, 1, 2]) });
  assert.deepEqual(pv.presets.map((r) => r.chip.text), ['= такий самий є — пропуск', 'конфлікт назви → «Мій (2)»', 'новий']);
  assert.deepEqual(pv.scenarios.map((r) => r.chip.text), ['= такий самий є — пропуск', 'конфлікт назви → «Сценарій 2 (2)»', 'новий']);
  assert.deepEqual(pv.counts, { create: 4, replace: 0, skip: 2 });
  assert.equal(pv.canImport, true);
  assert.match(pv.reason, /нових: 4, пропусків: 2/);
});

test('planPreview: стратегії replace / skip миттєво змінюють план', () => {
  const b = sampleBundle();
  const rep = planPreview({ bundle: b, existingPresets, existingPages: existingPages(), selected: sets([1], [1]), onConflict: { presets: 'replace', scenarios: 'replace' } });
  assert.equal(rep.presets[1].plan.action, 'replace');
  assert.equal(rep.presets[1].plan.targetId, 6);
  assert.equal(rep.scenarios[1].chip.text, 'замінить існуючий');
  assert.equal(rep.scenarios[1].plan.targetId, 2);
  const sk = planPreview({ bundle: b, existingPresets, existingPages: existingPages(), selected: sets([1], [1]), onConflict: { presets: 'skip', scenarios: 'skip' } });
  assert.equal(sk.presets[1].chip.text, 'пропуск');
  assert.equal(sk.canImport, false);
  assert.match(sk.reason, /Нічого імпортувати/);
});

test('planPreview: невибрані — «не вибрано» і не впливають на план; нічого не вибрано → вимкнено', () => {
  const b = sampleBundle();
  const pv = planPreview({ bundle: b, existingPresets, existingPages: existingPages(), selected: sets([], [2]) });
  assert.equal(pv.presets[0].chip.text, 'не вибрано');
  assert.equal(pv.presets[0].plan, null);
  assert.equal(pv.scenarios[2].plan.index, 2); // індекс — у бандлі, а не в підмножині
  assert.equal(pv.scenarios[2].chip.text, 'новий');
  const none = planPreview({ bundle: b, existingPresets, existingPages: [], selected: sets() });
  assert.equal(none.canImport, false);
  assert.match(none.reason, /Вибери/);
});

test('planPreview: дві однакові назви в бандлі — другий дістає нову назву навіть при replace', () => {
  const b = parseBundle(buildBundle({ scenarios: [page(1, 'X'), page(2, 'X', { url: 'https://b' })] })).bundle;
  const pv = planPreview({ bundle: b, existingPages: [page(9, 'X', { url: 'https://c' })], selected: sets([], [0, 1]), onConflict: { scenarios: 'replace' } });
  assert.equal(pv.scenarios[0].plan.action, 'replace');
  assert.equal(pv.scenarios[1].plan.action, 'create');
  assert.equal(pv.scenarios[1].plan.reason, 'duplicate_in_bundle');
  assert.equal(pv.scenarios[1].plan.name, 'X (2)');
});

test('planPreview: без БД пресети не імпортуються (чип і лічильники), сценарії — так', () => {
  const b = sampleBundle();
  const pv = planPreview({ bundle: b, existingPresets: [], existingPages: [], selected: sets([0, 1, 2], []), presetsDb: false });
  assert.ok(pv.presets.every((r) => /БД недоступна/.test(r.chip.text)));
  assert.equal(pv.canImport, false);
  const pv2 = planPreview({ bundle: b, existingPresets: [], existingPages: [], selected: sets([0], [0]), presetsDb: false });
  assert.equal(pv2.canImport, true);
  assert.equal(pv2.counts.create, 1);
});

// ---------- файли кроків ----------
function bundleWithFiles() {
  const s1 = page(1, 'A'); s1.recs[0].subs.push(fileStep('f1', 'cv.pdf'), fileStep('f2', 'big.zip'));
  const s2 = page(2, 'B'); s2.recs[0].subs.push(fileStep('f3', 'gone.txt'), fileStep('f4', 'x.png'));
  return parseBundle(buildBundle({
    scenarios: [s1, s2],
    files: [
      { fileId: 'f1', filename: 'cv.pdf', size: 3, data: Buffer.from('abc').toString('base64') },
      { fileId: 'f2', filename: 'big.zip', size: 9e7, data: null, skipped: 'too_large' },
      { fileId: 'f3', filename: 'gone.txt', size: 0, data: null, missing: true },
      // f4 не вкладено взагалі (експорт без файлів)
    ],
  })).bundle;
}

test('fileStatus: вкладені — на завантаження; завеликі/відсутні/не вкладені — перевибір', () => {
  const b = bundleWithFiles();
  const st = fileStatus(b, [0, 1]);
  assert.deepEqual(st.upload.map((f) => f.fileId), ['f1']);
  assert.deepEqual(st.missing.map((m) => [m.fileId, m.why]), [['f2', 'too_large'], ['f3', 'missing'], ['f4', 'not_included']]);
  assert.match(missingFileText(st.missing[0]), /«big\.zip» завеликий.*перевибору/);
  assert.match(missingFileText(st.missing[2]), /не вкладено у файл/);
  // лише вибрані сценарії
  assert.deepEqual(fileStatus(b, [1]).upload, []);
  assert.deepEqual(fileStatus(b, []).missing, []);
});

test('uploadTargets + applyFileMap: fileId підміняється лише у сценаріях, що імпортуються (не в «такому самому»)', () => {
  const b = bundleWithFiles();
  // Сценарій A вже є такий самий (на цій машині) — його fileId не чіпаємо, інакше сервер не впізнає однаковий.
  const pv = planPreview({ bundle: b, existingPages: [b.scenarios[0]], selected: sets([], [0, 1]) });
  assert.equal(pv.scenarios[0].plan.reason, 'identical');
  assert.deepEqual(uploadTargets(pv), [1]);
  const map = { f1: { fileId: 'n1', filename: 'cv.pdf' }, f4: { fileId: 'n4', filename: 'x.png' } };
  const out = applyFileMap(b.scenarios, map, [1]);
  assert.equal(out[0], b.scenarios[0]); // той самий обʼєкт
  assert.equal(out[0].recs[0].subs[1].fileId, 'f1');
  const subs1 = out[1].recs[0].subs;
  assert.equal(subs1.find((s) => s.filename === 'x.png').fileId, 'n4');
  assert.equal(subs1.find((s) => s.filename === 'gone.txt').fileId, 'f3'); // немає в map — як є
  assert.equal(b.scenarios[1].recs[0].subs.find((s) => s.filename === 'x.png').fileId, 'f4'); // оригінал не мутовано
});

test('buildImportRequest: без files[], індекси відсортовані, стратегії валідні, remap лише цілей', () => {
  const b = bundleWithFiles();
  const req = buildImportRequest({
    bundle: b, selected: sets([], [1, 0]), onConflict: { presets: 'bogus', scenarios: 'replace' },
    fileMap: { f1: { fileId: 'n1', filename: 'cv.pdf' } }, remapIdx: [0],
  });
  assert.deepEqual(req.select, { presets: [], scenarios: [0, 1] });
  assert.deepEqual(req.onConflict, { presets: 'rename', scenarios: 'replace' });
  assert.deepEqual(req.bundle.files, []); // вміст уже завантажено; про відсутні попереджає сервер
  assert.equal(req.bundle.scenarios[0].recs[0].subs.find((s) => s.type === 'file' && s.filename === 'cv.pdf').fileId, 'n1');
  assert.equal(req.dryRun, undefined);
  assert.equal(buildImportRequest({ bundle: b, selected: sets(), onConflict: {}, dryRun: true }).dryRun, true);
  // Сервер прийме те, що ми шлемо: бандл проходить parseBundle, без попереджень про файли (жодних дублів).
  const re = parseBundle(req.bundle);
  assert.equal(re.ok, true);
  assert.equal(re.warnings.filter((w) => /Файл «/.test(w)).length, 0);
  for (const s of CONFLICT_STRATEGIES) assert.ok(STRATEGY_LABELS[s]);
});

test('base64ToBytes: байти без втрат (у т.ч. > 127)', () => {
  const src = Uint8Array.from([0, 1, 127, 128, 200, 255]);
  assert.deepEqual([...base64ToBytes(Buffer.from(src).toString('base64'))], [...src]);
  assert.deepEqual([...base64ToBytes('')], []);
});

// ---------- після імпорту ----------
test('importedFocusId / reportLines: перший створений/замінений сценарій і людські рядки', () => {
  const report = {
    presets: [
      { index: 0, action: 'skip', reason: 'identical', name: 'A', originalName: 'A' },
      { index: 1, action: 'skip', reason: 'no_db', name: 'B', originalName: 'B' },
    ],
    scenarios: [
      { index: 0, action: 'skip', reason: 'skipped', name: 'S', originalName: 'S' },
      { index: 1, action: 'create', reason: 'renamed', name: 'S (2)', originalName: 'S', id: 42 },
      { index: 2, action: 'replace', reason: 'replaced', name: 'T', originalName: 'T', id: 7, targetId: 7 },
    ],
  };
  assert.equal(importedFocusId(report), 42);
  assert.equal(importedFocusId({ scenarios: [{ action: 'skip' }] }), null);
  assert.equal(importedFocusId(null), null);
  const lines = reportLines(report);
  assert.deepEqual(lines, [
    'Пресет «A» пропущено — такий самий уже є',
    'Пресет «B» не імпортовано — БД недоступна',
    'Сценарій «S» пропущено (назва зайнята)',
    'Сценарій «S (2)» створено (у файлі — «S», назва була зайнята)',
    'Сценарій «T» замінено',
  ]);
});

test('countText: українські форми множини', () => {
  assert.equal(countText(1, ['Дія', 'Дії', 'Дій']), '1 Дія');
  assert.equal(countText(3, ['Дія', 'Дії', 'Дій']), '3 Дії');
  assert.equal(countText(11, ['Дія', 'Дії', 'Дій']), '11 Дій');
  assert.equal(countText(22, ['файл', 'файли', 'файлів']), '22 файли');
});

// ---------- api.js ----------
test('api.importBundle: POST /import з JSON-тілом; 400 → ApiError з текстом сервера', async () => {
  let seen;
  const ok = createApi(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, presets: [], scenarios: [], summary: 'S' })); });
  const r = await ok.importBundle({ bundle: { format: 'x' }, select: {} });
  assert.equal(r.summary, 'S');
  assert.equal(seen.url, '/import');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { bundle: { format: 'x' }, select: {} });
  const bad = createApi(async () => new Response(JSON.stringify({ error: 'Це не файл експорту Stealth Render Studio' }), { status: 400 }));
  await assert.rejects(bad.importBundle({}), (e) => e.status === 400 && /не файл експорту/.test(e.message));
});

// ---------- збереження перед імпортом/експортом ----------
test('flushProblem: невдалий flush (PUT /pages 413) → текст проблеми; усе збережено → null', async () => {
  const fail = createPersistQueue({
    save: async () => { const e = new Error('Payload Too Large'); e.status = 413; throw e; },
    retryDelays: [], timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  fail.schedule(1, () => ({ name: 'LOCAL EDIT' }));
  const res = await fail.flushAll();
  assert.deepEqual(res, [false]); // flushAll НЕ кидає — тому результат треба перевіряти
  const t = flushProblem(fail.status());
  assert.match(t, /Не вдалося зберегти поточні зміни сценаріїв: 1 сценарій \(Payload Too Large\)/);
  const ok = createPersistQueue({ save: async () => ({ ok: true }), timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  ok.schedule(1, () => ({ name: 'x' }));
  await ok.flushAll();
  assert.equal(flushProblem(ok.status()), null);
  assert.equal(flushProblem(null), null);
  assert.match(flushProblem({ failed: 3 }), /3 сценарії\.$/);
});

test('importMayHaveWritten: 4xx — ні (валідація до запису); 5xx / мережа / таймаут — так', () => {
  assert.equal(importMayHaveWritten({ status: 400 }), false);
  assert.equal(importMayHaveWritten({ status: 413 }), false);
  assert.equal(importMayHaveWritten({ status: 500 }), true);
  assert.equal(importMayHaveWritten({ status: 0 }), true);
  assert.equal(importMayHaveWritten(Object.assign(new Error('сервер не відповів за 120 с'), { timeout: true })), true);
  assert.equal(importMayHaveWritten(new TypeError('Failed to fetch')), true);
});

test('presetsTouched: лише create/replace пресетів (інакше конфігуратор не перерендерюється)', () => {
  assert.equal(presetsTouched({ presets: [{ action: 'skip' }], scenarios: [{ action: 'create' }] }), false);
  assert.equal(presetsTouched({ presets: [{ action: 'skip' }, { action: 'replace' }] }), true);
  assert.equal(presetsTouched({ presets: [{ action: 'create' }] }), true);
  assert.equal(presetsTouched(null), false);
});

test('importSnapshot: зміна вибору/стратегії під час імпорту не впливає на запит', () => {
  const selected = sets([0], [0]);
  const onConflict = { presets: 'rename', scenarios: 'skip' };
  const snap = importSnapshot(selected, onConflict);
  selected.scenarios.add(1); selected.presets.clear(); onConflict.scenarios = 'rename';
  assert.deepEqual([...snap.selected.scenarios], [0]);
  assert.deepEqual([...snap.selected.presets], [0]);
  assert.equal(snap.onConflict.scenarios, 'skip');
  const bundle = buildBundle({ scenarios: [page(1, 'A'), page(2, 'B')] });
  const req = buildImportRequest({ bundle, selected: snap.selected, onConflict: snap.onConflict });
  assert.deepEqual(req.select.scenarios, [0]);
  assert.equal(req.onConflict.scenarios, 'skip');
});

test('secretTextSteps: текстові кроки в поле пароля (за описом/локаторами цілі)', () => {
  const pg = {
    name: 'Вхід', recs: [{ name: 'Дія 1', subs: [
      { type: 'text', text: 'me@x.com', target: { desc: 'поле «Email»', locs: [{ by: 'label', value: 'Email' }] } },
      { type: 'text', text: 'hunter2', target: { desc: 'поле «Пароль»', locs: [{ by: 'css', value: 'input#pwd' }] } },
      { type: 'text', text: 'x', target: { desc: 'поле', locs: [{ by: 'css', value: 'input[name="user_password"]' }] } },
      { type: 'click', target: { desc: 'кнопка «Forgot password?»' } },
      { type: 'text', text: 'bypass', target: { desc: 'поле «Bypass code»' } },
    ] }],
  };
  assert.deepEqual(secretTextSteps([pg]), [{ page: 'Вхід', rec: 'Дія 1', index: 2 }, { page: 'Вхід', rec: 'Дія 1', index: 3 }]);
  assert.deepEqual(secretTextSteps([page(1, 'A')]), []);
  assert.deepEqual(secretTextSteps(null), []);
});

test('planPreview replace: однаковий з існуючим, що перезаписує попередній, — не «такий самий», а «дубль у файлі»', () => {
  const bundle = buildBundle({ scenarios: [
    { name: 'S', url: 'u', recs: [{ name: 'a', subs: [] }] }, { name: 'S', url: 'u', recs: [{ name: 'b', subs: [] }] },
  ] });
  const pv = planPreview({ bundle, existingPages: [{ id: 1, name: 'S', url: 'u', recs: [{ id: 1, name: 'b', subs: [] }] }], selected: sets([], [0, 1]), onConflict: { scenarios: 'replace' } });
  assert.deepEqual(pv.scenarios.map((r) => r.chip.cls), ['replace', 'rename']);
});
