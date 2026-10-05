// E2E (opt-in, E2E=1): приховане поле файлу без семантики (як у Ashby/Preply apply) —
// живий запис через HTTP API у справжньому Chrome на локальній фікстурі
// (test/fixtures/upload-cssmod.html), потім /replay на «новому деплої» (?deploy=2:
// інший хеш CSS-модулів + обгортковий div і банер). Перевіряємо, що крок «Файл»
// отримує локатор input[type=file] (🎯, без хешу), а при кількох полях —
// відтворення влучає в правильне (найближчий бокс), а не «перше за порядком».
// Застосунок — createApp у процесі з реальним рушієм (chromium channel 'chrome',
// headless, без stealth-плагіна), БД немає, profile/uploads — у tmp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from '../../lib/app.js';
import { loadConfig } from '../../lib/config.js';
import { createSemaphore } from '../../lib/semaphore.js';
import { createProfileStore, applyProfilePatch } from '../../lib/profile.js';
import { createEngine } from '../../lib/engine.js';
import { createSessionStore } from '../../lib/session.js';
import { healthOf } from '../../lib/steps.js';

const E2E = process.env.E2E === '1';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FRAME = '#ashby_embed_iframe';
const HASH = /f7cvd|h2k8p/; // хеші CSS-модулів обох «деплоїв» фікстури
const quiet = { log() {}, error() {} };

let fsrv, A, tmp, engine, sessions, store, srv, base;
const pageEvents = [];

before(async () => {
  if (!E2E) return;
  fsrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/log') { pageEvents.push(u.searchParams.get('e')); res.end('ok'); return; }
    const f = path.join(FIX, path.basename(u.pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => fsrv.listen(0, '127.0.0.1', r));
  A = 'http://127.0.0.1:' + fsrv.address().port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-fileloc-e2e-'));
  const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  store.set(applyProfilePatch(store.get(), { launch: { stealthPlugin: false }, behavior: { humanize: false } }).profile);
  const { chromium } = await import('playwright');
  engine = createEngine({
    getProfile: () => store.get(), poolSize: 1, log: quiet,
    launchers: { chromium: () => chromium.launch({ channel: 'chrome', headless: true }), camoufox: () => { throw new Error('camoufox не використовується в e2e'); } },
  });
  sessions = createSessionStore({ log: quiet });
  const app = createApp({ config, engine, sem: createSemaphore(4), profileStore: store, sessions, log: quiet });
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + srv.address().port;
});
after(async () => {
  if (!E2E) return;
  await sessions.closeAll('end');
  srv.close(); fsrv.close();
  await engine.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
const nd = async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const act = async (sid, b) => (await post('/live/' + sid + '/act', b)).json();
const locOf = (step) => step.target.locs[step.target.pick];
async function openLive(url) {
  const ev = await nd(await post('/live', { url }));
  const live = ev.find((e) => e.event === 'live');
  assert.ok(live, 'немає події live: ' + JSON.stringify(ev.filter((e) => e.event === 'error')));
  return live.sid;
}
// Центр елемента у viewport сесії (як «користувач бачить його на скриншоті»).
async function center(sid, sel) {
  const l = sessions.get(sid).page.frameLocator(FRAME).locator(sel);
  await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox();
  return { vx: Math.round(b.x + b.width / 2), vy: Math.round(b.y + b.height / 2) };
}
async function waitEvents(n) {
  for (let k = 0; k < 60 && pageEvents.length < n; k++) await new Promise((r) => setTimeout(r, 50));
  return pageEvents.slice();
}
async function uploadTestFile(name) {
  const r = await fetch(base + '/upload', { method: 'POST', headers: { 'x-filename': name, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 fileloc e2e') });
  return r.json();
}

// Запис: клік по N-й кнопці «Upload File» → needFile → крок «Файл» з /upload.
async function recordUpload(url, buttonNth) {
  pageEvents.length = 0;
  const sid = await openLive(url);
  const c = await act(sid, { type: 'click', ...(await center(sid, 'button:has-text("Upload File") >> nth=' + buttonNth)) });
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(c.needFile, { multiple: false });
  assert.equal(c.step.chooser, true);
  const up = await uploadTestFile('cv.pdf');
  const f = await act(sid, { type: 'file', fileId: up.fileId, filename: up.filename });
  assert.equal(f.ok, true, f.error);
  assert.equal(f.step.type, 'file');
  assert.equal(f.step.target.kind, 'file');
  assert.deepEqual(f.step.target.frame.chain, ['iframe' + FRAME]);
  assert.ok(!HASH.test(JSON.stringify(c.step.target.locs)), 'хеш у локаторах кліку: ' + JSON.stringify(c.step.target.locs));
  assert.ok(!HASH.test(JSON.stringify(f.step.target.locs)), 'хеш у локаторах файлу: ' + JSON.stringify(f.step.target.locs));
  await post('/live/' + sid + '/close');
  return { click: c.step, file: f.step, events: await waitEvents(1) };
}

async function replay(url, steps) {
  pageEvents.length = 0;
  const ev = await nd(await post('/replay', { url, actions: steps }));
  assert.equal(ev.at(-1).event, 'done', JSON.stringify(ev.filter((e) => e.event === 'error')));
  const dones = ev.filter((e) => e.event === 'done-action');
  assert.deepEqual(dones.map((d) => d.ok), steps.map(() => true), JSON.stringify(dones.filter((d) => !d.ok)));
  return { dones, events: await waitEvents(1) };
}

let single = null, two = null;

test('e2e fileloc: приховане поле файлу без семантики → input[type=file] (n=1, 🎯), без хешу CSS-модуля', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const r = await recordUpload(A + '/upload-cssmod.html', 0);
  assert.deepEqual(locOf(r.click), { by: 'role', role: 'button', name: 'Upload File', exact: true, n: 1 });
  assert.deepEqual(locOf(r.file), { by: 'type', tag: 'input', value: 'file', n: 1 });
  assert.equal(healthOf(r.file), 'semantic');
  assert.deepEqual(r.events, ['resume:cv.pdf']);
  t.diagnostic('file locs: ' + JSON.stringify(r.file.target.locs));
  single = [r.click, r.file];
});

test('e2e fileloc: /replay на ?deploy=2 (новий хеш + обгортка) → файл за локатором (loc), не координати/порядок', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(single, 'потрібен попередній тест запису');
  const { dones, events } = await replay(A + '/upload-cssmod.html?deploy=2', single);
  t.diagnostic(dones.map((d) => single[d.index].type + ':' + d.strategy).join(' '));
  assert.deepEqual(dones.map((d) => d.strategy), ['loc', 'loc']);
  assert.deepEqual(events, ['resume:cv.pdf']);
});

test('e2e fileloc: два поля файлу — записано 2-ге (Resume) → унікальний не-type локатор або type з n=2', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const r = await recordUpload(A + '/upload-cssmod.html?two=1', 1);
  const pick = locOf(r.file);
  const typeLoc = r.file.target.locs.find((l) => l.by === 'type');
  assert.ok(typeLoc, 'серед кандидатів має бути input[type=file]');
  assert.equal(typeLoc.n, 2);
  assert.ok((pick.by !== 'type' && pick.n === 1) || (pick.by === 'type' && pick.n === 2), 'pick: ' + JSON.stringify(pick));
  assert.ok(r.file.target.box && r.file.target.box.w >= 1, 'потрібен бокс запису для вибору найближчого');
  assert.deepEqual(r.events, ['resume:cv.pdf']);
  t.diagnostic('file locs: ' + JSON.stringify(r.file.target.locs));
  two = [r.click, r.file];
});

test('e2e fileloc: два поля — /replay на тій самій верстці → файл у Resume за локатором', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(two, 'потрібен попередній тест запису');
  const { dones, events } = await replay(A + '/upload-cssmod.html?two=1', two);
  t.diagnostic(dones.map((d) => two[d.index].type + ':' + d.strategy).join(' '));
  assert.equal(dones[1].strategy, 'loc');
  assert.deepEqual(events, ['resume:cv.pdf']);
});

test('e2e fileloc: два поля — /replay на ?deploy=2 (CSS-шлях зламано) → найближчий бокс, файл у Resume (не в перше поле)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(two, 'потрібен попередній тест запису');
  const { dones, events } = await replay(A + '/upload-cssmod.html?deploy=2&two=1', two);
  t.diagnostic(dones.map((d) => two[d.index].type + ':' + d.strategy).join(' '));
  // Обидва кроки мають знайти ціль локатором (за потреби — найближчий із кількох збігів),
  // а не координатами чи «input[type=file] за порядком» (strategy null → було б cover).
  for (const d of dones) assert.ok(['loc', 'loc-alt', 'nth'].includes(d.strategy), 'крок ' + d.index + ': ' + d.strategy);
  // Файл: записаний CSS-шлях на новому деплої не знаходить нічого → input[type=file] (2 збіги)
  // → обрано найближчий до запису бокс.
  assert.equal(dones[1].strategy, 'nth');
  assert.deepEqual(events, ['resume:cv.pdf']);
  // Контроль фікстури: без цілі (legacy) файл іде в ПЕРШЕ поле за порядком — тобто
  // перевірка вище справді розрізняє «найближчий бокс» і «порядок».
  const { target: _t, ...legacyFile } = two[1];
  const ctl = await replay(A + '/upload-cssmod.html?deploy=2&two=1', [legacyFile]);
  assert.equal(ctl.dones[0].strategy, null);
  assert.deepEqual(ctl.events, ['cover:cv.pdf']);
});

test('e2e fileloc: два ПРИХОВАНІ поля (display:none), записано обидва → /replay на ?deploy=2 → кожен файл у своє поле', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const q = '?two=1&hidden=1';
  pageEvents.length = 0;
  const sid = await openLive(A + '/upload-cssmod.html' + q);
  const steps = [];
  for (const [nth, name] of [[0, 'cl.pdf'], [1, 'cv.pdf']]) {
    const c = await act(sid, { type: 'click', ...(await center(sid, 'button:has-text("Upload File") >> nth=' + nth)) });
    assert.equal(c.ok, true, c.error);
    assert.deepEqual(c.needFile, { multiple: false });
    const up = await uploadTestFile(name);
    const f = await act(sid, { type: 'file', fileId: up.fileId, filename: up.filename });
    assert.equal(f.ok, true, f.error);
    assert.ok(!HASH.test(JSON.stringify(f.step.target.locs)), 'хеш у локаторах файлу: ' + JSON.stringify(f.step.target.locs));
    steps.push(c.step, f.step);
  }
  await post('/live/' + sid + '/close');
  assert.deepEqual(await waitEvents(2), ['cover:cl.pdf', 'resume:cv.pdf']);
  t.diagnostic('file locs: ' + steps.filter((s) => s.type === 'file').map((s) => JSON.stringify(s.target.locs) + ' box=' + JSON.stringify(s.target.box)).join(' | '));
  pageEvents.length = 0;
  const ev = await nd(await post('/replay', { url: A + '/upload-cssmod.html?deploy=2' + q.replace('?', '&'), actions: steps }));
  assert.equal(ev.at(-1).event, 'done', JSON.stringify(ev.filter((e) => e.event === 'error')));
  const dones = ev.filter((e) => e.event === 'done-action');
  assert.deepEqual(dones.map((d) => d.ok), steps.map(() => true), JSON.stringify(dones.filter((d) => !d.ok)));
  t.diagnostic(dones.map((d) => steps[d.index].type + ':' + d.strategy).join(' '));
  // Без геометрії input[type=file] ×2 неоднозначний → поле за порядком, а не обидва файли в перше.
  assert.deepEqual(await waitEvents(2), ['cover:cl.pdf', 'resume:cv.pdf']);
});
