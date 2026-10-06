// E2E (opt-in, E2E=1): сайдбар сценаріїв F2 у справжньому Chrome — створення через діалог,
// legacy-кроки (рухи згорнуті, чипи здоровʼя), ▶ Старт зі статусами/бейджами стратегій/
// failShot/підсумком, швидке виправлення, вбудований редактор, видалення з «Скасувати»,
// ⏹ Стоп посеред прогону, бейдж «Не збережено» без БД (після зміни), 390 px без горизонтальної прокрутки.
// Застосунок — createApp у процесі (channel 'chrome', headless, без stealth-плагіна, без БД);
// UI_BASE=http://localhost:<порт> — ті самі перевірки проти вже запущеного ТЕСТОВОГО сервера
// (не 3000!). Сторінки сценаріїв — лише локальні фікстури (test/fixtures).
// F3: модалка редагування кроку (Esc/фон/валідація/фокус), «⏱ пауза після кроку» (чип, лог,
// реальний проміжок між кроками за ехо фікстури typing.html), ⤵ обʼєднання текстових кроків
// (legacy+v2, через приховані рухи, undo, неактивна для різних полів) і прогін злитого тексту.
// UI_PORT / FX_PORT — порти застосунку / фікстур (за замовчуванням вільні), UI_TMP — тека для tmp.
// Запуск: E2E=1 node --test test/e2e/scenarios.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const E2E = process.env.E2E === '1';
const EXTERNAL = process.env.UI_BASE || '';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const quiet = { log() {}, error() {}, warn() {} };

let fsrv, FX, tmp, engine, sessions, srv, base, uiBrowser;
const fxEvents = []; // події фікстури typing.html: {e: 'поле:значення', t: мс}

before(async () => {
  if (!E2E) return;
  fsrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // /log?e=…&t=… — ехо фікстури typing.html (значення поля + час у браузері).
    if (u.pathname === '/log') { fxEvents.push({ e: u.searchParams.get('e'), t: Number(u.searchParams.get('t')) || Date.now() }); return res.end('ok'); }
    const f = path.join(FIX, path.basename(u.pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => fsrv.listen(Number(process.env.FX_PORT) || 0, '127.0.0.1', r));
  FX = 'http://127.0.0.1:' + fsrv.address().port;
  const { chromium } = await import('playwright');
  if (EXTERNAL) {
    if (/:3000\b/.test(EXTERNAL)) throw new Error('UI_BASE не може бути робочим сервером на :3000');
    base = EXTERNAL.replace(/\/$/, '');
  } else {
    const [{ createApp }, { loadConfig }, { createSemaphore }, { createProfileStore, applyProfilePatch }, { createEngine }, { createSessionStore }] = await Promise.all([
      import('../../lib/app.js'), import('../../lib/config.js'), import('../../lib/semaphore.js'),
      import('../../lib/profile.js'), import('../../lib/engine.js'), import('../../lib/session.js'),
    ]);
    fs.mkdirSync(process.env.UI_TMP || os.tmpdir(), { recursive: true });
    tmp = fs.mkdtempSync(path.join(process.env.UI_TMP || os.tmpdir(), 'srs-f2-e2e-'));
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
    const port = Number(process.env.UI_PORT) || 0;
    if (port === 3000) throw new Error('UI_PORT не може бути 3000 (робочий сервер)');
    srv = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
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

async function openUi(viewport = { width: 1280, height: 900 }) {
  const ctx = await uiBrowser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + '/');
  await page.locator('#pagesEl .none, #pagesEl .page').first().waitFor();
  return { ctx, page, errors };
}

// Створення сценарію через діалог.
async function createScenario(page, name, url) {
  await page.click('#newPageBtn');
  const dlg = page.locator('#dialogs dialog');
  await dlg.waitFor();
  await dlg.getByLabel('Стартовий URL').fill(url);
  await dlg.getByLabel('Назва').fill(name);
  await dlg.getByRole('button', { name: 'Створити' }).click();
  await dlg.waitFor({ state: 'detached' });
  const card = page.locator('.page', { hasText: name });
  await card.waitFor();
  return card;
}

// Додає Дію напряму в модель (той самий модуль state.js, що й у застосунку) — як після запису.
async function addRec(page, scenarioName, rec) {
  await page.evaluate(async ({ scenarioName, rec }) => {
    const { state, emit } = await import('/js/state.js');
    const p = state.pages.find((x) => x.name === scenarioName);
    p.recs.push({ expanded: true, ...rec });
    emit('pages');
    emit('page:changed', { page: p, pageId: p.id, reason: 'test' });
  }, { scenarioName, rec });
}

const legacyRec = {
  id: 901, name: 'Legacy',
  subs: [
    { type: 'move', x: 50, y: 50, sw: 1280, sh: 3000 },
    { type: 'move', x: 120, y: 160, sw: 1280, sh: 3000 },
    { type: 'move', x: 190, y: 170, sw: 1280, sh: 3000 },
    { type: 'click', x: 200, y: 175, sw: 1280, sh: 3000 },
    { type: 'text', text: 'h' }, { type: 'text', text: 'i' },
    { type: 'key', key: 'Tab' },
    { v: 2, id: 's_missing', type: 'click', timeout: 1500, target: { frame: null, locs: [{ by: 'role', role: 'button', name: 'Немає такої', exact: true, n: 1 }], pick: 0, kind: 'button', desc: 'кнопка «Немає такої»' } },
    { v: 2, id: 's_top', type: 'click', target: { frame: null, locs: [{ by: 'css', value: 'button._btn_f7cvd_3', n: 1 }, { by: 'role', role: 'button', name: 'Верхня', exact: true, n: 1 }], pick: 0, kind: 'button', desc: 'кнопка «Верхня»' }, x: 200, y: 175 },
  ],
};

test('e2e F2: legacy-кроки → ▶ Старт: статуси, стратегії, failShot, підсумок; швидке виправлення; редактор; undo', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  try {
    if (!EXTERNAL) {
      assert.match(await page.locator('#pagesEl').innerText(), /Створи сценарій[\s\S]*Записуй[\s\S]*Відтвори/);
    }
    const card = await createScenario(page, 'F2 legacy', FX + '/click.html');
    // Без БД сервер тримає сценарії в памʼяті процесу: зміна доходить у GET /pages, бейдж
    // «Не збережено» не зʼявляється (стан «лише в памʼяті» показує health-бейдж у хедері).
    for (let i = 0; ; i++) {
      const d = await page.evaluate(() => fetch('/pages').then((r) => r.json()));
      if (d.db || d.pages.some((p) => p.name === 'F2 legacy')) break;
      if (i > 50) assert.fail('сценарій не зʼявився в GET /pages: ' + JSON.stringify(d).slice(0, 300));
      await page.waitForTimeout(200);
    }
    if (!EXTERNAL) assert.equal(await page.locator('#saveBadge.nodb').count(), 0);
    assert.match(await card.innerText(), /Ще немає Дій/);
    await addRec(page, 'F2 legacy', legacyRec);
    const rec = card.locator('.rec', { hasText: 'Legacy' });
    await rec.locator('.subs li').first().waitFor();
    // Рухи згорнуто в один рядок; чипи здоровʼя.
    assert.equal(await rec.locator('.moves-row').count(), 1);
    assert.match(await rec.locator('.moves-row').innerText(), /\+3 рухи миші/);
    const legacyClick = rec.locator('.subs li[data-si="3"]');
    assert.equal(await legacyClick.locator('.hchip.h-coords').count(), 1);
    assert.equal(await rec.locator('.subs li[data-si="7"] .hchip.h-ok').count(), 1);
    assert.equal(await rec.locator('.subs li[data-si="8"] .hchip.h-weak').count(), 1, 'css-локатор із хеш-класом — слабкий (CSS зі стабільним id і n=1 тепер 🎯)');

    // ▶ Старт
    await card.getByRole('button', { name: /Запустити послідовність/ }).click();
    await card.getByRole('button', { name: /Зупинити прогін/ }).waitFor();
    await card.locator('.sc-lastrun').waitFor({ timeout: 120000 });
    // Legacy-клік — координатний; злитий текст (2 рядки) — однаковий статус.
    assert.match(await legacyClick.getAttribute('class'), /done|failed/);
    assert.match(await legacyClick.locator('.strat').innerText(), /📍|🧲/);
    const t4 = await rec.locator('.subs li[data-si="4"]').getAttribute('class');
    assert.equal(t4, await rec.locator('.subs li[data-si="5"]').getAttribute('class'));
    // Legacy-рухи миші завжди пропускаються.
    assert.match(await rec.locator('.moves-row').getAttribute('class'), /skipped/);
    // Неіснуючий локатор → помилка з текстом, failShot і швидкими виправленнями.
    const miss = rec.locator('.subs li[data-si="7"]');
    assert.match(await miss.getAttribute('class'), /failed/);
    assert.ok((await miss.locator('.err-text').innerText()).length > 3);
    await miss.locator('.failshot img').waitFor();
    // Альтернативний локатор: 🔁 + 🩹.
    const healed = rec.locator('.subs li[data-si="8"]');
    assert.match(await healed.getAttribute('class'), /done/);
    assert.match(await healed.locator('.strat').innerText(), /🔁 · \d+ мс/);
    assert.equal(await healed.locator('.tag.healed').count(), 1);
    // Підсумок.
    const live = await page.locator('#live').innerText();
    assert.match(live, /виконано \d+\/\d+ — успішно \d+, помилок 1 \(крок 8 у «Legacy»: /);
    assert.match(await card.locator('.sc-lastrun').innerText(), /помилок 1/);
    assert.match(await rec.locator('.meta').innerText(), /✗1/);
    assert.ok(await page.locator('#tabs .tab').count() >= 1, 'таб фінального скріна');

    // failShot збільшується в модалці (Esc закриває).
    await miss.locator('.failshot').click();
    await page.locator('dialog.shot-modal img').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('dialog.shot-modal').waitFor({ state: 'detached' });

    // Швидке виправлення «необовʼязковий».
    await miss.getByRole('button', { name: 'необовʼязковий' }).click();
    await rec.locator('.subs li[data-si="7"] .tag', { hasText: 'необов.' }).waitFor();

    // Редактор у модалці: текстовий крок → чип {d} → «Зберегти».
    const txt = rec.locator('.subs li[data-si="4"]');
    await txt.getByRole('button', { name: 'Редагувати крок' }).click();
    const ed = page.locator('dialog.step-modal form.step-editor');
    await ed.waitFor();
    await ed.getByLabel('Текст').fill('id');
    await ed.getByRole('button', { name: /Вставити випадкову цифру/ }).click();
    assert.equal(await ed.getByLabel('Текст').inputValue(), 'id{d}');
    assert.match(await ed.locator('.se-preview').innerText(), /🎲ц/);
    await ed.getByRole('button', { name: 'Зберегти' }).click();
    await ed.waitFor({ state: 'detached' });
    assert.match(await rec.locator('.subs li[data-si="4"] .desc').innerText(), /Ввести «id🎲ц»/);

    // Редактор v2: кандидати з ×n, Esc скасовує.
    const v2 = rec.locator('.subs li[data-si="8"]');
    await v2.getByRole('button', { name: 'Редагувати крок' }).click();
    const sel = page.locator('dialog.step-modal form.step-editor select');
    await sel.waitFor();
    const opts = await sel.locator('option').allInnerTexts();
    assert.deepEqual(opts.map((o) => o.replace(/\s+/g, ' ')), ['button._btn_f7cvd_3 ×1', 'role=button[name="Верхня"] ×1', '📍 лише координати']);
    await page.keyboard.press('Escape');
    await page.locator('dialog.step-modal').waitFor({ state: 'detached' });

    // Видалення кроку з «Скасувати».
    const before = await rec.locator('.subs li').count();
    await rec.locator('.subs li[data-si="6"]').getByRole('button', { name: 'Видалити крок' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.rec .subs li').length === n - 1, before);
    await page.locator('#toasts').getByRole('button', { name: 'Скасувати' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.rec .subs li').length === n, before);
    assert.match(await rec.locator('.subs li[data-si="6"] .desc').innerText(), /Клавіша: Tab/);

    // ⚡ Оптимізувати через меню Дії (прибирає 3 рухи + зливає текст).
    await rec.getByRole('button', { name: /Меню Дії/ }).click();
    await page.getByRole('menuitem', { name: /Оптимізувати/ }).click();
    await page.waitForFunction(() => !document.querySelector('.rec .moves-row'));
    assert.match(await page.locator('#toasts').innerText(), /прибрано 3 рухи/);

    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F2: ⏹ Стоп посеред прогону — швидке завершення, підсумок «зупинено»', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  try {
    const card = await createScenario(page, 'F2 stop', FX + '/click.html');
    await addRec(page, 'F2 stop', {
      id: 902, name: 'Довга',
      subs: [
        { v: 2, id: 's_k1', type: 'key', key: 'Tab' },
        { v: 2, id: 's_slow', type: 'click', timeout: 30000, target: { frame: null, locs: [{ by: 'role', role: 'button', name: 'Ніколи', exact: true, n: 1 }], pick: 0, kind: 'button', desc: 'кнопка «Ніколи»' } },
        { v: 2, id: 's_k2', type: 'key', key: 'Tab' },
      ],
    });
    await card.locator('.rec .subs li').first().waitFor();
    await card.getByRole('button', { name: /Запустити послідовність/ }).click();
    const slow = card.locator('.subs li[data-si="1"]');
    await page.waitForFunction(() => { const li = document.querySelector('.page .subs li[data-si="1"]'); return li && li.classList.contains('running'); }, null, { timeout: 120000 });
    const t0 = Date.now();
    await card.getByRole('button', { name: /Зупинити прогін/ }).click();
    await card.locator('.sc-lastrun').waitFor({ timeout: 20000 });
    assert.ok(Date.now() - t0 < 15000, 'Стоп не чекає 30-секундного таймауту кроку');
    assert.match(await card.locator('.sc-lastrun').getAttribute('class'), /stopped/);
    assert.match(await page.locator('#live').innerText(), /зупинено|перервано/);
    assert.match(await slow.getAttribute('class'), /skipped/);
    assert.notEqual(await card.locator('.subs li[data-si="2"]').getAttribute('class'), 'done');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F2: 390 px — картка, меню, редактор без горизонтальної прокрутки', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 390, height: 844 });
  try {
    const card = await createScenario(page, 'F2 mobile with a rather long scenario name to wrap', FX + '/click.html');
    await addRec(page, 'F2 mobile with a rather long scenario name to wrap', { id: 903, name: 'Mobile', subs: legacyRec.subs.map((s) => ({ ...s })) });
    const row = card.locator('.subs li[data-si="8"]');
    await row.waitFor();
    await row.getByRole('button', { name: 'Редагувати крок' }).click();
    await page.locator('dialog.step-modal form.step-editor').waitFor();
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, 'scrollWidth=' + sw);
    const mbox = await page.locator('dialog.step-modal').boundingBox();
    assert.ok(mbox.x >= 0 && mbox.x + mbox.width <= 390, 'модалка в межах екрана: ' + JSON.stringify(mbox));
    // < 600 px — на весь екран.
    assert.ok(mbox.x <= 1 && mbox.y <= 1 && mbox.width >= 389 && mbox.height >= 843, 'модалка на весь екран: ' + JSON.stringify(mbox));
    const save = await page.locator('dialog.step-modal').getByRole('button', { name: 'Зберегти' }).boundingBox();
    assert.ok(save && save.y + save.height <= 844, '«Зберегти» видно без прокрутки сторінки: ' + JSON.stringify(save));
    await page.keyboard.press('Escape');
    await page.locator('dialog.step-modal').waitFor({ state: 'detached' });
    await card.getByRole('button', { name: /Меню сценарію/ }).click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    // Перейменування inline через меню.
    await card.getByRole('button', { name: /Меню сценарію/ }).click();
    await page.getByRole('menuitem', { name: /Перейменувати/ }).click();
    const inp = page.getByRole('textbox', { name: 'Назва сценарію' });
    await inp.fill('Мобільний');
    await inp.press('Enter');
    await page.locator('.page .pname', { hasText: 'Мобільний' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ---------- F3: модалка кроку, пауза після кроку, обʼєднання тексту ----------
const field = (label, id) => ({ frame: null, locs: [{ by: 'label', value: label, exact: true, n: 1 }, { by: 'id', value: id, n: 1 }], pick: 0, kind: 'input', desc: 'поле «' + label + '»' });
const F_FIRST = field('Імʼя', 'first'), F_CITY = field('Місто', 'city');

// Рядки Дії видимі (після перезавантаження Дія може бути згорнута).
async function expandRec(rec) {
  const tg = rec.locator('.rec-head .tg');
  if ((await tg.getAttribute('aria-expanded')) === 'false') await tg.click();
  await rec.locator('.subs li[data-si]').first().waitFor();
}
const stepModal = (page) => page.locator('dialog.step-modal');
async function openEditor(row) {
  await row.getByRole('button', { name: 'Редагувати крок' }).click();
  const dlg = stepModal(row.page());
  await dlg.locator('form.step-editor').waitFor();
  return dlg;
}
// Кроки Дії з моделі UI (без тимчасових полів не фільтруємо — для перевірок досить).
const recSubs = (page, scenarioName, recName) => page.evaluate(async ({ scenarioName, recName }) => {
  const { state } = await import('/js/state.js');
  const p = state.pages.find((x) => x.name === scenarioName);
  return JSON.parse(JSON.stringify(p.recs.find((r) => r.name === recName).subs));
}, { scenarioName, recName });
async function serverSubs(page, scenarioName, recName) {
  const d = await page.evaluate(() => fetch('/pages').then((r) => r.json()));
  const p = (d.pages || []).find((x) => x.name === scenarioName);
  const r = p && p.recs.find((x) => x.name === recName);
  return r ? r.subs : null;
}
async function waitServer(page, scenarioName, recName, pred, what) {
  for (let i = 0; ; i++) {
    const subs = await serverSubs(page, scenarioName, recName);
    if (subs && pred(subs)) return subs;
    if (i > 60) assert.fail('не дочекались у GET /pages: ' + what + ' — ' + JSON.stringify(subs).slice(0, 400));
    await page.waitForTimeout(200);
  }
}
async function waitCount(loc, n, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const c = await loc.count();
    if (c === n) return;
    if (Date.now() - t0 > ms) assert.fail('очікували ' + n + ' рядків, є ' + c);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const fxLast = (prefix, since = 0) => fxEvents.slice(since).filter((x) => x.e.startsWith(prefix + ':')).at(-1);

test('e2e F3: модалка кроку — Esc/фон без змін, фокус на ✎; текст + пауза 1500 → чип «⏱ +1,5 с»; 70000 — помилка; очищення; після reload; ▶ пауза ≥ 1,4 с між кроками', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F3 пауза', RN = 'Друк';
  try {
    const card = await createScenario(page, SC, FX + '/typing.html');
    await addRec(page, SC, {
      id: 911, name: RN,
      subs: [
        { v: 2, id: 's_pa', type: 'text', text: 'A', target: F_FIRST },
        { v: 2, id: 's_pb', type: 'text', text: 'B', target: F_CITY },
      ],
    });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    const row0 = rec.locator('.subs li[data-si="0"]');
    assert.match(await row0.locator('.desc').innerText(), /Ввести «A»/);

    // Відкрити: заголовок «Крок 1 · «Друк»», підзаголовок — підпис кроку + чип здоровʼя.
    let dlg = await openEditor(row0);
    assert.equal(await dlg.locator('h2').innerText(), 'Крок 1 · «' + RN + '»');
    assert.match(await dlg.locator('.sem-sub').innerText(), /Ввести «A»/);
    assert.equal(await dlg.locator('.sem-sub .hchip.h-ok').count(), 1);
    assert.equal(await dlg.getAttribute('open'), '');
    // Esc → без змін, фокус повертається на ✎ цього рядка.
    await dlg.getByLabel('Текст').fill('змінено');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    await page.waitForFunction((name) => {
      const a = document.activeElement;
      const c = a && a.closest('.page');
      return !!a && /-edit$/.test(a.dataset.fk || '') && a.closest('li') && a.closest('li').dataset.si === '0' &&
        !!c && (c.querySelector('.pname') || {}).textContent === name;
    }, SC, { timeout: 5000 });
    assert.match(await row0.locator('.desc').innerText(), /Ввести «A»/);
    // Клік по фону → теж без змін.
    dlg = await openEditor(row0);
    await dlg.getByLabel('Текст').fill('змінено');
    await page.mouse.click(5, 5);
    await dlg.waitFor({ state: 'detached' });
    assert.match(await row0.locator('.desc').innerText(), /Ввести «A»/);
    // «✕ Закрити» → без змін.
    dlg = await openEditor(row0);
    await dlg.getByLabel('Пауза після кроку, мс').fill('999');
    await dlg.getByRole('button', { name: 'Закрити' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await row0.locator('.tag', { hasText: '⏱' }).count(), 0);

    // Текст + пауза 1500 → «Зберегти» → підпис і чип.
    dlg = await openEditor(row0);
    await dlg.getByLabel('Текст').fill('Anna');
    await dlg.getByLabel('Пауза після кроку, мс').fill('1500');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.match(await row0.locator('.desc').innerText(), /Ввести «Anna»/);
    assert.equal((await row0.locator('.tag', { hasText: '⏱' }).innerText()).trim(), '⏱ +1,5 с');
    assert.equal((await recSubs(page, SC, RN))[0].delayAfter, 1500);

    // 70000 → помилка валідації, модалка лишається; «Скасувати» → без змін.
    dlg = await openEditor(row0);
    assert.equal(await dlg.getByLabel('Пауза після кроку, мс').inputValue(), '1500');
    await dlg.getByLabel('Пауза після кроку, мс').fill('70000');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    assert.match(await dlg.locator('.se-err').innerText(), /Пауза — ціле число мс від 0 до 60000/);
    assert.equal(await dlg.count(), 1);
    assert.ok(await dlg.evaluate((d) => d.open), 'модалка лишається відкритою');
    await dlg.getByRole('button', { name: 'Скасувати' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal((await row0.locator('.tag', { hasText: '⏱' }).innerText()).trim(), '⏱ +1,5 с');

    // Очищення поля → чип зникає.
    dlg = await openEditor(row0);
    await dlg.getByLabel('Пауза після кроку, мс').fill('');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await row0.locator('.tag', { hasText: '⏱' }).count(), 0);
    assert.equal('delayAfter' in (await recSubs(page, SC, RN))[0], false);

    // Знову 1500 → збережено на сервері → reload → значення на місці.
    dlg = await openEditor(row0);
    await dlg.getByLabel('Пауза після кроку, мс').fill('1500');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    await waitServer(page, SC, RN, (s) => s[0].delayAfter === 1500 && s[0].text === 'Anna', 'delayAfter=1500, text=Anna');
    await page.reload();
    await page.locator('#pagesEl .page').first().waitFor();
    const card2 = page.locator('.page', { hasText: SC });
    const rec2 = card2.locator('.rec', { hasText: RN });
    await expandRec(rec2);
    const r0 = rec2.locator('.subs li[data-si="0"]');
    assert.match(await r0.locator('.desc').innerText(), /Ввести «Anna»/);
    assert.equal((await r0.locator('.tag', { hasText: '⏱' }).innerText()).trim(), '⏱ +1,5 с');
    dlg = await openEditor(r0);
    assert.equal(await dlg.getByLabel('Пауза після кроку, мс').inputValue(), '1500');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });

    // ▶ Старт: лог паузи; реальний проміжок між кінцем друку «Anna» і початком «B» ≥ 1,4 с
    // (час — з браузера фікстури) і між ✓ кроку 1 та ▶ кроку 2 у сайдбарі.
    await page.evaluate((name) => {
      const w = window; w.__f3 = { done0: 0, run1: 0, banner: '', chip: '' };
      w.__f3t = setInterval(() => {
        const c = [...document.querySelectorAll('.page')].find((x) => (x.querySelector('.pname') || {}).textContent === name);
        const l0 = c && c.querySelector('.rec .subs li[data-si="0"]'), l1 = c && c.querySelector('.rec .subs li[data-si="1"]');
        const now = performance.now();
        if (!w.__f3.done0 && l0 && l0.classList.contains('done')) w.__f3.done0 = now;
        if (!w.__f3.run1 && l1 && (l1.classList.contains('running') || l1.classList.contains('done'))) w.__f3.run1 = now;
        // Під час ⏱ паузи: смуга каже «пауза після кроку 1», а не «виконується крок 2»; чип кроку — .pausing.
        const bn = document.querySelector('.run-banner');
        if (!w.__f3.banner && bn && !bn.hidden && bn.textContent.startsWith('⏱')) w.__f3.banner = bn.textContent;
        const pc = l0 && l0.querySelector('.tag.pausing');
        if (!w.__f3.chip && pc) w.__f3.chip = pc.textContent;
      }, 10);
    }, SC);
    const ev0 = fxEvents.length;
    await card2.getByRole('button', { name: /Запустити послідовність/ }).click();
    await card2.locator('.sc-lastrun').waitFor({ timeout: 120000 });
    assert.match(await card2.locator('.sc-lastrun').innerText(), /помилок 0/);
    assert.match(await page.locator('#consoleBody').innerText(), /⏱ Пауза 1500 мс після кроку #1/);
    const a = fxLast('first', ev0), b = fxEvents.slice(ev0).find((x) => x.e.startsWith('city:'));
    assert.ok(a && b, 'ехо фікстури: ' + JSON.stringify(fxEvents.slice(ev0)));
    assert.equal(a.e, 'first:Anna');
    assert.equal(fxLast('city', ev0).e, 'city:B');
    const gap = b.t - a.t;
    assert.ok(gap >= 1400, 'проміжок між кроками (фікстура) ' + gap + ' мс');
    const ui = await page.evaluate(() => { clearInterval(window.__f3t); return window.__f3; });
    assert.ok(ui.done0 && ui.run1 && ui.run1 - ui.done0 >= 1400, 'проміжок ✓1 → ▶2 у сайдбарі: ' + JSON.stringify(ui));
    assert.match(ui.banner, /^⏱ «.+» · пауза 1,5 с після кроку 1\/2 — далі: /, 'смуга під час паузи: ' + JSON.stringify(ui));
    assert.match(ui.chip, /⏱ \+1,5 с · пауза…/);
    assert.equal(await card2.locator('.tag.pausing').count(), 0, 'після прогону чип паузи вже не «триває»');
    t.diagnostic('проміжок між кроками: фікстура ' + gap + ' мс, сайдбар ' + Math.round(ui.run1 - ui.done0) + ' мс');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F3: ⤵ обʼєднання тексту — legacy+v2, через приховані рухи, undo, неактивна для різних полів; прогін друкує злитий текст', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F3 злиття', RN = 'Злиття';
  try {
    const card = await createScenario(page, SC, FX + '/typing.html');
    await addRec(page, SC, {
      id: 912, name: RN,
      subs: [
        { v: 2, id: 's_c0', type: 'click', target: F_FIRST },
        { type: 'text', text: 'I' }, // legacy-символ
        { v: 2, id: 's_t2', type: 'text', text: 'van', target: F_FIRST },
        { v: 2, id: 's_t3', type: 'text', text: 'Ки', target: F_CITY },
        { type: 'move', x: 30, y: 30, sw: 1280, sh: 900 },
        { type: 'move', x: 40, y: 40, sw: 1280, sh: 900 },
        { v: 2, id: 's_t6', type: 'text', text: 'їв', target: F_CITY, delayAfter: 300 },
      ],
    });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    await waitCount(rec.locator('.subs li[data-si]'), 5); // 7 кроків: 2 рухи згорнуто в «+2 рухи»
    const row = (si) => rec.locator('.subs li[data-si="' + si + '"]');
    const mergeBtn = (si) => row(si).locator('button.op', { hasText: '⤵' });
    assert.equal(await rec.locator('.moves-row').count(), 1, 'рухи сховано');
    // Немає ⤵ на кліку; ⤵ на «Ки» (наступний видимий через рухи — «їв»).
    assert.equal(await mergeBtn(0).count(), 0);
    assert.equal(await mergeBtn(6).count(), 0, 'останній текст — без ⤵');
    // Різні поля: «van» (Імʼя) → «Ки» (Місто) — неактивна з поясненням.
    assert.ok(await mergeBtn(2).isDisabled());
    assert.equal(await mergeBtn(2).getAttribute('title'), 'Не можна обʼєднати: Кроки вводять текст у різні поля');
    assert.equal(await mergeBtn(2).getAttribute('aria-label'), 'Не можна обʼєднати: Кроки вводять текст у різні поля');

    // legacy «I» + v2 «van» → один крок «Ivan»; undo відновлює.
    assert.ok(await mergeBtn(1).isEnabled());
    assert.match(await mergeBtn(1).getAttribute('aria-label'), /Обʼєднати з наступним/);
    await mergeBtn(1).click();
    await waitCount(rec.locator('.subs li[data-si]'), 4);
    assert.match(await row(1).locator('.desc').innerText(), /Ivan/);
    assert.match(await page.locator('#toasts').innerText(), /Обʼєднано/);
    let subs = await recSubs(page, SC, RN);
    assert.equal(subs.length, 6);
    assert.equal(subs[1].v, 2);
    assert.equal(subs[1].text, 'Ivan');
    assert.deepEqual(subs[1].target, F_FIRST, 'ціль — від другого кроку (у legacy її немає)');
    await page.locator('#toasts').getByRole('button', { name: 'Скасувати' }).click();
    await waitCount(rec.locator('.subs li[data-si]'), 5);
    subs = await recSubs(page, SC, RN);
    assert.equal(subs.length, 7);
    assert.equal(subs[1].text, 'I');
    assert.equal(subs[1].v, undefined);
    assert.match(await row(2).locator('.desc').innerText(), /van/);
    // Ще раз — і лишаємо.
    await mergeBtn(1).click();
    await waitCount(rec.locator('.subs li[data-si]'), 4);

    // Рухи показано → наступний видимий після «Ки» — рух, ⤵ зникає; сховано — повертається.
    assert.ok(await mergeBtn(2).isEnabled());
    await rec.getByRole('button', { name: /Меню Дії/ }).click();
    await page.getByRole('menuitem', { name: /Показати рухи/ }).click();
    await waitCount(rec.locator('.subs li[data-si]'), 6);
    assert.equal(await mergeBtn(2).count(), 0, 'поруч рух — ⤵ немає');
    await rec.getByRole('button', { name: /Сховати 2 рухи/ }).click();
    await waitCount(rec.locator('.subs li[data-si]'), 4);
    // «Ки» + (2 приховані рухи) + «їв» → «Київ», рухи на місці, пауза від другого.
    assert.ok(await mergeBtn(2).isEnabled());
    await mergeBtn(2).click();
    await waitCount(rec.locator('.subs li[data-si]'), 3);
    assert.match(await row(2).locator('.desc').innerText(), /Київ/);
    assert.equal((await row(2).locator('.tag', { hasText: '⏱' }).innerText()).trim(), '⏱ +300 мс');
    assert.equal(await rec.locator('.moves-row').count(), 1, 'рухи лишились');
    subs = await recSubs(page, SC, RN);
    assert.deepEqual(subs.map((s) => s.type), ['click', 'text', 'text', 'move', 'move']);
    assert.equal(subs[2].text, 'Київ');
    assert.equal(subs[2].delayAfter, 300);
    await waitServer(page, SC, RN, (s) => s.length === 5 && s[1].text === 'Ivan' && s[2].text === 'Київ', 'злиті кроки');

    // Прогін: у поля фікстури надруковано злитий текст.
    const ev0 = fxEvents.length;
    await card.getByRole('button', { name: /Запустити послідовність/ }).click();
    await card.locator('.sc-lastrun').waitFor({ timeout: 120000 });
    assert.match(await card.locator('.sc-lastrun').innerText(), /помилок 0/);
    assert.equal((fxLast('first', ev0) || {}).e, 'first:Ivan', JSON.stringify(fxEvents.slice(ev0)));
    assert.equal((fxLast('city', ev0) || {}).e, 'city:Київ', JSON.stringify(fxEvents.slice(ev0)));
    assert.match(await row(1).getAttribute('class'), /done/);
    assert.match(await row(2).getAttribute('class'), /done/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F3: 390×844 — модалка тексту на весь екран, «Зберегти» видно, пауза зберігається, без горизонтальної прокрутки', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 390, height: 844 });
  const SC = 'F3 мобільний', RN = 'Моб';
  try {
    const card = await createScenario(page, SC, FX + '/typing.html');
    await addRec(page, SC, { id: 913, name: RN, subs: [
      { v: 2, id: 's_m0', type: 'text', text: 'a', target: F_FIRST },
      { v: 2, id: 's_m1', type: 'text', text: 'b', target: F_FIRST },
    ] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    assert.ok(await rec.locator('.subs li[data-si="0"] button.op', { hasText: '⤵' }).isEnabled());
    const dlg = await openEditor(rec.locator('.subs li[data-si="0"]'));
    const box = await dlg.boundingBox();
    assert.ok(box.x <= 1 && box.y <= 1 && box.width >= 389 && box.width <= 391 && box.height >= 843, 'на весь екран: ' + JSON.stringify(box));
    const save = await dlg.getByRole('button', { name: 'Зберегти' }).boundingBox();
    assert.ok(save && save.y >= 0 && save.y + save.height <= 844 && save.x >= 0 && save.x + save.width <= 390, '«Зберегти» у вʼюпорті: ' + JSON.stringify(save));
    assert.ok(save.height >= 40, '«Зберегти» торкабельного розміру: ' + JSON.stringify(save));
    const pause = dlg.getByLabel('Пауза після кроку, мс');
    await pause.fill('250');
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, dsw: document.querySelector('dialog.step-modal').scrollWidth }));
    assert.ok(sw.sw <= 390 && sw.dsw <= 390, 'без горизонтальної прокрутки: ' + JSON.stringify(sw));
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal((await rec.locator('.subs li[data-si="0"] .tag', { hasText: '⏱' }).innerText()).trim(), '⏱ +250 мс');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ---------- F4: автопокращення цілі старого кроку «Файл» (⚠ → 🎯 після одного ▶) ----------
// Старий крок, записаний до локатора input[type=file]: лише CSS-шлях із хеш-класом CSS-модуля
// (як реальний крок Ashby). Фікстура upload-cssmod.html (поле файлу в same-origin iframe).
const OLD_FILE_CSS = 'div._container_f7cvd_28 > input._input_f7cvd_50';
const oldFileStep = (id, up) => ({
  v: 2, id, type: 'file', fileId: up.fileId, filename: up.filename,
  target: { pick: 0, frame: { chain: ['iframe#ashby_embed_iframe'] }, locs: [{ n: 1, by: 'css', nth: null, value: OLD_FILE_CSS }] },
});
async function uploadFx(name) {
  const r = await fetch(base + '/upload', { method: 'POST', headers: { 'x-filename': name, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 f4 e2e') });
  assert.equal(r.status, 200);
  return r.json();
}
// Проміжок між низом останньої Дії і низом картки сценарію (px).
const lastRecGap = (card) => card.evaluate((c) => {
  const recs = c.querySelectorAll('.page-recs > .rec');
  const last = recs[recs.length - 1];
  return { gap: c.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom, n: recs.length };
});
const upgradeLogCount = async (page) => ((await page.locator('#consoleBody').textContent()) || '').split('стане надійнішою').length - 1;

test('e2e F4: старий крок «Файл» (лише CSS з хешем) → ⚠; ▶ Старт → лог 🎯, 🎯 у рядку, GET /pages: pick=type n=1; reload — 🎯; повторний ▶ — без нового upgrade; без проміжку під останньою Дією', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F4 upgrade', RN = 'Старий Ashby';
  try {
    const up = await uploadFx('cv.pdf');
    const card = await createScenario(page, SC, FX + '/upload-cssmod.html');
    await addRec(page, SC, { id: 921, name: RN, subs: [oldFileStep('s_oldfile', up)] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    const row = rec.locator('.subs li[data-si="0"]');
    assert.equal(await row.locator('.hchip.h-weak').count(), 1, 'старий крок — ⚠');
    await waitServer(page, SC, RN, (s) => s.length === 1 && s[0].target.locs.length === 1, 'засіяний старий крок');

    // Без проміжку під останньою Дією (десктоп).
    const g = await lastRecGap(card);
    assert.ok(g.n === 1 && g.gap >= 0 && g.gap <= 1, 'проміжок під останньою Дією: ' + JSON.stringify(g));

    // ▶ Старт → крок ок, файл у полі, лог покращення, 🎯.
    const ev0 = fxEvents.length;
    const logs0 = await upgradeLogCount(page);
    await card.getByRole('button', { name: /Запустити послідовність/ }).click();
    await card.locator('.sc-lastrun').waitFor({ timeout: 120000 });
    assert.match(await card.locator('.sc-lastrun').innerText(), /помилок 0/);
    assert.match(await row.getAttribute('class'), /\bdone\b/);
    assert.deepEqual(fxEvents.slice(ev0).map((x) => x.e), ['resume:cv.pdf']);
    const con = await page.locator('#consoleBody').textContent();
    assert.match(con, /🎯 Ціль «[^»]*» стане надійнішою: input\[type="file"\]/);
    assert.match(con, /🎯 Надійнішу ціль отримали 1 крок — сценарій збережено\./);
    assert.equal(await upgradeLogCount(page), logs0 + 1);
    await row.locator('.hchip.h-ok').waitFor();
    assert.equal(await row.locator('.hchip.h-weak').count(), 0);

    // Збережено на ТЕСТОВОМУ сервері: pick → {by:'type', n:1}; CSS лишився кандидатом.
    const subs = await waitServer(page, SC, RN, (s) => { const tg = s[0].target; return tg.locs[tg.pick] && tg.locs[tg.pick].by === 'type'; }, 'pick → type');
    const tg = subs[0].target;
    assert.deepEqual(tg.locs[tg.pick], { by: 'type', tag: 'input', value: 'file', n: 1 });
    assert.ok(tg.locs.some((l) => l.by === 'css' && l.value === OLD_FILE_CSS), 'CSS-кандидат збережено: ' + JSON.stringify(tg.locs));
    assert.deepEqual(tg.frame, { chain: ['iframe#ashby_embed_iframe'] });
    assert.equal(subs[0].status, undefined, 'без тимчасових полів');

    // reload → 🎯 лишається.
    await page.reload();
    await page.locator('#pagesEl .page').first().waitFor();
    const card2 = page.locator('.page', { hasText: SC });
    const rec2 = card2.locator('.rec', { hasText: RN });
    await expandRec(rec2);
    const row2 = rec2.locator('.subs li[data-si="0"]');
    assert.equal(await row2.locator('.hchip.h-ok').count(), 1, 'після reload — 🎯');

    // Повторний ▶ — ок за локатором, без нового покращення.
    const ev1 = fxEvents.length;
    const logs1 = await upgradeLogCount(page);
    await card2.getByRole('button', { name: /Запустити послідовність/ }).click();
    await card2.locator('.sc-lastrun').waitFor({ timeout: 120000 });
    assert.match(await card2.locator('.sc-lastrun').innerText(), /помилок 0/);
    assert.deepEqual(fxEvents.slice(ev1).map((x) => x.e), ['resume:cv.pdf']);
    assert.match(await row2.locator('.strat').innerText(), /🎯/);
    assert.equal(await upgradeLogCount(page), logs1, 'повторний прогін не покращує ще раз');
    // Консоль після reload — лише повторний прогін: ні рядка покращення, ні підсумку.
    assert.equal(logs1, 0);
    assert.doesNotMatch((await page.locator('#consoleBody').textContent()) || '', /Надійнішу ціль отримали/);
    assert.equal(await row2.locator('.hchip.h-ok').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F4: ✎ на свіжому старому кроці «Файл» — input[type="file"] першим у списку; вибір + «Зберегти» зберігається; без проміжку під останньою Дією', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F4 editor', RN = 'Старий файл';
  try {
    const up = await uploadFx('cv.pdf');
    const card = await createScenario(page, SC, FX + '/upload-cssmod.html');
    await addRec(page, SC, { id: 922, name: RN, subs: [oldFileStep('s_oldfile2', up)] });
    await addRec(page, SC, { id: 923, name: 'Друга', subs: [{ v: 2, id: 's_tab', type: 'key', key: 'Tab' }] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    const row = rec.locator('.subs li[data-si="0"]');
    assert.equal(await row.locator('.hchip.h-weak').count(), 1);
    const dlg = await openEditor(row);
    const sel = dlg.getByLabel('Ціль', { exact: true });
    const opts = (await sel.locator('option').allInnerTexts()).map((o) => o.replace(/\s+/g, ' ').trim());
    assert.deepEqual(opts, ['input[type="file"]', OLD_FILE_CSS + ' ×1']);
    assert.equal(await sel.inputValue(), '1', 'спершу вибрано записаний CSS (pick не змінено міграцією)');
    await sel.selectOption('0');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    const subs = await waitServer(page, SC, RN, (s) => s[0].target.pick === 0 && s[0].target.locs[0].by === 'type', 'pick=0 → input[type=file]');
    assert.deepEqual(subs[0].target.locs.map((l) => l.by), ['type', 'css']);
    assert.equal(subs[0].fileId, up.fileId);
    // Після reload вибір на місці.
    await page.reload();
    await page.locator('#pagesEl .page').first().waitFor();
    const rec2 = page.locator('.page', { hasText: SC }).locator('.rec', { hasText: RN });
    await expandRec(rec2);
    const dlg2 = await openEditor(rec2.locator('.subs li[data-si="0"]'));
    assert.equal(await dlg2.getByLabel('Ціль', { exact: true }).inputValue(), '0');
    await page.keyboard.press('Escape');
    await dlg2.waitFor({ state: 'detached' });
    const g = await lastRecGap(page.locator('.page', { hasText: SC }));
    assert.ok(g.n === 2 && g.gap >= 0 && g.gap <= 1, 'проміжок під останньою Дією: ' + JSON.stringify(g));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F4: 390 px — остання Дія без проміжку до низу картки (розгорнута і згорнута)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 390, height: 844 });
  const SC = 'F4 mobile gap';
  try {
    const card = await createScenario(page, SC, FX + '/click.html');
    await addRec(page, SC, { id: 924, name: 'Перша', subs: [{ v: 2, id: 's_g1', type: 'key', key: 'Tab' }] });
    await addRec(page, SC, { id: 925, name: 'Остання', subs: [{ v: 2, id: 's_g2', type: 'key', key: 'Tab' }, { v: 2, id: 's_g3', type: 'key', key: 'Enter' }] });
    const last = card.locator('.rec', { hasText: 'Остання' });
    await expandRec(last);
    let g = await lastRecGap(card);
    assert.ok(g.n === 2 && g.gap >= 0 && g.gap <= 1, 'розгорнута: ' + JSON.stringify(g));
    await last.locator('.rec-head .tg').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.rec')].some((r) => r.textContent.includes('Остання') && r.querySelector('.rec-head .tg').getAttribute('aria-expanded') === 'false'));
    g = await lastRecGap(card);
    assert.ok(g.gap >= 0 && g.gap <= 1, 'згорнута: ' + JSON.stringify(g));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ---------- F5: реальний крок Ashby — input[type=file] ×2, ціль під хеш-класом ----------
// Збережений крок користувача: pick = input[type=file] (вибрав сам, n невідомий), запасний —
// CSS-шлях із хешем CSS-модуля. На формі ДВА поля файлу (автозаповнення з резюме + Resume),
// тож type неоднозначний; міграція додає очищений шлях, він унікальний → після прогону
// pick переходить на нього (🎯), наступні прогони — без «🔁 альтернативним».
const ASHBY_HASHED = 'div#form > div.ashby-application-form-autofill-uploader._container_f7cvd_28 > div.ashby-application-form-autofill-input-root > input';
const ASHBY_CLEAN = 'div#form > div.ashby-application-form-autofill-uploader > div.ashby-application-form-autofill-input-root > input';
const ashbyUserStep = (id, up) => ({
  v: 2, id, type: 'file', fileId: up.fileId, filename: up.filename,
  target: { pick: 0, frame: { chain: ['iframe#ashby_embed_iframe'] }, kind: 'file', desc: 'поле файлу',
    locs: [{ by: 'type', tag: 'input', value: 'file' }, { by: 'css', value: ASHBY_HASHED, nth: null, n: 1 }] },
});
const consoleText = async (page) => (await page.locator('#consoleBody').textContent()) || '';
const countIn = (s, needle) => s.split(needle).length - 1;
async function runCard(card) {
  await card.getByRole('button', { name: /Запустити послідовність/ }).click();
  await card.locator('.sc-lastrun').waitFor({ timeout: 120000 });
  assert.match(await card.locator('.sc-lastrun').innerText(), /помилок 0/);
}

test('e2e F5: крок Ashby (type ×2 + хеш-CSS) → ⚠; ▶ — файл у потрібне поле, лог 🎯 з очищеним CSS, 🎯 у рядку, GET /pages: pick → очищений CSS n=1; reload — 🎯; повтор — без 🔁/🎯-логу; deploy=2 — loc', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F5 ashby', RN = 'Ashby резюме';
  try {
    const up = await uploadFx('cv.pdf');
    const card = await createScenario(page, SC, FX + '/upload-cssmod.html?autofill=1');
    await addRec(page, SC, { id: 931, name: RN, subs: [ashbyUserStep('s_ashby', up)] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    const row = rec.locator('.subs li[data-si="0"]');
    assert.equal(await row.locator('.hchip.h-weak').count(), 1, 'крок користувача — ⚠ (type без n)');
    await waitServer(page, SC, RN, (s) => s.length === 1 && s[0].target.locs.length === 2, 'засіяний крок');
    const g = await lastRecGap(card);
    assert.ok(g.n === 1 && g.gap >= 0 && g.gap <= 1, 'проміжок під останньою Дією: ' + JSON.stringify(g));

    // ▶ Старт: type ×2 → знайдено очищеним CSS (🔁 один раз), файл — у поле автозаповнення.
    const ev0 = fxEvents.length;
    await runCard(card);
    assert.match(await row.getAttribute('class'), /\bdone\b/);
    assert.deepEqual(fxEvents.slice(ev0).map((x) => x.e), ['autofill:cv.pdf'], 'файл у потрібному полі (не Resume)');
    const con = await consoleText(page);
    assert.ok(con.includes('🔁 Ціль «поле файлу» знайдено альтернативним локатором ' + ASHBY_CLEAN), con.slice(-1500));
    assert.ok(con.includes('🎯 Ціль «поле файлу» стане надійнішою: ' + ASHBY_CLEAN + ' (той самий елемент, 1 збіг)'), con.slice(-1500));
    assert.equal(countIn(con, 'стане надійнішою'), 1);
    assert.match(con, /🎯 Надійнішу ціль отримали 1 крок — сценарій збережено\./);
    await row.locator('.hchip.h-ok').waitFor();
    assert.equal(await row.locator('.hchip.h-weak').count(), 0);

    // Збережено на ТЕСТОВОМУ сервері: pick → очищений CSS з n=1; type і хешований — кандидати.
    const subs = await waitServer(page, SC, RN, (s) => { const tg = s[0].target; return tg.locs[tg.pick] && tg.locs[tg.pick].value === ASHBY_CLEAN; }, 'pick → очищений CSS');
    const tg = subs[0].target;
    assert.deepEqual(tg.locs[tg.pick], { by: 'css', value: ASHBY_CLEAN, nth: null, n: 1 });
    assert.deepEqual(tg.locs.map((l) => [l.by, l.value]), [['type', 'file'], ['css', ASHBY_CLEAN], ['css', ASHBY_HASHED]]);
    assert.deepEqual(tg.frame, { chain: ['iframe#ashby_embed_iframe'] });
    assert.equal(subs[0].fileId, up.fileId);
    assert.equal(subs[0].status, undefined, 'без тимчасових полів');

    // reload → 🎯 лишається.
    await page.reload();
    await page.locator('#pagesEl .page').first().waitFor();
    const card2 = page.locator('.page', { hasText: SC });
    const rec2 = card2.locator('.rec', { hasText: RN });
    await expandRec(rec2);
    const row2 = rec2.locator('.subs li[data-si="0"]');
    assert.equal(await row2.locator('.hchip.h-ok').count(), 1, 'після reload — 🎯');

    // Повторний ▶: знайдено самим pick-ом — без «🔁 альтернативним» і без покращення.
    const ev1 = fxEvents.length;
    await runCard(card2);
    assert.deepEqual(fxEvents.slice(ev1).map((x) => x.e), ['autofill:cv.pdf']);
    assert.match(await row2.locator('.strat').innerText(), /🎯/);
    const con2 = await consoleText(page);
    assert.equal(countIn(con2, 'альтернативним'), 0, con2.slice(-1500));
    assert.equal(countIn(con2, 'стане надійнішою'), 0);
    assert.doesNotMatch(con2, /Надійнішу ціль отримали/);
    assert.equal(await row2.locator('.hchip.h-ok').count(), 1);

    // Новий білд сайту (deploy=2: інший хеш + банер/обгортка): очищений pick і далі — loc.
    const SC3 = 'F5 ashby deploy2';
    const card3 = await createScenario(page, SC3, FX + '/upload-cssmod.html?autofill=1&deploy=2');
    await addRec(page, SC3, { id: 932, name: RN, subs: JSON.parse(JSON.stringify(subs)).map((s) => ({ ...s, id: 's_ashby2' })) });
    const rec3 = card3.locator('.rec', { hasText: RN });
    await expandRec(rec3);
    const row3 = rec3.locator('.subs li[data-si="0"]');
    assert.equal(await row3.locator('.hchip.h-ok').count(), 1);
    const ev2 = fxEvents.length;
    const before3 = await consoleText(page);
    await runCard(card3);
    assert.deepEqual(fxEvents.slice(ev2).map((x) => x.e), ['autofill:cv.pdf'], 'deploy=2: файл у потрібному полі');
    assert.match(await row3.locator('.strat').innerText(), /🎯/);
    const con3 = (await consoleText(page)).slice(before3.length);
    assert.equal(countIn(con3, 'альтернативним'), 0, con3.slice(-1500));
    assert.equal(countIn(con3, 'стане надійнішою'), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F5: ✎ на кроці Ashby — мігровані кандидати у списку (очищений CSS); вибір + «Зберегти» зберігається; ▶ — n=1 → 🎯', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi();
  const SC = 'F5 editor', RN = 'Ashby ✎';
  try {
    const up = await uploadFx('cv.pdf');
    const card = await createScenario(page, SC, FX + '/upload-cssmod.html?autofill=1');
    await addRec(page, SC, { id: 933, name: RN, subs: [ashbyUserStep('s_ashby_ed', up)] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    const row = rec.locator('.subs li[data-si="0"]');
    const dlg = await openEditor(row);
    const sel = dlg.getByLabel('Ціль', { exact: true });
    const opts = (await sel.locator('option').allInnerTexts()).map((o) => o.replace(/\s+/g, ' ').trim());
    assert.deepEqual(opts, ['input[type="file"]', ASHBY_CLEAN, ASHBY_HASHED + ' ×1']);
    assert.equal(await sel.inputValue(), '0', 'вибрано збережений pick (input[type=file])');
    await sel.selectOption('1');
    await dlg.getByRole('button', { name: 'Зберегти' }).click();
    await dlg.waitFor({ state: 'detached' });
    const subs = await waitServer(page, SC, RN, (s) => s[0].target.pick === 1 && s[0].target.locs.length === 3, 'pick=1 → очищений CSS');
    assert.deepEqual(subs[0].target.locs[1], { by: 'css', value: ASHBY_CLEAN, nth: null });
    assert.deepEqual(subs[0].target.locs.map((l) => l.by), ['type', 'css', 'css']);
    assert.equal(subs[0].fileId, up.fileId);
    // reload → вибір на місці.
    await page.reload();
    await page.locator('#pagesEl .page').first().waitFor();
    const card2 = page.locator('.page', { hasText: SC });
    const rec2 = card2.locator('.rec', { hasText: RN });
    await expandRec(rec2);
    const row2 = rec2.locator('.subs li[data-si="0"]');
    const dlg2 = await openEditor(row2);
    assert.equal(await dlg2.getByLabel('Ціль', { exact: true }).inputValue(), '1');
    await page.keyboard.press('Escape');
    await dlg2.waitFor({ state: 'detached' });
    // n ще невідомий → ⚠; ▶ — знайдено самим pick-ом (1 збіг) → пряме покращення n=1 → 🎯.
    assert.equal(await row2.locator('.hchip.h-weak').count(), 1);
    const ev0 = fxEvents.length;
    await runCard(card2);
    assert.deepEqual(fxEvents.slice(ev0).map((x) => x.e), ['autofill:cv.pdf']);
    const con = await consoleText(page);
    assert.equal(countIn(con, 'альтернативним'), 0, con.slice(-1500));
    assert.ok(con.includes('🎯 Ціль «поле файлу» стане надійнішою: ' + ASHBY_CLEAN), con.slice(-1500));
    await row2.locator('.hchip.h-ok').waitFor();
    await waitServer(page, SC, RN, (s) => s[0].target.pick === 1 && s[0].target.locs[1].n === 1, 'n=1 після прогону');
    const g = await lastRecGap(card2);
    assert.ok(g.n === 1 && g.gap >= 0 && g.gap <= 1, 'проміжок під останньою Дією: ' + JSON.stringify(g));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('e2e F5: 390 px — крок Ashby ▶ → 🎯; остання Дія без проміжку до низу картки', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const { ctx, page, errors } = await openUi({ width: 390, height: 844 });
  const SC = 'F5 mobile', RN = 'Ashby 390';
  try {
    const up = await uploadFx('cv.pdf');
    const card = await createScenario(page, SC, FX + '/upload-cssmod.html?autofill=1');
    await addRec(page, SC, { id: 934, name: 'Перша', subs: [{ v: 2, id: 's_m1', type: 'key', key: 'Tab' }] });
    await addRec(page, SC, { id: 935, name: RN, subs: [ashbyUserStep('s_ashby_m', up)] });
    const rec = card.locator('.rec', { hasText: RN });
    await expandRec(rec);
    let g = await lastRecGap(card);
    assert.ok(g.n === 2 && g.gap >= 0 && g.gap <= 1, 'до прогону: ' + JSON.stringify(g));
    const ev0 = fxEvents.length;
    await runCard(card);
    assert.deepEqual(fxEvents.slice(ev0).map((x) => x.e), ['autofill:cv.pdf']);
    await rec.locator('.subs li[data-si="0"] .hchip.h-ok').waitFor();
    g = await lastRecGap(card);
    assert.ok(g.gap >= 0 && g.gap <= 1, 'після прогону: ' + JSON.stringify(g));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
