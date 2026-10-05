// Профіль браузера (fingerprint + cookies + stealth/launch/behavior прапорці).
// Чисті функції (дефолти, злиття, патч від POST /profile, storageState) +
// маленьке сховище profile.json (createProfileStore) без побічних ефектів при імпорті.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DEFAULT_UA, DEFAULT_VIEWPORT } from './config.js';

// Стартовий профіль (максимальний Chromium-стелс, як було в server.js).
export function defaultProfile() {
  return {
    fingerprint: null,
    storageState: null,
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true }, // наші анти-детект доповнення
    launch: { headless: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false, engine: 'chromium', automationControlled: true, realGpu: true, newHeadless: true, camoufoxHumanize: true, camoufoxGeoip: true }, // параметри запуску
    // humanize — людські рухи/затримки (відтворення І дії живої сесії);
    // prepareScroll — autoScroll перед відтворенням legacy-координатних кліків (як у /render);
    // fastPrefix — префікс живої сесії без humanize (швидше; логується).
    behavior: { humanize: true, prepareScroll: true, fastPrefix: false },
  };
}

// «Голий» Playwright: усе вимкнено (кнопка «Скинути» / пресет Clear all).
// `persistent` лишаємо в даних для сумісності, але режим persistent прибрано.
export function bareProfileParts() {
  return {
    stealth: { webdriver: false, windowChrome: false, outerWindow: false, permissions: false, pwInitScripts: false },
    launch: { headless: true, siteIsolationDisabled: false, stealthPlugin: false, persistent: false, engine: 'chromium', automationControlled: false, realGpu: false, newHeadless: false, camoufoxHumanize: false, camoufoxGeoip: false },
    behavior: { humanize: false, prepareScroll: false, fastPrefix: false },
  };
}

// Дефолтний (пустий) Playwright — щоб у конфігураторі показувати, що саме змінено.
export const PLAYWRIGHT_DEFAULTS = Object.freeze({
  fingerprint: null,
  ...bareProfileParts(),
  note: 'navigator.webdriver=true, стандартний UA Playwright, без cookies, ізоляція сайтів увімкнена, без stealth-плагіна, миттєві кліки, без autoScroll перед відтворенням',
});

// Зливає збережений profile.json із дефолтами (невідомі/відсутні поля — з дефолту).
export function mergeLoadedProfile(loaded) {
  const p = defaultProfile();
  if (!loaded || typeof loaded !== 'object') return p;
  p.fingerprint = loaded.fingerprint ?? null;
  p.storageState = loaded.storageState ?? null;
  p.stealth = Object.assign(p.stealth, loaded.stealth || {});
  p.launch = Object.assign(p.launch, loaded.launch || {});
  p.behavior = Object.assign(p.behavior, loaded.behavior || {});
  return p;
}

// Мапимо cookies з експорту розширень (Cookie-Editor тощо) у формат Playwright.
export function toStorageState(input) {
  if (!input) return null;
  if (input.cookies && Array.isArray(input.cookies)) return input; // уже storageState
  const arr = Array.isArray(input) ? input : [];
  const ss = { cookies: [], origins: [] };
  const mapSameSite = (v) => {
    const s = String(v || '').toLowerCase();
    if (s.includes('no_restriction') || s === 'none') return 'None';
    if (s.includes('strict')) return 'Strict';
    return 'Lax';
  };
  for (const c of arr) {
    if (!c || !c.name) continue;
    ss.cookies.push({
      name: c.name, value: String(c.value ?? ''),
      domain: c.domain || '', path: c.path || '/',
      expires: typeof c.expirationDate === 'number' ? Math.round(c.expirationDate)
             : (typeof c.expires === 'number' ? c.expires : -1),
      httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: mapSameSite(c.sameSite),
    });
  }
  return ss.cookies.length ? ss : null;
}

const sigOf = (p) => JSON.stringify([p.fingerprint, p.stealth, p.launch, p.storageState]);

// Застосовує тіло POST /profile до профілю. ЧИСТА: не мутує вхідний профіль.
// Повертає { profile, launchChanged, changed }.
export function applyProfilePatch(profile, body) {
  const { fingerprint, cookies, storageState, stealth, launch, behavior, clear } = body || {};
  const sigBefore = sigOf(profile);
  const launchBefore = JSON.stringify(profile.launch);
  let p = {
    ...profile,
    stealth: { ...profile.stealth },
    launch: { ...profile.launch },
    behavior: { ...profile.behavior },
  };
  if (clear) { // скинути до дефолту Playwright
    p = { ...p, fingerprint: null, storageState: null, ...bareProfileParts() };
  }
  if (fingerprint !== undefined) p.fingerprint = fingerprint;
  if (stealth) Object.assign(p.stealth, stealth);
  if (behavior) Object.assign(p.behavior, behavior);
  const ss = toStorageState(storageState || cookies);
  if (ss) p.storageState = ss;
  if (cookies === null || storageState === null) p.storageState = null; // явне очищення
  if (launch) Object.assign(p.launch, launch);
  // Порівнюємо з launch ДО будь-яких змін — щоб і `clear` (Clear all) перезапускав браузер.
  const launchChanged = JSON.stringify(p.launch) !== launchBefore;
  const changed = sigOf(p) !== sigBefore;
  return { profile: p, launchChanged, changed };
}

// Відповідь GET/POST /profile (формат не змінювати — на нього спирається UI).
export function fullConfig(profile) {
  const cookies = profile.storageState && Array.isArray(profile.storageState.cookies) ? profile.storageState.cookies : null;
  return {
    fingerprint: profile.fingerprint || null,
    stealth: profile.stealth,
    launch: profile.launch,
    behavior: profile.behavior,
    cookiesCount: cookies ? cookies.length : 0,
    cookies: cookies ? cookies.slice(0, 50) : [],
    defaults: PLAYWRIGHT_DEFAULTS,
    hasFingerprint: !!profile.fingerprint,
  };
}

// Опції browser.newContext() з профілю (із запасними значеннями).
export function contextOptions(profile) {
  const fp = profile.fingerprint || {};
  const opts = {
    viewport: fp.viewport && fp.viewport.width ? fp.viewport : { ...DEFAULT_VIEWPORT },
    userAgent: fp.userAgent || DEFAULT_UA,
    locale: fp.locale || 'en-US',
    timezoneId: fp.timezoneId || undefined,
    deviceScaleFactor: fp.deviceScaleFactor || 1,
  };
  if (profile.storageState && Array.isArray(profile.storageState.cookies)) {
    opts.storageState = profile.storageState;
  }
  return opts;
}

// Короткий хеш конфігу, що впливає на нові контексти (для виявлення «конфіг змінено»).
export function profileSig(profile) {
  const s = JSON.stringify([profile.fingerprint, profile.stealth, profile.launch, profile.storageState, profile.behavior]);
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// Сховище profile.json. load() читає файл (помилки → дефолт), save() пише атомарно
// (tmp + rename), щоб збій посеред запису не зіпсував файл.
export function createProfileStore(file, { fsImpl = fs, log = console } = {}) {
  let profile = defaultProfile();
  return {
    load() {
      try {
        if (fsImpl.existsSync(file)) profile = mergeLoadedProfile(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
      } catch (e) {
        log.error('profile.json не прочитано (' + e.message + ') — беру дефолт.');
        profile = defaultProfile();
      }
      return profile;
    },
    get() { return profile; },
    set(p) { profile = p; },
    save() {
      try {
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        fsImpl.writeFileSync(tmp, JSON.stringify(profile, null, 2));
        fsImpl.renameSync(tmp, file);
      } catch (e) { log.error('profile.json не збережено: ' + e.message); }
    },
  };
}
