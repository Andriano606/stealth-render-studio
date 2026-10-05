// E2E (opt-in, E2E=1): живий запис через HTTP API у справжньому Chrome на локальних
// фікстурах, потім відтворення записаних кроків через /replay на ЗСУНУТІЙ верстці.
// Застосунок — createApp у процесі з реальним рушієм (playwright chromium, channel
// 'chrome', headless, без stealth-плагіна), БД немає, profile/uploads — у tmp.
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-live-e2e-'));
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
async function openLive(url, actions) {
  const ev = await nd(await post('/live', { url, actions }));
  const live = ev.find((e) => e.event === 'live');
  assert.ok(live, 'немає події live: ' + JSON.stringify(ev.filter((e) => e.event === 'error')));
  return { ev, live, sid: live.sid };
}
// Центр елемента у viewport сесії (як «користувач бачить його на скриншоті»).
async function center(sid, sel, frame) {
  const page = sessions.get(sid).page;
  const l = frame ? page.frameLocator(frame).locator(sel) : page.locator(sel);
  await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox();
  return { vx: Math.round(b.x + b.width / 2), vy: Math.round(b.y + b.height / 2) };
}
const act = async (sid, b) => (await post('/live/' + sid + '/act', b)).json();
const locOf = (step) => step.target.locs[step.target.pick];

let recorded = null; // кроки з тесту запису → тести відтворення

test('e2e live: запис кліків/тексту/select/файлу/iframe/дублікатів → семантичні цілі', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { sid, live } = await openLive(A + '/live.html');
  assert.equal(live.engine, 'chromium');
  assert.equal(live.vp.w, 1280);
  assert.match(live.shot, /^data:image\/jpeg;base64,/);
  const steps = [];
  const keep = (r) => { assert.equal(r.ok, true, r.error); if (r.step) steps.push(r.step); return r; };

  // 1) поле з <label> → role textbox «Email», здоровʼя semantic
  const c1 = keep(await act(sid, { type: 'click', ...(await center(sid, '#email')) }));
  assert.deepEqual(locOf(c1.step), { by: 'role', role: 'textbox', name: 'Email', exact: true, n: 1 });
  assert.equal(healthOf(c1.step), 'semantic');
  assert.equal(c1.step.target.kind, 'input');
  assert.equal(c1.step.v, 2);
  assert.ok(c1.step.x > 0 && c1.step.sw === live.vp.docW);
  // 2) текст успадковує ціль поля
  const t1 = keep(await act(sid, { type: 'text', text: 'john{d}@ex.com' }));
  assert.equal(t1.step.text, 'john{d}@ex.com');
  assert.deepEqual(locOf(t1.step), locOf(c1.step));
  assert.match(await sessions.get(sid).page.inputValue('#email'), /^john\d@ex\.com$/);
  // 3) нативний <select> → needSelect (без кліку), потім select
  const s1 = await act(sid, { type: 'click', ...(await center(sid, '#country')) });
  assert.equal(s1.step, null);
  assert.deepEqual(s1.needSelect.options.map((o) => o.value), ['', 'UA', 'PL']);
  const s2 = keep(await act(sid, { type: 'select', value: 'PL' }));
  assert.equal(s2.step.label, 'Польща');
  assert.deepEqual(locOf(s2.step), { by: 'role', role: 'combobox', name: 'Країна', exact: true, n: 1 });
  // 4) кнопка, що відкриває прихований input[type=file] → needFile → /upload → file
  const f1 = keep(await act(sid, { type: 'click', ...(await center(sid, '#cvbtn')) }));
  assert.deepEqual(f1.needFile, { multiple: false });
  assert.equal(f1.step.chooser, true);
  const up = await (await fetch(base + '/upload', { method: 'POST', headers: { 'x-filename': 'cv.pdf', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 e2e') })).json();
  const f2 = keep(await act(sid, { type: 'file', fileId: up.fileId, filename: up.filename }));
  assert.equal(f2.step.target.kind, 'file');
  assert.deepEqual(locOf(f2.step), { by: 'id', value: 'cv', n: 1 });
  // 5) дублікати «Додати» — записано 2-й: CSS з nth (role має 3 збіги)
  const d1 = keep(await act(sid, { type: 'click', ...(await center(sid, '.add >> nth=1')) }));
  assert.equal(locOf(d1.step).by, 'css');
  assert.equal(locOf(d1.step).nth, 1);
  assert.ok(d1.step.target.locs.some((l) => l.by === 'role' && l.n === 3));
  // 6) кнопка в iframe → ланцюг фреймів
  const i1 = keep(await act(sid, { type: 'click', ...(await center(sid, '#apply', '#frm')) }));
  assert.deepEqual(i1.step.target.frame.chain, ['iframe#frm']);
  assert.match(i1.step.target.frame.url, /live-child\.html\*$/);
  assert.deepEqual(locOf(i1.step), { by: 'role', role: 'button', name: 'Apply now', exact: true, n: 1 });
  // 7) submit: хешований клас відкинуто, ціль — role button
  const sb = keep(await act(sid, { type: 'click', ...(await center(sid, '#submit')) }));
  assert.equal(locOf(sb.step).name, 'Submit Application');
  assert.ok(!JSON.stringify(sb.step.target.locs).includes('css-1x2y3z'));
  assert.deepEqual(await sessions.get(sid).page.evaluate(() => window.events), ['country:PL', 'cv:cv.pdf', 'add1', 'apply', 'submit:' + (await sessions.get(sid).page.inputValue('#email'))]);

  // inspect (без кліку), keep-alive за хешем, навігація, закриття → 410
  const ins = await (await fetch(base + '/live/' + sid + '/inspect?' + new URLSearchParams(await center(sid, '#email')).toString().replace('vx', 'x').replace('vy', 'y'))).json();
  assert.equal(ins.desc, 'поле «Email»');
  assert.ok(ins.box.w > 50);
  const sh = await (await fetch(base + '/live/' + sid + '/shot')).json();
  const sh2 = await (await fetch(base + '/live/' + sid + '/shot?h=' + sh.hash)).json();
  assert.ok(sh.shot);
  assert.equal(sh2.shot, undefined);
  const nv = await (await post('/live/' + sid + '/nav', { action: 'reload' })).json();
  assert.equal(nv.ok, true);
  assert.equal(await sessions.get(sid).page.inputValue('#email'), '');
  assert.equal((await (await post('/live/' + sid + '/close')).json()).closed, true);
  assert.equal((await post('/live/' + sid + '/act', { type: 'key', key: 'Tab' })).status, 410);
  recorded = steps;
  t.diagnostic('записано кроків: ' + steps.length);
});

async function replayShifted(t, humanize) {
  store.set(applyProfilePatch(store.get(), { behavior: { humanize } }).profile);
  pageEvents.length = 0;
  const ev = await nd(await post('/replay', { url: A + '/live.html?shift=1', actions: recorded }));
  const dones = ev.filter((e) => e.event === 'done-action');
  t.diagnostic('humanize=' + humanize + ': ' + dones.map((d) => recorded[d.index].type + ':' + d.strategy + '(' + d.ms + 'мс)').join(' '));
  assert.equal(ev.at(-1).event, 'done');
  assert.deepEqual(dones.map((d) => d.ok), recorded.map(() => true), JSON.stringify(dones.filter((d) => !d.ok)));
  const strat = dones.map((d) => d.strategy);
  assert.ok(!strat.includes('coord') && !strat.includes('snap'), 'жодного координатного кліку: ' + strat.join(','));
  dones.forEach((d) => {
    const s = recorded[d.index];
    if (s.type === 'click' || s.type === 'select' || s.type === 'file') {
      const want = s.target.locs[s.target.pick].by === 'css' && s.target.locs[s.target.pick].nth != null ? 'nth' : 'loc';
      assert.equal(d.strategy, want, 'крок ' + d.index + ' ' + s.type);
    }
  });
  for (let k = 0; k < 40 && pageEvents.length < 5; k++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pageEvents.slice(0, 4), ['country:PL', 'cv:cv.pdf', 'add1', 'apply']);
  assert.match(pageEvents[4], /^submit:john\d@ex\.com$/);
}

test('e2e live → /replay на зсунутій верстці (банер +300px, переставлені рядки): лише локатори, humanize off', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(recorded, 'потрібен попередній тест запису');
  await replayShifted(t, false);
});

test('e2e live → /replay на зсунутій верстці, humanize on (trial-клік, людський рух, down/up)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(recorded, 'потрібен попередній тест запису');
  await replayShifted(t, true);
  store.set(applyProfilePatch(store.get(), { behavior: { humanize: false } }).profile);
});

test('e2e live: префікс (записані кроки) відтворюється при відкритті сесії; /run виконує кроки в сесії', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  assert.ok(recorded, 'потрібен попередній тест запису');
  // префікс — усе, крім submit; сесія відкривається у досягнутому стані
  const prefix = recorded.slice(0, -1);
  const { ev, sid } = await openLive(A + '/live.html?shift=1', prefix);
  const dones = ev.filter((e) => e.event === 'done-action');
  assert.deepEqual(dones.map((d) => d.ok), prefix.map(() => true));
  const page = sessions.get(sid).page;
  assert.deepEqual(await page.evaluate(() => window.events), ['country:PL', 'cv:cv.pdf', 'add1', 'apply']);
  // «▶ спробувати» останній крок у живій сесії
  const run = await nd(await post('/live/' + sid + '/run', { steps: [recorded.at(-1)] }));
  assert.equal(run.find((e) => e.event === 'done-action').strategy, 'loc');
  assert.equal(run.at(-1).event, 'live');
  assert.match((await page.evaluate(() => window.events)).at(-1), /^submit:john\d@ex\.com$/);
  await post('/live/' + sid + '/close');
});

test('e2e live: клік крізь відкритий shadow root → role-локатор; повтор через /run', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { sid } = await openLive(A + '/shadow.html');
  const page = sessions.get(sid).page;
  const b = await page.locator('#ok').boundingBox(); // Playwright CSS пронизує shadow DOM
  pageEvents.length = 0;
  const r = await act(sid, { type: 'click', vx: Math.round(b.x + 20), vy: Math.round(b.y + b.height / 2) });
  assert.deepEqual(locOf(r.step), { by: 'role', role: 'button', name: 'Shadow OK', exact: true, n: 1 });
  assert.equal(r.step.target.desc, 'кнопка «Shadow OK»');
  const run = await nd(await post('/live/' + sid + '/run', { steps: [r.step] }));
  assert.equal(run.find((e) => e.event === 'done-action').strategy, 'loc');
  for (let k = 0; k < 40 && pageEvents.length < 2; k++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(pageEvents, ['shadow', 'shadow']);
  await post('/live/' + sid + '/close');
});
