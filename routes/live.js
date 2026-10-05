// Живі сесії запису (synth.md §4). Логіка — у lib/live.js, стан — lib/session.js.
//   POST   /live                 {url, actions, recId} → NDJSON (log/status/action/done-action …, кінець {event:'live', sid, …})
//   POST   /live/:sid/act        {type, vx, vy, text, key, dx, dy, fileId, filename, value, rec, waitResponse, k, h}
//   GET    /live/:sid/shot?h=    keep-alive + скриншот, лише якщо хеш змінився
//   POST   /live/:sid/nav        {action:'goto'|'back'|'forward'|'reload', url}
//   GET    /live/:sid/inspect?x&y → {box, target, desc} без кліку
//   POST   /live/:sid/run        {steps} → NDJSON через спільний runSteps («▶ спробувати»)
//   POST   /live/:sid/close      (sendBeacon) і DELETE /live/:sid
// Закрита/невідома сесія → 410 {code:'session_closed', reason}; поки відкривається → 409.
import express from 'express';
import { asyncHandler } from '../lib/http.js';
import { cleanError } from '../lib/errText.js';

// NDJSON-відповідь із лінивими заголовками: поки нічого не надіслано, помилку
// можна віддати звичайним HTTP-статусом (429/503/400).
function ndjson(res) {
  const write = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    res.write(JSON.stringify(obj) + '\n');
  };
  const fail = (err) => {
    const status = err && err.status;
    if (!res.headersSent) {
      res.status(status || 500).json({ ok: false, error: cleanError(err, 1000), ...((err && err.body) || {}) });
      return;
    }
    write({ event: 'error', message: cleanError(err, 1000), ...((err && err.body) || {}) });
    res.end();
  };
  return { write, fail };
}

export function liveRoutes({ live, sessions }) {
  const r = express.Router();

  r.post('/live', async (req, res) => {
    const out = ndjson(res);
    let session = null;
    // Клієнт відʼєднався, поки сесія відкривалась → закриваємо її (ресурси звільняються).
    res.on('close', () => {
      if (!res.writableEnded && session && session.state === 'prefix') sessions.close(session.sid, 'клієнт відʼєднався під час відкриття');
    });
    try {
      await live.open(req.body || {}, out.write, { onSession: (s) => { session = s; } });
      res.end();
    } catch (e) {
      out.fail(e);
    }
  });

  r.post('/live/:sid/act', asyncHandler(async (req, res) => {
    res.json(await live.act(req.params.sid, req.body || {}));
  }));

  r.get('/live/:sid/shot', asyncHandler(async (req, res) => {
    res.json(await live.shot(req.params.sid, req.query.h));
  }));

  r.post('/live/:sid/nav', asyncHandler(async (req, res) => {
    res.json(await live.nav(req.params.sid, req.body || {}));
  }));

  r.get('/live/:sid/inspect', asyncHandler(async (req, res) => {
    res.json(await live.inspect(req.params.sid, req.query.x, req.query.y));
  }));

  r.post('/live/:sid/run', async (req, res) => {
    const out = ndjson(res);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      await live.run(req.params.sid, (req.body || {}).steps, out.write, { signal: ac.signal });
      res.end();
    } catch (e) {
      out.fail(e);
    }
  });

  const closeHandler = asyncHandler(async (req, res) => {
    const closed = await live.close(req.params.sid, 'закрито клієнтом');
    res.json({ ok: true, closed });
  });
  r.post('/live/:sid/close', closeHandler);
  r.delete('/live/:sid', closeHandler);
  return r;
}
