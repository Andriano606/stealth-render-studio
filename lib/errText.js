// errText.js — ІЗОМОРФНЕ чищення текстів помилок Playwright для людини (без Node-імпортів;
// віддається браузеру як /lib/errText.js — див. SHARED_LIBS у lib/app.js).
//   cleanError(msg, max)  — прибирає ANSI-коди (\x1b[2m…, і «осиротілі» [2m/[22m без ESC),
//                           хвіст «Call log: …», префікс API («page.goto: », «locator.click: »),
//                           схлопує пробіли, обрізає до max символів;
//   humanError(msg, max)  — cleanError + переклад типових net::ERR_* / таймаутів українською:
//                           «Сторінка недоступна (ERR_CONNECTION_REFUSED) — http://…».

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// ESC міг загубитись при JSON/копіюванні — лишаються «[2m», «[22m», «[39m»…
const ANSI_ORPHAN = /\[(?:\d{1,2}(?:;\d{1,3})*)m/g;
const CALL_LOG = /\s*(?:=+\s*logs\s*=+|Call log:)[\s\S]*$/i;
const API_PREFIX = /^(?:[a-zA-Z_$][\w$]*\.)+[a-zA-Z_$][\w$]*:\s+/;

export function cleanError(msg, max = 300) {
  let s = msg == null ? '' : typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
  s = s.replace(ANSI, '').replace(ANSI_ORPHAN, '');
  s = s.replace(CALL_LOG, '');
  s = s.replace(API_PREFIX, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
  return s;
}

const NET_TEXT = [
  [/^(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_FAILED|ADDRESS_UNREACHABLE|UNSAFE_PORT|EMPTY_RESPONSE|ABORTED|BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE)$/, 'Сторінка недоступна'],
  [/^NAME_NOT_RESOLVED$/, 'Домен не знайдено'],
  [/^(?:TIMED_OUT|CONNECTION_TIMED_OUT)$/, 'Сторінка не відповіла вчасно'],
  [/^(?:CERT_|SSL_)/, 'Помилка сертифіката'],
  [/^INTERNET_DISCONNECTED$/, 'Немає зʼєднання'],
  [/^TOO_MANY_REDIRECTS$/, 'Забагато перенаправлень'],
];

export function humanError(msg, max = 300) {
  const s = cleanError(msg, 2000);
  const m = /net::ERR_([A-Z0-9_]+)/.exec(s);
  if (m) {
    const code = m[1];
    const hit = NET_TEXT.find(([re]) => re.test(code));
    const url = /\bat (\S+)/.exec(s.slice(m.index));
    const text = (hit ? hit[1] : 'Мережева помилка') + ' (ERR_' + code + ')' + (url ? ' — ' + url[1] : '');
    return cleanError(text, max);
  }
  if (/Timeout \d+\s*ms exceeded/i.test(s)) {
    const url = /navigating to "([^"]+)"/.exec(String(msg || '')) || /\bat (https?:\/\/\S+)/.exec(s);
    return cleanError('Сторінка не відповіла вчасно (' + (/(\d+)\s*ms/.exec(s) || [])[1] + ' мс)' + (url ? ' — ' + url[1] : ''), max);
  }
  return cleanError(s, max);
}
