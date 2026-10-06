// E2E (opt-in, E2E=1): видалення й перейменування пресетів у конфігураторі у справжньому Chrome (headless).
// Застосунок — createApp у процесі з ФЕЙКОВОЮ БД у памʼяті (presets/pages/recordings) і
// фейковим рушієм (браузер для рендеру не потрібен). Профіль — у tmp (TMPDIR / UI_TMP).
// Справжню БД і робочий сервер на :3000 НЕ чіпаємо.
// Засів: 4 пресети; «🧬 Мій FP» збігається з профілем, але ключі його fingerprint (і launch/
// stealth) в іншому порядку (як після Postgres JSONB) — має бути активним, НЕ «● змінено».
// Перевіряємо: ✕ з aria-label «Видалити пресет «…»», підтвердження (Скасувати / Esc / Видалити),
// DELETE без зміни профілю (жодного POST /profile, рушій не чіпали, profile.json той самий),
// видалення активного → «· кастом», 404 (уже видалено) — без помилки, кнопки неактивні під час
// застосування, 390 px: рядок пресетів гортається горизонтально без переповнення сторінки,
// ✕ ≥ 40 px на coarse-вказівнику; кнопки «Скинути до голого Playwright» (cfgReset) більше немає.
// Фокус після видалення — на ✕ сусіднього пресета (не губиться в <body>). Видалення активного
// «🧹 Clear all» не вмикає мовчки автозахоплення fingerprint після перезавантаження (noAutoFp).
// Перейменування (✎): діалог із поточною назвою, PUT /presets/:id {name} (обрізана/стиснута),
// профіль не чіпаємо; активний пресет лишається активним (чип — нова назва, не «змінено»);
// валідація (порожня / задовга / дубль), та сама назва / Esc / Скасувати — без запиту, фокус на ✎;
// 404 → алерт; лише клавіатура (Tab → ✎ → Enter → текст → Enter); 390 px: [чип][✎][✕] в одну лінію.
// Focus-ring кнопок групи не перекривається сусідньою кнопкою (піксельна перевірка скріна).
// SHOTS_DIR=<тека> — зберегти скріни. Запуск: E2E=1 node --test test/e2e/presets.e2e.test.js
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

// Fingerprint профілю і той самий fingerprint з іншим порядком ключів (у т.ч. вкладених).
const FP = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  locale: 'uk-UA', languages: ['uk-UA', 'en-US'], timezoneId: 'Europe/Kyiv', platform: 'MacIntel', vendor: 'Google Inc.',
  hardwareConcurrency: 8, deviceMemory: 8, deviceScaleFactor: 2, screen: { width: 1512, height: 982, colorDepth: 30 },
};
const FP_REORDERED = {
  screen: { colorDepth: 30, height: 982, width: 1512 }, deviceScaleFactor: 2, deviceMemory: 8, hardwareConcurrency: 8,
  vendor: 'Google Inc.', platform: 'MacIntel', timezoneId: 'Europe/Kyiv', languages: ['uk-UA', 'en-US'], locale: 'uk-UA',
  userAgent: FP.userAgent,
};
assert.notEqual(JSON.stringify(FP), JSON.stringify(FP_REORDERED)); // справді інший порядок

const MY = '🧬 Мій FP', CF = '☁️ Cloudflare', ASHBY = '📋 Ashby', CLEAR = '🧹 Clear all';
const SEED = [
  { id: 1, name: CLEAR, builtin: true, body: { clear: true } },
  { id: 2, name: CF, builtin: true, body: { launch: { engine: 'camoufox', camoufoxHumanize: false, camoufoxGeoip: false } } },
  { id: 3, name: ASHBY, builtin: true, body: {
    launch: { engine: 'chromium', headless: true, newHeadless: true, automationControlled: true, realGpu: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false },
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true },
    behavior: { humanize: true, prepareScroll: true },
  } },
  { id: 7, name: MY, builtin: false, body: {
    stealth: { pwInitScripts: true, permissions: true, outerWindow: true, windowChrome: true, webdriver: true },
    launch: { stealthPlugin: false, realGpu: false, engine: 'chromium' },
    fingerprint: FP_REORDERED,
    behavior: { humanize: false },
  } },
];

// Фейкова БД (той самий контракт, що lib/db.js createRepos): presets.update / presets.remove → bool.
function fakeDb() {
  let rows = [];
  const calls = [];
  const db = {
    calls,
    reset() { rows = clone(SEED); calls.length = 0; },
    names: () => rows.map((r) => r.name),
    drop(id) { rows = rows.filter((r) => r.id !== id); }, // «видалено в іншій вкладці»
    pages: { async list() { return []; }, async upsert() {}, async remove() {} },
    recordings: { async list() { return []; }, async upsert() {}, async remove() {} },
    presets: {
      async list() { return clone(rows); },
      async create({ name, body }) { const id = Math.max(0, ...rows.map((r) => r.id)) + 1; rows.push({ id, name, body: clone(body || {}), builtin: false }); calls.push(['create', id]); return id; },
      async update(id, { name, body }) {
        const r = rows.find((x) => x.id === id);
        calls.push(['update', id]);
        if (!r) return false;
        if (name != null) r.name = name;
        if (body !== undefined) r.body = clone(body);
        return true;
      },
      async remove(id) { calls.push(['remove', id]); const n = rows.length; rows = rows.filter((r) => r.id !== id); return rows.length < n; },
    },
  };
  db.reset();
  return db;
}

// Фейковий рушій: фіксує drain/relaunch — так видно, що профіль не застосовувався.
function fakeEngine() {
  const e = {
    calls: [],
    engineReady: () => true,
    async takeUnit() { throw new Error('рендер не потрібен у цьому e2e'); },
    async closeUnit() {},
    async drainPool() { e.calls.push('drain'); },
    async relaunchBrowser() { e.calls.push('relaunch'); },
    poolStats: () => ({ ready: 1, size: 1 }),
    async close() {},
  };
  return e;
}

let tmp, db, engine, store, sessions, srv, base, uiBrowser, profileFile;

before(async () => {
  if (!E2E) return;
  const root = process.env.UI_TMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  tmp = fs.mkdtempSync(path.join(root, 'srs-presets-e2e-'));
  profileFile = path.join(tmp, 'profile.json');
  const config = loadConfig({ PROFILE_FILE: profileFile, UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  store.set(applyProfilePatch(store.get(), { launch: { stealthPlugin: false, realGpu: false }, behavior: { humanize: false }, fingerprint: FP }).profile);
  store.save();
  db = fakeDb();
  engine = fakeEngine();
  sessions = createSessionStore({ log: quiet });
  const app = createApp({ config, engine, sem: createSemaphore(4), profileStore: store, sessions, getDb: () => db, log: quiet });
  const port = Number(process.env.UI_PORT) || 0;
  if (port === 3000) throw new Error('UI_PORT не може бути 3000 (робочий сервер)');
  srv = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
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

// Новий контекст (чистий localStorage). activeId → запамʼятований активний пресет.
// human → «не автоматизований» браузер (UA без Headless, navigator.webdriver=false), щоб
// syncFingerprint справді міг автозахопити fingerprint (інакше isAutomatedBrowser блокує).
async function openUi({ viewport = { width: 1280, height: 900 }, activeId = null, human = false } = {}) {
  const mobile = viewport.width < 600;
  const ctx = await uiBrowser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, ...(human ? { userAgent: FP.userAgent } : {}) });
  if (human) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); });
  if (activeId != null) await ctx.addInitScript((id) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('activePresetId', String(id)); sessionStorage.setItem('__seeded', '1'); } }, activeId);
  const page = await ctx.newPage();
  const errors = [], reqs = [], puts = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== base) return;
    reqs.push(r.method() + ' ' + u.pathname);
    if (r.method() === 'PUT') puts.push({ path: u.pathname, body: JSON.parse(r.postData() || 'null') });
  });
  await page.goto(base + '/');
  await page.waitForFunction(() => !/…|—/.test(document.getElementById('hdrConfigChip').textContent));
  return { ctx, page, errors, reqs, puts };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
const groups = (page) => page.locator('#cfgPresets .pre-group');
const delBtn = (page, name) => page.getByRole('button', { name: 'Видалити пресет «' + name + '»', exact: true });
const renBtn = (page, name) => page.getByRole('button', { name: 'Перейменувати пресет «' + name + '»', exact: true });
const confirmDlg = (page) => page.locator('#dialogs dialog');
const chipText = (page) => page.locator('#hdrConfigChip').innerText();
async function openCfg(page, via = '#hdrConfigChip') {
  await page.click(via);
  await page.locator('#cfgDialog .nav-item').first().waitFor();
  await groups(page).first().waitFor();
}
async function waitGroups(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll('#cfgPresets .pre-group').length === k, n, { timeout: 10000 });
}
const presetNames = (page) => page.locator('#cfgPresets .pre-group .pre-btn').evaluateAll((els) => els.map((e) => e.textContent));
const profileBytes = () => fs.readFileSync(profileFile, 'utf8');
const focusedLabel = (page) => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));

test('e2e пресети: ✕ на кожному, Скасувати/Esc лишають, Видалити прибирає неактивний і активний (→ кастом), профіль не змінюється', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, reqs } = await openUi({ activeId: 7 });
  try {
    // Порядок ключів fingerprint інший, але пресет — активний, без «● змінено».
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.match(await chipText(page), new RegExp(MY));
    assert.doesNotMatch(await chipText(page), /змінено|●/);

    await openCfg(page);
    assert.equal(await groups(page).count(), 4);
    assert.deepEqual(await presetNames(page), [CLEAR, CF, ASHBY, MY]);
    for (const name of [CLEAR, CF, ASHBY, MY]) {
      const b = delBtn(page, name);
      assert.equal(await b.count(), 1, '✕ для ' + name);
      assert.equal(await b.innerText(), '✕');
      assert.equal(await b.getAttribute('type'), 'button');
      assert.equal(await b.isEnabled(), true);
    }
    // Активний — «Мій FP», не dirty.
    const active = page.locator('#cfgPresets .pre-group.active');
    assert.equal(await active.count(), 1);
    assert.equal(await active.locator('.pre-btn').innerText(), MY);
    assert.equal(await active.locator('.pre-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(await active.locator('.pre-btn.dirty').count(), 0);
    // Кнопки «Скинути до голого Playwright» більше немає.
    assert.equal(await page.locator('#cfgReset').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Скинути до голого/ }).count(), 0);
    await shot(page, 'presets-desktop');

    // ✕ → «Скасувати» → пресет лишається, DELETE не було.
    await delBtn(page, CF).click();
    let dlg = confirmDlg(page);
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Видалити пресет/);
    assert.match(await dlg.innerText(), /«☁️ Cloudflare» буде видалено назавжди/);
    assert.match(await dlg.innerText(), /Поточні налаштування браузера не зміняться/);
    await shot(page, 'presets-desktop-confirm');
    await dlg.getByRole('button', { name: 'Скасувати' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await groups(page).count(), 4);
    // ✕ → Esc → теж лишається; модалка конфігуратора не закривається.
    await delBtn(page, CF).click();
    dlg = confirmDlg(page);
    await dlg.waitFor();
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#cfgDialog').evaluate((d) => d.open), true);
    assert.equal(await groups(page).count(), 4);
    assert.ok(!reqs.some((r) => r.startsWith('DELETE ')), 'DELETE не надсилали: ' + reqs.join(', '));
    assert.deepEqual(db.calls, []);

    // ✕ → «Видалити» неактивний → зник, тост, DELETE, активний лишився.
    await delBtn(page, CF).click();
    dlg = confirmDlg(page);
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Видалити', exact: true }).click();
    await waitGroups(page, 3);
    assert.deepEqual(await presetNames(page), [CLEAR, ASHBY, MY]);
    await page.locator('#toasts .toast', { hasText: 'Пресет «☁️ Cloudflare» видалено.' }).waitFor();
    assert.ok(reqs.includes('DELETE /presets/2'), reqs.join(', '));
    assert.deepEqual(db.calls, [['remove', 2]]);
    assert.deepEqual(db.names(), [CLEAR, ASHBY, MY]);
    assert.equal(await page.locator('#cfgPresets .pre-group.active .pre-btn').innerText(), MY);
    assert.match(await chipText(page), new RegExp(MY));
    assert.match(await page.locator('#consoleBody').innerText(), /🗑 Пресет «☁️ Cloudflare» видалено\./);
    // Фокус не впав у <body>: ✕ наступного пресета.
    assert.equal(await focusedLabel(page), 'Видалити пресет «' + ASHBY + '»');

    // Видалення АКТИВНОГО (з клавіатури: фокус на ✕ + Enter) → «· кастом», профіль той самий.
    await delBtn(page, MY).focus();
    await page.keyboard.press('Enter');
    dlg = confirmDlg(page);
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Видалити', exact: true }).click();
    await waitGroups(page, 2);
    // Видалено останній → фокус на ✕ попереднього.
    assert.equal(await focusedLabel(page), 'Видалити пресет «' + ASHBY + '»');
    assert.equal(await page.evaluate(() => localStorage.getItem('noAutoFp')), null, 'пресет з fingerprint — заборону не ставимо');
    assert.deepEqual(await presetNames(page), [CLEAR, ASHBY]);
    assert.equal(await page.locator('#cfgPresets .pre-group.active').count(), 0);
    assert.equal(await page.locator('#cfgPresets .pre-btn[aria-pressed="true"]').count(), 0);
    await page.waitForFunction(() => document.getElementById('hdrConfigChip').dataset.mode === 'custom');
    assert.match(await chipText(page), /·\s*кастом/);
    assert.equal(await page.evaluate(() => localStorage.getItem('activePresetId')), null);
    assert.ok(reqs.includes('DELETE /presets/7'), reqs.join(', '));
    // Чернетка конфігуратора не «забруднилась» (нічого не застосовано / не змінено).
    assert.equal(await page.locator('#cfgSave').isDisabled(), true);
    assert.equal(await page.locator('#cfgDialog .nav-item.changed').count(), 0);
    await shot(page, 'presets-desktop-after-delete');

    // Профіль НЕ чіпали: жодного POST /profile, рушій не перезапускали, файл той самий.
    assert.ok(!reqs.some((r) => r === 'POST /profile'), 'POST /profile: ' + reqs.join(', '));
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    const prof = await page.evaluate(() => fetch('/profile').then((r) => r.json()));
    assert.deepEqual(prof.fingerprint, FP);

    // Закриття без питань (незастосованих змін немає), після reload — ті самі 2 пресети, кастом.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('cfgDialog').open);
    assert.equal(await confirmDlg(page).count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('hdrConfigChip').dataset.mode === 'custom');
    await openCfg(page);
    assert.deepEqual(await presetNames(page), [CLEAR, ASHBY]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети: без запамʼятованого id чип знаходить збіг (порядок ключів не важить); 404 — пресет уже видалено деінде', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const { ctx, page, errors, reqs } = await openUi();
  try {
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.match(await chipText(page), new RegExp(MY));
    assert.doesNotMatch(await chipText(page), /змінено/);
    await openCfg(page);
    // «Видалено в іншій вкладці»: сервер відповість 404 — UI просто оновлює список без помилки.
    db.drop(3);
    await delBtn(page, ASHBY).click();
    const dlg = confirmDlg(page);
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Видалити', exact: true }).click();
    await waitGroups(page, 3);
    assert.deepEqual(await presetNames(page), [CLEAR, CF, MY]);
    assert.ok(reqs.includes('DELETE /presets/3'));
    assert.equal(await focusedLabel(page), 'Видалити пресет «' + MY + '»', 'фокус на ✕ наступного (і при 404)');
    assert.equal(await page.locator('#cfgAlert').isVisible(), false, 'без червоного алерту');
    await page.locator('#toasts .toast', { hasText: 'Пресет «📋 Ashby» видалено.' }).waitFor();
    assert.ok(!reqs.includes('POST /profile'));
    assert.deepEqual(engine.calls, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети: під час застосування пресета ✕ і чипи неактивні, ✕ нічого не робить', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    // Тримаємо POST /profile у браузері (до сервера не доходить) — модалка «зайнята».
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/profile', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'тестова помилка' }) });
    });
    await page.locator('#cfgPresets .pre-btn', { hasText: ASHBY }).click();
    await page.waitForFunction(() => document.getElementById('cfgDialog').getAttribute('aria-busy') === 'true');
    const states = await page.locator('#cfgPresets .pre-del, #cfgPresets .pre-btn').evaluateAll((els) => els.map((e) => e.disabled));
    assert.equal(states.length, 8);
    assert.ok(states.every(Boolean), 'усі неактивні: ' + JSON.stringify(states));
    const renStates = await page.locator('#cfgPresets .pre-ren').evaluateAll((els) => els.map((e) => e.disabled));
    assert.deepEqual(renStates, [true, true, true, true], '✎ неактивні під час застосування');
    await delBtn(page, CF).click({ force: true });
    await renBtn(page, CF).click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(await confirmDlg(page).count(), 0, 'підтвердження / перейменування не відкрилось');
    assert.equal(await groups(page).count(), 4);
    release();
    await page.waitForFunction(() => document.getElementById('cfgDialog').getAttribute('aria-busy') === 'false');
    assert.match(await page.locator('#cfgAlert').innerText(), /тестова помилка/);
    const after = await page.locator('#cfgPresets .pre-del, #cfgPresets .pre-ren').evaluateAll((els) => els.map((e) => e.disabled));
    assert.deepEqual(after, Array(8).fill(false));
    assert.deepEqual(db.calls, []);
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    // Очікувана помилка 500 від перехопленого запиту — не помилка застосунку.
    assert.deepEqual(errors.filter((e) => !/500|тестова помилка/.test(e)), []);
  } finally { await ctx.close(); }
});

test('e2e пресети 390×844: рядок пресетів гортається без переповнення сторінки, ✕ ≥ 40 px (coarse), видалення тапом', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, reqs } = await openUi({ viewport: { width: 390, height: 844 }, activeId: 7 });
  try {
    await openCfg(page, '#cfgBtn');
    const box = await page.locator('#cfgDialog').boundingBox();
    assert.ok(box.x === 0 && box.width === 390, 'модалка на всю ширину: ' + JSON.stringify(box));
    const hScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(await hScroll(), 0);
    const row = await page.locator('#cfgPresets').evaluate((el) => ({
      sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX, wrap: getComputedStyle(el).flexWrap,
      right: el.getBoundingClientRect().right,
    }));
    assert.equal(row.ox, 'auto');
    assert.equal(row.wrap, 'nowrap');
    assert.ok(row.sw > row.cw, 'рядок пресетів ширший за екран і гортається: ' + JSON.stringify(row));
    assert.ok(row.right <= 390, JSON.stringify(row));
    // Групи не стискаються/не переносяться: [кнопка][✎][✕] впритул (однакова висота, одна лінія).
    const geo = await page.locator('#cfgPresets .pre-group').evaluateAll((gs) => gs.map((g) => {
      const b = g.querySelector('.pre-btn').getBoundingClientRect(), r = g.querySelector('.pre-ren').getBoundingClientRect(),
        d = g.querySelector('.pre-del').getBoundingClientRect();
      return { bTop: b.top, rTop: r.top, dTop: d.top, bH: b.height, rH: r.height, dH: d.height, rW: r.width, dW: d.width,
        gapBR: r.left - b.right, gapRD: d.left - r.right };
    }));
    assert.equal(geo.length, 4);
    for (const g of geo) {
      assert.ok(Math.abs(g.bTop - g.rTop) < 1 && Math.abs(g.bTop - g.dTop) < 1, 'кнопка, ✎ і ✕ на одній лінії: ' + JSON.stringify(g));
      assert.ok(Math.abs(g.bH - g.rH) < 1 && Math.abs(g.bH - g.dH) < 1, 'однакова висота: ' + JSON.stringify(g));
      assert.ok(Math.abs(g.gapBR) < 1 && Math.abs(g.gapRD) < 1, '✎ і ✕ впритул: ' + JSON.stringify(g));
    }
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    assert.equal(coarse, true, 'coarse-вказівник емульовано (hasTouch/isMobile)');
    for (const g of geo) assert.ok(g.dW >= 40 && g.rW >= 40, '✎ і ✕ ширина ≥ 40 px на coarse: ' + JSON.stringify(g));
    for (const g of geo) assert.ok(g.dH >= 36 && g.rH >= 36, '✎ і ✕ висота ≥ 36 px: ' + JSON.stringify(g));
    await shot(page, 'presets-mobile');

    // Останній ✕ видно після горизонтальної прокрутки рядка; сторінка не гортається.
    const last = delBtn(page, MY);
    await last.scrollIntoViewIfNeeded();
    const lb = await last.boundingBox();
    assert.ok(lb.x >= 0 && lb.x + lb.width <= 390, '✕ останнього пресета у межах екрана: ' + JSON.stringify(lb));
    assert.ok(await page.locator('#cfgPresets').evaluate((el) => el.scrollLeft) > 0);
    assert.equal(await hScroll(), 0);
    await shot(page, 'presets-mobile-scrolled');

    // Тап по ✕ активного → підтвердження в межах екрана → «Видалити» → кастом.
    await last.tap();
    const dlg = confirmDlg(page);
    await dlg.waitFor();
    const db0 = await dlg.boundingBox();
    assert.ok(db0.x >= 0 && db0.x + db0.width <= 390, JSON.stringify(db0));
    await shot(page, 'presets-mobile-confirm');
    await dlg.getByRole('button', { name: 'Видалити', exact: true }).tap();
    await waitGroups(page, 3);
    await page.waitForFunction(() => document.getElementById('hdrConfigChip').dataset.mode === 'custom');
    assert.equal(await hScroll(), 0);
    await shot(page, 'presets-mobile-after-delete');
    assert.ok(reqs.includes('DELETE /presets/7'));
    assert.ok(!reqs.includes('POST /profile'));
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    assert.equal(await page.locator('#cfgReset').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети: видалення активного «🧹 Clear all» не вмикає мовчки автозахоплення fingerprint після reload', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const saved = clone(store.get());
  const bare = () => { store.set(applyProfilePatch(store.get(), { clear: true }).profile); store.save(); };
  bare();
  try {
    // Контроль (тест не холостий): «людський» браузер, свіжий localStorage, профіль без fingerprint →
    // UI САМ захоплює fingerprint (POST /profile).
    {
      const { ctx, page, reqs } = await openUi({ human: true });
      try {
        await page.waitForFunction(() => /Fingerprint захоплено/.test(document.getElementById('consoleBody').textContent), null, { timeout: 10000 });
        assert.ok(reqs.includes('POST /profile'), reqs.join(', '));
      } finally { await ctx.close(); }
      bare();
    }
    const { ctx, page, errors, reqs } = await openUi({ human: true, activeId: 1 });
    try {
      assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
      assert.match(await chipText(page), new RegExp(CLEAR));
      await page.waitForTimeout(400);
      assert.ok(!reqs.includes('POST /profile'), 'Clear all активний — без захоплення: ' + reqs.join(', '));

      await openCfg(page);
      await delBtn(page, CLEAR).click();
      const dlg = confirmDlg(page);
      await dlg.waitFor();
      await dlg.getByRole('button', { name: 'Видалити', exact: true }).click();
      await waitGroups(page, 3);
      assert.equal(await focusedLabel(page), 'Видалити пресет «' + CF + '»');
      await page.waitForFunction(() => document.getElementById('hdrConfigChip').dataset.mode === 'custom');
      assert.equal(await page.evaluate(() => localStorage.getItem('activePresetId')), null);
      assert.equal(await page.evaluate(() => localStorage.getItem('noAutoFp')), '1');

      // Reload: пресета вже немає, але умови «без fingerprint» лишаються — жодного POST /profile.
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('cfgDialog').open);
      reqs.length = 0;
      await page.reload();
      await page.waitForFunction(() => document.getElementById('hdrConfigChip').dataset.mode === 'custom');
      await page.waitForTimeout(400);
      assert.ok(reqs.includes('GET /profile'), reqs.join(', '));
      assert.ok(!reqs.includes('POST /profile'), 'мовчазного захоплення немає: ' + reqs.join(', '));
      assert.doesNotMatch(await page.locator('#consoleBody').textContent(), /Fingerprint захоплено/);
      const prof = await page.evaluate(() => fetch('/profile').then((r) => r.json()));
      assert.equal(prof.fingerprint, null);

      // Обрали інший пресет → він вирішує далі; заборону знято.
      await openCfg(page);
      await page.locator('#cfgPresets .pre-btn', { hasText: ASHBY }).click();
      await page.waitForFunction(() => localStorage.getItem('activePresetId') === '3');
      assert.equal(await page.evaluate(() => localStorage.getItem('noAutoFp')), null);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  } finally { store.set(saved); store.save(); }
});

// ---------- Перейменування (✎) ----------
const nameInput = (dlg) => dlg.getByRole('textbox', { name: 'Назва пресета' });
const dlgError = (dlg) => dlg.locator('.field .error');
const toastWith = (page, text) => page.locator('#toasts .toast', { hasText: text });
async function openRename(page, name) {
  await renBtn(page, name).click();
  const dlg = confirmDlg(page);
  await dlg.waitFor();
  return dlg;
}
async function waitName(page, name) {
  await page.waitForFunction((n) => [...document.querySelectorAll('#cfgPresets .pre-btn')].some((b) => b.textContent === n), name, { timeout: 10000 });
}

test('e2e пресети ✎: перейменування НЕактивного — діалог із поточною назвою, PUT з обрізаною назвою, профіль не змінюється', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, reqs, puts } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    for (const name of [CLEAR, CF, ASHBY, MY]) {
      const b = renBtn(page, name);
      assert.equal(await b.count(), 1, '✎ для ' + name);
      assert.equal(await b.innerText(), '✎');
      assert.equal(await b.getAttribute('type'), 'button');
      assert.equal(await b.getAttribute('title'), 'Перейменувати пресет «' + name + '»');
      assert.equal(await b.isEnabled(), true);
    }
    // Порядок у групі: [чип][✎][✕].
    const order = await page.locator('#cfgPresets .pre-group').first().evaluate((g) => [...g.children].map((c) => c.className.split(' ')[0]));
    assert.deepEqual(order, ['pre-btn', 'pre-ren', 'pre-del']);

    const dlg = await openRename(page, CF);
    assert.equal(await dlg.getByRole('heading').innerText(), 'Перейменувати пресет');
    const inp = nameInput(dlg);
    assert.equal(await inp.inputValue(), CF, 'поле заповнене поточною назвою');
    // Фокус у полі, текст виділено (одразу можна друкувати нову назву).
    const sel = await inp.evaluate((el) => ({ focused: document.activeElement === el, s: el.selectionStart, e: el.selectionEnd, n: el.value.length }));
    assert.ok(sel.focused && sel.s === 0 && sel.e === sel.n, JSON.stringify(sel));
    await shot(page, 'rename-desktop-dialog');

    await inp.fill('   ☁️   CF   нова  ');
    await dlg.getByRole('button', { name: 'Перейменувати', exact: true }).click();
    const NEW = '☁️ CF нова';
    await waitName(page, NEW);
    assert.equal(await confirmDlg(page).count(), 0, 'діалог закрито');
    assert.deepEqual(await presetNames(page), [CLEAR, NEW, ASHBY, MY]);
    assert.deepEqual(puts, [{ path: '/presets/2', body: { name: NEW } }], 'PUT лише з назвою (обрізаною), без body');
    assert.deepEqual(db.calls, [['update', 2]]);
    assert.deepEqual(db.names(), [CLEAR, NEW, ASHBY, MY]);
    assert.deepEqual((await page.evaluate(() => fetch('/presets').then((r) => r.json()))).presets.find((p) => p.id === 2).body,
      SEED.find((p) => p.id === 2).body, 'налаштування пресета не змінились');
    await toastWith(page, 'Пресет перейменовано: «' + NEW + '».').waitFor();
    assert.match(await page.locator('#consoleBody').innerText(), /✎ Пресет «☁️ Cloudflare» перейменовано на «☁️ CF нова»\./);
    // Фокус — на ✎ перейменованого (з новою назвою в aria-label), не в <body>.
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + NEW + '»');
    assert.equal(await renBtn(page, NEW).count(), 1);
    assert.equal(await delBtn(page, NEW).count(), 1);
    // Активний лишився «Мій FP», чип без змін.
    assert.equal(await page.locator('#cfgPresets .pre-group.active .pre-btn').innerText(), MY);
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.match(await chipText(page), new RegExp(MY));
    assert.equal(await page.evaluate(() => localStorage.getItem('activePresetId')), '7');
    // Чернетка не «забруднилась», профіль не чіпали.
    assert.equal(await page.locator('#cfgSave').isDisabled(), true);
    assert.equal(await page.locator('#cfgDialog .nav-item.changed').count(), 0);
    assert.equal(await page.locator('#cfgAlert').isVisible(), false);
    assert.ok(!reqs.includes('POST /profile'), reqs.join(', '));
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    await shot(page, 'rename-desktop-after');

    // Після reload — нова назва.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('cfgDialog').open);
    await page.reload();
    await page.waitForFunction(() => !/…|—/.test(document.getElementById('hdrConfigChip').textContent));
    await openCfg(page);
    assert.deepEqual(await presetNames(page), [CLEAR, NEW, ASHBY, MY]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети ✎: лише клавіатура — перейменування АКТИВНОГО (чип — нова назва, режим «preset», id той самий)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, reqs, puts } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    // Tab доходить до ✎ «Мій FP» (і він іде одразу після кнопки пресета, перед ✕).
    let label = null;
    for (let i = 0; i < 60 && label !== 'Перейменувати пресет «' + MY + '»'; i++) {
      await page.keyboard.press('Tab');
      label = await focusedLabel(page);
    }
    assert.equal(label, 'Перейменувати пресет «' + MY + '»', 'Tab дістає ✎');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), MY, 'перед ✎ — кнопка пресета');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await focusedLabel(page), 'Видалити пресет «' + MY + '»', 'після ✎ — ✕');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + MY + '»');

    await page.keyboard.press('Enter');
    const dlg = confirmDlg(page);
    await dlg.waitFor();
    assert.equal(await nameInput(dlg).inputValue(), MY);
    // Текст виділено — друк замінює його.
    const NEW = '🧬 Мій FP (Mac)';
    await page.keyboard.type(NEW);
    assert.equal(await nameInput(dlg).inputValue(), NEW);
    await page.keyboard.press('Enter');
    await waitName(page, NEW);
    assert.equal(await confirmDlg(page).count(), 0);
    assert.deepEqual(puts, [{ path: '/presets/7', body: { name: NEW } }]);
    assert.deepEqual(db.names(), [CLEAR, CF, ASHBY, NEW]);
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + NEW + '»');

    // Активний той самий пресет, нова назва; не dirty.
    const active = page.locator('#cfgPresets .pre-group.active');
    assert.equal(await active.count(), 1);
    assert.equal(await active.locator('.pre-btn').innerText(), NEW);
    assert.equal(await active.locator('.pre-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(await active.locator('.pre-btn.dirty').count(), 0);
    // Чип у шапці: нова назва, режим preset — не «кастом» і не «● змінено».
    await page.waitForFunction((n) => document.getElementById('hdrConfigChip').textContent.includes(n), NEW);
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.doesNotMatch(await chipText(page), /кастом|змінено|●/);
    assert.equal(await page.evaluate(() => localStorage.getItem('activePresetId')), '7');
    assert.equal(await page.evaluate(() => localStorage.getItem('noAutoFp')), null);
    assert.equal(await page.locator('#cfgSave').isDisabled(), true);
    assert.ok(!reqs.includes('POST /profile'), reqs.join(', '));
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    await shot(page, 'rename-active-after');

    // Після reload — чип одразу з новою назвою, режим preset.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('cfgDialog').open);
    await page.reload();
    await page.waitForFunction(() => !/…|—/.test(document.getElementById('hdrConfigChip').textContent));
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.ok((await chipText(page)).includes(NEW), await chipText(page));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети ✎: валідація (порожня / дубль / задовга), та сама назва, Esc і Скасувати — без запиту, фокус на ✎', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const { ctx, page, errors, reqs, puts } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    const dlg = await openRename(page, ASHBY);
    const inp = nameInput(dlg);
    const ok = dlg.getByRole('button', { name: 'Перейменувати', exact: true });
    const expectError = async (value, re) => {
      await inp.fill(value);
      await ok.click();
      await page.waitForTimeout(100);
      assert.equal(await confirmDlg(page).count(), 1, 'діалог лишився для «' + value + '»');
      assert.match(await dlgError(dlg).innerText(), re, 'помилка для «' + value + '»');
      assert.equal(await inp.getAttribute('aria-invalid'), 'true');
      assert.equal(await inp.evaluate((el) => document.activeElement === el), true, 'фокус у полі');
    };
    await expectError('', /\S/); // required → «Заповни поле»
    await shot(page, 'rename-error-empty');
    await expectError('    ', /\S/);
    await expectError(CF, /Пресет із такою назвою вже є/);
    await shot(page, 'rename-error-duplicate');
    await expectError('  ☁️    Cloudflare  ', /Пресет із такою назвою вже є/); // пробіли нормалізуються
    await expectError(MY, /Пресет із такою назвою вже є/);
    await expectError('я'.repeat(81), /до 80 символів/);
    // Виправили — помилка зникає при наступній спробі (тут: та сама назва → без запиту).
    await inp.fill('  📋   Ashby ');
    await ok.click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + ASHBY + '»', 'та сама назва → фокус на ✎');
    assert.equal(await page.locator('#cfgDialog').evaluate((d) => d.open), true);

    // Esc → без запиту, конфігуратор відкритий, фокус на ✎.
    let d2 = await openRename(page, ASHBY);
    await nameInput(d2).fill('щось інше');
    await page.keyboard.press('Escape');
    await d2.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#cfgDialog').evaluate((d) => d.open), true, 'Esc закрив лише діалог назви');
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + ASHBY + '»');
    // Скасувати → те саме.
    d2 = await openRename(page, ASHBY);
    await nameInput(d2).fill('щось інше');
    await d2.getByRole('button', { name: 'Скасувати' }).click();
    await d2.waitFor({ state: 'detached' });
    assert.equal(await focusedLabel(page), 'Перейменувати пресет «' + ASHBY + '»');

    assert.deepEqual(puts, [], 'жодного PUT: ' + reqs.join(', '));
    assert.deepEqual(db.calls, []);
    assert.deepEqual(await presetNames(page), [CLEAR, CF, ASHBY, MY]);
    assert.equal(await toastWith(page, 'перейменовано').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети ✎: 404 (пресет видалено деінде) → червоний алерт, без тосту успіху', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, puts } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    db.drop(2);
    const dlg = await openRename(page, CF);
    await nameInput(dlg).fill('☁️ CF 404');
    await dlg.getByRole('button', { name: 'Перейменувати', exact: true }).click();
    await dlg.waitFor({ state: 'detached' });
    await page.locator('#cfgAlert').waitFor({ state: 'visible' });
    assert.match(await page.locator('#cfgAlert').innerText(), /Пресет не перейменовано: Пресет не знайдено/);
    assert.match(await page.locator('#consoleBody').innerText(), /❌ Пресет не перейменовано/);
    assert.deepEqual(puts, [{ path: '/presets/2', body: { name: '☁️ CF 404' } }]);
    assert.deepEqual(db.calls, [['update', 2]]);
    assert.equal(await toastWith(page, 'перейменовано').count(), 0);
    assert.equal(await page.locator('#cfgPresets .pre-group.active .pre-btn').innerText(), MY);
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    await shot(page, 'rename-404');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e пресети ✎ 390×844: перейменування тапом, діалог у межах екрана, без горизонтального переповнення', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const prof0 = profileBytes();
  const { ctx, page, errors, puts } = await openUi({ viewport: { width: 390, height: 844 }, activeId: 7 });
  try {
    await openCfg(page, '#cfgBtn');
    const hScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const ren = renBtn(page, MY);
    await ren.scrollIntoViewIfNeeded();
    const rb = await ren.boundingBox();
    assert.ok(rb.x >= 0 && rb.x + rb.width <= 390, '✎ у межах екрана: ' + JSON.stringify(rb));
    assert.ok(rb.width >= 40, '✎ ≥ 40 px: ' + JSON.stringify(rb));
    assert.equal(await hScroll(), 0);
    await ren.tap();
    const dlg = confirmDlg(page);
    await dlg.waitFor();
    const b = await dlg.boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390, 'діалог у межах екрана: ' + JSON.stringify(b));
    await shot(page, 'rename-mobile-dialog');
    const NEW = '🧬 Мій FP 📱';
    await nameInput(dlg).fill(NEW);
    await dlg.getByRole('button', { name: 'Перейменувати', exact: true }).tap();
    await waitName(page, NEW);
    assert.deepEqual(puts, [{ path: '/presets/7', body: { name: NEW } }]);
    assert.equal(await page.locator('#hdrConfigChip').getAttribute('data-mode'), 'preset');
    assert.ok((await chipText(page)).includes(NEW));
    assert.equal(await hScroll(), 0);
    const row = await page.locator('#cfgPresets').evaluate((el) => ({ right: el.getBoundingClientRect().right, ox: getComputedStyle(el).overflowX }));
    assert.ok(row.right <= 390 && row.ox === 'auto', JSON.stringify(row));
    await shot(page, 'rename-mobile-after');
    assert.deepEqual(engine.calls, []);
    assert.equal(profileBytes(), prof0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// Колір пікселя (x, y у CSS-px) зі справжнього скріна — бачимо те, що намальовано, з урахуванням перекриття.
async function pixelAt(page, x, y) {
  const buf = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css' });
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, buf.toString('base64'));
}
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('e2e пресети: focus-ring кнопки пресета і ✎ не перекривається сусідньою кнопкою групи (видно праву сторону)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  db.reset(); engine.calls.length = 0;
  const { ctx, page, errors } = await openUi({ activeId: 7 });
  try {
    await openCfg(page);
    // Лише клавіатура: Tab до кнопки «☁️ Cloudflare» (focus-visible), далі ✎ і ✕.
    let txt = null;
    for (let i = 0; i < 60 && txt !== CF; i++) {
      await page.keyboard.press('Tab');
      txt = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
    }
    assert.equal(txt, CF, 'Tab дістає кнопку пресета');
    for (const [i, label] of ['кнопка пресета', '✎', '✕'].entries()) {
      if (i > 0) await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const el = document.activeElement, b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, fv: el.matches(':focus-visible') };
      });
      assert.ok(r.fv, label + ': :focus-visible');
      const y = (r.top + r.bottom) / 2;
      // Кільце: 2 px фону + 2 px акценту ЗОВНІ кнопки. Ліва сторона завжди видима — еталон кольору.
      const ringLeft = await pixelAt(page, r.left - 3.5, y);
      const ringRight = await pixelAt(page, r.right + 2.5, y);
      const ringTop = await pixelAt(page, (r.left + r.right) / 2, r.top - 3.5);
      assert.ok(near(ringLeft, ringTop), label + ': ліва й верхня сторони кільця однакові ' + JSON.stringify({ ringLeft, ringTop }));
      const accent = await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color.match(/\d+/g).slice(0, 3).map(Number); d.remove(); return c; });
      assert.ok(near(ringLeft, accent, 40), label + ': ліва сторона — колір акценту ' + JSON.stringify({ ringLeft, accent }));
      assert.ok(near(ringRight, ringLeft), label + ': права сторона кільця видима (не перекрита сусідом) ' + JSON.stringify({ ringLeft, ringRight }));
      await shot(page, 'focus-ring-' + i);
    }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
