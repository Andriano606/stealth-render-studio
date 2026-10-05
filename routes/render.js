// POST /render — відкриває URL у готовому контексті з пулу, повертає
// fullPage-скриншот + метадані + текст + лог життєвого циклу.
import express from 'express';
import { asyncHandler } from '../lib/http.js';
import { describeContextLogs } from '../lib/logs.js';
import { gotoSmart, prepareForInteraction } from '../lib/nav.js';

// Дозволяємо URL без схеми (example.com → https://example.com).
export const normalizeUrl = (url) => (/^https?:\/\//i.test(url) ? url : 'https://' + url);

export function renderRoutes({ engine, sem, profileStore }) {
  const r = express.Router();
  r.post('/render', asyncHandler(async (req, res) => {
    let { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Не передано url' });
    url = normalizeUrl(String(url));

    await sem.acquire();
    const t0 = Date.now();
    const warm = engine.engineReady(); // чи браузер уже був прогрітий ДО цього запиту
    let unit;
    try {
      // Беремо ГОТОВИЙ контекст із пулу — зазвичай ~0 мс.
      const tCtx0 = Date.now();
      unit = await engine.takeUnit();
      const page = unit.page;
      const ctxMs = Date.now() - tCtx0;
      const fromPool = unit.fromPool;

      // Логи життєвого циклу (браузер/контекст/fingerprint/cookies/stealth).
      const logs = describeContextLogs(profileStore.get(), { fromPool, warm });

      // Навігація, стійка до Cloudflare (domcontentloaded + очікування челенджу).
      logs.push({ kind: 'nav', text: '➡️ goto ' + url + ' (Cloudflare-aware)' });
      const tNav0 = Date.now();
      const { resp: response, cf } = await gotoSmart(page, url);
      if (cf.wasChallenge) logs.push({ kind: 'info', text: cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено (заставка лишилась)' });
      const navMs = Date.now() - tNav0;

      const title = await page.title();
      const html = await page.content();
      const text = (await page.evaluate(() => document.body?.innerText || '')).trim();

      // Чекаємо вміст iframe-ів, прокручуємо для lazy-контенту, знімаємо всю сторінку.
      // Та сама підготовка виконується в /replay перед першою дією (верстка збігається).
      await prepareForInteraction(page);
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
      }));
      // caret:'initial' — дефолтний 'hide' пише inline-стилі в DOM сторінки (stealth).
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, caret: 'initial' });
      logs.push({ kind: 'shot', text: '📸 fullPage-скриншот зроблено (' + Math.round(screenshot.length / 1024) + ' КБ)' });

      res.json({
        ok: true,
        url: page.url(),
        status: response ? response.status() : null,
        title,
        htmlLength: html.length,
        textPreview: text.slice(0, 1500),
        screenshot: 'data:image/jpeg;base64,' + screenshot.toString('base64'),
        metrics,
        fromPool,
        poolReady: engine.poolStats().ready,
        logs,
        timing: { contextMs: ctxMs, navMs, totalMs: Date.now() - t0 },
      });
    } finally {
      await engine.closeUnit(unit);
      sem.release();
    }
  }));
  return r;
}
