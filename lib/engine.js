// Рушій браузера: запуск (Chromium | Camoufox), теплий пул контекстів, перезапуск.
//
// Браузер запускається ОДИН раз і живе весь час роботи сервера. На кожен запит
// береться готовий ізольований контекст із пулу (newContext ~0 мс). Кожен
// контекст використовується РІВНО раз → ізоляція сесій.
//
// Імпорт модуля нічого не запускає: усе через createEngine({...}). Запускачі
// браузерів інʼєктуються (launchers) — тому логіку пулу можна тестувати без браузера.
import { contextOptions, profileSig as sigOfProfile } from './profile.js';
import { stealthScript } from './stealth.js';

// --- Чисті білдери опцій запуску ---

// Аргументи Chromium за прапорцями launch.*
export function launchArgs(launch) {
  const L = launch || {};
  const args = [];
  // Прибирає ключовий сигнал автоматизації на рівні рушія.
  if (L.automationControlled !== false) args.push('--disable-blink-features=AutomationControlled');
  // Справжній апаратний GPU (ANGLE→Metal на Mac) замість софтверного SwiftShader.
  if (L.realGpu !== false) args.push('--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=metal');
  // Вимкнена ізоляція сайтів — щоб крос-доменні iframe (напр. форма Ashby)
  // рендерились у спільному процесі й потрапляли у fullPage-скриншот.
  // Керується прапорцем (у «Clear all» = false → голий Playwright з ізоляцією).
  if (L.siteIsolationDisabled !== false) args.push('--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials');
  return args;
}

// Опції запуску. Новий headless (--headless=new) майже не відрізняється від
// справжнього Chrome; старий headless (headless:true) — детектованіший.
export function launchFlags(launch) {
  const L = launch || {};
  const args = launchArgs(L);
  const wantHeadless = L.headless !== false;
  if (!wantHeadless) return { headless: false, channel: 'chrome', args };        // headful
  if (L.newHeadless !== false) { args.push('--headless=new'); return { headless: false, channel: 'chrome', args }; }
  return { headless: true, channel: 'chrome', args };                            // старий headless
}

// Опції Camoufox (Firefox-антидетект).
export function camoufoxOptions(launch) {
  const L = launch || {};
  return {
    headless: L.headless !== false,
    humanize: L.camoufoxHumanize !== false, // людські рухи курсора на рівні рушія
    geoip: L.camoufoxGeoip !== false,       // підбирає timezone/locale під IP
  };
}

export const engineKind = (profile) =>
  ((profile && profile.launch && profile.launch.engine) === 'camoufox' ? 'camoufox' : 'chromium');

// Реальні запускачі (динамічний імпорт — щоб тести не тягнули playwright/camoufox).
// getStealthChromium — () => Promise<chromiumExtra> (див. stealth.js setupStealthPlugin).
export function defaultLaunchers({ getStealthChromium }) {
  return {
    async chromium(flags, usePlugin) {
      const engine = usePlugin ? await getStealthChromium() : (await import('playwright')).chromium;
      return engine.launch(flags);
    },
    // Фази з таймінгом у лозі: перший запуск Camoufox буває дуже довгим (холодний диск,
    // аддони, WebGL-база) — так видно, ДЕ саме час.
    async camoufox(opts, log = console) {
      const t = () => Date.now();
      let t0 = t();
      const { launchOptions } = await import('camoufox-js');
      const { firefox } = await import('playwright-core');
      const tImport = t() - t0; t0 = t();
      const { headless, ...rest } = opts || {};
      const fromOptions = await launchOptions({ ...rest, headless: !!headless });
      const tOpts = t() - t0; t0 = t();
      const b = await firefox.launch(fromOptions);
      log.log('Camoufox: імпорт ' + tImport + ' мс, launchOptions ' + tOpts + ' мс, запуск ' + (t() - t0) + ' мс');
      return b;
    },
  };
}

// --- Рушій із пулом ---
export function createEngine({ getProfile, launchers, poolSize = 3, log = console }) {
  let browser = null;       // поточний браузер (Chromium або Camoufox)
  let browserKind = null;   // 'chromium' | 'camoufox'
  let launchPromise = null; // single-flight запуск
  let refillPromise = null; // single-flight поповнення пулу (у межах одного покоління)
  let refillGen = -1;       // покоління, для якого крутиться refillPromise
  let relaunching = null;   // Promise, поки йде перезапуск
  let gen = 0;              // покоління пулу: юніти зі старого покоління не видаємо
  const pool = [];
  const beforeRelaunch = [];

  const isCamoufox = () => engineKind(getProfile()) === 'camoufox';

  // Готує активний рушій. Конкурентні виклики чекають той самий запуск.
  function ensure() {
    const want = engineKind(getProfile());
    if (browser && browserKind === want) return Promise.resolve(browser);
    if (launchPromise) return launchPromise;
    launchPromise = (async () => {
      if (browser && browserKind !== want) await closeBrowser(); // рушій змінився без relaunch
      const L = getProfile().launch || {};
      let b;
      if (want === 'camoufox') {
        log.log('Запускаю CAMOUFOX (Firefox-антидетект)...');
        b = await launchers.camoufox(camoufoxOptions(L), log);
        log.log('Camoufox готовий.');
      } else {
        const usePlugin = L.stealthPlugin !== false;
        log.log('Запускаю браузер (ізольований), stealth-plugin=' + usePlugin + '...');
        b = await launchers.chromium(launchFlags(L), usePlugin);
        log.log('Браузер готовий і чекає на запити.');
      }
      browser = b; browserKind = want;
      // Браузер упав/закрився ззовні → наступний запит запустить новий.
      try {
        if (typeof b.on === 'function') b.on('disconnected', () => {
          if (browser === b) { browser = null; browserKind = null; gen++; log.error('Браузер відʼєднався — буде перезапущено за потреби.'); }
        });
      } catch (_e) {}
      return b;
    })();
    launchPromise.then(() => { launchPromise = null; }, () => { launchPromise = null; });
    return launchPromise;
  }

  async function closeBrowser() {
    const b = browser;
    browser = null; browserKind = null; // (disconnected-хендлер вже не спрацює: browser !== b)
    if (b) { try { await b.close(); } catch (_e) {} }
  }

  // Створює одиницю {context, page, gen} для поточного рушія.
  async function makeReadyUnit() {
    const myGen = gen;
    const b = await ensure();
    const profile = getProfile();
    if (browserKind === 'camoufox') {
      // Camoufox сам керує fingerprint/stealth (на рівні рушія) — НЕ додаємо наші
      // Chromium-патчі (stealthScript/contextOptions), щоб не плодити JS-сліди.
      const context = await b.newContext();
      const page = await context.newPage();
      return { context, page, camoufox: true, gen: myGen };
    }
    const context = await b.newContext(contextOptions(profile));
    await context.addInitScript(stealthScript(profile.fingerprint, profile.stealth));
    const page = await context.newPage(); // порожня сторінка about:blank уже відкрита
    return { context, page, camoufox: false, gen: myGen };
  }

  // Закриває використану одиницю (весь контекст).
  async function closeUnit(unit) {
    if (!unit) return;
    try { if (unit.context) await unit.context.close(); } catch (_e) {}
  }

  const isStale = (u) => u.gen !== gen || (u.page && typeof u.page.isClosed === 'function' && u.page.isClosed());

  // Поповнення пулу. Відсутні юніти створюються ПАРАЛЕЛЬНО: у Camoufox кожна нова
  // сторінка — окремий процес (~6–9 с), послідовно 3 шт. = ~25 с, паралельно ≈ 9 с.
  // Single-flight у межах покоління: після relaunch/drain (gen++) стартує новий цикл,
  // не чекаючи старого — той сам зупиниться, а його запізнілі юніти буде закрито.
  function refillNow() {
    if (refillPromise && refillGen === gen) return refillPromise;
    const startGen = gen;
    const p = (async () => {
      try {
        // Якщо покоління змінилось (relaunch/drain) — зупиняємось: той, хто його
        // змінив, сам запустить нове поповнення (інакше зайвий запуск браузера).
        while (pool.length < poolSize && gen === startGen) {
          const need = poolSize - pool.length;
          const res = await Promise.allSettled(Array.from({ length: need }, () => makeReadyUnit()));
          let made = 0;
          for (const r of res) {
            if (r.status !== 'fulfilled') continue;
            const unit = r.value;
            // Поки ми чекали — міг статися relaunch/drain (або пул уже повний): закриваємо.
            if (isStale(unit) || gen !== startGen || pool.length >= poolSize) { await closeUnit(unit); continue; }
            pool.push(unit); made++;
          }
          const err = res.find((r) => r.status === 'rejected');
          if (err && gen === startGen) log.error('refillPool error:', String((err.reason && err.reason.message) || err.reason));
          if (!made) break; // нічого не вийшло — не крутимось у циклі помилок
        }
      } catch (e) {
        log.error('refillPool error:', e.message);
      }
    })();
    refillPromise = p; refillGen = startGen;
    p.finally(() => { if (refillPromise === p) refillPromise = null; });
    return p;
  }

  // Чекає, доки поточне поповнення пулу завершиться (для тестів / діагностики).
  async function whenPoolReady() {
    while (refillPromise) await refillPromise;
  }

  async function ensureEngine() { if (relaunching) await relaunching; await ensure(); }
  async function refillPool() { if (relaunching) await relaunching; return refillNow(); }

  // Віддає готовий контекст із пулу (fromPool=true) або, якщо пул порожній,
  // створює на льоту (fromPool=false). У будь-якому разі одразу тригерить поповнення.
  async function takeUnit() {
    if (relaunching) await relaunching;
    let unit = null;
    while (pool.length) {
      const u = pool.shift();
      if (isStale(u)) { closeUnit(u); continue; }
      unit = u; break;
    }
    refillNow(); // поповнюємо у фоні, не чекаючи
    if (unit) return { ...unit, fromPool: true };
    return { ...(await makeReadyUnit()), fromPool: false };
  }

  // Пересоздаємо пул, щоб нові контексти одразу мали оновлений профіль.
  // Повертається одразу: старі юніти закриваються, нові створюються у ФОНІ
  // (takeUnit до того часу просто створить контекст на льоту).
  // Camoufox: профіль (fingerprint/stealth/cookies) на його контексти не впливає
  // (newContext() без наших опцій) — пул не чіпаємо, це лише зайві ~9 с.
  async function drainPool() {
    if (relaunching) await relaunching;
    if (browser && browserKind === 'camoufox' && engineKind(getProfile()) === 'camoufox') return;
    gen++;
    const old = pool.splice(0, pool.length);
    for (const u of old) closeUnit(u);
    refillNow(); // пул — у фоні
    // Браузера немає (відʼєднався / попередній запуск упав / стартовий ще йде) —
    // чекаємо лише сам браузер (single-flight з ensure у refillNow), не сторінки пулу,
    // щоб engineReady() у POST /profile відображав реальність. Помилка запуску — наверх.
    if (!(browser && browserKind === engineKind(getProfile()))) await ensure();
  }

  // Перезапуск рушія (при зміні launch-прапорців). Спершу — хуки onBeforeRelaunch
  // (напр. закрити живі сесії), потім закриття пулу/браузера і новий запуск.
  async function relaunchBrowser() {
    if (relaunching) await relaunching.catch(() => {});
    let done;
    relaunching = new Promise((r) => { done = r; });
    gen++; // одразу (в тому ж тіку, що й зміна профілю) — фонове поповнення зупиниться
    try {
      for (const fn of beforeRelaunch) { try { await fn(); } catch (e) { log.error('onBeforeRelaunch:', e.message); } }
      if (launchPromise) await launchPromise.catch(() => {});
      // Старе поповнення НЕ чекаємо (у Camoufox це до ~9 с): gen++ уже зупинив його,
      // а юніти, що допишуться пізніше, буде закрито як застарілі.
      const old = pool.splice(0, pool.length);
      for (const u of old) await closeUnit(u);
      await closeBrowser();
      await ensure();
      refillNow(); // пул — у фоні: відповідь UI одразу після запуску браузера
    } finally {
      relaunching = null;
      done();
    }
  }

  return {
    isCamoufox,
    ensureEngine,
    refillPool,
    takeUnit,
    closeUnit,
    drainPool,
    relaunchBrowser,
    onBeforeRelaunch(fn) { beforeRelaunch.push(fn); },
    engineReady() { return !!browser && browserKind === engineKind(getProfile()); },
    profileSig() { return sigOfProfile(getProfile()); },
    poolStats() { return { ready: pool.length, size: poolSize, gen }; },
    whenPoolReady,
    async close() {
      gen++;
      const old = pool.splice(0, pool.length);
      for (const u of old) await closeUnit(u);
      await closeBrowser();
    },
  };
}
