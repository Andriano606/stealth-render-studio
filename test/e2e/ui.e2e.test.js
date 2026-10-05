// E2E (opt-in, E2E=1): ІНТЕГРАЦІЯ всього UI — справжній `node server.js` (дочірній процес) +
// headless Chrome, що керує сторінкою застосунку як користувач, + локальна фікстура
// test/fixtures/apply.html (поле з підписом, асинхронний div-дропдаун, нативний <select>,
// прихований file-input за кнопкою, submit у same-origin iframe, повідомлення з результатом).
//
// Сервер стартує на ВЛАСНОМУ порту (UI_PORT або вільний), без БД (DATABASE_URL на мертвий
// порт → сценарії в памʼяті процесу), profile.json і uploads — у тимчасовій теці.
// UI_BASE=http://localhost:<порт> — замість запуску ганяти проти вже запущеного ТЕСТОВОГО
// сервера (не 3000!). FX_PORT — порт фікстурного сервера (за замовчуванням вільний).
// UI_SHOTS=<тека> — зберегти скріни final-{desktop,mobile}-*.png. UI_HUMANIZE=1 — людська поведінка.
// UI_TMP=<тека> — де створити тимчасову теку з profile.json/uploads (за замовчуванням os.tmpdir()).
//
// Потоки: (1) сценарій через діалог; (2) ⏺ Записати → живий перегляд → клік/друк/дропдаун/
// select/файл/iframe-submit → ⏹ Готово; (3) семантичні підписи з 🎯 і дані в /pages;
// (4) ▶ Старт → усі ✓ зі стратегією 🎯, «помилок 0», новий таб; (5) зсунута верстка
// (?shift=1) → усе ще ✓; (6) 390×844: перемикач панелей, без горизонтальної прокрутки,
// тулбар запису; (7) legacy-сценарій: «+N рухів» згорнуто і прогін завершується.
// Запуск: E2E=1 node --test test/e2e/ui.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const E2E = process.env.E2E === '1';
const EXTERNAL = (process.env.UI_BASE || '').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const SHOTS = process.env.UI_SHOTS || '';
const HUMANIZE = process.env.UI_HUMANIZE === '1';
const opts = { skip: !E2E, timeout: 240000 };

let fsrv, FX, tmp, child, childLog = '', base, browser;
const fxEvents = [];
const ctx = {}; // спільний стан між послідовними тестами
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, { ms = 30000, step = 150, what = 'умова' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error('Не дочекались: ' + what + (last instanceof Error ? ' (' + last.message + ')' : ''));
    await sleep(step);
  }
}

before(async () => {
  if (!E2E) return;
  // Фікстурний сайт: *.html з test/fixtures + /log (події сторінки).
  fsrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/log') { fxEvents.push(u.searchParams.get('e')); res.end('ok'); return; }
    const f = path.join(FIX, path.basename(u.pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => fsrv.listen(Number(process.env.FX_PORT) || 0, '127.0.0.1', r));
  FX = 'http://127.0.0.1:' + fsrv.address().port;

  if (EXTERNAL) {
    if (/:3000\b/.test(EXTERNAL)) throw new Error('UI_BASE не може бути робочим сервером на :3000');
    base = EXTERNAL;
  } else {
    const port = Number(process.env.UI_PORT) || await freePort();
    if (port === 3000) throw new Error('UI_PORT не може бути 3000 (робочий сервер)');
    fs.mkdirSync(process.env.UI_TMP || os.tmpdir(), { recursive: true });
    tmp = fs.mkdtempSync(path.join(process.env.UI_TMP || os.tmpdir(), 'srs-ui-e2e-'));
    // Швидкий, але «справжній» профіль: дефолтний стелс, лише humanize вимкнено (якщо не UI_HUMANIZE=1).
    fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify({ behavior: { humanize: HUMANIZE, prepareScroll: true, fastPrefix: !HUMANIZE } }));
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(port), HOST: '127.0.0.1',
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
        PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });
    base = 'http://127.0.0.1:' + port;
  }
  // Сервер готовий, коли пул прогрітий (старт браузера — до ~100 с).
  await waitFor(async () => {
    if (child && child.exitCode != null) throw new Error('server.js завершився: ' + childLog.slice(-800));
    const r = await fetch(base + '/health');
    const hl = await r.json();
    return hl.ok && hl.poolReady > 0;
  }, { ms: 150000, step: 500, what: '/health poolReady' });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
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
  if (fsrv) fsrv.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- Хелпери ----------
// waitForFunction не чекає проміс (async-предикат завжди «truthy») → state UI — у window.__st.
const hookState = (ui) => ui.evaluate(async () => { window.__st = (await import('/js/state.js')).state; });
async function reloadUi(ui) {
  await ui.reload();
  await ui.waitForSelector('#newPageBtn');
  await hookState(ui);
  await ui.waitForFunction(() => window.__st && window.__st.db != null);
}
async function openUi(viewport, { touch = false } = {}) {
  const ui = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  const errors = [];
  ui.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  ui.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await ui.goto(base + '/');
  await ui.waitForSelector('#newPageBtn');
  await hookState(ui);
  // Сценарії завантажено (loadPages → state.db визначено) і чип конфігу заповнено.
  await ui.waitForFunction(() => window.__st && window.__st.db != null);
  await ui.waitForFunction(() => !/…/.test(document.getElementById('hdrConfigChip').textContent));
  return { ui, errors };
}

// Текст локатора з опитуванням (рендер сайдбару — у наступному кадрі).
async function expectText(loc, re, ms = 10000) {
  let last = '';
  try {
    await waitFor(async () => re.test(last = await loc.innerText()), { ms, what: String(re) });
  } catch (_e) { assert.match(last, re); }
  return last;
}

async function shot(ui, name) {
  if (!SHOTS) return;
  await sleep(250);
  await ui.screenshot({ path: path.join(SHOTS, 'final-' + name + '.png') });
}

const uiState = (ui) => ui.evaluate(async () => {
  const { state } = await import('/js/state.js');
  return {
    running: state.running, recording: state.recording, live: state.live, screens: state.screens.length,
    pages: state.pages.map((p) => ({ id: p.id, name: p.name, url: p.url, lastRun: p.lastRun || null,
      recs: p.recs.map((r) => ({ id: r.id, name: r.name, subs: r.subs })) })),
  };
});

const pageByName = (st, name) => st.pages.find((p) => p.name === name);

// Кроки поточної Дії запису: ≥ n і жодного pending.
async function waitRecSubs(ui, n, ms = 30000) {
  return waitFor(async () => {
    const st = await uiState(ui);
    const p = st.pages.find((x) => st.live && x.id === st.live.pageId);
    const rec = p && p.recs.find((r) => r.id === st.live.recId);
    const subs = rec ? rec.subs : [];
    return subs.length >= n && subs.every((s) => !s.pending) ? subs : null;
  }, { ms, what: n + ' підтверджених кроків запису' });
}

// Центри елементів фікстури у viewport сесії (та сама верстка, ширина = ширина сесії).
async function measure(url, vp) {
  if (!vp) throw new Error('measure: немає розміру viewport');
  const p = await browser.newPage({ viewport: vp });
  // domcontentloaded: boundingBox() локаторів сам чекає елементи (і iframe); «load» під
  // навантаженням машини інколи висів > 30 с на допоміжній вкладці.
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  const c = async (loc) => { const b = await loc.boundingBox(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; };
  const out = {
    name: await c(p.locator('#fullname')),
    ddopen: await c(p.locator('#ddopen')),
    level: await c(p.locator('#level')),
    cvbtn: await c(p.locator('#cvbtn')),
    send: await c(p.frameLocator('#frm').locator('#send')),
  };
  await p.click('#ddopen');
  out.lviv = await c(p.locator('.dd-option', { hasText: 'Львів' }));
  await p.close();
  return out;
}

// Клік/тап по живому зображенню в точці viewport (vx, vy): content-box <img> → клієнтські px.
// У режимі «1:1» (мобільний за замовчуванням) кадр ширший/вищий за панель — спершу прокручуємо до точки.
async function clickLive(ui, pt, { tap = false } = {}) {
  const img = ui.locator('#liveHost img.live-shot');
  const m = await img.evaluate((el, [px, py]) => {
    const stage = el.closest('.live-stage'), host = el.closest('#liveHost');
    const kx = el.clientWidth / el.naturalWidth, ky = el.clientHeight / el.naturalHeight;
    if (stage && stage.scrollWidth > stage.clientWidth + 1) stage.scrollLeft = Math.max(0, px * kx - stage.clientWidth / 2);
    if (stage && stage.scrollHeight > stage.clientHeight + 1) stage.scrollTop = Math.max(0, py * ky - stage.clientHeight / 2);
    if (host && host.scrollHeight > host.clientHeight + 1) {
      const hr = host.getBoundingClientRect(), r0 = el.getBoundingClientRect();
      const y = r0.top + el.clientTop + py * ky;
      if (y < hr.top + 20 || y > hr.bottom - 20) host.scrollTop += y - (hr.top + host.clientHeight / 2);
    }
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, top: r.top + el.clientTop, cw: el.clientWidth, ch: el.clientHeight, nw: el.naturalWidth, nh: el.naturalHeight };
  }, [pt.x, pt.y]);
  const x = m.left + (pt.x + 0.5) * m.cw / m.nw, y = m.top + (pt.y + 0.5) * m.ch / m.nh;
  if (tap) await ui.touchscreen.tap(x, y); else await ui.mouse.click(x, y);
}

// Живий кадр відображає нову сторінку (опції дропдауна): чекаємо через /live/:sid/inspect.
async function inspectDesc(sid, pt) {
  const r = await fetch(base + '/live/' + sid + '/inspect?x=' + pt.x + '&y=' + pt.y);
  const d = await r.json();
  return (d && (d.desc || (d.target && d.target.desc))) || '';
}

async function createScenario(ui, url, name) {
  await ui.click('#newPageBtn');
  const dlg = ui.locator('dialog[open]');
  await dlg.locator('input[name="url"]').fill(url);
  await dlg.locator('input[name="name"]').fill(name);
  await dlg.locator('button[type="submit"]').click();
  await dlg.waitFor({ state: 'detached' });
  return ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: name }) });
}

async function runAndWait(ui, card, ms = 120000) {
  const before = (await uiState(ui)).screens;
  await card.locator('button.sc-run').click();
  await ui.waitForFunction(() => window.__st && window.__st.running === true, null, { timeout: 15000 }).catch(() => {});
  await ui.waitForFunction(() => window.__st && window.__st.running === false, null, { timeout: ms, polling: 250 });
  const st = await uiState(ui);
  if (st.screens !== Math.min(before + 1, 12)) {
    const live = await ui.locator('#live').innerText();
    const logs = (await ui.locator('#consoleBody').innerText()).split('\n').slice(-25).join('\n');
    assert.fail('після прогону додається таб результату (скрінів ' + st.screens + ')\n#live: ' + live + '\nлог:\n' + logs);
  }
  return st;
}

const noHScroll = (ui) => ui.evaluate(() => {
  const d = document.documentElement;
  return { sw: d.scrollWidth, cw: d.clientWidth, ok: d.scrollWidth <= d.clientWidth + 1 };
});

const SCEN = 'Анкета e2e';
const CV = 'cv-e2e.pdf';

// ---------- (1) порожній стан + створення сценарію ----------
test('ui e2e (1): порожній стан, створення сценарію через діалог (з валідацією URL)', opts, async () => {
  const { ui, errors } = await openUi({ width: 1440, height: 900 });
  ctx.desk = ui; ctx.deskErrors = errors;
  // Порожній стан: онбординг у сайдбарі й у переглядачі.
  await ui.locator('#pagesEl .sc-empty').waitFor();
  assert.match(await ui.locator('#resultView').innerText(), /Створи сценарій/);
  await shot(ui, 'desktop-empty');
  {
    const m = await openUi({ width: 390, height: 844 }, { touch: true });
    await m.ui.locator('#pagesEl .sc-empty').waitFor();
    await shot(m.ui, 'mobile-empty');
    await m.ui.close();
  }
  // Порожній URL → помилка валідації, діалог лишається.
  await ui.click('#newPageBtn');
  const dlg = ui.locator('dialog[open]');
  await dlg.locator('input[name="url"]').fill('');
  await dlg.locator('button[type="submit"]').click();
  await dlg.locator('input[name="url"][aria-invalid="true"]').waitFor({ timeout: 5000 });
  assert.match(await dlg.locator('.field .error').first().innerText(), /URL/);
  assert.equal(await dlg.count(), 1);
  await ui.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });

  const card = await createScenario(ui, FX + '/apply.html', SCEN);
  await card.waitFor();
  await expectText(card.locator('.page-url'), /apply\.html/);
  const st = await uiState(ui);
  ctx.pageId = pageByName(st, SCEN).id;
});

// ---------- (2) живий запис ----------
test('ui e2e (2): ⏺ Записати → живий перегляд → клік, друк, дропдаун, select, файл, iframe-submit → ⏹ Готово', opts, async () => {
  const ui = ctx.desk;
  assert.ok(ui, 'потрібен тест (1)');
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: SCEN }) });
  await card.locator('button.sc-rec', { hasText: '⏺ Записати' }).click();
  // Живий перегляд: таби сховано, тулбар і кадр — видно.
  await ui.locator('#recToolbar:not([hidden])').waitFor();
  await ui.locator('#liveHost img.live-shot:not([hidden])').waitFor({ timeout: 90000 });
  await ui.waitForFunction(() => { const s = window.__st; return !!(s && s.live && s.live.phase === 'live'); }, null, { timeout: 90000 });
  assert.match(await ui.locator('#recToolbar .rt-live').innerText(), /LIVE/);
  const st0 = await uiState(ui);
  const sid = st0.live.sid;
  assert.ok(sid, 'sid живої сесії');
  const nat = await ui.locator('#liveHost img.live-shot').evaluate((el) => ({ width: el.naturalWidth, height: el.naturalHeight }));
  const P = await measure(FX + '/apply.html', nat);
  ctx.P = P; ctx.vp = nat;

  // Клік у поле «Повне імʼя» → друк.
  await clickLive(ui, P.name);
  await waitRecSubs(ui, 1);
  await ui.keyboard.type('Ivan Petrenko', { delay: 15 });
  let subs = await waitRecSubs(ui, 2);
  assert.equal(subs[1].type, 'text');
  assert.equal(subs[1].text, 'Ivan Petrenko');

  // Асинхронний дропдаун: клік-відкривач, чекаємо опції (у живій сторінці), клік «Львів».
  await clickLive(ui, P.ddopen);
  await waitRecSubs(ui, 3);
  await waitFor(async () => /Львів/.test(await inspectDesc(sid, P.lviv)), { ms: 10000, what: 'опції дропдауна в живій сторінці' });
  await clickLive(ui, P.lviv);
  subs = await waitRecSubs(ui, 4);
  assert.match(subs[3].target.desc, /Львів/);

  // Нативний <select> → поповер з опціями → B2.
  await clickLive(ui, P.level);
  const pop = ui.locator('.live-popover');
  await pop.waitFor({ timeout: 15000 });
  await pop.locator('.live-pop-opt', { hasText: 'B2' }).click();
  subs = await waitRecSubs(ui, 5);
  assert.equal(subs.at(-1).type, 'select');
  assert.equal(subs.at(-1).value, 'B2');

  // Прихований file-input за кнопкою: сторінка відкриває вибір файлу → файл через UI.
  const cvPath = path.join(tmp || os.tmpdir(), CV);
  fs.writeFileSync(cvPath, '%PDF-1.4\n% e2e\n');
  const chooser = ui.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  await clickLive(ui, P.cvbtn);
  let fc = await chooser;
  if (!fc) {
    // Без user activation браузер не відкриє діалог сам — кнопка в банері.
    const btn = ui.locator('.live-banner button', { hasText: 'Обрати файл' });
    await btn.waitFor({ timeout: 10000 });
    [fc] = await Promise.all([ui.waitForEvent('filechooser'), btn.click()]);
  }
  await fc.setFiles(cvPath);
  subs = await waitRecSubs(ui, 7);
  assert.equal(subs.at(-1).type, 'file');
  assert.equal(subs.at(-1).filename, CV);

  // Submit у same-origin iframe.
  const nBefore = subs.length;
  await clickLive(ui, P.send);
  subs = await waitRecSubs(ui, nBefore + 1);
  const submit = subs.at(-1);
  assert.equal(submit.type, 'click');
  assert.ok(submit.target && submit.target.frame, 'ціль у iframe: ' + JSON.stringify(submit.target));
  await waitFor(() => fxEvents.includes('submit:Ivan Petrenko|Львів|B2|' + CV), { ms: 10000, what: 'submit у фікстурі: ' + fxEvents.join(',') });
  // Маркери кліків на кадрі.
  assert.ok(await ui.locator('#liveHost .live-mark').count() >= 1, 'номери кліків на кадрі');
  await shot(ui, 'desktop-live');

  // ⏹ Готово → виходимо з LIVE, зʼявляється таб результату.
  await ui.locator('#recToolbar button.done').click();
  await ui.waitForFunction(() => window.__st && window.__st.recording === false, null, { timeout: 30000 });
  await ui.locator('#recToolbar').waitFor({ state: 'hidden' });
  const st = await uiState(ui);
  assert.ok(st.screens >= 1, 'таб із останнім кадром');
  const rec = pageByName(st, SCEN).recs[0];
  assert.equal(rec.subs.length, subs.length);
  ctx.steps = rec.subs;
});

// ---------- (3) сайдбар і збереження ----------
test('ui e2e (3): сайдбар — семантичні підписи з 🎯; дані збережено в /pages (памʼять сервера)', opts, async () => {
  const ui = ctx.desk;
  assert.ok(ctx.steps, 'потрібен тест (2)');
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: SCEN }) });
  const rows = card.locator('.rec').first().locator('.subs li[data-si]');
  await waitFor(async () => (await rows.count()) === ctx.steps.length, { what: 'рядки кроків у сайдбарі' });
  const descs = await rows.locator('.desc').allInnerTexts();
  const all = descs.join('\n');
  assert.match(all, /Клік: .*Повне імʼя/);
  assert.match(all, /Ввести «Ivan Petrenko»/);
  assert.match(all, /Клік: .*Львів/);
  assert.match(all, /Вибрати «B2/);
  assert.match(all, new RegExp('Файл «' + CV.replace('.', '\\.') + '»'));
  assert.match(all, /Клік: .*Submit application/);
  assert.ok(!/\d+, \d+/.test(all), 'немає сирих координат: ' + all);
  // 🎯 на кліках/тексті/select (семантичні унікальні локатори).
  const semantic = await rows.locator('.hchip.h-ok').count();
  assert.ok(semantic >= ctx.steps.length - 1, 'чипів 🎯: ' + semantic + ' з ' + ctx.steps.length + '\n' + all);
  await shot(ui, 'desktop-sidebar');

  // Збереження: debounce 400 мс → PUT /pages/:id (сервер без БД тримає в памʼяті).
  const saved = await waitFor(async () => {
    const d = await (await fetch(base + '/pages')).json();
    const p = (d.pages || []).find((x) => x.id === ctx.pageId);
    return p && p.recs[0] && p.recs[0].subs.length === ctx.steps.length ? { d, p } : null;
  }, { ms: 10000, what: 'сценарій у GET /pages' });
  assert.equal(saved.d.db, false);
  assert.equal(saved.d.memory, true);
  for (const s of saved.p.recs[0].subs) {
    assert.ok(!('pending' in s) && !('status' in s), 'без тимчасових полів: ' + JSON.stringify(s).slice(0, 200));
    assert.equal(s.v, 2);
  }
  // Після перезавантаження вкладки сценарій на місці.
  await reloadUi(ui);
  await card.waitFor();
  assert.equal(await card.locator('.pcount').innerText(), '1 Дія');
});

// ---------- (4) відтворення ----------
async function assertAllOk(ui, card, label) {
  const rec = card.locator('.rec').first();
  const rows = rec.locator('.subs li[data-si]');
  const tg = rec.locator('.rec-head .tg');
  if ((await tg.getAttribute('aria-expanded')) === 'false') await tg.click();
  await waitFor(async () => (await rows.count()) === ctx.steps.length, { what: label + ': рядки кроків' });
  const n = await rows.count();
  let classes = [];
  await waitFor(async () => { classes = await rows.evaluateAll((els) => els.map((e) => e.className)); return classes.every((c) => /\bdone\b/.test(c)); }, { ms: 5000 }).catch(() => {});
  assert.ok(classes.every((c) => /\bdone\b/.test(c)), label + ': усі ✓, а є: ' + classes.join(' | '));
  const strat = await rows.locator('.strat').allInnerTexts();
  assert.equal(strat.length, n, label + ': бейдж стратегії на кожному кроці');
  const locs = strat.filter((s) => s.startsWith('🎯')).length;
  assert.ok(locs >= n - 1, label + ': стратегія 🎯 loc — ' + strat.join(', '));
  return expectText(card.locator('.sc-lastrun'), /помилок 0/);
}

test('ui e2e (4): ▶ Старт → усі кроки ✓ (🎯 локатор), «помилок 0», новий таб результату', opts, async () => {
  const ui = ctx.desk;
  assert.ok(ctx.steps, 'потрібен тест (2)');
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: SCEN }) });
  const nEv = fxEvents.length;
  const st = await runAndWait(ui, card);
  await assertAllOk(ui, card, 'звичайна верстка');
  assert.equal(pageByName(st, SCEN).lastRun.failed, 0);
  assert.ok(fxEvents.slice(nEv).includes('submit:Ivan Petrenko|Львів|B2|' + CV), 'відтворення відправило ту саму форму: ' + fxEvents.slice(nEv));
  // Таб результату: підпис зі сценарієм, зелена точка, зображення — blob:.
  const tab = ui.locator('#tabs .tab.active');
  assert.match(await tab.innerText(), new RegExp(SCEN));
  assert.match(await tab.getAttribute('class'), /st-ok/);
  assert.match(await ui.locator('#resultView img.shot').getAttribute('src'), /^blob:/);
  await shot(ui, 'desktop-results');

  // Конфігуратор (скрін) — відкривається з чипа, Esc закриває.
  await ui.click('#hdrConfigChip');
  await ui.locator('#cfgDialog[open]').waitFor();
  await ui.locator('#cfgNav [role="tab"]').first().waitFor();
  await shot(ui, 'desktop-config');
  await ui.keyboard.press('Escape');
  await ui.locator('#cfgDialog[open]').waitFor({ state: 'detached' }).catch(() => {});
  await ui.waitForFunction(() => !document.getElementById('cfgDialog').open);
});

test('ui e2e (5): зсунута верстка (?shift=1: банер + переставлені рядки) → усе ще всі ✓', opts, async () => {
  const ui = ctx.desk;
  assert.ok(ctx.steps, 'потрібен тест (2)');
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: SCEN }) });
  // ⋯ → «🔗 Змінити URL» (діалог із валідацією).
  await card.locator('.page-head button.more').click();
  await ui.locator('.sc-menu [role="menuitem"]', { hasText: 'Змінити URL' }).click();
  const dlg = ui.locator('dialog[open]');
  await dlg.locator('input[name="url"]').fill(FX + '/apply.html?shift=1');
  await dlg.locator('button[type="submit"]').click();
  await dlg.waitFor({ state: 'detached' });
  await expectText(card.locator('.page-url'), /shift=1/);
  const nEv = fxEvents.length;
  await runAndWait(ui, card);
  await assertAllOk(ui, card, 'зсунута верстка');
  assert.ok(fxEvents.slice(nEv).includes('submit:Ivan Petrenko|Львів|B2|' + CV + '|shift'), 'сабміт на зсунутій сторінці: ' + fxEvents.slice(nEv));
  assert.deepEqual(ctx.deskErrors, [], 'без помилок у консолі UI');
});

// ---------- (6) мобільний ----------
test('ui e2e (6): 390×844 — перемикач панелей, без горизонтальної прокрутки, тулбар запису придатний', opts, async () => {
  assert.ok(ctx.pageId, 'потрібен тест (1)');
  const { ui, errors } = await openUi({ width: 390, height: 844 }, { touch: true });
  try {
    const nav = ui.locator('#paneNav');
    assert.ok(await nav.isVisible(), 'нижня навігація');
    for (const pane of ['scenarios', 'viewer', 'logs', 'scenarios']) {
      await nav.locator('[data-pane="' + pane + '"]').tap();
      await ui.waitForFunction((p) => document.body.dataset.pane === p, pane);
      assert.equal(await nav.locator('[data-pane="' + pane + '"]').getAttribute('aria-selected'), 'true');
      const hs = await noHScroll(ui);
      assert.ok(hs.ok, pane + ': горизонтальна прокрутка ' + JSON.stringify(hs));
    }
    const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: SCEN }) });
    await card.waitFor();
    // Розгорнути Дію (рядки з чипами) і зняти скрін сайдбару.
    const tg = card.locator('.rec').first().locator('.rec-head .tg');
    if ((await tg.getAttribute('aria-expanded')) === 'false') await tg.tap();
    await card.locator('.subs li[data-si]').first().waitFor();
    await shot(ui, 'mobile-sidebar');
    assert.ok((await noHScroll(ui)).ok);

    // Запис «з початку (лише URL)» — без префікса, без діалогу про сабміт.
    await card.locator('button.sc-rec-more').tap();
    await ui.locator('.sc-menu [role="menuitem"]', { hasText: 'З початку' }).tap();
    await ui.locator('#liveHost img.live-shot:not([hidden])').waitFor({ timeout: 90000 });
    await ui.waitForFunction(() => { const s = window.__st; return !!(s && s.live && s.live.phase === 'live'); }, null, { timeout: 90000 });
    await ui.waitForFunction(() => document.body.dataset.pane === 'viewer');
    // Тулбар: усі кнопки на екрані, торкабельного розміру, без горизонтальної прокрутки.
    const btns = await ui.locator('#recToolbar button:visible').evaluateAll((els) => els.map((b) => {
      const r = b.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), label: b.getAttribute('aria-label') };
    }));
    assert.ok(btns.length >= 8, 'кнопки тулбара: ' + btns.length);
    for (const b of btns) {
      assert.ok(b.l >= 0 && b.r <= 390, 'кнопка в межах екрана: ' + JSON.stringify(b));
      assert.ok(b.h >= 32, 'кнопка достатньо велика для пальця: ' + JSON.stringify(b));
    }
    assert.ok((await noHScroll(ui)).ok, 'LIVE: без горизонтальної прокрутки');
    // Дотик + 390 px: «1:1» за замовчуванням — поля на кадрі пальцевого розміру.
    assert.match(await ui.locator('#liveHost .live-stage').getAttribute('class'), /zoom-1/);
    // Тап по полю імені (верстка поточного URL сценарію) → крок записано.
    const nat = await ui.locator('#liveHost img.live-shot').evaluate((el) => ({ width: el.naturalWidth, height: el.naturalHeight }));
    const cur = (await uiState(ui)).pages.find((x) => x.id === ctx.pageId).url;
    const P = await measure(cur, nat);
    await clickLive(ui, P.name, { tap: true });
    const subs = await waitRecSubs(ui, 1);
    assert.equal(subs[0].type, 'click');
    assert.match(subs[0].target.desc, /Повне імʼя/);
    // Під кадром — останні кроки Дії (список кроків на мобільному — в іншій панелі).
    await expectText(ui.locator('#liveHost .live-recent'), /1 крок[\s\S]*Повне імʼя/);
    assert.ok((await noHScroll(ui)).ok, 'LIVE після кроку: без горизонтальної прокрутки');
    await shot(ui, 'mobile-live');
    await ui.locator('#recToolbar button.done').tap();
    await ui.waitForFunction(() => window.__st && window.__st.recording === false, null, { timeout: 30000 });
    const st = await uiState(ui);
    const p = st.pages.find((x) => x.id === ctx.pageId);
    assert.equal(p.recs.length, 2, 'нова Дія з 1 кроком');
    assert.equal(p.recs[1].subs.length, 1);
    // Таб результату й конфігуратор на весь екран.
    await nav.locator('[data-pane="viewer"]').tap();
    await ui.locator('#resultView img.shot').waitFor();
    await shot(ui, 'mobile-results');
    await ui.click('#hdrConfigChip');
    await ui.locator('#cfgDialog[open]').waitFor();
    const box = await ui.locator('#cfgDialog').boundingBox();
    assert.ok(box.width <= 391 && box.x >= -1, 'конфігуратор у межах екрана: ' + JSON.stringify(box));
    await shot(ui, 'mobile-config');
    await ui.keyboard.press('Escape');
    await ui.waitForFunction(() => !document.getElementById('cfgDialog').open);
    // Прибираємо мобільну Дію (меню Дії → видалити), щоб не впливала на інші перевірки.
    await nav.locator('[data-pane="scenarios"]').tap();
    const rec2 = card.locator('.rec').nth(1);
    await rec2.locator('.rec-head button.more').tap();
    await ui.locator('.sc-menu [role="menuitem"]', { hasText: 'Видалити Дію' }).tap();
    await waitFor(async () => (await uiState(ui)).pages.find((x) => x.id === ctx.pageId).recs.length === 1, { what: 'Дію видалено' });
    assert.deepEqual(errors, [], 'без помилок у консолі (мобільний)');
  } finally {
    await ui.close();
  }
});

// ---------- (7) legacy ----------
test('ui e2e (7): legacy-сценарій — «+N рухів» згорнуто, прогін завершується з підсумком', opts, async () => {
  const ui = ctx.desk;
  assert.ok(ui, 'потрібен тест (1)');
  const legacy = JSON.parse(fs.readFileSync(path.join(FIX, 'legacy-scenario.json'), 'utf8'));
  const id = 990001;
  const r = await fetch(base + '/pages/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: legacy.name, url: FX + '/apply.html', recs: legacy.recs }),
  });
  assert.equal((await r.json()).ok, true);
  await reloadUi(ui);
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: legacy.name }) });
  await card.waitFor();
  const rec = card.locator('.rec').first();
  const tg = rec.locator('.rec-head .tg');
  if ((await tg.getAttribute('aria-expanded')) === 'false') await tg.click();
  const moves = rec.locator('.moves-row');
  await moves.first().waitFor();
  assert.match(await moves.first().innerText(), /\+\d+ рух(ів|и)? миші/);
  // Рухи не показано поштучно.
  assert.equal(await rec.locator('.subs li[data-si]').count(), legacy.recs[0].subs.filter((s) => s.type !== 'move').length);
  assert.match(await rec.locator('.hchip.h-coords').first().getAttribute('aria-label'), /координати/);
  await runAndWait(ui, card, 180000);
  await expectText(card.locator('.sc-lastrun'), /Останній прогін: .*успішно \d+, помилок \d+/);
  // Legacy-рухи миші завжди пропускаються, кліки — координатні.
  assert.match(await rec.locator('.moves-row').first().getAttribute('class'), /skipped/);
  const strat = await rec.locator('.strat').allInnerTexts();
  assert.ok(strat.length >= 1 && strat.every((s) => /📍|🧲/.test(s)), 'legacy-кліки — за координатами: ' + strat);
  await fetch(base + '/pages/' + id, { method: 'DELETE' });
});
