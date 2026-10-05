// live-client.js — HTTP-клієнт живої сесії запису (контракт — routes/live.js, lib/live.js).
// Без DOM під час імпорту; усе зовнішнє (fetch, таймери, видимість вкладки, sendBeacon,
// sessionStorage) інʼєктується → тестується в node:test (test/liveClient.test.js).
//
//   createLiveClient(opts) → {
//     open({url, actions, recId}, onStreamEvent, {signal}) — POST /live (NDJSON: log/status/action/
//         done-action…, кінець {event:'live'} або {event:'error'}) → подія live;
//     attach(sid, meta)        — повторне підключення після перезавантаження (GET /shot);
//     enqueueAct(body, meta)   — дія в черзі: ОДНА в польоті, до 10 очікують, сусідні scroll/text
//                                зливаються → {promise, merged, item};  act(body) → promise;
//     nav(action, url)         — goto/back/forward/reload (у тій самій черзі — порядок збережено);
//     inspect(x, y)            — «що під курсором», лише коли черга порожня (інакше null);
//     close()                  — DELETE /live/:sid (спершу дочікується опитування/inspect у польоті,
//                                ≤ 3 с — інакше вони ловили б 410/500 посеред закриття);
//                                beaconClose() — sendBeacon на pagehide;
//     whenIdle(ms)             — проміс «черга порожня»; setMeta(m) — метадані для reattach;
//     sid/hash/vp/url/title/engine/busy/closed.
//   }
//   onEvent(type, payload): 'snap' {shot?, hash, vp, url, title} | 'logs' [..] | 'config' bool |
//     'closed' {reason} | 'busy' bool | 'dropped' item | 'net' {error}.
// Опитування скриншота — кожні 1.5 с, ЛИШЕ коли вкладка видима і черга порожня, з ?h=<hash>
// (сервер віддає shot тільки якщо змінився). 410/504 → 'closed'; 409 (ще відкривається) і
// 429 «черга сервера» → повтор із паузою; sid зберігається в sessionStorage для reattach.
import { ApiError, parseJsonResponse, streamNdjson } from './api.js';
import { enqueueAct as enqueuePure, classifyLiveError } from './liveModel.js';

export const LIVE_STORE_KEY = 'liveSession';
export const POLL_MS = 1500;
export const MAX_QUEUE = 10;

function defaultStore() {
  const ss = () => { try { return globalThis.sessionStorage || null; } catch (_e) { return null; } };
  return {
    get(k) { try { const s = ss(); return s ? s.getItem(k) : null; } catch (_e) { return null; } },
    set(k, v) { try { const s = ss(); if (s) s.setItem(k, v); } catch (_e) { /* */ } },
    remove(k) { try { const s = ss(); if (s) s.removeItem(k); } catch (_e) { /* */ } },
  };
}

// Збережений запис сесії: {sid, pageId, recId, baseRecIds, engine, at} або null.
export function readSavedSession(store = defaultStore()) {
  try {
    const v = JSON.parse(store.get(LIVE_STORE_KEY) || 'null');
    return v && typeof v.sid === 'string' && v.sid ? v : null;
  } catch (_e) { return null; }
}

const closedError = (reason) => new ApiError('Сесію закрито: ' + (reason || 'закрито'), { status: 410, body: { code: 'session_closed', reason } });
const sleep = (setTimer, ms) => new Promise((r) => setTimer(r, ms));

export function createLiveClient({
  fetchImpl = (...a) => globalThis.fetch(...a),
  store = defaultStore(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  beacon = (url) => (globalThis.navigator && typeof globalThis.navigator.sendBeacon === 'function' ? globalThis.navigator.sendBeacon(url) : false),
  pollMs = POLL_MS,
  maxQueue = MAX_QUEUE,
  retryMs = 700,
  onEvent = () => {},
} = {}) {
  let sid = null, hash = null, vp = null, url = '', title = '', engine = null;
  let closed = false, closedReason = null, configChanged = false;
  let meta = {};
  let queue = [], inflight = null, seqK = 0;
  let pollT = null, pollBusy = false, inspectBusy = false;
  let pollP = null, inspectP = null; // запити в польоті (close() їх дочікується)
  let idleWaiters = [];

  const emit = (type, payload) => { try { onEvent(type, payload); } catch (e) { console.error('[live-client] ' + type, e); } };
  const enc = encodeURIComponent;
  const json = async (method, path, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    return parseJsonResponse(await fetchImpl(path, init));
  };

  const isBusy = () => !!inflight || queue.length > 0;
  let lastBusy = false;
  function busyChanged() {
    const b = isBusy();
    if (b !== lastBusy) { lastBusy = b; emit('busy', b); }
    if (!b && idleWaiters.length) { const w = idleWaiters; idleWaiters = []; w.forEach((fn) => fn(true)); }
  }

  function persist() {
    if (!sid) return;
    store.set(LIVE_STORE_KEY, JSON.stringify({ ...meta, sid, engine, at: Date.now() }));
  }

  // Відповідь сервера зі знімком (live/act/nav/shot) → стан клієнта + події.
  function handleSnap(res) {
    if (!res || typeof res !== 'object' || closed) return; // після close() — без застарілих кадрів
    if (res.hash) hash = res.hash;
    if (res.vp) vp = res.vp;
    if (res.url != null) url = res.url;
    if (res.title != null) title = res.title;
    emit('snap', { shot: res.shot, hash, vp, url, title });
    if (Array.isArray(res.logs) && res.logs.length) emit('logs', res.logs);
    if (res.configChanged != null && !!res.configChanged !== configChanged) {
      configChanged = !!res.configChanged;
      emit('config', configChanged);
    }
  }

  function markClosed(reason, { silent = false } = {}) {
    if (closed) return;
    closed = true;
    closedReason = reason || 'закрито';
    stopPolling();
    const err = closedError(closedReason);
    const q = queue; queue = [];
    for (const it of q) for (const w of it.waiters) w.reject(err);
    store.remove(LIVE_STORE_KEY);
    busyChanged();
    if (!silent) emit('closed', { reason: closedReason });
  }

  function handleError(err) {
    const c = classifyLiveError(err);
    if (c.kind === 'closed') markClosed(c.reason);
    else if (c.kind === 'network') emit('net', { error: err });
    return c;
  }

  // ---------- Черга ----------
  async function send(item) {
    const k = ++seqK;
    if (item.kind === 'nav') return json('POST', '/live/' + enc(sid) + '/nav', { ...item.body, h: hash });
    return json('POST', '/live/' + enc(sid) + '/act', { ...item.body, k, h: hash });
  }

  async function pump() {
    if (inflight || closed || !queue.length) return;
    const item = queue.shift();
    inflight = item;
    busyChanged();
    let res = null, err = null;
    for (let attempt = 0; ; attempt++) {
      try { res = await send(item); err = null; break; } catch (e) {
        err = e;
        const c = classifyLiveError(e);
        if ((c.kind === 'busy' || c.kind === 'queue') && attempt < 3 && !closed) { await sleep(setTimer, retryMs); continue; }
        break;
      }
    }
    inflight = null;
    if (err) {
      handleError(err);
      for (const w of item.waiters) w.reject(err);
    } else {
      handleSnap(res);
      for (const w of item.waiters) w.resolve(res);
    }
    busyChanged();
    pump();
  }

  function enqueue(kind, body, itemMeta) {
    if (!sid || closed) {
      const p = Promise.reject(closedError(closedReason || 'сесію не відкрито'));
      p.catch(() => {});
      return { promise: p, merged: false, item: null };
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const item = { kind, body, meta: itemMeta || null, waiters: [{ resolve, reject }] };
    const r = enqueuePure(queue, item, maxQueue);
    if (r.dropped) {
      emit('dropped', item);
      reject(new ApiError('Забагато дій у черзі (' + maxQueue + ') — зачекай', { status: 429, body: { code: 'client_queue_full' } }));
      return { promise, merged: false, item: null };
    }
    if (r.merged) r.item.waiters.push({ resolve, reject });
    queue = r.queue;
    busyChanged();
    pump();
    return { promise, merged: r.merged, item: r.item };
  }

  // ---------- Опитування ----------
  function schedulePoll(ms = pollMs) {
    if (pollT != null || closed || !sid) return;
    pollT = setTimer(tick, ms);
  }
  function stopPolling() { if (pollT != null) { clearTimer(pollT); pollT = null; } }
  async function tick() {
    pollT = null;
    if (closed || !sid) return;
    if (!isVisible() || isBusy() || pollBusy || inspectBusy) { schedulePoll(); return; }
    pollBusy = true;
    const mySid = sid;
    const req = json('GET', '/live/' + enc(mySid) + '/shot' + (hash ? '?h=' + enc(hash) : ''));
    pollP = req.catch(() => {});
    try {
      const res = await req;
      if (sid === mySid && !closed) handleSnap(res);
    } catch (e) {
      if (sid === mySid && !closed) handleError(e);
    } finally {
      pollBusy = false; pollP = null;
      schedulePoll();
    }
  }

  function reset() {
    stopPolling();
    sid = null; hash = null; vp = null; url = ''; title = ''; engine = null;
    closed = false; closedReason = null; configChanged = false; queue = []; inflight = null;
    lastBusy = false;
  }

  return {
    // POST /live → {event:'live', sid, engine, vp, shot, hash, url, title}. Помилка → ApiError.
    async open({ url: startUrl, actions = [], recId = null } = {}, onStreamEvent = () => {}, { signal, meta: m } = {}) {
      reset();
      meta = { ...(m || {}) };
      let liveEv = null, errEv = null;
      try {
        await streamNdjson(fetchImpl, '/live', { url: startUrl, actions, recId }, (ev) => {
          if (ev && ev.event === 'session' && ev.sid) { sid = ev.sid; persist(); }
          if (ev && ev.event === 'live') liveEv = ev;
          if (ev && ev.event === 'error') errEv = ev;
          onStreamEvent(ev);
        }, { signal });
      } catch (e) {
        // Відʼєднання під час префікса → сервер сам закриє сесію; тут лише прибираємо стан.
        store.remove(LIVE_STORE_KEY);
        sid = null; closed = true; closedReason = 'відкриття перервано';
        throw e;
      }
      if (!liveEv) {
        store.remove(LIVE_STORE_KEY);
        sid = null; closed = true; closedReason = errEv ? errEv.message : 'потік завершився без події live';
        if (errEv) throw new ApiError(errEv.message || 'Помилка відкриття', { status: errEv.status || (errEv.code === 'session_closed' ? 410 : 0), body: errEv });
        throw new ApiError('Сесію не відкрито: потік завершився без події live', { status: 0, body: null });
      }
      sid = liveEv.sid;
      engine = liveEv.engine || null;
      persist();
      handleSnap(liveEv);
      schedulePoll();
      return liveEv;
    },

    // Повторне підключення до сесії, що пережила перезавантаження сторінки.
    async attach(savedSid, m = {}) {
      reset();
      meta = { ...m };
      sid = savedSid;
      engine = m.engine || null;
      try {
        const res = await json('GET', '/live/' + enc(savedSid) + '/shot');
        handleSnap(res);
        persist();
        schedulePoll();
        return res;
      } catch (e) {
        const c = classifyLiveError(e);
        store.remove(LIVE_STORE_KEY);
        sid = null; closed = true; closedReason = c.reason || e.message;
        throw e;
      }
    },

    enqueueAct(body, itemMeta) { return enqueue('act', { rec: true, ...body }, itemMeta); },
    act(body, itemMeta) { return enqueue('act', { rec: true, ...body }, itemMeta).promise; },
    nav(action, navUrl) { return enqueue('nav', navUrl != null ? { action, url: navUrl } : { action }).promise; },

    async inspect(x, y) {
      if (!sid || closed || isBusy() || inspectBusy) return null;
      inspectBusy = true;
      const req = json('GET', '/live/' + enc(sid) + '/inspect?x=' + Math.round(x) + '&y=' + Math.round(y));
      inspectP = req.catch(() => {});
      try {
        return await req;
      } catch (e) { if (!closed) handleError(e); return null; } finally { inspectBusy = false; inspectP = null; }
    },

    // Оновити метадані для reattach (напр. «＋ Нова Дія» змінила recId).
    setMeta(m) { meta = { ...meta, ...(m || {}) }; persist(); },

    // Негайно опитати (напр. вкладка знову видима).
    poke() { if (!closed && sid) { stopPolling(); schedulePoll(0); } },

    whenIdle(ms = 15000) {
      if (!isBusy()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const fn = (v) => { clearTimer(t); resolve(v); };
        const t = setTimer(() => { idleWaiters = idleWaiters.filter((x) => x !== fn); resolve(false); }, ms);
        idleWaiters.push(fn);
      });
    },

    // Явне закриття клієнтом (⏹ Готово / ⟲): без події 'closed'.
    async close() {
      const s = sid;
      markClosed('закрито клієнтом', { silent: true });
      if (!s) return false;
      const inflightReqs = [pollP, inspectP].filter(Boolean);
      if (inflightReqs.length) await Promise.race([Promise.allSettled(inflightReqs), sleep(setTimer, 3000)]);
      try { await json('DELETE', '/live/' + enc(s)); return true; } catch (_e) { return false; }
    },

    // pagehide: sendBeacon (fetch на вивантаженні не гарантований). Запис у sessionStorage
    // лишаємо — після перезавантаження клієнт спробує attach (і отримає 410 з причиною, якщо закрито).
    beaconClose() {
      if (!sid || closed) return false;
      try { return !!beacon('/live/' + enc(sid) + '/close'); } catch (_e) { return false; }
    },

    get sid() { return sid; },
    get hash() { return hash; },
    get vp() { return vp; },
    get url() { return url; },
    get title() { return title; },
    get engine() { return engine; },
    get busy() { return isBusy(); },
    get closed() { return closed; },
    get closedReason() { return closedReason; },
    get configChanged() { return configChanged; },
    get queueLength() { return queue.length; },
  };
}
