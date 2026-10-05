// Завантаження файлів для під-дій типу "file": безпечні імена, резолв шляху
// (захист від path traversal) і потоковий обробник POST /upload.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function safeName(name) {
  return String(name || 'file').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'file';
}

// Повертає абсолютний шлях до збереженого файлу або null.
// exists — інʼєкція перевірки існування (для тестів), за замовчуванням fs.existsSync.
export function resolveUpload(uploadDir, fileId, filename, exists = fs.existsSync) {
  if (!/^[a-f0-9-]{10,}$/i.test(String(fileId || ''))) return null;
  const root = path.resolve(uploadDir);
  const p = path.resolve(root, String(fileId), safeName(filename));
  if (!p.startsWith(root + path.sep)) return null;
  return exists(p) ? p : null;
}

// Потоковий аплоад: файл надходить як бінарний стрім (application/octet-stream),
// імʼя — у заголовку x-filename. БЕЗ base64 у памʼяті — тому великі файли (PDF
// на сотні МБ) не кладуть ні вкладку браузера, ні сервер. Пишемо req → на диск.
// Якщо клієнт обірвав завантаження — недописаний файл видаляємо.
export function createUploadHandler({ uploadDir, maxBytes, newId = () => crypto.randomUUID() }) {
  return (req, res) => {
    let finished = false;
    const done = (code, body) => { if (finished) return; finished = true; res.status(code).json(body); };
    // Лише application/octet-stream + x-filename (так шле UI): обидва «непрості» для
    // CORS → крос-сайтовий fetch(no-cors) не пройде без preflight, тож сторонній сайт
    // не може засмічувати диск.
    if (!/^application\/octet-stream\b/i.test(String(req.get('content-type') || '')) || !req.get('x-filename')) {
      req.resume();
      return done(415, { ok: false, error: 'Очікую Content-Type: application/octet-stream і заголовок x-filename' });
    }
    let dir = null;
    const cleanup = () => { if (dir) fs.rm(dir, { recursive: true, force: true }, () => {}); };
    try {
      let rawName = req.get('x-filename') || 'file';
      try { rawName = decodeURIComponent(rawName); } catch (_e) {}
      const name = safeName(rawName);
      const id = newId();
      dir = path.join(uploadDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      const ws = fs.createWriteStream(dest);
      let size = 0, aborted = false, complete = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes && !aborted) {
          aborted = true;
          done(413, { ok: false, error: 'файл завеликий (ліміт ' + Math.round(maxBytes / 1048576) + ' МБ)' });
          req.destroy(); ws.destroy();
          cleanup();
        }
      });
      req.on('end', () => { complete = true; });
      // Обрив зʼєднання клієнтом до кінця тіла → прибираємо частковий файл.
      req.on('close', () => {
        if (!complete && !aborted) { aborted = true; ws.destroy(); cleanup(); }
      });
      req.on('error', (e) => { aborted = true; ws.destroy(); cleanup(); done(500, { ok: false, error: String(e.message || e) }); });
      ws.on('error', (e) => { if (!aborted) { aborted = true; cleanup(); done(500, { ok: false, error: String(e.message || e) }); } });
      ws.on('finish', () => { if (!aborted) done(200, { ok: true, fileId: id, filename: name, size }); });
      req.pipe(ws);
    } catch (e) {
      cleanup();
      done(500, { ok: false, error: String(e.message || e) });
    }
  };
}
