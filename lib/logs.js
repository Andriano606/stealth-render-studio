// Лог-рядки життєвого циклу контексту для UI-консолі: ЩО саме відрізняється
// від дефолтного пустого Playwright. Чиста функція профілю — кожен рядок
// виводиться з реальних прапорців (щоб лог не вводив в оману при калібруванні).

import { proxyLabel } from './proxy.js';

export function shortUA(ua) {
  if (!ua) return '—';
  const m = ua.match(/Chrome\/[\d.]+/);
  return m ? m[0] : (ua.slice(0, 28) + '…');
}

// Людські назви stealth-прапорців (порядок = порядок у конфігураторі).
const STEALTH_LABELS = [
  ['webdriver', 'navigator.webdriver=false'],
  ['windowChrome', 'window.chrome'],
  ['outerWindow', 'outerWidth/Height'],
  ['permissions', 'permissions.query'],
  ['pwInitScripts', 'без __pwInitScripts'],
];

// profile — поточний профіль; fromPool — контекст із пулу; warm — браузер уже був запущений.
// Повертає масив { kind, text }.
// Рядок поведінки (behavior.*) — щоб калібрування фіксувало, що реально діяло.
function behaviorLine(profile) {
  const b = profile.behavior || {};
  return { kind: 'info', text: '🧍 Поведінка: humanize=' + (b.humanize !== false ? 'увімк' : 'вимк')
    + ', autoScroll перед legacy-відтворенням=' + (b.prepareScroll !== false ? 'увімк' : 'вимк')
    + (b.fastPrefix === true ? ', швидкий префікс живої сесії' : '') };
}

// Рядок «🖥 Вікно Camoufox» для MCP (view — явні viewport/DPR із запиту; headful — видиме вікно з
// viewport:null; ignoredFp — поля fingerprint запиту, яких Camoufox не бере). Чесно каже, що пішло в
// newContext, а чого НЕ застосовано.
export const CAMOUFOX_DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 }); // Playwright-дефолт
export function camoufoxWindowLines(view, { headful = false, ignoredFp = [] } = {}) {
  const out = [];
  const vp = view && view.viewport;
  const dpr = view && view.deviceScaleFactor;
  let text;
  if (!vp && !dpr) {
    text = headful
      ? '🖥 Вікно Camoufox: розмір реального вікна, DPR дисплея (viewport:null)'
      : '🖥 Вікно Camoufox: дефолт рушія ' + CAMOUFOX_DEFAULT_VIEWPORT.width + '×' + CAMOUFOX_DEFAULT_VIEWPORT.height + ', DPR 1× (контекст без опцій)';
  } else if (headful && !vp) {
    text = '🖥 Вікно Camoufox: розмір реального вікна; DPR ' + dpr + '× НЕ застосовано — у видимому вікні DPR потребує й viewport';
  } else {
    const w = vp ? vp.width : CAMOUFOX_DEFAULT_VIEWPORT.width;
    const h = vp ? vp.height : CAMOUFOX_DEFAULT_VIEWPORT.height;
    const d = dpr || 1;
    text = '🖥 Вікно Camoufox: viewport ' + w + '×' + h + (vp ? '' : ' (дефолт)') + ', DPR ' + d + '×' + (dpr ? '' : ' (дефолт)') +
      ' — з запиту, опції контексту Juggler → скрин viewport ' + Math.round(w * d) + '×' + Math.round(h * d) + ' px';
  }
  out.push({ kind: 'browser', text });
  if (ignoredFp && ignoredFp.length) {
    out.push({ kind: 'browser', text: '    ↳ поля fingerprint з запиту (' + ignoredFp.join(', ') + ') Camoufox не застосовує — генерує fingerprint сам' });
  }
  return out;
}

// opts.view (MCP) — додає рядок «🖥 Вікно Camoufox» (UI-логи без нього, як раніше).
export function describeContextLogs(profile, opts = {}) {
  const { fromPool, warm, view, ignoredFp, headful } = opts;
  const logs = [];
  const fp = profile.fingerprint;
  const st = profile.stealth || {};
  const L = profile.launch || {};
  const camoufox = L.engine === 'camoufox';
  logs.push({ kind: 'browser', text: '🧩 Рушій: ' + (camoufox ? 'Camoufox (Firefox-антидетект)' : 'Chromium') });
  logs.push({ kind: 'browser', text: warm
    ? '🌐 Браузер: використано вже прогрітий (reuse, без launch)'
    : '🌐 Браузер: запущено (launch)' });
  logs.push({ kind: 'browser', text: '🔀 Проксі: ' + proxyLabel(profile.proxy) });
  if (camoufox) {
    const extra = [];
    if (L.camoufoxHumanize !== false) extra.push('humanize');
    if (L.camoufoxGeoip !== false) extra.push('geoip');
    logs.push({ kind: 'browser', text: '    ↳ Camoufox: fingerprint у C++, без CDP (Juggler), headless=' + (L.headless !== false) +
      ', ' + (extra.length ? extra.join('+') : 'без humanize/geoip') });
    logs.push({ kind: 'context', text: fromPool ? '📦 Контекст: з пулу Camoufox' : '📦 Контекст: новий (Camoufox)' });
    logs.push({ kind: 'stealth', text: '🕵️ Антидетект вшито в рушій — JS-слідів немає' });
    if ('view' in opts) logs.push(...camoufoxWindowLines(view, { headful, ignoredFp }));
    logs.push(behaviorLine(profile));
    return logs;
  }
  const headless = L.headless === false ? 'false (headful)' : (L.newHeadless !== false ? 'new' : 'old');
  logs.push({ kind: 'browser', text: '    ↳ launch: headless=' + headless +
    ', siteIsolation=' + (L.siteIsolationDisabled !== false ? 'вимкнено' : 'увімкнено') +
    ', stealth-plugin=' + (L.stealthPlugin !== false ? 'УВІМК' : 'вимк') +
    ', AutomationControlled=' + (L.automationControlled !== false ? 'приховано' : 'як є') +
    ', GPU=' + (L.realGpu !== false ? 'реальний' : 'софтверний') +
    ', контекст=ізольований (новий на запит)' });
  logs.push({ kind: 'context', text: fromPool
    ? '📦 Контекст: взято з прогрітого пулу (newContext ~0 мс)'
    : '📦 Контекст: створено новий (newContext)' });
  if (fp) {
    logs.push({ kind: 'fp', text: '🧬 Fingerprint ПІДСТАВЛЕНО: UA=' + shortUA(fp.userAgent) +
      ', locale=' + (fp.locale || '—') + ', tz=' + (fp.timezoneId || '—') +
      ', cores=' + (fp.hardwareConcurrency || '—') +
      ', screen=' + (fp.screen ? fp.screen.width + 'x' + fp.screen.height : '—') });
  } else {
    logs.push({ kind: 'fp', text: '🧬 Fingerprint: НЕ задано → дефолт Playwright' });
  }
  const on = STEALTH_LABELS.filter(([k]) => st[k]).map(([, label]) => label);
  logs.push({ kind: 'stealth', text: on.length ? '🕵️ Stealth: ' + on.join(', ') : '🕵️ Stealth: вимкнено (як дефолт)' });
  const ck = profile.storageState && Array.isArray(profile.storageState.cookies) ? profile.storageState.cookies.length : 0;
  logs.push({ kind: 'cookies', text: ck ? '🍪 Cookies: підставлено ' + ck : '🍪 Cookies: немає (порожній контекст)' });
  logs.push(behaviorLine(profile));
  return logs;
}
