// Юніт-тести конфігу з env (lib/config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadConfig, PROJECT_ROOT } from '../lib/config.js';

test('loadConfig: дефолти', () => {
  const c = loadConfig({}, '/srv/app');
  assert.equal(c.PORT, 3000);
  assert.equal(c.PROFILE_FILE, path.resolve('/srv/app/profile.json'));
  assert.equal(c.UPLOAD_DIR, path.resolve('/srv/app/uploads'));
  assert.match(c.DB_URL, /^postgres:\/\/[^@]+@localhost:5432\/playwright_demo$/);
  assert.equal(c.PUBLIC_DIR, path.join(PROJECT_ROOT, 'public'));
  assert.equal(c.POOL_SIZE, 3);
  assert.equal(c.MAX_CONCURRENT, 6);
  assert.equal(c.JSON_LIMIT, '2mb');
});

test('loadConfig: перевизначення через env (відносні шляхи — від cwd)', () => {
  const c = loadConfig({
    PORT: '3101', DATABASE_URL: 'postgres://x@h:1/db',
    PROFILE_FILE: 'tmp/p.json', UPLOAD_DIR: '/abs/up',
  }, '/srv/app');
  assert.equal(c.PORT, 3101);
  assert.equal(c.DB_URL, 'postgres://x@h:1/db');
  assert.equal(c.PROFILE_FILE, path.resolve('/srv/app/tmp/p.json'));
  assert.equal(c.UPLOAD_DIR, '/abs/up');
});

test('loadConfig: некоректний PORT → 3000', () => {
  assert.equal(loadConfig({ PORT: 'abc' }).PORT, 3000);
  assert.equal(loadConfig({ PORT: '-5' }).PORT, 3000);
});

test('loadConfig: HOST за замовчуванням 127.0.0.1 (лише локально); ALLOWED_HOSTS — список через кому', () => {
  const c = loadConfig({});
  assert.equal(c.HOST, '127.0.0.1');
  assert.deepEqual(c.ALLOWED_HOSTS, []);
  const c2 = loadConfig({ HOST: '0.0.0.0', ALLOWED_HOSTS: ' 192.168.1.5, MyMac.local ,' });
  assert.equal(c2.HOST, '0.0.0.0');
  assert.deepEqual(c2.ALLOWED_HOSTS, ['192.168.1.5', 'mymac.local']);
});
