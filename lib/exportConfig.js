// Експорт застосованого конфігу браузера у Markdown-документ, за яким людина або
// LLM (Claude) може відтворити клієнт, що поводиться так само: точні аргументи
// запуску, опції контексту, ДОСЛІВНИЙ stealth init-script, налаштування
// stealth-плагіна, Cloudflare-навігація, людська поведінка + готовий client.mjs.
//
// Чиста функція buildConfigExport(profile, meta) → { markdown, spec, filename }.
// Секрети НЕ експортуються: cookies (storageState) — лише кількість і домени.
//
// client.mjs містить «рантайм застосунку» ДОСЛІВНО (String(fn) функцій із lib/*.js):
// ізольований світ (Chromium/CDP), Cloudflare-навігацію, підготовку сторінки як у
// /render, людську поведінку, паузи, очікування мережі. Так клієнт не розходиться з
// застосунком (тести перевіряють, що джерела збігаються й завантажуються без помилок).
import { launchFlags, camoufoxOptions, engineKind } from './engine.js';
import { contextOptions } from './profile.js';
import { stealthScript } from './stealth.js';
import { rnd, rint } from './rng.js';
import * as iso from './isoworld.js';
import * as settle from './settle.js';
import * as coords from './coords.js';
import * as dom from './dom.js';
import * as nav from './nav.js';
import * as human from './human.js';
import { pauseAfter, SETTLE_CLICK, SETTLE_KEY, SETTLE_FILE } from './replay.js';

const { CF_TEXT_RE, CF_MARKER_SELECTOR } = nav;

// Повний перелік евейжнів puppeteer-extra-plugin-stealth (2.11.x) — запасний, якщо
// плагін ще не підвантажено; застосунок вимикає webgl.vendor (реальний GPU).
export const DEFAULT_STEALTH_EVASIONS = [
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime', 'defaultArgs', 'iframe.contentWindow',
  'media.codecs', 'navigator.hardwareConcurrency', 'navigator.languages', 'navigator.permissions',
  'navigator.plugins', 'navigator.webdriver', 'sourceurl', 'user-agent-override', 'webgl.vendor', 'window.outerdimensions',
];
export const DISABLED_EVASIONS = ['webgl.vendor'];

// Той самий шаблон, що в scripts/patch-camoufox.mjs (postinstall застосунку): валідатор
// camoufox-js 0.10.2 падає з UnknownProperty на навігатор-властивостях генератора.
export const CAMOUFOX_PATCH_RE = /throw new UnknownProperty\(`Unknown property \$\{key\} in config`\);/;

// Поля fingerprint → де їх застосовує застосунок (Chromium).
const FP_CONTEXT = ['userAgent', 'locale', 'timezoneId', 'viewport', 'deviceScaleFactor'];
const FP_NAV_OWN = ['languages', 'hardwareConcurrency', 'deviceMemory', 'platform', 'vendor'];

// Назва пресета з query/UI → один рядок без керівних символів (інакше перенос рядка
// «вибиває» з //-коментаря client.mjs і ламає заголовок Markdown).
export function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const localDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// Умовно-стабільна назва файлу: stealth-config-<пресет>-<локальна дата>.md
// NFKC (а не NFKD): й/ї/ё лишаються цілими літерами, а не «и» + окремий діакритик.
export function exportFilename(presetName, now = new Date()) {
  const slug = cleanName(presetName).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'custom';
  return 'stealth-config-' + slug + '-' + localDate(now) + '.md';
}

const major = (v) => { const m = String(v || '').match(/(\d+)\./); return m ? Number(m[1]) : null; };
const uaMajor = (ua) => { const m = String(ua || '').match(/Chrome\/(\d+)/); return m ? Number(m[1]) : null; };

// Версії лише тих пакетів, що потрібні цьому рушію/режиму.
function versionsFor(all, engine, usePlugin) {
  const keep = engine === 'camoufox'
    ? ['camoufox-js', 'playwright-core', 'camoufox-browser']
    : ['playwright', 'playwright-core', 'chrome'].concat(usePlugin ? ['playwright-extra', 'puppeteer-extra-plugin-stealth'] : []);
  const out = {};
  for (const k of keep) if (all && all[k]) out[k] = all[k];
  return out;
}

// Машинозчитувана специфікація (без секретів).
export function buildSpec(profile, meta = {}) {
  const p = profile || {};
  const L = p.launch || {};
  const engine = engineKind(p);
  const usePlugin = engine === 'chromium' && L.stealthPlugin !== false;
  const cookies = (p.storageState && Array.isArray(p.storageState.cookies)) ? p.storageState.cookies : [];
  const b = p.behavior || {};
  const spec = {
    name: cleanName(meta.presetName) || 'кастом',
    presetStatus: meta.presetStatus ? cleanName(meta.presetStatus).slice(0, 16) : null,
    generatedAt: (meta.now || new Date()).toISOString(),
    engine,
    versions: versionsFor(meta.versions || {}, engine, usePlugin),
    behavior: {
      humanize: b.humanize !== false,
      prepareScroll: b.prepareScroll !== false,
      singleMove: engine === 'camoufox' && L.camoufoxHumanize !== false,
      settle: { click: SETTLE_CLICK, key: SETTLE_KEY, file: SETTLE_FILE },
    },
    cookies: { count: cookies.length, domains: [...new Set(cookies.map((c) => c.domain).filter(Boolean))].sort(), exported: false },
    notes: {
      presetStatus: 'preset — збігається з пресетом; changed — пресет змінено; custom — жодного пресета; null — не передано',
      'behavior.prepareScroll': 'лише /replay: перед legacy-координатними кроками — prepareForInteraction (з humanize — колесом), інакше лише waitForContentSettle',
      'behavior.singleMove': 'Camoufox із camoufox.humanize: курсор веде сам рушій — humanMove робить один mouse.move',
      'behavior.settle': 'waitQuiet після кліку/клавіші/файлу: мінімум minMs, далі тиша мережі quietMs, максимум maxMs',
    },
  };
  if (engine === 'camoufox') {
    spec.camoufox = camoufoxOptions(L);
    spec.context = {
      options: {},
      note: 'Camoufox: newContext() БЕЗ опцій — fingerprint генерує сам рушій (C++). Жодних init-скриптів.',
      viewport: 'дефолт Playwright 1280×720',
      fingerprint: 'ВИПАДКОВИЙ при кожному запуску браузера (ОС, UA-платформа, екран, WebGL, ядра) — і в застосунку теж',
      localeTimezone: spec.camoufox.geoip ? 'під IP (geoip)' : 'з хоста (geoip вимкнено)',
    };
  } else {
    const flags = launchFlags(L);
    const ctx = contextOptions(p);
    delete ctx.storageState; // секрети не експортуємо
    const evasions = usePlugin ? (meta.evasions && meta.evasions.length ? meta.evasions : DEFAULT_STEALTH_EVASIONS.filter((e) => !DISABLED_EVASIONS.includes(e))) : [];
    const uaOverride = evasions.includes('user-agent-override');
    const fp = p.fingerprint || {};
    const st = p.stealth || {};
    spec.chromium = {
      launch: flags,
      headlessMode: L.headless === false ? 'headful'
        : (L.newHeadless !== false ? 'new (--headless=new, headless:false)' : 'headless:true (Playwright --headless; у Chrome ≥132 старого headless немає — фактичний режим визначає Chrome)'),
      stealthPlugin: { enabled: usePlugin, evasions, disabled: DISABLED_EVASIONS },
      flags: {
        automationControlled: L.automationControlled !== false,
        realGpu: L.realGpu !== false,
        siteIsolationDisabled: L.siteIsolationDisabled !== false,
      },
      effectiveUserAgent: uaOverride
        ? 'browser: евейжн user-agent-override перекриває context.userAgent власним UA браузера (HeadlessChrome→Chrome)'
        : 'context.userAgent',
      initScriptOrder: 'context.addInitScript виконується ДО евейжнів плагіна (вони додаються на сторінку в onPageCreated)',
    };
    spec.context = ctx;
    spec.stealth = { ...st };
    spec.fingerprint = p.fingerprint || null;
    spec.fingerprintApplied = {
      context: FP_CONTEXT.filter((k) => fp[k] != null),
      initScript: FP_NAV_OWN.filter((k) => fp[k]).concat(fp.screen ? ['screen'] : []),
      defaults: fp.userAgent ? [] : ['userAgent=DEFAULT_UA застосунку'].concat(fp.locale ? [] : ['locale=en-US']),
    };
    spec.expected = {
      'navigator.webdriver': st.webdriver ? false : 'як у браузера (зазвичай true)',
      navigatorOwnProps: FP_NAV_OWN.filter((k) => fp[k]),
      "'__pwInitScripts' in window": false, // Playwright 1.63 його не створює; опція лише видаляє (старіші версії)
    };
  }
  return spec;
}

const js = (v) => JSON.stringify(v, null, 2);
const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const yesNo = (b) => (b ? '✅ так' : '— ні');

// Діагностика сигналів (--signals): ГОЛОВНИЙ світ сторінки — лише на власній сторінці-
// детекторі (init-скрипт підміняє значення саме в головному світі).
const SIGNALS_FN = async () => {
  const gl = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl');
      const e = c && c.getExtension('WEBGL_debug_renderer_info');
      return e ? [c.getParameter(e.UNMASKED_VENDOR_WEBGL), c.getParameter(e.UNMASKED_RENDERER_WEBGL)] : null;
    } catch (_e) { return null; }
  })();
  let perm = null;
  try { perm = (await navigator.permissions.query({ name: 'notifications' })).state; } catch (_e) {}
  return {
    webdriver: navigator.webdriver, navigatorOwnProps: Object.getOwnPropertyNames(navigator),
    userAgent: navigator.userAgent, userAgentData: navigator.userAgentData ? navigator.userAgentData.brands : null,
    languages: navigator.languages, platform: navigator.platform, vendor: navigator.vendor,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth],
    dpr: devicePixelRatio, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
    chrome: typeof window.chrome, chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : [],
    pwInitScriptsIn: '__pwInitScripts' in window, plugins: navigator.plugins.length, webgl: gl,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    permNotifications: perm,
  };
};

// «Рантайм застосунку» — ДОСЛІВНІ джерела функцій із lib/*.js + мінімальні шими імен
// (rndR/rintR — як аліаси імпорту в human.js, realDom — як `import * as realDom` у nav.js,
// waitScrollSettleRaw — як аліас у dom.js).
export function runtimeSource() {
  const fn = (f) => String(f);
  const R = [];
  R.push('// ===== Рантайм застосунку: функції ДОСЛІВНО з lib/*.js (не редагуй — так клієнт поводиться як застосунок) =====');
  R.push('// rng.js');
  R.push('const rnd = ' + fn(rnd) + ';');
  R.push('const rint = ' + fn(rint) + ';');
  R.push('const rndR = rnd, rintR = rint;');
  R.push('');
  R.push('// isoworld.js — read-only зонди в ІЗОЛЬОВАНОМУ світі (Chromium: CDP Page.createIsolatedWorld).');
  R.push('// page.evaluate у Chromium виконується в головному світі — обгортки сторінки бачать виклики');
  R.push('// Playwright (UtilityScript). Camoufox: CDP немає → page.evaluate (там він і так ізольований).');
  R.push(fn(iso.callExpression));
  R.push('const isStaleCtx = ' + fn(iso.isStaleCtx) + ';');
  R.push('const isNoFrame = ' + fn(iso.isNoFrame) + ';');
  R.push(fn(iso.createIso));
  R.push('const states = new WeakMap();');
  R.push('const frameSess = new WeakMap();');
  R.push(fn(iso.isoState));
  R.push(fn(iso.evalMain));
  R.push('');
  R.push('// settle.js / coords.js — очікування мережевого спокою і прокрутки');
  R.push('const realClock = { now: ' + fn(settle.realClock.now) + ', sleep: ' + fn(settle.realClock.sleep) + ' };');
  R.push(fn(settle.createNetTracker));
  R.push(fn(settle.waitQuiet));
  R.push('const SAMPLE_FN = ' + fn(settle.SCROLL_SAMPLE_FN) + ';');
  R.push('const waitScrollSettleRaw = ' + fn(settle.waitScrollSettle) + ';');
  R.push(fn(coords.scrollSettled));
  R.push('const INTERACTIVE_SEL = ' + JSON.stringify(coords.INTERACTIVE_SEL) + ';');
  R.push('const DEPENDENT_TYPES = new Set(' + JSON.stringify([...coords.DEPENDENT_TYPES]) + ');');
  R.push(fn(coords.shouldWander));
  R.push('');
  R.push('// dom.js');
  R.push('const MEASURE_FN = ' + fn(dom.MEASURE_FN) + ';');
  R.push(fn(dom.measure));
  R.push(fn(dom.waitScrollSettle));
  R.push('const IFRAMES_FN = ' + fn(dom.IFRAMES_FN) + ';');
  R.push(fn(dom.evalAllFrames));
  R.push('const NEUTRAL_FN = ' + fn(dom.NEUTRAL_FN) + ';');
  R.push(fn(dom.pickNeutralPoint));
  R.push('const realDom = { measure, waitScrollSettle, evalAllFrames, pickNeutralPoint };');
  R.push('');
  R.push('// nav.js — Cloudflare-aware навігація і підготовка сторінки (як /render перед скриншотом)');
  R.push('const CF_TEXT_RE = new RegExp(' + JSON.stringify(CF_TEXT_RE.source) + ', ' + JSON.stringify(CF_TEXT_RE.flags) + ');');
  R.push('const CF_MARKER_SELECTOR = ' + JSON.stringify(CF_MARKER_SELECTOR) + ';');
  R.push(fn(nav.isChallenge));
  R.push(fn(nav.waitPastCloudflare));
  R.push(fn(nav.gotoSmart));
  R.push(fn(nav.waitForContentSettle));
  R.push('const AUTOSCROLL_FN = ' + fn(nav.AUTOSCROLL_FN) + ';');
  R.push(fn(nav.wheelChunk));
  R.push(fn(nav.sweepAtBottom));
  R.push(fn(nav.wheelSweep));
  R.push(fn(nav.autoScroll));
  R.push(fn(nav.prepareForInteraction));
  R.push('');
  R.push('// human.js — людська поведінка');
  R.push(fn(human.humanMove));
  R.push(fn(human.humanPress));
  R.push(fn(human.humanClick));
  R.push(fn(human.humanType));
  R.push(fn(human.wanderCandidates));
  R.push(fn(human.humanWander));
  R.push('');
  R.push('// replay.js — паузи між кроками і параметри очікування після дій');
  R.push(fn(pauseAfter));
  R.push('const SETTLE_CLICK = ' + JSON.stringify(SETTLE_CLICK) + ';');
  R.push('const SETTLE_KEY = ' + JSON.stringify(SETTLE_KEY) + ';');
  R.push('const SETTLE_FILE = ' + JSON.stringify(SETTLE_FILE) + ';');
  R.push('// ===== кінець рантайму =====');
  return R.join('\n');
}

// Імена, які client.mjs експортує (API для сценаріїв).
export const CLIENT_EXPORTS = [
  'launch', 'newPage', 'dumpSignals', 'evalMain', 'isoState', 'gotoSmart', 'waitPastCloudflare', 'waitForContentSettle',
  'prepareForInteraction', 'autoScroll', 'wheelSweep', 'measure', 'pickNeutralPoint', 'evalAllFrames', 'waitScrollSettle', 'createNetTracker', 'waitQuiet',
  'humanMove', 'humanPress', 'humanClick', 'humanType', 'humanWander', 'wanderCandidates', 'shouldWander', 'pauseAfter',
  'SETTLE_CLICK', 'SETTLE_KEY', 'SETTLE_FILE', 'HUMANIZE', 'SINGLE_MOVE', 'rint',
];

// Самодостатній клієнт (Node 20, ESM) — відтворює конфіг без застосунку.
// Браузерні пакети імпортуються динамічно (у launch), тож модуль вантажиться й без них.
export function buildClient(spec, initScript) {
  const isCfx = spec.engine === 'camoufox';
  const usePlugin = !isCfx && spec.chromium.stealthPlugin.enabled;
  const v = spec.versions || {};
  const deps = isCfx
    ? ['camoufox-js@' + (v['camoufox-js'] || 'latest'), 'playwright-core@' + (v['playwright-core'] || 'latest')]
    : ['playwright@' + (v.playwright || 'latest')].concat(usePlugin ? ['playwright-extra@' + (v['playwright-extra'] || 'latest'), 'puppeteer-extra-plugin-stealth@' + (v['puppeteer-extra-plugin-stealth'] || 'latest')] : []);
  const L = [];
  L.push('// client.mjs — відтворює конфіг «' + spec.name + '» (Stealth Render Studio, ' + spec.generatedAt + ').');
  L.push('// Встановлення: npm i ' + deps.join(' ') + (isCfx ? '  &&  npx camoufox-js fetch   (бінарник Camoufox ~1.3 ГБ, один раз, у кеш користувача)' : ''));
  if (isCfx) L.push('// camoufox-js 0.10.2: валідатор падає з UnknownProperty — launch() сам латає dist/utils.js (як postinstall застосунку).');
  L.push('// Запуск: node client.mjs <url> [screenshot.jpg] [--signals]   (Node 20+, "type": "module" або .mjs)');
  if (!isCfx) L.push('// Потрібен встановлений Google Chrome (channel: "chrome")' + (v.chrome ? '; застосунок працював на Chrome ' + v.chrome + ' (мажорна версія потрапляє в UA/client hints)' : '') + '.');
  L.push('');
  L.push("import { pathToFileURL } from 'node:url';");
  L.push("import crypto from 'node:crypto';");
  if (isCfx) {
    L.push("import fs from 'node:fs';");
    L.push("import path from 'node:path';");
    L.push("import { createRequire } from 'node:module';");
  }
  L.push('');
  if (isCfx) {
    L.push('const CAMOUFOX = ' + js(spec.camoufox) + ';');
  } else {
    L.push('const LAUNCH = ' + js(spec.chromium.launch) + ';');
    L.push('const CONTEXT = ' + js(spec.context) + ';');
    if (usePlugin) L.push('const EVASIONS = ' + js(spec.chromium.stealthPlugin.evasions) + ';');
    L.push('// Init-скрипт ДОСЛІВНО як у застосунку. context.addInitScript виконується ДО евейжнів');
    L.push('// плагіна (ті додаються на сторінку в onPageCreated) — порядок як у застосунку.');
    L.push('const INIT_SCRIPT = ' + JSON.stringify(initScript) + ';');
  }
  L.push('export const HUMANIZE = ' + spec.behavior.humanize + ';');
  L.push('// Camoufox із humanize: курсор веде рушій → humanMove(..., { single: SINGLE_MOVE }) робить один рух.');
  L.push('export const SINGLE_MOVE = ' + spec.behavior.singleMove + ';');
  L.push('');
  if (isCfx) {
    L.push('const CAMOUFOX_PATCH_RE = new RegExp(' + JSON.stringify(CAMOUFOX_PATCH_RE.source) + ');');
    L.push(`// Ідемпотентний автопатч camoufox-js (той самий, що scripts/patch-camoufox.mjs у застосунку).
export function patchCamoufoxJs() {
  const file = path.join(path.dirname(createRequire(import.meta.url).resolve('camoufox-js')), 'utils.js');
  const s = fs.readFileSync(file, 'utf8');
  if (s.includes('CAMOUFOX_PATCHED')) return 'already';
  if (!CAMOUFOX_PATCH_RE.test(s)) return 'pattern-not-found';
  fs.writeFileSync(file, s.replace(CAMOUFOX_PATCH_RE, 'continue; /* CAMOUFOX_PATCHED: skip unknown props */'));
  return 'patched';
}

// Як застосунок: launchOptions(camoufox-js) + playwright-core firefox.launch.
// Fingerprint Camoufox генерує ВИПАДКОВО на кожен запуск (застосунок os/screen не фіксує;
// зафіксувати можна опцією launchOptions({ os: 'macos' | 'windows' | 'linux' }), але це вже не паритет).
export async function launch() {
  patchCamoufoxJs();
  const { launchOptions } = await import('camoufox-js');
  const { firefox } = await import('playwright-core');
  const { headless, ...rest } = CAMOUFOX;
  return firefox.launch(await launchOptions({ ...rest, headless: !!headless }));
}`);
  } else if (usePlugin) {
    L.push(`// Плагін реєструється РІВНО раз на процес (мемоізовано, як setupStealthPlugin у застосунку):
// playwright-extra — синглтон, повторний use() задвоїв би евейжни.
let _chromium = null;
async function stealthChromium() {
  if (!_chromium) {
    _chromium = (async () => {
      const { chromium } = await import('playwright-extra');
      const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
      const stealth = StealthPlugin();
      for (const e of [...stealth.enabledEvasions]) if (!EVASIONS.includes(e)) stealth.enabledEvasions.delete(e);
      chromium.use(stealth);
      return chromium;
    })();
    _chromium.catch(() => { _chromium = null; });
  }
  return _chromium;
}
export async function launch() {
  return (await stealthChromium()).launch(LAUNCH);
}`);
  } else {
    L.push(`export async function launch() {
  const { chromium } = await import('playwright');
  return chromium.launch(LAUNCH);
}`);
  }
  L.push('');
  L.push('// Кожна сесія — свіжий ізольований контекст (як пул застосунку: контекст використовується один раз).');
  L.push('export async function newPage(browser) {');
  if (isCfx) {
    L.push('  const context = await browser.newContext(); // Camoufox: без опцій і без init-скриптів');
  } else {
    L.push('  const context = await browser.newContext(CONTEXT);');
    L.push('  await context.addInitScript(INIT_SCRIPT);');
  }
  L.push('  const page = await context.newPage();');
  L.push('  return { context, page };');
  L.push('}');
  L.push('');
  L.push('// Діагностика: сигнали сторінки (ГОЛОВНИЙ світ — видно сторінці; лише для власного детектора).');
  L.push('const SIGNALS_FN = ' + String(SIGNALS_FN) + ';');
  L.push('export async function dumpSignals(page) { return page.evaluate(SIGNALS_FN); }');
  L.push('');
  L.push(runtimeSource());
  L.push('');
  L.push('export { ' + CLIENT_EXPORTS.filter((n) => !['launch', 'newPage', 'dumpSignals', 'HUMANIZE', 'SINGLE_MOVE'].includes(n)).join(', ') + ' };');
  L.push('');
  L.push(`// ---- Приклад: як /render — відкрити URL, підготувати сторінку, зняти fullPage-скрин ----
// Сценарій (як /replay): let mouse = { x: rint(80, 400), y: rint(80, 400) }; якщо HUMANIZE —
// humanWander після відкриття і перед кожним shouldWander(...) кліком; клік = humanMove(..., { single: SINGLE_MOVE })
// + humanPress; текст = humanType; після дії — waitQuiet(createNetTracker(page), SETTLE_*);
// між кроками — pauseAfter(step, nextStep, HUMANIZE, rint).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const wantSignals = args.includes('--signals');
  const [url, out] = args.filter((a) => !a.startsWith('--'));
  if (!url) { console.error('usage: node client.mjs <url> [out.jpg] [--signals]'); process.exit(2); }
  const browser = await launch();
  try {
    const { page } = await newPage(browser);
    const { resp, cf } = await gotoSmart(page, url);
    console.log('status', resp && resp.status(), 'cloudflare', JSON.stringify(cf), 'browser', browser.version());
    await prepareForInteraction(page); // як /render: заспокоєння контенту + autoScroll і назад угору
    if (wantSignals) console.log(JSON.stringify(await dumpSignals(page), null, 2));
    await page.screenshot({ path: out || 'screenshot.jpg', type: 'jpeg', quality: 70, fullPage: true, caret: 'initial' });
  } finally { await browser.close(); }
}`);
  return L.join('\n');
}

// Markdown-документ для людини/LLM.
export function buildConfigExport(profile, meta = {}) {
  const now = meta.now || new Date();
  const spec = buildSpec(profile, { ...meta, now });
  const isCfx = spec.engine === 'camoufox';
  const init = isCfx ? null : stealthScript((profile || {}).fingerprint, (profile || {}).stealth);
  const client = buildClient(spec, init);
  const v = spec.versions || {};
  const md = [];
  md.push('# Конфіг браузера «' + spec.name + '» — специфікація для відтворення');
  md.push('');
  md.push('Згенеровано Stealth Render Studio ' + spec.generatedAt + '. Документ описує **застосований** конфіг: усе, що потрібно, щоб написати клієнт, який запускає браузер із тими самими сигналами. Розділ «Готовий клієнт» — робочий `client.mjs` (функції застосунку в ньому — дослівні); JSON-блок — машинозчитувана версія.');
  if (spec.presetStatus === 'changed') md.push('\n> ⚠️ Конфіг відрізняється від пресета «' + spec.name + '» — експортовано саме поточний (застосований) стан.');
  md.push('');
  md.push('## Коротко');
  md.push('');
  md.push('| Параметр | Значення |');
  md.push('|---|---|');
  md.push('| Рушій | ' + (isCfx ? '🦊 Camoufox (кастомний Firefox, керування через Juggler, без CDP)' : '🧩 Chromium (Google Chrome, `channel: "chrome"`, керування через CDP)') + ' |');
  if (isCfx) {
    md.push('| headless | ' + yesNo(spec.camoufox.headless) + ' |');
    md.push('| `camoufox.humanize` — рушій сам веде курсор (≠ «Людська поведінка» нижче) | ' + yesNo(spec.camoufox.humanize) + ' |');
    md.push('| geoip (timezone/locale під IP) | ' + yesNo(spec.camoufox.geoip) + (spec.camoufox.geoip ? '' : ' — timezone/locale з хоста') + ' |');
    md.push('| Fingerprint | генерує Camoufox, **випадковий на кожен запуск** (і в застосунку) |');
    md.push('| Viewport | 1280×720 (дефолт Playwright) |');
  } else {
    const c = spec.chromium;
    md.push('| Headless-режим | ' + c.headlessMode + ' |');
    md.push('| `--disable-blink-features=AutomationControlled` | ' + yesNo(c.flags.automationControlled) + ' |');
    md.push('| Реальний GPU (`--use-angle=metal`, macOS) | ' + (c.flags.realGpu ? yesNo(true) : '— ні (ANGLE-прапорці не передаються; рендерер обирає Chrome — на macOS це часто все одно ANGLE Metal)') + ' |');
    md.push('| Ізоляцію сайтів вимкнено (крос-доменні iframe у скріні) | ' + yesNo(c.flags.siteIsolationDisabled) + ' |');
    md.push('| puppeteer-extra stealth-плагін | ' + yesNo(c.stealthPlugin.enabled) + (c.stealthPlugin.enabled ? ' (вимкнено: ' + c.stealthPlugin.disabled.join(', ') + ')' : '') + ' |');
    for (const [k, label] of [['webdriver', 'navigator.webdriver = false (на прототипі)'], ['windowChrome', 'window.chrome'], ['outerWindow', 'outerWidth/Height = inner (+74)'], ['permissions', 'permissions.query узгоджений'], ['pwInitScripts', 'видалити window.__pwInitScripts, якщо є']]) {
      md.push('| Stealth: ' + label + ' | ' + yesNo(spec.stealth[k]) + ' |');
    }
    md.push('| Fingerprint | ' + (spec.fingerprint ? 'задано (див. JSON `fingerprint` і «Де застосовується кожне поле»)' : '— не задано: UA і locale — дефолти **застосунку** (`' + spec.context.userAgent + '`, `' + spec.context.locale + '`), не Playwright') + ' |');
    md.push('| Фактичний User-Agent | ' + (/^browser/.test(c.effectiveUserAgent) ? 'власний UA браузера (евейжн `user-agent-override` перекриває `CONTEXT.userAgent`)' : '`CONTEXT.userAgent`') + ' |');
    md.push('| Viewport / DPR | ' + spec.context.viewport.width + '×' + spec.context.viewport.height + ' / ' + spec.context.deviceScaleFactor + ' |');
  }
  md.push('| Людська поведінка застосунку (`behavior.humanize`) | ' + yesNo(spec.behavior.humanize) + ' |');
  md.push('| `behavior.prepareScroll` (autoScroll перед legacy-координатними кроками /replay) | ' + yesNo(spec.behavior.prepareScroll) + ' |');
  md.push('| Cookies | ' + (spec.cookies.count ? spec.cookies.count + ' шт. — **не експортовано** (домени: ' + spec.cookies.domains.join(', ') + ')' : 'немає') + ' |');
  md.push('');
  md.push('Версії: ' + (Object.keys(v).length ? Object.entries(v).map(([k, x]) => '`' + k + '@' + x + '`').join(', ') : 'невідомі') + '. Для паритету бери ті самі версії пакетів' + (isCfx ? '' : '; для Chrome важлива мажорна версія (вона в UA і client hints)') + '.');
  md.push('');
  md.push('## Як застосунок використовує цей конфіг');
  md.push('');
  const steps = [];
  if (isCfx) {
    steps.push('Запуск: `launchOptions({ ...CAMOUFOX, headless })` з `camoufox-js` → `firefox.launch(...)` з `playwright-core` (див. JSON `camoufox`). Перед імпортом — патч валідатора camoufox-js 0.10.2 (інакше `UnknownProperty: Unknown property navigator.appCodeName`); `client.mjs` робить це сам.');
    steps.push('Fingerprint (ОС, UA-платформа, екран, WebGL, кількість ядер) генерує рушій на рівні C++ **випадково при кожному запуску браузера** — і в застосунку теж; **жодних** init-скриптів і опцій контексту. Viewport — 1280×720 (дефолт Playwright); ' + (spec.camoufox.geoip ? 'timezone/locale — під IP (geoip).' : 'geoip вимкнено → timezone і locale беруться з хоста.'));
    steps.push('На кожну сесію — `browser.newContext()` без опцій → `newPage()` (контекст використовується рівно один раз).');
  } else {
    const c = spec.chromium;
    steps.push('Запуск: `' + (c.stealthPlugin.enabled ? 'playwright-extra' : 'playwright') + '.chromium.launch(LAUNCH)` з точними `args` нижче' + (c.stealthPlugin.enabled ? ' + `puppeteer-extra-plugin-stealth` (евейжни з `EVASIONS`; `webgl.vendor` вимкнено, щоб назва GPU не суперечила реальним пікселям). Плагін реєструється один раз на процес' : '') + '.');
    steps.push('На кожну сесію — `browser.newContext(CONTEXT)` → `context.addInitScript(INIT_SCRIPT)` → `newPage()`. Контекст використовується рівно один раз. **Порядок:** у Playwright 1.63 скрипти контексту виконуються ДО скриптів сторінки, а евейжни плагіна додаються на сторінку (`onPageCreated`) — тож наш init-скрипт працює **першим**, евейжни — після нього (і можуть перевизначити, напр., `outerWidth/Height`). Не міняй порядок.');
    if (c.stealthPlugin.enabled && c.stealthPlugin.evasions.includes('user-agent-override')) {
      steps.push('⚠️ Евейжн `user-agent-override` на кожній сторінці ставить `Network.setUserAgentOverride` з **власним UA браузера** (`HeadlessChrome/` → `Chrome/`): `navigator.userAgent`, заголовок `User-Agent`, `navigator.platform`, `navigator.userAgentData` і `sec-ch-ua*` беруться з нього, а `CONTEXT.userAgent` фактично **не діє**. ' + (spec.chromium.launch.headless ? 'У режимі `headless:true` плагін ще й ставить `Accept-Language: en-US,en`. ' : '') + 'Клієнт без плагіна надсилав би інший UA.');
    }
    steps.push('Init-скрипт нижче — дослівно той, що інʼєктує застосунок. ' + (spec.stealth.webdriver ? '`navigator.webdriver` ставиться **на прототипі** `Navigator.prototype` (не own-property). ' : '`stealth.webdriver` вимкнено — `navigator.webdriver` лишається як у браузера. ') + (spec.expected.navigatorOwnProps.length ? 'Поля fingerprint `' + spec.expected.navigatorOwnProps.join('`, `') + '` визначаються як **own-property** на `navigator` — вони видні в `Object.getOwnPropertyNames(navigator)` (у справжнього Chrome там `[]`).' : 'Own-property на `navigator` скрипт не створює.'));
  }
  steps.push('Навігація (`gotoSmart`): `goto(url, {waitUntil: "domcontentloaded"})` → поки на сторінці інтерстиціал Cloudflare (маркер `' + CF_MARKER_SELECTOR + '` або текст за регекспом), рухаємо мишу кожні ~1 с і інколи крутимо колесо → `networkidle` (до 8 с). Усі зонди сторінки (`innerText`, `querySelector`, вимірювання) — в **ізольованому світі** (`evalMain`: Chromium — CDP `Page.createIsolatedWorld`; Camoufox — `page.evaluate`, там він і так ізольований). `page.evaluate` у Chromium виконується в головному світі — обгортки сторінки бачать виклики Playwright.');
  steps.push('`/render`: `gotoSmart` → `prepareForInteraction(page)` (заспокоєння контенту в усіх фреймах до 9 с + autoScroll донизу з форсуванням lazy-зображень і назад угору) → fullPage-скриншот JPEG q70.');
  steps.push('`/replay` (сценарій): `gotoSmart` → якщо є legacy-координатні кроки і `behavior.prepareScroll` — `prepareForInteraction(page, { mode: "replay", humanize })` (з humanize — людське колесо `wheelSweep`), інакше лише `waitForContentSettle`.');
  steps.push('Поведінка: ' + (spec.behavior.humanize
    ? 'миша стартує у випадковій точці (80–400, 80–400); «роздивляння» (`humanWander`, 1–3 скроли колесом у нейтральній точці, не над iframe/скролером/контролом) — після відкриття і перед кожним 4-м кліком, але не одразу після кліку/клавіші/тексту/select без навігації (`shouldWander`); клік — `humanMove` (2–4 «хопи» з дугою' + (spec.behavior.singleMove ? '; **тут Camoufox-humanize → один `mouse.move`**' : '') + ') + `humanPress` (роздільні down/up з паузами); текст — `humanType` (45–160 мс на символ, інколи «задума» 200–550 мс); після дії — `waitQuiet` (мережевий спокій, `behavior.settle`); паузи між кроками — `pauseAfter`: після руху 15–60 мс, текст→текст 0, інакше 350–1100 мс.'
    : 'миттєві дії (`page.mouse.move` без кроків), паузи `pauseAfter`: після руху 0, текст→текст 25 мс, інакше 80 мс; після дії — `waitQuiet` (`behavior.settle`).'));
  steps.forEach((s, i) => md.push((i + 1) + '. ' + s));
  md.push('');
  if (!isCfx) {
    const fa = spec.fingerprintApplied;
    md.push('### Де застосовується кожне поле fingerprint');
    md.push('');
    md.push('- **Опції контексту** (`CONTEXT`): `userAgent`, `locale` (→ також заголовок `Accept-Language`), `timezoneId`, `viewport`, `deviceScaleFactor`' + (fa.context.length ? ' — задано: `' + fa.context.join('`, `') + '`' : '') + (fa.defaults.length ? '; дефолти застосунку: ' + fa.defaults.join(', ') : '') + '.');
    md.push('- **Init-скрипт** (геттери в головному світі): `languages`, `hardwareConcurrency`, `deviceMemory`, `platform`, `vendor` (own-property на `navigator`), `screen.width/height/availWidth/availHeight/colorDepth/pixelDepth` (own-property на `screen`; avail* = width/height)' + (fa.initScript.length ? ' — задано: `' + fa.initScript.join('`, `') + '`' : ' — нічого не задано') + '.');
    md.push('- Не використовуй замість цього Playwright-опції `screen`/`extraHTTPHeaders`/`userAgentData` — сигнали вийдуть іншими. Окремого `Accept-Language`, крім `locale`, застосунок не ставить.');
    md.push('');
  }
  md.push('## Специфікація (JSON)');
  md.push('');
  md.push(fence('json', js(spec)));
  md.push('');
  if (!isCfx) {
    md.push('## Init-скрипт (дослівно)');
    md.push('');
    md.push(fence('js', init));
    md.push('');
  }
  md.push('## Готовий клієнт');
  md.push('');
  md.push(fence('js', client));
  md.push('');
  md.push('## Чого в експорті немає (і що впливає на проходження перевірок)');
  md.push('');
  md.push('- **IP-адреса / мережа.** Резидентний IP проходить, дата-центр (VPN/хостинг) блокується жорсткіше — особливо Cloudflare.');
  md.push('- **Cookies / сесії** — свідомо не експортовано (' + spec.cookies.count + ' шт.; значення, storageState і localStorage не потрапляють у файл).');
  md.push('- **Кроки сценарію** (кліки/текст/файли) — лише конфіг браузера; логіку дій клієнт пише сам із функцій рантайму (`humanClick`, `humanType`, `waitQuiet`, `pauseAfter`…).');
  if (!isCfx && spec.chromium.flags.realGpu) md.push('- **Реальний GPU** (`--use-angle=metal`) — лише macOS; на Linux без GPU Chrome впаде на SwiftShader, і WebGL-відбиток зміниться.');
  if (!isCfx) md.push('- **CDP.** Chromium керується через CDP — деякі антиботи (Cloudflare на окремих сайтах) детектують сам факт CDP-керування; init-скрипт це не ховає. Для таких сайтів у застосунку використовується Camoufox.');
  if (isCfx) md.push('- **Fingerprint Camoufox** — не експортується (його немає в конфігу: рушій генерує новий на кожен запуск). Зафіксувати ОС можна `launchOptions({ os: "macos" })`, але застосунок цього не робить — для паритету не задавай.');
  md.push('');
  if (!isCfx) {
    const ws = [];
    if (spec.expected.navigatorOwnProps.length || spec.fingerprint && spec.fingerprint.screen) ws.push('Геттери init-скрипту — звичайні функції: `Object.getOwnPropertyDescriptor(navigator, "platform").get.toString()` показує їхній код, а не `[native code]`; own-property на `navigator`/`screen` видно в `getOwnPropertyNames`.');
    if (spec.fingerprint && spec.fingerprint.screen) ws.push('`screen.*` підмінено лише в JS: `matchMedia("(device-width: …px)")` відповідає реальному екрану/viewport, а не `screen.width`.');
    if (spec.fingerprint && Array.isArray(spec.fingerprint.languages) && spec.fingerprint.languages.length > 1) ws.push('`Accept-Language` береться з `locale` (`' + spec.context.locale + '`), а `navigator.languages` — з fingerprint (' + spec.fingerprint.languages.join(', ') + ') — заголовок і JS можуть не збігатися.');
    if (/^browser/.test(spec.chromium.effectiveUserAgent)) ws.push('Client hints від `user-agent-override` (UA браузера на macOS): `sec-ch-ua-platform` = `"Mac OS X"` (а не `"macOS"`), `architecture` = `x86` навіть на Apple Silicon, `platformVersion` з UA (`10_15_7`), бренд-список «GREASE» плагіна відрізняється від нативного `fullVersionList`.');
    else {
      const ctxMajor = uaMajor(spec.context.userAgent), brMajor = major(v.chrome);
      if (ctxMajor && brMajor && ctxMajor !== brMajor) ws.push('UA контексту каже Chrome/' + ctxMajor + ', а браузер — ' + brMajor + ': `navigator.userAgentData` і `sec-ch-ua` показують ' + brMajor + ' — невідповідність видно детекторам.');
    }
    if (ws.length) {
      md.push('## Слабкі місця конфігу (спільні для застосунку і клієнта)');
      md.push('');
      for (const w of ws) md.push('- ' + w);
      md.push('');
    }
  }
  md.push('## Як перевірити, що клієнт відповідає оригіналу');
  md.push('');
  md.push('Відкрий одну й ту саму **власну** сторінку-детектор у застосунку (рендер) і в клієнті: `node client.mjs <url> out.jpg --signals` друкує сигнали (`dumpSignals` виконується в головному світі — лише для перевірки, не на цільових сайтах). Додатково дивись заголовки запиту (`User-Agent`, `Accept-Language`, `sec-ch-ua*`).');
  md.push('');
  if (isCfx) {
    md.push('Fingerprint Camoufox випадковий на кожен запуск, тож **ОС/UA-платформа, `platform`, `hardwareConcurrency`, `screen.*`, WebGL vendor/renderer відрізнятимуться навіть між двома запусками застосунку**. Мають збігатися структурні сигнали: `navigator.webdriver === false` (не own-property), UA — Firefox тієї ж версії, `typeof window.chrome === "undefined"`, немає `__pwInitScripts`, `navigator.vendor === ""`, `deviceMemory` відсутній, кількість plugins/mimeTypes, `devicePixelRatio`, viewport 1280×720, timezone/`Intl` locale (' + (spec.camoufox.geoip ? 'під IP' : 'з хоста') + ').');
  } else {
    const e = spec.expected;
    md.push('Мають збігатися: `navigator.webdriver` (очікувано ' + JSON.stringify(e['navigator.webdriver']) + '), `navigator.userAgent`, `navigator.userAgentData`, `languages`, `platform`, `vendor`, `hardwareConcurrency`, `deviceMemory`, `screen.*`, `devicePixelRatio`, `inner/outerWidth/Height`, `typeof window.chrome` і його ключі, `Object.getOwnPropertyNames(navigator)` (очікувано `' + JSON.stringify(e.navigatorOwnProps) + '`), `\'__pwInitScripts\' in window` (очікувано `' + e["'__pwInitScripts' in window"] + '`), `navigator.plugins.length`, WebGL vendor/renderer (на тій самій машині), `Intl.DateTimeFormat().resolvedOptions()` (timeZone, locale), `permissions.query({name:"notifications"})`. Зовнішній еталон стелсу: https://bot-detector.rebrowser.net.');
  }
  md.push('');
  return { markdown: md.join('\n'), spec, filename: exportFilename(meta.presetName, now) };
}
