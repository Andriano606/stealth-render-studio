// Юніт-тести профілю (lib/profile.js): злиття, патч POST /profile, cookies, сховище.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  defaultProfile, mergeLoadedProfile, applyProfilePatch, toStorageState,
  fullConfig, contextOptions, profileSig, createProfileStore, PLAYWRIGHT_DEFAULTS,
} from '../lib/profile.js';
import { DEFAULT_UA } from '../lib/config.js';

test('mergeLoadedProfile: відсутні поля беруться з дефолту', () => {
  const p = mergeLoadedProfile({ launch: { engine: 'camoufox' }, stealth: { webdriver: false } });
  assert.equal(p.launch.engine, 'camoufox');
  assert.equal(p.launch.siteIsolationDisabled, true); // з дефолту
  assert.equal(p.stealth.webdriver, false);
  assert.equal(p.stealth.windowChrome, true);
  assert.equal(p.fingerprint, null);
  assert.deepEqual(mergeLoadedProfile(null), defaultProfile());
});

test('applyProfilePatch: не мутує вхідний профіль', () => {
  const p0 = defaultProfile();
  const snap = JSON.stringify(p0);
  applyProfilePatch(p0, { stealth: { webdriver: false }, launch: { engine: 'camoufox' }, behavior: { humanize: false } });
  assert.equal(JSON.stringify(p0), snap);
});

test('applyProfilePatch: launch змінився → launchChanged', () => {
  const r = applyProfilePatch(defaultProfile(), { launch: { engine: 'camoufox' } });
  assert.equal(r.launchChanged, true);
  assert.equal(r.changed, true);
  assert.equal(r.profile.launch.engine, 'camoufox');
  assert.equal(r.profile.launch.headless, true); // решта збережена
});

test('applyProfilePatch: той самий launch → без перезапуску', () => {
  const p0 = defaultProfile();
  const r = applyProfilePatch(p0, { launch: { ...p0.launch } });
  assert.equal(r.launchChanged, false);
  assert.equal(r.changed, false);
});

test('applyProfilePatch: лише fingerprint → changed, але не launchChanged', () => {
  const r = applyProfilePatch(defaultProfile(), { fingerprint: { locale: 'uk' } });
  assert.equal(r.launchChanged, false);
  assert.equal(r.changed, true);
  assert.deepEqual(r.profile.fingerprint, { locale: 'uk' });
});

test('applyProfilePatch: clear → голий Playwright і перезапуск', () => {
  const p0 = { ...defaultProfile(), fingerprint: { locale: 'uk' }, storageState: { cookies: [{ name: 'a' }], origins: [] } };
  const r = applyProfilePatch(p0, { clear: true });
  assert.equal(r.launchChanged, true);
  assert.equal(r.profile.fingerprint, null);
  assert.equal(r.profile.storageState, null);
  assert.deepEqual(r.profile.launch, PLAYWRIGHT_DEFAULTS.launch);
  assert.deepEqual(r.profile.stealth, PLAYWRIGHT_DEFAULTS.stealth);
  assert.deepEqual(r.profile.behavior, { humanize: false, prepareScroll: false, fastPrefix: false });
});

test('applyProfilePatch: clear + launch у тому ж тілі (пресет поверх голого)', () => {
  const r = applyProfilePatch(defaultProfile(), { clear: true, launch: { engine: 'camoufox' } });
  assert.equal(r.profile.launch.engine, 'camoufox');
  assert.equal(r.profile.launch.stealthPlugin, false);
});

test('applyProfilePatch: cookies → storageState; cookies:null → очищення', () => {
  const r1 = applyProfilePatch(defaultProfile(), { cookies: [{ name: 'sid', value: 1, domain: '.x.com' }] });
  assert.equal(r1.profile.storageState.cookies.length, 1);
  assert.equal(r1.profile.storageState.cookies[0].value, '1');
  const r2 = applyProfilePatch(r1.profile, { cookies: null });
  assert.equal(r2.profile.storageState, null);
  const r3 = applyProfilePatch(r1.profile, {}); // нічого не передали — cookies лишаються
  assert.equal(r3.profile.storageState.cookies.length, 1);
});

test('toStorageState: Cookie-Editor → Playwright', () => {
  const ss = toStorageState([
    { name: 'a', value: 'x', domain: '.ex.com', expirationDate: 1700000000.6, sameSite: 'no_restriction', secure: true, httpOnly: true },
    { name: 'b', value: 'y', sameSite: 'strict', expires: 5 },
    { name: 'c', sameSite: 'unspecified' },
    { value: 'no name' }, null,
  ]);
  assert.equal(ss.cookies.length, 3);
  assert.deepEqual(ss.cookies[0], { name: 'a', value: 'x', domain: '.ex.com', path: '/', expires: 1700000001, httpOnly: true, secure: true, sameSite: 'None' });
  assert.equal(ss.cookies[1].sameSite, 'Strict');
  assert.equal(ss.cookies[1].expires, 5);
  assert.equal(ss.cookies[2].sameSite, 'Lax');
  assert.equal(ss.cookies[2].value, '');
  assert.equal(ss.cookies[2].expires, -1);
  assert.deepEqual(ss.origins, []);
});

test('toStorageState: уже storageState → як є; порожнє → null', () => {
  const s = { cookies: [], origins: [] };
  assert.equal(toStorageState(s), s);
  assert.equal(toStorageState(null), null);
  assert.equal(toStorageState([]), null);
  assert.equal(toStorageState({ foo: 1 }), null);
});

test('fullConfig: формат відповіді /profile', () => {
  const p = { ...defaultProfile(), storageState: { cookies: Array.from({ length: 60 }, (_, i) => ({ name: 'c' + i })) } };
  const c = fullConfig(p);
  assert.equal(c.cookiesCount, 60);
  assert.equal(c.cookies.length, 50);
  assert.equal(c.hasFingerprint, false);
  assert.equal(c.defaults, PLAYWRIGHT_DEFAULTS);
  assert.deepEqual(Object.keys(c).sort(), ['behavior', 'cookies', 'cookiesCount', 'defaults', 'fingerprint', 'hasFingerprint', 'launch', 'proxy', 'stealth']);
});

test('contextOptions: дефолти і fingerprint', () => {
  const d = contextOptions(defaultProfile());
  assert.deepEqual(d.viewport, { width: 1280, height: 900 });
  assert.equal(d.userAgent, DEFAULT_UA);
  assert.equal(d.locale, 'en-US');
  assert.equal(d.deviceScaleFactor, 1);
  assert.equal('storageState' in d, false);
  const f = contextOptions({ ...defaultProfile(), fingerprint: { userAgent: 'UA', locale: 'uk', timezoneId: 'Europe/Kiev', deviceScaleFactor: 2 }, storageState: { cookies: [], origins: [] } });
  assert.equal(f.userAgent, 'UA');
  assert.equal(f.timezoneId, 'Europe/Kiev');
  assert.equal(f.deviceScaleFactor, 2);
  assert.ok(f.storageState);
});

test('profileSig: стабільний і чутливий до змін', () => {
  const p = defaultProfile();
  assert.equal(profileSig(p), profileSig(defaultProfile()));
  assert.notEqual(profileSig(p), profileSig(applyProfilePatch(p, { behavior: { humanize: false } }).profile));
});

test('createProfileStore: load/save через файл (атомарно), битий файл → дефолт', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-prof-'));
  const file = path.join(dir, 'sub', 'profile.json');
  const quiet = { error() {} };
  const s1 = createProfileStore(file, { log: quiet });
  assert.deepEqual(s1.load(), defaultProfile()); // файлу ще немає
  s1.set(applyProfilePatch(s1.get(), { launch: { engine: 'camoufox' } }).profile);
  s1.save();
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['profile.json']); // tmp прибрано
  const s2 = createProfileStore(file, { log: quiet });
  assert.equal(s2.load().launch.engine, 'camoufox');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createProfileStore(file, { log: quiet }).load(), defaultProfile());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyProfilePatch: проксі — зміна = launchChanged; undefined — без змін; пресет (launch/clear) проксі не чіпає; невалідний → 400', () => {
  const p0 = defaultProfile();
  const a = applyProfilePatch(p0, { proxy: { server: 'h.test:3128', username: 'u', password: 'p' } });
  assert.deepEqual(a.profile.proxy, { server: 'http://h.test:3128', username: 'u', password: 'p' });
  assert.equal(a.launchChanged, true);
  assert.equal(p0.proxy, null, 'вхідний профіль не мутується');
  const same = applyProfilePatch(a.profile, { proxy: { server: 'http://h.test:3128', username: 'u' } });
  assert.equal(same.profile.proxy.password, 'p', 'пароль не надіслано — лишився');
  assert.equal(same.launchChanged, false);
  assert.equal(applyProfilePatch(a.profile, { launch: { headless: true } }).profile.proxy.server, 'http://h.test:3128');
  assert.equal(applyProfilePatch(a.profile, { clear: true }).profile.proxy.server, 'http://h.test:3128', 'Clear all — пресет, не середовище');
  const off = applyProfilePatch(a.profile, { proxy: null });
  assert.equal(off.profile.proxy, null);
  assert.equal(off.launchChanged, true);
  assert.throws(() => applyProfilePatch(p0, { proxy: { server: 'h.test' } }), (e) => e.status === 400 && /Проксі: .*порт/.test(e.message));
  assert.match(applyProfilePatch(p0, { proxy: 'socks5://u:p@h.test:1080' }).proxyWarning, /SOCKS/);
});

test('mergeLoadedProfile / fullConfig / profileSig: проксі з файлу, пароль назовні не віддається', () => {
  const p = mergeLoadedProfile({ proxy: { server: 'h.test:3128', username: 'u', password: 'secret' } });
  assert.deepEqual(p.proxy, { server: 'http://h.test:3128', username: 'u', password: 'secret' });
  assert.equal(mergeLoadedProfile({ proxy: { server: 'broken' } }).proxy, null, 'зіпсований — пряме зʼєднання');
  assert.equal(mergeLoadedProfile({}).proxy, null);
  const c = fullConfig(p);
  assert.deepEqual(c.proxy, { server: 'http://h.test:3128', username: 'u', bypass: '', hasPassword: true, enabled: true });
  assert.equal(JSON.stringify(c).includes('secret'), false);
  assert.notEqual(profileSig(p), profileSig({ ...p, proxy: null }));
});

test('applyProfilePatch: перемикач проксі — вимкнути/увімкнути = перезапуск, налаштування й пароль лишаються; правка вимкненого — без перезапуску', () => {
  const a = applyProfilePatch(defaultProfile(), { proxy: { server: 'h.test:3128', username: 'u', password: 'p' } }).profile;
  const off = applyProfilePatch(a, { proxy: { server: 'http://h.test:3128', username: 'u', bypass: '', enabled: false } });
  assert.equal(off.launchChanged, true);
  assert.deepEqual(off.profile.proxy, { server: 'http://h.test:3128', username: 'u', password: 'p', enabled: false });
  const edit = applyProfilePatch(off.profile, { proxy: { server: 'other.test:1', username: 'u', enabled: false } });
  assert.equal(edit.launchChanged, false, 'вимкнений — правки не чіпають браузер');
  const on = applyProfilePatch(edit.profile, { proxy: { server: 'other.test:1', username: 'u', enabled: true } });
  assert.equal(on.launchChanged, true);
  assert.deepEqual(on.profile.proxy, { server: 'http://other.test:1', username: 'u', password: 'p' });
  assert.equal(fullConfig(off.profile).proxy.enabled, false);
});
