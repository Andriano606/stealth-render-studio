// E2E (opt-in): справжній Chrome (playwright, channel:'chrome', headless) + локальна
// фікстура. Запуск: npm run test:e2e  (без E2E=1 — пропускаються, щоб npm test був швидким).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { replayActions } from '../../lib/replay.js';
import { gotoSmart } from '../../lib/nav.js';
import { createEngine, defaultLaunchers } from '../../lib/engine.js';
import { defaultProfile, applyProfilePatch } from '../../lib/profile.js';

const E2E = process.env.E2E === '1';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const quiet = { log() {}, error() {} };

let server, base, browser;
before(async () => {
  if (!E2E) return;
  server = http.createServer((req, res) => {
    const f = path.join(FIX, path.basename(new URL(req.url, 'http://x').pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

test('e2e: gotoSmart на локальній сторінці — без челенджу', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const page = await (await browser.newContext()).newPage();
  const { resp, cf } = await gotoSmart(page, base + '/click.html');
  assert.equal(resp.status(), 200);
  assert.deepEqual(cf, { passed: true, wasChallenge: false });
  await page.context().close();
});

test('e2e: replayActions — координатні кліки (у т.ч. нижче згину) і текст', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + '/click.html');
  const actions = [
    { type: 'click', x: 200, y: 175, gid: 1 },   // #top
    { type: 'click', x: 250, y: 315, gid: 1 },   // #name
    { type: 'text', text: 'Ok', gid: 1 },
    { type: 'click', x: 200, y: 2425, gid: 1 },  // #low — потрібен скрол
  ];
  const events = [];
  const replayed = await replayActions(page, actions, { send: (e) => events.push(e), humanize: false, resolveUpload: () => null });
  assert.equal(replayed, 4);
  assert.deepEqual(events.filter((e) => e.event === 'done-action').map((e) => e.ok), [true, true, true, true]);
  assert.deepEqual(await page.evaluate(() => window.clicks), ['top', 'low']);
  assert.equal(await page.inputValue('#name'), 'Ok');
  await ctx.close();
});

test('e2e: createEngine зі справжнім Chrome — пул, stealth init-скрипт, relaunch', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  // Без stealth-плагіна (його require дуже повільний) і без GPU-прапорців.
  let profile = applyProfilePatch(defaultProfile(), {
    launch: { stealthPlugin: false, realGpu: false },
    fingerprint: { userAgent: 'E2E-UA Chrome/999.0', locale: 'uk' },
  }).profile;
  const engine = createEngine({
    getProfile: () => profile,
    launchers: defaultLaunchers({ getStealthChromium: () => { throw new Error('не має викликатись'); } }),
    poolSize: 1, log: quiet,
  });
  try {
    await Promise.all([engine.ensureEngine(), engine.ensureEngine()]);
    await engine.refillPool();
    const u = await engine.takeUnit();
    assert.equal(u.fromPool, true);
    await u.page.goto(base + '/click.html');
    const nav = await u.page.evaluate(() => ({ wd: navigator.webdriver, own: Object.getOwnPropertyNames(navigator).includes('webdriver'), ua: navigator.userAgent, pw: typeof window.__pwInitScripts }));
    assert.deepEqual(nav, { wd: false, own: false, ua: 'E2E-UA Chrome/999.0', pw: 'undefined' });
    await engine.closeUnit(u);
    // relaunch на старий headless — нові юніти працюють
    profile = applyProfilePatch(profile, { launch: { newHeadless: false } }).profile;
    await engine.relaunchBrowser();
    assert.equal(engine.engineReady(), true);
    const u2 = await engine.takeUnit();
    await u2.page.goto(base + '/click.html');
    assert.equal(await u2.page.title(), 'Фікстура кліків');
    await engine.closeUnit(u2);
  } finally {
    await engine.close();
  }
});
