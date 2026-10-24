// HTTP-тести POST /mcp (routes/mcp.js) через createApp з ФЕЙКОВИМИ рушієм/сторінкою — без браузера:
// транспорт (Streamable HTTP без SSE), Host/Origin-захист, вибір джерела контексту (пул /
// основний браузер / тимчасовий), формат результату open_page, звільнення слота.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createSemaphore } from '../lib/semaphore.js';
import { createProfileStore } from '../lib/profile.js';

const quiet = { log() {}, error() {} };

function fakePage({ failGoto = false } = {}) {
  let url = 'about:blank';
  const frame = {
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('location.href')) return { url, text: 'Hello from page' };
      if (s.includes('innerText.length')) return 100;
      return '';
    },
  };
  const page = {
    closedCtx: false,
    async goto(u) { if (failGoto) throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at ' + u); url = u; return { status: () => 200 }; },
    async title() { return 'Fake title'; },
    async content() { return '<html><body>' + 'x'.repeat(5000) + '</body></html>'; },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('document.links')) return [['Link A', 'https://a.test/'], ['dup', 'https://a.test/']];
      if (s.includes('querySelector')) return false;
      if (s.includes('scrollHeight')) return { w: 1280, h: 20000 };
      return 'hello body';
    },
    frames() { return [frame]; },
    mainFrame() { return frame; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForSelector(sel) { if (sel === '#missing') throw new Error('timeout'); },
    async screenshot(o) { page.shotOpts = o; return Buffer.from('JPEGDATA'); },
    url() { return url; },
    mouse: { async move() {}, async wheel() {} },
  };
  return page;
}

function fakeEngine() {
  const e = {
    calls: [], closed: 0, failGoto: false,
    engineReady() { return true; },
    async takeUnit() { e.calls.push('take'); e.last = fakePage({ failGoto: e.failGoto }); return { context: {}, page: e.last, fromPool: true }; },
    async unitWithProfile(p) { e.calls.push(['with', p.fingerprint]); e.last = fakePage(); return { context: {}, page: e.last, fromPool: false }; },
    async closeUnit() { e.closed++; },
    poolStats() { return { ready: 2, size: 3 }; },
  };
  return e;
}

function fakeScratch() {
  const s = {
    taken: [], closed: 0,
    async take(p) { s.taken.push(p.launch.engine); return { context: {}, page: fakePage(), fromPool: false, launched: true }; },
    async closeUnit() { s.closed++; },
  };
  return s;
}

let tmp, server, base, engine, sem, scratch, store;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-mcp-'));
  const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'profile.json'), UPLOAD_DIR: path.join(tmp, 'uploads') }, tmp);
  engine = fakeEngine();
  scratch = fakeScratch();
  sem = createSemaphore(2);
  store = createProfileStore(config.PROFILE_FILE, { log: quiet });
  store.load();
  const app = createApp({ config, engine, sem, scratch, profileStore: store, log: quiet });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const rpc = async (body, headers = {}) => {
  const r = await fetch(base + '/mcp', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type'), body: text ? JSON.parse(text) : null };
};
const call = (name, args) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('POST /mcp initialize → JSON, версія протоколу; сповіщення → 202 без тіла', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.body.result.protocolVersion, '2025-06-18');
  assert.equal(r.body.result.serverInfo.name, 'stealth-render');
  const n = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(n.status, 202);
  assert.equal(n.body, null);
});

test('POST /mcp: tools/list — усі тули зі схемами', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-06-18' });
  assert.deepEqual(r.body.result.tools.map((t) => t.name), ['get_config', 'open_page', 'list_scenarios', 'run_scenario',
    'open_browser', 'browser_status', 'save_session', 'close_browser', 'list_sessions', 'delete_session']);
  assert.ok(r.body.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description));
  const open = r.body.result.tools[1];
  assert.deepEqual(open.inputSchema.required, ['url']);
  assert.deepEqual(open.inputSchema.properties.engine.enum, ['chromium', 'camoufox']);
});

test('POST /mcp: битий JSON → -32700; непідтримувана MCP-Protocol-Version → 400; GET/DELETE → 405', async () => {
  const bad = await rpc('{nope');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);
  const v = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' });
  assert.equal(v.status, 400);
  assert.match(v.body.error.message, /Unsupported/);
  assert.equal((await fetch(base + '/mcp')).status, 405);
  assert.equal((await fetch(base + '/mcp', { method: 'DELETE' })).status, 405);
});

test('POST /mcp: крос-сайтовий Origin і чужий Host → 403 (DNS-rebinding)', async () => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: '{}' });
  assert.equal(r.status, 403);
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/mcp', { method: 'POST', headers: { Host: 'evil.test', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 403);
});

test('open_page: застосований конфіг → теплий пул; заголовок, текст, посилання, скрин; контекст закрито, слот звільнено', async () => {
  const before = engine.closed;
  const r = await call('open_page', { url: 'example.test/x', links: true, screenshot: 'viewport' });
  assert.equal(r.body.result.isError, undefined);
  const [head, text, links, img] = r.body.result.content;
  assert.match(head.text, /^URL: https:\/\/example\.test\/x \(HTTP 200\)/);
  assert.match(head.text, /Заголовок: Fake title/);
  assert.match(head.text, /Рушій: Chromium · конфіг: застосований конфіг \(не збережено\)/);
  assert.match(head.text, /Браузер: теплий пул/);
  assert.match(head.text, /Лог конфігу:\n {2}🧩 Рушій: Chromium/);
  assert.equal(text.text, '--- ТЕКСТ ---\nHello from page');
  assert.equal(links.text, '--- ПОСИЛАННЯ ---\n- [Link A](https://a.test/)');
  assert.deepEqual(img, { type: 'image', data: Buffer.from('JPEGDATA').toString('base64'), mimeType: 'image/jpeg' });
  assert.equal(engine.last.shotOpts.fullPage, undefined);
  assert.equal(engine.closed, before + 1);
  assert.equal(sem.active, 0);
});

test('open_page: html обрізається maxChars; full-скрин обрізається по висоті; waitFor звітує', async () => {
  const r = await call('open_page', { url: 'https://example.test', content: 'html', maxChars: 1000, screenshot: 'full', waitFor: '#missing' });
  const [head, html] = r.body.result.content;
  assert.match(head.text, /Селектор «#missing»: НЕ зʼявився/);
  assert.match(html.text, /^--- HTML \(обрізано: 1000 з \d+ символів\) ---\n<html>/);
  assert.equal(engine.last.shotOpts.fullPage, true);
  assert.deepEqual(engine.last.shotOpts.clip, { x: 0, y: 0, width: 1280, height: 8000 });
  const none = await call('open_page', { url: 'https://example.test', content: 'none' });
  assert.equal(none.body.result.content.length, 1);
});

test('open_page: інший fingerprint → контекст основного браузера; інший рушій → тимчасовий браузер; профіль не змінено', async () => {
  const sig = JSON.stringify(store.get());
  engine.calls = [];
  const a = await call('open_page', { url: 'https://example.test', fingerprint: { locale: 'uk-UA' } });
  assert.deepEqual(engine.calls, [['with', { locale: 'uk-UA' }]]);
  assert.match(a.body.result.content[0].text, /основний браузер, окремий контекст/);
  const b = await call('open_page', { url: 'https://example.test', engine: 'camoufox' });
  assert.deepEqual(scratch.taken, ['camoufox']);
  assert.equal(scratch.closed, 1);
  assert.match(b.body.result.content[0].text, /Рушій: Camoufox .*engine=camoufox.*\nБраузер: тимчасовий.*щойно запущено/);
  assert.equal(JSON.stringify(store.get()), sig, 'профіль не змінено');
  assert.equal(sem.active, 0);
});

test('open_page: помилки — isError з людським текстом, слот звільнено', async () => {
  const bad = await call('open_page', { url: 'file:///etc/passwd' });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /лише http/);
  const flag = await call('open_page', { url: 'x.test', stealth: { nope: true } });
  assert.match(flag.body.result.content[0].text, /stealth\.nope: невідомий/);
  engine.failGoto = true;
  const nav = await call('open_page', { url: 'https://nx.test' });
  engine.failGoto = false;
  assert.equal(nav.body.result.isError, true);
  assert.match(nav.body.result.content[0].text, /Не вдалося відкрити https:\/\/nx\.test\/: .*ERR_NAME_NOT_RESOLVED/);
  assert.equal(sem.active, 0);
});

test('get_config / list_scenarios через HTTP (без БД — сценарії з памʼяті /pages)', async () => {
  await fetch(base + '/pages/3', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Мій', url: 'https://x.test', recs: [{ id: 1, name: 'Дія 1', subs: [{ type: 'click', x: 1, y: 2 }] }] }) });
  const cfg = JSON.parse((await call('get_config', {})).body.result.content[0].text);
  assert.equal(cfg.applied.engine, 'chromium');
  assert.equal(cfg.applied.proxy, null);
  const list = JSON.parse((await call('list_scenarios', {})).body.result.content[0].text);
  assert.deepEqual(list, [{ id: 3, name: 'Мій', url: 'https://x.test', actions: [{ id: 1, name: 'Дія 1', steps: 1 }] }]);
});
