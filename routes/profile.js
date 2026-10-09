// Профіль браузера: fingerprint + cookies + stealth/launch/behavior.
// POST /profile застосовує патч; зміна launch-прапорців = перезапуск браузера,
// інакше — лише перестворення пулу (нові контексти з оновленим профілем).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { asyncHandler } from '../lib/http.js';
import { applyProfilePatch, fullConfig } from '../lib/profile.js';
import { buildConfigExport, cleanName } from '../lib/exportConfig.js';
import { stealthEvasions } from '../lib/stealth.js';
import { PROJECT_ROOT } from '../lib/config.js';
import { humanError } from '../lib/errText.js';
import { proxyLabel } from '../lib/proxy.js';

// Куди ходить «🔀 Перевірити IP»: відповідь — JSON {ip}. Запит іде БРАУЗЕРОМ (через
// застосований проксі), тож видно саме вихідний IP прогонів.
export const IP_CHECK_URL = 'https://api.ipify.org?format=json';
export const IP_CHECK_TIMEOUT = 20000;

// Версії ключових пакетів (з node_modules/*/package.json) — для відтворюваності експорту.
const EXPORT_PKGS = ['playwright', 'playwright-core', 'playwright-extra', 'puppeteer-extra-plugin-stealth', 'camoufox-js'];
export function packageVersions(root = PROJECT_ROOT, fsImpl = fs) {
  const out = {};
  for (const name of EXPORT_PKGS) {
    try { out[name] = JSON.parse(fsImpl.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch (_e) { /* немає — пропускаємо */ }
  }
  return out;
}

export function profileRoutes({ profileStore, engine, sem = null, log = console }) {
  const r = express.Router();
  r.get('/profile', (_req, res) => res.json({ ok: true, ...fullConfig(profileStore.get()) }));
  // Експорт ЗАСТОСОВАНОГО конфігу: Markdown-специфікація + готовий client.mjs (без cookies).
  //   ?preset=<назва для заголовка>&status=preset|changed|custom ; ?format=json — лише JSON-специфікація.
  r.get('/profile/export', (req, res) => {
    const versions = packageVersions();
    const bv = engine && typeof engine.browserVersion === 'function' ? engine.browserVersion() : null;
    if (bv && bv.version) versions[bv.kind === 'camoufox' ? 'camoufox-browser' : 'chrome'] = bv.version;
    const presetName = typeof req.query.preset === 'string' ? cleanName(req.query.preset) : ''; // без переносів рядка/керівних символів
    const presetStatus = typeof req.query.status === 'string' ? cleanName(req.query.status).slice(0, 16) : null;
    const out = buildConfigExport(profileStore.get(), { presetName, presetStatus, versions, evasions: stealthEvasions() });
    if (req.query.format === 'json') return res.json({ ok: true, spec: out.spec });
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', "attachment; filename=\"stealth-config.md\"; filename*=UTF-8''" + encodeURIComponent(out.filename));
    res.send(out.markdown);
  });
  r.post('/profile', asyncHandler(async (req, res) => {
    const { profile, launchChanged, proxyWarning } = applyProfilePatch(profileStore.get(), req.body || {});
    profileStore.set(profile);
    profileStore.save();

    let relaunched = false, launchError = null;
    if (launchChanged) {
      await engine.relaunchBrowser().catch((e) => { launchError = humanError(e); });
      relaunched = true;
    } else {
      await engine.drainPool().catch(() => {}); // просто оновити пул
    }
    // refillPool ковтає помилки — тож перевіряємо, чи рушій реально піднявся.
    if (!launchError && !engine.engineReady()) launchError = 'браузер не запустився (див. лог сервера)';
    if (launchError) log.error('Помилка запуску браузера після зміни конфігу:', launchError);
    res.json({ ok: true, relaunched, launchError, proxyWarning, ...fullConfig(profileStore.get()) });
  }));

  // «🔀 Перевірити IP»: вихідний IP браузера з ЗАСТОСОВАНИМ проксі (контекст із пулу, як прогін).
  r.post('/profile/proxy-check', asyncHandler(async (_req, res) => {
    const prof = profileStore.get();
    if (sem) await sem.acquire();
    const t0 = Date.now();
    let unit = null;
    try {
      unit = await engine.takeUnit();
      const resp = await unit.page.goto(IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: IP_CHECK_TIMEOUT });
      const body = resp ? await resp.text() : '';
      let ip = null;
      try { ip = JSON.parse(body).ip || null; } catch (_e) { ip = null; }
      if (!ip) throw new Error('сервіс перевірки IP відповів неочікувано (HTTP ' + (resp ? resp.status() : '—') + ')');
      // (Firefox/Camoufox на 407 віддає саму відповідь проксі — статус 407 потрапить у текст вище.)
      res.json({ ok: true, ip, ms: Date.now() - t0, proxy: proxyLabel(prof.proxy), engine: (prof.launch && prof.launch.engine) || 'chromium' });
    } catch (e) {
      let error = humanError(e, 500);
      // 407 від проксі Chromium показує як ERR_HTTP_RESPONSE_CODE_FAILURE, Firefox — як 407 у відповіді.
      if (prof.proxy && /RESPONSE_CODE_FAILURE|\b407\b|PROXY_AUTH/i.test(error)) error += ' — схоже, проксі відхилив авторизацію: перевір логін/пароль';
      res.json({ ok: false, error, ms: Date.now() - t0, proxy: proxyLabel(prof.proxy) });
    } finally {
      if (unit) await engine.closeUnit(unit).catch(() => {});
      if (sem) sem.release();
    }
  }));
  return r;
}
