// api.js — усі HTTP-виклики до бекенду в одному місці.
//   createApi(fetchImpl) → { getPages, savePage, deletePage, getProfile, postProfile,
//                            getPresets, createPreset, updatePreset, deletePreset, renamePreset, upload, replay, stopReplay,
//                            importBundle }  (експорт бандла — GET-посилання, див. transfer.js exportHref)
//   api                  — екземпляр на глобальному fetch (для UI).
//   readNdjson / streamNdjson — читач NDJSON-стріму (/replay, згодом /live) з AbortController.
//   ApiError             — не-2xx відповідь: message з тіла {error}, status, body.
//   createSerialSaver    — послідовне збереження по ключу зі злиттям (нові PUT не обганяють старі).
// Контракти — routes/*.js (вони авторитетні). Без DOM під час імпорту.

export class ApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// Відповідь → JSON; не-2xx → ApiError з повідомленням сервера (або «HTTP 503»).
export async function parseJsonResponse(r) {
  let body = null;
  const text = await r.text().catch(() => '');
  if (text) { try { body = JSON.parse(text); } catch (_e) { body = null; } }
  if (!r.ok) {
    const msg = (body && (body.error || body.message)) || ('HTTP ' + r.status + (text && !body ? ': ' + text.slice(0, 200) : ''));
    throw new ApiError(msg, { status: r.status, body });
  }
  return body == null ? {} : body;
}

// Інкрементальний розбір NDJSON: push(шматок тексту) викликає onEvent на кожен
// повний рядок; end() — на хвіст без '\n'. Битий рядок → onEvent({event:'parse-error', line}).
export function createNdjsonParser(onEvent) {
  let buf = '';
  const emitLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line); } catch (_e) { ev = { event: 'parse-error', line }; }
    onEvent(ev);
  };
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); emitLine(l); }
    },
    end() { const l = buf; buf = ''; emitLine(l); },
  };
}

// Читає ReadableStream (body відповіді) як NDJSON. signal.abort → reader.cancel() і
// відхилення з AbortError.
export async function readNdjson(body, onEvent, { signal } = {}) {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parser = createNdjsonParser(onEvent);
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(dec.decode(value, { stream: true }));
    }
    parser.push(dec.decode());
    parser.end();
    if (signal && signal.aborted) throw abortError();
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function abortError() {
  try { return new DOMException('Перервано', 'AbortError'); } catch (_e) { const e = new Error('Перервано'); e.name = 'AbortError'; return e; }
}

// POST JSON → NDJSON-стрім. Не-2xx (400/409/429/503 до початку стріму) → ApiError.
export async function streamNdjson(fetchImpl, url, payload, onEvent, { signal } = {}) {
  const r = await fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  if (!r.ok) await parseJsonResponse(r); // кидає ApiError
  await readNdjson(r.body, onEvent, { signal });
}

export function createApi(fetchImpl = (...a) => globalThis.fetch(...a)) {
  // timeoutMs — запит перериваємо з зрозумілою помилкою, а не «крутимось» вічно.
  const json = async (url, { method = 'GET', body, headers, timeoutMs } = {}) => {
    const init = { method, headers: { ...(headers || {}) } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    let timer = null;
    if (timeoutMs) {
      const ac = new AbortController();
      init.signal = ac.signal;
      timer = setTimeout(() => ac.abort(), timeoutMs);
    }
    try {
      return await parseJsonResponse(await fetchImpl(url, init));
    } catch (e) {
      if (timeoutMs && init.signal && init.signal.aborted) {
        const err = new Error('сервер не відповів за ' + Math.round(timeoutMs / 1000) + ' с');
        err.timeout = true;
        throw err;
      }
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    getPages: () => json('/pages'),
    savePage: (id, payload) => json('/pages/' + encodeURIComponent(id), { method: 'PUT', body: payload }),
    deletePage: (id) => json('/pages/' + encodeURIComponent(id), { method: 'DELETE' }),
    getProfile: () => json('/profile'),
    // Перезапуск браузера на холодному диску може бути довгим — даємо 3 хв.
    postProfile: (patch) => json('/profile', { method: 'POST', body: patch, timeoutMs: 180000 }),
    getPresets: () => json('/presets'),
    createPreset: (name, body) => json('/presets', { method: 'POST', body: { name, body } }),
    updatePreset: (id, body) => json('/presets/' + encodeURIComponent(id), { method: 'PUT', body: { body } }),
    deletePreset: (id) => json('/presets/' + encodeURIComponent(id), { method: 'DELETE' }),
    renamePreset: (id, name) => json('/presets/' + encodeURIComponent(id), { method: 'PUT', body: { name } }),
    // Файл — бінарним стрімом (без base64 у памʼяті), імʼя — у заголовку x-filename.
    upload: async (file) => parseJsonResponse(await fetchImpl('/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    })),
    // /replay: перша подія {event:'run', runId}; далі log/status/opened/action/done-action/done|error.
    replay: (body, onEvent, opts) => streamNdjson(fetchImpl, '/replay', body, onEvent, opts),
    stopReplay: (runId) => json('/replay/' + encodeURIComponent(runId) + '/stop', { method: 'POST', body: {} }),
    // POST /import {bundle (без files[].data), select, onConflict, dryRun} → {ok, presets, scenarios, warnings, summary}.
    importBundle: (payload) => json('/import', { method: 'POST', body: payload, timeoutMs: 120000 }),
  };
}

export const api = createApi();

// Послідовне збереження по ключу: поки попереднє збереження ключа летить, нові
// виклики зливаються в ОДНЕ наступне (з найсвіжішими даними — task() читає стан
// у момент відправки). Повертає проміс завершення збереження, що покриває виклик.
// onError(err, key) — для показу «не збережено».
export function createSerialSaver({ onError = () => {}, onSaved = () => {} } = {}) {
  const slots = new Map(); // key → {running: Promise|null, pending: {task, promise, resolve}|null}
  const runTask = (key, task) => {
    const slot = slots.get(key);
    const p = Promise.resolve().then(task).then(
      (res) => { onSaved(res, key); return true; },
      (err) => { onError(err, key); return false; },
    ).then((ok) => {
      if (slot.pending) {
        const next = slot.pending; slot.pending = null;
        slot.running = runTask(key, next.task);
        slot.running.then(next.resolve);
      } else {
        slot.running = null;
        slots.delete(key);
      }
      return ok;
    });
    return p;
  };
  return {
    save(key, task) {
      let slot = slots.get(key);
      if (!slot) { slot = { running: null, pending: null }; slots.set(key, slot); }
      if (!slot.running) { slot.running = runTask(key, task); return slot.running; }
      if (slot.pending) { slot.pending.task = task; return slot.pending.promise; }
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      slot.pending = { task, promise, resolve };
      return promise;
    },
    get busy() { return slots.size > 0; },
  };
}
