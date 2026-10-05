// GET /health — стан сервера (семафор, пул, БД, живі сесії).
import express from 'express';

export function healthRoutes({ engine, sem, getDb, sessions }) {
  const r = express.Router();
  r.get('/health', (_req, res) => {
    const ps = engine.poolStats();
    res.json({ ok: true, active: sem.active, poolReady: ps.ready, poolSize: ps.size, db: !!getDb(), sessions: sessions ? sessions.size : 0 });
  });
  return r;
}
