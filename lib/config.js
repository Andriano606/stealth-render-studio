// Конфіг застосунку: константи + змінні оточення в одному місці.
// Чиста функція (без побічних ефектів) — легко тестувати з будь-яким env.
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Корінь проєкту (тека з server.js) — щоб public/ знаходився незалежно від cwd.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

// Користувач ОС для дефолтного рядка підключення (libpq-стиль), без хардкоду імені.
function osUser() {
  try { return os.userInfo().username; } catch (_e) { return process.env.USER || 'postgres'; }
}

// env — обʼєкт оточення (process.env), cwd — база для відносних шляхів.
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const port = Number(env.PORT);
  return {
    PORT: Number.isInteger(port) && port > 0 ? port : 3000,
    // Інтерфейс прослуховування: за замовчуванням ЛИШЕ локальний (127.0.0.1). Доступ із
    // мережі — явне HOST=0.0.0.0 + ALLOWED_HOSTS=<ім'я/IP через кому> (Host-захист).
    HOST: env.HOST || '127.0.0.1',
    ALLOWED_HOSTS: String(env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    DB_URL: env.DATABASE_URL || ('postgres://' + osUser() + '@localhost:5432/playwright_demo'),
    PROFILE_FILE: path.resolve(cwd, env.PROFILE_FILE || 'profile.json'),
    UPLOAD_DIR: path.resolve(cwd, env.UPLOAD_DIR || 'uploads'),
    PUBLIC_DIR: path.join(PROJECT_ROOT, 'public'),
    POOL_SIZE: 3,              // скільки прогрітих контекстів тримати напоготові
    MAX_CONCURRENT: 6,         // ліміт одночасних рендерів, щоб не покласти машину
    MAX_UPLOAD_BYTES: 200 * 1024 * 1024, // 200 МБ — запобіжник для /upload
    JSON_LIMIT: '2mb',         // файли йдуть стрімом через /upload, тож JSON маленький
    IMPORT_JSON_LIMIT: '20mb', // POST /import: бандл сценаріїв (файли клієнт уже завантажив через /upload)
    EXPORT_FILES_MAX_BYTES: 50 * 1024 * 1024, // GET /export: сумарний ліміт вкладених файлів кроків (base64)
  };
}
