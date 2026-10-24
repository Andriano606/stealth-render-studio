// MCP: видимий браузер для входу (lib/interactive.js), збережені сесії (lib/savedSessions.js) і
// повний цикл тулів open_browser → browser_status → save_session → open_page {session} → close_browser
// на фейкових браузерах — без справжнього Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateSessionName, sessionFile, sessionSummary, mergeStorageState, createSavedSessions,
} from '../lib/savedSessions.js';
import { createInteractiveBrowsers, headfulProfile, headfulContextOptions } from '../lib/interactive.js';
import { createMcpTools, resolveMcpProfile, unitSource } from '../lib/mcpTools.js';
import { createScratchBrowsers } from '../lib/scratch.js';
import { defaultProfile } from '../lib/profile.js';

const quiet = { log() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'srs-sess-'));

const STATE = {
  cookies: [
    { name: 'sid', value: 'SECRET', domain: '.site.test', path: '/' },
    { name: 'pref', value: '1', domain: 'site.test', path: '/' },
    { name: 'x', value: '2', domain: 'cdn.other.test', path: '/' },
  ],
  origins: [{ origin: 'https://site.test', localStorage: [{ name: 'token', value: 'T' }] }, { origin: 'https://empty.test', localStorage: [] }],
};

// ---------- сховище сесій ----------
test('validateSessionName / sessionFile: обрізання, ліміт, без регістру, безпечне імʼя файлу', () => {
  assert.deepEqual(validateSessionName('  Gmail   main '), { name: 'Gmail main' });
  assert.match(validateSessionName('').error, /порожньою/);
  assert.match(validateSessionName(5).error, /рядком/);
  assert.match(validateSessionName('x'.repeat(81)).error, /80/);
  assert.equal(sessionFile('Gmail'), sessionFile('gmail'));
  assert.equal(sessionFile('../etc/passwd'), '%2E%2E%2Fetc%2Fpasswd.json');
  assert.ok(!sessionFile('a/b').includes('/'));
});

test('sessionSummary: без значень — кількість, домени, origin зі сховищем; mergeStorageState: b перемагає', () => {
  assert.deepEqual(sessionSummary(STATE), { cookies: 3, domains: ['cdn.other.test', 'site.test'], origins: ['https://site.test'] });
  assert.deepEqual(sessionSummary(null), { cookies: 0, domains: [], origins: [] });
  assert.ok(!JSON.stringify(sessionSummary(STATE)).includes('SECRET'));
  const a = { cookies: [{ name: 'sid', value: 'old', domain: '.site.test', path: '/' }, { name: 'keep', value: 'k', domain: 'a.test', path: '/' }], origins: [{ origin: 'https://site.test', localStorage: [] }] };
  const m = mergeStorageState(a, STATE);
  assert.equal(m.cookies.length, 4);
  assert.equal(m.cookies.find((c) => c.name === 'sid').value, 'SECRET');
  assert.equal(m.origins.find((o) => o.origin === 'https://site.test').localStorage[0].value, 'T');
  assert.deepEqual(mergeStorageState(null, null), { cookies: [], origins: [] });
});

test('createSavedSessions: save/get/list/remove, перезапис тієї ж назви, файл лише власнику', () => {
  const dir = path.join(tmpDir(), 'sessions');
  const s = createSavedSessions(dir);
  assert.deepEqual(s.list(), [], 'теки ще немає');
  const rec = s.save({ name: ' Site ', storageState: STATE, url: 'https://site.test/home', engine: 'chromium' });
  assert.equal(rec.name, 'Site');
  assert.equal(s.get('site').storageState.cookies.length, 3);
  assert.equal(fs.statSync(path.join(dir, sessionFile('Site'))).mode & 0o777, 0o600);
  s.save({ name: 'site', storageState: { cookies: [], origins: [] } });
  assert.equal(s.list().length, 1, 'та сама назва без регістру — перезапис');
  s.save({ name: 'B', storageState: STATE });
  assert.deepEqual(s.list().map((x) => x.name), ['B', 'site']);
  assert.equal(s.get('nope'), null);
  assert.equal(s.get(''), null);
  assert.throws(() => s.save({ name: '', storageState: STATE }), /порожньою/);
  assert.equal(s.remove('B'), true);
  assert.equal(s.remove('B'), false);
  fs.writeFileSync(path.join(dir, 'junk.json'), '{bad');
  assert.equal(s.list().length, 1, 'зіпсований файл пропускається');
});

// ---------- фейковий світ браузерів ----------
function fakeWorld() {
  const w = { launches: [], browsers: [] };
  const mkPage = (ctx, url = 'about:blank') => {
    const pg = {
      _url: url, closed: false,
      url: () => pg._url, isClosed: () => pg.closed,
      async goto(u) { pg._url = u; return { status: () => 200 }; },
      async title() { return 'T ' + pg._url; },
      async screenshot() { return Buffer.from('IMG'); },
      async waitForLoadState() {}, async waitForTimeout() {},
      async content() { return '<html></html>'; },
      async evaluate() { return false; },
      frames() { return [{ evaluate: async (fn) => (String(fn).includes('location.href') ? { url: pg._url, text: 'Welcome, Andrii' } : 100) }]; },
      mainFrame() { return pg.frames()[0]; },
      mouse: { async move() {}, async wheel() {} },
    };
    ctx.pages_.push(pg);
    return pg;
  };
  const mk = (kind, opts) => {
    const b = { kind, opts, closed: false, handlers: {}, ctxs: [],
      on(ev, fn) { (b.handlers[ev] ||= []).push(fn); },
      emit(ev) { for (const fn of b.handlers[ev] || []) fn(); },
      async newContext(o) {
        const ctx = { o, closed: false, inits: [], pages_: [], handlers: {},
          on(ev, fn) { (ctx.handlers[ev] ||= []).push(fn); },
          async addInitScript(s) { ctx.inits.push(s); },
          async newPage() { return mkPage(ctx); },
          pages() { return ctx.pages_; },
          async cookies() { return ctx.cookies_ || (ctx.o && ctx.o.storageState && ctx.o.storageState.cookies) || []; },
          async storageState(opt) { ctx.lastStateOpt = opt; return { cookies: ctx.cookies_ || [], origins: ctx.origins_ || [] }; },
          async close() { ctx.closed = true; } };
        b.ctxs.push(ctx);
        return ctx;
      },
      async close() { b.closed = true; } };
    w.browsers.push(b);
    return b;
  };
  w.launchers = {
    async chromium(flags, plugin) { w.launches.push(['chromium', flags, plugin]); return mk('chromium', flags); },
    async camoufox(opts) { w.launches.push(['camoufox', opts]); return mk('camoufox', opts); },
  };
  return w;
}

test('headfulProfile / headfulContextOptions: headless вимкнено; viewport:null без deviceScaleFactor; Camoufox — лише storageState', () => {
  const p = { ...defaultProfile(), fingerprint: { userAgent: 'UA', deviceScaleFactor: 2, locale: 'uk-UA' } };
  assert.equal(headfulProfile(p).launch.headless, false);
  assert.equal(p.launch.headless, true, 'вхідний не мутується');
  const o = headfulContextOptions(p, 'chromium');
  assert.equal(o.viewport, null);
  assert.equal('deviceScaleFactor' in o, false);
  assert.equal(o.userAgent, 'UA');
  assert.equal(headfulContextOptions(p, 'chromium', STATE).storageState, STATE);
  assert.deepEqual(headfulContextOptions(p, 'camoufox'), { viewport: null });
  assert.deepEqual(headfulContextOptions(p, 'camoufox', STATE), { viewport: null, storageState: STATE });
});

test('interactive: відкриває headful-браузер зі stealth, ліміт, get без id лише для одного, закриття вікна прибирає', async () => {
  const w = fakeWorld();
  const ib = createInteractiveBrowsers({ launchers: w.launchers, log: quiet, max: 2 });
  const a = await ib.open(defaultProfile(), { url: 'https://site.test/login', label: 'L' });
  assert.equal(a.id, 'b1');
  const [kind, flags, plugin] = w.launches[0];
  assert.equal(kind, 'chromium');
  assert.equal(flags.headless, false);
  assert.ok(!flags.args.includes('--headless=new'), 'видиме вікно');
  assert.equal(plugin, true);
  assert.equal(a.context.inits.length, 1, 'наш stealth-скрипт');
  assert.equal(ib.pagesOf(a).active.url(), 'https://site.test/login');
  assert.equal(ib.get().id, 'b1', 'один відкритий — id можна не вказувати');
  const b = await ib.open({ ...defaultProfile(), launch: { ...defaultProfile().launch, engine: 'camoufox' } }, { storageState: STATE });
  assert.equal(w.launches[1][1].headless, false);
  assert.deepEqual(b.context.o, { viewport: null, storageState: STATE });
  assert.equal(b.context.inits.length, 0, 'Camoufox без наших JS-патчів');
  assert.throws(() => ib.get(), /Вкажи browser.*b1, b2/);
  assert.throws(() => ib.get('b9'), /«b9» не знайдено/);
  await assert.rejects(ib.open(defaultProfile()), /Уже відкрито 2/);
  w.browsers[0].emit('disconnected'); // користувач закрив вікно
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(ib.list().map((x) => x.id), ['b2']);
  await ib.close('b2');
  assert.equal(w.browsers[1].closed, true);
  assert.throws(() => ib.get(), /Немає відкритих/);
});

test('interactive: простій без звернень MCP закриває; звернення (get) продовжує життя', async () => {
  const w = fakeWorld();
  let t = 0;
  const ib = createInteractiveBrowsers({ launchers: w.launchers, log: quiet, idleMs: 100, now: () => t });
  await ib.open(defaultProfile());
  t = 90; ib.get('b1'); t = 150; ib.sweep();
  assert.equal(ib.list().length, 1);
  t = 300; ib.sweep();
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(ib.list().length, 0);
  assert.equal(w.browsers[0].closed, true);
});

test('resolveMcpProfile: session перекриває cookies профілю; unitSource withState — Camoufox не з пулу', () => {
  const applied = { ...defaultProfile(), storageState: { cookies: [{ name: 'old' }] } };
  const r = resolveMcpProfile(applied, { cookies: false }, [], { session: { name: 'Site', storageState: STATE } });
  assert.equal(r.profile.storageState, STATE);
  assert.equal(r.session, 'Site');
  assert.match(r.label, /без cookies \+ сесія «Site»/);
  const cfx = { ...applied, launch: { ...applied.launch, engine: 'camoufox' } };
  assert.equal(unitSource(cfx, cfx), 'pool');
  assert.equal(unitSource(cfx, cfx, { withState: true }), 'main');
  assert.equal(unitSource({ ...applied, storageState: STATE }, applied, { withState: true }), 'main');
});

// ---------- повний цикл тулів ----------
function setup({ engineKindApplied = 'chromium' } = {}) {
  const w = fakeWorld();
  let applied = { ...defaultProfile(), launch: { ...defaultProfile().launch, engine: engineKindApplied }, storageState: { cookies: [{ name: 'keep', value: 'k', domain: 'a.test', path: '/' }], origins: [] } };
  const store = { saved: 0, get: () => applied, set(p) { applied = p; }, save() { store.saved++; } };
  const engineCalls = [];
  const engine = {
    engineReady: () => true,
    async takeUnit() { engineCalls.push(['take']); const b = await w.launchers.chromium({}, true); const ctx = await b.newContext({}); return { context: ctx, page: await ctx.newPage(), fromPool: true }; },
    async unitWithProfile(p, opts) {
      engineCalls.push(['with', p.storageState, opts]);
      const ctx = await (await w.launchers.chromium({}, true)).newContext({ storageState: p.storageState });
      return { context: ctx, page: await ctx.newPage(), fromPool: false };
    },
    async closeUnit() {},
    async drainPool() { engineCalls.push(['drain']); },
  };
  const dir = tmpDir();
  const savedSessions = createSavedSessions(path.join(dir, 'sessions'));
  const interactive = createInteractiveBrowsers({ launchers: w.launchers, log: quiet });
  const tools = Object.fromEntries(createMcpTools({
    engine, scratch: createScratchBrowsers({ launchers: w.launchers, log: quiet }), interactive, savedSessions,
    sem: { acquire: async () => {}, release() {} }, profileStore: store, log: quiet,
  }).map((t) => [t.name, t]));
  const text = async (name, args) => { const r = await tools[name].handler(args || {}, {}); return typeof r === 'string' ? r : r.content[0].text; };
  return { w, tools, text, store, engineCalls, savedSessions, interactive, getApplied: () => applied };
}

test('цикл входу: open_browser → status → save_session → open_page{session} → close_browser{saveAs}; профіль без змін', async () => {
  const { w, tools, text, store, engineCalls, savedSessions, getApplied } = setup();
  const before = JSON.stringify(getApplied());
  const opened = await text('open_browser', { url: 'site.test/login', preset: undefined, stealth: { webdriver: false } });
  assert.match(opened, /Відкрито видимий браузер b1 — Chromium · конфіг: застосований конфіг \+ stealth\.webdriver=false/);
  assert.match(opened, /save_session \{browser:"b1"/);
  const [, flags] = w.launches[0];
  assert.equal(flags.headless, false);

  // Користувач залогінився: у контексті зʼявились cookies/localStorage.
  const ctx = w.browsers[0].ctxs[0];
  ctx.cookies_ = STATE.cookies; ctx.origins_ = STATE.origins;
  ctx.pages_[0]._url = 'https://site.test/home';

  const st = await tools.browser_status.handler({ content: 'text', screenshot: true });
  assert.match(st.content[0].text, /▶ 1\. https:\/\/site\.test\/home — T https:\/\/site\.test\/home/);
  assert.match(st.content[0].text, /Cookies: 3 cookies \(cdn\.other\.test, site\.test\)/);
  assert.ok(!st.content[0].text.includes('SECRET'), 'значення cookies не віддаються');
  assert.match(st.content[1].text, /Welcome, Andrii/);
  assert.equal(st.content[2].type, 'image');

  const saved = await text('save_session', { name: 'Site' });
  assert.match(saved, /Сесію «Site» збережено \(b1, chromium\): 3 cookies \(cdn\.other\.test, site\.test\); localStorage\/IndexedDB: https:\/\/site\.test\./);
  assert.deepEqual(ctx.lastStateOpt, { indexedDB: true });
  assert.equal(savedSessions.get('site').url, 'https://site.test/home');
  assert.equal(JSON.stringify(getApplied()), before, 'без applyToProfile профіль не змінено');
  assert.equal(store.saved, 0);

  const page = await tools.open_page.handler({ url: 'https://site.test/feed', session: 'site' }, {});
  assert.match(page.content[0].text, /конфіг: застосований конфіг \+ сесія «Site»/);
  const call = engineCalls.find((c) => c[0] === 'with');
  assert.equal(call[1].cookies.length, 3, 'контекст отримав cookies сесії');
  assert.deepEqual(call[2], { camoufoxState: true });

  await assert.rejects(tools.open_page.handler({ url: 'https://x.test', session: 'nope' }, {}), /Сесію «nope» не знайдено\. Збережені: «Site»/);

  const closed = await text('close_browser', { saveAs: 'Site 2' });
  assert.match(closed, /«Site 2» збережено[\s\S]*Браузер b1 закрито/);
  assert.equal(w.browsers[0].closed, true);
  const list = JSON.parse(await text('list_sessions'));
  assert.deepEqual(list.map((x) => [x.name, x.cookies]), [['Site', 3], ['Site 2', 3]]);
  assert.ok(!JSON.stringify(list).includes('SECRET'));
  assert.match(await text('delete_session', { name: 'site 2' }), /видалено/);
  await assert.rejects(tools.delete_session.handler({ name: 'site 2' }), /не знайдено/);
});

test('save_session applyToProfile: зливає cookies у профіль, зберігає profile.json, перестворює пул', async () => {
  const { w, text, store, engineCalls, getApplied } = setup();
  await text('open_browser', {});
  const ctx = w.browsers[0].ctxs[0];
  ctx.cookies_ = STATE.cookies; ctx.origins_ = STATE.origins;
  const out = await text('save_session', { name: 'S', applyToProfile: true });
  assert.match(out, /Додано в cookies профілю .*тепер там 4 cookies/);
  assert.deepEqual(getApplied().storageState.cookies.map((c) => c.name).sort(), ['keep', 'pref', 'sid', 'x']);
  assert.equal(store.saved, 1);
  assert.ok(engineCalls.some((c) => c[0] === 'drain'));
});

test('save_session: без cookies — попередження; Camoufox-профіль — підказка про session; помилки назви/браузера', async () => {
  const { text, tools } = setup({ engineKindApplied: 'camoufox' });
  await assert.rejects(tools.save_session.handler({ name: 'x' }), /Немає відкритих/);
  await text('open_browser', {});
  assert.match(await text('save_session', { name: 'E' }), /Cookies немає — схоже, вхід ще не виконано/);
  assert.match(await text('save_session', { name: 'E2', applyToProfile: true }), /Camoufox: його контексти cookies профілю не беруть/);
  await assert.rejects(tools.save_session.handler({ name: '  ' }), /name: назва сесії не може бути порожньою/);
  assert.match(await text('browser_status', {}), /Браузер b1 — Camoufox/);
});

test('open_browser: недоступні видимі браузери / немає дисплея — людська помилка', async () => {
  const noIb = Object.fromEntries(createMcpTools({ engine: {}, sem: {}, profileStore: { get: defaultProfile } }).map((t) => [t.name, t]));
  await assert.rejects(noIb.open_browser.handler({}), /Видимі браузери недоступні/);
  assert.match(await noIb.list_sessions.handler(), /Збережених сесій немає/);
  const launchers = { async chromium() { throw new Error('Missing X server or $DISPLAY'); } };
  const t = Object.fromEntries(createMcpTools({
    engine: {}, sem: {}, profileStore: { get: defaultProfile }, interactive: createInteractiveBrowsers({ launchers, log: quiet }),
  }).map((x) => [x.name, x]));
  await assert.rejects(t.open_browser.handler({}), /не відкрився: .*немає графічного дисплея/);
});
