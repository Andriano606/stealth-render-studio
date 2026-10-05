// Захист локального сервісу від DNS-rebinding і крос-сайтових запитів.
//   • Host — лише localhost / 127.0.0.1 / [::1] (+ явний білий список ALLOWED_HOSTS):
//     сторінка зловмисника, що «перевʼязала» свій домен на 127.0.0.1, шле Host
//     зі СВОЇМ доменом → 403. Порт не порівнюємо (тести слухають порт 0, PORT довільний).
//   • Змінні запити (не GET/HEAD/OPTIONS) з чужим Origin або Sec-Fetch-Site: cross-site → 403.
//     Запити без Origin (curl, Node, same-origin GET) проходять.
// Чисті функції (hostnameOf/isAllowedHost/isAllowedOrigin) — юніт-тестовані.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// 'localhost:3000' → 'localhost', '[::1]:3000' → '[::1]', 'Example.COM' → 'example.com'
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i > 0 ? h.slice(0, i + 1) : ''; }
  return h.split(':')[0];
}

export function isAllowedHost(hostHeader, extra = []) {
  const n = hostnameOf(hostHeader);
  return !!n && (LOCAL.has(n) || extra.includes(n));
}

// Відсутній Origin — дозволено (не браузерний крос-сайт); 'null' (sandbox/file) — ні.
export function isAllowedOrigin(origin, extra = []) {
  if (origin == null || origin === '') return true;
  if (origin === 'null') return false;
  try { return isAllowedHost(new URL(origin).host, extra); } catch (_e) { return false; }
}

export function hostGuard({ allowedHosts = [] } = {}) {
  const extra = allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  return (req, res, next) => {
    if (!isAllowedHost(req.headers.host, extra)) {
      return res.status(403).json({ ok: false, error: 'Недозволений Host (захист від DNS-rebinding). Для доступу з мережі: HOST=0.0.0.0 ALLOWED_HOSTS=<ім’я/IP>' });
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe && (req.get('sec-fetch-site') === 'cross-site' || !isAllowedOrigin(req.get('origin'), extra))) {
      return res.status(403).json({ ok: false, error: 'Крос-сайтовий запит заборонено' });
    }
    next();
  };
}
