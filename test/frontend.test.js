// Юніт-тести чистої логіки фронтенду (public/js/*.js) — без DOM і без браузера.
// Модулі UI не чіпають DOM під час імпорту, тож імпортуються прямо в Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, parseJsonResponse, createNdjsonParser, readNdjson, streamNdjson, createApi, createSerialSaver,
} from '../public/js/api.js';
import { state, on, emit, createExpandStore } from '../public/js/state.js';
import {
  validateUrl, normalizeUrlInput, pagesFromApi, maxId, nextPageId,
} from '../public/js/scenarioModel.js';
// План/події прогону — runner.js (ним користуються і ▶, і префікс живого запису).
import { createRunPlan as prepareRun, applyRunEvent, finishRun } from '../public/js/runner.js';
import {
  configSig, subsetEq, presetMatches, makeDraft, setPath, draftBody, captureFingerprint,
  shouldAutoCapture, chipInfo, engineName,
  busyLabel,
} from '../public/js/config.js';
import { validateFields } from '../public/js/dialogs.js';
import { pushScreen } from '../public/js/viewer.js';
import { shotPoint } from '../public/js/recorder.js';

const streamOf = (chunks) => new ReadableStream({
  start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
});
const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), m };
};

// ---------- api.js ----------
test('createNdjsonParser: рядки, розбиті між шматками, хвіст без \\n і битий рядок', () => {
  const evs = [];
  const p = createNdjsonParser((e) => evs.push(e));
  p.push('{"event":"run","ru');
  p.push('nId":"a"}\n\n{"event":"log"');
  p.push(',"text":"x"}\nnot-json\n{"event":"done"}');
  assert.equal(evs.length, 3);
  p.end();
  assert.deepEqual(evs.map((e) => e.event), ['run', 'log', 'parse-error', 'done']);
  assert.equal(evs[0].runId, 'a');
  assert.equal(evs[2].line, 'not-json');
});

test('readNdjson: читає ReadableStream, UTF-8 на межі шматків', async () => {
  const bytes = new TextEncoder().encode('{"text":"Привіт"}\n');
  const evs = [];
  const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 11)); c.enqueue(bytes.slice(11)); c.close(); } });
  await readNdjson(body, (e) => evs.push(e));
  assert.deepEqual(evs, [{ text: 'Привіт' }]);
});

test('readNdjson: abort → AbortError і зупинка читання', async () => {
  const ac = new AbortController();
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; c.enqueue(new TextEncoder().encode('{"a":1}\n')); } });
  const evs = [];
  const p = readNdjson(body, (e) => { evs.push(e); ac.abort(); }, { signal: ac.signal });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.deepEqual(evs, [{ a: 1 }]);
  assert.ok(ctrl);
});

test('streamNdjson: не-2xx до початку стріму → ApiError з повідомленням сервера', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'Не передано url' }), { status: 400 });
  await assert.rejects(streamNdjson(fetchImpl, '/replay', {}, () => {}),
    (e) => e instanceof ApiError && e.status === 400 && e.message === 'Не передано url');
});

test('streamNdjson: 2xx → події по порядку; тіло запиту — JSON', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(streamOf(['{"event":"run","runId":"r1"}\n', '{"event":"done"}\n'])); };
  const evs = [];
  await streamNdjson(fetchImpl, '/replay', { url: 'x' }, (e) => evs.push(e.event));
  assert.deepEqual(evs, ['run', 'done']);
  assert.equal(seen.url, '/replay');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { url: 'x' });
});

test('parseJsonResponse: не-JSON помилка → «HTTP 502: …»', async () => {
  await assert.rejects(parseJsonResponse(new Response('Bad gateway', { status: 502 })), /HTTP 502: Bad gateway/);
  assert.deepEqual(await parseJsonResponse(new Response('', { status: 200 })), {});
});

test('createApi: маршрути й методи відповідають routes/*.js', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push([init.method || 'GET', url, init.body]); return new Response('{"ok":true}'); };
  const api = createApi(fetchImpl);
  await api.getPages();
  await api.savePage(7, { name: 'a' });
  await api.deletePage(7);
  await api.getProfile();
  await api.postProfile({ fingerprint: null });
  await api.getPresets();
  await api.createPreset('P', { launch: {} });
  await api.updatePreset(3, { launch: {} });
  await api.stopReplay('id/1');
  assert.deepEqual(calls.map((c) => c[0] + ' ' + c[1]), [
    'GET /pages', 'PUT /pages/7', 'DELETE /pages/7', 'GET /profile', 'POST /profile', 'GET /presets',
    'POST /presets', 'PUT /presets/3', 'POST /replay/id%2F1/stop',
  ]);
  assert.deepEqual(JSON.parse(calls[6][2]), { name: 'P', body: { launch: {} } });
  assert.deepEqual(JSON.parse(calls[7][2]), { body: { launch: {} } });
});

test('createApi.upload: бінарне тіло + x-filename', async () => {
  let init;
  const api = createApi(async (_u, i) => { init = i; return new Response('{"ok":true,"fileId":"f","filename":"a b.pdf"}'); });
  const d = await api.upload({ name: 'a b.pdf' });
  assert.equal(d.fileId, 'f');
  assert.equal(init.headers['x-filename'], 'a%20b.pdf');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
});

test('createSerialSaver: по ключу послідовно; проміжні виклики зливаються в один (найсвіжіший)', async () => {
  const log = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = createSerialSaver();
  const p1 = s.save(1, async () => { log.push('a-start'); await gate; log.push('a-end'); });
  const p2 = s.save(1, async () => log.push('b'));
  const p3 = s.save(1, async () => log.push('c'));
  const q = s.save(2, async () => log.push('other'));
  await q;
  assert.deepEqual(log, ['a-start', 'other']);
  release();
  assert.equal(await p1, true);
  await p2; await p3;
  assert.deepEqual(log, ['a-start', 'other', 'a-end', 'c']);
  assert.equal(s.busy, false);
});

test('createSerialSaver: помилка → onError і false', async () => {
  const errs = [];
  const s = createSerialSaver({ onError: (e, k) => errs.push([e.message, k]) });
  assert.equal(await s.save('x', async () => { throw new Error('503'); }), false);
  assert.deepEqual(errs, [['503', 'x']]);
});

// ---------- state.js ----------
test('createExpandStore: дефолт, збереження у сховищі, битий JSON', () => {
  const st = memStorage({ expandState: '{"p":{"1":false}}' });
  const e = createExpandStore(st);
  assert.equal(e.get('p', 1, true), false);
  assert.equal(e.get('r', 5, false), false);
  e.set('r', 5, true);
  assert.deepEqual(JSON.parse(st.get('expandState')), { p: { 1: false }, r: { 5: true } });
  assert.equal(createExpandStore(memStorage({ expandState: '{oops' })).get('p', 1, true), true);
});

test('on/emit: підписка, відписка, падіння обробника не ламає інших', () => {
  const got = [];
  const off = on('t-evt', (p) => got.push(p));
  on('t-evt', () => { throw new Error('boom'); });
  const origErr = console.error; console.error = () => {};
  try { emit('t-evt', 1); off(); emit('t-evt', 2); } finally { console.error = origErr; }
  assert.deepEqual(got, [1]);
  assert.equal(typeof state.pages, 'object');
});

// ---------- scenarioModel.js ----------
test('validateUrl / normalizeUrlInput', () => {
  assert.equal(validateUrl(''), 'Вкажи стартовий URL');
  assert.equal(validateUrl('   '), 'Вкажи стартовий URL');
  assert.equal(validateUrl('example.com'), '');
  assert.equal(validateUrl('http://127.0.0.1:3202/click.html'), '');
  assert.match(validateUrl('ftp://x.com'), /http/);
  assert.match(validateUrl('a b.com'), /пробіл/);
  assert.match(validateUrl('http://'), /URL/);
  assert.equal(normalizeUrlInput(' example.com '), 'https://example.com');
  assert.equal(normalizeUrlInput('http://a.b'), 'http://a.b');
});

test('pagesFromApi + maxId: id як числа, памʼять розгортання, копії під-дій', () => {
  const raw = [{ id: '3', name: 'A', url: 'u', recs: [{ id: '9', name: 'Д', subs: [{ type: 'click', x: 1, y: 2 }] }] }];
  const pages = pagesFromApi(raw, { get: (k, id, d) => (k === 'r' && id === 9 ? true : d) });
  assert.equal(pages[0].id, 3);
  assert.equal(pages[0].expanded, true);
  assert.equal(pages[0].recs[0].expanded, true);
  pages[0].recs[0].subs[0].x = 100;
  assert.equal(raw[0].recs[0].subs[0].x, 1);
  assert.equal(maxId(pages), 3);
  assert.equal(maxId(pages.flatMap((p) => p.recs)), 9);
  assert.equal(maxId([]), 0);
});

test('nextPageId: часова мітка (без колізій між вкладками), монотонно зростає', () => {
  assert.equal(nextPageId(3, 1700000000000), 1700000000000);
  // Два сценарії в ту саму мілісекунду — все одно різні id.
  assert.equal(nextPageId(1700000000000, 1700000000000), 1700000000001);
  assert.equal(nextPageId(0, NaN), 1);
  assert.ok(Number.isSafeInteger(nextPageId(0)));
});

function samplePage() {
  return {
    id: 1, name: 'S', url: 'http://x', recs: [
      { id: 10, name: 'Д1', subs: [
        { type: 'move', x: 1, y: 1 },
        { type: 'click', x: 5, y: 6, sw: 100, sh: 200 },
        { type: 'text', text: 'a' }, { type: 'text', text: 'b', random: 'digit' },
        { type: 'key', key: 'Enter' },
      ] },
      { id: 11, name: 'Д2', subs: [{ type: 'click', x: 7, y: 8 }] },
      { id: 12, name: 'Д3', subs: [{ type: 'click', x: 9, y: 9 }] },
    ],
  };
}

test('prepareRun: спільний flattenScenario — gid, пропуск рухів, злиття legacy-тексту, статуси', () => {
  const page = samplePage();
  const plan = prepareRun(page, 11, { skipMoves: true });
  assert.equal(plan.total, 4); // click, text(ab→шаблон), key, click
  assert.deepEqual(plan.flat.map((s) => s.type), ['click', 'text', 'key', 'click']);
  assert.equal(plan.flat[1].text, 'a{d}');
  assert.deepEqual(plan.flat.map((s) => s.gid), [10, 10, 10, 11]);
  assert.equal(plan.recs.length, 2);
  const [d1, d2, d3] = page.recs;
  assert.equal(d1.subs[0].status, 'skipped');
  assert.equal(d1.subs[1].status, 'idle');
  assert.equal(d1.running && d2.running, true);
  assert.equal(d3.running, undefined);
  assert.equal(d1.runTotal, 3);
  assert.equal(d2.runTotal, 1);
  // Модель під-дій не змінюється (лише статуси).
  assert.equal(d1.subs[2].text, 'a');
  assert.equal(d1.subs[3].random, 'digit');
});

test('prepareRun: без skipMoves рухи йдуть у прогін; невідома Дія → помилка', () => {
  const plan = prepareRun(samplePage(), null, { skipMoves: false });
  assert.equal(plan.flat[0].type, 'move');
  assert.throws(() => prepareRun(samplePage(), 999), /не знайдено/);
});

test('applyRunEvent: злитий текст оновлює всі свої під-дії; помилка зберігається; finishRun', () => {
  const page = samplePage();
  const plan = prepareRun(page, null, { skipMoves: true });
  const d1 = page.recs[0];
  let r = applyRunEvent(plan, { event: 'action', index: 1 });
  assert.equal(r.rec, d1);
  assert.equal(d1.runCur, 2);
  assert.equal(d1.subs[2].status, 'running');
  assert.equal(d1.subs[3].status, 'running');
  applyRunEvent(plan, { event: 'done-action', index: 1, ok: false, error: 'немає фокусу' });
  assert.equal(d1.subs[2].status, 'failed');
  assert.equal(d1.subs[3].error, 'немає фокусу');
  applyRunEvent(plan, { event: 'done-action', index: 0, ok: true, skipped: true });
  assert.equal(d1.subs[1].status, 'skipped');
  applyRunEvent(plan, { event: 'done-action', index: 2, ok: false, aborted: true, error: 'stop' });
  assert.equal(d1.subs[4].status, 'skipped');
  applyRunEvent(plan, { event: 'done-action', index: 3, ok: true });
  assert.equal(page.recs[1].subs[0].status, 'done');
  assert.equal(applyRunEvent(plan, { event: 'action', index: 99 }), null);
  assert.equal(applyRunEvent(plan, { event: 'log' }), null);
  page.running = true;
  finishRun(page, plan);
  assert.equal(page.running, false);
  assert.ok(page.recs.every((x) => !x.running));
  // Повторний прогін скидає старі помилки.
  prepareRun(page, null);
  assert.equal(d1.subs[3].error, undefined);
});

// ---------- config.js ----------
const DEFAULTS = { launch: { headless: true, stealthPlugin: false }, stealth: { webdriver: false }, behavior: { humanize: false } };
test('presetMatches: часткове порівняння; Clear all = дефолти + без fingerprint', () => {
  const prof = { launch: { headless: true, stealthPlugin: false, engine: 'chromium' }, stealth: { webdriver: false }, behavior: { humanize: false }, fingerprint: null, defaults: DEFAULTS };
  assert.equal(presetMatches({ clear: true }, prof), true);
  assert.equal(presetMatches({ clear: true }, { ...prof, fingerprint: { userAgent: 'x' } }), false);
  assert.equal(presetMatches({ launch: { engine: 'camoufox' } }, prof), false);
  assert.equal(presetMatches({ launch: { engine: 'chromium' } }, prof), true);
  assert.equal(presetMatches({ fingerprint: null }, prof), true);
  assert.equal(presetMatches(null, prof), false);
  assert.equal(subsetEq(null, {}), true);
});

test('makeDraft / configSig / setPath / draftBody', () => {
  const d = makeDraft({ launch: { engine: 'camoufox' }, fingerprint: { screen: { width: 1 } }, cookiesCount: 2 });
  assert.equal(d.launch.engine, 'camoufox');
  assert.equal(d.launch.siteIsolationDisabled, true);
  assert.equal(d.behavior.prepareScroll, true);
  assert.equal(d.hasFingerprint, true);
  const before = configSig(d);
  setPath(d, 'fingerprint.screen.height', 900);
  assert.notEqual(configSig(d), before);
  const e = makeDraft({});
  assert.equal(e.fingerprint, null);
  setPath(e, 'fingerprint.userAgent', 'UA');
  assert.deepEqual(e.fingerprint, { userAgent: 'UA' });
  assert.deepEqual(Object.keys(draftBody(d)), ['launch', 'stealth', 'behavior', 'fingerprint']);
});

test('captureFingerprint: з інʼєктованих navigator/window/Intl', () => {
  const nav = { userAgent: 'UA', language: 'uk-UA', languages: ['uk-UA', 'en'], platform: 'MacIntel', vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8 };
  const win = { devicePixelRatio: 2, screen: { width: 1512, height: 982, colorDepth: 30 } };
  const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Kyiv' }) }) };
  assert.deepEqual(captureFingerprint(nav, win, intl), {
    userAgent: 'UA', locale: 'uk-UA', languages: ['uk-UA', 'en'], timezoneId: 'Europe/Kyiv', platform: 'MacIntel',
    vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8, deviceScaleFactor: 2,
    screen: { width: 1512, height: 982, colorDepth: 30 },
  });
});

test('shouldAutoCapture: лише коли fingerprint немає і пресет не «голий»', () => {
  assert.equal(shouldAutoCapture({ fingerprint: null }, null), true);
  assert.equal(shouldAutoCapture({ fingerprint: { userAgent: 'edited' } }, null), false);
  assert.equal(shouldAutoCapture({ fingerprint: null }, { body: { clear: true } }), false);
  assert.equal(shouldAutoCapture({ fingerprint: null }, { body: { fingerprint: null } }), false);
  assert.equal(shouldAutoCapture({ fingerprint: null }, { body: { launch: {} } }), true);
  assert.equal(shouldAutoCapture(null, null), false);
});

test('chipInfo: рушій · пресет / кастом / без пресетів', () => {
  const prof = { launch: { engine: 'chromium', headless: true }, stealth: {}, behavior: {}, fingerprint: null, defaults: { launch: { headless: false } } };
  const presets = [{ id: 1, name: '🛡️ All', body: { launch: { headless: true } } }, { id: 2, name: '☁️ Cloudflare', body: { launch: { engine: 'camoufox' } } }];
  assert.deepEqual(chipInfo(prof, presets, 1), { text: '🧩 Chromium · 🛡️ All', custom: false });
  assert.deepEqual(chipInfo(prof, presets, 2), { text: '🧩 Chromium · 🛡️ All', custom: false }); // збережений не збігся → перший, що збігся
  assert.deepEqual(chipInfo({ ...prof, launch: { engine: 'chromium', headless: false } }, presets, null), { text: '🧩 Chromium · кастом', custom: true });
  assert.deepEqual(chipInfo(prof, [], null), { text: '🧩 Chromium', custom: false });
  assert.equal(engineName({ engine: 'camoufox' }), '🦊 Camoufox');
});

// ---------- dialogs.js / viewer.js / recorder.js ----------
test('validateFields: required, validate(value, values)', () => {
  const fields = [
    { name: 'url', required: true, requiredMsg: 'Вкажи URL', validate: validateUrl },
    { name: 'name', validate: (v, all) => (v === all.url ? 'не як URL' : '') },
  ];
  assert.deepEqual(validateFields(fields, { url: ' ', name: '' }), { url: 'Вкажи URL' });
  assert.deepEqual(validateFields(fields, { url: 'ftp://a', name: 'n' }), { url: 'Підтримуються лише http:// і https://' });
  assert.deepEqual(validateFields(fields, { url: 'a.com', name: 'a.com' }), { name: 'не як URL' });
  assert.deepEqual(validateFields(fields, { url: 'a.com', name: 'ok' }), {});
});

test('pushScreen: новий першим, ліміт', () => {
  let list = [];
  for (let i = 1; i <= 5; i++) list = pushScreen(list, { id: i }, 3);
  assert.deepEqual(list.map((s) => s.id), [5, 4, 3]);
});

test('shotPoint: від content-box (без рамки), масштаб до натуральних пікселів, обмеження', () => {
  const img = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 642, height: 1002 }),
    clientLeft: 1, clientTop: 1, clientWidth: 640, clientHeight: 1000,
    naturalWidth: 1280, naturalHeight: 2000,
  };
  assert.deepEqual(shotPoint({ clientX: 101, clientY: 51 }, img), { x: 0, y: 0, sw: 1280, sh: 2000 });
  assert.deepEqual(shotPoint({ clientX: 421, clientY: 551 }, img), { x: 640, y: 1000, sw: 1280, sh: 2000 });
  assert.deepEqual(shotPoint({ clientX: 99, clientY: 2000 }, img), { x: 0, y: 1999, sw: 1280, sh: 2000 });
});

// ---------- Застосування конфігу: лічильник і тайм-аут ----------
test('busyLabel: секунди зʼявляються з 1 с', () => {
  assert.equal(busyLabel('Перезапускаю браузер…', 0), 'Перезапускаю браузер…');
  assert.equal(busyLabel('Перезапускаю браузер…', 7), 'Перезапускаю браузер… 7 с');
  assert.equal(busyLabel(undefined, 2), 'Застосовую… 2 с');
});

test('createApi.postProfile: є тайм-аут — завислий сервер дає зрозумілу помилку, а не вічний спінер', async () => {
  let seen = null;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    seen = init;
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const api = createApi(fetchImpl);
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => realSet(fn, ms > 1000 ? 5 : ms); // прискорюємо 3-хвилинний тайм-аут
  try {
    await assert.rejects(api.postProfile({ launch: { engine: 'camoufox' } }), (e) => e.timeout === true && /не відповів за 180 с/.test(e.message));
  } finally { globalThis.setTimeout = realSet; }
  assert.ok(seen && seen.signal, 'запит має signal');
});

test('createApi: звичайні запити без тайм-ауту (без signal)', async () => {
  let seen = null;
  const api = createApi(async (url, init) => { seen = init; return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); });
  await api.getProfile();
  assert.equal(seen.signal, undefined);
});
