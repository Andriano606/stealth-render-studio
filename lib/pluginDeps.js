// Жадібне (при старті) резолвлення залежностей плагінів playwright-extra.
//
// playwright-extra за замовчуванням підвантажує залежності плагіна (напр. усі
// `stealth/evasions/*` для stealth-плагіна) ЛІНИВО — динамічним `require()` у
// момент першого launch. Якщо на той час файли вже недоступні (тека проєкту
// перенесена/перейменована при запущеному сервері, node_modules перевстановлюється)
// — launch падає з «Plugin dependency not found», і браузер не стартує.
// Тому ми проходимо дерево залежностей одразу при старті й реєструємо модулі
// через `plugins.setDependencyResolution()` — тоді launch не робить жодних require.

// 'stealth/evasions/chrome.app' → 'puppeteer-extra-plugin-stealth/evasions/chrome.app'
// (та сама схема префіксів, що й у playwright-extra).
export function depModulePath(dep) {
  const PREFIX = 'puppeteer-extra-plugin-';
  return dep.startsWith(PREFIX) ? dep : PREFIX + dep;
}

// Рекурсивно обходить `plugin.dependencies` (Set/Array або Map dep→opts).
// requireDep(dep) → фабрика плагіна; register(dep, factory) — реєстрація.
// Повертає список зареєстрованих залежностей (у порядку обходу).
export function preloadPluginDeps(plugin, requireDep, register, seen = new Set()) {
  const deps = plugin && plugin.dependencies;
  if (!deps) return [...seen];
  const entries = deps instanceof Map ? [...deps.entries()] : [...deps].map(d => [d, undefined]);
  for (const [dep, opts] of entries) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const factory = requireDep(dep);
    register(dep, factory);
    preloadPluginDeps(factory(opts || {}), requireDep, register, seen); // вкладені залежності
  }
  return [...seen];
}
