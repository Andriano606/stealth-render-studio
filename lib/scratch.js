// Тимчасові («scratch») браузери для конфігу «на один запит» (MCP): інший рушій або інші
// параметри запуску, ніж застосовані, — БЕЗ зміни профілю й без перезапуску основного
// браузера (UI, прогони і живі сесії не чіпаються).
//
// Браузер кешується за launchKey (той самий рушій/прапорці/проксі → повторне використання),
// кожен запит отримує власний ізольований контекст. Невикористаний браузер закривається
// після idleMs; одночасно живе не більше max (найстаріший вільний витісняється).
// Імпорт нічого не запускає: createScratchBrowsers({ launchers }) — запускачі інʼєктуються.
import { launchKey, launchForProfile, newUnitOn, engineKind } from './engine.js';

export function createScratchBrowsers({ launchers, log = console, idleMs = 3 * 60 * 1000, max = 2, now = Date.now } = {}) {
  const entries = new Map(); // key → { key, kind, promise, browser, users, lastUsed }
  let timer = null;

  async function closeEntry(e, why) {
    if (entries.get(e.key) === e) entries.delete(e.key);
    const b = e.browser || await e.promise.catch(() => null);
    if (b) { try { await b.close(); } catch (_e) {} }
    if (why) log.log('Тимчасовий браузер (' + e.kind + ') закрито: ' + why);
  }

  // Звільняє місце під новий браузер: закриває найдавніше використаний вільний.
  async function evict() {
    while (entries.size >= max) {
      const idle = [...entries.values()].filter((e) => e.users === 0).sort((a, b) => a.lastUsed - b.lastUsed);
      if (!idle.length) return; // усі зайняті — тимчасово перевищуємо ліміт
      await closeEntry(idle[0], 'ліміт тимчасових браузерів');
    }
  }

  function sweep() {
    for (const e of [...entries.values()]) {
      if (e.users === 0 && now() - e.lastUsed > idleMs) closeEntry(e, 'простій');
    }
    if (!entries.size && timer) { clearInterval(timer); timer = null; }
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(sweep, Math.max(1000, Math.min(idleMs, 30000)));
    if (typeof timer.unref === 'function') timer.unref();
  }

  // opts — для newUnitOn ({camoufoxState}). → { context, page, camoufox, fromPool:false, scratch:true, launched } — закривати через closeUnit.
  async function take(profile, opts = {}) {
    const key = launchKey(profile);
    let e = entries.get(key);
    let launched = false;
    if (!e) {
      await evict();
      e = entries.get(key); // поки витісняли, міг зʼявитись паралельний запит з тим самим ключем
    }
    if (!e) {
      launched = true;
      e = { key, kind: engineKind(profile), browser: null, users: 0, lastUsed: now() };
      const entry = e;
      e.promise = launchForProfile(launchers, profile, log).then((b) => {
        entry.browser = b;
        try {
          if (typeof b.on === 'function') b.on('disconnected', () => { if (entries.get(key) === entry) entries.delete(key); });
        } catch (_e) {}
        return b;
      });
      e.promise.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      entries.set(key, e);
      ensureTimer();
    }
    e.users++;
    try {
      const b = await e.promise;
      const unit = await newUnitOn(b, e.kind, profile, opts);
      return { ...unit, fromPool: false, scratch: true, launched, _entry: e };
    } catch (err) {
      e.users--; e.lastUsed = now();
      throw err;
    }
  }

  async function closeUnit(unit) {
    if (!unit) return;
    try { if (unit.context) await unit.context.close(); } catch (_e) {}
    const e = unit._entry;
    if (e && e.users > 0) { e.users--; e.lastUsed = now(); }
  }

  return {
    take,
    closeUnit,
    sweep,
    stats() { return [...entries.values()].map((e) => ({ kind: e.kind, users: e.users, ready: !!e.browser })); },
    async closeAll() {
      if (timer) { clearInterval(timer); timer = null; }
      await Promise.all([...entries.values()].map((e) => closeEntry(e)));
    },
  };
}
