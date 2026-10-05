// E2E (opt-in, E2E=1): оболонка UI (F3) у справжньому Chrome — розкладка 1440 і 390 px,
// без горизонтальної прокрутки, health-бейдж «лише в памʼяті», таби скрінів (blob:-URL,
// «Сценарій · …», статус-крапка, ліміт 12), фільтри логу, конфігуратор (футер, Esc-охорона,
// на весь екран на мобільному), нижня навігація панелей.
// Застосунок — createApp у процесі (БД немає, profile/uploads — у tmp); сценарій відкриває
// локальну фікстуру. UI_BASE=http://localhost:<порт> — проти вже запущеного ТЕСТОВОГО сервера
// (не 3000!). SHOTS_DIR=<тека> — зберегти скріни. Запуск: E2E=1 node --test test/e2e/shell.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from '../../lib/app.js';
import { loadConfig } from '../../lib/config.js';
import { createSemaphore } from '../../lib/semaphore.js';
import { createProfileStore, applyProfilePatch } from '../../lib/profile.js';
import { createEngine } from '../../lib/engine.js';
import { createSessionStore } from '../../lib/session.js';

const E2E = process.env.E2E === '1';
const EXTERNAL = process.env.UI_BASE || '';
const SHOTS = process.env.SHOTS_DIR || '';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const quiet = { log() {}, error() {} };
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let fsrv, FX, tmp, engine, sessions, srv, base, uiBrowser;

before(async () => {
  if (!E2E) return;
  fsrv = http.createServer((req, res) => {
    const f = path.join(FIX, path.basename(new URL(req.url, 'http://x').pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => fsrv.listen(0, '127.0.0.1', r));
  FX = 'http://127.0.0.1:' + fsrv.address().port;
  const { chromium } = await import('playwright');
  if (EXTERNAL) {
    if (/:3000\b/.test(EXTERNAL)) throw new Error('UI_BASE не може бути робочим сервером на :3000');
    base = EXTERNAL.replace(/\/$/, '');
  } else {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-shell-e2e-'));
    const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
    const store = createProfileStore(config.PROFILE_FILE, { log: quiet });
    store.load();
    store.set(applyProfilePatch(store.get(), { launch: { stealthPlugin: false, realGpu: false }, behavior: { humanize: false } }).profile);
    engine = createEngine({
      getProfile: () => store.get(), poolSize: 1, log: quiet,
      launchers: { chromium: () => chromium.launch({ channel: 'chrome', headless: true }), camoufox: () => { throw new Error('camoufox не використовується в e2e'); } },
    });
    sessions = createSessionStore({ log: quiet });
    const app = createApp({ config, engine, sem: createSemaphore(4), profileStore: store, sessions, log: quiet });
    srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = 'http://127.0.0.1:' + srv.address().port;
  }
  uiBrowser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (!E2E) return;
  if (uiBrowser) await uiBrowser.close();
  if (sessions) await sessions.closeAll('end');
  if (srv) srv.close();
  if (fsrv) fsrv.close();
  if (engine) await engine.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function openUi(viewport) {
  const mobile = viewport.width < 600;
  const ctx = await uiBrowser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + '/');
  await page.locator('#pagesEl .none, #pagesEl .page').first().waitFor({ state: 'attached' });
  await page.waitForFunction(() => !/…/.test(document.getElementById('hdrConfigChip').textContent));
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const hScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function createAndRun(page, name, url) {
  await page.click('#newPageBtn');
  const dlg = page.locator('#dialogs dialog');
  await dlg.waitFor();
  await dlg.getByLabel('Стартовий URL').fill(url);
  await dlg.getByLabel('Назва').fill(name);
  await dlg.getByRole('button', { name: 'Створити' }).click();
  await dlg.waitFor({ state: 'detached' });
  const card = page.locator('.page', { hasText: name });
  await card.getByRole('button', { name: /Запустити послідовність/ }).click();
  await page.waitForFunction((n) => !document.querySelector('.page.page-run')
    && [...document.querySelectorAll('#tabs .tab')].some((t) => t.textContent.includes(n)), name, { timeout: 120000 });
}

test('e2e оболонка 1440: health, таби (blob, підпис, статус, ліміт), зум, фільтри логу, футер конфігуратора', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 1440, height: 900 });
  try {
    assert.equal(await page.title(), 'Stealth Render Studio');
    assert.equal(await page.locator('#paneNav').isVisible(), false, 'нижня навігація лише < 900 px');
    for (const id of ['#paneScenarios', '#viewer', '#consoleBody']) assert.ok(await page.locator(id).isVisible(), id);
    if (!EXTERNAL) {
      await page.locator('#hdrHealth .hbadge').first().waitFor();
      assert.match(await page.locator('#hdrHealth').innerText(), /лише в памʼяті/);
    }

    await createAndRun(page, 'Shell desk', FX + '/click.html');
    const src = await page.locator('#resultView img.shot').getAttribute('src');
    assert.ok(src.startsWith('blob:'), 'скрін — blob:-URL, а не мегабайтний data:-URL: ' + src.slice(0, 20));
    const tab = page.locator('#tabs .tab', { hasText: 'Shell desk' });
    assert.match(await tab.innerText(), /Shell desk · лише URL/);
    assert.equal(await tab.locator('.sdot').count(), 1);
    assert.ok(await page.locator('#consoleBody details.run').count() >= 1, 'група прогону в лозі');
    await shot(page, 'e2e-desk-result');

    // Зум: кнопка і клік по скріну.
    await page.click('#shotZoom');
    assert.equal(await page.locator('#resultView img.shot.full').count(), 1);
    await page.click('#resultView img.shot');
    assert.equal(await page.locator('#resultView img.shot.full').count(), 0);

    // Фільтр «Навігація» ховає nav-рядки; копіювання не падає.
    const visible = () => page.locator('#consoleBody .ln:visible').count();
    const before = await visible();
    await page.locator('#consoleFilters .lchip.g-nav').click();
    assert.ok(await visible() < before);
    await page.locator('#consoleFilters .lchip.g-nav').click();
    assert.equal(await visible(), before);

    // Конфігуратор: «Застосувати» неактивна без змін; зміна → «●» на категорії; Esc → охорона.
    await page.click('#hdrConfigChip');
    const cfg = page.locator('#cfgDialog');
    await cfg.locator('.nav-item').first().waitFor();
    assert.equal(await page.locator('#cfgSave').isDisabled(), true);
    await cfg.getByRole('tab', { name: /Поведінка/ }).click();
    await cfg.locator('input[data-p="behavior.fastPrefix"]').click();
    assert.equal(await cfg.locator('.nav-item.changed').count(), 1);
    assert.equal(await page.locator('#cfgSave').isDisabled(), false);
    await cfg.locator('.nav-item[aria-selected="true"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.match(await cfg.locator('.nav-item[aria-selected="true"]').innerText(), /Fingerprint/);
    await shot(page, 'e2e-desk-config');
    await page.keyboard.press('Escape');
    const guard = page.locator('#dialogs dialog');
    await guard.waitFor();
    await guard.getByRole('button', { name: /Закрити без збереження/ }).click();
    await page.waitForFunction(() => !document.getElementById('cfgDialog').open);

    // Ліміт табів: ще 13 скрінів → рівно 12, є «червоні».
    await page.evaluate(async (px) => {
      const v = await import('/js/viewer.js');
      for (let i = 0; i < 13; i++) {
        v.addScreen('🎬 T' + i, px, 'http://x/' + i, { ok: i % 3 !== 0, scenario: 'T', upto: i % 3, total: 2 });
        await new Promise((r) => setTimeout(r, 30));
      }
    }, PX);
    assert.equal(await page.locator('#tabs .tab').count(), 12);
    assert.ok(await page.locator('#tabs .tab.st-failed').count() > 0);
    assert.equal(await hScroll(page), 0, 'без горизонтальної прокрутки сторінки (таби прокручуються всередині)');
    await shot(page, 'e2e-desk-tabs');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e оболонка 390: панелі «Сценарії | Перегляд | Логи», 100dvh, без горизонтальної прокрутки, конфігуратор на весь екран', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 390, height: 844 });
  try {
    assert.equal(await hScroll(page), 0);
    assert.ok(await page.locator('#paneNav').isVisible());
    const nav = await page.locator('#paneNav').boundingBox();
    assert.ok(Math.abs(nav.y + nav.height - 844) <= 1, 'навігація притиснута донизу: ' + JSON.stringify(nav));
    assert.ok((await page.locator('#paneNav button').first().boundingBox()).height >= 40, 'touch target ≥ 40 px');
    // Видно рівно одну панель.
    const vis = async () => Promise.all(['#paneScenarios', '#paneViewer', '#console'].map((s) => page.locator(s).isVisible()));
    await page.locator('#paneNav [data-pane="scenarios"]').click();
    assert.deepEqual(await vis(), [true, false, false]);
    await shot(page, 'e2e-mob-scenarios');

    await createAndRun(page, 'Shell mob', FX + '/click.html');
    assert.equal(await page.locator('#paneNav [data-pane="viewer"] .nav-badge:not([hidden])').count(), 1, 'бейдж «новий скрін»');
    await page.locator('#paneNav [data-pane="viewer"]').click();
    assert.deepEqual(await vis(), [false, true, false]);
    assert.equal(await page.locator('#paneNav [data-pane="viewer"] .nav-badge:not([hidden])').count(), 0, 'бейдж знято');
    await page.waitForFunction(() => { const i = document.querySelector('#resultView img.shot'); return i && i.complete && i.naturalWidth > 0; });
    assert.equal(await hScroll(page), 0);
    await shot(page, 'e2e-mob-viewer');

    // Стрілки по навігації панелей.
    await page.locator('#paneNav [data-pane="viewer"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await vis(), [false, false, true]);
    assert.equal(await hScroll(page), 0);
    await shot(page, 'e2e-mob-logs');

    // emit('ui:pane') з інших модулів.
    await page.evaluate(async () => { const s = await import('/js/state.js'); s.emit('ui:pane', 'scenarios'); });
    assert.deepEqual(await vis(), [true, false, false]);

    await page.click('#cfgBtn');
    await page.locator('#cfgDialog .nav-item').first().waitFor();
    const box = await page.locator('#cfgDialog').boundingBox();
    assert.ok(box.x === 0 && box.width === 390 && Math.round(box.height) === 844, JSON.stringify(box));
    await page.getByRole('tab', { name: /Fingerprint/ }).click();
    assert.equal(await hScroll(page), 0);
    await shot(page, 'e2e-mob-config');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('cfgDialog').open);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
