// Юніт-тести lib/transfer.js — бандл експорту/імпорту пресетів і сценаріїв, план конфліктів назв.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_FORMAT, BUNDLE_VERSION, NAME_MAX, SCENARIO_NAME_MAX, MAX_PRESETS, MAX_SCENARIOS, MAX_STEPS, MAX_DEPTH,
  normName, stableJson, sameValue, cleanPreset, cleanScenario, collectFileRefs, buildBundle,
  parseBundle, uniqueName, planImport, remapFileRefs, summarizeImport, presetBody, PRESET_BODY_KEYS,
} from '../lib/transfer.js';

const v2Click = { id: 's1', v: 2, type: 'click', x: 10, y: 20, sw: 1280, sh: 900, target: { locs: [{ kind: 'testid', value: 'go' }], pick: 0 } };
const fileStep = { id: 's2', v: 2, type: 'file', fileId: 'aaaaaaaa-1111', filename: 'cv.pdf' };
const page = (over = {}) => ({
  id: 7, name: 'Сценарій 1', url: 'https://example.com/', expanded: true, lastRun: { ok: 1 },
  recs: [{ id: 3, name: 'Дія 1', expanded: true, subs: [
    { ...v2Click, status: 'ok', strategy: 'loc', ms: 12, error: null, failShot: 'data:x', healed: true, fallback: false, pausing: true },
    { id: 'p', type: 'text', text: 'x', pending: true },
    fileStep,
  ] }],
  ...over,
});
const bundleOf = (over = {}) => ({ format: BUNDLE_FORMAT, version: 1, presets: [], scenarios: [], files: [], ...over });

// ---------- назви і порівняння ----------
test('normName: стискає й обрізає пробіли; null → ""', () => {
  assert.equal(normName('  a \n  b\t'), 'a b');
  assert.equal(normName(null), '');
  assert.equal(normName(5), '5');
});

test('stableJson/sameValue: без залежності від порядку ключів; undefined-поля ігноруються', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } }), stableJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
  assert.ok(sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameValue([1, 2], [2, 1]));
  assert.equal(stableJson(undefined), 'null');
});

// ---------- очищення ----------
test('cleanScenario: без id/expanded/lastRun, без pending-кроків і runtime-полів; id кроків лишаються', () => {
  const c = cleanScenario(page());
  assert.deepEqual(Object.keys(c).sort(), ['name', 'recs', 'url']);
  assert.deepEqual(Object.keys(c.recs[0]).sort(), ['name', 'subs']);
  assert.equal(c.recs[0].subs.length, 2);
  assert.deepEqual(c.recs[0].subs[0], v2Click);
  assert.equal(c.recs[0].subs[1].id, 's2');
});

test('cleanScenario: глибока копія (зміна результату не чіпає джерело), сміття в recs/subs відкидається', () => {
  const src = page();
  const c = cleanScenario(src);
  c.recs[0].subs[0].target.locs[0].value = 'zzz';
  assert.equal(src.recs[0].subs[0].target.locs[0].value, 'go');
  const d = cleanScenario({ name: ' A ', url: 5, recs: [null, 'x', { name: 'R', subs: [null, 3, { type: 'key', key: 'Enter' }] }] });
  assert.deepEqual(d, { name: 'A', url: '', recs: [{ name: 'R', subs: [{ type: 'key', key: 'Enter' }] }] });
  assert.deepEqual(cleanScenario(null), { name: '', url: '', recs: [] });
});

test('cleanPreset: лише name+body (без id/builtin), body — копія', () => {
  const p = { id: 1, builtin: true, name: ' 📋  Ashby ', body: { launch: { engine: 'chromium' } } };
  const c = cleanPreset(p);
  assert.deepEqual(c, { name: '📋 Ashby', body: { launch: { engine: 'chromium' } } });
  c.body.launch.engine = 'x';
  assert.equal(p.body.launch.engine, 'chromium');
  assert.deepEqual(cleanPreset({ name: 'x', body: [1] }).body, {});
});

// ---------- файли ----------
test('collectFileRefs: унікальні за fileId, лише type file з fileId', () => {
  const refs = collectFileRefs([
    page(),
    { recs: [{ subs: [{ ...fileStep, filename: 'other.pdf' }, { type: 'file', filename: 'nofid' }, { type: 'file', fileId: 'bbbbbbbbbb', filename: 'b.png' }, { type: 'click', fileId: 'cccccccccc' }] }] },
    null, { recs: null },
  ]);
  assert.deepEqual(refs, [{ fileId: 'aaaaaaaa-1111', filename: 'cv.pdf' }, { fileId: 'bbbbbbbbbb', filename: 'b.png' }]);
  assert.deepEqual(collectFileRefs(undefined), []);
});

test('remapFileRefs: підміняє fileId/filename у file-кроках; невідомі — як є; джерело не мутується', () => {
  const src = [cleanScenario(page()), { name: 'B', url: '', recs: [{ name: 'R', subs: [{ type: 'file', fileId: 'zzzzzzzzzz', filename: 'z' }] }] }];
  const out = remapFileRefs(src, { 'aaaaaaaa-1111': { fileId: 'new-id-12345', filename: 'cv (1).pdf' } });
  assert.deepEqual(out[0].recs[0].subs[1], { ...fileStep, fileId: 'new-id-12345', filename: 'cv (1).pdf' });
  assert.equal(out[0].recs[0].subs[0], src[0].recs[0].subs[0]); // не-file крок — той самий обʼєкт
  assert.deepEqual(out[1].recs[0].subs[0], { type: 'file', fileId: 'zzzzzzzzzz', filename: 'z' });
  assert.equal(src[0].recs[0].subs[1].fileId, 'aaaaaaaa-1111');
  // map без filename — лишається старий; прототипні ключі map не діють
  const o2 = remapFileRefs(src, { 'aaaaaaaa-1111': { fileId: 'q' } });
  assert.equal(o2[0].recs[0].subs[1].filename, 'cv.pdf');
  const o3 = remapFileRefs([{ recs: [{ subs: [{ type: 'file', fileId: 'constructor', filename: 'c' }] }] }], {});
  assert.equal(o3[0].recs[0].subs[0].fileId, 'constructor');
});

// ---------- buildBundle ----------
test('buildBundle: формат, версія, exportedAt, очищення, файли', () => {
  const b = buildBundle({
    presets: [{ id: 5, builtin: true, name: 'P', body: { launch: { headless: true } } }],
    scenarios: [page()],
    files: [{ fileId: 'f1', filename: 'a.pdf', size: 3, data: 'YWJj' }, { fileId: 'f2', filename: 'b.pdf', size: 9e9, data: null, skipped: 'too_large' }, { fileId: 'f3', filename: 'c', missing: true }],
    exportedAt: '2026-10-06T10:00:00.000Z',
  });
  assert.equal(b.format, BUNDLE_FORMAT);
  assert.equal(b.version, BUNDLE_VERSION);
  assert.equal(b.exportedAt, '2026-10-06T10:00:00.000Z');
  assert.deepEqual(b.presets, [{ name: 'P', body: { launch: { headless: true } } }]);
  assert.deepEqual(b.scenarios, [cleanScenario(page())]);
  assert.deepEqual(b.files, [
    { fileId: 'f1', filename: 'a.pdf', size: 3, data: 'YWJj' },
    { fileId: 'f2', filename: 'b.pdf', size: 9e9, data: null, skipped: 'too_large' },
    { fileId: 'f3', filename: 'c', size: 0, data: null, missing: true },
  ]);
  assert.match(buildBundle().exportedAt, /^\d{4}-\d\d-\d\dT/);
  // бандл проходить parseBundle без змін змісту
  const p = parseBundle(JSON.stringify(b));
  assert.ok(p.ok);
  assert.deepEqual(p.bundle.presets, b.presets);
  assert.deepEqual(p.bundle.scenarios, b.scenarios);
});

// ---------- parseBundle ----------
test('parseBundle: валідний рядок і обʼєкт; BOM; новий обʼєкт; невідомі поля ігноруються', () => {
  const raw = bundleOf({ extra: 1, presets: [{ name: ' A  b ', body: { launch: { x: 1 } }, id: 9, builtin: true }], scenarios: [{ name: 'S', url: 'u', id: 4, recs: [{ id: 1, name: ' R ', expanded: true, subs: [{ id: 'k', type: 'click', x: 1, y: 2, status: 'ok' }] }] }] });
  const r = parseBundle('﻿' + JSON.stringify(raw));
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.bundle.presets, [{ name: 'A b', body: { launch: { x: 1 } } }]);
  assert.deepEqual(r.bundle.scenarios, [{ name: 'S', url: 'u', recs: [{ name: 'R', subs: [{ id: 'k', type: 'click', x: 1, y: 2 }] }] }]);
  assert.equal(r.bundle.extra, undefined);
  const r2 = parseBundle(raw);
  assert.ok(r2.ok);
  assert.notEqual(r2.bundle.presets[0].body, raw.presets[0].body);
});

test('parseBundle: відсутні масиви → порожні з попередженням; url/recs/subs/назва Дії за замовчуванням', () => {
  const r = parseBundle({ format: BUNDLE_FORMAT, version: 1 });
  assert.ok(r.ok);
  assert.deepEqual(r.bundle.presets, []);
  assert.match(r.warnings[0], /немає ні пресетів, ні сценаріїв/);
  const r2 = parseBundle(bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: null }, { name: '  ' }] }] }));
  assert.ok(r2.ok);
  assert.deepEqual(r2.bundle.scenarios[0], { name: 'S', url: '', recs: [{ name: 'Дія 1', subs: [] }, { name: 'Дія 2', subs: [] }] });
});

test('parseBundle: не той формат / не JSON / не обʼєкт → людська помилка', () => {
  assert.deepEqual(parseBundle('{oops'), { ok: false, error: 'Файл не є коректним JSON' });
  for (const x of [null, [], 5, '[]', {}, { format: 'other', version: 1 }]) {
    const r = parseBundle(x);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Це не файл експорту Stealth Render Studio');
  }
});

test('parseBundle: версія — новіша за підтримувану або некоректна → помилка', () => {
  const r = parseBundle(bundleOf({ version: BUNDLE_VERSION + 1 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /новішою версією/);
  for (const v of [undefined, 0, '1', 1.5]) assert.equal(parseBundle(bundleOf({ version: v })).ok, false, String(v));
});

test('parseBundle: типи полів', () => {
  const bad = [
    bundleOf({ presets: {} }), bundleOf({ scenarios: 'x' }), bundleOf({ files: 1 }),
    bundleOf({ presets: [null] }), bundleOf({ presets: [{ name: 1, body: {} }] }), bundleOf({ presets: [{ name: '   ', body: {} }] }),
    bundleOf({ presets: [{ name: 'a' }] }), bundleOf({ presets: [{ name: 'a', body: [] }] }), bundleOf({ presets: [{ name: 'a', body: null }] }),
    bundleOf({ scenarios: [{ name: 'S', url: 5 }] }), bundleOf({ scenarios: [{ name: 'S', recs: {} }] }),
    bundleOf({ scenarios: [{ name: 'S', recs: ['x'] }] }), bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: {} }] }] }),
    bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: [null] }] }] }), bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: [[1]] }] }] }),
    bundleOf({ scenarios: [{ url: 'u' }] }),
    bundleOf({ files: [{ filename: 'a' }] }), bundleOf({ files: [{ fileId: 'f', data: 5 }] }), bundleOf({ files: [{ fileId: 'f', filename: 3 }] }), bundleOf({ files: ['x'] }),
  ];
  for (const b of bad) {
    const r = parseBundle(b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.equal(typeof r.error, 'string');
  }
  assert.match(parseBundle(bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: [1] }] }] })).error, /Сценарій №1 «S», Дія №1, крок №1/);
});

test('parseBundle: довгі назви обрізаються з попередженням (пресет — 80, сценарій — 200, як в UI)', () => {
  const long = 'Я'.repeat(NAME_MAX + 20);
  const r = parseBundle(bundleOf({ presets: [{ name: long, body: {} }], scenarios: [{ name: long + ' x', recs: [] }] }));
  assert.ok(r.ok);
  assert.equal(r.bundle.presets[0].name.length, NAME_MAX);
  assert.equal(r.bundle.scenarios[0].name, long + ' x'); // 102 символи — сценарію можна (≤ 200)
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Пресет №1: назву обрізано до 80/);
  const huge = 'Ж'.repeat(SCENARIO_NAME_MAX + 5);
  const r2 = parseBundle(bundleOf({ scenarios: [{ name: huge, recs: [] }] }));
  assert.equal(r2.bundle.scenarios[0].name.length, SCENARIO_NAME_MAX);
  assert.match(r2.warnings[0], /Сценарій №1: назву обрізано до 200/);
});

test('planImport: сценарій з назвою 81..200 символів — повторний імпорт = «такий самий» (пропуск), конфлікт → ≤ 200', () => {
  const name = 'Довга назва сценарію '.repeat(6).trim(); // > 80
  assert.ok(name.length > NAME_MAX && name.length <= SCENARIO_NAME_MAX);
  const ex = [{ id: 1, ...page({ name }) }];
  const parsed = parseBundle(buildBundle({ scenarios: ex })).bundle.scenarios;
  assert.deepEqual(planImport(ex, parsed, { kind: 'scenarios' }).map((p) => p.reason), ['identical']);
  const other = [{ ...parsed[0], url: 'https://other.example/' }];
  const plan = planImport(ex, other, { kind: 'scenarios' });
  assert.equal(plan[0].action, 'create');
  assert.ok(plan[0].name.endsWith(' (2)') && plan[0].name.length <= SCENARIO_NAME_MAX, plan[0].name);
  assert.ok(plan[0].name.length > NAME_MAX);
});

test('parseBundle: прототипні ключі (__proto__/constructor/prototype) не копіюються — глибоко', () => {
  const json = '{"format":"' + BUNDLE_FORMAT + '","version":1,'
    + '"presets":[{"name":"P","body":{"__proto__":{"polluted":1},"launch":{"constructor":{"x":1},"prototype":2,"ok":true}}}],'
    + '"scenarios":[{"name":"S","recs":[{"name":"R","subs":[{"type":"click","__proto__":{"polluted":2},"target":{"locs":[{"__proto__":{"polluted":3},"kind":"css"}]}}]}]}]}';
  const r = parseBundle(json);
  assert.ok(r.ok, r.error);
  const body = r.bundle.presets[0].body;
  assert.equal(Object.getPrototypeOf(body), Object.prototype);
  assert.equal(body.polluted, undefined);
  assert.deepEqual(Object.keys(body), ['launch']);
  assert.deepEqual(body.launch, { ok: true });
  const step = r.bundle.scenarios[0].recs[0].subs[0];
  assert.equal(step.polluted, undefined);
  assert.equal(step.target.locs[0].polluted, undefined);
  assert.equal(Object.getPrototypeOf(step.target.locs[0]), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('parseBundle: ліміти кількості і глибини → помилка', () => {
  assert.match(parseBundle(bundleOf({ presets: Array.from({ length: MAX_PRESETS + 1 }, (_, i) => ({ name: 'p' + i, body: {} })) })).error, /Забагато пресетів/);
  assert.match(parseBundle(bundleOf({ scenarios: Array.from({ length: MAX_SCENARIOS + 1 }, (_, i) => ({ name: 's' + i })) })).error, /Забагато сценаріїв/);
  assert.match(parseBundle(bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: Array.from({ length: MAX_STEPS + 1 }, () => ({ type: 'click' })) }] }] })).error, /забагато кроків/);
  assert.ok(parseBundle(bundleOf({ scenarios: [{ name: 'S', recs: [{ subs: Array.from({ length: MAX_STEPS }, () => ({ type: 'click' })) }] }] })).ok);
  let deep = {};
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { d: deep };
  assert.match(parseBundle(bundleOf({ presets: [{ name: 'P', body: { launch: deep } }] })).error, /глибоку вкладеність/);
});

test('parseBundle: pending- і runtime-поля кроків прибираються; NaN/Infinity → null', () => {
  const r = parseBundle(bundleOf({ scenarios: [{ name: 'S', recs: [{ name: 'R', subs: [{ type: 'text', pending: true }, { id: 'a', type: 'click', status: 'ok', failShot: 'x', pausing: true }] }] }] }));
  assert.deepEqual(r.bundle.scenarios[0].recs[0].subs, [{ id: 'a', type: 'click' }]);
  const r2 = parseBundle(bundleOf({ presets: [{ name: 'P', body: { launch: { n: NaN, i: Infinity, f: () => 1 } } }] }));
  assert.deepEqual(r2.bundle.presets[0].body, { launch: { n: null, i: null } });
});

test('parseBundle: файли — без data з missing/skipped → попередження; без прапорців — тихо', () => {
  const r = parseBundle(bundleOf({ files: [
    { fileId: 'f1', filename: 'a.pdf', size: 3, data: 'YWJj' },
    { fileId: 'f2', filename: 'big.pdf', size: 1e9, data: null, skipped: 'too_large' },
    { fileId: 'f3', filename: 'gone.pdf', data: null, missing: true },
    { fileId: 'f4', filename: 'stripped.pdf' },
  ], presets: [{ name: 'P', body: {} }] }));
  assert.ok(r.ok);
  assert.equal(r.bundle.files.length, 4);
  assert.equal(r.bundle.files[3].data, null);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /«big\.pdf» завеликий.*перевибору файлу/);
  assert.match(r.warnings[1], /«gone\.pdf» не знайдено.*перевибору файлу/);
});

// ---------- uniqueName ----------
test('uniqueName: вільна назва — як є; зайнята → (2), (3)…', () => {
  assert.equal(uniqueName('A', []), 'A');
  assert.equal(uniqueName(' A ', ['B']), 'A');
  assert.equal(uniqueName('A', ['A']), 'A (2)');
  assert.equal(uniqueName('A', ['A', 'A (2)', ' A  (3) ']), 'A (4)');
  assert.equal(uniqueName('A', new Set(['A'])), 'A (2)');
  assert.equal(uniqueName('a', ['A']), 'a'); // регістр враховується
});

test('uniqueName: продовжує з наявного суфікса (N)', () => {
  assert.equal(uniqueName('X (4)', ['X (4)']), 'X (5)');
  assert.equal(uniqueName('X (4)', ['X (4)', 'X (5)']), 'X (6)');
  assert.equal(uniqueName('(2)', ['(2)']), '(2) (2)'); // без основи — суфікс не розпізнається
});

test('uniqueName: результат ≤ 80 — обрізається основа, не суфікс', () => {
  const base = 'Б'.repeat(NAME_MAX);
  const u = uniqueName(base, [base]);
  assert.equal(u.length, NAME_MAX);
  assert.ok(u.endsWith(' (2)'));
  const taken = [base, u];
  const u3 = uniqueName(base, taken);
  assert.ok(u3.endsWith(' (3)') && u3.length <= NAME_MAX);
  assert.equal(uniqueName('abcdef', ['abcdef'], 8), 'abcd (2)');
  assert.equal(uniqueName('ab cdef', ['ab cdef'], 7), 'ab (2)'); // хвостовий пробіл основи прибирається
  // довша за max вільна назва обрізається
  assert.equal(uniqueName('x'.repeat(100), []).length, NAME_MAX);
});

// ---------- planImport ----------
const exPresets = [
  { id: 1, name: 'A', body: { launch: { engine: 'chromium', headless: true } }, builtin: true },
  { id: 2, name: 'B', body: { x: 1 } },
  { id: 3, name: 'B', body: { x: 2 } },
];

test('planImport: новий → create/new; однаковий зміст (інший порядок ключів) → skip/identical за будь-якої стратегії', () => {
  for (const onConflict of ['rename', 'replace', 'skip']) {
    const plan = planImport(exPresets, [{ name: 'A', body: { launch: { headless: true, engine: 'chromium' } } }, { name: 'C', body: {} }], { onConflict, kind: 'presets' });
    assert.deepEqual(plan, [
      { index: 0, action: 'skip', name: 'A', originalName: 'A', reason: 'identical' },
      { index: 1, action: 'create', name: 'C', originalName: 'C', reason: 'new' },
    ], onConflict);
  }
});

test('planImport: identical — з будь-яким із кількох однойменних існуючих', () => {
  const plan = planImport(exPresets, [{ name: 'B', body: { x: 2 } }], { onConflict: 'replace', kind: 'preset' });
  assert.equal(plan[0].action, 'skip');
  assert.equal(plan[0].reason, 'identical');
});

test('planImport: конфлікт назви — rename / replace (лише першого) / skip', () => {
  const inc = [{ name: 'B', body: { x: 9 } }];
  assert.deepEqual(planImport(exPresets, inc, { kind: 'presets' }), [{ index: 0, action: 'create', name: 'B (2)', originalName: 'B', reason: 'renamed' }]);
  assert.deepEqual(planImport(exPresets, inc, { onConflict: 'replace', kind: 'presets' }), [{ index: 0, action: 'replace', name: 'B', originalName: 'B', targetId: 2, reason: 'replaced' }]);
  assert.deepEqual(planImport(exPresets, inc, { onConflict: 'skip', kind: 'presets' }), [{ index: 0, action: 'skip', name: 'B', originalName: 'B', reason: 'skipped' }]);
  // невідома стратегія → rename
  assert.equal(planImport(exPresets, inc, { onConflict: 'boom', kind: 'presets' })[0].reason, 'renamed');
});

test('planImport: регістр назви враховується (як presetNameError); пробіли — ні', () => {
  const plan = planImport(exPresets, [{ name: 'b', body: { x: 9 } }, { name: ' B ', body: { x: 9 } }], { kind: 'presets' });
  assert.equal(plan[0].reason, 'new');
  assert.equal(plan[1].reason, 'renamed');
  assert.equal(plan[1].originalName, ' B ');
});

test('planImport: rename враховує і існуючі, і вже сплановані назви', () => {
  const ex = [{ id: 1, name: 'X', body: { a: 1 } }, { id: 2, name: 'X (2)', body: { a: 2 } }];
  const inc = [{ name: 'X', body: { a: 3 } }, { name: 'X (3)', body: { a: 4 } }, { name: 'Y', body: {} }, { name: 'X', body: { a: 5 } }];
  const plan = planImport(ex, inc, { kind: 'presets' });
  assert.deepEqual(plan.map((p) => [p.action, p.name, p.reason]), [
    ['create', 'X (3)', 'renamed'],        // X і X (2) зайняті
    ['create', 'X (4)', 'renamed'],        // «X (3)» уже зайняла перша — продовжуємо з (3)
    ['create', 'Y', 'new'],
    ['create', 'X (5)', 'duplicate_in_bundle'],
  ]);
});

test('planImport: дублікати назв усередині бандла — другий перейменовується навіть при replace; однаковий — пропуск', () => {
  const inc = [{ name: 'B', body: { x: 7 } }, { name: 'B', body: { x: 8 } }, { name: 'B', body: { x: 7 } }];
  const plan = planImport(exPresets, inc, { onConflict: 'replace', kind: 'presets' });
  assert.deepEqual(plan, [
    { index: 0, action: 'replace', name: 'B', originalName: 'B', targetId: 2, reason: 'replaced' },
    { index: 1, action: 'create', name: 'B (2)', originalName: 'B', reason: 'duplicate_in_bundle' },
    { index: 2, action: 'skip', name: 'B', originalName: 'B', reason: 'identical' },
  ]);
  // без існуючих: перший new, другий — duplicate_in_bundle
  const p2 = planImport([], [{ name: 'N', body: { a: 1 } }, { name: 'N', body: { a: 2 } }], { kind: 'presets' });
  assert.deepEqual(p2.map((p) => [p.action, p.name, p.reason]), [['create', 'N', 'new'], ['create', 'N (2)', 'duplicate_in_bundle']]);
  // skip-стратегія: конфлікт з існуючим → пропуск, навіть якщо назва повторюється в бандлі
  const p3 = planImport(exPresets, [{ name: 'B', body: { x: 7 } }, { name: 'B', body: { x: 8 } }], { onConflict: 'skip', kind: 'presets' });
  assert.deepEqual(p3.map((p) => p.reason), ['skipped', 'skipped']);
});

test('planImport: сценарії — зміст {url, recs[{name, subs}]} без id і runtime-полів', () => {
  const existing = [page({ id: 100 })];
  const same = cleanScenario(page()); // без id, без expanded/status/pending
  const plan = planImport(existing, [same], { kind: 'scenarios' });
  assert.equal(plan[0].reason, 'identical');
  // інший id Дії не важить; інша назва Дії — важить; інший id кроку — важить
  const otherRecName = { ...same, recs: [{ ...same.recs[0], name: 'Дія 2' }] };
  assert.equal(planImport(existing, [otherRecName], { kind: 'scenarios' })[0].reason, 'renamed');
  const otherStepId = { ...same, recs: [{ ...same.recs[0], subs: [{ ...same.recs[0].subs[0], id: 'zz' }, same.recs[0].subs[1]] }] };
  assert.equal(planImport(existing, [otherStepId], { kind: 'scenarios' })[0].reason, 'renamed');
  const otherUrl = { ...same, url: 'https://other/' };
  assert.deepEqual(planImport(existing, [otherUrl], { onConflict: 'replace', kind: 'scenarios' })[0], { index: 0, action: 'replace', name: 'Сценарій 1', originalName: 'Сценарій 1', targetId: 100, reason: 'replaced' });
});

test('planImport: kind виводиться з елементів; власний same; порожні входи', () => {
  assert.equal(planImport(exPresets, [{ name: 'B', body: { x: 1 } }])[0].reason, 'identical');
  assert.equal(planImport([{ id: 1, name: 'S', url: 'u', recs: [] }], [{ name: 'S', url: 'u', recs: [] }])[0].reason, 'identical');
  const plan = planImport(exPresets, [{ name: 'B', body: { x: 999 } }], { same: () => true });
  assert.equal(plan[0].reason, 'identical');
  assert.deepEqual(planImport(null, null), []);
});

// ---------- summarizeImport ----------
test('summarizeImport: український підсумок', () => {
  const report = {
    presets: [
      { action: 'create', reason: 'new' }, { action: 'create', reason: 'renamed' }, { action: 'skip', reason: 'identical' },
    ],
    scenarios: [
      { action: 'create', reason: 'new' }, { action: 'create', reason: 'duplicate_in_bundle' }, { action: 'replace', reason: 'replaced' },
    ],
  };
  assert.equal(summarizeImport(report), 'Імпортовано: пресетів 2 (1 перейменовано), сценаріїв 3 (1 перейменовано); пропущено однакових: 1; замінено: 1');
  assert.equal(summarizeImport({ presets: [{ action: 'create', reason: 'new' }, { action: 'create', reason: 'renamed' }], scenarios: [{ action: 'create' }, { action: 'create' }, { action: 'replace' }] }),
    'Імпортовано: пресетів 2 (1 перейменовано), сценаріїв 3; замінено: 1');
  assert.equal(summarizeImport({ scenarios: [{ action: 'skip', reason: 'skipped' }] }), 'Імпортовано: сценаріїв 0; пропущено через конфлікт назви: 1');
  assert.equal(summarizeImport({ presets: [{ action: 'skip', reason: 'no_db' }], scenarios: [{ action: 'create', reason: 'new' }] }),
    'Імпортовано: пресетів 0, сценаріїв 1; пресети не імпортовано (БД недоступна): 1');
  assert.equal(summarizeImport({}), 'Нічого не імпортовано: файл порожній');
  assert.equal(summarizeImport(null), 'Нічого не імпортовано: файл порожній');
});

// ---------- bundleFilename ----------
test('bundleFilename: presets / scenarios / all / назва одного (UTF-8 + ASCII-запасний)', async () => {
  const { bundleFilename } = await import('../lib/transfer.js');
  const now = new Date(2026, 9, 6, 12);
  const P = { name: '📋 Ashby', body: {} }, S = { name: 'Заявка Preply / CV', url: '', recs: [] };
  assert.deepEqual(bundleFilename({ presets: [P, P], scenarios: [] }, now), { filename: 'stealth-bundle-presets-2026-10-06.json', asciiFilename: 'stealth-bundle-presets-2026-10-06.json' });
  assert.equal(bundleFilename({ presets: [], scenarios: [S, S] }, now).filename, 'stealth-bundle-scenarios-2026-10-06.json');
  assert.equal(bundleFilename({ presets: [P], scenarios: [S] }, now).filename, 'stealth-bundle-all-2026-10-06.json');
  assert.equal(bundleFilename({}, now).filename, 'stealth-bundle-all-2026-10-06.json');
  assert.deepEqual(bundleFilename({ presets: [], scenarios: [S] }, now), { filename: 'stealth-bundle-заявка-preply-cv-2026-10-06.json', asciiFilename: 'stealth-bundle-preply-cv-2026-10-06.json' });
  assert.deepEqual(bundleFilename({ presets: [{ name: 'Хмара', body: {} }] }, now), { filename: 'stealth-bundle-хмара-2026-10-06.json', asciiFilename: 'stealth-bundle-preset-2026-10-06.json' });
  assert.equal(bundleFilename({ presets: [P] }, now).filename, 'stealth-bundle-ashby-2026-10-06.json');
  assert.match(bundleFilename({ scenarios: [{ name: 'Café\n"x"' }] }, now).asciiFilename, /^stealth-bundle-cafe-x-2026-10-06\.json$/);
});

// ---------- replace: «такий самий» — лише серед НЕзамінених існуючих ----------
test('planImport replace: елемент, однаковий з існуючим, який уже перезаписує попередній, — не губиться («X (2)»)', () => {
  const ex = [{ id: 1, name: 'X', body: { b: 1 } }];
  const plan = planImport(ex, [{ name: 'X', body: { a: 1 } }, { name: 'X', body: { b: 1 } }], { onConflict: 'replace', kind: 'presets' });
  assert.deepEqual(plan.map((p) => [p.action, p.name, p.reason]), [['replace', 'X', 'replaced'], ['create', 'X (2)', 'duplicate_in_bundle']]);
  // сценарії (назви не унікальні): той самий випадок
  const S = (recs) => ({ name: 'S', url: 'u', recs });
  const sp = planImport([{ id: 1, ...S([{ name: 'b', subs: [] }]) }], [S([{ name: 'a', subs: [] }]), S([{ name: 'b', subs: [] }])], { onConflict: 'replace', kind: 'scenarios' });
  assert.deepEqual(sp.map((p) => [p.action, p.name, p.targetId]), [['replace', 'S', 1], ['create', 'S (2)', undefined]]);
  // інший однойменний існуючий, якого НЕ замінено, лишається «таким самим»
  const ex2 = [{ id: 1, name: 'X', body: { c: 1 } }, { id: 2, name: 'X', body: { b: 1 } }];
  const p2 = planImport(ex2, [{ name: 'X', body: { a: 1 } }, { name: 'X', body: { b: 1 } }], { onConflict: 'replace', kind: 'presets' });
  assert.deepEqual(p2.map((p) => [p.action, p.reason]), [['replace', 'replaced'], ['skip', 'identical']]);
});

// ---------- білий список тіла пресета ----------
test('parseBundle: тіло пресета — лише launch/stealth/behavior/fingerprint/clear:true; cookies/storageState — геть з попередженням', () => {
  const r = parseBundle(bundleOf({ presets: [
    { name: 'Ashby', body: { launch: { engine: 'chromium' }, storageState: { cookies: [{ name: 'session', value: 'evil' }] }, cookies: null, fingerprint: null } },
    { name: 'Clear', body: { clear: true } },
    { name: 'Weird', body: { clear: 'yes', behavior: { humanize: true } } },
  ] }));
  assert.ok(r.ok);
  assert.deepEqual(r.bundle.presets[0].body, { launch: { engine: 'chromium' }, fingerprint: null });
  assert.ok(!('storageState' in r.bundle.presets[0].body) && !('cookies' in r.bundle.presets[0].body));
  assert.deepEqual(r.bundle.presets[1].body, { clear: true });
  assert.deepEqual(r.bundle.presets[2].body, { behavior: { humanize: true } });
  assert.ok(r.warnings.some((w) => /«Ashby».*storageState, cookies проігноровано/.test(w)), r.warnings.join('\n'));
  assert.ok(r.warnings.some((w) => /«Weird».*clear/.test(w)));
  assert.deepEqual([...PRESET_BODY_KEYS], ['launch', 'stealth', 'behavior', 'fingerprint', 'clear']);
});

test('cleanPreset (експорт): cookies/storageState не потрапляють у файл', () => {
  const p = { id: 5, name: 'P', body: { stealth: { webdriver: true }, storageState: { cookies: [{ name: 'a', value: 'secret' }] }, cookies: [{ name: 'b' }], clear: false } };
  assert.deepEqual(cleanPreset(p), { name: 'P', body: { stealth: { webdriver: true } } });
  assert.doesNotMatch(JSON.stringify(buildBundle({ presets: [p] })), /secret/);
  assert.deepEqual(presetBody(null), { body: {}, dropped: [] });
});

// ---------- NUL ----------
test('parseBundle: символ NUL (\\u0000) будь-де — помилка (Postgres його не прийме; імпорт упав би посеред запису)', () => {
  const S = (over = {}) => ({ name: 'S', url: 'u', recs: [{ name: 'R', subs: [{ type: 'text', text: 'x' }] }], ...over });
  const bad = [
    bundleOf({ presets: [{ name: 'a\u0000b', body: {} }] }),
    bundleOf({ presets: [{ name: 'P', body: { launch: { x: 'a\u0000' } } }] }),
    bundleOf({ presets: [{ name: 'P', body: { launch: { ['k\u0000']: 1 } } }] }),
    bundleOf({ scenarios: [S({ name: 'a\u0000b' })] }),
    bundleOf({ scenarios: [S({ url: 'http://x/\u0000' })] }),
    bundleOf({ scenarios: [S({ recs: [{ name: 'R\u0000', subs: [] }] })] }),
    bundleOf({ scenarios: [S({ recs: [{ name: 'R', subs: [{ type: 'text', text: 'x\u0000' }] }] })] }),
    bundleOf({ files: [{ fileId: 'f', filename: 'a\u0000.pdf', data: null }] }),
  ];
  for (const b of bad) {
    const r = parseBundle(JSON.stringify(b));
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.match(r.error, /NUL/);
  }
  assert.ok(parseBundle(bundleOf({ scenarios: [S()] })).ok);
});
