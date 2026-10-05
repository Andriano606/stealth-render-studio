// Пресети конфігуратора (у БД). Без БД: GET → порожньо, зміни → 503.
import express from 'express';
import { asyncHandler, httpError } from '../lib/http.js';

export function presetsRoutes({ getDb }) {
  const r = express.Router();
  const needDb = () => { const db = getDb(); if (!db) throw httpError(503, 'БД недоступна'); return db; };
  r.get('/presets', asyncHandler(async (_req, res) => {
    const db = getDb();
    if (!db) return res.json({ ok: true, db: false, presets: [] });
    res.json({ ok: true, db: true, presets: await db.presets.list() });
  }));
  r.post('/presets', asyncHandler(async (req, res) => {
    const db = needDb();
    const { name, body } = req.body || {};
    res.json({ ok: true, id: await db.presets.create({ name, body }) });
  }));
  r.put('/presets/:id', asyncHandler(async (req, res) => {
    const db = needDb();
    const { name, body } = req.body || {};
    await db.presets.update(Number(req.params.id), { name, body });
    res.json({ ok: true });
  }));
  r.delete('/presets/:id', asyncHandler(async (req, res) => {
    const db = needDb();
    await db.presets.remove(Number(req.params.id));
    res.json({ ok: true });
  }));
  return r;
}
