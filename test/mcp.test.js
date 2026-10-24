// Юніт-тести MCP: протокол (lib/mcp.js), чиста логіка тулів (lib/mcpTools.js) і тимчасові
// браузери (lib/scratch.js) з фейковими запускачами — без браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, negotiateVersion, MCP_PROTOCOL_VERSIONS, RPC, toolError } from '../lib/mcp.js';
import {
  resolveMcpProfile, findPreset, findByRef, unitSource, checkUrl, truncate, joinFrameTexts, formatLinks,
  clampInt, cfLine, formatHeader, createMcpTools, MCP_FLAGS,
} from '../lib/mcpTools.js';
import { createScratchBrowsers } from '../lib/scratch.js';
import { defaultProfile } from '../lib/profile.js';

const quiet = { log() {}, error() {} };

// ---------- протокол ----------
function server(extraTools = []) {
  return createMcpServer({
    name: 'srv', version: '9', instructions: 'hi', log: quiet,
    tools: [
      { name: 'echo', description: 'e', inputSchema: { type: 'object' }, handler: async (a) => 'got ' + a.x },
      { name: 'boom', description: 'b', inputSchema: { type: 'object' }, handler: async () => { throw new Error('bad thing'); } },
      { name: 'obj', description: 'o', inputSchema: { type: 'object' }, handler: async () => ({ a: 1 }) },
      ...extraTools,
    ],
  });
}

test('mcp initialize: узгодження версії, capabilities.tools, serverInfo, instructions', async () => {
  const s = server();
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(r.result.serverInfo, { name: 'srv', version: '9' });
  assert.equal(r.result.instructions, 'hi');
  const r2 = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r2.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateVersion(undefined), MCP_PROTOCOL_VERSIONS[0]);
});

test('mcp: сповіщення без відповіді, ping, невідомий метод, некоректний запит', async () => {
  const s = server();
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, RPC.METHOD_NOT_FOUND);
  assert.equal((await s.handle({ id: 4, method: 'ping' })).error.code, RPC.INVALID_REQUEST);
  assert.equal((await s.handle('x')).error.code, RPC.INVALID_REQUEST);
  assert.equal((await s.handle([])).error.code, RPC.INVALID_REQUEST);
});

test('mcp tools/list — без handler; tools/call: рядок/обʼєкт → content, помилка → isError, невідомий тул → -32602', async () => {
  const s = server();
  const list = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom', 'obj']);
  assert.ok(list.result.tools.every((t) => !('handler' in t)));
  const ok = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { x: 5 } } });
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: 'got 5' }] });
  const obj = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'obj' } });
  assert.deepEqual(JSON.parse(obj.result.content[0].text), { a: 1 });
  const bad = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /bad thing/);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x' } })).error.code, RPC.INVALID_PARAMS);
});

test('mcp: батч — відповіді лише на запити; лише сповіщення → null', async () => {
  const s = server();
  const out = await s.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  assert.equal(out.length, 1);
  assert.equal(await s.handle([{ jsonrpc: '2.0', method: 'notifications/x' }]), null);
});

test('mcp: очікувана помилка тула (toolError) не пишеться в лог сервера', async () => {
  const errs = [];
  const s = createMcpServer({ name: 'n', version: '1', log: { error: (...a) => errs.push(a) }, tools: [
    { name: 'a', handler: async () => { throw toolError('arg wrong'); } },
    { name: 'b', handler: async () => { throw new Error('crash'); } },
  ] });
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } });
  assert.equal(errs.length, 0);
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'b' } });
  assert.equal(errs.length, 1);
});

// ---------- чиста логіка тулів ----------
const PRESETS = [
  { id: 1, name: '🧹 Clear all', body: { clear: true } },
  { id: 2, name: '☁️ Cloudflare', body: { launch: { engine: 'camoufox' } } },
  { id: 3, name: '📋 Ashby', body: { launch: { engine: 'chromium', siteIsolationDisabled: true }, behavior: { humanize: true }, cookies: [{ name: 'x', value: 'y' }] } },
];

test('findPreset: за id, точною назвою, без емодзі-префікса, без регістру', () => {
  assert.equal(findPreset(PRESETS, 2).id, 2);
  assert.equal(findPreset(PRESETS, '3').id, 3);
  assert.equal(findPreset(PRESETS, '🧹 Clear all').id, 1);
  assert.equal(findPreset(PRESETS, 'cloudflare').id, 2);
  assert.equal(findPreset(PRESETS, '  ASHBY ').id, 3);
  assert.equal(findPreset(PRESETS, 'nope'), null);
  assert.equal(findPreset(PRESETS, ''), null);
});

test('findByRef: id або назва', () => {
  const items = [{ id: 7, name: 'Тест форма' }, { id: 8, name: 'Інше' }];
  assert.equal(findByRef(items, 7).id, 7);
  assert.equal(findByRef(items, '8').id, 8);
  assert.equal(findByRef(items, 'тест   форма').id, 7);
  assert.equal(findByRef(items, 'x'), null);
  assert.equal(findByRef(items, ''), null);
});

test('resolveMcpProfile: без аргументів — застосований профіль, нічого не мутує', () => {
  const applied = defaultProfile();
  const snap = JSON.stringify(applied);
  const r = resolveMcpProfile(applied, {});
  assert.equal(r.profile, applied);
  assert.equal(r.label, 'застосований конфіг');
  resolveMcpProfile(applied, { engine: 'camoufox', launch: { headless: false }, fingerprint: { locale: 'uk' }, proxy: false, cookies: false });
  assert.equal(JSON.stringify(applied), snap, 'застосований профіль не змінено');
});

test('resolveMcpProfile: пресет (білий список тіла — cookies з пресета ігноруються) + перевизначення поверх', () => {
  const applied = { ...defaultProfile(), storageState: { cookies: [{ name: 'mine', value: '1' }] } };
  const a = resolveMcpProfile(applied, { preset: 'Ashby', launch: { headless: false }, stealth: { webdriver: false } }, PRESETS);
  assert.equal(a.profile.launch.siteIsolationDisabled, true);
  assert.equal(a.profile.launch.headless, false);
  assert.equal(a.profile.stealth.webdriver, false);
  assert.equal(a.profile.storageState.cookies[0].name, 'mine', 'cookies пресета не потрапили');
  assert.equal(a.label, 'пресет «📋 Ashby» + launch.headless=false + stealth.webdriver=false');
  const c = resolveMcpProfile(applied, { preset: 'clear all' }, PRESETS);
  assert.equal(c.profile.launch.stealthPlugin, false);
  assert.equal(c.profile.stealth.webdriver, false);
  const cf = resolveMcpProfile(applied, { preset: 2, engine: 'chromium' }, PRESETS);
  assert.equal(cf.profile.launch.engine, 'chromium', 'engine після пресета');
  assert.throws(() => resolveMcpProfile(applied, { preset: 'x' }, PRESETS), /не знайдено.*Clear all/);
  assert.throws(() => resolveMcpProfile(applied, { preset: 'x' }, []), /Пресетів немає/);
});

test('resolveMcpProfile: валідація прапорців, fingerprint, проксі, cookies', () => {
  const applied = { ...defaultProfile(), fingerprint: { userAgent: 'A', locale: 'en-US' }, proxy: { server: 'http://p:1' }, storageState: { cookies: [{ name: 'c' }] } };
  assert.throws(() => resolveMcpProfile(applied, { engine: 'webkit' }), /chromium \| camoufox/);
  assert.throws(() => resolveMcpProfile(applied, { launch: { foo: true } }), /launch\.foo: невідомий/);
  assert.throws(() => resolveMcpProfile(applied, { stealth: { webdriver: 'yes' } }), /true або false/);
  assert.throws(() => resolveMcpProfile(applied, { behavior: [] }), /обʼєкт/);
  assert.throws(() => resolveMcpProfile(applied, { fingerprint: { gpu: 'x' } }), /fingerprint\.gpu/);
  assert.throws(() => resolveMcpProfile(applied, { proxy: 'ftp://x:1' }), /^Error: proxy:/);
  const fp = resolveMcpProfile(applied, { fingerprint: { locale: 'uk-UA' } });
  assert.deepEqual(fp.profile.fingerprint, { userAgent: 'A', locale: 'uk-UA' }, 'злиття з поточним');
  assert.equal(resolveMcpProfile(applied, { fingerprint: null }).profile.fingerprint, null);
  assert.equal(resolveMcpProfile(applied, { proxy: false }).profile.proxy, null);
  assert.equal(resolveMcpProfile(applied, { proxy: 'h2:8080' }).profile.proxy.server, 'http://h2:8080');
  assert.equal(resolveMcpProfile(applied, { cookies: false }).profile.storageState, null);
  assert.equal(resolveMcpProfile(applied, { cookies: true }).profile.storageState.cookies.length, 1);
  for (const g of Object.keys(MCP_FLAGS)) for (const k of MCP_FLAGS[g]) assert.ok(k in defaultProfile()[g], g + '.' + k + ' існує в профілі');
});

test('unitSource: пул / основний браузер з іншим контекстом / тимчасовий браузер', () => {
  const applied = defaultProfile();
  assert.equal(unitSource(applied, applied), 'pool');
  assert.equal(unitSource({ ...applied, behavior: { humanize: false } }, applied), 'pool', 'поведінка не задається контекстом');
  assert.equal(unitSource({ ...applied, fingerprint: { locale: 'uk' } }, applied), 'main');
  assert.equal(unitSource({ ...applied, stealth: { ...applied.stealth, webdriver: false } }, applied), 'main');
  assert.equal(unitSource({ ...applied, storageState: null, stealth: { pwInitScripts: true, permissions: true, outerWindow: true, windowChrome: true, webdriver: true } }, applied), 'pool', 'порядок ключів не важить');
  assert.equal(unitSource({ ...applied, launch: { ...applied.launch, headless: false } }, applied), 'scratch');
  assert.equal(unitSource({ ...applied, launch: { ...applied.launch, engine: 'camoufox' } }, applied), 'scratch');
  const cfx = { ...applied, launch: { ...applied.launch, engine: 'camoufox' } };
  assert.equal(unitSource({ ...cfx, fingerprint: { locale: 'uk' } }, cfx), 'pool', 'Camoufox ігнорує контекстні опції');
});

test('checkUrl: http(s), без схеми → https (локальні → http), інші схеми — помилка', () => {
  assert.equal(checkUrl('example.com/x'), 'https://example.com/x');
  assert.equal(checkUrl('http://a.test'), 'http://a.test/');
  assert.equal(checkUrl('localhost:8765/fx.html'), 'http://localhost:8765/fx.html');
  assert.equal(checkUrl('127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(checkUrl(' HTTPS://A.test '), 'https://a.test/');
  assert.throws(() => checkUrl('file:///etc/passwd'), /лише http/);
  assert.throws(() => checkUrl('javascript:alert(1)'), /лише http/);
  assert.throws(() => checkUrl(''), /обовʼязковий/);
  assert.throws(() => checkUrl(5), /обовʼязковий/);
  assert.throws(() => checkUrl('http://'), /некоректна/);
});

test('форматери: truncate, joinFrameTexts, formatLinks, clampInt, cfLine, formatHeader', () => {
  assert.deepEqual(truncate('abcdef', 4), { text: 'abcd', truncated: true, total: 6 });
  assert.deepEqual(truncate('ab', 4), { text: 'ab', truncated: false, total: 2 });
  assert.equal(joinFrameTexts([{ url: 'm', text: ' main ' }, null, { url: 'f1', text: '  ' }, { url: 'f2', text: 'inner' }]), 'main\n\n--- iframe: f2 ---\ninner');
  assert.equal(joinFrameTexts([]), '');
  assert.equal(formatLinks([['A', 'https://a/'], ['dup', 'https://a/'], ['js', 'javascript:x'], ['', 'http://b/'], ['[x]', 'https://c/']]),
    '- [A](https://a/)\n- [—](http://b/)\n- [x](https://c/)');
  assert.equal(formatLinks([['1', 'https://1/'], ['2', 'https://2/']], 1), '- [1](https://1/)');
  assert.equal(clampInt(undefined, 0, 10, 3), 3);
  assert.equal(clampInt('abc', 0, 10, 3), 3);
  assert.equal(clampInt(99, 0, 10, 3), 10);
  assert.equal(clampInt(-5, 0, 10, 3), 0);
  assert.equal(cfLine(null), 'челенджу не було');
  assert.equal(cfLine({ wasChallenge: true, passed: true }), 'челендж ПРОЙДЕНО');
  assert.match(cfLine({ wasChallenge: true, passed: false }), /НЕ пройдено/);
  const h = formatHeader({ url: 'https://x/', status: 200, title: 'T', label: 'L', profile: { launch: { engine: 'camoufox' } }, source: 'scratch', launched: true, cf: null, ms: 1234, extra: ['E'] });
  assert.match(h, /^URL: https:\/\/x\/ \(HTTP 200\)\nЗаголовок: T\nРушій: Camoufox .*конфіг: L \(не збережено\)\nБраузер: тимчасовий.*щойно запущено\nCloudflare: челенджу не було\nE\nЧас: 1\.2 с$/);
});

// ---------- тули з фейковими залежностями ----------
function toolsWith({ pages = [], presets = null } = {}) {
  const applied = defaultProfile();
  const db = presets ? { presets: { list: async () => presets }, pages: { list: async () => pages } } : null;
  const mem = new Map(pages.map((p) => [p.id, p]));
  const tools = createMcpTools({
    engine: { engineReady: () => true }, sem: { acquire: async () => {}, release() {} },
    profileStore: { get: () => applied }, getDb: () => db, pagesMem: mem, config: {}, log: quiet,
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

test('get_config: застосований конфіг без пароля проксі, пресети (білий список тіла), перелік прапорців', async () => {
  const t = toolsWith({ presets: PRESETS });
  const out = JSON.parse((await t.get_config.handler({})).content[0].text);
  assert.equal(out.applied.engine, 'chromium');
  assert.equal(out.presets.length, 3);
  assert.deepEqual(out.presets[2].body, { launch: { engine: 'chromium', siteIsolationDisabled: true }, behavior: { humanize: true } });
  assert.deepEqual(out.overridable.engine, ['chromium', 'camoufox']);
  const noDb = JSON.parse((await toolsWith().get_config.handler({})).content[0].text);
  assert.match(noDb.presetsNote, /БД недоступна/);
});

test('list_scenarios: Дії, кількість кроків (без рухів), побічний ефект, підписи', async () => {
  const t = toolsWith({ pages: [{ id: 1, name: 'S', url: 'https://x', recs: [{ id: 5, name: 'Дія 1', subs: [
    { type: 'move', x: 1, y: 1 }, { type: 'click', x: 1, y: 1 },
    { v: 2, type: 'click', target: { desc: 'кнопка Submit', locs: [] }, x: 1, y: 1 },
  ] }] }] });
  const out = JSON.parse((await t.list_scenarios.handler({ steps: true })).content[0].text);
  assert.equal(out[0].actions[0].steps, 2);
  assert.equal(out[0].actions[0].sideEffects, true);
  assert.equal(out[0].actions[0].labels.length, 2);
  assert.equal((await toolsWith().list_scenarios.handler({})).content[0].text, 'Сценаріїв немає.');
});

test('run_scenario: невідомий сценарій/Дія і кроки з побічним ефектом без підтвердження — помилка ДО відкриття браузера', async () => {
  const pages = [{ id: 1, name: 'S', url: 'https://x.test', recs: [
    { id: 5, name: 'Заповнити', subs: [{ v: 2, type: 'click', target: { desc: 'поле', locs: [] }, x: 1, y: 1 }] },
    { id: 6, name: 'Відправити', subs: [{ v: 2, type: 'click', target: { desc: 'кнопка Submit', locs: [] }, x: 1, y: 1 }] },
  ] }];
  const t = toolsWith({ pages });
  await assert.rejects(t.run_scenario.handler({ scenario: 'nope' }), /не знайдено/);
  await assert.rejects(t.run_scenario.handler({ scenario: 1, upto: 'x' }), /Дію «x» не знайдено/);
  await assert.rejects(t.run_scenario.handler({ scenario: 'S' }), /побічним ефектом.*Submit.*confirmSideEffects/);
});

// ---------- тимчасові браузери ----------
function fakeLaunchers() {
  const w = { launches: [], browsers: [] };
  const mk = (kind, opts) => {
    const b = { kind, opts, closed: false, handlers: {}, ctxs: [],
      on(ev, fn) { (b.handlers[ev] ||= []).push(fn); },
      async newContext(o) { const ctx = { o, closed: false, inits: [], async addInitScript(s) { ctx.inits.push(s); }, async newPage() { return { ctx }; }, async close() { ctx.closed = true; } }; b.ctxs.push(ctx); return ctx; },
      async close() { b.closed = true; } };
    w.browsers.push(b);
    return b;
  };
  w.launchers = {
    async chromium(flags, plugin) { w.launches.push(['chromium', plugin]); return mk('chromium', flags); },
    async camoufox(opts) { w.launches.push(['camoufox']); return mk('camoufox', opts); },
  };
  return w;
}

test('scratch: той самий launchKey — один браузер, кожен запит — свій контекст з профілем', async () => {
  const w = fakeLaunchers();
  const s = createScratchBrowsers({ launchers: w.launchers, log: quiet });
  const p = { ...defaultProfile(), launch: { ...defaultProfile().launch, stealthPlugin: false }, fingerprint: { userAgent: 'U1' } };
  const [a, b] = await Promise.all([s.take(p), s.take({ ...p, fingerprint: { userAgent: 'U2' } })]);
  assert.equal(w.launches.length, 1);
  assert.deepEqual(w.launches[0], ['chromium', false]);
  assert.equal(a.launched || b.launched, true);
  assert.equal(a.context.o.userAgent, 'U1');
  assert.equal(b.context.o.userAgent, 'U2');
  assert.deepEqual(s.stats(), [{ kind: 'chromium', users: 2, ready: true }]);
  await s.closeUnit(a); await s.closeUnit(b);
  assert.ok(a.context.closed && b.context.closed);
  assert.equal(s.stats()[0].users, 0);
  const c = await s.take(p);
  assert.equal(c.launched, false, 'повторне використання');
  await s.closeAll();
  assert.ok(w.browsers[0].closed);
});

test('scratch: ліміт max витісняє найдавніший ВІЛЬНИЙ браузер; простій закриває; збій запуску не кешується', async () => {
  const w = fakeLaunchers();
  let t = 1000;
  const s = createScratchBrowsers({ launchers: w.launchers, log: quiet, max: 2, idleMs: 100, now: () => t });
  const base = defaultProfile();
  const p1 = { ...base, launch: { ...base.launch, headless: false } };
  const p2 = { ...base, launch: { ...base.launch, engine: 'camoufox' } };
  const p3 = { ...base, launch: { ...base.launch, realGpu: false } };
  const u1 = await s.take(p1); await s.closeUnit(u1);
  t += 10;
  const u2 = await s.take(p2); // зайнятий
  assert.equal(u2.camoufox, true);
  await s.take(p3);            // витісняє вільний p1
  assert.equal(w.browsers[0].closed, true);
  assert.equal(s.stats().length, 2);
  await s.closeUnit(u2);
  t += 1000;
  s.sweep();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.browsers[1].closed, true, 'простій → закрито');
  assert.equal(w.browsers[2].closed, false, 'зайнятий не чіпаємо');
  await s.closeAll();

  let fail = true;
  const launchers = { ...w.launchers, async chromium(f, pl) { if (fail) throw new Error('no chrome'); return w.launchers.chromium(f, pl); } };
  const s2 = createScratchBrowsers({ launchers, log: quiet });
  await assert.rejects(s2.take(p1), /no chrome/);
  assert.equal(s2.stats().length, 0);
  fail = false;
  const ok = await s2.take(p1);
  assert.equal(ok.launched, true);
  await s2.closeAll();
});
