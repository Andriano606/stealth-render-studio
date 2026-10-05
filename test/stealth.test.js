// Юніт-тести init-скрипта stealth (lib/stealth.js stealthScript).
// Плагін тут НЕ підвантажується (імпорт модуля без побічних ефектів).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stealthScript } from '../lib/stealth.js';

const ALL = { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true };

test('stealthScript: повертає рядок, що парситься як JS (усі комбінації)', () => {
  for (const st of [ALL, {}, null, { webdriver: true }]) {
    for (const fp of [null, {}, { languages: ['uk', 'en'], hardwareConcurrency: 8, screen: { width: 1680, height: 1050 } }]) {
      const src = stealthScript(fp, st);
      assert.equal(typeof src, 'string');
      assert.doesNotThrow(() => new Function(src));
    }
  }
});

test('stealthScript: дані fingerprint серіалізуються безпечно (лапки, </script>)', () => {
  const src = stealthScript({ platform: 'x"); throw 1; ("', vendor: '</script>' }, ALL);
  assert.doesNotThrow(() => new Function(src));
});

// Виконуємо скрипт у vm зі стабами window/navigator — перевіряємо ключові ефекти.
function runInStub(fp, st) {
  class Navigator {}
  const navigator = new Navigator();
  Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true }); // як у Playwright
  const window = { innerWidth: 1280, innerHeight: 900, __pwInitScripts: {} };
  const ctx = { Navigator, navigator, window, screen: {}, Notification: { permission: 'default' }, Object, Promise };
  vm.runInNewContext(stealthScript(fp, st), ctx);
  return ctx;
}

test('stealthScript у vm: webdriver=false на ПРОТОТИПІ, own-property прибрано', () => {
  const { navigator } = runInStub(null, ALL);
  assert.equal(navigator.webdriver, false);
  assert.equal(Object.getOwnPropertyNames(navigator).includes('webdriver'), false);
});

test('stealthScript у vm: window.chrome, outerWidth, __pwInitScripts', () => {
  const { window } = runInStub(null, ALL);
  assert.ok(window.chrome && window.chrome.runtime);
  assert.equal(window.outerWidth, 1280);
  assert.equal(window.outerHeight, 974);
  assert.equal(window.__pwInitScripts, undefined);
});

test('stealthScript у vm: прапорці вимкнено → нічого не чіпаємо', () => {
  const { navigator, window } = runInStub(null, {});
  assert.equal(navigator.webdriver, true);
  assert.equal(window.chrome, undefined);
  assert.ok(window.__pwInitScripts);
});
