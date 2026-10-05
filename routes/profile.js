// Профіль браузера: fingerprint + cookies + stealth/launch/behavior.
// POST /profile застосовує патч; зміна launch-прапорців = перезапуск браузера,
// інакше — лише перестворення пулу (нові контексти з оновленим профілем).
import express from 'express';
import { asyncHandler } from '../lib/http.js';
import { applyProfilePatch, fullConfig } from '../lib/profile.js';

export function profileRoutes({ profileStore, engine, log = console }) {
  const r = express.Router();
  r.get('/profile', (_req, res) => res.json({ ok: true, ...fullConfig(profileStore.get()) }));
  r.post('/profile', asyncHandler(async (req, res) => {
    const { profile, launchChanged } = applyProfilePatch(profileStore.get(), req.body || {});
    profileStore.set(profile);
    profileStore.save();

    let relaunched = false, launchError = null;
    if (launchChanged) {
      await engine.relaunchBrowser().catch((e) => { launchError = String(e && e.message || e); });
      relaunched = true;
    } else {
      await engine.drainPool().catch(() => {}); // просто оновити пул
    }
    // refillPool ковтає помилки — тож перевіряємо, чи рушій реально піднявся.
    if (!launchError && !engine.engineReady()) launchError = 'браузер не запустився (див. лог сервера)';
    if (launchError) log.error('Помилка запуску браузера після зміни конфігу:', launchError);
    res.json({ ok: true, relaunched, launchError, ...fullConfig(profileStore.get()) });
  }));
  return r;
}
