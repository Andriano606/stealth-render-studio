// Експорт застосованого конфігу браузера у Markdown-документ, за яким людина або
// LLM (Claude) може відтворити клієнт, що поводиться так само: точні аргументи
// запуску, опції контексту, ДОСЛІВНИЙ stealth init-скрипт, налаштування
// stealth-плагіна, Cloudflare-навігація, людська поведінка + готовий client.mjs.
//
// Чиста функція buildConfigExport(profile, meta) → { markdown, spec, filename }.
// Секрети НЕ експортуються: cookies (storageState) — лише кількість і домени.
import { launchFlags, camoufoxOptions, engineKind } from './engine.js';
import { contextOptions } from './profile.js';
import { stealthScript } from './stealth.js';
import { CF_TEXT_RE, CF_MARKER_SELECTOR } from './nav.js';

// Повний перелік евейжнів puppeteer-extra-plugin-stealth (2.11.x) — запасний, якщо
// плагін ще не підвантажено; застосунок вимикає webgl.vendor (реальний GPU).
export const DEFAULT_STEALTH_EVASIONS = [
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime', 'defaultArgs', 'iframe.contentWindow',
  'media.codecs', 'navigator.hardwareConcurrency', 'navigator.languages', 'navigator.permissions',
  'navigator.plugins', 'navigator.webdriver', 'sourceurl', 'user-agent-override', 'webgl.vendor', 'window.outerdimensions',
];
export const DISABLED_EVASIONS = ['webgl.vendor'];

// Умовно-стабільна назва файлу: stealth-config-<пресет>-<дата>.md
export function exportFilename(presetName, now = new Date()) {
  const slug = String(presetName || 'custom').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'custom';
  const d = now.toISOString().slice(0, 10);
  return 'stealth-config-' + slug + '-' + d + '.md';
}

// Машинозчитувана специфікація (без секретів).
export function buildSpec(profile, meta = {}) {
  const p = profile || {};
  const L = p.launch || {};
  const engine = engineKind(p);
  const cookies = (p.storageState && Array.isArray(p.storageState.cookies)) ? p.storageState.cookies : [];
  const spec = {
    name: meta.presetName || 'кастом',
    presetStatus: meta.presetStatus || null,
    generatedAt: (meta.now || new Date()).toISOString(),
    engine,
    versions: meta.versions || {},
    behavior: {
      humanize: (p.behavior || {}).humanize !== false,
      prepareScroll: (p.behavior || {}).prepareScroll !== false,
    },
    cookies: { count: cookies.length, domains: [...new Set(cookies.map((c) => c.domain).filter(Boolean))].sort(), exported: false },
  };
  if (engine === 'camoufox') {
    spec.camoufox = camoufoxOptions(L);
    spec.context = { note: 'Camoufox: newContext() БЕЗ опцій — fingerprint генерує сам рушій (C++). Жодних init-скриптів.' };
  } else {
    const flags = launchFlags(L);
    const ctx = contextOptions(p);
    delete ctx.storageState; // секрети не експортуємо
    const evasions = (meta.evasions && meta.evasions.length ? meta.evasions : DEFAULT_STEALTH_EVASIONS.filter((e) => !DISABLED_EVASIONS.includes(e)));
    spec.chromium = {
      launch: flags,
      headlessMode: L.headless === false ? 'headful' : (L.newHeadless !== false ? 'new (--headless=new, headless:false)' : 'old (headless:true)'),
      stealthPlugin: { enabled: L.stealthPlugin !== false, evasions: L.stealthPlugin !== false ? evasions : [], disabled: DISABLED_EVASIONS },
      flags: {
        automationControlled: L.automationControlled !== false,
        realGpu: L.realGpu !== false,
        siteIsolationDisabled: L.siteIsolationDisabled !== false,
      },
    };
    spec.context = ctx;
    spec.stealth = { ...(p.stealth || {}) };
    spec.fingerprint = p.fingerprint || null;
  }
  return spec;
}

const js = (v) => JSON.stringify(v, null, 2);
const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const yesNo = (b) => (b ? '✅ так' : '— ні');

// Самодостатній клієнт (Node 20, ESM) — відтворює конфіг без застосунку.
export function buildClient(spec, initScript) {
  const isCfx = spec.engine === 'camoufox';
  const usePlugin = !isCfx && spec.chromium.stealthPlugin.enabled;
  const v = spec.versions || {};
  const deps = isCfx
    ? ['camoufox-js@' + (v['camoufox-js'] || 'latest'), 'playwright-core@' + (v['playwright-core'] || v.playwright || 'latest')]
    : ['playwright@' + (v.playwright || 'latest')].concat(usePlugin ? ['playwright-extra@' + (v['playwright-extra'] || 'latest'), 'puppeteer-extra-plugin-stealth@' + (v['puppeteer-extra-plugin-stealth'] || 'latest')] : []);
  const L = [];
  L.push('// client.mjs — відтворює конфіг «' + spec.name + '» (Stealth Render Studio, ' + spec.generatedAt + ').');
  L.push('// Встановлення: npm i ' + deps.join(' ') + (isCfx ? '  &&  npx camoufox-js fetch' : '') + '');
  L.push('// Запуск: node client.mjs <url> [screenshot.jpg]   (Node 20+, "type": "module" або .mjs)');
  if (!isCfx) L.push('// Потрібен встановлений Google Chrome (channel: "chrome").');
  L.push('');
  L.push("import { pathToFileURL } from 'node:url';");
  if (isCfx) {
    L.push("import { Camoufox } from 'camoufox-js';");
  } else if (usePlugin) {
    L.push("import { chromium } from 'playwright-extra';");
    L.push("import StealthPlugin from 'puppeteer-extra-plugin-stealth';");
  } else {
    L.push("import { chromium } from 'playwright';");
  }
  L.push('');
  if (isCfx) {
    L.push('const CAMOUFOX = ' + js(spec.camoufox) + ';');
  } else {
    L.push('const LAUNCH = ' + js(spec.chromium.launch) + ';');
    L.push('const CONTEXT = ' + js(spec.context) + ';');
    if (usePlugin) L.push('const EVASIONS = ' + js(spec.chromium.stealthPlugin.evasions) + ';');
    L.push('// Init-скрипт ДОСЛІВНО як у застосунку (додається ПІСЛЯ евейжнів плагіна, останнім).');
    L.push('const INIT_SCRIPT = ' + JSON.stringify(initScript) + ';');
  }
  L.push('const HUMANIZE = ' + spec.behavior.humanize + ';');
  L.push('');
  L.push('export async function launch() {');
  if (isCfx) {
    L.push('  return Camoufox(CAMOUFOX);');
  } else if (usePlugin) {
    L.push('  const stealth = StealthPlugin();');
    L.push('  for (const e of [...stealth.enabledEvasions]) if (!EVASIONS.includes(e)) stealth.enabledEvasions.delete(e);');
    L.push('  chromium.use(stealth);');
    L.push('  return chromium.launch(LAUNCH);');
  } else {
    L.push('  return chromium.launch(LAUNCH);');
  }
  L.push('}');
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
  L.push('// ---- Навігація, стійка до Cloudflare: domcontentloaded → чекаємо, поки зникне інтерстиціал ----');
  L.push('const CF_TEXT_RE = new RegExp(' + JSON.stringify(CF_TEXT_RE.source) + ', ' + JSON.stringify(CF_TEXT_RE.flags) + ');');
  L.push('const CF_MARKER_SELECTOR = ' + JSON.stringify(CF_MARKER_SELECTOR) + ';');
  L.push('const rnd = (a, b) => a + Math.random() * (b - a);');
  L.push('const rint = (a, b) => Math.round(rnd(a, b));');
  L.push(`export async function waitPastCloudflare(page, maxMs = 40000) {
  const start = Date.now();
  let wasChallenge = false, iter = 0;
  while (Date.now() - start < maxMs) {
    iter++;
    const title = (await page.title().catch(() => '')) || '';
    const body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 600) : '')).catch(() => '');
    const marker = await page.evaluate((sel) => !!document.querySelector(sel), CF_MARKER_SELECTOR).catch(() => false);
    if (marker || CF_TEXT_RE.test(title) || CF_TEXT_RE.test(body)) {
      wasChallenge = true;
      // Людська активність, поки крутиться челендж (рухи миші; інколи колесо).
      await page.mouse.move(rint(80, 1000), rint(80, 650), { steps: rint(6, 16) }).catch(() => {});
      if (iter % 3 === 0) await page.mouse.wheel(0, rint(-60, 160)).catch(() => {});
      await page.waitForTimeout(rint(900, 1400));
      continue;
    }
    if (!wasChallenge) { if (iter >= 2) return { passed: true, wasChallenge: false }; await page.waitForTimeout(300); continue; }
    if (body.replace(/\\s+/g, '').length > 80 || Date.now() - start > 2000) return { passed: true, wasChallenge };
    await page.waitForTimeout(500);
  }
  return { passed: false, wasChallenge };
}

export async function gotoSmart(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const cf = await waitPastCloudflare(page);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  return { resp, cf };
}

// ---- Людська поведінка (HUMANIZE) — ті самі діапазони, що в застосунку ----
export async function humanMove(page, from, toX, toY) {
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
export async function humanPress(page) {
  await page.waitForTimeout(rint(60, 180));
  await page.mouse.down();
  await page.waitForTimeout(rint(40, 110));
  await page.mouse.up();
}
export async function humanClick(page, from, x, y) {
  const pos = await humanMove(page, from, x, y);
  await humanPress(page);
  return pos;
}
export async function humanType(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(rint(45, 160));
    if (Math.random() < 0.07) await page.waitForTimeout(rint(200, 550));
  }
}
// «Роздивляння»: 1–3 дрібні прокрутки колесом із паузами (лише між незалежними кроками).
export async function humanWander(page) {
  for (let i = rint(1, 3); i > 0; i--) {
    await page.mouse.wheel(0, rint(-120, 280)).catch(() => {});
    await page.waitForTimeout(rint(250, 750));
  }
}
// Пауза між кроками сценарію: людська або мінімальна.
export const pauseBetweenSteps = () => (HUMANIZE ? rint(350, 1100) : 80);

// ---- Приклад: відкрити URL і зняти fullPage-скрин ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) { console.error('usage: node client.mjs <url> [out.jpg]'); process.exit(2); }
  const browser = await launch();
  try {
    const { page } = await newPage(browser);
    const { resp, cf } = await gotoSmart(page, url);
    console.log('status', resp && resp.status(), 'cloudflare', cf);
    await page.screenshot({ path: process.argv[3] || 'screenshot.jpg', type: 'jpeg', quality: 70, fullPage: true, caret: 'initial' });
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
  md.push('Згенеровано Stealth Render Studio ' + spec.generatedAt + '. Документ описує **застосований** конфіг: усе, що потрібно, щоб написати клієнт, який запускає браузер із тими самими сигналами. Розділ «Готовий клієнт» — робочий `client.mjs`; JSON-блок — машинозчитувана версія.');
  if (spec.presetStatus === 'changed') md.push('\n> ⚠️ Конфіг відрізняється від пресета «' + spec.name + '» — експортовано саме поточний (застосований) стан.');
  md.push('');
  md.push('## Коротко');
  md.push('');
  md.push('| Параметр | Значення |');
  md.push('|---|---|');
  md.push('| Рушій | ' + (isCfx ? '🦊 Camoufox (кастомний Firefox, керування через Juggler, без CDP)' : '🧩 Chromium (Google Chrome, `channel: "chrome"`, керування через CDP)') + ' |');
  if (isCfx) {
    md.push('| headless | ' + yesNo(spec.camoufox.headless) + ' |');
    md.push('| humanize (рушій сам веде курсор) | ' + yesNo(spec.camoufox.humanize) + ' |');
    md.push('| geoip (timezone/locale під IP) | ' + yesNo(spec.camoufox.geoip) + ' |');
  } else {
    const c = spec.chromium;
    md.push('| Headless-режим | ' + c.headlessMode + ' |');
    md.push('| `--disable-blink-features=AutomationControlled` | ' + yesNo(c.flags.automationControlled) + ' |');
    md.push('| Реальний GPU (ANGLE→Metal, macOS) | ' + yesNo(c.flags.realGpu) + ' |');
    md.push('| Ізоляцію сайтів вимкнено (крос-доменні iframe у скріні) | ' + yesNo(c.flags.siteIsolationDisabled) + ' |');
    md.push('| puppeteer-extra stealth-плагін | ' + yesNo(c.stealthPlugin.enabled) + (c.stealthPlugin.enabled ? ' (вимкнено: ' + c.stealthPlugin.disabled.join(', ') + ')' : '') + ' |');
    for (const [k, label] of [['webdriver', 'navigator.webdriver = false (на прототипі)'], ['windowChrome', 'window.chrome'], ['outerWindow', 'outerWidth/Height = inner (+74)'], ['permissions', 'permissions.query узгоджений'], ['pwInitScripts', 'прибрати window.__pwInitScripts']]) {
      md.push('| Stealth: ' + label + ' | ' + yesNo(spec.stealth[k]) + ' |');
    }
    md.push('| Fingerprint | ' + (spec.fingerprint ? 'задано (UA, locale, timezone, екран… — див. JSON)' : '— не задано (дефолт Playwright)') + ' |');
    md.push('| Viewport / DPR | ' + spec.context.viewport.width + '×' + spec.context.viewport.height + ' / ' + spec.context.deviceScaleFactor + ' |');
  }
  md.push('| Людська поведінка (humanize) | ' + yesNo(spec.behavior.humanize) + ' |');
  md.push('| Cookies | ' + (spec.cookies.count ? spec.cookies.count + ' шт. — **не експортовано** (домени: ' + spec.cookies.domains.join(', ') + ')' : 'немає') + ' |');
  md.push('');
  md.push('Версії: ' + Object.entries(v).map(([k, x]) => '`' + k + '@' + x + '`').join(', ') + (v.browser ? '' : '') + '.');
  md.push('');
  md.push('## Як застосунок використовує цей конфіг');
  md.push('');
  if (isCfx) {
    md.push('1. `Camoufox(options)` з `camoufox-js` (див. JSON `camoufox`). Fingerprint, UA, екран, WebGL генерує сам рушій на рівні C++ — **жодних** init-скриптів і опцій контексту.');
    md.push('2. На кожну сесію — `browser.newContext()` без опцій → `newPage()` (контекст використовується рівно один раз).');
  } else {
    md.push('1. Запуск: `' + (spec.chromium.stealthPlugin.enabled ? 'playwright-extra' : 'playwright') + '.chromium.launch(LAUNCH)` з точними `args` нижче' + (spec.chromium.stealthPlugin.enabled ? ' + `puppeteer-extra-plugin-stealth` (усі евейжни, крім `webgl.vendor`: WebGL не спуфиться, щоб назва GPU не суперечила реальним пікселям)' : '') + '.');
    md.push('2. На кожну сесію — новий контекст `browser.newContext(CONTEXT)` (viewport, UA, locale, timezone, DPR із fingerprint) → `context.addInitScript(INIT_SCRIPT)` (останнім, після евейжнів плагіна) → `newPage()`. Контекст використовується рівно один раз.');
    md.push('3. Init-скрипт нижче — дослівно той, що інʼєктує застосунок. Він ставить `navigator.webdriver` **на прототипі** (не own-property), щоб `Object.getOwnPropertyNames(navigator)` був чистим.');
  }
  md.push((isCfx ? '3' : '4') + '. Навігація: `goto(url, {waitUntil: "domcontentloaded"})` → поки на сторінці інтерстиціал Cloudflare (маркер `' + CF_MARKER_SELECTOR + '` або текст за регекспом), рухаємо мишу кожні ~1 с і інколи крутимо колесо → `networkidle` (до 8 с).');
  md.push((isCfx ? '4' : '5') + '. Поведінка: ' + (spec.behavior.humanize ? 'кліки — рух миші 2–4 «хопами» з дугою + роздільні down/up з паузами; друк — по символу 45–160 мс (інколи «задума» 200–550 мс); між кроками — 350–1100 мс.' : 'миттєві дії, пауза між кроками ~80 мс.'));
  md.push('');
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
  md.push('- **Cookies / сесії** — свідомо не експортовано (' + spec.cookies.count + ' шт.).');
  md.push('- **Кроки сценарію** (кліки/текст/файли) — лише конфіг браузера; логіку дій клієнт пише сам (див. humanClick/humanType).');
  if (!isCfx && spec.chromium.flags.realGpu) md.push('- **Реальний GPU** (`--use-angle=metal`) — лише macOS; на Linux без GPU Chrome впаде на SwiftShader, і WebGL-відбиток зміниться.');
  if (!isCfx) md.push('- **CDP.** Chromium керується через CDP — деякі антиботи (Cloudflare на окремих сайтах) детектують сам факт CDP-керування; init-скрипт це не ховає. Для таких сайтів у застосунку використовується Camoufox.');
  md.push('');
  md.push('## Як перевірити, що клієнт відповідає оригіналу');
  md.push('');
  md.push('Відкрий одну й ту саму сторінку-детектор (напр. https://bot-detector.rebrowser.net або власну сторінку, що виводить `navigator.webdriver`, `navigator.userAgent`, `navigator.languages`, `navigator.platform`, `hardwareConcurrency`, `deviceMemory`, `screen.*`, `devicePixelRatio`, `typeof window.chrome`, `outerWidth/outerHeight`, `Object.getOwnPropertyNames(navigator)`, `typeof window.__pwInitScripts`, `navigator.plugins.length`, WebGL vendor/renderer, `Intl.DateTimeFormat().resolvedOptions().timeZone`) у застосунку й у клієнті — значення мають збігатися.');
  md.push('');
  return { markdown: md.join('\n'), spec, filename: exportFilename(spec.name, now) };
}
