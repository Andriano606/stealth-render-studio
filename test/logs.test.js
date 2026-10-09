// Юніт-тести лог-рядків життєвого циклу (lib/logs.js) — мають відповідати реальним прапорцям.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeContextLogs, shortUA } from '../lib/logs.js';
import { defaultProfile, applyProfilePatch } from '../lib/profile.js';

const texts = (logs) => logs.map((l) => l.text).join('\n');

test('shortUA', () => {
  assert.equal(shortUA(''), '—');
  assert.equal(shortUA('Mozilla/5.0 ... Chrome/154.0.0.0 Safari/537.36'), 'Chrome/154.0.0.0');
  assert.equal(shortUA('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko'), 'Mozilla/5.0 (X11; Linux x86_…');
});

test('Chromium за замовчуванням: усі stealth-прапорці і вимкнена ізоляція', () => {
  const t = texts(describeContextLogs(defaultProfile(), { fromPool: true, warm: true }));
  assert.match(t, /Рушій: Chromium/);
  assert.match(t, /reuse/);
  assert.match(t, /siteIsolation=вимкнено/);
  assert.match(t, /stealth-plugin=УВІМК/);
  assert.match(t, /headless=new/);
  assert.match(t, /з прогрітого пулу/);
  assert.match(t, /navigator\.webdriver=false, window\.chrome, outerWidth\/Height, permissions\.query, без __pwInitScripts/);
  assert.match(t, /Fingerprint: НЕ задано/);
  assert.match(t, /Cookies: немає/);
});

test('Clear all: ізоляція увімкнена, stealth вимкнено, старий headless', () => {
  const p = applyProfilePatch(defaultProfile(), { clear: true }).profile;
  const t = texts(describeContextLogs(p, { fromPool: false, warm: false }));
  assert.match(t, /siteIsolation=увімкнено/);
  assert.match(t, /stealth-plugin=вимк/);
  assert.match(t, /headless=old/);
  assert.match(t, /GPU=софтверний/);
  assert.match(t, /Stealth: вимкнено/);
  assert.match(t, /запущено \(launch\)/);
  assert.match(t, /створено новий/);
});

test('Camoufox (пресет Cloudflare): без humanize/geoip — і лог це каже', () => {
  const p = applyProfilePatch(defaultProfile(), { launch: { engine: 'camoufox', camoufoxHumanize: false, camoufoxGeoip: false } }).profile;
  const logs = describeContextLogs(p, { fromPool: true, warm: true });
  const t = texts(logs);
  assert.match(t, /Camoufox/);
  assert.match(t, /без humanize\/geoip/);
  assert.doesNotMatch(t, /humanize\+geoip/);
  assert.doesNotMatch(t, /Fingerprint/); // Chromium-рядки не показуємо
  const p2 = applyProfilePatch(p, { launch: { camoufoxGeoip: true } }).profile;
  assert.match(texts(describeContextLogs(p2, {})), /, geoip$/m);
});

test('fingerprint і cookies підставлені', () => {
  const p = applyProfilePatch(defaultProfile(), {
    fingerprint: { userAgent: 'X Chrome/150.1 Y', locale: 'uk', timezoneId: 'Europe/Kiev', hardwareConcurrency: 8, screen: { width: 1680, height: 1050 } },
    cookies: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }],
  }).profile;
  const t = texts(describeContextLogs(p, {}));
  assert.match(t, /UA=Chrome\/150\.1, locale=uk, tz=Europe\/Kiev, cores=8, screen=1680x1050/);
  assert.match(t, /Cookies: підставлено 2/);
});

test('лог поведінки: humanize / autoScroll перед відтворенням / швидкий префікс — з реальних прапорців', () => {
  const t1 = texts(describeContextLogs(defaultProfile(), {}));
  assert.match(t1, /Поведінка: humanize=увімк, autoScroll перед legacy-відтворенням=увімк$/m);
  const p = applyProfilePatch(defaultProfile(), { clear: true }).profile;
  assert.match(texts(describeContextLogs(p, {})), /humanize=вимк, autoScroll перед legacy-відтворенням=вимк/);
  const p2 = applyProfilePatch(defaultProfile(), { behavior: { fastPrefix: true }, launch: { engine: 'camoufox' } }).profile;
  assert.match(texts(describeContextLogs(p2, {})), /швидкий префікс/);
});

test('describeContextLogs: рядок проксі для обох рушіїв, без пароля', () => {
  const withPx = applyProfilePatch(defaultProfile(), { proxy: { server: 'h.test:3128', username: 'u', password: 'secret' } }).profile;
  for (const p of [withPx, applyProfilePatch(withPx, { launch: { engine: 'camoufox' } }).profile]) {
    const line = describeContextLogs(p, {}).find((l) => /Проксі/.test(l.text));
    assert.ok(line, 'є рядок проксі');
    assert.match(line.text, /🔀 Проксі: http:\/\/h\.test:3128 \(логін u, з паролем\)/);
    assert.equal(line.text.includes('secret'), false);
  }
  assert.match(describeContextLogs(defaultProfile(), {}).find((l) => /Проксі/.test(l.text)).text, /немає \(пряме зʼєднання\)/);
});

test('describeContextLogs: вимкнений перемикачем проксі', () => {
  const p = applyProfilePatch(defaultProfile(), { proxy: { server: 'h.test:3128', enabled: false } }).profile;
  assert.match(describeContextLogs(p, {}).find((l) => /Проксі/.test(l.text)).text, /🔀 Проксі: вимкнено — пряме зʼєднання/);
});
