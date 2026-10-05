// Юніт-тести жадібного резолвлення залежностей плагінів (lib/pluginDeps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { depModulePath, preloadPluginDeps } from '../lib/pluginDeps.js';

const require = createRequire(import.meta.url);

test('depModulePath: додає префікс puppeteer-extra-plugin-', () => {
  assert.equal(depModulePath('stealth/evasions/chrome.app'), 'puppeteer-extra-plugin-stealth/evasions/chrome.app');
  assert.equal(depModulePath('user-preferences'), 'puppeteer-extra-plugin-user-preferences');
  assert.equal(depModulePath('puppeteer-extra-plugin-foo'), 'puppeteer-extra-plugin-foo'); // вже з префіксом
});

test('preloadPluginDeps: рекурсивно, без дублів, з opts із Map', () => {
  const tree = {
    a: { dependencies: new Set(['b', 'c']) },
    b: { dependencies: new Set(['c']) },     // c — спільна залежність
    c: { dependencies: new Map([['d', { x: 1 }]]) },
    d: {},
  };
  const gotOpts = {};
  const requireDep = (dep) => (opts) => { gotOpts[dep] = opts; return tree[dep]; };
  const registered = [];
  const out = preloadPluginDeps(tree.a, requireDep, (dep) => registered.push(dep));
  assert.deepEqual(registered, ['b', 'c', 'd']);
  assert.deepEqual(out, ['b', 'c', 'd']);
  assert.deepEqual(gotOpts.d, { x: 1 });
});

test('preloadPluginDeps: плагін без залежностей → нічого не реєструє', () => {
  const registered = [];
  preloadPluginDeps({}, () => { throw new Error('не має викликатись'); }, (d) => registered.push(d));
  assert.deepEqual(registered, []);
});

test('preloadPluginDeps: реальний stealth-плагін резолвиться повністю', () => {
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('webgl.vendor'); // як у server.js
  const deps = preloadPluginDeps(stealth, (d) => require(depModulePath(d)), () => {});
  assert.ok(deps.includes('stealth/evasions/chrome.app'));
  assert.ok(deps.includes('user-preferences'));    // вкладена (через user-agent-override)
  assert.ok(deps.includes('user-data-dir'));       // вкладена (через user-preferences)
  assert.ok(!deps.includes('stealth/evasions/webgl.vendor'));
});
