// POST /upload — потокове завантаження файлу для під-дій "file".
import express from 'express';
import { createUploadHandler } from '../lib/uploads.js';

export function uploadRoutes({ config }) {
  const r = express.Router();
  r.post('/upload', createUploadHandler({ uploadDir: config.UPLOAD_DIR, maxBytes: config.MAX_UPLOAD_BYTES }));
  return r;
}
