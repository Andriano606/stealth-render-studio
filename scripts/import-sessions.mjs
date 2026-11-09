// Одноразове перенесення сесій входу з файлів (SESSIONS_DIR, ./sessions) у Postgres.
//   SESSIONS_DATABASE_URL=postgres://… node scripts/import-sessions.mjs [--force]
// Наявні в БД назви не перезаписуються (--force — перезаписати). Файли не змінюються й не видаляються.
// Виводить лише назви й кількість cookies — значення секретні.
import { loadConfig } from '../lib/config.js';
import { initSessionsDb } from '../lib/db.js';
import { createSavedSessions, sessionSummary, siteFromUrl } from '../lib/savedSessions.js';

const config = loadConfig();
const force = process.argv.includes('--force');
const repo = await initSessionsDb(config.SESSIONS_DB_URL || config.DB_URL);
if (!repo) { console.error('Postgres недоступний — нічого не перенесено.'); process.exit(1); }

let imported = 0, skipped = 0;
for (const s of createSavedSessions(config.SESSIONS_DIR).list()) {
  const n = sessionSummary(s.storageState).cookies;
  if (!force && await repo.get(s.name)) { skipped++; console.log('⏭ ' + s.name + ' — вже є в БД'); continue; }
  await repo.save({ ...s, site: s.site || siteFromUrl(s.url) || undefined, account: s.account || undefined, description: s.description || undefined });
  imported++;
  console.log('✅ ' + s.name + ' — ' + n + ' cookies');
}
console.log('Перенесено: ' + imported + ', пропущено: ' + skipped);
await repo.end();
