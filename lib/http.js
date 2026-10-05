import { cleanError } from './errText.js';

// HTTP-утиліти для роутів: asyncHandler (помилки async-хендлерів → error
// middleware) і єдиний формат помилки { ok:false, error } зі статусом err.status.

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Остання middleware: відповідає JSON-помилкою (якщо заголовки ще не надіслано).
export function errorHandler(log = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('Помилка ' + req.method + ' ' + req.originalUrl + ':', err && err.message);
    if (res.headersSent) { try { res.end(); } catch (_e) {} return; }
    // err.body — додаткові поля (напр. {code:'session_closed', reason} для 410).
    res.status(status).json({ ok: false, error: cleanError(err, 1000), ...((err && err.body) || {}) });
  };
}
