// HTTP-тести живих сесій (routes/live.js + lib/live.js + lib/session.js) з ФЕЙКОВИМ
// рушієм і сторінками — без браузера. Перевіряють формати відповідей, статуси
// 409/410/429/503, keep-alive за хешем, закриття (клієнт, relaunch, закриття сторінки),
// /health.sessions і роздачу спільних /lib-модулів. Реальний браузер — test/e2e/live.e2e.test.js.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createApp, SHARED_LIBS } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createSemaphore } from '../lib/semaphore.js';
import { createProfileStore, applyProfilePatch } from '../lib/profile.js';
import { createSessionStore } from '../lib/session.js';
import { createLive, shotHash } from '../lib/live.js';

const quiet = { log() {}, error() {} };

function fakePage(opts = {}) {
  const em = new EventEmitter();
  let url = 'about:blank';
  const st = { scrollY: 0, mouse: [], downs: 0, ups: [], typed: [], keys: [], keyOpts: [], wheels: [], gotos: [], navs: [], seq: [], shot: Buffer.from('SHOT-1'), closed: false };
  const frame = {
    async evaluate() { return 100; }, async evaluateHandle() { return { asElement: () => null, async dispose() {} }; },
    async waitForLoadState() {}, async $$() { return []; },
  };
  const page = Object.assign(em, {
    st,
    async goto(u) { if (opts.gotoGate) await opts.gotoGate; url = u; st.gotos.push(u); return { status: () => 200 }; },
    async title() { return 'Fake'; },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('docW')) return { w: 1280, h: 900, dpr: 1, scrollX: 0, scrollY: st.scrollY, docW: 1280, docH: 4000 };
      if (s.includes('scrollingElement')) return { w: 1280, h: 900, dpr: 1, sw: 1280, sh: 4000, scrollY: st.scrollY, topInset: 0, bottomInset: 0 };
      if (s.includes('requestAnimationFrame')) return st.scrollY;
      if (s.includes('querySelector')) return false;
      if (s.includes('innerText.length')) return 100;
      return 'body text';
    },
    mainFrame: () => frame,
    frames: () => [frame],
    async waitForLoadState() {},
    async waitForTimeout(ms) { st.seq.push('wait'); },
    async screenshot(o) { st.lastShotOpts = o; return st.shot; },
    url: () => url,
    isClosed: () => st.closed,
    async goBack() { st.navs.push('back'); }, async goForward() { st.navs.push('forward'); }, async reload() { st.navs.push('reload'); },
    mouse: {
      async move(x, y, o) { st.mouse.push([x, y]); st.seq.push('move'); st.moveOpts = (st.moveOpts || []).concat([o || {}]); },
      async down() { st.downs++; st.seq.push('down'); }, async up(o) { st.ups.push(o || {}); st.seq.push('up'); },
      async wheel(dx, dy) { st.wheels.push([dx, dy]); st.scrollY += dy; },
    },
    keyboard: { async type(t, o) { st.typed.push(t); st.typeOpts = o; }, async press(k, o) { st.keys.push(k); st.keyOpts.push(o || null); } },
  });
  return page;
}

function fakeEngine() {
  const hooks = [];
  const e = {
    sig: 'sig-1', closed: [], taken: [], gate: null,
    engineReady: () => true,
    async takeUnit() {
      const page = fakePage({ gotoGate: e.gate });
      const ctx = new EventEmitter();
      ctx.pages = () => [page];
      const u = { context: ctx, page, fromPool: true };
      e.taken.push(u);
      return u;
    },
    async closeUnit(u) { e.closed.push(u); },
    async drainPool() {}, async relaunchBrowser() { for (const h of hooks) await h(); },
    onBeforeRelaunch(fn) { hooks.push(fn); },
    profileSig: () => e.sig,
    poolStats: () => ({ ready: 1, size: 3 }),
  };
  return e;
}

let tmp, server, base, engine, sem, sessions, config, profileStore;
// Більшість тестів перевіряє формати — без humanize (швидко, детерміновано);
// людську поведінку — окремі тести нижче (setBehavior).
const setBehavior = (behavior) => profileStore.set(applyProfilePatch(profileStore.get(), { behavior }).profile);
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-live-'));
  config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  engine = fakeEngine();
  sem = createSemaphore(3);
  sessions = createSessionStore({ log: quiet });
  profileStore = createProfileStore(config.PROFILE_FILE, { log: quiet });
  profileStore.load();
  setBehavior({ humanize: false });
  const live = createLive({ engine, sem, profileStore, config, sessions, log: quiet, acquireTimeoutMs: 200 });
  const app = createApp({ config, engine, sem, profileStore, sessions, live, log: quiet });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterEach(async () => { await sessions.closeAll('cleanup'); setBehavior({ humanize: false, fastPrefix: false }); });
after(async () => { await sessions.closeAll('end'); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (p, b) => fetch(base + p, json('POST', b || {}));
const nd = async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function openLive(body = { url: 'example.test' }) {
  const r = await post('/live', body);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /ndjson/);
  const ev = await nd(r);
  const live = ev.find((e) => e.event === 'live');
  assert.ok(live, JSON.stringify(ev));
  return { ev, live, sid: live.sid, s: sessions.get(live.sid) };
}
const act = async (sid, b) => (await post('/live/' + sid + '/act', b)).json();

test('POST /live без url → 400 JSON; сесія не створюється', async () => {
  const r = await post('/live', {});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(sessions.size, 0);
});

test('POST /live: NDJSON session → … → live {sid, engine, vp, shot, hash, url, title}; /health.sessions; слот зайнято', async () => {
  const { ev, live, sid } = await openLive();
  assert.equal(ev[0].event, 'session');
  assert.equal(ev[0].sid, sid);
  assert.equal(ev.at(-1).event, 'live');
  assert.equal(live.engine, 'chromium');
  assert.deepEqual(live.vp, { w: 1280, h: 900, dpr: 1, scrollX: 0, scrollY: 0, docW: 1280, docH: 4000 });
  assert.equal(live.shot, 'data:image/jpeg;base64,' + Buffer.from('SHOT-1').toString('base64'));
  assert.equal(live.hash, shotHash(Buffer.from('SHOT-1')));
  assert.equal(live.url, 'https://example.test');
  assert.equal(live.title, 'Fake');
  assert.equal(live.configChanged, false);
  assert.ok(ev.some((e) => e.event === 'log' && /Жива сесія/.test(e.text)));
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.sessions, 1);
  assert.equal(h.active, 1);
  // скриншот viewport: jpeg q60, scale css, caret initial (не fullPage)
  assert.deepEqual(sessions.get(sid).page.st.lastShotOpts, { type: 'jpeg', quality: 60, scale: 'css', caret: 'initial', timeout: 10000 });
  await post('/live/' + sid + '/close');
  assert.equal((await (await fetch(base + '/health')).json()).active, 0);
});

test('префікс: кроки відтворюються (події action/done-action як у /replay), потім live', async () => {
  const { ev, s } = await openLive({ url: 'https://x.test', actions: [{ type: 'key', key: 'Tab' }, { v: 2, type: 'text', text: 'hi' }] });
  const kinds = ev.filter((e) => e.event === 'action' || e.event === 'done-action').map((e) => e.event + e.index);
  assert.deepEqual(kinds, ['action0', 'done-action0', 'action1', 'done-action1']);
  assert.deepEqual(s.page.st.keys, ['Tab']);
  assert.deepEqual(s.page.st.typed, ['hi']);
  assert.ok(ev.some((e) => e.event === 'log' && /Префікс відтворено/.test(e.text)));
  await sessions.close(s.sid, 't');
});

test('поки відтворюється префікс: act/shot → 409 session_busy; клієнт відʼєднався → сесію закрито, слот звільнено', async () => {
  let release;
  engine.gate = new Promise((r) => { release = r; });
  const ac = new AbortController();
  const req = fetch(base + '/live', { ...json('POST', { url: 'https://slow.test' }), signal: ac.signal }).then((r) => r.body.getReader().read()).catch(() => null);
  for (let i = 0; i < 50 && !sessions.list().length; i++) await new Promise((r) => setTimeout(r, 10));
  const s = sessions.list()[0];
  assert.equal(s.state, 'prefix');
  const r1 = await post('/live/' + s.sid + '/act', { type: 'key', key: 'A' });
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).code, 'session_busy');
  assert.equal((await fetch(base + '/live/' + s.sid + '/shot')).status, 409);
  await req; // перший chunk (подія session) прочитано
  ac.abort();
  for (let i = 0; i < 100 && sessions.size; i++) await new Promise((r) => setTimeout(r, 10));
  release(); engine.gate = null;
  assert.equal(sessions.size, 0);
  assert.match(sessions.reasonOf(s.sid), /відʼєднався/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sem.active, 0);
});

test('act key/text/scroll: крок v2, хеш, без shot якщо не змінився; rec:false → step null', async () => {
  const { sid, live, s } = await openLive();
  const k = await act(sid, { type: 'key', key: 'Enter', k: 'c1', h: live.hash });
  assert.equal(k.ok, true);
  assert.equal(k.k, 'c1');
  assert.equal(k.step.v, 2);
  assert.equal(k.step.type, 'key');
  assert.equal(k.step.key, 'Enter');
  assert.match(k.step.id, /^s_[0-9a-z]{8}$/);
  assert.equal(k.shot, undefined);       // хеш той самий
  assert.equal(k.hash, live.hash);
  assert.equal(typeof k.ms, 'number');
  assert.deepEqual(k.logs, []);
  s.page.st.shot = Buffer.from('SHOT-2');
  const t = await act(sid, { type: 'text', text: 'id{d}{{' });
  assert.equal(t.step.text, 'id{d}{{');           // у кроці — шаблон як є
  assert.match(s.page.st.typed[0], /^id[0-9]\{$/);  // на сторінку — розгорнутий
  assert.ok(t.shot);                               // скрин змінився
  const sc = await act(sid, { type: 'scroll', vx: 100, vy: 200, dx: 0, dy: 400 });
  assert.deepEqual(sc.step, { id: sc.step.id, v: 2, type: 'scroll', dx: 0, dy: 400, vx: 100, vy: 200 });
  assert.deepEqual(s.page.st.wheels, [[0, 400]]);
  const nr = await act(sid, { type: 'key', key: 'Tab', rec: false });
  assert.equal(nr.step, null);
  await post('/live/' + sid + '/close');
});

test('act click: точка → mouse.move+down/up; крок має x,y у CSS px документа (+scrollY), sw/sh, vw/vh', async () => {
  const { sid, s } = await openLive();
  s.page.st.scrollY = 1000;
  const c = await act(sid, { type: 'click', vx: 300.4, vy: 200 });
  assert.equal(c.ok, true);
  assert.deepEqual(s.page.st.mouse.at(-1), [300.4, 200]);
  assert.equal(s.page.st.downs, 1);
  const { id, ...rest } = c.step;
  assert.match(id, /^s_/);
  assert.deepEqual(rest, { v: 2, type: 'click', x: 300, y: 1200, sw: 1280, sh: 4000, vw: 1280, vh: 900, scrollY: 1000, button: 'left', clicks: 1 });
  const d = await act(sid, { type: 'dblclick', vx: 10, vy: 10, waitResponse: true });
  assert.equal(d.step.clicks, 2);
  assert.equal(d.step.waitResponse, true);
  assert.deepEqual(s.page.st.ups.at(-1), { clickCount: 2 });
  await post('/live/' + sid + '/close');
});

test('act: валідація → 400 (невідомий тип, точка поза viewport, порожній текст, select без списку, файл без upload)', async () => {
  const { sid } = await openLive();
  for (const b of [{ type: 'teleport' }, { type: 'click', vx: 5000, vy: 1 }, { type: 'click' }, { type: 'text', text: '' },
    { type: 'select', value: 'x' }, { type: 'file', fileId: 'nope', filename: 'a.pdf' }]) {
    const r = await post('/live/' + sid + '/act', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal((await r.json()).ok, false);
  }
  await post('/live/' + sid + '/close');
});

test('act file без поля на сторінці → ok:false з помилкою і знімком (не 500)', async () => {
  const { sid } = await openLive();
  const id = 'abcdef0123456789';
  fs.mkdirSync(path.join(config.UPLOAD_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(config.UPLOAD_DIR, id, 'cv.pdf'), 'x');
  const r = await post('/live/' + sid + '/act', { type: 'file', fileId: id, filename: 'cv.pdf' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, false);
  assert.match(d.error, /немає поля для файлу/);
  assert.ok(d.hash);
  assert.ok(d.logs.some((l) => l.kind === 'error'));
  await post('/live/' + sid + '/close');
});

test('GET /shot?h=: keep-alive, shot лише якщо хеш змінився; configChanged після зміни профілю', async () => {
  const { sid, live, s } = await openLive();
  const a = await (await fetch(base + '/live/' + sid + '/shot?h=' + live.hash)).json();
  assert.equal(a.ok, true);
  assert.equal(a.shot, undefined);
  assert.equal(a.hash, live.hash);
  s.page.st.shot = Buffer.from('NEW');
  const b = await (await fetch(base + '/live/' + sid + '/shot?h=' + live.hash)).json();
  assert.ok(b.shot);
  assert.equal(b.configChanged, false);
  engine.sig = 'sig-2';
  const c = await (await fetch(base + '/live/' + sid + '/shot')).json();
  assert.equal(c.configChanged, true);
  engine.sig = 'sig-1';
  await post('/live/' + sid + '/close');
});

test('POST /nav: goto/back/forward/reload; невідома дія → 400', async () => {
  const { sid, s } = await openLive();
  const g = await (await post('/live/' + sid + '/nav', { action: 'goto', url: 'other.test/x' })).json();
  assert.equal(g.ok, true);
  assert.equal(g.url, 'https://other.test/x');
  for (const a of ['back', 'forward', 'reload']) assert.equal((await (await post('/live/' + sid + '/nav', { action: a })).json()).ok, true);
  assert.deepEqual(s.page.st.navs, ['back', 'forward', 'reload']);
  assert.equal((await post('/live/' + sid + '/nav', { action: 'jump' })).status, 400);
  await post('/live/' + sid + '/close');
});

test('GET /inspect: без елемента під точкою → box/target null; некоректні x/y → 400', async () => {
  const { sid } = await openLive();
  assert.deepEqual(await (await fetch(base + '/live/' + sid + '/inspect?x=10&y=10')).json(), { ok: true, box: null, target: null, desc: null });
  assert.equal((await fetch(base + '/live/' + sid + '/inspect?x=a&y=1')).status, 400);
  await post('/live/' + sid + '/close');
});

test('POST /run: кроки через спільний runSteps (NDJSON), наприкінці подія live зі знімком', async () => {
  const { sid, s } = await openLive();
  const ev = await nd(await post('/live/' + sid + '/run', { steps: [{ type: 'key', key: 'A' }, { type: 'key', key: 'B' }] }));
  assert.deepEqual(ev.filter((e) => e.event === 'done-action').map((e) => e.ok), [true, true]);
  const last = ev.at(-1);
  assert.equal(last.event, 'live');
  assert.equal(last.replayed, 2);
  assert.equal(last.total, 2);
  assert.deepEqual(s.page.st.keys, ['A', 'B']);
  assert.equal((await post('/live/' + sid + '/run', { steps: 'x' })).status, 400);
  await post('/live/' + sid + '/close');
});

test('close (sendBeacon) і DELETE: ресурси звільнено; далі — 410 {code:session_closed, reason}', async () => {
  const { sid, s } = await openLive();
  const unit = s.unit;
  assert.deepEqual(await (await post('/live/' + sid + '/close')).json(), { ok: true, closed: true });
  assert.ok(engine.closed.includes(unit));
  const r = await post('/live/' + sid + '/act', { type: 'key', key: 'A' });
  assert.equal(r.status, 410);
  const d = await r.json();
  assert.equal(d.code, 'session_closed');
  assert.equal(d.reason, 'закрито клієнтом');
  assert.equal((await fetch(base + '/live/' + sid + '/shot')).status, 410);
  assert.deepEqual(await (await fetch(base + '/live/' + sid, { method: 'DELETE' })).json(), { ok: true, closed: false });
  const u = await post('/live/unknown/act', { type: 'key', key: 'A' });
  assert.equal(u.status, 410);
  assert.match((await u.json()).reason, /невідома/);
});

test('GET /shot у польоті, а сесію закрили (DELETE) → 410 session_closed, а не 500', async () => {
  const { sid, s } = await openLive();
  let release;
  const gate = new Promise((r) => { release = r; });
  s.page.screenshot = async () => { await gate; throw new Error('page.screenshot: Target page, context or browser has been closed'); };
  const shotP = fetch(base + '/live/' + sid + '/shot');
  await new Promise((r) => setTimeout(r, 50)); // запит уже чекає на скриншот
  assert.equal((await fetch(base + '/live/' + sid, { method: 'DELETE' })).status, 200);
  release();
  const r = await shotP;
  assert.equal(r.status, 410);
  const d = await r.json();
  assert.equal(d.code, 'session_closed');
  assert.equal(d.reason, 'закрито клієнтом');
});

test('помилки в JSON без ANSI-кодів і «Call log» (cleanError у errorHandler)', async () => {
  const { sid, s } = await openLive();
  s.page.screenshot = async () => { throw new Error('page.screenshot: boom\nCall log:\n  \x1b[2m - waiting\x1b[22m'); };
  const r = await fetch(base + '/live/' + sid + '/shot');
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'boom');
});

test('ліміт 2 сесії: третя → 429 (обидві активні); relaunch закриває всі з причиною «config changed»', async () => {
  const a = await openLive();
  const b = await openLive();
  const r = await post('/live', { url: 'x.test' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'too_many_sessions');
  await engine.relaunchBrowser();
  assert.equal(sessions.size, 0);
  for (const sid of [a.sid, b.sid]) {
    const x = await post('/live/' + sid + '/act', { type: 'key', key: 'A' });
    assert.equal(x.status, 410);
    assert.equal((await x.json()).reason, 'config changed');
  }
  assert.equal(sem.active, 0);
});

test('сторінку сесії закрито ззовні → сесія закрита (410 «сторінку закрито»)', async () => {
  const { sid, s } = await openLive();
  s.page.st.closed = true;
  s.unit.context.pages = () => [];
  s.page.emit('close');
  await new Promise((r) => setTimeout(r, 10));
  const x = await post('/live/' + sid + '/act', { type: 'key', key: 'A' });
  assert.equal(x.status, 410);
  assert.equal((await x.json()).reason, 'сторінку закрито');
});

test('попап: нова сторінка контексту стає сторінкою сесії', async () => {
  const { sid, s } = await openLive();
  const popup = fakePage();
  s.unit.context.emit('page', popup);
  await act(sid, { type: 'key', key: 'X' });
  assert.deepEqual(popup.st.keys, ['X']);
  const k = await act(sid, { type: 'key', key: 'Y' });
  assert.equal(k.ok, true);
  await post('/live/' + sid + '/close');
});

test('немає вільного слота за таймаут → 503 у потоці (після події session) і сесію закрито', async () => {
  const held = [];
  while (sem.active < sem.max) { await sem.acquire(); held.push(1); }
  const ev = await nd(await post('/live', { url: 'x.test' }));
  for (const _ of held) sem.release();
  assert.equal(ev[0].event, 'session');
  const err = ev.at(-1);
  assert.equal(err.event, 'error');
  assert.match(err.message, /Немає вільного слота/);
  assert.equal(sessions.size, 0);
});

test('GET /lib/<name>.js: білий список спільних модулів як JS; інше — 404', async () => {
  for (const n of SHARED_LIBS) {
    const r = await fetch(base + '/lib/' + n + '.js');
    assert.equal(r.status, 200, n);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /export /);
  }
  for (const n of ['db', 'live', 'config', 'session', '..%2Fserver']) {
    assert.equal((await fetch(base + '/lib/' + n + '.js')).status, 404, n);
  }
});

test('спільні модулі ізоморфні: без Node-імпортів (лише відносні імпорти з білого списку)', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib');
  for (const n of SHARED_LIBS) {
    const src = fs.readFileSync(path.join(dir, n + '.js'), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const imp of imports) {
      const m = /^\.\/(\w+)\.js$/.exec(imp);
      assert.ok(m && SHARED_LIBS.includes(m[1]), n + '.js імпортує ' + imp);
    }
    assert.doesNotMatch(src, /\brequire\(|process\.|Buffer\./, n);
  }
});


// ---------- закриття під час відкриття: потік закінчується error з причиною ----------

test('relaunch («config changed») під час відкриття → останнє NDJSON-подія error session_closed з причиною; без live; слот звільнено', async () => {
  let release;
  engine.gate = new Promise((r) => { release = r; });
  const p = post('/live', { url: 'https://slow.test', actions: [{ type: 'key', key: 'Tab' }] }).then(nd);
  for (let i = 0; i < 50 && !sessions.list().length; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
  await engine.relaunchBrowser();
  release(); engine.gate = null;
  const ev = await p;
  const last = ev.at(-1);
  assert.equal(last.event, 'error', JSON.stringify(ev.map((e) => e.event)));
  assert.equal(last.code, 'session_closed');
  assert.equal(last.reason, 'config changed');
  assert.ok(!ev.some((e) => e.event === 'live'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sem.active, 0);
});

test('DELETE /live/:sid з іншої вкладки під час префікса → error session_closed «закрито клієнтом»', async () => {
  let release;
  engine.gate = new Promise((r) => { release = r; });
  const p = post('/live', { url: 'https://slow.test', actions: [{ type: 'key', key: 'Tab' }] }).then(nd);
  for (let i = 0; i < 50 && !sessions.list().length; i++) await new Promise((r) => setTimeout(r, 10));
  const sid = sessions.list()[0].sid;
  assert.equal((await fetch(base + '/live/' + sid, { method: 'DELETE' })).status, 200);
  release(); engine.gate = null;
  const ev = await p;
  assert.equal(ev.at(-1).event, 'error');
  assert.equal(ev.at(-1).code, 'session_closed');
  assert.equal(ev.at(-1).reason, 'закрито клієнтом');
});

// ---------- behavior.humanize діє і в живій сесії ----------

test('humanize: клік — кілька рухів (steps ≥ 6) і пауза між down/up; текст — по буквах; клавіша — з delay; лог поведінки', async () => {
  setBehavior({ humanize: true });
  const { sid, s, ev } = await openLive();
  assert.ok(ev.some((e) => e.event === 'log' && /Поведінка: людська/.test(e.text)));
  s.page.st.seq.length = 0;
  const c = await act(sid, { type: 'click', vx: 300, vy: 200 });
  assert.equal(c.ok, true);
  const seq = s.page.st.seq;
  assert.ok(seq.filter((x) => x === 'move').length >= 2, seq.join(','));
  assert.deepEqual(s.page.st.mouse.at(-1), [300, 200]);
  assert.ok(s.page.st.moveOpts.every((o) => (o.steps || 0) >= 6), JSON.stringify(s.page.st.moveOpts));
  const di = seq.indexOf('down');
  assert.equal(seq[di + 1], 'wait'); // роздільні down/up з паузою
  assert.equal(seq[di + 2], 'up');
  await act(sid, { type: 'text', text: 'abc' });
  assert.deepEqual(s.page.st.typed.slice(-3), ['a', 'b', 'c']);
  await act(sid, { type: 'key', key: 'Enter' });
  const ko = s.page.st.keyOpts.at(-1);
  assert.ok(ko && ko.delay >= 30 && ko.delay <= 90, JSON.stringify(ko));
});

test('humanize вимкнено: клік — один рух + down/up без паузи; текст одним type з delay 25', async () => {
  const { sid, s } = await openLive();
  s.page.st.seq.length = 0;
  await act(sid, { type: 'click', vx: 30, vy: 20 });
  assert.deepEqual(s.page.st.seq.slice(0, 3), ['move', 'down', 'up']);
  await act(sid, { type: 'text', text: 'abc' });
  assert.equal(s.page.st.typed.at(-1), 'abc');
  assert.deepEqual(s.page.st.typeOpts, { delay: 25 });
});

test('префікс: humanize діє (behavior), fastPrefix — швидкий префікс і це видно в лозі', async () => {
  setBehavior({ humanize: true, fastPrefix: true });
  const { ev, s } = await openLive({ url: 'https://x.test', actions: [{ type: 'text', text: 'hi' }] });
  assert.ok(ev.some((e) => e.event === 'log' && /префікс: швидкий/.test(e.text)));
  assert.deepEqual(s.page.st.typed, ['hi']); // швидкий — без друку по буквах
  await sessions.close(s.sid, 't');
  setBehavior({ humanize: true, fastPrefix: false });
  const r2 = await openLive({ url: 'https://x.test', actions: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(r2.s.page.st.typed, ['h', 'i']); // людський префікс
});
