// POST /replay — відтворення записаних дій зі СТРІМІНГОМ прогресу (NDJSON).
// Сервер відкриває сторінку наново і шле подію на кожну дію, щоб клієнт
// показував у реальному часі, яка саме дія зараз виконується.
// Перша подія — { event:'run', runId }: зупинити прогін можна через
// POST /replay/:runId/stop (фінальний скриншот усе одно буде). Якщо клієнт
// відʼєднався — цикл зупиняється, контекст закривається одразу, слот звільняється.
import express from 'express';
import { randomUUID } from 'crypto';
import { describeContextLogs } from '../lib/logs.js';
import { gotoSmart, waitForContentSettle, prepareForInteraction } from '../lib/nav.js';
import { runReplay } from '../lib/replay.js';
import { needsLegacyPrep } from '../lib/steps.js';
import { cleanError } from '../lib/errText.js';
import { behaviorOpts } from '../lib/human.js';
import { resolveUpload } from '../lib/uploads.js';
import { normalizeUrl } from './render.js';

export function replayRoutes({ engine, sem, profileStore, config }) {
  const r = express.Router();
  const runs = new Map(); // runId → { stop(reason) }

  r.post('/replay/:runId/stop', (req, res) => {
    const run = runs.get(req.params.runId);
    if (!run) return res.status(404).json({ ok: false, error: 'Прогін не знайдено (вже завершився?)' });
    run.stop('user');
    res.json({ ok: true });
  });

  r.post('/replay', async (req, res) => {
    let { url, actions } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Не передано url' });
    url = normalizeUrl(String(url));
    if (!Array.isArray(actions)) actions = [];

    res.set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const send = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n'); };

    const runId = randomUUID();
    const ac = new AbortController();
    let stopReason = null, unit = null, unitClosed = false;
    const closeUnitOnce = async () => {
      if (!unit || unitClosed) return;
      unitClosed = true;
      await engine.closeUnit(unit).catch(() => {});
    };
    const run = {
      stop(reason) {
        if (ac.signal.aborted) return;
        stopReason = reason;
        ac.abort();
      },
    };
    runs.set(runId, run);
    // Клієнт відʼєднався (закрив вкладку/перервав fetch) — зупиняємо і звільняємо
    // контекст негайно: операції сторінки, що тривають, впадуть і цикл вийде.
    res.on('close', () => {
      if (res.writableEnded) return;
      run.stop('client');
      closeUnitOnce();
    });
    send({ event: 'run', runId });

    // Слот семафора. Stop / відʼєднання поки в черзі → очікувач виходить із черги
    // (не займає слот «вхолосту»), клієнт отримує термінальну подію.
    if (sem.active >= sem.max) send({ event: 'status', text: 'Чекаю вільний слот браузера…' });
    let acquired = false;
    try { await sem.acquire(undefined, { signal: ac.signal }); acquired = true; } catch (_e) { /* скасовано в черзі */ }
    const t0 = Date.now();
    const warm = engine.engineReady();
    try {
      if (ac.signal.aborted) {
        // Зупинено ДО старту (у черзі на слот або одразу після) — інакше потік
        // закінчився б лише подією 'run'.
        if (stopReason !== 'client') send({ event: 'error', stopped: true, message: 'Прогін зупинено до старту (чекав вільний слот)' });
        return;
      }
      unit = await engine.takeUnit();
      if (stopReason === 'client') { await closeUnitOnce(); return; }
      let page = unit.page;
      const profile = profileStore.get();
      const { humanize, singleMove } = behaviorOpts(profile, 'replay');

      // Логи життєвого циклу — одразу стрімимо в UI.
      for (const l of describeContextLogs(profile, { fromPool: unit.fromPool, warm })) send({ event: 'log', ...l });

      send({ event: 'log', kind: 'nav', text: '➡️ goto ' + url + ' (Cloudflare-aware)' });
      send({ event: 'status', text: 'Відкриваю сторінку…' });
      const { cf } = await gotoSmart(page, url);
      if (cf.wasChallenge) send({ event: 'log', kind: 'info', text: cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено' });
      // Підготовка як у /render (autoScroll) — лише для legacy-координатних кліків
      // (їх записано на fullPage-скрині після autoScroll) і лише з behavior.prepareScroll.
      // Інакше — лише заспокоєння контенту (читання innerText, без прокрутки/мутацій).
      const legacy = needsLegacyPrep(actions);
      const prepOn = !(profile.behavior && profile.behavior.prepareScroll === false);
      const tp = Date.now();
      if (legacy && prepOn) {
        send({ event: 'status', text: 'Чекаю дозавантаження контенту (як у рендері)…' });
        await prepareForInteraction(page, { signal: ac.signal, mode: 'replay', humanize });
        send({ event: 'log', kind: 'info', text: '⏳ Сторінку підготовлено (контент + autoScroll' + (humanize ? ' колесом' : '') + ' — legacy-координати) за ' + (Date.now() - tp) + ' мс' });
      } else {
        send({ event: 'status', text: 'Чекаю дозавантаження контенту…' });
        await waitForContentSettle(page, 9000, { signal: ac.signal });
        send({ event: 'log', kind: 'info', text: '⏭ autoScroll пропущено (' + (!legacy ? 'немає legacy-координатних кліків' : 'behavior.prepareScroll вимкнено') + '); контент заспокоєно за ' + (Date.now() - tp) + ' мс' });
      }
      send({ event: 'opened', text: 'Сторінка відкрита, відтворюю дії…' });

      const result = await runReplay(page, actions, {
        send, humanize, signal: ac.signal, singleMove,
        resolveUpload: (fileId, filename) => resolveUpload(config.UPLOAD_DIR, fileId, filename),
      });
      page = result.page;
      if (stopReason === 'client') return; // нікому показувати — не робимо скриншот
      if (stopReason === 'user') send({ event: 'log', kind: 'warn', text: '⏹ Прогін зупинено користувачем' });

      // За замовчуванням БЕЗ важкого очікування наприкінці — скрин одразу (лише
      // коротке підстроювання контенту). Повне очікування відповіді сервера
      // вмикається чекбоксом «чекати відповідь» на потрібній під-дії клік.
      await waitForContentSettle(page, 1500);
      send({ event: 'status', text: 'Роблю фінальний скриншот…' });
      // ВАЖЛИВО: НЕ робимо autoScroll тут — прокрутка закриває відкриті дропдауни
      // (react-select закривається при скролі) та інший інтерактивний стан, а
      // мета фінального скрина — показати результат дій (напр. розкритий дропдаун).
      // fullPage-скриншот і так захоплює всю сторінку без попередньої прокрутки.
      // caret:'initial' — дефолтний 'hide' пише inline-стилі в DOM сторінки (stealth).
      const title = await page.title();
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
        scrollY: window.scrollY, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
      })).catch(() => null);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, caret: 'initial' });

      send({
        event: 'done',
        url: page.url(),
        title,
        actionsReplayed: result.replayed,
        actionsTotal: actions.length,
        stopped: !!stopReason,
        metrics, // scrollY фінального скрина — фіксовані елементи на ньому намальовані зі зсувом scrollY
        screenshot: 'data:image/jpeg;base64,' + screenshot.toString('base64'),
        timing: { totalMs: Date.now() - t0 },
      });
    } catch (err) {
      if (stopReason !== 'client') send({ event: 'error', message: cleanError(err, 1000) });
    } finally {
      runs.delete(runId);
      await closeUnitOnce();
      if (acquired) sem.release();
      res.end();
    }
  });
  return r;
}
