// E2E (opt-in, E2E=1): 📦 експорт / імпорт пресетів і сценаріїв через UI — справжній `node server.js`
// (дочірній процес, ВЛАСНИЙ порт UI_PORT або вільний, БЕЗ БД → сценарії в памʼяті процесу,
// profile.json і uploads — у тимчасовій теці) + headless Chrome, що керує UI як користувач.
// Справжню БД і робочий сервер на :3000 НЕ чіпаємо; жодних реальних сайтів (URL сценаріїв не відкриваються).
//
// Потік: засів 2 сценаріїв через PUT /pages (один із кроком file, файл — через /upload) →
// «📤 Експорт» у сайдбарі (діалог, пояснення «БД недоступна» в блоці пресетів, «файли кроків (1 файл)»,
// download Playwright-ом: назва, формат, без id, base64 файлу) → ⋯ «📤 Експортувати сценарій» →
// змінюємо «Сценарій А» (та сама назва, інший URL) і видаляємо «Сценарій Б» → «📥 Імпорт»: прев'ю
// «конфлікт назви → «Сценарій А (2)»» і «новий» → імпорт → /pages (нові id, файл перезавантажено з
// новим fileId і тим самим вмістом), фокус на імпортованому сценарії → повторний імпорт: «Пропустити»
// (кнопка вимкнена з поясненням, «= такий самий є — пропуск» для Б) і «Замінити» (той самий id, URL з файлу);
// пресет у файлі без БД → пояснення; сміття → role=alert; Esc → фокус на кнопку; 390×844 без
// горизонтальної прокрутки з відкритим діалогом.
// Запуск: E2E=1 node --test test/e2e/transfer.e2e.test.js  (UI_PORT / UI_TMP — щоб не чіпати робочий сервер)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const E2E = process.env.E2E === '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const opts = { skip: !E2E, timeout: 180000 };
const FILE_TEXT = 'резюме: тестовий вміст файлу кроку ✓\n';
const URL_A = 'http://127.0.0.1:9/a.html', URL_A2 = 'http://127.0.0.1:9/a-changed.html', URL_B = 'http://127.0.0.1:9/b.html';

let tmp, child, childLog = '', base, browser, uploadDir;
const ctx = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { ms = 20000, step = 150, what = 'умова' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error('Не дочекались: ' + what + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(step);
  }
}

const api = async (p, init) => { const r = await fetch(base + p, init); return r.json(); };
const getPages = async () => (await api('/pages')).pages;
const putPage = (id, page) => api('/pages/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(page) });
const fileSteps = (page) => page.recs.flatMap((r) => r.subs).filter((s) => s.type === 'file');
const readUpload = (s) => fs.readFileSync(path.join(uploadDir, s.fileId, s.filename), 'utf8');

before(async () => {
  if (!E2E) return;
  const port = Number(process.env.UI_PORT) || await freePort();
  if (port === 3000) throw new Error('UI_PORT не може бути 3000 (робочий сервер)');
  fs.mkdirSync(process.env.UI_TMP || os.tmpdir(), { recursive: true });
  tmp = fs.mkdtempSync(path.join(process.env.UI_TMP || os.tmpdir(), 'srs-transfer-e2e-'));
  uploadDir = path.join(tmp, 'uploads');
  fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify({ behavior: { humanize: false } }));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
      PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: uploadDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  base = 'http://127.0.0.1:' + port;
  // Рендер не потрібен — досить, що HTTP відповідає і БД визначилась (мертвий порт → памʼять).
  await waitFor(async () => {
    if (child.exitCode != null) throw new Error('server.js завершився: ' + childLog.slice(-800));
    const hl = await api('/health');
    return hl.ok && /БД недоступна|Помилка БД|Postgres підключено/.test(childLog);
  }, { ms: 150000, step: 300, what: '/health + ініціалізація БД' });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (!E2E) return;
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode == null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM'); // лише процес, який запустили ми
    await Promise.race([gone, sleep(8000)]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function openApp(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/');
  await page.waitForSelector('#importBtn');
  return { context, page, errors };
}

const card = (page, id) => page.locator('[data-fk="p' + id + '-tg"]');
const importDlg = (page) => page.locator('dialog.tr-import[open]');
const rowOf = (page, list, name) => page.locator('#' + list + ' li').filter({ hasText: name });

async function openImport(page, file) {
  await page.click('#importBtn');
  await importDlg(page).waitFor();
  await page.setInputFiles('#trImportFile', file);
  await page.locator('#trImS').waitFor();
}

test('засів: 2 сценарії (один з кроком file) у памʼяті сервера без БД', opts, async () => {
  const up = await fetch(base + '/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('cv.txt') }, body: FILE_TEXT });
  const u = await up.json();
  assert.ok(u.ok && u.fileId, JSON.stringify(u));
  ctx.fileId = u.fileId;
  await putPage(101, { name: 'Сценарій А', url: URL_A, recs: [{ id: 1, name: 'Дія 1', expanded: true, subs: [
    { id: 's1', v: 2, type: 'click', x: 10, y: 20, sw: 1280, sh: 900, status: 'ok', ms: 12, target: { locs: [{ kind: 'testid', value: 'go' }], pick: 0 } },
    { id: 's2', v: 2, type: 'file', fileId: u.fileId, filename: u.filename, target: { locs: [{ kind: 'css', value: 'input[type=file]' }], pick: 0 } },
  ] }] });
  await putPage(102, { name: 'Сценарій Б', url: URL_B, recs: [{ id: 2, name: 'Дія 1', subs: [{ id: 's3', v: 2, type: 'text', text: 'привіт {d}' }] }] });
  const pages = await getPages();
  assert.deepEqual(pages.map((p) => p.id), [101, 102]);
});

test('📤 експорт через UI: діалог, пояснення без БД, файл бандла з вмістом файлу кроку', opts, async () => {
  const { context, page, errors } = await openApp();
  try {
    await card(page, 102).waitFor();
    await page.click('#exportBtn');
    const dlg = page.locator('dialog.tr-export[open]');
    await dlg.waitFor();
    // Без БД пресетів немає — блок пояснює чому.
    await assert.doesNotReject(dlg.locator('#trExP', { hasText: 'БД недоступна' }).waitFor({ timeout: 5000 }));
    await page.locator('#trExS').waitFor();
    assert.equal(await page.locator('#trExS .tr-list input[type=checkbox]:checked').count(), 2);
    assert.match(await page.locator('label[for="trExFiles"]').innerText(), /1 файл/);
    assert.equal(await page.locator('#trExFiles').isChecked(), true);
    // «жодного» → кнопка вимкнена з поясненням; «усі» → знову активна.
    await page.click('label[for="trExS_all"]');
    assert.equal(await page.locator('#trExportGo').isDisabled(), true);
    assert.match(await page.locator('#trExportHint').innerText(), /Вибери хоча б один/);
    await page.click('label[for="trExS_all"]');
    assert.equal(await page.locator('#trExportGo').isDisabled(), false);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#trExportGo')]);
    assert.match(dl.suggestedFilename(), /^stealth-bundle-scenarios-\d{4}-\d{2}-\d{2}\.json$/);
    ctx.bundlePath = path.join(tmp, 'bundle.json');
    await dl.saveAs(ctx.bundlePath);
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'exportBtn', 'фокус повертається на кнопку');

    const b = JSON.parse(fs.readFileSync(ctx.bundlePath, 'utf8'));
    assert.equal(b.format, 'stealth-render-studio/bundle');
    assert.equal(b.version, 1);
    assert.deepEqual(b.presets, []);
    assert.deepEqual(b.scenarios.map((s) => s.name), ['Сценарій А', 'Сценарій Б']);
    assert.equal(b.scenarios[0].id, undefined);
    assert.equal(b.scenarios[0].recs[0].id, undefined);
    assert.equal(b.scenarios[0].recs[0].expanded, undefined);
    const s1 = b.scenarios[0].recs[0].subs[0];
    assert.equal(s1.id, 's1', 'id кроків лишаються');
    assert.equal(s1.status, undefined, 'runtime-поля прибрано');
    assert.equal(b.files.length, 1);
    assert.equal(b.files[0].fileId, ctx.fileId);
    assert.equal(Buffer.from(b.files[0].data, 'base64').toString('utf8'), FILE_TEXT);

    // ⋯ → «📤 Експортувати сценарій» — одразу файл з одним сценарієм.
    await page.click('[data-fk="p102-menu"]');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Експортувати сценарій/ }).click()]);
    assert.match(dl2.suggestedFilename(), /^stealth-bundle-.+-\d{4}-\d{2}-\d{2}\.json$/);
    const one = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'));
    assert.deepEqual(one.scenarios.map((s) => s.name), ['Сценарій Б']);
    assert.deepEqual(one.files, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('📥 імпорт: конфлікт назви → «Сценарій А (2)», новий Б; нові id, файл перезавантажено', opts, async () => {
  // Та сама назва, інший зміст (URL) + Б видалено.
  const pages0 = await getPages();
  await putPage(101, { ...pages0.find((p) => p.id === 101), url: URL_A2 });
  await fetch(base + '/pages/102', { method: 'DELETE' });

  const { context, page, errors } = await openApp();
  try {
    await card(page, 101).waitFor();
    await openImport(page, ctx.bundlePath);
    await assert.doesNotReject(rowOf(page, 'trImS', 'Сценарій А').locator('.tr-chip', { hasText: 'конфлікт назви → «Сценарій А (2)»' }).waitFor({ timeout: 5000 }));
    assert.equal(await rowOf(page, 'trImS', 'Сценарій Б').locator('.tr-chip').innerText(), 'новий');
    assert.equal(await page.locator('#trStrat_scenarios_rename').isChecked(), true, 'за замовчуванням — перейменування');
    assert.match(await page.locator('#trImportHint').innerText(), /нових: 2/);
    await page.click('#trImportGo');
    await importDlg(page).waitFor({ state: 'detached', timeout: 30000 });

    const pages = await getPages();
    assert.equal(pages.length, 3, JSON.stringify(pages.map((p) => p.name)));
    const a = pages.find((p) => p.id === 101);
    assert.equal(a.url, URL_A2, 'існуючий не чіпали');
    const a2 = pages.find((p) => p.name === 'Сценарій А (2)');
    const b = pages.find((p) => p.name === 'Сценарій Б');
    assert.ok(a2 && b);
    assert.ok(![101, 102].includes(a2.id) && a2.id !== b.id, 'нові id сторінок');
    assert.equal(a2.url, URL_A);
    const recIds = pages.flatMap((p) => p.recs.map((r) => r.id));
    assert.equal(new Set(recIds).size, recIds.length, 'id Дій унікальні');
    const [fs2] = fileSteps(a2);
    assert.notEqual(fs2.fileId, ctx.fileId, 'файл кроку перезавантажено з новим fileId');
    assert.equal(fs2.filename, 'cv.txt');
    assert.equal(readUpload(fs2), FILE_TEXT, 'вміст файлу той самий');
    assert.equal(a2.recs[0].subs[0].id, 's1');
    ctx.a2 = a2.id; ctx.b = b.id;

    // UI: нові картки, фокус — на першому імпортованому сценарії, тост і лог.
    await card(page, a2.id).waitFor();
    await waitFor(() => page.evaluate((fk) => document.activeElement && document.activeElement.dataset.fk === fk, 'p' + a2.id + '-tg'), { what: 'фокус на імпортованому сценарії' });
    assert.match(await page.locator('#console').innerText(), /📥 Імпортовано: сценаріїв 2 \(1 перейменовано\)/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('📥 повторний імпорт: «Пропустити» (= такий самий / пропуск), потім «Замінити» — той самий id', opts, async () => {
  const { context, page, errors } = await openApp();
  try {
    await card(page, ctx.b).waitFor();
    await openImport(page, ctx.bundlePath);
    // Б тепер ідентичний (той самий зміст) — пропуск за будь-якої стратегії.
    await assert.doesNotReject(rowOf(page, 'trImS', 'Сценарій Б').locator('.tr-chip', { hasText: '= такий самий є — пропуск' }).waitFor({ timeout: 5000 }));
    await page.click('label[for="trStrat_scenarios_skip"]');
    assert.equal(await rowOf(page, 'trImS', 'Сценарій А').locator('.tr-chip').innerText(), 'пропуск');
    assert.equal(await page.locator('#trImportGo').isDisabled(), true);
    assert.match(await page.locator('#trImportHint').innerText(), /Нічого імпортувати/);

    await page.click('label[for="trStrat_scenarios_replace"]');
    assert.equal(await rowOf(page, 'trImS', 'Сценарій А').locator('.tr-chip').innerText(), 'замінить існуючий');
    assert.equal(await rowOf(page, 'trImS', 'Сценарій Б').locator('.tr-chip').innerText(), '= такий самий є — пропуск');
    await page.click('#trImportGo');
    await importDlg(page).waitFor({ state: 'detached', timeout: 30000 });

    const pages = await getPages();
    assert.equal(pages.length, 3, 'нових сценаріїв не додалось');
    const a = pages.find((p) => p.id === 101);
    assert.equal(a.name, 'Сценарій А');
    assert.equal(a.url, URL_A, 'замінено вмістом із файлу, id той самий');
    const [f] = fileSteps(a);
    assert.notEqual(f.fileId, ctx.fileId);
    assert.equal(readUpload(f), FILE_TEXT);
    assert.match(await page.locator('#console').innerText(), /замінено: 1/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('📥 пресет у файлі без БД — пояснення; сміття → role=alert; Esc → фокус на кнопку', opts, async () => {
  const withPreset = JSON.parse(fs.readFileSync(ctx.bundlePath, 'utf8'));
  withPreset.presets = [{ name: '📋 Ashby', body: { launch: { engine: 'chromium' } } }];
  const p1 = path.join(tmp, 'with-preset.json');
  fs.writeFileSync(p1, JSON.stringify(withPreset));
  const junk = path.join(tmp, 'junk.json');
  fs.writeFileSync(junk, JSON.stringify({ hello: 'world' }));

  const { context, page, errors } = await openApp();
  try {
    await openImport(page, p1);
    await page.locator('#trImP').waitFor();
    assert.equal(await rowOf(page, 'trImP', 'Ashby').locator('.tr-chip').innerText(), 'БД недоступна — пропуск');
    assert.match(await importDlg(page).locator('.tr-warns').innerText(), /БД недоступна — пресети не імпортуються/);
    assert.equal(await page.locator('#trStrat_presets_rename').count(), 0, 'без БД стратегії пресетів не показуються');

    await page.setInputFiles('#trImportFile', junk);
    const alert = importDlg(page).locator('.tr-alert[role=alert]');
    await waitFor(async () => /Це не файл експорту Stealth Render Studio/.test(await alert.innerText()), { what: 'алерт про сміття' });
    assert.equal(await page.locator('#trImportGo').isDisabled(), true);

    await page.keyboard.press('Escape');
    await importDlg(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'importBtn');

    // Конфігуратор без БД: «📤 Експорт пресетів» вимкнено (пресетів немає), «📥 Імпорт» — доступний.
    await page.click('#cfgBtn');
    await page.locator('#cfgPresetsImport').waitFor();
    assert.equal(await page.locator('#cfgPresetsExport').isDisabled(), true);
    assert.equal(await page.locator('#cfgPresetsImport').isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('390×844: діалоги імпорту й експорту без горизонтальної прокрутки', opts, async () => {
  const { context, page, errors } = await openApp({ width: 390, height: 844 });
  try {
    await card(page, ctx.b).waitFor();
    // 📥/📤 — у хедері (імпорт/експорт усього застосунку), на вузькому екрані — лише іконки, у межах екрана.
    const hdr = await page.evaluate(() => ['importBtn', 'exportBtn', 'cfgBtn'].map((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { id, inHeader: !!el.closest('.app-header'), right: r.right, w: r.width };
    }));
    for (const b of hdr) {
      assert.ok(b.inHeader && b.w > 0 && b.right <= 390, JSON.stringify(b));
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    await openImport(page, ctx.bundlePath);
    const m = await page.evaluate(() => {
      const d = document.querySelector('dialog.tr-import[open]').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, left: d.left, right: d.right };
    });
    assert.ok(m.sw <= 390, 'scrollWidth ' + m.sw);
    assert.ok(m.left >= 0 && m.right <= 390, JSON.stringify(m));
    const go = await page.locator('#trImportGo').boundingBox();
    assert.ok(go && go.x >= 0 && go.x + go.width <= 390, 'кнопка «Імпортувати» в межах екрана');
    await page.keyboard.press('Escape');
    await importDlg(page).waitFor({ state: 'detached' });

    await page.click('#exportBtn');
    await page.locator('dialog.tr-export[open] #trExS').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    const eg = await page.locator('#trExportGo').boundingBox();
    assert.ok(eg && eg.x + eg.width <= 390);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('📥 надійність: drop повз зону, прокрутка списку, inert і подвійний Esc під час імпорту, 500 → перечитаний список, збій збереження блокує імпорт, фокус у конфігураторі', opts, async () => {
  const many = { format: 'stealth-render-studio/bundle', version: 1, presets: [], files: [],
    scenarios: Array.from({ length: 40 }, (_, i) => ({ name: 'Масовий ' + (i + 1), url: 'http://127.0.0.1:9/m' + i, recs: [] })) };
  const manyText = JSON.stringify(many);
  const { context, page, errors } = await openApp();
  try {
    await card(page, ctx.b).waitFor();
    await page.click('#importBtn');
    await importDlg(page).waitFor();
    // Файл, кинутий НЕ на зону (на футер), — браузер його не відкриває (preventDefault), а діалог його бере.
    const prevented = await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'many.json', { type: 'application/json' }));
      const foot = document.querySelector('dialog.tr-import .tr-foot');
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      foot.dispatchEvent(over);
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      foot.dispatchEvent(drop);
      return over.defaultPrevented && drop.defaultPrevented;
    }, manyText);
    assert.equal(prevented, true);
    await page.locator('#trImS').waitFor();
    assert.equal(await page.locator('#trImS .tr-list li').count(), 40);

    // Клік по чекбоксу внизу списку не скидає його прокрутку на верх.
    const scroll = await page.evaluate(() => {
      const ul = document.querySelector('#trImS .tr-list');
      ul.scrollTop = 400;
      const before = ul.scrollTop;
      document.getElementById('trImS_24').click();
      const after = document.querySelector('#trImS .tr-list').scrollTop;
      return { before, after, focus: document.activeElement && document.activeElement.id };
    });
    assert.ok(scroll.before > 0 && Math.abs(scroll.after - scroll.before) <= 1, JSON.stringify(scroll));
    assert.equal(scroll.focus, 'trImS_24');
    await page.evaluate(() => document.getElementById('trImS_24').click()); // назад — вибрано все

    // Сервер «відповідає» 500 лише коли тест дозволить: під час роботи — inert, подвійний Esc не закриває.
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/import', async (route) => { await gate; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'boom' }) }); });
    await page.click('#trImportGo');
    await waitFor(() => page.evaluate(() => document.querySelector('dialog.tr-import .tr-body').inert === true), { what: 'inert під час імпорту' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(200);
    assert.equal(await importDlg(page).count(), 1, 'діалог не закрито під час імпорту');
    const reload = page.waitForRequest((r) => r.method() === 'GET' && /\/pages$/.test(r.url()), { timeout: 10000 });
    release();
    await reload; // 5xx → список перечитано з сервера
    const alert = importDlg(page).locator('.tr-alert[role=alert]');
    await waitFor(async () => /Імпорт не вдався: boom.*міг виконатися частково/.test(await alert.innerText()), { what: 'алерт про частковий імпорт' });
    assert.equal(await page.evaluate(() => document.querySelector('dialog.tr-import .tr-body').inert), false);
    await page.unroute('**/import');

    // Незбережені зміни сценарію (PUT /pages 413) → імпорт не починається, /import не викликається.
    const imports = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/import$/.test(r.url())) imports.push(r.url()); });
    await page.route('**/pages/*', (route) => (route.request().method() === 'PUT'
      ? route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Payload Too Large' }) })
      : route.continue()));
    await page.evaluate(async () => {
      const st = await import('/js/state.js'); const pr = await import('/js/persist.js');
      pr.persistPage(st.state.pages[0]);
    });
    await page.click('#trImportGo');
    await waitFor(async () => /Не вдалося зберегти поточні зміни сценаріїв/.test(await alert.innerText()), { what: 'алерт про незбережені зміни' });
    assert.deepEqual(imports, []);
    await page.unroute('**/pages/*');
    await page.evaluate(async () => { const pr = await import('/js/persist.js'); await pr.flushAllPages(); });
    await page.keyboard.press('Escape');
    await importDlg(page).waitFor({ state: 'detached' });

    // Імпорт із конфігуратора (лише сценарій): фокус лишається на «📥 Імпорт» конфігуратора.
    const one = path.join(tmp, 'one.json');
    fs.writeFileSync(one, JSON.stringify({ ...many, scenarios: [{ name: 'З конфігуратора', url: 'http://127.0.0.1:9/c', recs: [] }] }));
    await page.click('#cfgBtn');
    await page.locator('#cfgPresetsImport').click();
    await importDlg(page).waitFor();
    await page.setInputFiles('#trImportFile', one);
    await page.locator('#trImS').waitFor();
    await page.click('#trImportGo');
    await importDlg(page).waitFor({ state: 'detached', timeout: 30000 });
    await sleep(300);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'cfgPresetsImport');
    assert.ok((await getPages()).some((p) => p.name === 'З конфігуратора'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
