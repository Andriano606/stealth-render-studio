// Host/Origin-захист локального сервісу (lib/guard.js): DNS-rebinding і крос-сайтові POST.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostnameOf, isAllowedHost, isAllowedOrigin } from '../lib/guard.js';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createSemaphore } from '../lib/semaphore.js';
import { createProfileStore } from '../lib/profile.js';

test('hostnameOf / isAllowedHost: локальні імена з будь-яким портом; чужі — ні (крім ALLOWED_HOSTS)', () => {
  assert.equal(hostnameOf('LocalHost:3000'), 'localhost');
  assert.equal(hostnameOf('[::1]:3000'), '[::1]');
  assert.equal(hostnameOf(''), '');
  for (const h of ['localhost:3000', '127.0.0.1:0', '[::1]:3000', 'localhost']) assert.equal(isAllowedHost(h), true, h);
  for (const h of ['evil.com', 'evil.com:3000', '192.168.1.5:3000', '', undefined, 'localhost.evil.com']) assert.equal(isAllowedHost(h), false, String(h));
  assert.equal(isAllowedHost('192.168.1.5:3000', ['192.168.1.5']), true);
});

test('isAllowedOrigin: без Origin — так; свій — так; чужий / null — ні', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:1234'), true);
  assert.equal(isAllowedOrigin('https://evil.com'), false);
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin('not a url'), false);
});

let server, port, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-guard-'));
  const config = loadConfig({ PROFILE_FILE: path.join(tmp, 'p.json'), UPLOAD_DIR: path.join(tmp, 'up') }, tmp);
  const store = createProfileStore(config.PROFILE_FILE, { log: { log() {}, error() {} } });
  const engine = { engineReady: () => true, poolStats: () => ({ ready: 0, size: 0 }), async drainPool() {}, async relaunchBrowser() {} };
  const app = createApp({ config, engine, sem: createSemaphore(1), profileStore: store, log: { log() {}, error() {} } });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Сирий HTTP-запит (fetch не дає підмінити Host).
function raw(method, p, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('чужий Host (DNS-rebinding) → 403 навіть для GET /profile і index.html; свій — 200', async () => {
  assert.equal((await raw('GET', '/profile', { Host: 'evil.com' })).status, 403);
  assert.equal((await raw('GET', '/', { Host: 'rebind.attacker.test:' + port })).status, 403);
  assert.equal((await raw('GET', '/profile', { Host: 'localhost:' + port })).status, 200);
  assert.equal((await raw('GET', '/health', { Host: '127.0.0.1:' + port })).status, 200);
});

test('POST з чужим Origin або Sec-Fetch-Site: cross-site → 403; без Origin / свій Origin — проходить', async () => {
  const body = JSON.stringify({ url: '' });
  const h = { Host: 'localhost:' + port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  assert.equal((await raw('POST', '/live', { ...h, Origin: 'https://evil.com' }, body)).status, 403);
  assert.equal((await raw('POST', '/live', { ...h, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
  assert.equal((await raw('POST', '/live', h, body)).status, 400); // пройшло захист → валідація url
  assert.equal((await raw('POST', '/live', { ...h, Origin: 'http://localhost:' + port }, body)).status, 400);
});
