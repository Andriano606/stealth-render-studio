// Видимі («інтерактивні») браузери для MCP: open_browser відкриває ВІКНО з обраним конфігом
// (пресет/рушій/прапорці/fingerprint/проксі — на цей браузер, профіль не змінюється), користувач
// у ньому працює руками (напр. логіниться), Claude дивиться стан (browser_status) і зберігає
// сесію (save_session → lib/savedSessions.js), потім закриває (close_browser).
//
// Кожен — окремий процес браузера (headless:false) з одним контекстом; живе, доки його не
// закрили (MCP, вікно, простій idleMs без звернень MCP, SIGTERM). Імпорт нічого не запускає.
import { launchForProfile, engineKind } from './engine.js';
import { contextOptions } from './profile.js';
import { stealthScript } from './stealth.js';

// Профіль видимого вікна: той самий конфіг, але headless вимкнено.
export function headfulProfile(profile) {
  return { ...profile, launch: { ...(profile.launch || {}), headless: false } };
}

// Опції контексту видимого вікна: viewport:null — сторінка займає реальне вікно (з фіксованим
// viewport вікно й сторінка розходяться); deviceScaleFactor з null-viewport Playwright не приймає.
// storageState — збережена сесія (перекриває cookies профілю); Camoufox — лише вона (без наших опцій).
// view — явні viewport/DPR із запиту (MCP): фіксований viewport замість null, DPR — лише разом із ним
// (Playwright не приймає deviceScaleFactor з viewport:null; про це каже лог camoufoxWindowLines).
export function headfulContextOptions(profile, kind, storageState = null, view = null) {
  const vp = view && view.viewport ? { width: view.viewport.width, height: view.viewport.height } : null;
  const sized = vp ? { viewport: vp, ...(view.deviceScaleFactor ? { deviceScaleFactor: view.deviceScaleFactor } : {}) } : { viewport: null };
  if (kind === 'camoufox') return { ...sized, ...(storageState ? { storageState } : {}) };
  const o = { ...contextOptions(profile) };
  delete o.deviceScaleFactor;
  Object.assign(o, sized);
  if (storageState) o.storageState = storageState;
  return o;
}

export function createInteractiveBrowsers({ launchers, log = console, max = 2, idleMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const items = new Map(); // id → entry
  let seq = 0, timer = null;

  async function closeEntry(e, why) {
    if (!items.has(e.id)) return;
    items.delete(e.id);
    e.closed = why || 'закрито';
    try { await e.browser.close(); } catch (_e) {}
    log.log('Видимий браузер ' + e.id + ' закрито: ' + e.closed);
    if (!items.size && timer) { clearInterval(timer); timer = null; }
  }

  function sweep() {
    for (const e of [...items.values()]) if (now() - e.lastUsed > idleMs) closeEntry(e, 'простій');
  }

  // profile — ефективний профіль (headless вимкнеться тут); opts: {url, storageState, label, view}.
  async function open(profile, { url = null, storageState = null, label = '', view = null } = {}) {
    if (items.size >= max) {
      throw Object.assign(new Error('Уже відкрито ' + items.size + ' видимих браузери (' + [...items.keys()].join(', ') + ') — закрий один (close_browser).'), { expected: true });
    }
    const prof = headfulProfile(profile);
    const kind = engineKind(prof);
    const browser = await launchForProfile(launchers, prof, log);
    let context;
    try {
      context = await browser.newContext(headfulContextOptions(prof, kind, storageState, view));
      if (kind !== 'camoufox') await context.addInitScript(stealthScript(prof.fingerprint, prof.stealth));
      const page = await context.newPage();
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((err) => log.error('open_browser goto:', err.message));
    } catch (err) {
      try { await browser.close(); } catch (_e) {}
      throw err;
    }
    const id = 'b' + (++seq);
    const e = { id, kind, browser, context, label, view, profile: prof, openedAt: now(), lastUsed: now(), closed: null };
    items.set(id, e);
    // Користувач закрив вікно / браузер упав.
    try { if (typeof browser.on === 'function') browser.on('disconnected', () => { closeEntry(e, 'браузер закрито'); }); } catch (_e) {}
    try { if (typeof context.on === 'function') context.on('close', () => { closeEntry(e, 'вікно закрито'); }); } catch (_e) {}
    if (!timer) {
      timer = setInterval(sweep, Math.max(1000, Math.min(idleMs, 60000)));
      if (typeof timer.unref === 'function') timer.unref();
    }
    log.log('Видимий браузер ' + id + ' (' + kind + ') відкрито' + (url ? ': ' + url : ''));
    return e;
  }

  // → entry (і продовжує життя) або помилка з переліком відкритих.
  function get(id) {
    const key = id == null || id === '' ? (items.size === 1 ? [...items.keys()][0] : null) : String(id);
    const e = key ? items.get(key) : null;
    if (!e) {
      const open = [...items.keys()];
      throw Object.assign(new Error(open.length
        ? (key ? 'Браузер «' + id + '» не знайдено. ' : 'Вкажи browser. ') + 'Відкриті: ' + open.join(', ')
        : 'Немає відкритих видимих браузерів (open_browser).'), { expected: true });
    }
    e.lastUsed = now();
    return e;
  }

  // Сторінки контексту (відкриті), активна — остання відкрита (нова вкладка/попап зазвичай і є поточною).
  function pagesOf(e) {
    const pages = (e.context.pages ? e.context.pages() : []).filter((p) => !(p.isClosed && p.isClosed()));
    return { pages, active: pages[pages.length - 1] || null };
  }

  return {
    open,
    get,
    pagesOf,
    sweep,
    async close(id) { const e = get(id); await closeEntry(e, 'закрито через MCP'); return e; },
    list() { return [...items.values()]; },
    async closeAll() {
      if (timer) { clearInterval(timer); timer = null; }
      await Promise.all([...items.values()].map((e) => closeEntry(e, 'сервер зупиняється')));
    },
  };
}
