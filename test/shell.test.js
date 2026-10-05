// Чиста логіка оболонки UI (F3): health-бейджі, ширина сайдбара, лог (групи/фільтри/копія),
// стан конфігу (чип, «● змінено» замість мовчазного повернення пресета), футер конфігуратора,
// таби скрінів (blob-URL, ліміт, «Сценарій · до Дії N», статус).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthBadges, clampSidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, PANES } from '../public/js/app.js';
import { kindGroup, groupMeta, formatCopy, LOG_GROUPS } from '../public/js/log.js';
import {
  configStatus, chipInfo, changedCats, needsRelaunch, footerState, makeDraft, CATS, CAT_PATHS,
} from '../public/js/config.js';
import {
  splitScreens, pushScreen, dataUrlToBlob, deriveRunMeta, screenTitle, screenStatus, MAX_SCREENS,
  STATUS_TEXT, runBanner, runBannerText, placeholderMode,
} from '../public/js/viewer.js';

// ---------- app.js ----------
test('healthBadges: БД off / LIVE / пул / сервер недоступний', () => {
  assert.deepEqual(healthBadges(null), []);
  assert.deepEqual(healthBadges({ ok: true, db: true, sessions: 0, poolReady: 1, poolSize: 3, active: 0 }), []);
  const b = healthBadges({ ok: true, db: false, sessions: 2, poolReady: 0, poolSize: 3, active: 0 });
  assert.deepEqual(b.map((x) => x.key), ['db', 'live', 'pool']);
  assert.match(b[0].text, /лише в памʼяті/);
  assert.equal(b[1].label, 'LIVE ×2');
  assert.equal(healthBadges({ ok: true, db: true, sessions: 1 })[0].label, 'LIVE');
  // Пул порожній, бо всі контексти зайняті прогонами — це не «готується».
  assert.deepEqual(healthBadges({ ok: true, db: true, sessions: 0, poolReady: 0, poolSize: 3, active: 2 }), []);
  const down = healthBadges({ ok: false, error: 'Failed to fetch' });
  assert.equal(down.length, 1);
  assert.equal(down[0].kind, 'danger');
  assert.match(down[0].title, /Failed to fetch/);
  for (const x of [...b, ...down]) assert.ok(x.icon && x.label && x.title && x.text, JSON.stringify(x));
});

test('clampSidebarWidth: межі й 60% вікна; сміття → null', () => {
  assert.equal(clampSidebarWidth('abc', 1440), null);
  assert.equal(clampSidebarWidth(null, 1440), null);
  assert.equal(clampSidebarWidth(100, 1440), SIDEBAR_MIN);
  assert.equal(clampSidebarWidth(5000, 1440), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(5000, 1000), 600);
  assert.equal(clampSidebarWidth('400.4', 1440), 400);
  assert.equal(clampSidebarWidth(500, 300), SIDEBAR_MIN); // вузьке вікно — не менше мінімуму
  assert.deepEqual(PANES, ['scenarios', 'viewer', 'logs']);
});

// ---------- log.js ----------
test('kindGroup: кожен вид логу сервера має групу-фільтр; невідомий → info', () => {
  const kinds = ['info', 'nav', 'browser', 'context', 'fp', 'stealth', 'cookies', 'shot', 'warn', 'error'];
  const keys = new Set(LOG_GROUPS.map((g) => g.key));
  for (const k of kinds) assert.ok(keys.has(kindGroup(k)), k);
  assert.equal(kindGroup('error'), 'error');
  assert.equal(kindGroup('warn'), 'error');
  assert.equal(kindGroup('context'), 'browser');
  assert.equal(kindGroup('fp'), 'stealth');
  assert.equal(kindGroup('щось'), 'info');
  assert.equal(kindGroup(undefined), 'info');
});

test('groupMeta: час · N рядків (відмінки) · ✗ помилки', () => {
  assert.equal(groupMeta({ time: '12:00:01', lines: 1, errors: 0 }), '12:00:01 · 1 рядок');
  assert.equal(groupMeta({ time: '12:00:01', lines: 3, errors: 2 }), '12:00:01 · 3 рядки · ✗ 2');
  assert.equal(groupMeta({ time: '', lines: 11 }), '11 рядків');
  assert.equal(groupMeta({ lines: 22 }), '22 рядки');
  assert.equal(groupMeta({ lines: 0 }), '0 рядків');
});

test('formatCopy: заголовки груп + рядки з часом; приховані фільтром не копіюються', () => {
  const entries = [
    { type: 'line', group: 'info', text: 'старт', time: '10:00:00' },
    { type: 'group', title: 'Старт «A»' },
    { type: 'line', group: 'nav', text: 'goto', time: '10:00:01' },
    { type: 'line', group: 'error', text: 'бах', time: '10:00:02' },
  ];
  assert.equal(formatCopy(entries), '[10:00:00] старт\n── Старт «A» ──\n[10:00:01] goto\n[10:00:02] бах');
  assert.equal(formatCopy(entries, new Set(['nav', 'info'])), '── Старт «A» ──\n[10:00:02] бах');
});

// ---------- config.js ----------
const DEF = { launch: { headless: true }, stealth: { webdriver: false }, behavior: { humanize: false } };
const PRESETS = [
  { id: 1, name: '🛡️ All', body: { launch: { engine: 'chromium', stealthPlugin: true } } },
  { id: 2, name: '☁️ Cloudflare', body: { launch: { engine: 'camoufox' } } },
];
const prof = (launch) => ({ launch: { engine: 'chromium', headless: true, ...launch }, stealth: {}, behavior: {}, fingerprint: null, defaults: DEF });

test('configStatus: пресет / «● змінено» (НЕ повертаємо мовчки) / кастом / без пресетів', () => {
  assert.equal(configStatus(prof({ stealthPlugin: true }), PRESETS, 1).mode, 'preset');
  // Запамʼятований пресет — All, а профіль змінили (stealthPlugin false) → changed, не 'preset'.
  const ch = configStatus(prof({ stealthPlugin: false }), PRESETS, 1);
  assert.equal(ch.mode, 'changed');
  assert.equal(ch.presetName, '🛡️ All');
  assert.equal(ch.text, '🧩 Chromium · 🛡️ All ● змінено');
  // Без запамʼятованого — кастом.
  assert.deepEqual(configStatus(prof({ stealthPlugin: false }), PRESETS, null).text, '🧩 Chromium · кастом');
  // Запамʼятований не збігся, але збігся інший → показуємо той, що збігся.
  const cf = configStatus({ ...prof({}), launch: { engine: 'camoufox' } }, PRESETS, 1);
  assert.equal(cf.mode, 'preset');
  assert.equal(cf.text, '🦊 Camoufox · ☁️ Cloudflare');
  assert.equal(configStatus(prof({}), [], 1).mode, 'none');
  // Сумісний chipInfo: «● змінено» вважається кастомним станом.
  assert.deepEqual(chipInfo(prof({ stealthPlugin: false }), PRESETS, 1), { text: '🧩 Chromium · 🛡️ All ● змінено', custom: true });
});

test('changedCats: позначає лише категорії зі змінами (рушій окремо від запуску)', () => {
  const applied = makeDraft(prof({ stealthPlugin: true }));
  const d = makeDraft(prof({ stealthPlugin: true }));
  assert.deepEqual([...changedCats(d, applied)], []);
  d.launch.engine = 'camoufox';
  assert.deepEqual([...changedCats(d, applied)], ['engine']);
  d.launch.realGpu = false;
  d.behavior.humanize = true;
  assert.deepEqual([...changedCats(d, applied)].sort(), ['behavior', 'engine', 'launch']);
  d.fingerprint = { userAgent: 'X' };
  assert.ok(changedCats(d, applied).has('fingerprint'));
  assert.deepEqual([...changedCats(null, applied)], []);
  // Кожна категорія меню має опис шляхів.
  for (const c of CATS) assert.ok(Array.isArray(CAT_PATHS[c.key]), c.key);
});

test('needsRelaunch: лише коли змінюються launch-прапорці (у т.ч. Clear all)', () => {
  const applied = prof({ stealthPlugin: true });
  assert.equal(needsRelaunch({ launch: { stealthPlugin: true } }, applied), false);
  assert.equal(needsRelaunch({ launch: { stealthPlugin: false } }, applied), true);
  assert.equal(needsRelaunch({ behavior: { humanize: true } }, applied), false);
  assert.equal(needsRelaunch({ clear: true }, applied), false); // дефолтний launch уже збігається (headless:true)
  assert.equal(needsRelaunch({ clear: true }, { ...applied, launch: { headless: false } }), true);
  assert.equal(needsRelaunch(null, applied), false);
});

test('footerState: «Застосувати» vs «💾 Оновити пресет «X»» vs «➕ Зберегти як новий пресет»', () => {
  const clean = footerState({ unsaved: false, dirty: false, activeName: '🛡️ All', presetsDb: true });
  assert.equal(clean.applyDisabled, true);
  assert.equal(clean.update, null);
  assert.equal(clean.saveNew, null);
  assert.match(clean.hint, /змін немає/);

  const dirty = footerState({ unsaved: true, dirty: true, activeName: '🛡️ All', presetsDb: true });
  assert.equal(dirty.apply, 'Застосувати');
  assert.equal(dirty.applyDisabled, false);
  assert.equal(dirty.update, '💾 Оновити пресет «🛡️ All»');
  assert.equal(dirty.saveNew, '➕ Зберегти як новий пресет');
  assert.match(dirty.hint, /кастом/);

  // Зміни, що не стосуються полів пресета (пресет усе ще збігається): лише «Застосувати».
  const within = footerState({ unsaved: true, dirty: false, activeName: '☁️ Cloudflare', presetsDb: true });
  assert.equal(within.update, null);
  assert.equal(within.saveNew, null);

  const custom = footerState({ unsaved: true, dirty: false, activeName: null, presetsDb: true });
  assert.equal(custom.saveNew, '➕ Зберегти як новий пресет');
  // Без БД — жодних кнопок пресетів.
  const noDb = footerState({ unsaved: true, dirty: true, activeName: 'X', presetsDb: false });
  assert.equal(noDb.update, null);
  assert.equal(noDb.saveNew, null);
});

// ---------- viewer.js ----------
test('splitScreens/pushScreen: новий першим, ліміт 12, повертає те, що випало (для revokeObjectURL)', () => {
  let list = [];
  let dropped = [];
  for (let i = 1; i <= MAX_SCREENS + 2; i++) {
    const r = splitScreens(list, { id: i });
    list = r.kept; dropped = dropped.concat(r.dropped);
  }
  assert.equal(MAX_SCREENS, 12);
  assert.equal(list.length, 12);
  assert.equal(list[0].id, 14);
  assert.deepEqual(dropped.map((s) => s.id), [1, 2]);
  assert.deepEqual(pushScreen([{ id: 1 }], { id: 2 }, 1), [{ id: 2 }]);
});

test('dataUrlToBlob: base64 і не-base64; не data: → null', async () => {
  const b = dataUrlToBlob('data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'));
  assert.equal(b.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await b.arrayBuffer())], [0xff, 0xd8, 0xff, 0x00]);
  const t = dataUrlToBlob('data:text/plain,%D0%BF%D1%80%D0%B8%D0%B2%D1%96%D1%82');
  assert.equal(await t.text(), 'привіт');
  assert.equal(dataUrlToBlob('blob:http://x/1'), null);
  assert.equal(dataUrlToBlob(null), null);
});

test('deriveRunMeta: сценарій, «до Дії N» за прапорцями running, кількість помилок', () => {
  const pages = [{
    id: 7, name: 'Заявка', recs: [
      { id: 1, name: 'Логін', running: true, subs: [{ status: 'done' }, { status: 'failed' }] },
      { id: 2, name: 'Дія 3', running: true, subs: [{ status: 'failed' }] },
      { id: 3, running: false, subs: [{ status: 'failed' }] }, // не в ланцюгу — не рахуємо
    ],
  }];
  assert.deepEqual(deriveRunMeta(pages, { pageId: 7 }), { scenario: 'Заявка', upto: 2, uptoName: 'Дія 3', total: 3, failed: 2 });
  assert.equal(deriveRunMeta(pages, null), null);
  assert.equal(deriveRunMeta(pages, { pageId: 99 }), null);
  assert.deepEqual(deriveRunMeta([{ id: 1, name: 'Порожній', recs: [] }], { pageId: 1 }), { scenario: 'Порожній', upto: 0, uptoName: '', total: 0, failed: 0 });
});

test('screenTitle/screenStatus: підписи табів і статус-крапка', () => {
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 2, total: 3 }), 'Заявка · до Дії 2');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 3, total: 3 }), 'Заявка · усі Дії (3)');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 1, total: 1 }), 'Заявка · Дія 1');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 0, total: 2 }), 'Заявка · лише URL');
  assert.equal(screenTitle({ label: '🎬 Сирий (1/2)' }), 'Сирий (1/2)');
  assert.equal(screenTitle(null), 'Скрін');
  assert.equal(screenStatus({ failed: 0 }), 'ok');
  assert.equal(screenStatus({ failed: 2 }), 'failed');
  assert.equal(screenStatus({ ok: false }), 'failed');
  assert.equal(screenStatus({ stopped: true }), 'stopped');
  assert.equal(screenStatus({ stopped: true, failed: 1 }), 'failed');
  assert.equal(screenStatus({ degraded: 2 }), 'degraded');
  assert.equal(screenStatus({ degraded: 2, failed: 1 }), 'failed');
  assert.equal(STATUS_TEXT.degraded, '⚠ запасний шлях');
});

test('screenTitle: назва Дії (як у сайдбарі), а не порядковий номер; старі скріни — номер', () => {
  assert.equal(screenTitle({ scenario: 'Форма В', upto: 1, total: 1, uptoName: 'Дія 3' }), 'Форма В · «Дія 3»');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 2, total: 3, uptoName: 'Логін' }), 'Заявка · до «Логін»');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 3, total: 3, uptoName: 'Фінал' }), 'Заявка · усі Дії (3)');
  assert.equal(screenTitle({ scenario: 'Заявка', upto: 0, total: 2, uptoName: '' }), 'Заявка · лише URL');
});

test('runBanner / runBannerText / placeholderMode: смуга прогону й порожній стан переглядача', () => {
  const recA = { id: 1, name: 'Дія 1', subs: [{ status: 'done' }, { status: 'running' }] };
  const page = { id: 5, name: 'Форма В', recs: [recA] };
  const plan = {
    total: 2, flat: [{ type: 'key', key: 'Tab' }, { type: 'key', key: 'Enter' }],
    map: [{ rec: recA, subIdxs: [0] }, { rec: recA, subIdxs: [1] }], results: [{ ok: true }, null],
  };
  const b = runBanner([page], { pageId: 5, plan });
  assert.deepEqual({ ...b, label: !!b.label }, { scenario: 'Форма В', total: 2, cur: 2, recName: 'Дія 1', label: true, stopping: false });
  assert.match(runBannerText(b), /^▶ Виконується «Форма В» · крок 2\/2 · Дія 1 — /);
  assert.match(runBannerText({ ...b, stopping: true }), /^⏹ Зупиняю «Форма В»/);
  assert.match(runBannerText({ scenario: 'X', total: 0 }), /відкриваю URL/);
  assert.equal(runBanner([page], null), null);
  assert.equal(runBanner([page], { pageId: 9, plan }), null);
  // Ще жоден крок не «running» — номер за кількістю результатів.
  recA.subs[1].status = 'idle';
  assert.equal(runBanner([page], { pageId: 5, plan }).cur, 2);
  // ⏱ Пауза після кроку 1: смуга НЕ каже «виконується крок 2», а «пауза після кроку 1 — далі: …».
  recA.subs[0].status = 'done'; recA.subs[1].status = 'idle';
  const pz = runBanner([page], { pageId: 5, plan: { ...plan, results: [{ ok: true }, null], pause: { index: 0, ms: 6000 } } });
  assert.equal(pz.cur, 1);
  assert.equal(pz.pause, 6000);
  assert.ok(pz.next);
  assert.match(runBannerText(pz), /^⏱ «Форма В» · пауза 6 с після кроку 1\/2 — далі: /);
  const last = runBanner([page], { pageId: 5, plan: { ...plan, pause: { index: 1, ms: 250 } } });
  assert.match(runBannerText(last), /пауза 250 мс після кроку 2\/2 — далі: фінальний скрин$/);
  assert.match(runBannerText({ ...pz, stopping: true }), /^⏹ Зупиняю/);
  assert.equal(runBanner([page], { pageId: 5, plan }).pause, undefined);
  assert.equal(placeholderMode([], null), 'onboarding');
  assert.equal(placeholderMode([page], null), 'hint');
  assert.equal(placeholderMode([page], { pageId: 5, error: 'x' }), 'error');
});
