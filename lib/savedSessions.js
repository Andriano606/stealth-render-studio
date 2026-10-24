// Збережені сесії входу (MCP): storageState браузера (cookies + localStorage [+ IndexedDB]) під назвою.
// Користувач логіниться у видимому вікні (open_browser), Claude зберігає сесію (save_session), далі
// open_page / run_scenario / open_browser отримують `session: "назва"` → контекст з цим storageState.
// Файли — у SESSIONS_DIR (./sessions, gitignored): там СЕКРЕТИ (cookies входу), назовні їх не віддаємо —
// лише кількість і домени (sessionSummary).
// Чисті функції (validateSessionName, sessionFile, sessionSummary, mergeStorageState) — юніт-тестовані.
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

// Імʼя файлу: без регістру (назви «Gmail» і «gmail» — та сама сесія), безпечне для ФС (без «/», «..»).
export function sessionFile(name) {
  return encodeURIComponent(name.toLowerCase()).replace(/\./g, '%2E') + '.json';
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
    // rec: {name, storageState, url?, engine?} → збережений запис (перезаписує ту саму назву).
    save(rec) {
      const v = validateSessionName(rec && rec.name);
      if (v.error) throw new Error(v.error);
      const out = { name: v.name, savedAt: new Date().toISOString(), url: rec.url || null, engine: rec.engine || null, storageState: rec.storageState };
      fsImpl.mkdirSync(dir, { recursive: true });
      const file = fileOf(v.name);
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
