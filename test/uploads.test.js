// Юніт-тести завантажень (lib/uploads.js): безпечні імена, traversal, потоковий обробник.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { safeName, resolveUpload, createUploadHandler } from '../lib/uploads.js';

test('safeName: прибирає небезпечні символи, обрізає довжину', () => {
  assert.equal(safeName('cv.pdf'), 'cv.pdf');
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeName('Резюме (1).pdf'), '_ (1).pdf');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName(null), 'file');
  assert.equal(safeName('a'.repeat(300)).length, 120);
});

test('resolveUpload: валідний id → шлях усередині теки', () => {
  const dir = '/tmp/up';
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(resolveUpload(dir, id, 'cv.pdf', () => true), path.resolve(dir, id, 'cv.pdf'));
  assert.equal(resolveUpload(dir, id, 'cv.pdf', () => false), null); // файлу немає
});

test('resolveUpload: path traversal і криві id → null', () => {
  const ok = () => true;
  assert.equal(resolveUpload('/tmp/up', '../../etc', 'passwd', ok), null);
  assert.equal(resolveUpload('/tmp/up', 'abc', 'x', ok), null);               // закороткий
  assert.equal(resolveUpload('/tmp/up', '0123456789/../..', 'x', ok), null);
  assert.equal(resolveUpload('/tmp/up', null, 'x', ok), null);
  // імʼя файлу з ../ нейтралізується safeName і лишається всередині теки
  const p = resolveUpload('/tmp/up', '0123456789abcdef', '../../../etc/passwd', ok);
  assert.ok(p.startsWith(path.resolve('/tmp/up') + path.sep));
});

// Піднімає express з обробником на випадковому порту.
async function startUploadServer(uploadDir, maxBytes) {
  const app = express();
  let n = 0;
  app.post('/upload', createUploadHandler({ uploadDir, maxBytes, newId: () => 'aaaaaaaaaa-' + (++n) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, port: server.address().port };
}

test('upload: файл пишеться на диск, імʼя з x-filename (url-encoded)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-up-'));
  const { server, port } = await startUploadServer(dir, 1024 * 1024);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent('my cv.pdf') },
      body: Buffer.from('hello pdf'),
    });
    const d = await r.json();
    assert.deepEqual(d, { ok: true, fileId: 'aaaaaaaaaa-1', filename: 'my cv.pdf', size: 9 });
    assert.equal(fs.readFileSync(path.join(dir, 'aaaaaaaaaa-1', 'my cv.pdf'), 'utf8'), 'hello pdf');
    assert.equal(resolveUpload(dir, d.fileId, d.filename), path.join(dir, 'aaaaaaaaaa-1', 'my cv.pdf'));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload: перевищення ліміту → 413 і тека прибрана', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-up-'));
  const { server, port } = await startUploadServer(dir, 1000);
  try {
    let status = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'big.bin' },
        body: Buffer.alloc(200 * 1024),
      });
      status = r.status;
    } catch (_e) { status = 'reset'; } // сервер рве зʼєднання — допустимо
    assert.ok(status === 413 || status === 'reset');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload: обрив клієнтом посеред передачі → частковий файл видалено', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-up-'));
  const { server, port } = await startUploadServer(dir, 10 * 1024 * 1024);
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/upload', method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'part.bin', 'Content-Length': 5 * 1024 * 1024 } });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(64 * 1024));
      setTimeout(() => { req.destroy(); resolve(); }, 80);
    });
    // чекаємо, доки сервер обробить close і прибере теку
    for (let i = 0; i < 40 && fs.readdirSync(dir).length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upload: не octet-stream або без x-filename → 415 і нічого не записано (крос-сайтовий no-cors)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-up-'));
  const { server, port } = await startUploadServer(dir, 1024 * 1024);
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'junk' });
    assert.equal(r1.status, 415);
    assert.equal((await r1.json()).ok, false);
    const r2 = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
    assert.equal(r2.status, 415);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
