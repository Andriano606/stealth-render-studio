// persist.js — збереження сценаріїв у БД: debounce + серіалізація по id + повтори.
//   createPersistQueue({save, remove, delay, retryDelays, timers, onChange}) — ЧИСТА черга
//       (fetch і таймери інʼєктуються → тестується в node:test без браузера):
//         schedule(id, getPayload) — відкладене збереження (getPayload читає НАЙСВІЖІШИЙ
//                                    стан у момент відправки; часті зміни зливаються в один PUT);
//         flush(id) / flushAll()   — відправити зараз (напр. перед закриттям вкладки);
//         remove(id)               — скасувати відкладене, дочекатися PUT у польоті, потім DELETE
//                                    (старий PUT не «воскресить» видалений сценарій);
//         retryAll()               — повторити невдалі зараз;
//         status()                 — {pending, saving, failed, nodb, lastError, unsaved}.
//       Порядок: на один id — не більше одного запиту в польоті; зміни під час польоту →
//       ще один PUT після нього (новіший стан завжди виграє). Помилка → повтори з
//       затримками retryDelays, далі — «Не збережено» до ручного повтору або нової зміни.
//       Відповідь {db:false} → nodb: дані лише в памʼяті (повторювати марно); {db:false, memory:true} —
//       сервер тримає сценарії в памʼяті процесу (зберігаємо як завжди, без бейджа «Не збережено»).
//   savePayload(page) — payload PUT без тимчасових полів і без pending-кроків живого запису;
//   initPersist() / persistPage(page) / deletePageRemote(id) / persistStatus — екземпляр для UI
//       поверх fetch (PUT/DELETE /pages/:id) + бейдж «Не збережено» в хедері.
// Під час імпорту DOM не чіпається.
import { parseJsonResponse } from './api.js';
import { pagePayload } from '../../lib/steps.js';
import { state, on, emit } from './state.js';

export const DEFAULT_DELAY = 400;
export const DEFAULT_RETRY_DELAYS = [1000, 3000, 10000, 30000];

export function createPersistQueue({
  save, remove: removeFn = async () => ({}), delay = DEFAULT_DELAY, retryDelays = DEFAULT_RETRY_DELAYS,
  timers = { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: (t) => globalThis.clearTimeout(t) },
  onChange = () => {},
} = {}) {
  // id → {getPayload, timer, inflight: Promise|null, dirty, attempts, error, retryTimer}
  const entries = new Map();
  let nodb = false;      // сервер без БД (з /pages або з відповіді PUT)
  let nodbDirty = false; // і були зміни, які через це не збереглися
  let lastError = null;

  const key = (id) => String(id);
  const status = () => {
    let pending = 0, saving = 0, failed = 0;
    for (const e of entries.values()) {
      if (e.inflight) saving++;
      else if (e.error) failed++;
      else pending++;
    }
    return { pending, saving, failed, nodb, nodbDirty, lastError, unsaved: pending + saving + failed > 0 || nodbDirty };
  };
  const changed = () => { try { onChange(status()); } catch (_e) { /* UI-обробник не ламає чергу */ } };

  const clearTimers = (e) => {
    if (e.timer != null) { timers.clearTimeout(e.timer); e.timer = null; }
    if (e.retryTimer != null) { timers.clearTimeout(e.retryTimer); e.retryTimer = null; }
  };

  function send(k) {
    const e = entries.get(k);
    if (!e) return Promise.resolve(true);
    clearTimers(e);
    if (e.inflight) {
      // Запит у польоті: позначаємо «ще раз після нього» (його обробник сам перевідправить).
      e.dirty = true;
      return e.inflight.then(() => { const cur = entries.get(k); return cur && cur.inflight ? cur.inflight : true; });
    }
    e.dirty = false;
    let payload;
    try { payload = e.getPayload(); } catch (_err) { payload = null; }
    if (payload == null) { entries.delete(k); changed(); return Promise.resolve(false); }
    const p = Promise.resolve().then(() => save(e.id, payload)).then(
      (res) => {
        e.inflight = null;
        if (res && res.db === false) { nodb = true; if (!res.memory) nodbDirty = true; }
        e.error = null; e.attempts = 0;
        if (entries.get(k) !== e) return true; // видалено під час польоту
        if (e.dirty) { send(k); return true; }
        entries.delete(k);
        if (![...entries.values()].some((x) => x.error)) lastError = null;
        changed();
        return true;
      },
      (err) => {
        e.inflight = null;
        if (entries.get(k) !== e) return false;
        e.error = err; lastError = err;
        if (e.dirty) { e.attempts = 0; send(k); return false; }
        const d = retryDelays[e.attempts];
        e.attempts++;
        if (d != null) e.retryTimer = timers.setTimeout(() => { e.retryTimer = null; send(k); }, d);
        changed();
        return false;
      },
    );
    e.inflight = p;
    changed();
    return p;
  }

  return {
    schedule(id, getPayload) {
      const k = key(id);
      let e = entries.get(k);
      if (!e) { e = { id, getPayload, timer: null, inflight: null, dirty: false, attempts: 0, error: null, retryTimer: null }; entries.set(k, e); }
      e.getPayload = getPayload;
      if (e.inflight) { e.dirty = true; changed(); return; }
      // Нова зміна після збою — нова серія спроб.
      if (e.error) { e.attempts = 0; }
      if (e.retryTimer != null) { timers.clearTimeout(e.retryTimer); e.retryTimer = null; }
      if (e.timer != null) timers.clearTimeout(e.timer);
      e.timer = timers.setTimeout(() => { e.timer = null; send(k); }, delay);
      changed();
    },
    flush(id) { return send(key(id)); },
    flushAll() { return Promise.all([...entries.keys()].map((k) => send(k))); },
    retryAll() {
      const ks = [...entries.entries()].filter(([, e]) => e.error && !e.inflight).map(([k]) => k);
      for (const k of ks) entries.get(k).attempts = 0;
      return Promise.all(ks.map((k) => send(k)));
    },
    async remove(id) {
      const k = key(id);
      const e = entries.get(k);
      if (e) {
        clearTimers(e);
        entries.delete(k);
        changed();
        if (e.inflight) await e.inflight.catch(() => {});
      }
      const res = await removeFn(id);
      if (res && res.db === false) { nodb = true; if (!res.memory) nodbDirty = true; changed(); }
      return res;
    },
    has(id) { return entries.has(key(id)); },
    status,
    setNoDb(v) { nodb = !!v; changed(); },
  };
}

// Текст і стан бейджа «Не збережено» (чиста функція від status()).
//   null → бейдж прихований. Без БД бейдж зʼявляється після першої незбереженої зміни
//   (сам факт «БД немає» показує індикатор здоровʼя в хедері).
export function badgeInfo(st) {
  if (!st) return null;
  if (st.nodb && st.nodbDirty) return { cls: 'nodb', text: '⚠ Не збережено', title: 'БД не підключена — зміни лише в памʼяті цієї вкладки і зникнуть після перезавантаження.', clickable: false };
  if (st.failed) {
    const msg = st.lastError && st.lastError.message ? ': ' + st.lastError.message : '';
    return { cls: 'error', text: '⚠ Не збережено · повторити', title: 'Не вдалося зберегти ' + st.failed + ' сценарій(ї)' + msg + '. Натисни, щоб повторити.', clickable: true };
  }
  if ((st.saving || st.pending) && !st.nodb) return { cls: 'saving', text: '● Зберігаю…', title: 'Зміни зберігаються в БД', clickable: false };
  return null;
}

// Payload для PUT: як pagePayload (без тимчасових полів), але БЕЗ кроків, що ще
// виконуються в живій сесії (pending:true) — вони або підтвердяться, або зникнуть.
export function savePayload(p) {
  return pagePayload({ ...p, recs: (p.recs || []).map((r) => ({ ...r, subs: (r.subs || []).filter((x) => !(x && x.pending)) })) });
}

// ---------- Екземпляр для UI ----------
const fetchJson = async (url, init) => parseJsonResponse(await globalThis.fetch(url, init));
let queue = null;
let badgeEl = null;

function getQueue() {
  if (!queue) {
    queue = createPersistQueue({
      save: (id, payload) => fetchJson('/pages/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
      remove: (id) => fetchJson('/pages/' + encodeURIComponent(id), { method: 'DELETE' }),
      onChange: (st) => {
        if (st.nodb && state.db !== false) state.db = false;
        renderBadge(st);
        emit('persist:status', st);
      },
    });
  }
  return queue;
}

export function persistStatus() { return getQueue().status(); }

// Запланувати збереження сценарію (payload — без тимчасових полів, у момент відправки).
export function persistPage(page) {
  if (!page || page.id == null) return;
  const id = page.id;
  getQueue().schedule(id, () => {
    const p = state.pages.find((x) => String(x.id) === String(id));
    return p ? savePayload(p) : null; // сценарій видалено — нічого не шлемо
  });
}
export function flushPage(page) { return page ? getQueue().flush(page.id) : Promise.resolve(true); }
export function deletePageRemote(id) { return getQueue().remove(id); }
export function markNoDb() { getQueue().setNoDb(true); }

// Бейдж у хедері (створюється тут — розмітку index.html не чіпаємо).
function ensureBadge() {
  if (badgeEl || typeof document === 'undefined') return badgeEl;
  const header = document.querySelector('.app-header');
  if (!header) return null;
  badgeEl = document.createElement('button');
  badgeEl.type = 'button';
  badgeEl.id = 'saveBadge';
  badgeEl.className = 'save-badge';
  badgeEl.hidden = true;
  badgeEl.setAttribute('aria-live', 'polite');
  badgeEl.addEventListener('click', () => { if (badgeEl.dataset.clickable === '1') getQueue().retryAll(); });
  const chip = document.getElementById('hdrConfigChip');
  header.insertBefore(badgeEl, chip || null);
  return badgeEl;
}

function renderBadge(st) {
  const el = ensureBadge();
  if (!el) return;
  const info = badgeInfo(st);
  if (!info) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'save-badge ' + info.cls;
  el.textContent = info.text;
  el.title = info.title;
  el.setAttribute('aria-label', info.title);
  el.dataset.clickable = info.clickable ? '1' : '0';
  el.disabled = !info.clickable;
}

export function initPersist() {
  const q = getQueue();
  ensureBadge();
  if (state.db === false) q.setNoDb(true);
  // Інші модулі (рекордер) можуть просити зберегти через шину: emit('persist', page).
  on('persist', (page) => persistPage(page));
  // Перед закриттям вкладки — відправляємо відкладене (keepalive, щоб запит не обірвався).
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      for (const p of state.pages) {
        if (!q.has(p.id)) continue;
        try {
          globalThis.fetch('/pages/' + encodeURIComponent(p.id), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savePayload(p)), keepalive: true,
          });
        } catch (_e) { /* best effort */ }
      }
    });
  }
  renderBadge(q.status());
}
