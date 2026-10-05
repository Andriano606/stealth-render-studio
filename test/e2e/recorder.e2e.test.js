// E2E (opt-in, E2E=1): ЖИВИЙ запис через UI (js/recorder.js + live-client.js) у справжньому Chrome.
// Фікстура test/fixtures/live.html (поле Email, <select> «Країна», кнопка «Submit Application»)
// віддається локальним сервером; події сторінки (/log) збираються тут.
// Застосунок — createApp у процесі (рушій channel 'chrome', headless, без stealth-плагіна), або
// UI_BASE=http://localhost:<порт> — уже запущений ТЕСТОВИЙ сервер (не 3000!).
// Запуск: E2E=1 node --test test/e2e/recorder.e2e.test.js
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
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const quiet = { log() {}, error() {} };

let fsrv, FX, tmp, engine, sessions, srv, base, browser;
const pageEvents = [];

before(async () => {
  if (!E2E) return;
  fsrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/log') { pageEvents.push(u.searchParams.get('e')); res.end('ok'); return; }
    const f = path.join(FIX, path.basename(u.pathname));
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-rec-e2e-'));
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
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (!E2E) return;
  if (browser) await browser.close();
  if (sessions) await sessions.closeAll('end');
  if (srv) srv.close();
  if (fsrv) fsrv.close();
  if (engine) await engine.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// Центри (і висоти) елементів фікстури у viewport 1280×900 (та сама верстка, що й у сесії).
async function centersOf(url, sels) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(url);
  const out = {};
  for (const s of sels) {
    const b = await p.locator(s).first().boundingBox();
    out[s] = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), h: b.height };
  }
  await p.close();
  return out;
}

// Клік по живому зображенню в точці viewport (vx, vy): content-box <img> → клієнтські px.
// У режимі «1:1» (мобільний) кадр ширший за екран — спершу прокручуємо перегляд до точки.
async function clickLive(ui, vx, vy, { tap = false } = {}) {
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
  }, [vx, vy]);
  const x = m.left + (vx + 0.5) * m.cw / m.nw, y = m.top + (vy + 0.5) * m.ch / m.nh;
  if (tap) await ui.touchscreen.tap(x, y); else await ui.mouse.click(x, y);
}

const recState = (ui) => ui.evaluate(async () => {
  const { state } = await import('/js/state.js');
  return {
    recording: state.recording, live: state.live,
    pages: state.pages.map((p) => ({ id: p.id, name: p.name, recs: p.recs.map((r) => ({ id: r.id, name: r.name, subs: r.subs })) })),
  };
});
async function waitSubs(ui, n, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const st = await recState(ui);
    const rec = st.pages.at(-1) && st.pages.at(-1).recs.at(-1);
    const subs = rec ? rec.subs : [];
    if (subs.length >= n && subs.every((s) => !s.pending)) return subs;
    if (Date.now() - t0 > ms) throw new Error('Не дочекались ' + n + ' кроків: ' + JSON.stringify(subs).slice(0, 600));
    await new Promise((r) => setTimeout(r, 150));
  }
}

const pagesApi = async () => (await (await fetch(base + '/pages')).json()).pages || [];
async function waitFor(fn, ms = 10000, what = 'умова') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Не дочекались: ' + what);
    await new Promise((r) => setTimeout(r, 150));
  }
}
// Живий кадр уміщається в панель (без прокрутки панелі) і не обрізаний знизу.
const liveFits = (ui) => ui.evaluate(() => {
  const host = document.getElementById('liveHost'), img = host.querySelector('img.live-shot');
  const hr = host.getBoundingClientRect(), ir = img.getBoundingClientRect();
  return { sh: host.scrollHeight, ch: host.clientHeight, imgBottom: Math.round(ir.bottom), hostBottom: Math.round(hr.bottom), w: Math.round(ir.width),
    ok: host.scrollHeight <= host.clientHeight + 1 && ir.bottom <= hr.bottom + 1 && ir.width > 300 };
});

async function openUi(viewport, { touch = false } = {}) {
  const ui = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
  const errors = [];
  ui.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  ui.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await ui.goto(base + '/');
  await ui.waitForSelector('#newPageBtn:not([disabled])');
  return { ui, errors };
}

async function createScenario(ui, url, name) {
  await ui.click('#newPageBtn');
  const dlg = ui.locator('dialog[open]');
  await dlg.locator('input').first().fill(url);
  await dlg.locator('input[name="name"]').fill(name);
  await dlg.locator('button[type="submit"]').click();
  await dlg.waitFor({ state: 'detached' });
}

// Старт запису: кнопка сайдбару (scenarios.js) або — якщо її ще немає — API рекордера.
async function startRecording(ui, name, { mode = 'append' } = {}) {
  const card = ui.locator('#pagesEl article.sc-card', { has: ui.locator('.pname', { hasText: name }) });
  const btn = card.locator('button.sc-rec', { hasText: '⏺ Записати' });
  if (mode === 'append' && await btn.count()) await btn.first().click();
  else {
    await ui.evaluate(async ({ name: n, mode: m }) => {
      const { state } = await import('/js/state.js');
      const rec = await import('/js/recorder.js');
      const page = state.pages.find((p) => p.name === n);
      rec.start({ page, mode: m, recId: m === 'appendTo' ? page.recs.at(-1).id : undefined });
    }, { name, mode });
  }
}

test('живий запис: клік по кнопці, друк у поле, вибір у <select>, ⏹ Готово → кроки v2 із семантичними цілями', { skip: !E2E, timeout: 180000 }, async () => {
  const URL_ = FX + '/live.html';
  const c = await centersOf(URL_, ['#email', '#country', '#submit', '#cvbtn']);
  const { ui, errors } = await openUi({ width: 1280, height: 900 });
  try {
    const name = 'Запис e2e ' + Date.now();
    await createScenario(ui, URL_, name);
    await startRecording(ui, name);
    await ui.locator('#viewer.live-mode').waitFor();
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    await ui.locator('#liveHost img.live-shot:not([hidden])').waitFor();
    assert.equal(await ui.locator('#resultView').isVisible(), false, 'скріни-результати сховано під час LIVE');
    assert.match(await ui.locator('#recToolbar .rt-engine').textContent(), /Chromium/);
    // Десктоп: увесь viewport сесії видно (без прокрутки панелі), консоль згорнута на час LIVE.
    await ui.waitForFunction(() => document.querySelector('#liveHost img.live-shot').naturalWidth > 0);
    let fit = await liveFits(ui);
    assert.ok(fit.ok, '1280×900: кадр уміщається ' + JSON.stringify(fit));
    assert.match(await ui.locator('#console').getAttribute('class'), /collapsed/, 'консоль згорнута під час LIVE');
    // Прихований IME-інпут — не в порядку Tab (інакше пастка: кожна клавіша стає кроком).
    assert.equal(await ui.locator('#liveHost .live-ime').getAttribute('tabindex'), '-1');
    await ui.setViewportSize({ width: 1024, height: 768 });
    await ui.waitForTimeout(150);
    fit = await liveFits(ui);
    assert.ok(fit.ok, '1024×768: кадр уміщається ' + JSON.stringify(fit));
    await ui.setViewportSize({ width: 1280, height: 900 });
    await ui.waitForTimeout(150);

    // 1) клік у поле Email → крок click з ціллю kind=input
    await clickLive(ui, c['#email'].x, c['#email'].y);
    let subs = await waitSubs(ui, 1);
    assert.equal(subs[0].type, 'click');
    assert.equal(subs[0].v, 2);
    assert.equal(subs[0].target.kind, 'input');
    assert.ok(await ui.locator('#liveHost .live-mark').count() >= 1, 'номерний маркер кліку на зображенні');

    // 2) друк (з буфером і «{» — шаблонне екранування) → один text-крок у поле Email
    await ui.keyboard.type('john{x', { delay: 30 });
    assert.match(await ui.locator('#liveHost .live-typing').textContent(), /john\{x/, 'буфер показано inline');
    subs = await waitSubs(ui, 2);
    assert.equal(subs[1].type, 'text');
    assert.equal(subs[1].text, 'john{{x');
    assert.equal(subs[1].target && subs[1].target.kind, 'input', 'ціль успадкована від кліку');

    // 3) клік по <select> → поповер → вибір «Польща» → крок select
    await clickLive(ui, c['#country'].x, c['#country'].y);
    const pop = ui.locator('#liveHost .live-popover');
    await pop.waitFor({ timeout: 20000 });
    await pop.getByRole('option', { name: /Польща/ }).click();
    subs = await waitSubs(ui, 3);
    assert.equal(subs[2].type, 'select');
    assert.equal(subs[2].value, 'PL');
    assert.equal(subs[2].target.kind, 'select');

    // 4) колесо — прокрутка йде в сторінку, але НЕ записується (за замовчуванням)
    await ui.locator('#liveHost img.live-shot').hover();
    await ui.mouse.wheel(0, 200);
    await ui.waitForTimeout(800);
    await ui.mouse.wheel(0, -200);
    await ui.waitForTimeout(800);

    // 5) ↶ видалити останній, потім знову вибрати Україну
    await ui.locator('#recToolbar button[aria-label="Видалити останній"]').click();
    assert.equal((await recState(ui)).pages.at(-1).recs.at(-1).subs.length, 2);
    // ↶ збережено на сервері (GET /pages)
    await waitFor(async () => { const p = (await pagesApi()).find((x) => x.name === name); return p && p.recs.at(-1) && p.recs.at(-1).subs.length === 2; }, 10000, '↶ у GET /pages');
    await ui.locator('#liveHost .live-banner', { hasText: 'сторінка вже змінилась' }).waitFor();
    await clickLive(ui, c['#country'].x, c['#country'].y);
    await pop.waitFor({ timeout: 20000 });
    await pop.getByRole('option', { name: /Україна/ }).click();
    subs = await waitSubs(ui, 3);
    assert.equal(subs[2].value, 'UA');

    // 5б) клік, що відкриває вибір файлу → needFile → системний діалог → /upload → крок file
    const cvPath = path.join(os.tmpdir(), 'srs-cv-' + process.pid + '.txt');
    fs.writeFileSync(cvPath, 'CV e2e');
    const [chooser] = await Promise.all([ui.waitForEvent('filechooser', { timeout: 20000 }), clickLive(ui, c['#cvbtn'].x, c['#cvbtn'].y)]);
    await ui.locator('#liveHost .live-banner', { hasText: 'вибір файлу' }).waitFor();
    await chooser.setFiles(cvPath);
    subs = await waitSubs(ui, 5);
    fs.rmSync(cvPath, { force: true });
    assert.equal(subs[3].type, 'click');
    assert.equal(subs[3].chooser, true, 'клік позначено як такий, що відкриває вибір файлу');
    assert.equal(subs[4].type, 'file');
    assert.equal(subs[4].filename, path.basename(cvPath));
    const t1 = Date.now();
    while (!pageEvents.includes('cv:' + path.basename(cvPath)) && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(pageEvents.includes('cv:' + path.basename(cvPath)), 'файл підставлено в input сторінки');

    // 6) клік по Submit → крок із семантичним локатором (role/text), сторінка отримала значення
    await clickLive(ui, c['#submit'].x, c['#submit'].y);
    subs = await waitSubs(ui, 6);
    const sub = subs[5];
    assert.equal(sub.type, 'click');
    const loc = sub.target.locs[sub.target.pick];
    assert.ok(loc && ['role', 'text', 'testid', 'id'].includes(loc.by), 'семантичний локатор: ' + JSON.stringify(loc));
    assert.match(sub.target.desc, /Submit Application/);
    const t0 = Date.now();
    while (!pageEvents.includes('submit:john{x') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(pageEvents.includes('submit:john{x'), 'сторінка отримала сабміт із введеним текстом: ' + pageEvents.join(','));
    assert.ok(pageEvents.includes('country:UA'));

    // 7) ⏹ Готово → вихід із LIVE, таб із останнім кадром, кроки без pending
    const tabsBefore = await ui.locator('#tabs [role="tab"]').count();
    await ui.locator('#recToolbar button[aria-label="Готово"]').click();
    await ui.locator('#viewer.live-mode').waitFor({ state: 'detached' });
    await ui.waitForFunction((n) => document.querySelectorAll('#tabs [role="tab"]').length > n, tabsBefore);
    const st = await recState(ui);
    assert.equal(st.recording, false);
    assert.equal(st.live, null);
    const final = st.pages.at(-1).recs.at(-1).subs;
    assert.equal(final.length, 6);
    assert.ok(final.every((s) => s.v === 2 && s.id && !s.pending && s.target), 'усі кроки v2 із ціллю');
    assert.doesNotMatch(await ui.locator('#console').getAttribute('class'), /collapsed/, 'консоль розгорнута після ⏹ Готово');
    assert.deepEqual(errors, [], 'без помилок у консолі');
  } finally {
    await ui.close();
  }
});

test('живий запис на 390 px: без горизонтальної прокрутки; «Дописати» підтверджує сабміт у префіксі; порожній запис нічого не додає', { skip: !E2E, timeout: 180000 }, async () => {
  const URL_ = FX + '/live.html';
  const c = await centersOf(URL_, ['#submit', '#email']);
  const { ui, errors } = await openUi({ width: 390, height: 844 }, { touch: true });
  try {
    const name = 'Мобільний ' + Date.now();
    await createScenario(ui, URL_, name);
    // Перша Дія: один сабміт-клік (fromStart через API)
    await startRecording(ui, name, { mode: 'fromStart' });
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    const noHScroll = () => ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(await noHScroll(), 'LIVE на 390 px — без горизонтальної прокрутки сторінки');
    // Дотик + вузький екран: «1:1» увімкнено за замовчуванням (поля — пальцеві), прокрутка — в перегляді.
    const stage = ui.locator('#liveHost .live-stage');
    await ui.waitForFunction(() => document.querySelector('#liveHost img.live-shot').naturalWidth > 0);
    assert.match(await stage.getAttribute('class'), /zoom-1/, '1:1 за замовчуванням на дотиковому вузькому екрані');
    const zoomBtn = ui.locator('#recToolbar button[aria-label="Масштаб 1:1"]');
    assert.equal(await zoomBtn.getAttribute('aria-pressed'), 'true');
    assert.match(await zoomBtn.innerText(), /1:1/, 'кнопка має видимий підпис');
    assert.ok(await noHScroll(), '1:1 не додає горизонтальної прокрутки сторінки');
    assert.ok(await stage.evaluate((el) => el.scrollWidth > el.clientWidth), 'прокручується сам перегляд');
    const k = await ui.locator('#liveHost img.live-shot').evaluate((el) => el.clientWidth / el.naturalWidth);
    assert.ok(k > 0.95, 'кадр 1:1 (масштаб ' + k.toFixed(2) + ')');
    assert.ok(k * c['#email'].h >= c['#email'].h * 0.95, 'поле на кадрі в натуральну висоту: ' + (k * c['#email'].h).toFixed(1) + ' px');
    // Вимкнули 1:1 → кадр дрібний → підказка «Дрібно? Увімкни 1:1»; кнопка в ній вмикає назад.
    await zoomBtn.click();
    assert.ok(await noHScroll());
    const hint = ui.locator('#liveHost .live-banner', { hasText: 'Дрібно' });
    await hint.waitFor({ timeout: 5000 });
    await hint.getByRole('button', { name: /1:1/ }).click();
    await hint.waitFor({ state: 'detached' });
    assert.match(await stage.getAttribute('class'), /zoom-1/);
    await clickLive(ui, c['#submit'].x, c['#submit'].y, { tap: true }); // тап = клік (у режимі 1:1)
    await waitSubs(ui, 1);
    await ui.locator('#recToolbar button[aria-label="Готово"]').click();
    await ui.locator('#viewer.live-mode').waitFor({ state: 'detached' });
    const recId = (await recState(ui)).pages.at(-1).recs.at(-1).id;

    // «⏺ Дописати» — кнопка САМЕ цієї Дії в сайдбарі; ланцюг містить сабміт → підтвердження
    const appendBtn = async () => {
      const nav = ui.locator('#paneNav [data-pane="scenarios"]');
      if (await nav.isVisible()) await nav.tap();
      const b = ui.locator('#pagesEl button[data-fk="r' + recId + '-append"]');
      await b.waitFor();
      assert.equal(await b.isDisabled(), false, '⏺ Дописати активна після завершення запису');
      return b;
    };
    await (await appendBtn()).tap();
    const dlg = ui.locator('dialog[open]');
    await dlg.waitFor();
    assert.match(await dlg.textContent(), /відправить форму/i);
    await dlg.locator('button[type="submit"]').click();
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    assert.ok(await noHScroll(), 'після відкриття — теж без горизонтальної прокрутки');
    assert.equal(await ui.locator('#pagesEl button[data-fk$="-append"]:not([disabled])').count(), 0, 'під час запису ⏺ Дописати вимкнено');
    const before = (await recState(ui)).pages.at(-1).recs;
    await ui.locator('#recToolbar button[aria-label="Готово"]').click();
    await ui.locator('#viewer.live-mode').waitFor({ state: 'detached' });
    let after = (await recState(ui)).pages.at(-1).recs;
    assert.equal(after.length, before.length, 'існуюча Дія лишилась');
    assert.equal(after.at(-1).subs.length, 1, 'нових кроків немає');

    // Ще раз «⏺ Дописати» — тепер із кроком: він іде в ТУ САМУ Дію.
    await (await appendBtn()).tap();
    await dlg.waitFor();
    await dlg.locator('button[type="submit"]').click();
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    await clickLive(ui, c['#email'].x, c['#email'].y, { tap: true });
    await waitSubs(ui, 2);
    await ui.locator('#recToolbar button[aria-label="Готово"]').click();
    await ui.locator('#viewer.live-mode').waitFor({ state: 'detached' });
    after = (await recState(ui)).pages.at(-1).recs;
    assert.equal(after.length, before.length, 'нової Дії не створено');
    assert.equal(after.at(-1).id, recId, 'та сама Дія');
    assert.equal(after.at(-1).subs.length, 2, 'крок дописано');
    assert.equal(after.at(-1).subs[1].target.kind, 'input');
    assert.deepEqual(errors, [], 'без помилок у консолі');
  } finally {
    await ui.close();
  }
});

test('перезавантаження вкладки посеред запису: кроки збережено, «⟲ Відновити» повертає в ТУ САМУ Дію; назва нової Дії — в межах сценарію', { skip: !E2E, timeout: 180000 }, async () => {
  const URL_ = FX + '/live.html';
  const c = await centersOf(URL_, ['#email', '#country']);
  const { ui, errors } = await openUi({ width: 1280, height: 900 });
  try {
    const name = 'Reload ' + Date.now();
    await createScenario(ui, URL_, name);
    await startRecording(ui, name);
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    await ui.locator('#liveHost img.live-shot:not([hidden])').waitFor();
    let st = await recState(ui);
    const page0 = st.pages.find((p) => p.name === name);
    assert.equal(page0.recs.at(-1).name, 'Дія 1', 'перша Дія нового сценарію — «Дія 1» (не глобальний лічильник)');
    const recId = page0.recs.at(-1).id;
    await clickLive(ui, c['#email'].x, c['#email'].y);
    await waitSubs(ui, 1);
    // Одразу перезавантажуємо (без очікування дебаунсу збереження) — pagehide має дозберегти.
    await ui.reload();
    await ui.waitForSelector('#newPageBtn');
    // Повернення: та сама Дія у LIVE-режимі; сесію закрито beacon-ом → банер «⟲ Відновити».
    await ui.locator('#viewer.live-mode').waitFor({ timeout: 20000 });
    st = await recState(ui);
    assert.equal(st.live && st.live.recId, recId, 'рекордер повернувся до тієї ж Дії');
    const subs0 = st.pages.find((p) => p.name === name).recs.find((r) => r.id === recId).subs;
    assert.equal(subs0.filter((x) => !x.pending).length, 1, 'крок до перезавантаження збережено');
    const restore = ui.locator('#liveHost .live-banner button', { hasText: 'Відновити' });
    if (await restore.count() || !(await ui.locator('#recToolbar .rt-live.on').count())) {
      await restore.first().click();
    }
    await ui.locator('#recToolbar .rt-live.on').waitFor({ timeout: 90000 });
    await clickLive(ui, c['#country'].x, c['#country'].y);
    const pop = ui.locator('#liveHost .live-popover');
    await pop.waitFor({ timeout: 20000 });
    await pop.getByRole('option', { name: /Польща/ }).click();
    await waitSubs(ui, 2);
    await ui.locator('#recToolbar button[aria-label="Готово"]').click();
    await ui.locator('#viewer.live-mode').waitFor({ state: 'detached' });
    st = await recState(ui);
    const p = st.pages.find((x) => x.name === name);
    assert.equal(p.recs.length, 1, 'нової Дії не створено');
    assert.equal(p.recs[0].id, recId);
    assert.deepEqual(p.recs[0].subs.map((x) => x.type), ['click', 'select']);
    assert.ok(p.recs[0].subs.every((x) => !x.pending));
    // Таб результату підписано назвою Дії, як у сайдбарі.
    assert.match(await ui.locator('#tabs .tab.active').innerText(), /Запис «Дія 1»/);
    assert.deepEqual(errors.filter((e) => !/Failed to load resource.*410/.test(e)), [], 'без помилок у консолі');
  } finally {
    await ui.close();
  }
});
