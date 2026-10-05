// Фабрика Express-застосунку з інʼєкцією залежностей — роутам не потрібні
// глобальні змінні, тож їх можна тестувати по HTTP з фейковими engine/db.
//
// deps: {
//   config,                  // loadConfig()
//   engine,                  // createEngine(): takeUnit/closeUnit/engineReady/poolStats/drainPool/relaunchBrowser
//   sem,                     // createSemaphore()
//   profileStore,            // createProfileStore(): get/set/save
//   getDb,                   // () => репозиторії БД або null (в пам'яті)
//   log,                     // console-подібний логер
//   sessions,                // createSessionStore() — живі сесії (інакше створюється тут)
//   live,                    // createLive() — сервіс живих сесій (інакше створюється тут)
// }
import express from 'express';
import path from 'path';
import { errorHandler } from './http.js';
import { renderRoutes } from '../routes/render.js';
import { replayRoutes } from '../routes/replay.js';
import { pagesRoutes } from '../routes/pages.js';
import { recordingsRoutes } from '../routes/recordings.js';
import { presetsRoutes } from '../routes/presets.js';
import { uploadRoutes } from '../routes/upload.js';
import { profileRoutes } from '../routes/profile.js';
import { healthRoutes } from '../routes/health.js';
import { liveRoutes } from '../routes/live.js';
import { createSessionStore } from './session.js';
import { createLive } from './live.js';
import { PROJECT_ROOT } from './config.js';
import { hostGuard } from './guard.js';

// Спільні ізоморфні модулі, які віддаємо браузеру як ES-модулі (/lib/<name>.js).
// Лише цей білий список і лише файли без Node-імпортів.
export const SHARED_LIBS = Object.freeze(['steps', 'coords', 'locators', 'textTemplate', 'errText']);

export function createApp(deps) {
  const d = { log: console, getDb: () => null, ...deps };
  if (!d.sessions) {
    d.sessions = createSessionStore({ log: d.log });
    d.sessions.start(); // unref-таймер — не тримає процес
  }
  if (!d.live) d.live = createLive({ ...d });
  // Перезапуск браузера (зміна launch-прапорців) вбиває контексти — закриваємо
  // живі сесії ДО нього з причиною (клієнт отримає 410 «config changed»).
  if (d.engine && typeof d.engine.onBeforeRelaunch === 'function') {
    d.engine.onBeforeRelaunch(() => d.sessions.closeAll('config changed'));
  }
  const app = express();
  // ПЕРШИМ: Host/Origin-захист (DNS-rebinding, крос-сайтові POST) — навіть index.html
  // не віддаємо чужому Host.
  app.use(hostGuard({ allowedHosts: d.config.ALLOWED_HOSTS || [] }));
  app.use(express.json({ limit: d.config.JSON_LIMIT || '2mb' })); // файли йдуть стрімом через /upload
  // Cache-Control: no-cache + ETag — браузер ЩОРАЗУ перевіряє свіжість index.html/JS/CSS
  // (304, якщо не змінились). Без заголовка браузер кешував «на власний розсуд» і після
  // оновлення коду показував старий UI.
  app.use(express.static(d.config.PUBLIC_DIR, {
    etag: true, lastModified: true, cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/lib/:name.js', (req, res, next) => {
    if (!SHARED_LIBS.includes(req.params.name)) return next();
    res.type('application/javascript; charset=utf-8');
    res.sendFile(path.join(PROJECT_ROOT, 'lib', req.params.name + '.js'));
  });

  app.use(renderRoutes(d));
  app.use(replayRoutes(d));
  app.use(pagesRoutes(d));
  app.use(recordingsRoutes(d));
  app.use(presetsRoutes(d));
  app.use(uploadRoutes(d));
  app.use(profileRoutes(d));
  app.use(healthRoutes(d));
  app.use(liveRoutes(d));

  app.use(errorHandler(d.log));
  return app;
}
