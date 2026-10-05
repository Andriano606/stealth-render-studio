// Сценарії (таблиця pages): URL + масив Дій (recs JSONB).
// Без БД — сховище в памʼяті ПРОЦЕСУ сервера: відповіді мають db:false, memory:true
// (сценарії переживають перезавантаження вкладки, але не перезапуск сервера).
import express from 'express';
import { asyncHandler } from '../lib/http.js';

export function pagesRoutes({ getDb }) {
  const r = express.Router();
  const mem = new Map(); // id → {id, name, url, recs}
  r.get('/pages', asyncHandler(async (_req, res) => {
    const db = getDb();
    if (!db) return res.json({ ok: true, db: false, memory: true, pages: [...mem.values()].sort((a, b) => a.id - b.id) });
    res.json({ ok: true, db: true, pages: await db.pages.list() });
  }));
  r.put('/pages/:id', asyncHandler(async (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const { name, url, recs } = req.body || {};
    if (!db) {
      if (Number.isFinite(id)) mem.set(id, { id, name: name || ('Сценарій ' + id), url: url || '', recs: Array.isArray(recs) ? recs : [] });
      return res.json({ ok: true, db: false, memory: true });
    }
    await db.pages.upsert(id, { name, url, recs });
    res.json({ ok: true, db: true });
  }));
  r.delete('/pages/:id', asyncHandler(async (req, res) => {
    const db = getDb();
    if (!db) { mem.delete(Number(req.params.id)); return res.json({ ok: true, db: false, memory: true }); }
    await db.pages.remove(Number(req.params.id));
    res.json({ ok: true, db: true });
  }));
  return r;
}
