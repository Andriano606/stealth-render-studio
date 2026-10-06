// Postgres: схема + репозиторії (pages / recordings / presets) + засів пресетів.
// Якщо БД недоступна — initDb() повертає null, і застосунок працює в пам'яті
// (сценарії — у памʼяті процесу, див. routes/pages.js). Імпорт модуля нічого не підключає.
import pg from 'pg';

// Вбудовані пресети конфігуратора (засіваються в порожню таблицю).
export const BUILTIN_PRESETS = [
  { name: '🧹 Clear all', pos: 2, body: { clear: true } },
  { name: '☁️ Cloudflare', pos: 3, body: { launch: { engine: 'camoufox', camoufoxHumanize: false, camoufoxGeoip: false } } },
  { name: '📋 Ashby', pos: 4, body: {
    launch: { engine: 'chromium', headless: true, newHeadless: true, automationControlled: true, realGpu: true, siteIsolationDisabled: true, stealthPlugin: true, persistent: false },
    stealth: { webdriver: true, windowChrome: true, outerWindow: true, permissions: true, pwInitScripts: true },
    behavior: { humanize: true, prepareScroll: true },
  } },
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS recordings (
    id          BIGINT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    subs        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS pages (
    id          BIGINT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    recs        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Пресети конфігуратора (набори налаштувань).
  `CREATE TABLE IF NOT EXISTS presets (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    body        JSONB NOT NULL DEFAULT '{}'::jsonb,
    builtin     BOOLEAN NOT NULL DEFAULT false,
    pos         INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Службові прапорці (напр. «вбудовані пресети вже засіяно» — щоб видалені не поверталися).
  `CREATE TABLE IF NOT EXISTS app_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  )`,
];

const withNumId = (rows) => rows.map((r) => ({ ...r, id: Number(r.id) }));

// Репозиторії над будь-яким обʼєктом з методом query(sql, params) (pg.Pool або фейк).
export function createRepos(q) {
  return {
    pages: {
      async list() {
        const { rows } = await q.query('SELECT id, name, url, recs FROM pages ORDER BY id ASC');
        return withNumId(rows);
      },
      async upsert(id, { name, url, recs }) {
        await q.query(
          `INSERT INTO pages (id, name, url, recs, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET name = $2, url = $3, recs = $4::jsonb, updated_at = now()`,
          [id, name || ('Сторінка ' + id), url || '', JSON.stringify(recs || [])]
        );
      },
      async remove(id) { await q.query('DELETE FROM pages WHERE id = $1', [id]); },
    },
    // legacy: стара пласка модель Дій (лишено для сумісності)
    recordings: {
      async list() {
        const { rows } = await q.query('SELECT id, name, url, subs FROM recordings ORDER BY id ASC');
        return withNumId(rows);
      },
      async upsert(id, { name, url, subs }) {
        await q.query(
          `INSERT INTO recordings (id, name, url, subs, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET name = $2, url = $3, subs = $4::jsonb, updated_at = now()`,
          [id, name || ('Дія ' + id), url || '', JSON.stringify(subs || [])]
        );
      },
      async remove(id) { await q.query('DELETE FROM recordings WHERE id = $1', [id]); },
    },
    presets: {
      async list() {
        const { rows } = await q.query('SELECT id, name, body, builtin FROM presets ORDER BY pos ASC, id ASC');
        return withNumId(rows);
      },
      async create({ name, body }) {
        const { rows } = await q.query(
          'INSERT INTO presets (name, body, builtin, pos) VALUES ($1, $2::jsonb, false, 100) RETURNING id',
          [name || 'Новий пресет', JSON.stringify(body || {})]
        );
        return Number(rows[0].id);
      },
      // → true, якщо пресет знайдено й оновлено.
      async update(id, { name, body }) {
        const r = await q.query(
          `UPDATE presets SET
             name = COALESCE($2, name),
             body = COALESCE($3::jsonb, body),
             updated_at = now()
           WHERE id = $1
           RETURNING id`,
          [id, name ?? null, body === undefined ? null : JSON.stringify(body)]
        );
        return !!(r && r.rows && r.rows.length);
      },
      // Будь-який пресет, і вбудований теж (засівання одноразове — видалений не повернеться).
      // → true, якщо щось видалено.
      async remove(id) {
        const r = await q.query('DELETE FROM presets WHERE id = $1 RETURNING id', [id]);
        return !!(r && r.rows && r.rows.length);
      },
    },
  };
}

// Засіває вбудовані пресети ОДИН раз за життя БД (прапорець app_meta.presets_seeded),
// і лише в порожню таблицю. Без прапорця видалення всіх пресетів повертало б вбудовані
// після перезапуску. Наявна БД із пресетами просто отримує прапорець.
export async function seedPresets(q, log = console) {
  const meta = await q.query("SELECT value FROM app_meta WHERE key = 'presets_seeded'");
  if (meta.rows && meta.rows.length) return false;
  const { rows } = await q.query('SELECT COUNT(*)::int AS n FROM presets');
  const empty = rows[0].n === 0;
  if (empty) {
    for (const p of BUILTIN_PRESETS) {
      await q.query('INSERT INTO presets (name, body, builtin, pos) VALUES ($1, $2::jsonb, true, $3)', [p.name, JSON.stringify(p.body), p.pos]);
    }
    log.log('Вбудовані пресети засіяно.');
  }
  await q.query("INSERT INTO app_meta (key, value) VALUES ('presets_seeded', '1') ON CONFLICT (key) DO NOTHING");
  return empty;
}

// Транзакція на ОДНОМУ клієнті пулу: fn(repos) → результат; збій → ROLLBACK і помилка далі.
// (Імпорт бандла пише багато рядків — частковий імпорт після збою посередині не лишається.)
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(createRepos(client));
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Ховає пароль у рядку підключення для логів.
export const redactDbUrl = (url) => String(url).replace(/(\/\/[^:/@]+):[^@]*@/, '$1:***@');

// Підключається, створює таблиці, засіває пресети. Повертає { pool, ...repos, tx, end }
// або null, якщо БД недоступна.
export async function initDb(url, { log = console, Pool = pg.Pool } = {}) {
  const pool = new Pool({ connectionString: url });
  // Помилка простою клієнта (напр. рестарт Postgres) не повинна валити процес.
  if (typeof pool.on === 'function') pool.on('error', (e) => log.error('Postgres pool error:', e.message));
  try {
    for (const sql of SCHEMA) await pool.query(sql);
    await seedPresets(pool, log);
    log.log('Postgres підключено (' + redactDbUrl(url) + '), таблиці recordings/pages/presets готові.');
    return { pool, ...createRepos(pool), tx: (fn) => withTransaction(pool, fn), end: () => pool.end() };
  } catch (e) {
    await pool.end().catch(() => {});
    log.log('БД недоступна (' + e.message + ') — Дії лише в пам\'яті.');
    return null;
  }
}
