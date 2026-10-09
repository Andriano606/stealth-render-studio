// Проксі браузера (lib/proxy.js) — чиста логіка: розбір адреси, нормалізація з профілю/POST /profile,
// збереження пароля, опція Playwright, публічний вигляд без пароля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyServer, normalizeProxy, toPlaywrightProxy, publicProxy, proxyLabel, sameProxy, activeProxy } from '../lib/proxy.js';

test('parseProxyServer: host:port → http://; схеми; IPv6; логін/пароль з URL (декодуються)', () => {
  assert.deepEqual(parseProxyServer('1.2.3.4:8080'), { server: 'http://1.2.3.4:8080' });
  assert.deepEqual(parseProxyServer(' SOCKS5://Proxy.Example.com:1080/ '), { server: 'socks5://proxy.example.com:1080' });
  assert.deepEqual(parseProxyServer('https://[2001:db8::1]:3128'), { server: 'https://[2001:db8::1]:3128' });
  assert.deepEqual(parseProxyServer('http://us%40r:p%3Ass@h.test:3128'), { server: 'http://h.test:3128', username: 'us@r', password: 'p:ss' });
  assert.deepEqual(parseProxyServer('http://user@h.test:3128'), { server: 'http://h.test:3128', username: 'user' });
});

test('parseProxyServer: помилки людською мовою', () => {
  assert.match(parseProxyServer('').error, /вкажи адресу/);
  assert.match(parseProxyServer('h.test').error, /вкажи порт/);
  assert.match(parseProxyServer('h.test:99999').error, /порт/);
  assert.match(parseProxyServer('ftp://h.test:21').error, /не підтримується/);
  assert.match(parseProxyServer('h .test:80').error, /пробіли/);
  assert.match(parseProxyServer('http://h.test:80/path').error, /не схоже/);
});

test('normalizeProxy: null/порожній сервер → без проксі; рядок і обʼєкт; bypass нормалізується', () => {
  assert.deepEqual(normalizeProxy(null), { proxy: null });
  assert.deepEqual(normalizeProxy(''), { proxy: null });
  assert.deepEqual(normalizeProxy({ server: '  ' }), { proxy: null });
  assert.deepEqual(normalizeProxy('h.test:3128'), { proxy: { server: 'http://h.test:3128' } });
  assert.deepEqual(normalizeProxy({ server: 'h.test:3128', username: ' u ', password: 'p', bypass: 'localhost, *.internal  ,' }),
    { proxy: { server: 'http://h.test:3128', username: 'u', password: 'p', bypass: 'localhost,*.internal' } });
  assert.match(normalizeProxy({ server: 'h.test' }).error, /порт/);
  assert.match(normalizeProxy(42).error, /рядком або обʼєктом/);
  assert.match(normalizeProxy({ server: 'h.test:1', username: 'a\u0000b' }).error, /керівні/);
});

test('normalizeProxy: пароль не надіслано → лишається збережений (лише той самий логін); без логіна пароля немає', () => {
  const prev = { server: 'http://h.test:3128', username: 'u', password: 'secret' };
  assert.equal(normalizeProxy({ server: 'h.test:3128', username: 'u' }, prev).proxy.password, 'secret');
  assert.equal(normalizeProxy({ server: 'other.test:1', username: 'u' }, prev).proxy.password, 'secret', 'сервер змінено — пароль того ж логіна лишається');
  assert.equal(normalizeProxy({ server: 'h.test:3128', username: 'v' }, prev).proxy.password, undefined, 'інший логін — старий пароль не підставляємо');
  assert.equal(normalizeProxy({ server: 'h.test:3128', username: 'u', password: 'new' }, prev).proxy.password, 'new');
  assert.equal(normalizeProxy({ server: 'h.test:3128', username: 'u', password: '' }, prev).proxy.password, undefined, 'явний порожній — прибрати');
  assert.deepEqual(normalizeProxy({ server: 'h.test:3128', username: '', password: 'x' }, prev).proxy, { server: 'http://h.test:3128' });
});

test('normalizeProxy: SOCKS з логіном → попередження (Chromium не підтримує)', () => {
  const r = normalizeProxy({ server: 'socks5://h.test:1080', username: 'u', password: 'p' });
  assert.ok(r.proxy);
  assert.match(r.warning, /SOCKS/);
  assert.equal(normalizeProxy('socks5://h.test:1080').warning, undefined);
});

test('toPlaywrightProxy / publicProxy / proxyLabel / sameProxy', () => {
  const p = { server: 'http://h.test:3128', username: 'u', password: 'secret', bypass: 'localhost' };
  assert.deepEqual(toPlaywrightProxy(p), p);
  assert.equal(toPlaywrightProxy(null), undefined);
  assert.deepEqual(publicProxy(p), { server: 'http://h.test:3128', username: 'u', bypass: 'localhost', hasPassword: true, enabled: true });
  assert.equal(publicProxy(null), null);
  const label = proxyLabel(p);
  assert.match(label, /http:\/\/h\.test:3128 \(логін u, з паролем\), в обхід: localhost/);
  assert.equal(label.includes('secret'), false);
  assert.match(proxyLabel(null), /немає/);
  assert.equal(sameProxy(p, { ...p }), true);
  assert.equal(sameProxy(p, { ...p, password: 'other' }), false);
  assert.equal(sameProxy(null, undefined), true);
});

test('перемикач: enabled:false зберігає налаштування, але проксі не діє; зміна стану = інший проксі для браузера', () => {
  const on = normalizeProxy({ server: 'h.test:3128', username: 'u', password: 'p' }).proxy;
  assert.equal('enabled' in on, false, 'увімкнений — без поля (як раніше)');
  const prev = { server: 'http://h.test:3128', username: 'u', password: 'p' };
  const off = normalizeProxy({ server: 'h.test:3128', username: 'u', enabled: false }, prev).proxy;
  assert.deepEqual(off, { server: 'http://h.test:3128', username: 'u', password: 'p', enabled: false }, 'пароль і решта лишились');
  assert.equal(activeProxy(off), null);
  assert.equal(activeProxy(on), on);
  assert.equal(activeProxy(null), null);
  assert.equal(publicProxy(off).enabled, false);
  assert.match(proxyLabel(off), /^вимкнено — пряме зʼєднання \(налаштовано http:\/\/h\.test:3128\)/);
  assert.equal(sameProxy(on, off), false, 'перемикання → перезапуск');
  assert.equal(sameProxy(off, { ...off, server: 'http://other.test:1' }), true, 'правка вимкненого — без перезапуску');
  assert.equal(sameProxy(off, null), true);
});
