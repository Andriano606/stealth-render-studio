// Тонка точка входу: конфіг → профіль → рушій → БД → HTTP.
// Уся логіка — у lib/*.js і routes/*.js (імпорти без побічних ефектів).
import fs from 'fs';
import { loadConfig } from './lib/config.js';
import { createProfileStore } from './lib/profile.js';
import { setupStealthPlugin } from './lib/stealth.js';
import { createEngine, defaultLaunchers } from './lib/engine.js';
import { createSemaphore } from './lib/semaphore.js';
import { initDb } from './lib/db.js';
import { createApp } from './lib/app.js';
import { createSessionStore } from './lib/session.js';

const config = loadConfig();
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

const profileStore = createProfileStore(config.PROFILE_FILE);
profileStore.load();

// Stealth-плагін підвантажуємо ОДРАЗУ при старті (усі evasions) — див. lib/stealth.js.
const stealthReady = setupStealthPlugin();
stealthReady.catch((e) => console.error('Stealth-плагін не підвантажено:', e.message));

const engine = createEngine({
  getProfile: () => profileStore.get(),
  launchers: defaultLaunchers({ getStealthChromium: () => setupStealthPlugin() }),
  poolSize: config.POOL_SIZE,
});
const sem = createSemaphore(config.MAX_CONCURRENT);
let db = null;

// Живі сесії запису: max 2, простій 5 хв, sweep кожні 30 с (unref-таймер).
const sessions = createSessionStore();
sessions.start();

const app = createApp({ config, engine, sem, profileStore, sessions, getDb: () => db });

// Лише локальний інтерфейс за замовчуванням (config.HOST = 127.0.0.1).
const server = app.listen(config.PORT, config.HOST, async () => {
  db = await initDb(config.DB_URL).catch((e) => { console.error('Помилка БД:', e.message); return null; });
  try {
    await engine.ensureEngine(); // 1) прогріваємо сам браузер (раз)
    await engine.refillPool();   // 2) заздалегідь готуємо пул контекстів зі сторінками
    console.log(`Пул готовий: ${engine.poolStats().ready} контекстів чекають.`);
  } catch (e) {
    console.error('Браузер не запустився:', e.message);
  }
  console.log(`\n  ▶  Відкрий у браузері:  http://localhost:${config.PORT}   (слухаю ${config.HOST})\n`);
});

// Коректне завершення: закрити браузер і БД, потім вийти. (Власний обробник
// Playwright на SIGTERM лише закриває браузер і НЕ завершує процес.)
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Отримано ' + signal + ' — завершую роботу…');
  setTimeout(() => process.exit(1), 5000).unref(); // запобіжник, якщо щось зависло
  server.close();
  sessions.stop();
  await sessions.closeAll('сервер зупиняється').catch(() => {});
  await engine.close().catch(() => {});
  if (db) await db.end().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
