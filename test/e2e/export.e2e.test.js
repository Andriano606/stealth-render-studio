// E2E (opt-in, E2E=1): кнопка 📤 Експорт у футері конфігуратора у справжньому Chrome (headless).
// Застосунок — createApp у процесі з ФЕЙКОВОЮ БД у памʼяті (лише пресети) і фейковим рушієм
// (браузер для рендеру не потрібен; GET /profile/export рушій не чіпає). Профіль — у tmp.
// Справжню БД і робочий сервер на :3000 НЕ чіпаємо.
// Перевіряємо: клік 📤 → завантаження .md (назва stealth-config-<слаг пресета>-<дата>.md),
// заголовок документа з назвою активного пресета, розділи JSON / init-скрипт / client.mjs,
// cookies (значення й localStorage) НЕ потрапляють у файл; тост «завантажується»;
// незастосовані зміни → файл усе одно з ЗАСТОСОВАНОГО конфігу + тост-попередження;
// режим «кастом» (профіль не збігається з жодним пресетом) → stealth-config-custom-….md, заголовок «кастом»;
// 390 px — кнопка видима в межах екрана.
// SHOTS_DIR=<тека> — зберегти скріни. Запуск: E2E=1 node --test test/e2e/export.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../../lib/app.js';
import { loadConfig } from '../../lib/config.js';
import { createSemaphore } from '../../lib/semaphore.js';
import { createProfileStore, applyProfilePatch } from '../../lib/profile.js';
import { createSessionStore } from '../../lib/session.js';

const E2E = process.env.E2E === '1';
const SHOTS = process.env.SHOTS_DIR || '';
const quiet = { log() {}, error() {}, warn() {} };
const clone = (v) => JSON.parse(JSON.stringify(v));

const SECRET = 'SECRET-cookie-value-7f3a9c';
const LS_SECRET = 'SECRET-localStorage-token-51b2';
const FP = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  locale: 'uk-UA', languages: ['uk-UA', 'en-US'], timezoneId: 'Europe/Kyiv', platform: 'MacIntel', vendor: 'Google Inc.',
  hardwareConcurrency: 8, deviceMemory: 8, deviceScaleFactor: 2, screen: { width: 1512, height: 982, colorDepth: 30 },
};
const PRESET = 'Ashby 2';
const SEED = [
  { id: 1, name: '🧹 Clear all', builtin: true, body: { clear: true } },
  { id: 3, name: PRESET, builtin: false, body: {
    launch: { engine: 'chromium', headless: true, newHeadless: true, automationControlled: true, realGpu: false, siteIsolationDisabled: true, stealthPlugin: true, persistent: false },
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true },
    behavior: { humanize: true, prepareScroll: true },
  } },
];

function fakeDb() {
  let rows = clone(SEED);
  return {
    pages: { async list() { return []; }, async upsert() {}, async remove() {} },
    recordings: { async list() { return []; }, async upsert() {}, async remove() {} },
    presets: {
      async list() { return clone(rows); },
      async create({ name, body }) { const id = Math.max(0, ...rows.map((r) => r.id)) + 1; rows.push({ id, name, body: clone(body || {}), builtin: false }); return id; },
      async update() { return true; },
      async remove(id) { const n = rows.length; rows = rows.filter((r) => r.id !== id); return rows.length < n; },
    },
  };
}

// Фейковий рушій: профіль не застосовується (зміни лише в store), браузер не запускається.
function fakeEngine() {
  return {
    engineReady: () => true,
    async takeUnit() { throw new Error('рендер не потрібен у цьому e2e'); },
    async closeUnit() {},
    async drainPool() {},
    async relaunchBrowser() {},
    poolStats: () => ({ ready: 1, size: 1 }),
    browserVersion: () => ({ kind: 'chromium', version: '140.0.1.2' }),
    async close() {},
  };
}

let tmp, store, sessions, srv, base, uiBrowser;

before(async () => {
  if (!E2E) return;
  const root = process.env.UI_TMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  tmp = fs.mkdtempSync(path.join(root, 'srs-export-e2e-'));
  const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  store.set(applyProfilePatch(store.get(), {
    launch: SEED[1].body.launch, stealth: SEED[1].body.stealth, behavior: SEED[1].body.behavior, fingerprint: FP,
    storageState: {
      cookies: [{ name: 'sid', value: SECRET, domain: '.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [{ origin: 'https://example.test', localStorage: [{ name: 'token', value: LS_SECRET }] }],
    },
  }).profile);
  store.save();
  sessions = createSessionStore({ log: quiet });
  const app = createApp({ config, engine: fakeEngine(), sem: createSemaphore(4), profileStore: store, sessions, getDb: () => fakeDb(), log: quiet });
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + srv.address().port;
  assert.notEqual(srv.address().port, 3000);
  const { chromium } = await import('playwright');
  uiBrowser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (!E2E) return;
  if (uiBrowser) await uiBrowser.close();
  if (sessions) await sessions.closeAll('end');
  if (srv) srv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function openConfigurator(viewport = { width: 1440, height: 900 }) {
  const mobile = viewport.width < 600;
  const ctx = await uiBrowser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + '/');
  await page.waitForFunction(() => !/…/.test(document.getElementById('hdrConfigChip').textContent));
  await page.click('#hdrConfigChip');
  await page.locator('#cfgDialog .nav-item').first().waitFor();
  return { ctx, page, errors };
}

// Клік 📤 → { name, text } завантаженого файлу.
async function clickExport(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cfgExport')]);
  const file = path.join(tmp, 'dl-' + Date.now() + '.md');
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(file, 'utf8') };
}
// Локальна дата (як exportFilename).
const today = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

test('e2e 📤 Експорт: .md з назвою/заголовком пресета, розділи, без секретів cookies; тост', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openConfigurator();
  try {
    const btn = page.locator('#cfgExport');
    assert.ok(await btn.isVisible());
    assert.match(await btn.getAttribute('title'), /Markdown/);
    const d0 = today();
    const { name, text } = await clickExport(page);
    assert.ok([d0, today()].some((d) => name === 'stealth-config-ashby-2-' + d + '.md'), 'назва файлу: ' + name);
    assert.ok(text.startsWith('# Конфіг браузера «' + PRESET + '» — специфікація для відтворення\n'), text.slice(0, 120));
    for (const h of ['## Коротко', '## Специфікація (JSON)', '## Init-скрипт (дослівно)', '## Готовий клієнт', '## Чого в експорті немає']) {
      assert.ok(text.includes('\n' + h), 'розділ ' + h);
    }
    assert.match(text, /const INIT_SCRIPT = /);
    assert.match(text, /`chrome@140\.0\.1\.2`/, 'версія браузера з рушія');
    // Секрети: ні значення cookie, ні localStorage; лише кількість і домен.
    assert.equal(text.includes(SECRET), false, 'значення cookie не експортується');
    assert.equal(text.includes(LS_SECRET), false, 'localStorage не експортується');
    assert.equal(/"storageState"/.test(text), false);
    assert.match(text, /1 шт\. — \*\*не експортовано\*\* \(домени: \.example\.test\)/);
    assert.doesNotMatch(text, /відрізняється від пресета/, 'профіль = пресет → без попередження');
    // JSON-специфікація парситься.
    const json = JSON.parse(text.split('## Специфікація (JSON)')[1].split('```json\n')[1].split('\n```')[0]);
    assert.equal(json.name, PRESET);
    assert.equal(json.presetStatus, 'preset');
    assert.equal(json.engine, 'chromium');
    assert.equal(json.cookies.exported, false);
    await page.locator('.toast.toast-ok', { hasText: /Експорт конфігу «Ashby 2» завантажується/ }).waitFor();
    await shot(page, 'e2e-export-desk');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e 📤 Експорт із незастосованими змінами: файл — застосований конфіг, тост-попередження', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openConfigurator();
  try {
    const cfg = page.locator('#cfgDialog');
    await cfg.getByRole('tab', { name: /Stealth/ }).click();
    await cfg.locator('input[data-p="stealth.webdriver"]').click(); // draft: webdriver=false (не застосовано)
    assert.equal(await page.locator('#cfgSave').isDisabled(), false, 'є незастосовані зміни');
    const { text } = await clickExport(page);
    const json = JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
    assert.equal(json.stealth.webdriver, true, 'у файлі — ЗАСТОСОВАНИЙ стан, не draft');
    await page.locator('.toast.toast-warn', { hasText: /Незастосовані зміни в експорт не потрапили/ }).waitFor();
    assert.equal(store.get().stealth.webdriver, true, 'експорт не змінює профіль');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e 📤 Експорт «кастом» (профіль ≠ жодного пресета) і 390 px', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const saved = store.get();
  store.set(applyProfilePatch(saved, { behavior: { humanize: false } }).profile); // вже не Ashby 2
  const { ctx, page, errors } = await openConfigurator({ width: 390, height: 844 });
  try {
    const box = await page.locator('#cfgExport').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, 'кнопка в межах екрана: ' + JSON.stringify(box));
    const d0 = today();
    const { name, text } = await clickExport(page);
    // Назва без пресета: файл — «custom» (заголовок документа — «кастом»).
    assert.ok([d0, today()].some((d) => name === 'stealth-config-custom-' + d + '.md'), 'назва файлу: ' + name);
    assert.ok(text.startsWith('# Конфіг браузера «кастом» — специфікація для відтворення\n'));
    assert.match(text, /\| Людська поведінка застосунку \(`behavior\.humanize`\) \| — ні \|/);
    await shot(page, 'e2e-export-mob');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); store.set(saved); }
});
