// Stealth: init-скрипт (чистий рядок) + налаштування puppeteer-extra stealth-плагіна.
// Плагін і його залежності підвантажуються ЛИШЕ в setupStealthPlugin() (дорогий
// require) — імпорт модуля нічого не запускає, тож тести stealthScript швидкі.
import { createRequire } from 'module';
import { depModulePath, preloadPluginDeps } from './pluginDeps.js';

// JS, що виконується ДО скриптів сторінки в кожному контексті: прибирає
// сигнали автоматизації й підставляє задекларовані параметри реального браузера.
// fp — fingerprint (або null), stealthFlags — profile.stealth.
export function stealthScript(fp, stealthFlags) {
  const st = stealthFlags || {};
  return `(() => {
    const fp = ${JSON.stringify(fp || {})};
    const st = ${JSON.stringify(st)};
    // webdriver: НЕ створюємо own-property на navigator (інакше getOwnPropertyNames
    // його видає). Прибираємо own-property, якщо є, і ховаємо через прототип.
    try {
      if (st.webdriver) {
        if (Object.getOwnPropertyDescriptor(navigator, 'webdriver')) { try { delete navigator.webdriver; } catch(e){} }
        // Справжній Chrome: navigator.webdriver === false (на прототипі, не own-property).
        try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
      }
    } catch(e){}
    try { if (fp.languages) Object.defineProperty(navigator, 'languages', { get: () => fp.languages }); } catch(e){}
    try { if (fp.hardwareConcurrency) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency }); } catch(e){}
    try { if (fp.deviceMemory) Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory }); } catch(e){}
    try { if (fp.platform) Object.defineProperty(navigator, 'platform', { get: () => fp.platform }); } catch(e){}
    try { if (fp.vendor) Object.defineProperty(navigator, 'vendor', { get: () => fp.vendor }); } catch(e){}
    try {
      if (fp.screen) {
        Object.defineProperty(screen, 'width', { get: () => fp.screen.width });
        Object.defineProperty(screen, 'height', { get: () => fp.screen.height });
        Object.defineProperty(screen, 'availWidth', { get: () => fp.screen.width });
        Object.defineProperty(screen, 'availHeight', { get: () => fp.screen.height });
        Object.defineProperty(screen, 'colorDepth', { get: () => fp.screen.colorDepth || 24 });
        Object.defineProperty(screen, 'pixelDepth', { get: () => fp.screen.colorDepth || 24 });
      }
    } catch(e){}
    // типовий для справжнього Chrome об'єкт, якого немає в автоматиці
    try {
      if (st.windowChrome) {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
        if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
        if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };
        window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: {}, RunningState: {} };
      }
    } catch(e){}
    // У headless outerWidth/outerHeight = 0 — явний маячок. Підставляємо реальні.
    if (st.outerWindow) {
      try { Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth }); } catch(e){}
      try { Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 74 }); } catch(e){}
    }
    // WebGL НЕ спуфимо — використовуємо справжній GPU (реальні vendor/renderer/пікселі).
    // permissions.query: узгоджена поведінка (як у справжньому браузері).
    if (st.permissions) try {
      const orig = navigator.permissions && navigator.permissions.query;
      if (orig) navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(p);
    } catch(e){}
    // Прибираємо підпис Playwright: об'єкт window.__pwInitScripts, який створює
    // addInitScript. Видаляємо його ПІСЛЯ реєстрації (наш скрипт додається останнім).
    if (st.pwInitScripts) {
      try { delete window.__pwInitScripts; } catch(e){}
      try { Object.defineProperty(window, '__pwInitScripts', { get: () => undefined, set: () => {}, configurable: true }); } catch(e){}
    }
  })();`;
}

// Реєструє stealth-плагін на extra-рушії (десятки анти-детект патчів).
// ВАЖЛИВО: вимикаємо webgl.vendor-евейжн — бо ми вмикаємо СПРАВЖНІЙ GPU, і
// підміна назви WebGL у фіксований Intel створила б суперечність із реальними
// пікселями Apple GPU. Хай справжні значення проходять як є.
// Підвантажуємо всі stealth-евейжни ОДРАЗУ (а не ліниво при першому launch):
// інакше, якщо теку проєкту перенесли при запущеному сервері, перемикання на
// пресет зі stealth-плагіном падало з «Plugin dependency not found».
// Мемоізовано: повертає той самий Promise<chromiumExtra> при повторних викликах.
let _stealthPromise = null;
let _evasions = null; // фактичний список евейжнів після налаштування (для експорту конфігу)
export function stealthEvasions() { return _evasions ? [..._evasions] : null; }
export function setupStealthPlugin({ log = console } = {}) {
  if (_stealthPromise) return _stealthPromise;
  _stealthPromise = (async () => {
    const { chromium: chromiumExtra } = await import('playwright-extra');
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
    const stealth = StealthPlugin();
    try { stealth.enabledEvasions.delete('webgl.vendor'); } catch (_e) {}
    try { _evasions = [...stealth.enabledEvasions].sort(); } catch (_e) { _evasions = null; }
    chromiumExtra.use(stealth);
    const require = createRequire(import.meta.url);
    const deps = preloadPluginDeps(stealth, (d) => require(depModulePath(d)),
      (d, mod) => chromiumExtra.plugins.setDependencyResolution(d, mod));
    log.log('Stealth-плагін: підвантажено ' + deps.length + ' залежностей.');
    return chromiumExtra;
  })();
  _stealthPromise.catch(() => { _stealthPromise = null; }); // дозволяємо повтор після збою
  return _stealthPromise;
}
