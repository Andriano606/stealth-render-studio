// HTTP-тести GET /export і POST /import (routes/transfer.js) через createApp з ФЕЙКОВИМИ engine/БД.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createSemaphore } from '../lib/semaphore.js';
import { createProfileStore } from '../lib/profile.js';
import { createRepos } from '../lib/db.js';
import { BUNDLE_FORMAT, parseBundle } from '../lib/transfer.js';
import { parseIdList } from '../routes/transfer.js';

const quiet = { log() {}, error() {} };

function fakeEngine() {
  return {
    engineReady: () => true,
    async takeUnit() { throw new Error('not used'); },
    async closeUnit() {}, async drainPool() {}, async relaunchBrowser() {},
    poolStats: () => ({ ready: 0, size: 0 }),
  };
}

// JSONB переставляє ключі — імітуємо (зворотний порядок), щоб «той самий» порівнювався без порядку.
const jsonb = (s) => {
  const re = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(re) : Object.keys(v).reverse().reduce((a, k) => { a[k] = re(v[k]); return a; }, {})) : v);
  return re(JSON.parse(s));
};

// Фейкова БД у памʼяті поверх createRepos (pages + presets): перевіряє і SQL-шар, і роут.
function memDb() {
  const pages = new Map();
  const presets = new Map();
  let seq = 0;
  const db = createRepos({
    async query(sql, p = []) {
      const s = sql.trim();
      if (/^SELECT id, name, url, recs FROM pages/.test(s)) return { rows: [...pages.values()].sort((a, b) => a.id - b.id).map((r) => ({ ...r, id: String(r.id) })) };
      if (/INSERT INTO pages/.test(s)) { pages.set(Number(p[0]), { id: Number(p[0]), name: p[1], url: p[2], recs: jsonb(p[3]) }); return { rows: [] }; }
      if (/DELETE FROM pages/.test(s)) { pages.delete(p[0]); return { rows: [] }; }
      if (/^SELECT id, name, body, builtin FROM presets/.test(s)) return { rows: [...presets.values()].sort((a, b) => a.pos - b.pos || a.id - b.id).map(({ pos: _p, ...r }) => ({ ...r, id: String(r.id) })) };
      if (/INSERT INTO presets/.test(s)) { const id = ++seq; presets.set(id, { id, name: p[0], body: jsonb(p[1]), builtin: false, pos: 100 }); return { rows: [{ id: String(id) }] }; }
      if (/UPDATE presets/.test(s)) {
        const x = presets.get(p[0]);
        if (!x) return { rows: [] };
        if (p[1] != null) x.name = p[1];
        if (p[2] != null) x.body = jsonb(p[2]);
        return { rows: [{ id: String(p[0]) }] };
      }
      return { rows: [] };
    },
  });
  db.seedPreset = (name, body, builtin = false, pos = 1) => { const id = ++seq; presets.set(id, { id, name, body, builtin, pos }); return id; };
  db.raw = { pages, presets };
  return db;
}

let tmp, uploadDir;
const servers = [];
async function startApp({ getDb = () => null, env = {}, configOver = {} } = {}) {
  const config = { ...loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: uploadDir, ...env }, tmp), ...configOver };
  const store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  const app = createApp({ config, engine: fakeEngine(), sem: createSemaphore(2), profileStore: store, getDb, log: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}

let base, db = null;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-transfer-'));
  uploadDir = path.join(tmp, 'uploads');
  base = await startApp({ getDb: () => db });
});
after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const importReq = (body) => fetch(base + '/import', json('POST', body));

// Файл «завантажено» в UPLOAD_DIR так само, як це робить /upload (<fileId>/<safeName>).
function putUpload(fileId, filename, content) {
  fs.mkdirSync(path.join(uploadDir, fileId), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, fileId, filename), content);
}

const FILE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILE_GONE = 'bbbbbbbb-0000-4000-8000-000000000002';
const scenario = (over = {}) => ({
  name: 'Заявка', url: 'https://x.test/apply',
  recs: [{ id: 3, name: 'Дія 1', expanded: true, subs: [
    { id: 's1', v: 2, type: 'click', x: 1, y: 2, status: 'ok', strategy: 'loc', ms: 5 },
    { id: 's2', v: 2, type: 'file', fileId: FILE_A, filename: 'cv.pdf' },
    { id: 's3', type: 'file', fileId: FILE_GONE, filename: 'gone.pdf' },
    { id: 'p', type: 'text', text: 'x', pending: true },
  ] }],
  ...over,
});

function seededDb() {
  const d = memDb();
  d.seedPreset('📋 Ashby', { launch: { engine: 'chromium', headless: true }, stealth: { webdriver: true } }, true, 4);
  d.seedPreset('Мій', { behavior: { humanize: false } }, false, 100);
  d.raw.pages.set(10, { id: 10, ...scenario() });
  d.raw.pages.set(11, { id: 11, name: 'Другий', url: 'https://y.test/', recs: [{ id: 7, name: 'Дія 1', subs: [] }] });
  return d;
}

test('parseIdList: all / список / порожньо / сміття', () => {
  assert.equal(parseIdList('all'), 'all');
  assert.deepEqual(parseIdList('1, 2,,3'), [1, 2, 3]);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.equal(parseIdList('1,x'), null);
  assert.equal(parseIdList('-1'), null);
});

test('GET /export: усе (без параметрів) — бандл без id/builtin/runtime-полів, файли base64, Content-Disposition', async () => {
  db = seededDb();
  putUpload(FILE_A, 'cv.pdf', 'PDF-BYTES');
  try {
    const r = await fetch(base + '/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const cd = r.headers.get('content-disposition');
    assert.match(cd, /^attachment; filename="stealth-bundle-all-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''stealth-bundle-all-\d{4}-\d{2}-\d{2}\.json$/);
    const b = await r.json();
    assert.equal(b.format, BUNDLE_FORMAT);
    assert.equal(b.version, 1);
    assert.ok(!Number.isNaN(Date.parse(b.exportedAt)));
    assert.deepEqual(b.presets.map((p) => p.name), ['📋 Ashby', 'Мій']);
    assert.deepEqual(Object.keys(b.presets[0]).sort(), ['body', 'name']);
    assert.equal(b.scenarios.length, 2);
    const s = b.scenarios[0];
    assert.deepEqual(Object.keys(s).sort(), ['name', 'recs', 'url']);
    assert.deepEqual(Object.keys(s.recs[0]).sort(), ['name', 'subs']);
    assert.deepEqual(s.recs[0].subs.map((x) => x.id), ['s1', 's2', 's3'], 'pending-крок прибрано, id кроків лишились');
    assert.deepEqual(s.recs[0].subs[0], { id: 's1', v: 2, type: 'click', x: 1, y: 2 });
    assert.deepEqual(b.files, [
      { fileId: FILE_A, filename: 'cv.pdf', size: 9, data: Buffer.from('PDF-BYTES').toString('base64') },
      { fileId: FILE_GONE, filename: 'gone.pdf', size: 0, data: null, missing: true },
    ]);
    assert.ok(!JSON.stringify(b).includes('cookies'), 'профіль/cookies не експортуються');
    assert.equal(parseBundle(b).ok, true);
  } finally { db = null; }
});

test('GET /export: вибір id, files=0, невідомі id ігноруються, назва одного елемента у файлі, 400 на сміття', async () => {
  db = seededDb();
  try {
    let r = await fetch(base + '/export?pages=10&presets=');
    let b = await r.json();
    assert.deepEqual(b.presets, []);
    assert.deepEqual(b.scenarios.map((s) => s.name), ['Заявка']);
    const cd = r.headers.get('content-disposition');
    assert.match(cd, /filename="stealth-bundle-scenario-\d{4}-\d{2}-\d{2}\.json"/, 'кирилиця → ASCII-запасний');
    assert.ok(cd.includes("filename*=UTF-8''" + encodeURIComponent('stealth-bundle-заявка-')), cd);

    r = await fetch(base + '/export?presets=1,999');
    b = await r.json();
    assert.deepEqual(b.presets.map((p) => p.name), ['📋 Ashby']);
    assert.deepEqual(b.scenarios, []);
    assert.match(r.headers.get('content-disposition'), /filename="stealth-bundle-ashby-/);

    b = await (await fetch(base + '/export?presets=all')).json();
    assert.equal(b.presets.length, 2);
    assert.match((await fetch(base + '/export?presets=all')).headers.get('content-disposition'), /stealth-bundle-presets-/);
    assert.match((await fetch(base + '/export?pages=all')).headers.get('content-disposition'), /stealth-bundle-scenarios-/);

    b = await (await fetch(base + '/export?pages=10&files=0')).json();
    assert.equal(b.files[0].data, null);
    assert.equal(b.files[0].skipped, 'excluded');
    assert.equal(b.files[1].missing, true);
    assert.ok(parseBundle(b).warnings.some((w) => /cv\.pdf.*перевибору/.test(w)));

    for (const q of ['pages=abc', 'presets=1;2', 'files=2']) {
      r = await fetch(base + '/export?' + q);
      assert.equal(r.status, 400, q);
      assert.equal((await r.json()).ok, false);
    }
  } finally { db = null; }
});

test('GET /export: сумарний ліміт файлів → skipped:too_large (data:null)', async () => {
  const d = memDb();
  const FILE_B = 'cccccccc-0000-4000-8000-000000000003';
  putUpload(FILE_A, 'cv.pdf', 'PDF-BYTES');      // 9 байт
  putUpload(FILE_B, 'big.bin', 'X'.repeat(20));  // 20 байт
  d.raw.pages.set(1, { id: 1, name: 'S', url: '', recs: [{ id: 1, name: 'Дія 1', subs: [
    { id: 'a', type: 'file', fileId: FILE_A, filename: 'cv.pdf' },
    { id: 'b', type: 'file', fileId: FILE_B, filename: 'big.bin' },
    { id: 'c', type: 'file', fileId: FILE_A, filename: 'cv.pdf' }, // дубль fileId — один запис
  ] }] });
  const b2 = await startApp({ getDb: () => d, configOver: { EXPORT_FILES_MAX_BYTES: 15 } });
  const b = await (await fetch(b2 + '/export?pages=all')).json();
  assert.equal(b.files.length, 2);
  assert.equal(b.files[0].data, Buffer.from('PDF-BYTES').toString('base64'));
  assert.deepEqual(b.files[1], { fileId: FILE_B, filename: 'big.bin', size: 20, data: null, skipped: 'too_large' });
});

test('GET /export без БД: пресетів немає, сценарії — з памʼяті процесу (спільне сховище з /pages)', async () => {
  await fetch(base + '/pages/5', json('PUT', { name: 'Памʼять', url: 'https://m.test', recs: [{ id: 1, name: 'Дія 1', subs: [] }] }));
  try {
    const b = await (await fetch(base + '/export')).json();
    assert.deepEqual(b.presets, []);
    assert.deepEqual(b.scenarios, [{ name: 'Памʼять', url: 'https://m.test', recs: [{ name: 'Дія 1', subs: [] }] }]);
  } finally { await fetch(base + '/pages/5', { method: 'DELETE' }); }
});

test('POST /import: експорт → імпорт у той самий стан = усе «identical» (порядок ключів JSONB не важить)', async () => {
  db = seededDb();
  try {
    const bundle = await (await fetch(base + '/export?files=0')).json();
    const r = await importReq({ bundle });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.dryRun, false);
    assert.equal(d.db, true);
    assert.deepEqual(d.presets.map((p) => [p.action, p.reason]), [['skip', 'identical'], ['skip', 'identical']]);
    assert.deepEqual(d.scenarios.map((p) => [p.action, p.reason]), [['skip', 'identical'], ['skip', 'identical']]);
    assert.equal(db.raw.presets.size, 2);
    assert.equal(db.raw.pages.size, 2);
    assert.match(d.summary, /пропущено однакових: 4/);
  } finally { db = null; }
});

const changedBundle = () => ({
  format: BUNDLE_FORMAT, version: 1,
  presets: [{ name: '📋 Ashby', body: { launch: { engine: 'camoufox' } } }, { name: 'Новий', body: { behavior: { humanize: true } } }],
  scenarios: [{ name: 'Заявка', url: 'https://x.test/other', recs: [{ name: 'Дія A', subs: [{ id: 'k', type: 'key', key: 'Enter' }] }, { name: 'Дія B', subs: [] }] }],
  files: [],
});

test('POST /import: конфлікт назви — rename (за замовч.): «X (2)», нові id сторінок/Дій', async () => {
  db = seededDb();
  try {
    const before = Date.now();
    const d = await (await importReq({ bundle: changedBundle() })).json();
    assert.deepEqual(d.presets.map(({ id: _id, ...p }) => p), [
      { index: 0, action: 'create', name: '📋 Ashby (2)', originalName: '📋 Ashby', reason: 'renamed' },
      { index: 1, action: 'create', name: 'Новий', originalName: 'Новий', reason: 'new' },
    ]);
    assert.ok(d.presets.every((p) => Number.isInteger(p.id)));
    const created = db.raw.presets.get(d.presets[0].id);
    assert.equal(created.name, '📋 Ashby (2)');
    assert.deepEqual(created.body, { launch: { engine: 'camoufox' } });
    assert.equal(created.builtin, false);
    assert.equal(db.raw.presets.get(1).name, '📋 Ashby', 'існуючий не чіпаємо');

    const sc = d.scenarios[0];
    assert.equal(sc.action, 'create');
    assert.equal(sc.name, 'Заявка (2)');
    assert.ok(sc.id >= before && sc.id > 11, 'id сторінки ≥ Date.now() і > max наявних');
    const page = db.raw.pages.get(sc.id);
    assert.deepEqual(page.recs.map((r) => r.id), [8, 9], 'id Дій > max id Дій серед усіх сторінок (7)');
    assert.deepEqual(page.recs[0].subs, [{ id: 'k', type: 'key', key: 'Enter' }]);
    assert.equal(page.url, 'https://x.test/other');
    assert.equal(d.summary, 'Імпортовано: пресетів 2 (1 перейменовано), сценаріїв 1 (1 перейменовано)');
    // GET /pages бачить імпортований
    assert.ok((await (await fetch(base + '/pages')).json()).pages.some((p) => p.id === sc.id));
  } finally { db = null; }
});

test('POST /import: replace — оновлює перший з такою назвою (id той самий); skip — пропускає', async () => {
  db = seededDb();
  try {
    let d = await (await importReq({ bundle: changedBundle(), onConflict: { presets: 'replace', scenarios: 'replace' } })).json();
    assert.deepEqual([d.presets[0].action, d.presets[0].targetId, d.presets[0].id, d.presets[0].reason], ['replace', 1, 1, 'replaced']);
    assert.deepEqual(db.raw.presets.get(1).body, { launch: { engine: 'camoufox' } });
    assert.equal(db.raw.presets.get(1).name, '📋 Ashby');
    assert.deepEqual([d.scenarios[0].action, d.scenarios[0].id], ['replace', 10]);
    assert.equal(db.raw.pages.get(10).url, 'https://x.test/other');
    assert.deepEqual(db.raw.pages.get(10).recs.map((r) => r.name), ['Дія A', 'Дія B']);
    assert.equal(db.raw.pages.size, 2);
    assert.match(d.summary, /замінено: 2/);

    db = seededDb();
    d = await (await importReq({ bundle: changedBundle(), onConflict: { presets: 'skip', scenarios: 'skip' } })).json();
    assert.deepEqual(d.presets.map((p) => [p.action, p.reason]), [['skip', 'skipped'], ['create', 'new']]);
    assert.deepEqual(d.scenarios.map((p) => [p.action, p.reason]), [['skip', 'skipped']]);
    assert.equal(db.raw.presets.size, 3);
    assert.equal(db.raw.pages.size, 2);
    assert.equal(db.raw.pages.get(10).url, 'https://x.test/apply');
  } finally { db = null; }
});

test('POST /import: дві однакові назви в бандлі — друга перейменовується навіть при replace', async () => {
  db = seededDb();
  try {
    const bundle = { format: BUNDLE_FORMAT, version: 1, presets: [
      { name: 'Мій', body: { behavior: { v: 1 } } }, { name: 'Мій', body: { behavior: { v: 2 } } },
    ] };
    const d = await (await importReq({ bundle, onConflict: { presets: 'replace' } })).json();
    assert.deepEqual(d.presets.map((p) => [p.action, p.name, p.reason]), [['replace', 'Мій', 'replaced'], ['create', 'Мій (2)', 'duplicate_in_bundle']]);
    assert.deepEqual(db.raw.presets.get(2).body, { behavior: { v: 1 } });
  } finally { db = null; }
});

test('POST /import: select — лише вибрані; index у відповіді = індекс у бандлі', async () => {
  db = seededDb();
  try {
    const d = await (await importReq({ bundle: changedBundle(), select: { presets: [1], scenarios: [] } })).json();
    assert.deepEqual(d.presets.map((p) => [p.index, p.name, p.action]), [[1, 'Новий', 'create']]);
    assert.deepEqual(d.scenarios, []);
    assert.equal(db.raw.presets.size, 3);
    assert.equal(db.raw.pages.size, 2);
  } finally { db = null; }
});

test('POST /import: dryRun нічого не пише (ні БД, ні памʼять), план той самий', async () => {
  db = seededDb();
  try {
    const d = await (await importReq({ bundle: changedBundle(), dryRun: true })).json();
    assert.equal(d.dryRun, true);
    assert.deepEqual(d.presets.map((p) => [p.action, p.name]), [['create', '📋 Ashby (2)'], ['create', 'Новий']]);
    assert.ok(d.presets.every((p) => p.id === undefined));
    assert.equal(db.raw.presets.size, 2);
    assert.equal(db.raw.pages.size, 2);
  } finally { db = null; }
  const d = await (await importReq({ bundle: changedBundle(), dryRun: true })).json();
  assert.equal(d.db, false);
  assert.equal(d.scenarios[0].action, 'create');
  assert.deepEqual((await (await fetch(base + '/pages')).json()).pages, []);
});

test('POST /import без БД: пресети → skip no_db + попередження; сценарії — у памʼять процесу (видно в /pages)', async () => {
  const d = await (await importReq({ bundle: changedBundle() })).json();
  assert.equal(d.db, false);
  assert.deepEqual(d.presets.map((p) => [p.action, p.reason]), [['skip', 'no_db'], ['skip', 'no_db']]);
  assert.ok(d.warnings.includes('БД недоступна — пресети не імпортовано'));
  assert.equal(d.scenarios[0].action, 'create');
  assert.equal(d.scenarios[0].name, 'Заявка');
  const pages = (await (await fetch(base + '/pages')).json()).pages;
  assert.equal(pages.length, 1);
  assert.equal(pages[0].id, d.scenarios[0].id);
  assert.deepEqual(pages[0].recs.map((r) => [r.id, r.name]), [[1, 'Дія A'], [2, 'Дія B']]);
  assert.match(d.summary, /пресети не імпортовано \(БД недоступна\): 2/);
  // повторний імпорт → identical
  const again = await (await importReq({ bundle: changedBundle() })).json();
  assert.deepEqual(again.scenarios.map((p) => p.reason), ['identical']);
  await fetch(base + '/pages/' + pages[0].id, { method: 'DELETE' });
});

test('POST /import: крок файлу, якого немає на сервері → попередження; наявний — без', async () => {
  putUpload(FILE_A, 'cv.pdf', 'PDF-BYTES');
  const bundle = { format: BUNDLE_FORMAT, version: 1, scenarios: [scenario({ name: 'З файлами' })] };
  const d = await (await importReq({ bundle, dryRun: true })).json();
  assert.equal(d.warnings.filter((w) => /відсутній на сервері/.test(w)).length, 1);
  assert.ok(d.warnings.some((w) => w.includes('gone.pdf')));
});

test('POST /import: 400 на сміття (людський текст), невалідний onConflict/select', async () => {
  const cases = [
    [{}, /Немає даних/],
    [{ bundle: { format: 'other', version: 1 } }, /не файл експорту Stealth Render Studio/],
    [{ bundle: '{not json' }, /коректним JSON/],
    [{ bundle: { format: BUNDLE_FORMAT, version: 99 } }, /новішою версією/],
    [{ bundle: { format: BUNDLE_FORMAT, version: 1, presets: [{ name: '', body: {} }] } }, /порожньою/],
    [{ bundle: changedBundle(), onConflict: { presets: 'merge' } }, /onConflict\.presets/],
    [{ bundle: changedBundle(), onConflict: 'rename' }, /onConflict/],
    [{ bundle: changedBundle(), select: { scenarios: [-1] } }, /select\.scenarios/],
    [{ bundle: changedBundle(), select: [0] }, /select/],
  ];
  for (const [body, re] of cases) {
    const r = await importReq(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.match(j.error, re);
  }
  const r = await fetch(base + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"bundle":' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /некоректний JSON/);
  assert.deepEqual((await (await fetch(base + '/pages')).json()).pages, []);
});

test('POST /import: власний ліміт 20mb (глобальний 2mb для інших роутів лишається)', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const bundle = { format: BUNDLE_FORMAT, version: 1, scenarios: [{ name: 'Великий', url: '', recs: [{ name: 'Дія 1', subs: [{ id: 'a', type: 'text', text: big }] }] }] };
  const r = await importReq({ bundle, dryRun: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).scenarios[0].action, 'create');
  const p = await fetch(base + '/pages/1', json('PUT', { name: 'x', url: '', recs: [{ subs: [{ text: big }] }] }));
  assert.equal(p.status, 413);
  const b3 = await startApp({ configOver: { IMPORT_JSON_LIMIT: '1kb' } });
  const t = await fetch(b3 + '/import', json('POST', { bundle, dryRun: true }));
  assert.equal(t.status, 413);
  assert.match((await t.json()).error, /завеликий/);
});

test('POST /import: guard — крос-сайтовий Origin → 403, нічого не імпортовано', async () => {
  const r = await fetch(base + '/import', json('POST', { bundle: changedBundle() }, { Origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
  assert.deepEqual((await (await fetch(base + '/pages')).json()).pages, []);
  const ok = await fetch(base + '/import', json('POST', { bundle: changedBundle(), dryRun: true }, { Origin: base }));
  assert.equal(ok.status, 200);
});

test('POST /import replace: однаковий з існуючим, який перезаписує попередній елемент, — створюється «S (2)», зміст не губиться', async () => {
  db = memDb();
  db.raw.pages.set(1, { id: 1, name: 'S', url: 'u', recs: [{ id: 1, name: 'b', subs: [] }] });
  try {
    const bundle = { format: BUNDLE_FORMAT, version: 1, scenarios: [
      { name: 'S', url: 'u', recs: [{ name: 'a', subs: [] }] }, { name: 'S', url: 'u', recs: [{ name: 'b', subs: [] }] },
    ] };
    const d = await (await importReq({ bundle, onConflict: { scenarios: 'replace' } })).json();
    assert.deepEqual(d.scenarios.map((p) => [p.action, p.name]), [['replace', 'S'], ['create', 'S (2)']]);
    const recNames = [...db.raw.pages.values()].map((p) => p.name + ':' + p.recs.map((r) => r.name).join(','));
    assert.deepEqual(recNames.sort(), ['S (2):b', 'S:a']);
  } finally { db = null; }
});

test('POST /import: тіло пресета — без cookies/storageState (попередження); NUL у бандлі → 400, нічого не записано', async () => {
  db = memDb();
  try {
    const bundle = { format: BUNDLE_FORMAT, version: 1, presets: [
      { name: 'P', body: { launch: { headless: true }, storageState: { cookies: [{ name: 's', value: 'evil', domain: '.x' }] }, cookies: null } },
    ] };
    const d = await (await importReq({ bundle })).json();
    assert.equal(d.presets[0].action, 'create');
    assert.deepEqual(db.raw.presets.get(d.presets[0].id).body, { launch: { headless: true } });
    assert.ok(d.warnings.some((w) => /storageState, cookies проігноровано/.test(w)));
    const bad = { format: BUNDLE_FORMAT, version: 1, scenarios: [{ name: 'S', url: '', recs: [{ name: 'R', subs: [{ type: 'text', text: 'a\u0000b' }] }] }] };
    const r = await importReq({ bundle: bad });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /NUL/);
    assert.equal(db.raw.pages.size, 0);
  } finally { db = null; }
});

test('POST /import: запис — однією транзакцією (db.tx); збій посередині → 500 і нічого не записано', async () => {
  const d0 = seededDb();
  // Фейкова транзакція: знімок сховища, відкат при помилці; upsert сценарію «boom» падає (як Postgres).
  const upsert = d0.pages.upsert;
  d0.pages.upsert = async (id, page) => { if (page.name === 'boom') throw new Error('invalid byte sequence'); return upsert(id, page); };
  let txCalls = 0;
  d0.tx = async (fn) => {
    txCalls++;
    const snap = { pages: new Map([...d0.raw.pages].map(([k, v]) => [k, structuredClone(v)])), presets: new Map([...d0.raw.presets].map(([k, v]) => [k, structuredClone(v)])) };
    try { return await fn(d0); } catch (e) {
      d0.raw.pages.clear(); for (const [k, v] of snap.pages) d0.raw.pages.set(k, v);
      d0.raw.presets.clear(); for (const [k, v] of snap.presets) d0.raw.presets.set(k, v);
      throw e;
    }
  };
  db = d0;
  try {
    const bundle = { format: BUNDLE_FORMAT, version: 1,
      presets: [{ name: 'Новий', body: { behavior: { humanize: true } } }],
      scenarios: [{ name: 'ok', url: 'u', recs: [] }, { name: 'boom', url: 'u', recs: [] }] };
    const r = await importReq({ bundle });
    assert.equal(r.status, 500);
    assert.equal(txCalls, 1);
    assert.equal(d0.raw.presets.size, 2);
    assert.deepEqual([...d0.raw.pages.keys()].sort(), [10, 11]);
    // успішний імпорт теж іде через tx, звіт — з id
    const ok = await (await importReq({ bundle: { ...bundle, scenarios: [bundle.scenarios[0]] } })).json();
    assert.equal(txCalls, 2);
    assert.ok(ok.presets[0].id > 0 && ok.scenarios[0].id > 0);
    assert.equal(d0.raw.pages.get(ok.scenarios[0].id).name, 'ok');
  } finally { db = null; }
});

// ---------- Проксі в бандлі ----------
async function startProxyApp(proxy) {
  const dir = fs.mkdtempSync(path.join(tmp, 'px-'));
  const config = loadConfig({ PROFILE_FILE: path.join(dir, 'profile.json'), UPLOAD_DIR: uploadDir }, dir);
  const store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  if (proxy) store.set({ ...store.get(), proxy });
  const engine = { ...fakeEngine(), relaunches: 0 };
  engine.relaunchBrowser = async () => { engine.relaunches++; };
  const app = createApp({ config, engine, sem: createSemaphore(2), profileStore: store, getDb: () => null, log: quiet });
  const server = await new Promise((r) => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)); });
  servers.push(server);
  return { url: 'http://127.0.0.1:' + server.address().port, store, engine };
}
const PROXY_FULL = { server: 'http://h.test:3128', username: 'u', password: 'p@ss:w0rd', bypass: 'localhost', enabled: false };

test('GET /export: proxy=1 — проксі цілим (з логіном і паролем), окремо від пресетів; proxy=0 / експорт сценарію — без; «усе» без параметрів — з проксі', async () => {
  const { url } = await startProxyApp(PROXY_FULL);
  const withPx = await (await fetch(url + '/export?presets=all&pages=all&files=0&proxy=1')).json();
  assert.deepEqual(withPx.proxy, PROXY_FULL);
  const noPx = await (await fetch(url + '/export?presets=all&pages=all&files=0&proxy=0')).json();
  assert.equal('proxy' in noPx, false);
  assert.equal('proxy' in await (await fetch(url + '/export?presets=&pages=1&files=1')).json(), false, 'без proxy= → не додаємо');
  assert.deepEqual((await (await fetch(url + '/export')).json()).proxy, PROXY_FULL);
  assert.equal((await fetch(url + '/export?proxy=2')).status, 400);
  const { url: url2 } = await startProxyApp(null);
  assert.equal('proxy' in await (await fetch(url2 + '/export?presets=&pages=&proxy=1')).json(), false, 'проксі не налаштовано');
});

test('POST /import: проксі з файлу — застосовано цілком (пароль, тумблер) + перезапуск; такий самий — пропуск; не вибрано — пропуск; dryRun — без змін', async () => {
  const { url, store, engine } = await startProxyApp({ server: 'http://old.test:1', username: 'old', password: 'oldpw' });
  const bundle = { format: BUNDLE_FORMAT, version: 1, proxy: PROXY_FULL };
  const post = (body) => fetch(url + '/import', json('POST', body)).then((r) => r.json());
  const dry = await post({ bundle, dryRun: true });
  assert.deepEqual({ action: dry.proxy.action, reason: dry.proxy.reason }, { action: 'replace', reason: 'replaced' });
  assert.equal(store.get().proxy.server, 'http://old.test:1', 'dryRun нічого не міняє');
  const off = await post({ bundle, select: { proxy: false } });
  assert.equal(off.proxy.reason, 'not_selected');
  assert.equal(store.get().proxy.server, 'http://old.test:1');
  const r = await post({ bundle });
  assert.equal(r.proxy.action, 'replace');
  assert.equal(r.proxy.relaunched, true);
  assert.equal(engine.relaunches, 1);
  assert.deepEqual(store.get().proxy, PROXY_FULL);
  assert.equal(JSON.stringify(r).includes('p@ss:w0rd'), false, 'у відповіді пароля немає');
  assert.match(r.summary, /проксі/);
  const again = await post({ bundle });
  assert.equal(again.proxy.reason, 'identical');
  assert.equal(engine.relaunches, 1, 'такий самий — без перезапуску');
  // проксі у файлі без пароля → пароль прибирається (а не лишається старий)
  await post({ bundle: { ...bundle, proxy: { server: 'h.test:3128', username: 'u' } } });
  assert.equal(store.get().proxy.password, undefined);
});
