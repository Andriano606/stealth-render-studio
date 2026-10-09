// Проксі браузера (спільний ізоморфний модуль: сервер + UI конфігуратора).
//
// Проксі — частина СЕРЕДОВИЩА (як cookies), а не анти-детект конфігу: живе в profile.proxy
// окремо від launch/stealth/behavior/fingerprint, тож НЕ потрапляє в пресети, у 📦 бандл
// експорту і не змінюється вибором пресета. Пароль ніколи не віддається назовні
// (publicProxy / proxyLabel / експорт конфігу) — лише ознака hasPassword.
//
// Формат у профілі: { server: 'http://host:port' | 'socks5://host:port', username?, password?, bypass?, enabled? }.
// enabled:false — проксі ВИМКНЕНО перемикачем: налаштування зберігаються, але браузер іде напряму
// (activeProxy → null). Відсутнє поле = увімкнено.

export const PROXY_SCHEMES = Object.freeze(['http', 'https', 'socks4', 'socks5']);
const MAX = { server: 300, cred: 256, bypass: 1000 };
const CTRL = /[\u0000-\u001f\u007f]/;

const str = (v) => (v == null ? '' : String(v)).trim();

// Розбирає рядок сервера: 'host:port', 'http://host:port', 'socks5://user:pass@host:port'.
// → { server, username?, password? } або { error }.
export function parseProxyServer(input) {
  let s = str(input);
  if (!s) return { error: 'вкажи адресу проксі (host:port)' };
  if (s.length > MAX.server) return { error: 'адреса проксі задовга' };
  if (CTRL.test(s) || /\s/.test(s)) return { error: 'адреса проксі містить пробіли або керівні символи' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?(\[[0-9a-f:.]+\]|[^:/?#@[\]]+)(?::(\d+))?\/?$/i);
  if (!m) return { error: 'не схоже на адресу проксі — очікую host:port або схема://host:port' };
  const scheme = m[1].toLowerCase();
  if (!PROXY_SCHEMES.includes(scheme)) return { error: 'схема «' + scheme + '» не підтримується (лише ' + PROXY_SCHEMES.join(', ') + ')' };
  const port = m[4] ? Number(m[4]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'вкажи порт проксі (1–65535), напр. ' + m[3] + ':8080' };
  const out = { server: scheme + '://' + m[3].toLowerCase() + ':' + port };
  if (m[2] != null) {
    const i = m[2].indexOf(':');
    const dec = (x) => { try { return decodeURIComponent(x); } catch (_e) { return x; } };
    out.username = dec(i < 0 ? m[2] : m[2].slice(0, i));
    if (i >= 0) out.password = dec(m[2].slice(i + 1));
  }
  return out;
}

// Нормалізує проксі з тіла POST /profile або profile.json.
//   input: null / '' / { server: '' } → null (без проксі); рядок — як server;
//   обʼєкт { server, username, password, bypass, enabled }. password === undefined → лишається
//   пароль із prev (UI не отримує пароль назад і не шле його, якщо не змінено).
// → { proxy, warning? } або { error }.
export function normalizeProxy(input, prev = null) {
  if (input == null || input === false) return { proxy: null };
  const o = typeof input === 'string' ? { server: input } : (typeof input === 'object' && !Array.isArray(input) ? input : null);
  if (!o) return { error: 'проксі має бути рядком або обʼєктом' };
  if (!str(o.server)) return { proxy: null };
  const parsed = parseProxyServer(o.server);
  if (parsed.error) return { error: parsed.error };
  let username = str(o.username) || parsed.username || '';
  let password;
  if (o.password !== undefined && o.password !== null) password = String(o.password);
  else if (parsed.password !== undefined) password = parsed.password;
  else password = prev && prev.password && username && username === prev.username ? prev.password : '';
  if (!username) password = '';
  for (const [k, v] of [['логін', username], ['пароль', password]]) {
    if (v.length > MAX.cred) return { error: k + ' проксі задовгий' };
    if (CTRL.test(v)) return { error: k + ' проксі містить керівні символи' };
  }
  const bypass = str(o.bypass).split(/[,\s]+/).filter(Boolean).join(',');
  if (bypass.length > MAX.bypass) return { error: 'список bypass задовгий' };
  if (CTRL.test(bypass)) return { error: 'bypass містить керівні символи' };
  const proxy = { server: parsed.server };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  if (bypass) proxy.bypass = bypass;
  if (o.enabled === false) proxy.enabled = false;
  const res = { proxy };
  if (/^socks/.test(proxy.server) && username) {
    res.warning = 'SOCKS із логіном/паролем Chromium у Playwright не підтримує (запуск упаде) — для Chromium бери HTTP-проксі';
  }
  return res;
}

// Проксі, що реально діє: вимкнений перемикачем (enabled:false) → null (пряме зʼєднання).
export function activeProxy(proxy) {
  return proxy && proxy.server && proxy.enabled !== false ? proxy : null;
}

// Опція `proxy` для Playwright launch() (Chromium і Firefox/Camoufox). Враховує лише server/
// username/password/bypass — чи проксі увімкнено, вирішує activeProxy (викликач).
export function toPlaywrightProxy(proxy) {
  if (!proxy || !proxy.server) return undefined;
  const out = { server: proxy.server };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  if (proxy.bypass) out.bypass = proxy.bypass;
  return out;
}

// Що можна показати (UI / GET /profile / експорт): без пароля.
export function publicProxy(proxy) {
  if (!proxy || !proxy.server) return null;
  return { server: proxy.server, username: proxy.username || '', bypass: proxy.bypass || '', hasPassword: !!proxy.password, enabled: proxy.enabled !== false };
}

// Людський підпис для логів: «http://host:8080 (логін user)». Без пароля.
export function proxyLabel(proxy) {
  if (!proxy || !proxy.server) return 'немає (пряме зʼєднання)';
  if (proxy.enabled === false) return 'вимкнено — пряме зʼєднання (налаштовано ' + proxy.server + ')';
  return proxy.server + (proxy.username ? ' (логін ' + proxy.username + (proxy.password ? ', з паролем' : '') + ')' : '')
    + (proxy.bypass ? ', в обхід: ' + proxy.bypass : '');
}

// Чи відрізняються два проксі за тим, що реально йде в браузер (для «зміна = перезапуск»):
// перемикач — так; правки налаштувань вимкненого проксі — ні.
export function sameProxy(a, b) {
  const k = (p) => JSON.stringify(toPlaywrightProxy(activeProxy(p)) || null);
  return k(a) === k(b);
}
