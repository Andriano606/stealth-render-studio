// Legacy: пласка модель Дій (таблиця recordings), лишена для сумісності.
import express from 'express';
import { asyncHandler } from '../lib/http.js';

export function recordingsRoutes({ getDb }) {
  const r = express.Router();
  r.get('/recordings', asyncHandler(async (_req, res) => {
    const db = getDb();
    if (!db) return res.json({ ok: true, db: false, recordings: [] });
    res.json({ ok: true, db: true, recordings: await db.recordings.list() });
  }));
  r.put('/recordings/:id', asyncHandler(async (req, res) => {
    const db = getDb();
    if (!db) return res.json({ ok: true, db: false });
    const { name, url, subs } = req.body || {};
    await db.recordings.upsert(Number(req.params.id), { name, url, subs });
    res.json({ ok: true, db: true });
  }));
  r.delete('/recordings/:id', asyncHandler(async (req, res) => {
    const db = getDb();
    if (!db) return res.json({ ok: true, db: false });
    await db.recordings.remove(Number(req.params.id));
    res.json({ ok: true, db: true });
  }));
  return r;
}
