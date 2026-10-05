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
  assert.deepEqual(Object.keys(c).sort(), ['behavior', 'cookies', 'cookiesCount', 'defaults', 'fingerprint', 'hasFingerprint', 'launch', 'stealth']);
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
