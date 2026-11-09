// Збережені сесії входу (MCP): storageState браузера (cookies + localStorage [+ IndexedDB]) під назвою +
// опис для агентів (account, site, description). Користувач логіниться у видимому вікні (open_browser),
// Claude зберігає сесію (save_session), далі будь-який агент: list_sessions → `session: "назва"`.
// Сховище — Postgres (lib/db.js: таблиця saved_sessions, спільна база SESSIONS_DATABASE_URL);
// без БД — файли у SESSIONS_DIR (createSessionVault обирає). Там СЕКРЕТИ (cookies входу), назовні їх
// не віддаємо — лише кількість і домени (sessionSummary).
// Чисті функції (validateSessionName, cleanSessionMeta, siteFromUrl, filterSessions, sessionFile,
// sessionSummary, mergeStorageState) — юніт-тестовані.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const SESSION_NAME_MAX = 80;

// Назва: рядок, пробіли стиснуто, 1..80 символів. → {name} або {error}.
export function validateSessionName(v) {
  if (typeof v !== 'string') return { error: 'назва сесії має бути рядком' };
  const name = v.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'назва сесії не може бути порожньою' };
  if (name.length > SESSION_NAME_MAX) return { error: 'назва сесії — до ' + SESSION_NAME_MAX + ' символів' };
  return { name };
}

// Ключ сесії: назви «Gmail» і «gmail» — та сама сесія.
export const sessionKey = (name) => String(name).toLowerCase();

// Опис для агентів: чий акаунт, який сайт, що варто знати. undefined — «не змінювати», '' — очистити.
export const SESSION_META_LIMITS = Object.freeze({ account: 120, site: 200, description: 1000 });
export function cleanSessionMeta(meta = {}) {
  const out = {};
  for (const [k, max] of Object.entries(SESSION_META_LIMITS)) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { error: k + ': очікується рядок' };
    const s = v.replace(/\s+/g, ' ').trim();
    if (s.length > max) return { error: k + ': до ' + max + ' символів' };
    out[k] = s;
  }
  return { meta: out };
}

// 'https://www.aliexpress.com/x' → 'aliexpress.com'; не http(s) → null.
export function siteFromUrl(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null;
  } catch (_e) { return null; }
}

// Пошук сесії агентом (підрядок без регістру). Домени cookies — лише якщо за назвою/акаунтом/сайтом/описом
// нічого немає: майже кожна сесія має cookies accounts.google.com, тож «google» інакше видавав би всі.
export function filterSessions(list, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return list;
  const has = (values) => values.some((x) => String(x || '').toLowerCase().includes(q));
  const direct = list.filter((r) => has([r.name, r.account, r.site, r.description]));
  return direct.length ? direct : list.filter((r) => has(sessionSummary(r.storageState).domains));
}

// Імʼя файлу: без регістру, безпечне для ФС (без «/», «..»). Ліміт ФС — 255 байт, а кирилична літера
// кодується 6-ма: довгі назви скорочуються, хеш тримає їх різними.
export function sessionFile(name) {
  const enc = encodeURIComponent(sessionKey(name)).replace(/\./g, '%2E');
  if (enc.length <= 250) return enc + '.json';
  const hash = crypto.createHash('sha1').update(sessionKey(name)).digest('hex').slice(0, 16);
  return enc.slice(0, 200).replace(/%[0-9A-F]?$/i, '') + '-' + hash + '.json';
}

// Без секретів: скільки cookies, з яких доменів, які origin мають localStorage.
export function sessionSummary(state) {
  const cookies = (state && Array.isArray(state.cookies)) ? state.cookies : [];
  const origins = (state && Array.isArray(state.origins)) ? state.origins : [];
  const domains = [...new Set(cookies.map((c) => String(c.domain || '').replace(/^\./, '')).filter(Boolean))].sort();
  return {
    cookies: cookies.length,
    domains,
    origins: origins.filter((o) => (o.localStorage && o.localStorage.length) || (o.indexedDB && o.indexedDB.length)).map((o) => o.origin),
  };
}

// Злиття storageState (для «додати сесію в cookies профілю»): cookie з тим самим name+domain+path і
// origin з тим самим адресом — перемагає b.
export function mergeStorageState(a, b) {
  const key = (c) => [c.name, c.domain, c.path || '/'].join('\u0001');
  const cookies = new Map();
  for (const c of (a && a.cookies) || []) cookies.set(key(c), c);
  for (const c of (b && b.cookies) || []) cookies.set(key(c), c);
  const origins = new Map();
  for (const o of (a && a.origins) || []) origins.set(o.origin, o);
  for (const o of (b && b.origins) || []) origins.set(o.origin, o);
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

export function createSavedSessions(dir, { fsImpl = fs } = {}) {
  const fileOf = (name) => path.join(dir, sessionFile(name));
  const read = (file) => { try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (_e) { return null; } };

  return {
    dir,
    list() {
      let files = [];
      try { files = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_e) { return []; }
      return files.map((f) => read(path.join(dir, f))).filter((s) => s && s.name && s.storageState)
        .sort((x, y) => String(x.name).localeCompare(String(y.name)));
    },
    get(name) {
      const v = validateSessionName(name);
      if (v.error) return null;
      const s = read(fileOf(v.name));
      return s && s.storageState ? s : null;
    },
    backend: () => 'files',
    // rec: {name, storageState, url?, engine?, account?, site?, description?} → збережений запис
    // (перезаписує ту саму назву; поле опису undefined — лишається попереднє).
    save(rec) {
      const v = validateSessionName(rec && rec.name);
      if (v.error) throw new Error(v.error);
      const file = fileOf(v.name);
      const prev = read(file) || {};
      const meta = (k) => (rec[k] !== undefined ? rec[k] : (prev[k] ?? null)) || null;
      const out = {
        name: v.name, savedAt: new Date().toISOString(), url: rec.url || null, engine: rec.engine || null,
        account: meta('account'), site: meta('site'), description: meta('description'), storageState: rec.storageState,
      };
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fsImpl.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 }); // cookies входу — лише власнику
      fsImpl.renameSync(tmp, file);
      return out;
    },
    remove(name) {
      const v = validateSessionName(name);
      if (v.error) return false;
      try { fsImpl.unlinkSync(fileOf(v.name)); return true; } catch (_e) { return false; }
    },
  };
}

// Єдиний вхід для тулів: Postgres, якщо підключено (getRepo() ≠ null), інакше файли. Лише одне джерело
// за раз: файли — не запасна копія (видалена в БД сесія не воскресне з файлу). Збій БД посеред роботи —
// помилка, а не тихий запис секретів деінде.
export function createSessionVault({ getRepo, files }) {
  const store = () => getRepo() || files;
  return {
    backend: () => (getRepo() ? 'postgres' : 'files'),
    list: async () => store().list(),
    get: async (name) => store().get(name),
    save: async (rec) => store().save(rec),
    remove: async (name) => store().remove(name),
  };
}
