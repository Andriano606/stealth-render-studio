// Сховище живих сесій запису (SessionStore) — чиста логіка з інʼєкцією годинника.
// Нічого не знає про браузер: закриття ресурсів сесії робить s.dispose(reason)
// (його ставить lib/live.js) або інʼєктований closer.
//
// Правила (synth.md §4 «Session lifecycle»):
//   • не більше max сесій (2). Якщо місця немає — закриваємо НАЙСТАРШУ за
//     простоєм, якщо вона простоює > evictIdleMs (60 с) і нічого не виконує;
//     інакше 429 {code:'too_many_sessions'};
//   • стани: 'prefix' (відкривається / відтворює префікс) → 'ready' → 'closed';
//     run(sid, fn) поки 'prefix' → 409 {code:'session_busy'};
//   • run(sid, fn) — ланцюг промісів на сесію: дії однієї сесії виконуються
//     строго по черзі, у порядку надходження;
//   • закрита/невідома сесія → 410 {code:'session_closed', reason}; причини
//     («надгробки») тримаємо tombstoneMs (10 хв);
//   • sweep() закриває сесії, що простоюють > idleMs (5 хв), і чистить старі надгробки;
//     start() запускає його на unref-таймері кожні sweepMs (30 с);
//   • кожен виклик run має межу часу (timeoutMs, дефолт actTimeoutMs 90 с; Infinity —
//     без межі): зависла дія (сторінка заблокувала головний потік, Playwright-виклики
//     без таймауту) ЗАКРИВАЄ сесію — dispose контексту відхиляє завислі виклики, слот
//     і контекст звільняються, а відповідь — 504 {code:'act_timeout'}. sweep() теж
//     закриває зайняту сесію, якщо її поточна дія давно пережила свою межу;
//   • черга сесії обмежена maxQueue (20) → 429 {code:'session_queue_full'}.

export const SESSION_DEFAULTS = Object.freeze({
  max: 2,
  idleMs: 300000,
  evictIdleMs: 60000,
  tombstoneMs: 600000,
  sweepMs: 30000,
  actTimeoutMs: 90000,
  maxQueue: 20,
});

// Помилка з HTTP-статусом і тілом (errorHandler домішує body у відповідь).
export function sessionError(status, code, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.body = { code, ...extra };
  return e;
}

function defaultNewId() {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = 'ls_';
  for (let i = 0; i < 12; i++) s += abc[Math.floor(Math.random() * 36)];
  return s;
}

export function createSessionStore(opts = {}) {
  const o = { ...SESSION_DEFAULTS, ...opts };
  const now = opts.now || (() => Date.now());
  const newId = opts.newId || defaultNewId;
  const log = opts.log || console;
  const closer = opts.closer || (async (s, reason) => { if (typeof s.dispose === 'function') await s.dispose(reason); });
  // Таймер межі дії (інʼєкція для тестів із фейковим годинником).
  const setTimer = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; });
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  const sessions = new Map();   // sid → Session
  const tombstones = new Map(); // sid → { reason, at }
  let timer = null;

  const closedError = (sid) => {
    const t = tombstones.get(sid);
    const reason = t ? t.reason : 'невідома сесія (сервер перезапущено або вже закрито)';
    return sessionError(410, 'session_closed', 'Сесію закрито: ' + reason, { reason });
  };

  // Найстарша за простоєм сесія, яку можна витіснити (простій > evictIdleMs і не зайнята).
  function evictable() {
    let best = null;
    for (const s of sessions.values()) {
      if (s.busy > 0 || s.state === 'prefix') continue;
      if (now() - s.lastSeen <= o.evictIdleMs) continue;
      if (!best || s.lastSeen < best.lastSeen) best = s;
    }
    return best;
  }

  // Створює сесію в стані 'prefix'. fields — довільні дані (engine, profileSig…).
  // Якщо ліміт вичерпано — витісняє найстаршу простійну, інакше кидає 429.
  async function create(fields = {}) {
    let victim = null;
    if (sessions.size >= o.max) {
      victim = evictable();
      if (!victim) {
        throw sessionError(429, 'too_many_sessions',
          'Забагато живих сесій (' + o.max + '). Закрий іншу сесію запису або зачекай.');
      }
      // Синхронно звільняємо місце (щоб паралельний create не перевищив ліміт),
      // ресурси жертви закриваємо нижче.
      detach(victim.sid, 'витіснено новою сесією (ліміт ' + o.max + ')');
    }
    let sid = newId();
    while (sessions.has(sid) || tombstones.has(sid)) sid = newId();
    const t = now();
    const s = {
      ...fields,
      sid,
      state: 'prefix',
      chain: Promise.resolve(),
      busy: 0,
      pending: { chooser: null, select: null },
      createdAt: t,
      lastSeen: t,
    };
    sessions.set(sid, s);
    if (victim) await runCloser(victim);
    return s;
  }

  // Жива сесія (оновлює lastSeen) або null.
  function get(sid) {
    const s = sessions.get(sid);
    if (!s) return null;
    s.lastSeen = now();
    return s;
  }

  // Жива сесія або 410 з причиною.
  function require(sid) {
    const s = get(sid);
    if (!s) throw closedError(sid);
    return s;
  }

  function markReady(sid) {
    const s = sessions.get(sid);
    if (s && s.state === 'prefix') { s.state = 'ready'; s.lastSeen = now(); }
    return s || null;
  }

  // fn(s) з межею часу: по закінченні — закрити сесію (dispose відхилить завислі
  // Playwright-виклики, ланцюг розмотається) і відхилити 504 act_timeout.
  function runWithDeadline(s, fn, timeoutMs) {
    const limited = Number.isFinite(timeoutMs) && timeoutMs > 0;
    s.actStartedAt = now();
    s.actDeadline = limited ? s.actStartedAt + timeoutMs : Infinity;
    const work = Promise.resolve().then(() => fn(s));
    const clear = () => { s.actStartedAt = null; s.actDeadline = null; };
    if (!limited) return work.finally(clear);
    let timer = null;
    const expired = new Promise((_r, reject) => {
      timer = setTimer(() => {
        const secs = Math.round(timeoutMs / 1000);
        const reason = 'дія зависла (> ' + secs + ' с) — сесію закрито';
        close(s.sid, reason).catch(() => {});
        reject(sessionError(504, 'act_timeout', 'Дія не завершилась за ' + secs + ' с — сесію закрито', { reason }));
      }, timeoutMs);
    });
    return Promise.race([work, expired]).finally(() => { clearTimer(timer); clear(); });
  }

  // Виконує fn(s) у черзі сесії. 410 — закрита/невідома; 409 — ще відкривається;
  // 429 — черга переповнена; 504 — дія не вклалась у timeoutMs (сесію закрито).
  // opts.allowPrefix — дозволити під час 'prefix' (для внутрішніх викликів).
  function run(sid, fn, { allowPrefix = false, timeoutMs = o.actTimeoutMs } = {}) {
    const s = sessions.get(sid);
    if (!s) return Promise.reject(closedError(sid));
    if (s.state === 'prefix' && !allowPrefix) {
      return Promise.reject(sessionError(409, 'session_busy', 'Сесія ще відкривається (відтворюю префікс) — зачекай'));
    }
    if (s.busy >= o.maxQueue) {
      return Promise.reject(sessionError(429, 'session_queue_full', 'Забагато дій у черзі сесії (' + o.maxQueue + ') — зачекай'));
    }
    s.lastSeen = now();
    s.busy++;
    const p = s.chain.then(async () => {
      if (s.state === 'closed') throw closedError(sid);
      try { return await runWithDeadline(s, fn, timeoutMs); } catch (e) {
        // Сесію закрили посеред дії (DELETE/⏹ Готово) → «сирий» Playwright-збій
        // («Target page, context or browser has been closed») — це 410, а не 500.
        if (s.state === 'closed' && !(e && e.status)) throw closedError(sid);
        throw e;
      }
    });
    // Ланцюг не рветься на помилці: наступна дія виконується попри збій попередньої.
    s.chain = p.then(() => {}, () => {}).then(() => { s.busy--; s.lastSeen = now(); });
    return p;
  }

  // Закриває сесію (ідемпотентно). Причину зберігаємо для 410.
  function detach(sid, reason) {
    const s = sessions.get(sid);
    if (!s) return null;
    sessions.delete(sid);
    s.state = 'closed';
    s.closeReason = reason;
    tombstones.set(sid, { reason, at: now() });
    return s;
  }
  async function runCloser(s) {
    try { await closer(s, s.closeReason); } catch (e) { log.error('Закриття сесії ' + s.sid + ':', e && e.message); }
  }
  async function close(sid, reason = 'закрито') {
    const s = detach(sid, reason);
    if (!s) return false;
    await runCloser(s);
    return true;
  }

  async function closeAll(reason = 'закрито') {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map((sid) => close(sid, reason)));
    return ids.length;
  }

  // Закриває простійні сесії (> idleMs), зайняті з дією, що давно пережила свою
  // межу (запобіжник, якщо таймер межі загубився), і чистить старі надгробки.
  async function sweep() {
    const t = now();
    const idle = [...sessions.values()].filter((s) => s.busy === 0 && s.state !== 'prefix' && t - s.lastSeen > o.idleMs);
    const hung = [...sessions.values()].filter((s) => s.busy > 0 && Number.isFinite(s.actDeadline) && t > s.actDeadline + o.sweepMs);
    for (const s of idle) await close(s.sid, 'простій понад ' + Math.round(o.idleMs / 60000) + ' хв');
    for (const s of hung) await close(s.sid, 'дія зависла — сесію закрито');
    for (const [sid, tb] of tombstones) if (t - tb.at > o.tombstoneMs) tombstones.delete(sid);
    return idle.length + hung.length;
  }

  function reasonOf(sid) {
    const t = tombstones.get(sid);
    return t ? t.reason : null;
  }

  function start(intervalMs = o.sweepMs) {
    if (timer) return;
    timer = setInterval(() => { sweep().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    closedError, create, get, require, run, markReady, close, closeAll, sweep, reasonOf, start, stop,
    get size() { return sessions.size; },
    get max() { return o.max; },
    list() { return [...sessions.values()]; },
  };
}
