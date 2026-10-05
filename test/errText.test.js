// lib/errText.js — чищення помилок Playwright для людини (ANSI, «Call log», net::ERR_* → українською).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanError, humanError } from '../lib/errText.js';

const RAW = 'page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/\nCall log:\n  \x1b[2m - navigating to "http://127.0.0.1:1/", waiting until "domcontentloaded"\x1b[22m\n';

test('cleanError: без ANSI, без «Call log», без префікса API, пробіли схлопнуто', () => {
  const s = cleanError(RAW);
  assert.equal(s, 'net::ERR_UNSAFE_PORT at http://127.0.0.1:1/');
  assert.ok(!/\[2m|\[22m|Call log|\x1b/.test(s));
  // «Осиротілі» коди без ESC (загубився при пересиланні)
  assert.equal(cleanError('locator.click: Timeout 6000ms exceeded.\n[2m - waiting for x[22m'), 'Timeout 6000ms exceeded. - waiting for x');
  assert.equal(cleanError('a\n\n  b'), 'a b');
  assert.equal(cleanError('x'.repeat(50), 10), 'x'.repeat(9) + '…');
});

test('cleanError: не-рядки й Error; звичайний український текст не змінюється', () => {
  assert.equal(cleanError(null), '');
  assert.equal(cleanError(undefined), '');
  assert.equal(cleanError(42), '42');
  assert.equal(cleanError(new Error('page.click: boom')), 'boom');
  assert.equal(cleanError('Сесію закрито: простій понад 5 хв'), 'Сесію закрито: простій понад 5 хв');
  assert.equal(cleanError('немає фокусу'), 'немає фокусу');
});

test('humanError: net::ERR_* → українською з кодом і URL', () => {
  assert.equal(humanError(RAW), 'Сторінка недоступна (ERR_UNSAFE_PORT) — http://127.0.0.1:1/');
  assert.match(humanError('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/'), /^Сторінка недоступна \(ERR_CONNECTION_REFUSED\) — http:\/\/localhost:9\/$/);
  assert.match(humanError('net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/'), /^Домен не знайдено \(ERR_NAME_NOT_RESOLVED\)/);
  assert.match(humanError('net::ERR_CERT_AUTHORITY_INVALID at https://x/'), /^Помилка сертифіката/);
  assert.match(humanError('net::ERR_INTERNET_DISCONNECTED'), /^Немає зʼєднання \(ERR_INTERNET_DISCONNECTED\)$/);
  assert.match(humanError('net::ERR_SOMETHING_NEW at http://a/'), /^Мережева помилка \(ERR_SOMETHING_NEW\)/);
});

test('humanError: таймаут Playwright → «не відповіла вчасно»; решта — як cleanError', () => {
  const t = 'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://slow.test/", waiting until "load"\n';
  assert.equal(humanError(t), 'Сторінка не відповіла вчасно (30000 мс) — https://slow.test/');
  assert.equal(humanError('Помилка відкриття'), 'Помилка відкриття');
  assert.equal(humanError(new Error('x\x1b[2my')), 'xy');
});
