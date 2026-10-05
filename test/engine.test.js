// Юніт-тести рушія (lib/engine.js): чисті білдери опцій + пул із фейковими запускачами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchArgs, launchFlags, camoufoxOptions, engineKind, createEngine } from '../lib/engine.js';
import { defaultProfile, applyProfilePatch } from '../lib/profile.js';

const SI = ['--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials'];
const GPU = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=metal'];
const AC = '--disable-blink-features=AutomationControlled';

test('launchArgs: дефолтний профіль (All) — усе ввімкнено, включно з вимкненою ізоляцією', () => {
  assert.deepEqual(launchArgs(defaultProfile().launch), [AC, ...GPU, ...SI]);
});

test('launchArgs: siteIsolationDisabled=false → без прапорців ізоляції (баг-фікс)', () => {
  const args = launchArgs({ ...defaultProfile().launch, siteIsolationDisabled: false });
  for (const a of SI) assert.equal(args.includes(a), false);
  assert.ok(args.includes(AC));
});

test('launchArgs: Clear all → голий Playwright (жодних аргументів)', () => {
  const p = applyProfilePatch(defaultProfile(), { clear: true }).profile;
  assert.deepEqual(launchArgs(p.launch), []);
});

test('launchArgs: відсутні поля трактуються як увімкнені (сумісність)', () => {
  assert.deepEqual(launchArgs({}), [AC, ...GPU, ...SI]);
  assert.deepEqual(launchArgs(undefined), [AC, ...GPU, ...SI]);
});

test('launchFlags: new headless / old headless / headful', () => {
  const n = launchFlags({ headless: true, newHeadless: true });
  assert.equal(n.headless, false);
  assert.equal(n.channel, 'chrome');
  assert.equal(n.args.at(-1), '--headless=new');
  const o = launchFlags({ headless: true, newHeadless: false });
  assert.equal(o.headless, true);
  assert.equal(o.args.includes('--headless=new'), false);
  const h = launchFlags({ headless: false });
  assert.equal(h.headless, false);
  assert.equal(h.args.includes('--headless=new'), false);
});

test('camoufoxOptions і engineKind', () => {
  assert.deepEqual(camoufoxOptions({ headless: true, camoufoxHumanize: false, camoufoxGeoip: false }), { headless: true, humanize: false, geoip: false });
  assert.deepEqual(camoufoxOptions({}), { headless: true, humanize: true, geoip: true });
  assert.equal(engineKind({ launch: { engine: 'camoufox' } }), 'camoufox');
  assert.equal(engineKind({ launch: {} }), 'chromium');
  assert.equal(engineKind(null), 'chromium');
});

// --- Фейковий браузер ---
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeWorld({ launchDelay = 5, pageDelay = 0 } = {}) {
  const w = { launches: [], browsers: [], contexts: 0 };
  const makeBrowser = (kind, opts) => {
    const b = {
      kind, opts, closed: false, ctxs: [], handlers: {},
      on(ev, fn) { (b.handlers[ev] ||= []).push(fn); },
      emit(ev) { for (const fn of b.handlers[ev] || []) fn(); },
      async newContext(o) {
        if (b.closed) throw new Error('Target closed');
        await delay(1);
        w.contexts++;
        const ctx = {
          o, closed: false, inits: [],
          async addInitScript(s) { ctx.inits.push(s); },
          async newPage() { if (pageDelay) await delay(pageDelay); if (ctx.closed || b.closed) throw new Error('Target closed'); return { ctx, isClosed: () => ctx.closed }; },
          async close() { ctx.closed = true; },
        };
        b.ctxs.push(ctx);
        return ctx;
      },
      async close() { b.closed = true; },
    };
    w.browsers.push(b);
    return b;
  };
  w.launchers = {
    async chromium(flags, usePlugin) { w.launches.push(['chromium', usePlugin]); await delay(launchDelay); return makeBrowser('chromium', flags); },
    async camoufox(opts) { w.launches.push(['camoufox']); await delay(launchDelay); return makeBrowser('camoufox', opts); },
  };
  return w;
}
const quiet = { log() {}, error() {} };

test('engine: single-flight — конкурентні ensureEngine запускають ОДИН браузер', async () => {
  const w = fakeWorld({ launchDelay: 20 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await Promise.all([e.ensureEngine(), e.ensureEngine(), e.takeUnit(), e.refillPool()]);
  assert.equal(w.launches.length, 1);
  assert.equal(e.engineReady(), true);
});

test('engine: takeUnit — з пулу (fromPool) і на льоту, кожен контекст один раз', async () => {
  const w = fakeWorld();
  const profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  const fresh = await e.takeUnit();
  assert.equal(fresh.fromPool, false);
  await e.refillPool();
  assert.equal(e.poolStats().ready, 2);
  const u1 = await e.takeUnit();
  const u2 = await e.takeUnit();
  assert.equal(u1.fromPool, true);
  assert.notEqual(u1.context, u2.context);
  // Chromium: контекст з fingerprint/UA + stealth init-скрипт
  assert.equal(u1.context.inits.length, 1);
  assert.ok(u1.context.o.userAgent);
  await e.closeUnit(u1);
  assert.equal(u1.context.closed, true);
});

test('engine: relaunch — хуки onBeforeRelaunch, новий рушій, старі юніти закрито', async () => {
  const w = fakeWorld();
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  const oldCtxs = [...w.browsers[0].ctxs];
  const calls = [];
  e.onBeforeRelaunch(async () => { calls.push('hook'); });
  profile = applyProfilePatch(profile, { launch: { engine: 'camoufox' } }).profile;
  await e.relaunchBrowser();
  assert.deepEqual(calls, ['hook']);
  assert.equal(w.browsers[0].closed, true);
  assert.ok(oldCtxs.every((c) => c.closed));
  assert.deepEqual(w.launches.map((l) => l[0]), ['chromium', 'camoufox']);
  const u = await e.takeUnit();
  assert.equal(u.camoufox, true);
  assert.equal(u.context.inits.length, 0); // Camoufox: без наших Chromium-патчів
});

test('engine: покоління — юніт, створений під час relaunch, не видається', async () => {
  const w = fakeWorld({ launchDelay: 15 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 3, log: quiet });
  await e.ensureEngine();
  const refill = e.refillPool(); // цикл поповнення в польоті
  await delay(1);
  profile = applyProfilePatch(profile, { launch: { engine: 'camoufox' } }).profile;
  await Promise.all([refill, e.relaunchBrowser()]);
  // Після relaunch у пулі лише Camoufox-юніти; жодного з закритого браузера.
  for (let i = 0; i < 3; i++) {
    const u = await e.takeUnit();
    assert.equal(u.camoufox, true);
    assert.equal(u.context.closed, false);
  }
  assert.equal(w.launches.filter((l) => l[0] === 'chromium').length, 1);
  assert.equal(w.launches.filter((l) => l[0] === 'camoufox').length, 1);
});

test('engine: drainPool — нові контексти з оновленим профілем', async () => {
  const w = fakeWorld();
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  profile = applyProfilePatch(profile, { fingerprint: { userAgent: 'NEW-UA' } }).profile;
  await e.drainPool();
  await e.whenPoolReady(); // пул поповнюється у фоні
  const u = await e.takeUnit();
  assert.equal(u.fromPool, true);
  assert.equal(u.context.o.userAgent, 'NEW-UA');
  assert.equal(w.launches.length, 1); // браузер не перезапускали
});

test('engine: закритий ззовні контекст у пулі пропускається', async () => {
  const w = fakeWorld();
  const profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 1, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  w.browsers[0].ctxs[0].closed = true;
  const u = await e.takeUnit();
  assert.equal(u.context.closed, false);
});

test('engine: помилка запуску не залипає — наступний виклик пробує знову', async () => {
  const w = fakeWorld();
  let fail = true;
  const launchers = { ...w.launchers, async chromium(f, p) { if (fail) throw new Error('no chrome'); return w.launchers.chromium(f, p); } };
  const e = createEngine({ getProfile: () => defaultProfile(), launchers, poolSize: 1, log: quiet });
  await assert.rejects(e.ensureEngine(), /no chrome/);
  assert.equal(e.engineReady(), false);
  fail = false;
  await e.ensureEngine();
  assert.equal(e.engineReady(), true);
});

// Дрейф «прапорець діє, але в конфігураторі його не видно» (як було з siteIsolationDisabled):
// кожен launch.* ключ, який читають білдери запуску, і кожен behavior.* дефолтного
// профілю мають контрол у конфігураторі (public/js/config.js).
test('кожен launch.*/behavior.* прапорець має контрол у конфігураторі (UI)', async () => {
  const fsm = await import('fs');
  const { defaultProfile } = await import('../lib/profile.js');
  const src = fsm.readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8');
  const builders = src.slice(src.indexOf('export function launchArgs'), src.indexOf('export const engineKind'));
  const keys = new Set([...builders.matchAll(/\bL\.(\w+)/g)].map((m) => m[1]));
  assert.ok(keys.has('siteIsolationDisabled') && keys.has('realGpu'));
  const html = fsm.readFileSync(new URL('../public/js/config.js', import.meta.url), 'utf8');
  for (const k of keys) assert.ok(html.includes("'launch." + k + "'"), 'немає контрола для launch.' + k);
  for (const k of Object.keys(defaultProfile().behavior)) assert.ok(html.includes("'behavior." + k + "'"), 'немає контрола для behavior.' + k);
});

// ---------- Швидкий перезапуск: пул у фоні, паралельно ----------
test('engine: поповнення пулу паралельне (Camoufox newPage ~секунди → не множиться на розмір пулу)', async () => {
  const w = fakeWorld({ pageDelay: 60 });
  const profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 3, log: quiet });
  await e.ensureEngine();
  const t0 = Date.now();
  await e.refillPool();
  const ms = Date.now() - t0;
  assert.equal(e.poolStats().ready, 3);
  assert.ok(ms < 150, 'три сторінки паралельно ≈ одна (було ' + ms + ' мс; послідовно було б ≥180)');
});

test('engine: relaunch повертається одразу після запуску браузера, пул добирається у фоні', async () => {
  const w = fakeWorld({ pageDelay: 80 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 3, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  profile = applyProfilePatch(profile, { launch: { engine: 'camoufox' } }).profile;
  const t0 = Date.now();
  await e.relaunchBrowser();
  assert.ok(Date.now() - t0 < 70, 'не чекає створення сторінок пулу');
  assert.equal(e.engineReady(), true);
  assert.ok(e.poolStats().ready < 3);
  await e.whenPoolReady();
  assert.equal(e.poolStats().ready, 3);
  const u = await e.takeUnit();
  assert.equal(u.fromPool, true);
  assert.equal(u.camoufox, true);
});

test('engine: relaunch під час поповнення — не чекає старий цикл, запізнілі юніти закриваються', async () => {
  const w = fakeWorld({ pageDelay: 60 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine();
  const oldRefill = e.refillPool(); // у польоті: 2 сторінки Chromium по 60 мс
  await delay(5);
  profile = applyProfilePatch(profile, { launch: { engine: 'camoufox' } }).profile;
  const t0 = Date.now();
  await e.relaunchBrowser();
  assert.ok(Date.now() - t0 < 50, 'не чекав старе поповнення (' + (Date.now() - t0) + ' мс)');
  await oldRefill;
  await e.whenPoolReady();
  assert.equal(e.poolStats().ready, 2);
  for (let i = 0; i < 2; i++) {
    const u = await e.takeUnit();
    assert.equal(u.camoufox, true, 'у пулі лише юніти нового рушія');
    assert.equal(u.context.closed, false);
  }
  // Усі контексти старого Chromium закрито (браузер закрито).
  assert.equal(w.browsers[0].closed, true);
});

test('engine: drainPool у Camoufox — пул не перестворюється (профіль на контексти не впливає)', async () => {
  const w = fakeWorld();
  let profile = applyProfilePatch(defaultProfile(), { launch: { engine: 'camoufox' } }).profile;
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  const before = w.contexts;
  profile = applyProfilePatch(profile, { fingerprint: { userAgent: 'X' } }).profile;
  await e.drainPool();
  await e.whenPoolReady();
  assert.equal(w.contexts, before, 'жодного нового контексту');
  assert.equal(e.poolStats().ready, 2);
});

test('engine: drainPool у Chromium повертається одразу, старі юніти закрито', async () => {
  const w = fakeWorld({ pageDelay: 60 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  const oldCtxs = [...w.browsers[0].ctxs];
  profile = applyProfilePatch(profile, { fingerprint: { userAgent: 'NEW' } }).profile;
  const t0 = Date.now();
  await e.drainPool();
  assert.ok(Date.now() - t0 < 40);
  await e.whenPoolReady();
  await delay(1);
  assert.ok(oldCtxs.every((c) => c.closed));
  const u = await e.takeUnit();
  assert.equal(u.context.o.userAgent, 'NEW');
});

test('engine: помилки створення сторінок не зациклюють поповнення', async () => {
  const w = fakeWorld();
  const profile = defaultProfile();
  const errs = [];
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: { log() {}, error: (...a) => errs.push(a.join(' ')) } });
  const b = await (async () => { await e.ensureEngine(); return w.browsers[0]; })();
  b.newContext = async () => { throw new Error('boom'); };
  await e.refillPool();
  assert.equal(e.poolStats().ready, 0);
  assert.equal(errs.length, 1, 'одна помилка, без нескінченного циклу');
});

// Регресія: drainPool не чекає пул, але якщо браузера НЕМАЄ (упав/не піднявся) —
// має дочекатися запуску браузера, інакше POST /profile хибно звітує launchError.
test('engine: drainPool після відʼєднання браузера — повертається з піднятим рушієм', async () => {
  const w = fakeWorld({ launchDelay: 30 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 2, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  w.browsers[0].emit('disconnected');
  assert.equal(e.engineReady(), false);
  profile = applyProfilePatch(profile, { fingerprint: { userAgent: 'NEW' } }).profile;
  await e.drainPool();
  assert.equal(e.engineReady(), true);
  await e.whenPoolReady();
  assert.equal(w.launches.length, 2, 'рівно один перезапуск (single-flight з поповненням)');
  assert.equal(e.poolStats().ready, 2);
});

test('engine: drainPool, поки стартовий запуск ще йде — чекає браузер', async () => {
  const w = fakeWorld({ launchDelay: 40 });
  let profile = defaultProfile();
  const e = createEngine({ getProfile: () => profile, launchers: w.launchers, poolSize: 1, log: quiet });
  const starting = e.ensureEngine();
  profile = applyProfilePatch(profile, { stealth: { webdriver: false } }).profile;
  await e.drainPool();
  assert.equal(e.engineReady(), true);
  await starting; await e.whenPoolReady();
  assert.equal(w.launches.length, 1);
});

test('engine: drainPool без браузера і зі збоєм запуску — відхиляється (реальна помилка доходить до роуту)', async () => {
  const w = fakeWorld();
  let fail = false;
  const launchers = { ...w.launchers, async chromium(f, p) { if (fail) throw new Error('no chrome'); return w.launchers.chromium(f, p); } };
  const e = createEngine({ getProfile: () => defaultProfile(), launchers, poolSize: 1, log: quiet });
  await e.ensureEngine(); await e.refillPool();
  fail = true;
  w.browsers[0].emit('disconnected');
  await assert.rejects(e.drainPool(), /no chrome/);
  assert.equal(e.engineReady(), false);
  await e.whenPoolReady();
});
