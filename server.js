import express from 'express';
import { chromium as chromiumPlain } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Camoufox } from 'camoufox-js';
import pg from 'pg';

// Реєструємо stealth-плагін на extra-рушії (десятки анти-детект патчів).
// ВАЖЛИВО: вимикаємо webgl.vendor-евейжн — бо ми вмикаємо СПРАВЖНІЙ GPU, і
// підміна назви WebGL у фіксований Intel створила б суперечність із реальними
// пікселями Apple GPU. Хай справжні значення проходять як є.
const _stealth = StealthPlugin();
try { _stealth.enabledEvasions.delete('webgl.vendor'); } catch (_e) {}
chromiumExtra.use(_stealth);
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORT = 3000;
const MAX_CONCURRENT = 6; // ліміт одночасних рендерів, щоб не покласти машину

// Тека для завантажених файлів (для дій типу "file")
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '30mb' })); // файли приходять як base64 у JSON
// no-cache, щоб браузер завжди підтягував свіжий index.html/JS під час розробки
app.use(express.static('public', { etag: false, lastModified: false, maxAge: 0, cacheControl: false }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// --- Браузер: запускається ОДИН раз і живе весь час роботи сервера ---
// Два режими:
//  • Звичайний (ізольований): browser.newContext() на кожен запит — ізоляція + пул.
//  • Persistent profile: один постійний контекст із текою профілю на диску,
//    що зберігає cookies/cache (включно з cf_clearance Cloudflare). Ізоляції немає.
let browser = null;          // Chromium, режим ізоляції
let persistentCtx = null;    // Chromium, режим persistent
let camoufoxBrowser = null;  // Camoufox (Firefox-антидетект)
let browserInfo = null;
const USER_DATA_DIR = path.join(process.cwd(), 'browser_profile');

function isCamoufox() { return (profile.launch && profile.launch.engine) === 'camoufox'; }
function isPersistent() { return false; } // режим persistent вимкнено (завжди ізольований контекст)
function launchArgs() {
  const L = profile.launch || {};
  const args = [];
  // Прибирає ключовий сигнал автоматизації на рівні рушія.
  if (L.automationControlled !== false) args.push('--disable-blink-features=AutomationControlled');
  // Справжній апаратний GPU (ANGLE→Metal на Mac) замість софтверного SwiftShader.
  if (L.realGpu !== false) args.push('--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=metal');
  // Ізоляцію сайтів завжди вимкнено — щоб крос-доменні iframe (напр. форма Ashby)
  // рендерились у спільному процесі й потрапляли у fullPage-скриншот.
  args.push('--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials');
  return args;
}
// Опції запуску. Новий headless (--headless=new) майже не відрізняється від
// справжнього Chrome; старий headless (headless:true) — детектованіший.
function launchFlags() {
  const L = profile.launch || {};
  const args = launchArgs();
  const wantHeadless = L.headless !== false;
  if (!wantHeadless) return { headless: false, channel: 'chrome', args };        // headful
  if (L.newHeadless !== false) { args.push('--headless=new'); return { headless: false, channel: 'chrome', args }; }
  return { headless: true, channel: 'chrome', args };                            // старий headless
}
// Прибирає storageState зі spec контексту для persistent-режиму (там свій профіль на диску).
function persistentContextOptions() {
  const o = contextOptions();
  delete o.storageState;
  return o;
}
// Готує активний «движок» (Chromium або Camoufox) залежно від режиму.
async function ensureEngine() {
  const L = profile.launch || {};

  // --- Camoufox: Firefox-антидетект (інший рушій, власний fingerprint у C++) ---
  if (isCamoufox()) {
    if (!camoufoxBrowser) {
      console.log('Запускаю CAMOUFOX (Firefox-антидетект)...');
      camoufoxBrowser = await Camoufox({
        headless: L.headless !== false,
        humanize: L.camoufoxHumanize !== false, // людські рухи курсора на рівні рушія
        geoip: L.camoufoxGeoip !== false,        // підбирає timezone/locale під IP
      });
      browserInfo = { engine: 'camoufox', headless: L.headless !== false };
      console.log('Camoufox готовий.');
    }
    return;
  }

  const usePlugin = L.stealthPlugin !== false;
  const engine = usePlugin ? chromiumExtra : chromiumPlain;
  const flags = launchFlags();

  if (isPersistent()) {
    if (!persistentCtx) {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true });
      console.log('Запускаю PERSISTENT браузер (профіль: ' + USER_DATA_DIR + ')...');
      persistentCtx = await engine.launchPersistentContext(USER_DATA_DIR, {
        ...flags, ...persistentContextOptions(),
      });
      await persistentCtx.addInitScript(stealthScript(profile.fingerprint));
      browserInfo = { persistent: true, ...flags, stealthPlugin: usePlugin };
      console.log('Persistent-браузер готовий.');
    }
  } else {
    if (!browser) {
      console.log('Запускаю браузер (ізольований), stealth-plugin=' + usePlugin + '...');
      browser = await engine.launch(flags);
      browserInfo = { persistent: false, ...flags, stealthPlugin: usePlugin };
      console.log('Браузер готовий і чекає на запити.');
    }
  }
}
// Сумісність зі старим ім'ям — просто готує движок.
async function getBrowser() { await ensureEngine(); return browser; }
function engineReady() {
  if (isCamoufox()) return !!camoufoxBrowser;
  return isPersistent() ? !!persistentCtx : !!browser;
}

// Закриває використану одиницю: у persistent — лише сторінку (контекст спільний),
// у звичайному — весь контекст.
async function closeUnit(unit) {
  if (!unit) return;
  try {
    if (unit.persistent) { if (unit.page) await unit.page.close(); }
    else if (unit.context) await unit.context.close();
  } catch (_e) {}
}

// Перезапуск движка (при зміні launch-прапорців чи профілю).
async function relaunchBrowser() {
  const old = pool.splice(0, pool.length);
  for (const u of old) { await closeUnit(u); }
  if (browser) { try { await browser.close(); } catch (_e) {} browser = null; }
  if (persistentCtx) { try { await persistentCtx.close(); } catch (_e) {} persistentCtx = null; }
  if (camoufoxBrowser) { try { await camoufoxBrowser.close(); } catch (_e) {} camoufoxBrowser = null; }
  await ensureEngine();
  await refillPool();
}

// --- Пул ЗАЗДАЛЕГІДЬ готових контекстів ---
// Сервер тримає кілька свіжих контекстів із уже відкритою порожньою сторінкою.
// Коли приходить запит — бере готовий (миттєво), а пул у фоні поповнюється.
// Кожен контекст використовується РІВНО ОДИН раз → ізоляція сесій зберігається.
const POOL_SIZE = 3;
const pool = [];
let refilling = false;

// --- Профіль реального браузера (fingerprint + cookies) ---
// Заповнюється з index.html, який виконується у ТВОЄМУ справжньому Chrome,
// тож зчитує реальні задекларовані параметри. Зберігається у profile.json.
const PROFILE_FILE = path.join(process.cwd(), 'profile.json');
let profile = {
  fingerprint: null,
  storageState: null,
  stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true }, // наші анти-детект доповнення
  launch: { headless: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false, engine: 'chromium', automationControlled: true, realGpu: true, newHeadless: true, camoufoxHumanize: true, camoufoxGeoip: true }, // параметри запуску
  behavior: { humanize: true },                          // людські рухи/затримки при відтворенні
};
try {
  if (fs.existsSync(PROFILE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    profile.fingerprint = loaded.fingerprint ?? null;
    profile.storageState = loaded.storageState ?? null;
    profile.stealth = Object.assign(profile.stealth, loaded.stealth || {});
    profile.launch = Object.assign(profile.launch, loaded.launch || {});
    profile.behavior = Object.assign(profile.behavior, loaded.behavior || {});
  }
} catch (_e) {}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Опції newContext на основі захопленого профілю (із запасними значеннями).
function contextOptions() {
  const fp = profile.fingerprint || {};
  const opts = {
    viewport: fp.viewport && fp.viewport.width ? fp.viewport : { width: 1280, height: 900 },
    userAgent: fp.userAgent || DEFAULT_UA,
    locale: fp.locale || 'en-US',
    timezoneId: fp.timezoneId || undefined,
    deviceScaleFactor: fp.deviceScaleFactor || 1,
  };
  if (profile.storageState && Array.isArray(profile.storageState.cookies)) {
    opts.storageState = profile.storageState;
  }
  return opts;
}

// JS, що виконується ДО скриптів сторінки в кожному контексті: прибирає
// сигнали автоматизації й підставляє задекларовані параметри реального браузера.
function stealthScript(fp) {
  const st = profile.stealth || {};
  return `(() => {
    const fp = ${JSON.stringify(fp || {})};
    const st = ${JSON.stringify(st)};
    // webdriver: НЕ створюємо own-property на navigator (інакше getOwnPropertyNames
    // його видає). Прибираємо own-property, якщо є, і ховаємо через прототип.
    try {
      if (st.webdriver) {
        if (Object.getOwnPropertyDescriptor(navigator, 'webdriver')) { try { delete navigator.webdriver; } catch(e){} }
        // Справжній Chrome: navigator.webdriver === false (на прототипі, не own-property).
        try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
      }
    } catch(e){}
    try { if (fp.languages) Object.defineProperty(navigator, 'languages', { get: () => fp.languages }); } catch(e){}
    try { if (fp.hardwareConcurrency) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency }); } catch(e){}
    try { if (fp.deviceMemory) Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory }); } catch(e){}
    try { if (fp.platform) Object.defineProperty(navigator, 'platform', { get: () => fp.platform }); } catch(e){}
    try { if (fp.vendor) Object.defineProperty(navigator, 'vendor', { get: () => fp.vendor }); } catch(e){}
    try {
      if (fp.screen) {
        Object.defineProperty(screen, 'width', { get: () => fp.screen.width });
        Object.defineProperty(screen, 'height', { get: () => fp.screen.height });
        Object.defineProperty(screen, 'availWidth', { get: () => fp.screen.width });
        Object.defineProperty(screen, 'availHeight', { get: () => fp.screen.height });
        Object.defineProperty(screen, 'colorDepth', { get: () => fp.screen.colorDepth || 24 });
        Object.defineProperty(screen, 'pixelDepth', { get: () => fp.screen.colorDepth || 24 });
      }
    } catch(e){}
    // типовий для справжнього Chrome об'єкт, якого немає в автоматиці
    try {
      if (st.windowChrome) {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
        if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };
        window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: {}, RunningState: {} };
      }
    } catch(e){}
    // У headless outerWidth/outerHeight = 0 — явний маячок. Підставляємо реальні.
    if (st.outerWindow) {
      try { Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth }); } catch(e){}
      try { Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 74 }); } catch(e){}
    }
    // WebGL НЕ спуфимо — використовуємо справжній GPU (реальні vendor/renderer/пікселі).
    // permissions.query: узгоджена поведінка (як у справжньому браузері).
    if (st.permissions) try {
      const orig = navigator.permissions && navigator.permissions.query;
      if (orig) navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p);
    } catch(e){}
    // Прибираємо підпис Playwright: об'єкт window.__pwInitScripts, який створює
    // addInitScript. Видаляємо його ПІСЛЯ реєстрації (наш скрипт додається останнім).
    if (st.pwInitScripts) {
      try { delete window.__pwInitScripts; } catch(e){}
      try { Object.defineProperty(window, '__pwInitScripts', { get: () => undefined, set: () => {}, configurable: true }); } catch(e){}
    }
  })();`;
}

async function makeReadyUnit() {
  await ensureEngine();
  if (isCamoufox()) {
    // Camoufox сам керує fingerprint/stealth (на рівні рушія) — НЕ додаємо наші
    // Chromium-патчі (stealthScript/contextOptions), щоб не плодити JS-сліди.
    const context = await camoufoxBrowser.newContext();
    const page = await context.newPage();
    return { context, page, persistent: false, camoufox: true };
  }
  if (isPersistent()) {
    // Один спільний контекст — створюємо лише нову сторінку (вкладку).
    const page = await persistentCtx.newPage();
    return { context: null, page, persistent: true };
  }
  const context = await browser.newContext(contextOptions());
  await context.addInitScript(stealthScript(profile.fingerprint));
  const page = await context.newPage(); // порожня сторінка about:blank уже відкрита
  return { context, page, persistent: false };
}

// Короткий опис того, ЩО саме відрізняється від дефолтного пустого Playwright —
// для логів у UI. Повертає масив рядків {kind, text}.
function shortUA(ua) {
  if (!ua) return '—';
  const m = ua.match(/Chrome\/[\d.]+/);
  return m ? m[0] : (ua.slice(0, 28) + '…');
}
function describeContextLogs(fromPool, warmBrowser) {
  const logs = [];
  const fp = profile.fingerprint;
  const st = profile.stealth || {};
  const L = profile.launch || {};
  const eng = isCamoufox() ? 'Camoufox (Firefox-антидетект)' : 'Chromium';
  logs.push({ kind: 'browser', text: '🧩 Рушій: ' + eng });
  logs.push({ kind: 'browser', text: warmBrowser
    ? '🌐 Браузер: використано вже прогрітий (reuse, без launch)'
    : '🌐 Браузер: запущено (launch)' });
  if (isCamoufox()) {
    logs.push({ kind: 'browser', text: '    ↳ Camoufox: fingerprint у C++, без CDP (Juggler), humanize+geoip' });
    logs.push({ kind: 'context', text: fromPool ? '📦 Контекст: з пулу Camoufox' : '📦 Контекст: новий (Camoufox)' });
    logs.push({ kind: 'stealth', text: '🕵️ Антидетект вшито в рушій — JS-слідів немає' });
    return logs;
  }
  logs.push({ kind: 'browser', text: '    ↳ launch: headless=' + (L.headless !== false) +
    ', siteIsolation=вимкнено' +
    ', stealth-plugin=' + (L.stealthPlugin !== false ? 'УВІМК' : 'вимк') +
    ', контекст=ізольований (новий на запит)' });
  logs.push({ kind: 'context', text: fromPool
    ? '📦 Контекст: взято з прогрітого пулу (newContext ~0 мс)'
    : '📦 Контекст: створено новий (newContext)' });
  if (fp) {
    logs.push({ kind: 'fp', text: '🧬 Fingerprint ПІДСТАВЛЕНО: UA=' + shortUA(fp.userAgent) +
      ', locale=' + (fp.locale || '—') + ', tz=' + (fp.timezoneId || '—') +
      ', cores=' + (fp.hardwareConcurrency || '—') +
      ', screen=' + (fp.screen ? fp.screen.width + 'x' + fp.screen.height : '—') });
  } else {
    logs.push({ kind: 'fp', text: '🧬 Fingerprint: НЕ задано → дефолт Playwright' });
  }
  const on = [];
  if (st.webdriver) on.push('navigator.webdriver=false');
  if (st.windowChrome) on.push('window.chrome');
  logs.push({ kind: 'stealth', text: on.length ? '🕵️ Stealth: ' + on.join(', ') : '🕵️ Stealth: вимкнено (як дефолт)' });
  const ck = profile.storageState ? profile.storageState.cookies.length : 0;
  logs.push({ kind: 'cookies', text: ck ? '🍪 Cookies: підставлено ' + ck : '🍪 Cookies: немає (порожній контекст)' });
  return logs;
}

async function refillPool() {
  if (refilling) return;
  refilling = true;
  try {
    while (pool.length < POOL_SIZE) {
      pool.push(await makeReadyUnit());
    }
  } catch (e) {
    console.error('refillPool error:', e.message);
  } finally {
    refilling = false;
  }
}

// Віддає готовий контекст із пулу (fromPool=true) або, якщо пул порожній,
// створює на льоту (fromPool=false). У будь-якому разі одразу тригерить поповнення.
async function takeUnit() {
  const unit = pool.shift();
  refillPool(); // поповнюємо у фоні, не чекаючи
  if (unit) return { ...unit, fromPool: true };
  return { ...(await makeReadyUnit()), fromPool: false };
}

// --- Простенький семафор, щоб обмежити кількість одночасних контекстів ---
let active = 0;
const queue = [];
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  active--;
  const next = queue.shift();
  if (next) {
    active++;
    next();
  }
}

// --- Головний ендпоінт: приймає URL, рендерить, повертає скриншот + метадані ---
app.post('/render', async (req, res) => {
  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Не передано url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // дозволяємо без схеми

  await acquire();
  const t0 = Date.now();
  const warm = engineReady(); // чи браузер уже був прогрітий ДО цього запиту
  let unit;
  try {
    // Беремо ГОТОВУ сторінку/контекст з пулу — зазвичай це ~0 мс,
    // бо вони створені заздалегідь. fromPool=false лише якщо пул встиг спорожніти.
    const tCtx0 = Date.now();
    unit = await takeUnit();
    const page = unit.page;
    const ctxMs = Date.now() - tCtx0;
    const fromPool = unit.fromPool;

    // Збираємо логи життєвого циклу (браузер/контекст/fingerprint/cookies/stealth).
    const logs = describeContextLogs(fromPool, warm);

    // Навігація, стійка до Cloudflare (domcontentloaded + очікування челенджу).
    logs.push({ kind: 'nav', text: '➡️ goto ' + url + ' (Cloudflare-aware)' });
    const tNav0 = Date.now();
    const { resp: response, cf } = await gotoSmart(page, url);
    if (cf.wasChallenge) logs.push({ kind: 'info', text: cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено (заставка лишилась)' });
    const navMs = Date.now() - tNav0;

    const title = await page.title();
    const html = await page.content();
    const text = (await page.evaluate(() => document.body?.innerText || '')).trim();

    // Чекаємо вміст iframe-ів, прокручуємо для lazy-контенту, знімаємо всю сторінку.
    await waitForContentSettle(page);
    await autoScroll(page);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
    logs.push({ kind: 'shot', text: '📸 fullPage-скриншот зроблено (' + Math.round(screenshot.length / 1024) + ' КБ)' });

    res.json({
      ok: true,
      url: page.url(),
      status: response ? response.status() : null,
      title,
      htmlLength: html.length,
      textPreview: text.slice(0, 1500),
      screenshot: 'data:image/jpeg;base64,' + screenshot.toString('base64'),
      fromPool,
      poolReady: pool.length,
      logs,
      timing: { contextMs: ctxMs, navMs, totalMs: Date.now() - t0 },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  } finally {
    await closeUnit(unit); // persistent → закриваємо лише сторінку; інакше — весь контекст
    release();
  }
});

// Чекає проходження Cloudflare-челенджу («Just a moment…»): опитує title/контент,
// поки заставка не зникне й не з'явиться реальна сторінка (або таймаут).
async function waitPastCloudflare(page, maxMs = 40000) {
  const start = Date.now();
  let wasChallenge = false, iter = 0;
  const re = /just a moment|checking your browser|attention required|verifying you are|performing security verification|security service to protect|cf-browser-verification|needs to review the security|un momento|трохи зачекайте|перевірка безпеки|перевіряє/i;
  while (Date.now() - start < maxMs) {
    iter++;
    let title = '', body = '', marker = false;
    try { title = (await page.title()) || ''; } catch (_e) {}
    try { body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 600) : '')); } catch (_e) {}
    // Мовно-незалежний маркер САМЕ інтерстиціалу челенджу (не фонового скрипта
    // bot-management, який присутній на звичайних сайтах за Cloudflare).
    try {
      marker = await page.evaluate(() =>
        !!document.querySelector('#challenge-running, #challenge-stage, #cf-challenge-running, #trk_jschal_js'));
    } catch (_e) {}
    const onChallenge = marker || re.test(title) || re.test(body);
    if (onChallenge) {
      wasChallenge = true;
      // ЛЮДСЬКА АКТИВНІСТЬ поки крутиться челендж — Cloudflare Managed Challenge
      // пропускає, коли бачить ознаки живого користувача (рухи миші).
      try { await page.mouse.move(rint(80, 1000), rint(80, 650), { steps: rint(6, 16) }); } catch (_e) {}
      if (iter % 3 === 0) { try { await page.mouse.wheel(0, rint(-60, 160)); } catch (_e) {} }
      await page.waitForTimeout(rint(900, 1400));
      continue;
    }
    // Челенджу зараз немає.
    // Якщо його НІКОЛИ не було — це звичайна сторінка (контент може бути в iframe),
    // не чекаємо даремно: одразу далі. Cloudflare-челендж завжди присутній одразу
    // в початковому HTML, тож пара перших перевірок його б уже зловила.
    if (!wasChallenge) { if (iter >= 2) return { passed: true, wasChallenge: false }; await page.waitForTimeout(300); continue; }
    // Був челендж і зник → переконаємось, що з'явився реальний контент.
    if (body.replace(/\s+/g, '').length > 80 || Date.now() - start > 2000) return { passed: true, wasChallenge };
    await page.waitForTimeout(500);
  }
  return { passed: false, wasChallenge };
}

// Навігація, стійка до Cloudflare: domcontentloaded + очікування проходження челенджу.
async function gotoSmart(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const cf = await waitPastCloudflare(page);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  return { resp, cf };
}

async function waitForContentSettle(page, maxMs = 9000) {
  const start = Date.now();
  let prev = -1, stable = 0;
  while (Date.now() - start < maxMs) {
    let total = 0;
    for (const f of page.frames()) {
      total += await f.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    }
    if (total > 0 && total === prev) { if (++stable >= 2) break; }
    else { stable = 0; prev = total; }
    await page.waitForTimeout(500);
  }
}

// Текст з УСІХ фреймів (головного + iframe) — для детекції появи результату сабміту.
async function allFramesText(page) {
  let t = '';
  for (const f of page.frames()) {
    t += await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  }
  return t;
}
// Чекає, доки контент (у будь-якому фреймі) зміниться відносно `before` — тобто
// з'явиться результат сабміту (напр. «Application received» у формі Ashby).
async function waitForResultChange(page, before, maxMs = 9000) {
  const start = Date.now();
  const norm = (s) => s.replace(/\s+/g, '');
  const b = norm(before);
  while (Date.now() - start < maxMs) {
    const now = norm(await allFramesText(page));
    if (now !== b && Math.abs(now.length - b.length) >= 5) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Знаходимо реальний елемент прокрутки: або window, або найвищий контейнер
      // з внутрішнім скролом (деякі сайти скролять не body, а div).
      function scrollHeightOf(el) { return el === window ? document.scrollingElement.scrollHeight : el.scrollHeight; }
      let scroller = window;
      let maxH = document.scrollingElement.scrollHeight;
      document.querySelectorAll('*').forEach((el) => {
        const st = getComputedStyle(el);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 200 && el.scrollHeight > maxH) {
          maxH = el.scrollHeight; scroller = el;
        }
      });
      const doScroll = (y) => (scroller === window ? window.scrollTo(0, y) : (scroller.scrollTop = y));
      const vh = scroller === window ? window.innerHeight : scroller.clientHeight;

      // Крокуємо донизу з паузами, щоб довантажувався lazy-контент.
      let last = -1;
      for (let i = 0; i < 80; i++) {
        const h = scrollHeightOf(scroller);
        doScroll(i * Math.floor(vh * 0.8));
        await sleep(160);
        if (i * Math.floor(vh * 0.8) >= h - vh) {
          if (h === last) break; // висота перестала рости — весь контент довантажено
          last = h;
        }
      }
      // Форсуємо завантаження lazy-зображень/iframe
      document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
        el.loading = 'eager';
        if (el.dataset && el.dataset.src && !el.src) el.src = el.dataset.src;
      });
      doScroll(0);
    });
    // Чекаємо, доки довантажене "заспокоїться"
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
  } catch (_e) { /* ігноруємо */ }
}

// Прокручує сторінку так, щоб точка full-page-координати y опинилась у видимій
// області, і повертає фактичний scrollY — щоб кліки працювали і нижче згину.
async function scrollToY(page, y) {
  return page.evaluate((yy) => {
    const target = Math.max(0, Math.round(yy - window.innerHeight / 2));
    window.scrollTo(0, target);
    return window.scrollY;
  }, y);
}

// Збирає всі <input type="file"> з головного фрейму та всіх iframe.
async function collectFileInputs(page) {
  const inputs = [];
  for (const fr of page.frames()) {
    const hs = await fr.$$('input[type="file"]').catch(() => []);
    inputs.push(...hs);
  }
  return inputs;
}

// --- Людська поведінка при відтворенні (проти поведінкового детектування) ---
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.round(rnd(a, b));

// Рухає мишу до (toX,toY) з кількох проміжних точок і легкою «дугою»,
// а не миттєвим стрибком. Повертає нову позицію.
async function humanMove(page, from, toX, toY) {
  const hops = rint(2, 4);
  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    const nx = from.x + (toX - from.x) * t + rnd(-22, 22) * (1 - t);
    const ny = from.y + (toY - from.y) * t + rnd(-22, 22) * (1 - t);
    await page.mouse.move(nx, ny, { steps: rint(8, 18) });
    await page.waitForTimeout(rint(12, 55));
  }
  await page.mouse.move(toX, toY, { steps: rint(6, 12) });
  return { x: toX, y: toY };
}
// Клік із природним рухом, мікропаузою й роздільними down/up.
async function humanClick(page, from, x, y) {
  const pos = await humanMove(page, from, x, y);
  await page.waitForTimeout(rint(60, 180));
  await page.mouse.down();
  await page.waitForTimeout(rint(40, 110));
  await page.mouse.up();
  return pos;
}
// Друк по символу зі змінним ритмом та випадковими «задумами».
async function humanType(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(rint(45, 160));
    if (Math.random() < 0.07) await page.waitForTimeout(rint(200, 550));
  }
}
// «Роздивляння»: кілька дрібних скролів колесом із паузами, ніби користувач
// читає сторінку. Координатний клік потім сам доскролить до цілі.
async function humanWander(page) {
  const rounds = rint(1, 3);
  for (let i = 0; i < rounds; i++) {
    const dy = rint(-120, 280); // переважно вниз, іноді трохи вгору
    try { await page.mouse.wheel(0, dy); } catch (_e) {}
    await page.waitForTimeout(rint(250, 750));
  }
}

// --- Відтворення записаних дій зі СТРІМІНГОМ прогресу (NDJSON) ---
// Сервер відкриває сторінку наново і шле подію на кожну дію, щоб клієнт
// показував у реальному часі, яка саме дія зараз виконується.
app.post('/replay', async (req, res) => {
  let { url, actions } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Не передано url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!Array.isArray(actions)) actions = [];

  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  await acquire();
  const t0 = Date.now();
  const warm = engineReady();
  let unit;
  try {
    unit = await takeUnit();
    const page = unit.page;

    // Логи життєвого циклу — одразу стрімимо в UI.
    for (const l of describeContextLogs(unit.fromPool, warm)) send({ event: 'log', ...l });

    send({ event: 'log', kind: 'nav', text: '➡️ goto ' + url + ' (Cloudflare-aware)' });
    send({ event: 'status', text: 'Відкриваю сторінку…' });
    const { cf } = await gotoSmart(page, url);
    if (cf.wasChallenge) send({ event: 'log', kind: 'info', text: cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено' });
    send({ event: 'opened', text: 'Сторінка відкрита, відтворюю дії…' });

    const humanize = !(profile.behavior && profile.behavior.humanize === false);
    let mouse = { x: rint(80, 400), y: rint(80, 400) }; // стартова позиція миші
    if (humanize) {
      send({ event: 'log', kind: 'info', text: '🧍 Людська поведінка: криві рухи, змінні затримки, друк по буквах, випадкове роздивляння' });
      await humanWander(page); // «роздивляємось» сторінку після відкриття
    }

    let replayed = 0;
    let fileIdx = 0; // лічильник використаних полів input[type=file]
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      send({ event: 'action', index: i }); // яка дія зараз виконується
      let ok = true, errMsg = null;
      try {
        if (a.type === 'move') {
          const sy = await scrollToY(page, a.y);
          if (humanize) mouse = await humanMove(page, mouse, a.x, a.y - sy);
          else await page.mouse.move(a.x, a.y - sy);
        } else if (a.type === 'click') {
          if (humanize && Math.random() < 0.5) await humanWander(page); // інколи «роздивляємось» перед кліком
          const sy = await scrollToY(page, a.y);
          if (humanize) mouse = await humanClick(page, mouse, a.x, a.y - sy);
          else await page.mouse.click(a.x, a.y - sy);
          await page.waitForTimeout(humanize ? rint(250, 600) : 350); // даємо інтерфейсу зреагувати
        } else if (a.type === 'text') {
          // Режим рандому: замість заданого символу — випадкова цифра або англ. літера.
          let txt = String(a.text);
          if (a.random === 'digit') txt = String(Math.floor(Math.random() * 10));
          else if (a.random === 'letter') txt = String.fromCharCode(97 + Math.floor(Math.random() * 26));
          if (humanize) await humanType(page, txt);
          else await page.keyboard.type(txt, { delay: 25 });
        } else if (a.type === 'key') {
          await page.keyboard.press(String(a.key));
        } else if (a.type === 'file') {
          const fp = resolveUpload(a.fileId, a.filename);
          if (!fp) { ok = false; errMsg = 'файл не знайдено на сервері'; }
          else {
            // Шукаємо input[type=file] по всіх фреймах (форма може бути в iframe).
            // Якщо поля ще немає — чекаємо довантаження контенту і пробуємо ще раз.
            let inputs = await collectFileInputs(page);
            if (!inputs.length) { await waitForContentSettle(page, 4000); inputs = await collectFileInputs(page); }
            const input = inputs[fileIdx] || inputs[inputs.length - 1];
            if (input) {
              await input.setInputFiles(fp); // підставляємо файл напряму — надійно
              fileIdx++;
            } else { ok = false; errMsg = 'на сторінці немає поля для файлу'; }
          }
        }
        replayed++;
      } catch (e) {
        ok = false; errMsg = String(e && e.message || e);
      }
      send({ event: 'done-action', index: i, ok, error: errMsg });
      // пауза між діями: людська (випадкова) або мінімальна
      await page.waitForTimeout(humanize ? rint(350, 1100) : 120);
    }

    // Надійно чекаємо відповідь сервера після останньої дії (напр. сабміт форми).
    // Важливо: сабміт часто йде з IFRAME (напр. форма Ashby), тож чекаємо
    // networkidle УСІХ фреймів, а не лише головного, і додатково — доки реально
    // з'явиться/зміниться контент результату.
    const beforeText = await allFramesText(page);
    send({ event: 'status', text: 'Чекаю відповідь сервера…' });
    await page.waitForTimeout(500);
    await Promise.all(page.frames().map(f => f.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})));
    await waitForResultChange(page, beforeText, 9000); // чекаємо появу результату
    await page.waitForTimeout(500);
    await waitForContentSettle(page);
    send({ event: 'status', text: 'Роблю фінальний скриншот…' });
    await autoScroll(page);
    const title = await page.title();
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });

    send({
      event: 'done',
      url: page.url(),
      title,
      actionsReplayed: replayed,
      actionsTotal: actions.length,
      screenshot: 'data:image/jpeg;base64,' + screenshot.toString('base64'),
      timing: { totalMs: Date.now() - t0 },
    });
  } catch (err) {
    send({ event: 'error', message: String(err && err.message || err) });
  } finally {
    await closeUnit(unit);
    release();
    res.end();
  }
});

// --- Postgres: збереження Дій, щоб не перестворювати їх щоразу ---
// Рядок підключення береться з env DATABASE_URL. Якщо його немає — БД вимкнена,
// застосунок працює в пам'яті (Дії не зберігаються між перезавантаженнями).
// За замовчуванням — локальний Postgres.app (база playwright_demo).
// Можна перевизначити через env DATABASE_URL.
const DB_URL = process.env.DATABASE_URL || 'postgres://andreykuluev@localhost:5432/playwright_demo';
let db = null;
async function initDb() {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id          BIGINT PRIMARY KEY,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL,
        subs        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id          BIGINT PRIMARY KEY,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL,
        recs        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Пресети конфігуратора (набори налаштувань). Зберігаються в БД.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS presets (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        body        JSONB NOT NULL DEFAULT '{}'::jsonb,
        builtin     BOOLEAN NOT NULL DEFAULT false,
        pos         INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    db = pool;
    await seedPresets();
    console.log('Postgres підключено (' + DB_URL + '), таблиці recordings/pages/presets готові.');
  } catch (e) {
    db = null;
    await pool.end().catch(() => {});
    console.log('БД недоступна (' + e.message + ') — Дії лише в пам\'яті.');
  }
}

// Повернути всі збережені Дії (за порядком запису)
app.get('/recordings', async (_req, res) => {
  if (!db) return res.json({ ok: true, db: false, recordings: [] });
  try {
    const { rows } = await db.query('SELECT id, name, url, subs FROM recordings ORDER BY id ASC');
    res.json({ ok: true, db: true, recordings: rows.map(r => ({ ...r, id: Number(r.id) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Створити/оновити одну Дію (upsert)
app.put('/recordings/:id', async (req, res) => {
  if (!db) return res.json({ ok: true, db: false });
  const id = Number(req.params.id);
  const { name, url, subs } = req.body || {};
  try {
    await db.query(
      `INSERT INTO recordings (id, name, url, subs, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET name = $2, url = $3, subs = $4::jsonb, updated_at = now()`,
      [id, name || ('Дія ' + id), url || '', JSON.stringify(subs || [])]
    );
    res.json({ ok: true, db: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Видалити Дію
app.delete('/recordings/:id', async (req, res) => {
  if (!db) return res.json({ ok: true, db: false });
  try {
    await db.query('DELETE FROM recordings WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true, db: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Сторінки (верхній рівень: URL + масив Дій) ---
app.get('/pages', async (_req, res) => {
  if (!db) return res.json({ ok: true, db: false, pages: [] });
  try {
    const { rows } = await db.query('SELECT id, name, url, recs FROM pages ORDER BY id ASC');
    res.json({ ok: true, db: true, pages: rows.map(r => ({ ...r, id: Number(r.id) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.put('/pages/:id', async (req, res) => {
  if (!db) return res.json({ ok: true, db: false });
  const id = Number(req.params.id);
  const { name, url, recs } = req.body || {};
  try {
    await db.query(
      `INSERT INTO pages (id, name, url, recs, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET name = $2, url = $3, recs = $4::jsonb, updated_at = now()`,
      [id, name || ('Сторінка ' + id), url || '', JSON.stringify(recs || [])]
    );
    res.json({ ok: true, db: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.delete('/pages/:id', async (req, res) => {
  if (!db) return res.json({ ok: true, db: false });
  try {
    await db.query('DELETE FROM pages WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true, db: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Пресети конфігуратора (в БД) ---
const BUILTIN_PRESETS = [
  { name: '🛡️ All', pos: 1, body: {
    launch: { engine: 'chromium', headless: true, newHeadless: true, automationControlled: true, realGpu: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false },
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true },
    behavior: { humanize: true },
  } },
  { name: '🧹 Clear all', pos: 2, body: { clear: true } },
  { name: '☁️ Cloudflare', pos: 3, body: { launch: { engine: 'camoufox', camoufoxHumanize: false, camoufoxGeoip: false } } },
  { name: '📋 Ashby', pos: 4, body: {
    launch: { engine: 'chromium', headless: true, newHeadless: true, automationControlled: true, realGpu: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false },
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true },
    behavior: { humanize: true },
  } },
];
async function seedPresets() {
  if (!db) return;
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM presets');
  if (rows[0].n > 0) return;
  for (const p of BUILTIN_PRESETS) {
    await db.query('INSERT INTO presets (name, body, builtin, pos) VALUES ($1, $2::jsonb, true, $3)', [p.name, JSON.stringify(p.body), p.pos]);
  }
  console.log('Вбудовані пресети засіяно.');
}

app.get('/presets', async (_req, res) => {
  if (!db) return res.json({ ok: true, db: false, presets: [] });
  try {
    const { rows } = await db.query('SELECT id, name, body, builtin FROM presets ORDER BY pos ASC, id ASC');
    res.json({ ok: true, db: true, presets: rows.map(r => ({ ...r, id: Number(r.id) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/presets', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'БД недоступна' });
  const { name, body } = req.body || {};
  try {
    const { rows } = await db.query(
      'INSERT INTO presets (name, body, builtin, pos) VALUES ($1, $2::jsonb, false, 100) RETURNING id',
      [name || 'Новий пресет', JSON.stringify(body || {})]
    );
    res.json({ ok: true, id: Number(rows[0].id) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.put('/presets/:id', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'БД недоступна' });
  const { name, body } = req.body || {};
  try {
    await db.query(
      `UPDATE presets SET
         name = COALESCE($2, name),
         body = COALESCE($3::jsonb, body),
         updated_at = now()
       WHERE id = $1`,
      [Number(req.params.id), name ?? null, body === undefined ? null : JSON.stringify(body)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.delete('/presets/:id', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'БД недоступна' });
  try {
    await db.query('DELETE FROM presets WHERE id = $1 AND builtin = false', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// --- Завантаження файлів для дій типу "file" ---
function safeName(name) {
  return String(name || 'file').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'file';
}
// Повертає абсолютний шлях до збереженого файлу або null (із захистом від path traversal)
function resolveUpload(fileId, filename) {
  if (!/^[a-f0-9-]{10,}$/i.test(String(fileId || ''))) return null;
  const dir = path.join(UPLOAD_DIR, fileId);
  const p = path.join(dir, safeName(filename));
  if (!p.startsWith(UPLOAD_DIR)) return null;
  return fs.existsSync(p) ? p : null;
}

app.post('/upload', (req, res) => {
  try {
    const { filename, data } = req.body || {};
    if (!data) return res.status(400).json({ ok: false, error: 'немає даних файлу' });
    const b64 = String(data).includes(',') ? String(data).split(',', 2)[1] : String(data);
    const buf = Buffer.from(b64, 'base64');
    const id = crypto.randomUUID();
    const name = safeName(filename);
    const dir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    res.json({ ok: true, fileId: id, filename: name, size: buf.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- Профіль браузера: fingerprint + cookies у кожен контекст ---
function saveProfile() {
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2)); } catch (_e) {}
}
// Пересоздаємо пул, щоб нові контексти одразу мали оновлений профіль.
async function drainPool() {
  const old = pool.splice(0, pool.length);
  for (const u of old) { await closeUnit(u); }
  await refillPool();
}
// Мапимо cookies з експорту розширень (Cookie-Editor тощо) у формат Playwright.
function toStorageState(input) {
  if (!input) return null;
  if (input.cookies && Array.isArray(input.cookies)) return input; // уже storageState
  const arr = Array.isArray(input) ? input : [];
  const ss = { cookies: [], origins: [] };
  const mapSameSite = (v) => {
    const s = String(v || '').toLowerCase();
    if (s.includes('no_restriction') || s === 'none') return 'None';
    if (s.includes('strict')) return 'Strict';
    return 'Lax';
  };
  for (const c of arr) {
    if (!c || !c.name) continue;
    ss.cookies.push({
      name: c.name, value: String(c.value ?? ''),
      domain: c.domain || '', path: c.path || '/',
      expires: typeof c.expirationDate === 'number' ? Math.round(c.expirationDate)
             : (typeof c.expires === 'number' ? c.expires : -1),
      httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: mapSameSite(c.sameSite),
    });
  }
  return ss.cookies.length ? ss : null;
}

// Дефолтний (пустий) Playwright — щоб у конфігураторі показувати, що саме змінено.
const PLAYWRIGHT_DEFAULTS = {
  fingerprint: null,
  stealth: { webdriver: false, windowChrome: false, outerWindow: false, permissions: false, pwInitScripts: false },
  launch: { headless: true, siteIsolationDisabled: false, stealthPlugin: false, persistent: false, engine: 'chromium', automationControlled: false, realGpu: false, newHeadless: false, camoufoxHumanize: false, camoufoxGeoip: false },
  behavior: { humanize: false },
  note: 'navigator.webdriver=true, стандартний UA Playwright, без cookies, ізоляція сайтів увімкнена, без stealth-плагіна, миттєві кліки',
};

app.post('/profile', async (req, res) => {
  const { fingerprint, cookies, storageState, stealth, launch, behavior, clear } = req.body || {};
  // знімок стану ДО змін — щоб у persistent-режимі перезапускати лише за реальної зміни
  const sigBefore = JSON.stringify([profile.fingerprint, profile.stealth, profile.launch, profile.storageState]);

  if (clear) { // скинути до дефолту Playwright
    profile.fingerprint = null; profile.storageState = null;
    profile.stealth = { webdriver: false, windowChrome: false, outerWindow: false, permissions: false, pwInitScripts: false };
    profile.launch = { headless: true, siteIsolationDisabled: false, stealthPlugin: false, persistent: false, engine: 'chromium', automationControlled: false, realGpu: false, newHeadless: false, camoufoxHumanize: false, camoufoxGeoip: false };
    profile.behavior = { humanize: false };
  }
  if (fingerprint !== undefined) profile.fingerprint = fingerprint;
  if (stealth) profile.stealth = Object.assign(profile.stealth, stealth);
  if (behavior) profile.behavior = Object.assign(profile.behavior, behavior);
  const ss = toStorageState(storageState || cookies);
  if (ss) profile.storageState = ss;
  if (cookies === null || storageState === null) profile.storageState = null; // явне очищення

  let launchChanged = false;
  if (launch) {
    const before = JSON.stringify(profile.launch);
    profile.launch = Object.assign(profile.launch, launch);
    launchChanged = JSON.stringify(profile.launch) !== before;
  }
  saveProfile();

  const sigAfter = JSON.stringify([profile.fingerprint, profile.stealth, profile.launch, profile.storageState]);
  const changed = sigAfter !== sigBefore;

  let relaunched = false;
  // Перезапуск потрібен: (1) якщо змінилися launch-прапорці; (2) у persistent-режимі
  // при будь-якій зміні профілю (init-скрипт висить на постійному контексті).
  if (launchChanged || (isPersistent() && changed)) {
    await relaunchBrowser().catch(() => {}); relaunched = true;
  }
  if (!relaunched) await drainPool().catch(() => {}); // у звичайному режимі — просто оновити пул
  res.json({ ok: true, relaunched, ...fullConfig() });
});

function fullConfig() {
  return {
    fingerprint: profile.fingerprint || null,
    stealth: profile.stealth,
    launch: profile.launch,
    behavior: profile.behavior,
    cookiesCount: profile.storageState ? profile.storageState.cookies.length : 0,
    cookies: profile.storageState ? profile.storageState.cookies.slice(0, 50) : [],
    defaults: PLAYWRIGHT_DEFAULTS,
    hasFingerprint: !!profile.fingerprint,
  };
}

app.get('/profile', (_req, res) => res.json({ ok: true, ...fullConfig() }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, active, poolReady: pool.length, poolSize: POOL_SIZE, db: !!db }));

app.listen(PORT, async () => {
  await initDb().catch(e => console.error('Помилка БД:', e.message));
  await getBrowser();   // 1) прогріваємо сам браузер (раз)
  await refillPool();   // 2) заздалегідь готуємо пул контекстів зі сторінками
  console.log(`Пул готовий: ${pool.length} контекстів чекають.`);
  console.log(`\n  ▶  Відкрий у браузері:  http://localhost:${PORT}\n`);
});
