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
  assert.match(clientOf(buildConfigExport(variants.plugin, {}).markdown), /from 'playwright-extra'/);
  assert.match(clientOf(buildConfigExport(variants.plain, {}).markdown), /from 'playwright'/);
  const cfx = buildConfigExport(variants.camoufox, {}).markdown;
  assert.match(clientOf(cfx), /from 'camoufox-js'/);
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
  const { markdown, filename } = buildConfigExport(withFp(), { presetName: 'Ashby 2', presetStatus: 'changed', now: new Date('2026-10-06T10:00:00Z') });
  assert.match(markdown, /відрізняється від пресета «Ashby 2»/);
  assert.equal(filename, 'stealth-config-ashby-2-2026-10-06.md');
  assert.equal(exportFilename('☁️ Cloudflare', new Date('2026-01-02T00:00:00Z')), 'stealth-config-cloudflare-2026-01-02.md');
  assert.equal(exportFilename('', new Date('2026-01-02T00:00:00Z')), 'stealth-config-custom-2026-01-02.md');
});
