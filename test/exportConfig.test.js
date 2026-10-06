// Юніт-тести експорту конфігу (lib/exportConfig.js): специфікація, відсутність
// секретів, дослівний init-скрипт, синтаксично коректний client.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildConfigExport, buildSpec, exportFilename, DEFAULT_STEALTH_EVASIONS } from '../lib/exportConfig.js';
import { defaultProfile, applyProfilePatch } from '../lib/profile.js';
import { stealthScript } from '../lib/stealth.js';
import { launchFlags } from '../lib/engine.js';

const FP = { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/154.0.0.0 Safari/537.36', locale: 'uk', languages: ['uk', 'en'], timezoneId: 'Europe/Kiev', platform: 'MacIntel', deviceScaleFactor: 2, screen: { width: 1680, height: 1050, colorDepth: 30 } };
const withFp = () => applyProfilePatch(defaultProfile(), { fingerprint: FP, cookies: [{ name: 'sid', value: 'SECRET-COOKIE', domain: '.preply.com' }] }).profile;
const clientOf = (md) => md.match(/## Готовий клієнт\n\n```js\n([\s\S]*?)\n```/)[1];
function nodeCheck(src) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srs-exp-')), 'client.mjs');
  fs.writeFileSync(f, src);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  return r;
}

test('Chromium: специфікація збігається з тим, що робить застосунок', () => {
  const p = withFp();
  const spec = buildSpec(p, { presetName: 'Ashby 2', evasions: ['chrome.app', 'navigator.webdriver'] });
  assert.equal(spec.engine, 'chromium');
  assert.deepEqual(spec.chromium.launch, launchFlags(p.launch));
  assert.equal(spec.context.userAgent, FP.userAgent);
  assert.equal(spec.context.deviceScaleFactor, 2);
  assert.equal(spec.context.storageState, undefined, 'cookies не потрапляють у контекст експорту');
  assert.deepEqual(spec.chromium.stealthPlugin.evasions, ['chrome.app', 'navigator.webdriver']);
  assert.deepEqual(spec.cookies, { count: 1, domains: ['.preply.com'], exported: false });
});

test('без секретів: значення cookies ніде в документі', () => {
  const { markdown } = buildConfigExport(withFp(), { presetName: 'X' });
  assert.equal(/SECRET-COOKIE/.test(markdown), false);
  assert.match(markdown, /1 шт\. — \*\*не експортовано\*\*/);
});

test('init-скрипт у документі й у client.mjs — дослівно той, що інʼєктує застосунок', () => {
  const p = withFp();
  const { markdown } = buildConfigExport(p, {});
  const init = stealthScript(p.fingerprint, p.stealth);
  assert.ok(markdown.includes(init), 'розділ «Init-скрипт (дослівно)»');
  assert.ok(clientOf(markdown).includes('const INIT_SCRIPT = ' + JSON.stringify(init) + ';'));
});

test('client.mjs синтаксично коректний: Chromium+плагін, Chromium без плагіна, Camoufox', () => {
  const base = defaultProfile();
  const variants = {
    plugin: withFp(),
    plain: applyProfilePatch(base, { launch: { stealthPlugin: false } }).profile,
    camoufox: applyProfilePatch(base, { launch: { engine: 'camoufox' } }).profile,
  };
  for (const [name, p] of Object.entries(variants)) {
    const src = clientOf(buildConfigExport(p, { presetName: name }).markdown);
    const r = nodeCheck(src);
    assert.equal(r.status, 0, name + ': ' + r.stderr);
  }
  assert.match(clientOf(buildConfigExport(variants.plugin, {}).markdown), /import\('playwright-extra'\)/);
  assert.match(clientOf(buildConfigExport(variants.plain, {}).markdown), /import\('playwright'\)/);
  const cfx = buildConfigExport(variants.camoufox, {}).markdown;
  assert.match(clientOf(cfx), /import\('camoufox-js'\)/);
  assert.equal(/INIT_SCRIPT/.test(cfx), false, 'Camoufox — без init-скриптів');
});

test('без завантаженого плагіна — дефолтний перелік евейжнів без webgl.vendor', () => {
  const spec = buildSpec(withFp(), {});
  assert.ok(spec.chromium.stealthPlugin.evasions.length === DEFAULT_STEALTH_EVASIONS.length - 1);
  assert.ok(!spec.chromium.stealthPlugin.evasions.includes('webgl.vendor'));
  const off = buildSpec(applyProfilePatch(withFp(), { launch: { stealthPlugin: false } }).profile, {});
  assert.deepEqual(off.chromium.stealthPlugin.evasions, []);
});

test('попередження, коли конфіг відрізняється від пресета; назва файлу', () => {
  const { markdown, filename } = buildConfigExport(withFp(), { presetName: 'Ashby 2', presetStatus: 'changed', now: new Date(2026, 9, 6, 12) });
  assert.match(markdown, /відрізняється від пресета «Ashby 2»/);
  assert.equal(filename, 'stealth-config-ashby-2-2026-10-06.md');
  assert.equal(exportFilename('☁️ Cloudflare', new Date(2026, 0, 2, 12)), 'stealth-config-cloudflare-2026-01-02.md');
  assert.equal(exportFilename('', new Date(2026, 0, 2, 12)), 'stealth-config-custom-2026-01-02.md');
});

// ---------- Фікси за результатами звірки клієнта із застосунком ----------
import { pathToFileURL } from 'node:url';
import * as nav from '../lib/nav.js';
import * as iso from '../lib/isoworld.js';
import * as human from '../lib/human.js';
import { pauseAfter } from '../lib/replay.js';
import { buildClient, cleanName, CAMOUFOX_PATCH_RE, CLIENT_EXPORTS, runtimeSource } from '../lib/exportConfig.js';

const camoufoxProfile = (patch = {}) => applyProfilePatch(defaultProfile(), { launch: { engine: 'camoufox', ...patch } }).profile;
const bareProfile = () => applyProfilePatch(defaultProfile(), { clear: true }).profile;
const tmpDirs = [];
// Пише client.mjs (і фейкові пакети node_modules) у tmp і імпортує його як модуль.
async function loadClient(src, pkgs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-client-'));
  tmpDirs.push(dir);
  for (const [name, files] of Object.entries(pkgs)) {
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(dir, 'node_modules', name, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
  }
  const f = path.join(dir, 'client.mjs');
  fs.writeFileSync(f, src);
  return { dir, mod: await import(pathToFileURL(f).href) };
}
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Фейкова сторінка Playwright: миттєві таймери, мінімальні відповіді зондів.
function fakePage({ cdp = null } = {}) {
  const log = { evaluate: 0, moves: 0, wheels: 0, keys: '', cdp: [] };
  const answer = (fn) => {
    const s = String(fn);
    if (s.includes('insetAt')) return { w: 1280, h: 900, dpr: 1, sw: 1280, sh: 900, scrollY: 0, topInset: 0, bottomInset: 0 };
    if (s.includes('elementFromPoint')) return { x: 20, y: 450 };
    if (s.includes('requestAnimationFrame')) return 0;
    if (s.includes('innerText.length')) return 500;
    if (s.includes('innerText')) return 'Real content '.repeat(10);
    return false;
  };
  const page = {
    log,
    title: async () => 'Real page',
    evaluate: async (fn) => { log.evaluate++; return answer(fn); },
    frames: () => [{ evaluate: async (fn) => { log.evaluate++; return answer(fn); } }],
    mainFrame() { return this.frames()[0]; },
    goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: { move: async () => { log.moves++; }, wheel: async () => { log.wheels++; }, down: async () => {}, up: async () => {} },
    keyboard: { type: async (ch) => { log.keys += ch; } },
    context: () => (cdp ? { newCDPSession: async () => cdp } : {}),
  };
  return page;
}
function fakeCdp(page) {
  return {
    async send(method, params) {
      page.log.cdp.push(method);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        const v = e.includes('innerText') ? 'Real content '.repeat(10) : e.includes('querySelectorAll(\'iframe') ? [] : false;
        return { result: { value: v } };
      }
      return {};
    },
  };
}

test('рантайм client.mjs — ДОСЛІВНІ джерела функцій застосунку (ізольований світ, навігація, поведінка)', () => {
  const src = clientOf(buildConfigExport(withFp(), {}).markdown);
  for (const f of [iso.evalMain, iso.isoState, iso.createIso, nav.waitPastCloudflare, nav.gotoSmart, nav.prepareForInteraction,
    nav.autoScroll, nav.wheelSweep, nav.AUTOSCROLL_FN, human.humanMove, human.humanType, human.humanWander, pauseAfter]) {
    assert.ok(src.includes(String(f)), 'немає дослівного джерела ' + (f.name || String(f).slice(0, 40)));
  }
  assert.ok(src.includes(runtimeSource()));
  assert.match(src, /await prepareForInteraction\(page\); \/\/ як \/render/, 'приклад робить те саме, що /render перед скрином');
});

test('client.mjs вантажиться без браузерних пакетів і експортує API; рантайм працює без ReferenceError', async () => {
  for (const p of [withFp(), bareProfile(), camoufoxProfile()]) {
    const { mod } = await loadClient(clientOf(buildConfigExport(p, {}).markdown));
    for (const n of CLIENT_EXPORTS) assert.ok(n in mod, 'експорт ' + n);
    const page = fakePage();
    const nav0 = await mod.gotoSmart(page, 'http://x/');
    assert.equal(nav0.resp.status(), 200);
    assert.deepEqual(nav0.cf, { passed: true, wasChallenge: false });
    await mod.prepareForInteraction(page);
    await mod.prepareForInteraction(page, { mode: 'replay', humanize: true }); // wheelSweep: measure/pickNeutralPoint/waitScrollSettle
    assert.ok(page.log.moves > 0, 'wheelSweep веде мишу в нейтральну точку');
    // Те, що всередині рантайму ковтає помилки, — викликаємо напряму (ReferenceError не сховається).
    assert.deepEqual(await mod.evalAllFrames(page, () => document.body.innerText.length), [500]);
    assert.equal(await mod.wheelSweep(page), true);
    assert.equal((await mod.waitScrollSettle(page, { maxMs: 50 })).settled, true);
    assert.equal((await mod.measure(page)).w, 1280);
    assert.deepEqual(await mod.pickNeutralPoint(page, [{ x: 20, y: 450 }]), { x: 20, y: 450 });
    const cdpPage = fakePage();
    cdpPage.context = () => ({ newCDPSession: async () => fakeCdp(cdpPage) });
    assert.equal(typeof await mod.evalMain(cdpPage, () => document.body.innerText), 'string');
    assert.ok(cdpPage.log.cdp.includes('Page.createIsolatedWorld'));
    const pos = await mod.humanClick(page, { x: 0, y: 0 }, 100, 100, Math.random, { single: mod.SINGLE_MOVE });
    assert.deepEqual(pos, { x: 100, y: 100 });
    await mod.humanType(page, 'абв');
    assert.equal(page.log.keys, 'абв');
    await mod.humanWander(page, Math.random, { point: { x: 5, y: 5 }, from: { x: 0, y: 0 } });
    assert.equal(typeof mod.shouldWander({ humanize: true, phase: 'open' }), 'boolean');
    const tracker = mod.createNetTracker({ on() {}, off() {} });
    assert.equal((await mod.waitQuiet(tracker, { minMs: 0, quietMs: 0, maxMs: 10 })).quiet, true);
    assert.equal(mod.pauseAfter({ type: 'move' }, { type: 'click' }, true, mod.rint) <= 60, true);
  }
});

test('ізольований світ: у Chromium зонди Cloudflare-навігації йдуть через CDP, а не page.evaluate (головний світ)', async () => {
  const { mod } = await loadClient(clientOf(buildConfigExport(withFp(), {}).markdown));
  const page = fakePage();
  page.context = () => ({ newCDPSession: async () => fakeCdp(page) });
  const cf = await mod.waitPastCloudflare(page, 5000);
  assert.deepEqual(cf, { passed: true, wasChallenge: false });
  assert.equal(page.log.evaluate, 0, 'page.evaluate (головний світ) не викликався');
  assert.ok(page.log.cdp.includes('Page.createIsolatedWorld') && page.log.cdp.includes('Runtime.evaluate'));
  assert.equal(/Runtime\.enable/.test(clientOf(buildConfigExport(withFp(), {}).markdown)), false, 'без Runtime.enable');
});

test('stealth-плагін реєструється РІВНО раз на процес (повторний launch не задвоює евейжни)', async () => {
  const pkgs = {
    'playwright-extra': {
      'package.json': '{"name":"playwright-extra","type":"module","main":"index.js"}',
      'index.js': 'export const chromium = { uses: 0, use() { this.uses++; }, async launch(o) { return { o, uses: this.uses }; } };',
    },
    'puppeteer-extra-plugin-stealth': {
      'package.json': '{"name":"puppeteer-extra-plugin-stealth","type":"module","main":"index.js"}',
      'index.js': "export default () => ({ enabledEvasions: new Set(['chrome.app', 'webgl.vendor', 'navigator.webdriver']) });",
    },
  };
  const { mod } = await loadClient(clientOf(buildConfigExport(withFp(), { evasions: ['chrome.app', 'navigator.webdriver'] }).markdown), pkgs);
  const a = await mod.launch();
  const b = await mod.launch();
  assert.equal(a.uses, 1);
  assert.equal(b.uses, 1, 'use() викликано один раз');
  assert.equal(b.o.channel, 'chrome');
});

test('Camoufox: client.mjs сам латає валідатор camoufox-js 0.10.2 (той самий шаблон, що postinstall застосунку)', async () => {
  const script = fs.readFileSync(new URL('../scripts/patch-camoufox.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes('/' + CAMOUFOX_PATCH_RE.source + '/'), 'шаблон збігається з scripts/patch-camoufox.mjs');
  const UTILS = 'export function validateConfig(c) {\n  for (const key of Object.keys(c)) {\n    if (!known(key)) {\n      throw new UnknownProperty(`Unknown property ${key} in config`);\n    }\n  }\n}\n';
  const pkgs = { 'camoufox-js': { 'package.json': '{"name":"camoufox-js","type":"module","main":"dist/index.js"}', 'dist/index.js': 'export const launchOptions = async (o) => o;', 'dist/utils.js': UTILS } };
  const md = buildConfigExport(camoufoxProfile(), { versions: { 'camoufox-js': '0.10.2', 'playwright-core': '1.63.0', playwright: '1.63.0', chrome: '154' } }).markdown;
  const { dir, mod } = await loadClient(clientOf(md), pkgs);
  assert.equal(mod.patchCamoufoxJs(), 'patched');
  const patched = fs.readFileSync(path.join(dir, 'node_modules/camoufox-js/dist/utils.js'), 'utf8');
  assert.match(patched, /continue; \/\* CAMOUFOX_PATCHED/);
  assert.equal(/throw new UnknownProperty/.test(patched), false);
  assert.equal(mod.patchCamoufoxJs(), 'already', 'ідемпотентно');
  assert.match(clientOf(md), /launchOptions\(\{ \.\.\.rest, headless: !!headless \}\)/, 'як застосунок: launchOptions + firefox.launch');
  assert.match(clientOf(md), /npm i camoufox-js@0\.10\.2 playwright-core@1\.63\.0/);
});

test('Camoufox: документ чесно каже про випадковий fingerprint, viewport 1280×720 і timezone/locale з хоста', () => {
  const md = buildConfigExport(camoufoxProfile({ camoufoxGeoip: false, camoufoxHumanize: true }), {}).markdown;
  assert.match(md, /випадков\S* (на кожен|при кожному) запуск/);
  assert.match(md, /1280×720/);
  assert.match(md, /timezone і locale беруться з хоста/);
  assert.match(md, /відрізнятимуться навіть між двома запусками застосунку/);
  assert.equal(/значення мають збігатися/.test(md), false);
  const spec = buildSpec(camoufoxProfile({ camoufoxHumanize: true }), {});
  assert.equal(spec.behavior.singleMove, true, 'Camoufox-humanize → один mouse.move, як у застосунку');
  assert.equal(buildSpec(camoufoxProfile({ camoufoxHumanize: false }), {}).behavior.singleMove, false);
  assert.match(clientOf(md), /export const SINGLE_MOVE = true;/);
});

test('UA: зі stealth-плагіном (user-agent-override) документ каже, що CONTEXT.userAgent перекривається', () => {
  const on = buildConfigExport(withFp(), {});
  assert.match(on.spec.chromium.effectiveUserAgent, /^browser/);
  assert.match(on.markdown, /`CONTEXT\.userAgent` фактично \*\*не діє\*\*/);
  const off = buildConfigExport(applyProfilePatch(withFp(), { launch: { stealthPlugin: false } }).profile, {});
  assert.equal(off.spec.chromium.effectiveUserAgent, 'context.userAgent');
  assert.equal(/фактично \*\*не діє\*\*/.test(off.markdown), false);
});

test('порядок init-скриптів описано правильно: скрипт контексту ПЕРШИМ, евейжни плагіна — після', () => {
  const md = buildConfigExport(withFp(), {}).markdown;
  assert.match(md, /наш init-скрипт працює \*\*першим\*\*/);
  assert.equal(/ПІСЛЯ евейжнів плагіна, останнім|останнім, після евейжнів/.test(md), false);
});

test('pwInitScripts: опція лише видаляє об\'єкт — у документі очікувано `in window` = false (як у Chrome)', () => {
  const md = buildConfigExport(withFp(), {}).markdown;
  assert.match(md, /'__pwInitScripts' in window` \(очікувано `false`\)/);
  assert.match(md, /видалити window\.__pwInitScripts, якщо є/);
  assert.equal(/не створює\*\*/.test(md), false, 'розділ про геттер-маячок прибрано — його більше немає');
  const off = buildConfigExport(applyProfilePatch(withFp(), { stealth: { pwInitScripts: false } }).profile, {}).markdown;
  assert.match(off, /'__pwInitScripts' in window` \(очікувано `false`\)/);
});

test('webdriver/own-property: крок 3 залежить від stealth.webdriver; own-property полів fingerprint названо', () => {
  const md = buildConfigExport(withFp(), {}).markdown;
  assert.match(md, /`navigator\.webdriver` ставиться \*\*на прототипі\*\*/);
  assert.match(md, /`languages`, `platform` визначаються як \*\*own-property\*\*/);
  assert.match(md, /Object\.getOwnPropertyNames\(navigator\)` \(очікувано `\["languages","platform"\]`\)/);
  const off = buildConfigExport(applyProfilePatch(withFp(), { stealth: { webdriver: false } }).profile, {}).markdown;
  assert.match(off, /`stealth\.webdriver` вимкнено/);
  assert.equal(/ставиться \*\*на прототипі\*\*/.test(off), false);
  assert.deepEqual(buildSpec(withFp(), {}).fingerprintApplied.initScript, ['languages', 'platform', 'screen']);
});

test('Clear all: чесні підписи — UA/locale з дефолтів застосунку, GPU, headless:true, розбіжність мажорних версій', () => {
  const r = buildConfigExport(bareProfile(), { versions: { playwright: '1.63.0', chrome: '154.0.8037.98', 'camoufox-js': '0.10.2', 'playwright-extra': '4.3.6' } });
  assert.match(r.markdown, /UA і locale — дефолти \*\*застосунку\*\*/);
  assert.equal(/дефолт Playwright\)/.test(r.markdown), false);
  assert.match(r.markdown, /ANGLE-прапорці не передаються/);
  assert.match(r.spec.chromium.headlessMode, /^headless:true .*Chrome ≥132/);
  assert.match(r.markdown, /UA контексту каже Chrome\/120, а браузер — 154/);
  assert.deepEqual(Object.keys(r.spec.versions).sort(), ['chrome', 'playwright'], 'лише пакети цього рушія/режиму');
  const c = buildSpec(camoufoxProfile(), { versions: { playwright: '1.63.0', 'playwright-core': '1.63.0', 'camoufox-js': '0.10.2', 'camoufox-browser': '156' } });
  assert.deepEqual(Object.keys(c.versions).sort(), ['camoufox-browser', 'camoufox-js', 'playwright-core']);
});

test('назва пресета з переносом рядка не ламає client.mjs і заголовок', () => {
  const evil = 'Ashby\nprocess.exit(7) //  x';
  const { markdown, spec } = buildConfigExport(withFp(), { presetName: evil, presetStatus: 'changed\nX' });
  assert.equal(spec.name, 'Ashby process.exit(7) // x');
  assert.equal(markdown.split('\n')[0], '# Конфіг браузера «Ashby process.exit(7) // x» — специфікація для відтворення');
  assert.equal(nodeCheck(clientOf(markdown)).status, 0);
  assert.equal(/^process\.exit/m.test(clientOf(markdown)), false);
  assert.equal(cleanName('  a\r\n\tb  '), 'a b');
});

test('назва файлу: українські літери цілі, без пресета — custom, локальна дата', () => {
  const d = new Date(2026, 9, 6, 23, 30); // пізно ввечері за місцевим часом
  assert.equal(exportFilename('Мій пресет', d), 'stealth-config-мій-пресет-2026-10-06.md');
  assert.equal(exportFilename('Їжак', d), 'stealth-config-їжак-2026-10-06.md');
  assert.equal(exportFilename('Йорданія', d), 'stealth-config-йорданія-2026-10-06.md');
  assert.equal(buildConfigExport(withFp(), { now: d }).filename, 'stealth-config-custom-2026-10-06.md');
  assert.match(buildConfigExport(withFp(), { now: d }).markdown, /^# Конфіг браузера «кастом»/);
});

test('UI: кнопка 📤 вимикається на час застосування (і клавіатурою не спрацьовує)', () => {
  const src = fs.readFileSync(new URL('../public/js/config.js', import.meta.url), 'utf8');
  assert.match(src, /if \(exportBtn\) exportBtn\.disabled = busy;/);
  assert.match(src, /function exportConfig\(\) \{\n  if \(!cfgState \|\| busy\) return;/);
});

test('buildClient: Chromium без плагіна — без EVASIONS і без playwright-extra', () => {
  const spec = buildSpec(bareProfile(), {});
  const src = buildClient(spec, stealthScript(null, {}));
  assert.equal(/EVASIONS|playwright-extra/.test(src), false);
  assert.match(src, /await import\('playwright'\)/);
});
