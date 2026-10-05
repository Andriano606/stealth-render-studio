// state.js — центральне сховище стану UI + проста шина подій (без DOM під час імпорту —
// тестується в node:test).
//
// state — один обʼєкт:
//   pages, pageCounter, recCounter, db      — сценарії (scenarios.js; db: true/false після GET /pages);
//   screens, activeScreenId, screenSeq      — таби результатів (viewer.js);
//   running, run                            — прогін ▶ (runner.js): run = {pageId, runId, ac, stopping, plan, startedAt};
//   recording, curPage, curRec, live        — живий запис (recorder.js): live = {phase:'opening'|'live'|'closed',
//                                             sid, engine, paused, waitNext, pageId, recId} або null;
//   health                                  — останній GET /health (app.js) або {ok:false, error}; null до першого.
// Кроки, що ще виконуються в живій сесії, лежать у rec.subs з pending:true (+ status:'running');
// вони не зберігаються (pagePayload / persist.savePayload їх відкидають).
//
// Події (on(evt, fn) / emit(evt, payload)):
//   'pages'          — змінилась модель сценаріїв або прапорці → перемалювати сайдбар (батч на кадр);
//   'screens'        — змінились скріни/активний таб → перемалювати переглядач;
//   'screens:added'  — {id, status} новий скрін (бейдж «Перегляд» на мобільному);
//   'busy'           — змінились running/recording (кнопки, health, перемикання панелі);
//   'live'           — змінився state.live;
//   'page:changed'   — {page, pageId, reason} сценарій змінено поза сайдбаром (рекордер:
//                      'live-step'|'undo'|'new-rec'|'finish') → scenarios.js → persist.js (debounce);
//   'persist'        — emit('persist', page): коротка форма того самого;
//   'persist:status' — {pending, saving, failed, nodb, nodbDirty, lastError, unsaved} черги збереження;
//   'run:finished'   — {page, summary} після прогону (runner.summarizeRun);
//   'health'         — оновився state.health;
//   'ui:pane'        — emit('ui:pane', 'scenarios'|'viewer'|'logs'): на вузькому екрані перемкнути панель;
//   'log'            — {kind} кожного рядка логу (лічильники/бейджі).
// storage — безпечні обгортки над localStorage (приватний режим/без сховища не падає).
// createExpandStore — памʼять «згорнуто/розгорнуто» для Сценаріїв і Дій.

export const state = {
  pages: [],          // [{id,name,url,expanded,running,lastRun,recs:[{id,name,subs,expanded,isRecording,running,runCur,runTotal}]}]
  screens: [],        // [{id,label,src,owned,url,time,scenario,upto,total,failed,ok,stopped}]
  activeScreenId: null,
  screenSeq: 0,
  pageCounter: 0,
  recCounter: 0,
  running: false,
  recording: false,
  curPage: null,      // Сценарій, у який записуємо
  curRec: null,       // Дія, яку зараз записуємо
  run: null,          // див. вище
  db: null,           // true/false після завантаження /pages
  live: null,         // див. вище
  health: null,       // див. вище
};

export const isBusy = () => state.running || state.recording;

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload); } catch (e) { console.error('[state] обробник «' + evt + '» впав:', e); }
  }
}

// ---------- localStorage (безпечно) ----------
function ls() { try { return globalThis.localStorage || null; } catch (_e) { return null; } }
export const storage = {
  get(k) { try { const s = ls(); return s ? s.getItem(k) : null; } catch (_e) { return null; } },
  set(k, v) { try { const s = ls(); if (s) s.setItem(k, String(v)); } catch (_e) { /* квота/приватний режим */ } },
  remove(k) { try { const s = ls(); if (s) s.removeItem(k); } catch (_e) { /* */ } },
};

// Памʼять розгортання: {p: {pageId: bool}, r: {recId: bool}} у ключі key.
export function createExpandStore(st = storage, key = 'expandState') {
  let data = {};
  try { data = JSON.parse(st.get(key) || '{}') || {}; } catch (_e) { data = {}; }
  if (!data.p || typeof data.p !== 'object') data.p = {};
  if (!data.r || typeof data.r !== 'object') data.r = {};
  return {
    get(kind, id, def) { const v = data[kind] && data[kind][id]; return v === undefined ? def : v; },
    set(kind, id, val) { data[kind][id] = val; st.set(key, JSON.stringify(data)); },
  };
}

