// HTTP-тести застосунку (lib/app.js createApp) з ФЕЙКОВИМИ залежностями — без браузера і БД.
// Перевіряють, що формати /health, /profile, /pages, /presets, /render, /replay не змінились.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createSemaphore } from '../lib/semaphore.js';
import { createProfileStore, defaultProfile, PLAYWRIGHT_DEFAULTS } from '../lib/profile.js';
import { createRepos } from '../lib/db.js';

const quiet = { log() {}, error() {} };

// Фейкова сторінка Playwright: достатньо для gotoSmart/settle/screenshot.
function fakePage() {
  let url = 'about:blank';
  const frame = { async evaluate(fn) { return String(fn).includes('innerText.length') ? 100 : ''; } };
  return {
    async goto(u) { url = u; return { status: () => 200 }; },
    async title() { return 'Fake title'; },
    async content() { return '<html><body>hi</body></html>'; },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('querySelector')) return false;
      if (s.includes('innerWidth')) return { innerWidth: 1280, innerHeight: 900, dpr: 1, scrollW: 1280, scrollH: 900, w: 1280, h: 900, sw: 1280, sh: 900 };
      return 'hello body';
    },
    frames() { return [frame]; },
    mainFrame() { return frame; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async screenshot() { return Buffer.from('JPEGDATA'); },
    url() { return url; },
    mouse: { async move() {}, async down() {}, async up() {}, async click() {}, async wheel() {} },
    keyboard: { async type() {}, async press() {} },
  };
}

function fakeEngine() {
  const e = {
    calls: [], ready: true, closed: 0,
    engineReady() { return e.ready; },
    async takeUnit() { e.calls.push('take'); return { context: {}, page: fakePage(), fromPool: true }; },
    async closeUnit() { e.closed++; },
    async drainPool() { e.calls.push('drain'); },
    async relaunchBrowser() { e.calls.push('relaunch'); },
    poolStats() { return { ready: 2, size: 3 }; },
  };
  return e;
}

// Фейкова БД у пам'яті поверх createRepos (перевіряє і SQL-шар, і роут).
function memDb() {
  const pages = new Map();
  return createRepos({
    async query(sql, p) {
      if (/^SELECT id, name, url, recs FROM pages/.test(sql.trim())) return { rows: [...pages.values()].sort((a, b) => a.id - b.id).map((r) => ({ ...r, id: String(r.id) })) };
      if (/INSERT INTO pages/.test(sql)) { pages.set(p[0], { id: p[0], name: p[1], url: p[2], recs: JSON.parse(p[3]) }); return { rows: [] }; }
      if (/DELETE FROM pages/.test(sql)) { pages.delete(p[0]); return { rows: [] }; }
      return { rows: [] };
    },
  });
}

let tmp, server, base, engine, sem, store, db = null;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-app-'));
  const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  engine = fakeEngine();
  sem = createSemaphore(2);
  store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  const app = createApp({ config, engine, sem, profileStore: store, getDb: () => db, log: quiet });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /health', async () => {
  const d = await (await fetch(base + '/health')).json();
  assert.deepEqual(d, { ok: true, active: 0, poolReady: 2, poolSize: 3, db: false, sessions: 0 });
});

test('GET / віддає фронтенд з Cache-Control: no-cache + ETag (ревалідація); API — no-store', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html/i);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const etag = r.headers.get('etag');
  assert.ok(etag, 'є ETag для умовних запитів');
  // Незмінений файл → 304. (Через node:http, бо fetch з ручним If-None-Match сам додає
  // «cache-control: no-cache», а такий запит за стандартом ніколи не отримує 304.)
  const status304 = await new Promise((resolve, reject) => {
    http.get(base + '/', { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status304, 304);
  for (const p of ['/js/scenarios.js', '/css/components.css']) {
    const x = await fetch(base + p);
    assert.equal(x.status, 200, p);
    assert.equal(x.headers.get('cache-control'), 'no-cache', p);
  }
  assert.equal((await fetch(base + '/health')).headers.get('cache-control'), 'no-store');
});

test('GET /profile — формат fullConfig', async () => {
  const d = await (await fetch(base + '/profile')).json();
  assert.equal(d.ok, true);
  assert.deepEqual(d.launch, defaultProfile().launch);
  assert.deepEqual(d.defaults, JSON.parse(JSON.stringify(PLAYWRIGHT_DEFAULTS)));
  assert.equal(d.cookiesCount, 0);
  assert.equal(d.hasFingerprint, false);
});

test('POST /profile: fingerprint → drain (без перезапуску), збережено у файл', async () => {
  engine.calls.length = 0;
  const d = await (await fetch(base + '/profile', json('POST', { fingerprint: { locale: 'uk' } }))).json();
  assert.equal(d.ok, true);
  assert.equal(d.relaunched, false);
  assert.equal(d.launchError, null);
  assert.equal(d.hasFingerprint, true);
  assert.deepEqual(engine.calls, ['drain']);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'profile.json'), 'utf8'));
  assert.deepEqual(saved.fingerprint, { locale: 'uk' });
});

test('POST /profile: зміна launch → relaunch; рушій не піднявся → launchError', async () => {
  engine.calls.length = 0;
  engine.ready = false;
  const d = await (await fetch(base + '/profile', json('POST', { launch: { engine: 'camoufox' } }))).json();
  engine.ready = true;
  assert.equal(d.relaunched, true);
  assert.match(d.launchError, /не запустився/);
  assert.equal(d.launch.engine, 'camoufox');
  assert.deepEqual(engine.calls, ['relaunch']);
  await fetch(base + '/profile', json('POST', { launch: { engine: 'chromium' } }));
});

test('/pages без БД: сховище в памʼяті процесу (db:false, memory:true) — PUT → GET → DELETE', async () => {
  db = null;
  assert.deepEqual(await (await fetch(base + '/pages')).json(), { ok: true, db: false, memory: true, pages: [] });
  const recs = [{ id: 1, name: 'Дія 1', subs: [{ type: 'click', x: 1, y: 2 }] }];
  assert.deepEqual(await (await fetch(base + '/pages/2', json('PUT', { name: 'B', url: 'u2', recs }))).json(), { ok: true, db: false, memory: true });
  assert.deepEqual(await (await fetch(base + '/pages/1', json('PUT', { name: 'A', url: 'u', recs: [] }))).json(), { ok: true, db: false, memory: true });
  const d = await (await fetch(base + '/pages')).json();
  assert.deepEqual(d.pages.map((p) => p.id), [1, 2]);
  assert.deepEqual(d.pages[1], { id: 2, name: 'B', url: 'u2', recs });
  assert.deepEqual(await (await fetch(base + '/pages/1', { method: 'DELETE' })).json(), { ok: true, db: false, memory: true });
  await fetch(base + '/pages/2', { method: 'DELETE' });
  assert.deepEqual((await (await fetch(base + '/pages')).json()).pages, []);
});

test('/pages з БД: PUT → GET → DELETE (recs зберігаються як є)', async () => {
  db = memDb();
  try {
    const recs = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-scenario.json', import.meta.url), 'utf8')).recs;
    assert.deepEqual(await (await fetch(base + '/pages/5', json('PUT', { name: 'Заявка', url: 'https://x.test', recs }))).json(), { ok: true, db: true });
    const d = await (await fetch(base + '/pages')).json();
    assert.equal(d.db, true);
    assert.equal(d.pages[0].id, 5);
    assert.deepEqual(d.pages[0].recs, recs);
    await fetch(base + '/pages/5', { method: 'DELETE' });
    assert.deepEqual((await (await fetch(base + '/pages')).json()).pages, []);
  } finally { db = null; }
});

test('/presets без БД: GET порожньо, POST → 503 {ok:false}', async () => {
  assert.deepEqual(await (await fetch(base + '/presets')).json(), { ok: true, db: false, presets: [] });
  const r = await fetch(base + '/presets', json('POST', { name: 'x', body: {} }));
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'БД недоступна' });
});

test('DELETE /presets/:id: будь-який пресет (і вбудований) → ok; неіснуючий → 404', async () => {
  const store = new Map([[1, { id: 1, name: '🧹 Clear all', builtin: true }], [6, { id: 6, name: 'Ashby 2', builtin: false }]]);
  db = { presets: {
    async list() { return [...store.values()]; },
    async remove(id) { return store.delete(id); },
  } };
  try {
    let r = await fetch(base + '/presets/6', { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, deleted: true });
    r = await fetch(base + '/presets/1', { method: 'DELETE' });
    assert.equal(r.status, 200, 'вбудований теж видаляється');
    r = await fetch(base + '/presets/99', { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { ok: false, error: 'Пресет не знайдено' });
    assert.deepEqual((await (await fetch(base + '/presets')).json()).presets, []);
  } finally { db = null; }
});

test('PUT /presets/:id: перейменування — назву обрізано; порожня/задовга → 400; неіснуючий → 404', async () => {
  const store = new Map([[6, { id: 6, name: 'Ashby 2', body: { a: 1 } }]]);
  db = { presets: {
    async list() { return [...store.values()]; },
    async update(id, { name, body }) {
      const p = store.get(id); if (!p) return false;
      if (name !== undefined && name !== null) p.name = name;
      if (body !== undefined) p.body = body;
      return true;
    },
    async create({ name }) { store.set(7, { id: 7, name: name || 'Новий пресет', body: {} }); return 7; },
  } };
  try {
    let r = await fetch(base + '/presets/6', json('PUT', { name: '  Ashby   CV  ' }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, name: 'Ashby CV' });
    assert.equal(store.get(6).name, 'Ashby CV');
    assert.deepEqual(store.get(6).body, { a: 1 }, 'налаштування пресета не змінились');
    for (const bad of ['', '   ', 'x'.repeat(81), 5]) {
      r = await fetch(base + '/presets/6', json('PUT', { name: bad }));
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    r = await fetch(base + '/presets/6', json('PUT', {}));
    assert.equal(r.status, 400, 'нічого оновлювати');
    r = await fetch(base + '/presets/99', json('PUT', { name: 'X' }));
    assert.equal(r.status, 404);
    r = await fetch(base + '/presets', json('POST', { name: '   ', body: {} }));
    assert.equal(r.status, 400, 'створення з порожньою назвою');
  } finally { db = null; }
});

test('GET /profile/export: Markdown-вкладення з client.mjs; ?format=json — специфікація', async () => {
  const r = await fetch(base + '/profile/export?preset=' + encodeURIComponent('Ashby 2') + '&status=preset');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/markdown/);
  assert.match(r.headers.get('content-disposition'), /attachment; .*filename\*=UTF-8''stealth-config-ashby-2-/);
  const md = await r.text();
  assert.match(md, /^# Конфіг браузера «Ashby 2»/);
  assert.match(md, /## Готовий клієнт/);
  const j = await (await fetch(base + '/profile/export?format=json')).json();
  assert.equal(j.ok, true);
  assert.ok(['chromium', 'camoufox'].includes(j.spec.engine));
  assert.ok(j.spec.versions && typeof j.spec.versions === 'object');
});

test('помилка БД → 500 {ok:false, error}', async () => {
  db = { pages: { async list() { throw new Error('db down'); } } };
  try {
    const r = await fetch(base + '/pages');
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { ok: false, error: 'db down' });
  } finally { db = null; }
});

test('POST /render без url → 400', async () => {
  const r = await fetch(base + '/render', json('POST', {}));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'Не передано url' });
});

test('POST /render: успіх на фейковій сторінці (формат відповіді, слот звільнено)', async () => {
  const before = engine.closed;
  const d = await (await fetch(base + '/render', json('POST', { url: 'example.test/x' }))).json();
  assert.equal(d.ok, true);
  assert.equal(d.url, 'https://example.test/x'); // схему додано
  assert.equal(d.status, 200);
  assert.equal(d.title, 'Fake title');
  assert.match(d.screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(d.fromPool, true);
  assert.ok(Array.isArray(d.logs) && d.logs.some((l) => l.kind === 'nav'));
  for (const k of ['htmlLength', 'textPreview', 'metrics', 'poolReady', 'timing']) assert.ok(k in d, k);
  assert.equal(engine.closed, before + 1);
  assert.equal(sem.active, 0);
});

test('POST /render: помилка сторінки → 500 {ok:false}, слот звільнено', async () => {
  const orig = engine.takeUnit;
  engine.takeUnit = async () => { const u = await orig(); u.page.goto = async () => { throw new Error('net::ERR'); }; return u; };
  try {
    const r = await fetch(base + '/render', json('POST', { url: 'https://x.test' }));
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { ok: false, error: 'net::ERR' });
    assert.equal(sem.active, 0);
  } finally { engine.takeUnit = orig; }
});

test('POST /replay без url → 400', async () => {
  const r = await fetch(base + '/replay', json('POST', { actions: [] }));
  assert.equal(r.status, 400);
});

test('POST /replay: NDJSON-стрім закінчується done; події кроків по порядку', async () => {
  // humanize вимкнено, щоб не було «роздивлянь»
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false } }));
  const r = await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [{ type: 'key', key: 'Tab' }, { type: 'text', text: 'a' }] }));
  assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes('log'));
  assert.ok(kinds.indexOf('opened') < kinds.indexOf('action'));
  assert.deepEqual(events.filter((e) => e.event === 'done-action').map((e) => [e.index, e.ok]), [[0, true], [1, true]]);
  const done = events.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.actionsReplayed, 2);
  assert.equal(done.actionsTotal, 2);
  assert.match(done.screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(sem.active, 0);
});

test('POST /replay: перша подія — {event:"run", runId}; done-action має strategy/ms', async () => {
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false } }));
  const r = await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [{ type: 'key', key: 'Tab' }] }));
  const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].event, 'run');
  assert.match(events[0].runId, /^[0-9a-f-]{36}$/);
  const d = events.find((e) => e.event === 'done-action');
  assert.equal(typeof d.ms, 'number');
  assert.ok('strategy' in d);
  assert.equal(events.at(-1).stopped, false);
});

test('POST /replay/:runId/stop: невідомий → 404; зупинка посеред прогону → done(stopped) з фінальним скрином', async () => {
  assert.equal((await fetch(base + '/replay/nope/stop', { method: 'POST' })).status, 404);
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false } }));
  const actions = Array.from({ length: 60 }, () => ({ type: 'key', key: 'a' }));
  const r = await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions }));
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', stopped = false;
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      events.push(ev);
      if (!stopped && ev.event === 'done-action' && ev.index === 1) {
        stopped = true;
        const s = await (await fetch(base + '/replay/' + events[0].runId + '/stop', { method: 'POST' })).json();
        assert.deepEqual(s, { ok: true });
      }
    }
  }
  const done = events.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.stopped, true);
  assert.match(done.screenshot, /^data:image\/jpeg;base64,/);
  assert.ok(events.filter((e) => e.event === 'done-action').length < 10);
  assert.ok(events.some((e) => e.event === 'log' && /зупинено користувачем/.test(e.text)));
  assert.equal((await fetch(base + '/replay/' + events[0].runId + '/stop', { method: 'POST' })).status, 404); // реєстр очищено
  assert.equal(sem.active, 0);
});

test('POST /replay: клієнт відʼєднався → цикл зупинено, контекст закрито, слот звільнено', async () => {
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false } }));
  const closedBefore = engine.closed;
  const actions = Array.from({ length: 200 }, () => ({ type: 'key', key: 'a' }));
  const ac = new AbortController();
  const r = await fetch(base + '/replay', { ...json('POST', { url: 'https://x.test', actions }), signal: ac.signal });
  const reader = r.body.getReader();
  let got = '';
  while (!/"done-action"/.test(got)) got += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const t0 = Date.now();
  while ((sem.active !== 0 || engine.closed === closedBefore) && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 20));
  assert.equal(sem.active, 0);
  assert.ok(engine.closed > closedBefore);
  assert.ok(Date.now() - t0 < 1500, 'звільнено за ' + (Date.now() - t0) + ' мс');
});

// Читає NDJSON-потік подієво (для тестів, що реагують посеред потоку).
async function readEvents(r, onEvent) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      events.push(ev);
      if (onEvent) await onEvent(ev, events);
    }
  }
  return events;
}

test('POST /replay: Stop поки прогін чекає слот → термінальна подія error(stopped), черга звільнена без чужого release', async () => {
  for (let i = 0; i < sem.max; i++) await sem.acquire(); // усі слоти зайняті
  const takenBefore = engine.calls.filter((c) => c === 'take').length;
  try {
    const r = await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [] }));
    const events = await readEvents(r, async (ev) => {
      if (ev.event === 'run') {
        for (let i = 0; i < 50 && sem.waiting === 0; i++) await new Promise((res) => setTimeout(res, 5));
        assert.equal(sem.waiting, 1);
        assert.equal((await fetch(base + '/replay/' + ev.runId + '/stop', { method: 'POST' })).status, 200);
      }
    });
    const last = events.at(-1);
    assert.equal(last.event, 'error');
    assert.equal(last.stopped, true);
    assert.match(last.message, /зупинено до старту/);
    assert.ok(events.some((e) => e.event === 'status' && /Чекаю вільний слот/.test(e.text)));
    assert.equal(sem.waiting, 0);
    assert.equal(sem.active, sem.max); // утримувані слоти не чіпали
    assert.equal(engine.calls.filter((c) => c === 'take').length, takenBefore); // контекст не брали
  } finally { for (let i = 0; i < sem.max; i++) sem.release(); }
  assert.equal(sem.active, 0);
});

test('POST /replay: клієнт відʼєднався поки в черзі → очікувача прибрано, takeUnit не викликано', async () => {
  for (let i = 0; i < sem.max; i++) await sem.acquire();
  const takenBefore = engine.calls.filter((c) => c === 'take').length;
  try {
    const ac = new AbortController();
    const r = await fetch(base + '/replay', { ...json('POST', { url: 'https://x.test', actions: [] }), signal: ac.signal });
    await r.body.getReader().read(); // подія run
    for (let i = 0; i < 50 && sem.waiting === 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(sem.waiting, 1);
    ac.abort();
    for (let i = 0; i < 100 && sem.waiting !== 0; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(sem.waiting, 0);
  } finally { for (let i = 0; i < sem.max; i++) sem.release(); }
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(sem.active, 0);
  assert.equal(engine.calls.filter((c) => c === 'take').length, takenBefore);
});

// Шпигун на сторінці: чи виконався autoScroll (prepareForInteraction) і коли.
function spyTakeUnit(trace) {
  const orig = engine.takeUnit;
  engine.takeUnit = async () => {
    const u = await orig();
    const ev = u.page.evaluate;
    u.page.evaluate = async (fn, ...a) => { if (String(fn).includes('scrollHeightOf')) trace.push('autoScroll'); return ev(fn, ...a); };
    const down = u.page.mouse.down, press = u.page.keyboard.press;
    u.page.mouse.down = async (...a) => { trace.push('press'); return down(...a); };
    u.page.keyboard.press = async (...a) => { trace.push('press'); return press(...a); };
    return u;
  };
  return () => { engine.takeUnit = orig; };
}
const ndText = async (r) => (await r.text()).trim().split('\n').map((l) => JSON.parse(l));

test('POST /replay: legacy-координатні кліки → перед діями autoScroll (prepareForInteraction) — причина #1', async () => {
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false, prepareScroll: true } }));
  const trace = [];
  const restore = spyTakeUnit(trace);
  try {
    const events = await ndText(await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [{ type: 'click', x: 10, y: 10 }] })));
    assert.equal(events.at(-1).event, 'done');
    assert.ok(trace.includes('autoScroll'), 'autoScroll не викликано: ' + trace.join(','));
    assert.ok(trace.indexOf('autoScroll') < trace.indexOf('press'), trace.join(','));
    const prepLog = events.findIndex((e) => e.event === 'log' && /Сторінку підготовлено/.test(e.text));
    assert.ok(prepLog >= 0 && prepLog < events.findIndex((e) => e.event === 'opened'));
  } finally { restore(); }
});

test('POST /replay: лише кроки v2 / не-координатні → БЕЗ autoScroll; prepareScroll:false → теж без, з логом причини', async () => {
  await fetch(base + '/profile', json('POST', { behavior: { humanize: false, prepareScroll: true } }));
  let trace = [];
  let restore = spyTakeUnit(trace);
  try {
    const events = await ndText(await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [{ type: 'key', key: 'Tab' }, { v: 2, type: 'click', x: 5, y: 5, target: { locs: [{ by: 'css', value: '#a' }], pick: 0 } }] })));
    assert.ok(!trace.includes('autoScroll'), trace.join(','));
    assert.ok(events.some((e) => e.event === 'log' && /autoScroll пропущено \(немає legacy/.test(e.text)));
  } finally { restore(); }
  await fetch(base + '/profile', json('POST', { behavior: { prepareScroll: false } }));
  trace = [];
  restore = spyTakeUnit(trace);
  try {
    const events = await ndText(await fetch(base + '/replay', json('POST', { url: 'https://x.test', actions: [{ type: 'click', x: 10, y: 10 }] })));
    assert.ok(!trace.includes('autoScroll'), trace.join(','));
    assert.ok(events.some((e) => e.event === 'log' && /prepareScroll вимкнено/.test(e.text)));
  } finally { restore(); await fetch(base + '/profile', json('POST', { behavior: { prepareScroll: true } })); }
});

test('JSON-тіло понад ліміт → 413 {ok:false}', async () => {
  const r = await fetch(base + '/pages/1', json('PUT', { recs: 'x'.repeat(3 * 1024 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).ok, false);
});
