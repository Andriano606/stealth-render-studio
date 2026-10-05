// Лог-рядки життєвого циклу контексту для UI-консолі: ЩО саме відрізняється
// від дефолтного пустого Playwright. Чиста функція профілю — кожен рядок
// виводиться з реальних прапорців (щоб лог не вводив в оману при калібруванні).

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

export function describeContextLogs(profile, { fromPool, warm } = {}) {
  const logs = [];
  const fp = profile.fingerprint;
  const st = profile.stealth || {};
  const L = profile.launch || {};
  const camoufox = L.engine === 'camoufox';
  logs.push({ kind: 'browser', text: '🧩 Рушій: ' + (camoufox ? 'Camoufox (Firefox-антидетект)' : 'Chromium') });
  logs.push({ kind: 'browser', text: warm
    ? '🌐 Браузер: використано вже прогрітий (reuse, без launch)'
    : '🌐 Браузер: запущено (launch)' });
  if (camoufox) {
    const extra = [];
    if (L.camoufoxHumanize !== false) extra.push('humanize');
    if (L.camoufoxGeoip !== false) extra.push('geoip');
    logs.push({ kind: 'browser', text: '    ↳ Camoufox: fingerprint у C++, без CDP (Juggler), headless=' + (L.headless !== false) +
      ', ' + (extra.length ? extra.join('+') : 'без humanize/geoip') });
    logs.push({ kind: 'context', text: fromPool ? '📦 Контекст: з пулу Camoufox' : '📦 Контекст: новий (Camoufox)' });
    logs.push({ kind: 'stealth', text: '🕵️ Антидетект вшито в рушій — JS-слідів немає' });
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
