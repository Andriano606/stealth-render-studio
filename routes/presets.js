// Пресети конфігуратора (у БД). Без БД: GET → порожньо, зміни → 503.
import express from 'express';
import { asyncHandler, httpError } from '../lib/http.js';

// Назва пресета: рядок, обрізаний, 1–80 символів. → {name} або {error}.
export const PRESET_NAME_MAX = 80;
export function validatePresetName(v) {
  if (typeof v !== 'string') return { error: 'Назва пресета має бути рядком' };
  const name = v.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Назва пресета не може бути порожньою' };
  if (name.length > PRESET_NAME_MAX) return { error: 'Назва пресета — до ' + PRESET_NAME_MAX + ' символів' };
  return { name };
}

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
    let clean;
    if (name !== undefined && name !== null) {
      const v = validatePresetName(name);
      if (v.error) throw httpError(400, v.error);
      clean = v.name;
    }
    res.json({ ok: true, id: await db.presets.create({ name: clean, body }) });
  }));
  r.put('/presets/:id', asyncHandler(async (req, res) => {
    const db = needDb();
    const { name, body } = req.body || {};
    let clean;
    if (name !== undefined) {
      const v = validatePresetName(name);
      if (v.error) throw httpError(400, v.error);
      clean = v.name;
    }
    if (clean === undefined && body === undefined) throw httpError(400, 'Нічого оновлювати');
    const found = await db.presets.update(Number(req.params.id), { name: clean, body });
    if (found === false) throw httpError(404, 'Пресет не знайдено');
    res.json({ ok: true, ...(clean !== undefined ? { name: clean } : {}) });
  }));
  r.delete('/presets/:id', asyncHandler(async (req, res) => {
    const db = needDb();
    const deleted = await db.presets.remove(Number(req.params.id));
    if (!deleted) throw httpError(404, 'Пресет не знайдено');
    res.json({ ok: true, deleted: true });
  }));
  return r;
}
