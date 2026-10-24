// Тули MCP-сервера (POST /mcp): Claude обирає рушій/пресет/прапорці НА ОДИН ЗАПИТ (нічого не
// зберігається в профіль і не перезапускає основний браузер), відкриває сторінку і отримує
// контент (текст/HTML/посилання/скрин) або проганяє збережений сценарій.
//
// Звідки береться браузер (acquireUnit):
//   • конфіг = застосований                → теплий пул (як /render);
//   • інші лише fingerprint/stealth/cookies → новий контекст ОСНОВНОГО браузера (unitWithProfile);
//   • інший рушій/прапорці запуску/проксі   → тимчасовий браузер (lib/scratch.js, кеш + простій).
// Чиста частина (resolveMcpProfile, findPreset, formatters) експортується для тестів.
import { applyProfilePatch, fullConfig } from './profile.js';
import { launchKey, engineKind } from './engine.js';
import { presetBody } from './transfer.js';
import { normalizeProxy, publicProxy } from './proxy.js';
import { describeContextLogs } from './logs.js';
import { gotoSmart, waitForContentSettle, prepareForInteraction } from './nav.js';
import { evalMain } from './isoworld.js';
import { evalAllFrames } from './dom.js';
import { runReplay } from './replay.js';
import { flattenScenario, needsLegacyPrep, isSideEffectStep, stepLabel } from './steps.js';
import { behaviorOpts } from './human.js';
import { resolveUpload } from './uploads.js';
import { humanError } from './errText.js';
import { toolError } from './mcp.js';

// ---------- Чиста логіка ----------

// Прапорці, які можна перевизначити (усі boolean). persistent прибрано з продукту.
export const MCP_FLAGS = Object.freeze({
  launch: ['headless', 'newHeadless', 'automationControlled', 'realGpu', 'siteIsolationDisabled', 'stealthPlugin', 'camoufoxHumanize', 'camoufoxGeoip'],
  stealth: ['webdriver', 'windowChrome', 'outerWindow', 'permissions', 'pwInitScripts'],
  behavior: ['humanize', 'prepareScroll', 'fastPrefix'],
});
export const FP_KEYS = Object.freeze(['userAgent', 'locale', 'timezoneId', 'platform', 'vendor', 'languages', 'hardwareConcurrency', 'deviceMemory', 'deviceScaleFactor', 'screen', 'viewport']);
export const ENGINES = Object.freeze(['chromium', 'camoufox']);

export const MAX_CHARS_DEFAULT = 30000;
export const MAX_CHARS_LIMIT = 500000;
export const MAX_WAIT_MS = 30000;
export const MAX_FULL_SHOT_H = 8000; // висота fullPage-скрина (CSS px) — довші обрізаються
export const MAX_LINKS = 300;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const normName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

export function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Пресет за id або назвою (без регістру; емодзі-префікс у назві можна не писати).
export function findPreset(presets, ref) {
  const list = Array.isArray(presets) ? presets : [];
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const byId = list.find((p) => Number(p.id) === Number(ref));
    if (byId) return byId;
  }
  const want = normName(ref);
  if (!want) return null;
  const strip = (s) => normName(s).replace(/^[^\p{L}\p{N}]+/u, '');
  return list.find((p) => normName(p.name) === want) || list.find((p) => strip(p.name) === strip(want)) || null;
}

// Сценарій / Дія за id або назвою.
export function findByRef(items, ref) {
  const list = Array.isArray(items) ? items : [];
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  return list.find((x) => String(x.id) === s) || list.find((x) => normName(x.name) === normName(s)) || null;
}

function pickFlags(group, v) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw toolError(group + ': очікується обʼєкт {прапорець: true|false}');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!MCP_FLAGS[group].includes(k)) throw toolError(group + '.' + k + ': невідомий прапорець. Доступні: ' + MCP_FLAGS[group].join(', '));
    if (typeof val !== 'boolean') throw toolError(group + '.' + k + ': очікується true або false');
    out[k] = val;
  }
  return out;
}

// Застосований профіль + аргументи тула → ефективний профіль на ОДИН запит (не зберігається).
// Порядок: застосований → preset → engine → launch/stealth/behavior → fingerprint → proxy → cookies.
// → { profile, label, overrides:[рядки], preset: назва|null }
export function resolveMcpProfile(applied, args = {}, presets = []) {
  let p = applied;
  const overrides = [];
  let presetName = null;
  if (args.preset !== undefined && args.preset !== null && args.preset !== '') {
    const pr = findPreset(presets, args.preset);
    if (!pr) {
      const names = (presets || []).map((x) => '«' + x.name + '»').join(', ');
      throw toolError('Пресет «' + args.preset + '» не знайдено. ' + (names ? 'Доступні: ' + names : 'Пресетів немає (БД недоступна або всі видалено).'));
    }
    p = applyProfilePatch(p, presetBody(pr.body).body).profile;
    presetName = pr.name;
  }
  if (args.engine !== undefined && args.engine !== null && args.engine !== '') {
    if (!ENGINES.includes(args.engine)) throw toolError('engine: очікується ' + ENGINES.join(' | '));
    p = applyProfilePatch(p, { launch: { engine: args.engine } }).profile;
    overrides.push('engine=' + args.engine);
  }
  const patch = {};
  for (const g of ['launch', 'stealth', 'behavior']) {
    const f = pickFlags(g, args[g]);
    if (f && Object.keys(f).length) {
      patch[g] = f;
      for (const [k, v] of Object.entries(f)) overrides.push(g + '.' + k + '=' + v);
    }
  }
  if (Object.keys(patch).length) p = applyProfilePatch(p, patch).profile;
  if (args.fingerprint !== undefined) {
    if (args.fingerprint === null) {
      p = { ...p, fingerprint: null };
      overrides.push('fingerprint=немає');
    } else if (isObj(args.fingerprint)) {
      for (const k of Object.keys(args.fingerprint)) {
        if (!FP_KEYS.includes(k)) throw toolError('fingerprint.' + k + ': невідоме поле. Доступні: ' + FP_KEYS.join(', '));
      }
      p = { ...p, fingerprint: { ...(p.fingerprint || {}), ...args.fingerprint } };
      overrides.push('fingerprint{' + Object.keys(args.fingerprint).join(',') + '}');
    } else throw toolError('fingerprint: очікується обʼєкт або null');
  }
  if (args.proxy !== undefined) {
    if (args.proxy === false || args.proxy === null || args.proxy === '') {
      p = { ...p, proxy: null };
      overrides.push('proxy=пряме зʼєднання');
    } else {
      const px = normalizeProxy(args.proxy);
      if (px.error) throw toolError('proxy: ' + px.error);
      p = { ...p, proxy: px.proxy };
      overrides.push('proxy=' + px.proxy.server);
    }
  }
  if (args.cookies === false) {
    p = { ...p, storageState: null };
    overrides.push('без cookies');
  }
  const label = [presetName ? 'пресет «' + presetName + '»' : 'застосований конфіг', ...overrides].join(' + ');
  return { profile: p, label, overrides, preset: presetName };
}

// Підпис того, що задається на рівні КОНТЕКСТУ (Chromium): однаковий → годиться теплий пул.
const stable = (v) => (Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v));
export const contextSig = (p) => stable([p.fingerprint || null, p.stealth || {}, p.storageState || null]);

// Звідки брати контекст: 'pool' (застосований), 'main' (той самий браузер, інший контекст), 'scratch'.
export function unitSource(profile, applied) {
  if (launchKey(profile) !== launchKey(applied)) return 'scratch';
  if (engineKind(profile) === 'camoufox') return 'pool'; // Camoufox ігнорує контекстні опції
  return contextSig(profile) === contextSig(applied) ? 'pool' : 'main';
}

export function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw toolError('url: обовʼязковий рядок');
  const s = raw.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(\/|$)/.test(s);
  // Без схеми: локальні адреси — http (тестові фікстури), решта — https.
  const local = /^(localhost|127(\.\d+){3}|\[::1\])([:/]|$)/i.test(s);
  const withScheme = hasScheme ? s : (local ? 'http://' : 'https://') + s;
  let u;
  try { u = new URL(withScheme); } catch (_e) { throw toolError('url: некоректна адреса «' + s + '»'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw toolError('url: дозволено лише http(s)');
  return u.href;
}

export function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return { text: str, truncated: false, total: str.length };
  return { text: str.slice(0, max), truncated: true, total: str.length };
}

// Текст усіх фреймів: головний + непорожні iframe з підписом.
export function joinFrameTexts(parts) {
  const list = (parts || []).filter((x) => x && typeof x.text === 'string');
  if (!list.length) return '';
  const [main, ...rest] = list;
  let out = main.text.trim();
  for (const f of rest) {
    const t = f.text.trim();
    if (t) out += '\n\n--- iframe: ' + (f.url || '?') + ' ---\n' + t;
  }
  return out;
}

export function formatLinks(links, max = MAX_LINKS) {
  const seen = new Set(), out = [];
  for (const [text, href] of links || []) {
    if (!href || seen.has(href) || !/^https?:/i.test(href)) continue;
    seen.add(href);
    out.push('- [' + (String(text || '').replace(/[[\]]/g, '') || '—') + '](' + href + ')');
    if (out.length >= max) break;
  }
  return out.join('\n');
}

export function cfLine(cf) {
  if (!cf || !cf.wasChallenge) return 'челенджу не було';
  return cf.passed ? 'челендж ПРОЙДЕНО' : 'челендж НЕ пройдено (заставка лишилась)';
}

const SOURCE_TEXT = {
  pool: 'теплий пул основного браузера',
  main: 'основний браузер, окремий контекст з цим конфігом',
  scratch: 'тимчасовий браузер (інший рушій/параметри запуску; закриється після простою)',
};

export function formatHeader({ url, status, title, label, profile, source, launched, cf, ms, extra = [] }) {
  const kind = engineKind(profile);
  const lines = [
    'URL: ' + url + (status ? ' (HTTP ' + status + ')' : ''),
    'Заголовок: ' + (title || '—'),
    'Рушій: ' + (kind === 'camoufox' ? 'Camoufox (Firefox-антидетект)' : 'Chromium') + ' · конфіг: ' + label + ' (не збережено)',
    'Браузер: ' + SOURCE_TEXT[source] + (source === 'scratch' && launched ? ' — щойно запущено' : ''),
    'Cloudflare: ' + cfLine(cf),
    ...extra,
    'Час: ' + (Math.round(ms / 100) / 10) + ' с',
  ];
  return lines.join('\n');
}

// ---------- Опис тулів (JSON Schema) ----------
const flagsSchema = (group) => ({
  type: 'object',
  description: 'Перевизначення ' + group + '.* лише на цей запит: { ' + MCP_FLAGS[group].map((k) => k + ': bool').join(', ') + ' }',
  properties: Object.fromEntries(MCP_FLAGS[group].map((k) => [k, { type: 'boolean' }])),
  additionalProperties: false,
});

export const CONFIG_PROPS = Object.freeze({
  preset: { type: ['string', 'number'], description: 'Пресет конфігуратора (назва або id з get_config), напр. "Clear all", "Cloudflare", "Ashby". Без нього — застосований у UI конфіг.' },
  engine: { type: 'string', enum: ENGINES, description: 'Рушій: chromium (швидко, stealth-опції) або camoufox (Firefox-антидетект, жорсткий Cloudflare; повільніший перший запуск).' },
  launch: flagsSchema('launch'),
  stealth: flagsSchema('stealth'),
  behavior: flagsSchema('behavior'),
  fingerprint: { type: ['object', 'null'], description: 'Поля fingerprint (Chromium), зливаються з поточним: ' + FP_KEYS.join(', ') + '. null — без fingerprint.' },
  proxy: { type: ['string', 'boolean'], description: 'false — пряме зʼєднання; рядок "схема://[логін:пароль@]host:порт" — інший проксі. Без поля — проксі з конфігуратора.' },
  cookies: { type: 'boolean', description: 'false — без збережених cookies профілю (чистий контекст).' },
});

const OUTPUT_PROPS = {
  content: { type: 'string', enum: ['text', 'html', 'none'], description: 'Що повернути: text (innerText головного документа + iframe, за замовч.), html (page.content()), none.' },
  links: { type: 'boolean', description: 'Додати список посилань сторінки (до ' + MAX_LINKS + ').' },
  screenshot: { type: 'string', enum: ['none', 'viewport', 'full'], description: 'Скрин JPEG: viewport, full (до ' + MAX_FULL_SHOT_H + ' px висоти) або none.' },
  maxChars: { type: 'integer', minimum: 1000, maximum: MAX_CHARS_LIMIT, description: 'Обрізати текст/HTML до N символів (за замовч. ' + MAX_CHARS_DEFAULT + ').' },
};

export const SERVER_INSTRUCTIONS = [
  'Stealth Render Studio — локальний тестовий стенд headless-браузера (Playwright) з антидетектом.',
  'get_config — застосований конфіг, пресети й доступні прапорці. open_page — відкрити URL з обраним рушієм/пресетом/прапорцями',
  'і отримати текст/HTML/посилання/скрин. list_scenarios / run_scenario — збережені в UI сценарії.',
  'Конфіг у тулах діє ЛИШЕ на цей запит: профіль у UI не змінюється і не зберігається.',
  'Cloudflare-челендж очікується автоматично (до ~40 с); жорсткий Cloudflare проходить engine:"camoufox".',
].join(' ');

// ---------- Тули ----------
// deps: { engine, scratch, sem, profileStore, getDb, pagesMem, config, log }
export function createMcpTools(deps) {
  const { engine, scratch = null, sem, profileStore, getDb = () => null, pagesMem = null, config = {} } = deps;

  async function loadPresets() {
    const db = getDb();
    if (!db) return { db: false, presets: [] };
    try { return { db: true, presets: await db.presets.list() }; } catch (e) { return { db: false, presets: [], error: e.message }; }
  }

  async function loadPages() {
    const db = getDb();
    if (db) return db.pages.list();
    return pagesMem ? [...pagesMem.values()].sort((a, b) => a.id - b.id) : [];
  }

  async function acquireUnit(profile) {
    const applied = profileStore.get();
    const source = unitSource(profile, applied);
    const warm = engine.engineReady();
    if (source === 'pool') {
      const u = await engine.takeUnit();
      return { unit: u, source, warm, close: () => engine.closeUnit(u) };
    }
    if (source === 'main') {
      const u = await engine.unitWithProfile(profile);
      return { unit: u, source, warm, close: () => engine.closeUnit(u) };
    }
    if (!scratch) throw toolError('Інший рушій/параметри запуску на один запит недоступні (тимчасові браузери не налаштовано).');
    const u = await scratch.take(profile);
    return { unit: u, source, warm: !u.launched, launched: u.launched, close: () => scratch.closeUnit(u) };
  }

  // Спільна обгортка: семафор → контекст → fn(page, ctx) → закриття. Відʼєднання клієнта — закриває контекст.
  async function withPage(profile, signal, fn) {
    await sem.acquire(undefined, signal ? { signal } : undefined);
    let got = null, closed = false;
    const close = async () => { if (got && !closed) { closed = true; await got.close().catch(() => {}); } };
    const onAbort = () => { close(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      got = await acquireUnit(profile);
      if (signal && signal.aborted) throw toolError('запит скасовано');
      return await fn(got.unit.page, got);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      await close();
      sem.release();
    }
  }

  async function grabContent(page, args) {
    const blocks = [];
    const maxChars = clampInt(args.maxChars, 1000, MAX_CHARS_LIMIT, MAX_CHARS_DEFAULT);
    const mode = args.content || 'text';
    if (mode === 'text') {
      const parts = await evalAllFrames(page, () => ({ url: location.href, text: document.body ? document.body.innerText : '' }), undefined, { onError: () => null }).catch(() => []);
      const t = truncate(joinFrameTexts(parts), maxChars);
      blocks.push({ type: 'text', text: '--- ТЕКСТ' + (t.truncated ? ' (обрізано: ' + t.text.length + ' з ' + t.total + ' символів)' : '') + ' ---\n' + (t.text || '(порожньо)') });
    } else if (mode === 'html') {
      const t = truncate(await page.content(), maxChars);
      blocks.push({ type: 'text', text: '--- HTML' + (t.truncated ? ' (обрізано: ' + t.text.length + ' з ' + t.total + ' символів)' : '') + ' ---\n' + t.text });
    }
    if (args.links) {
      const links = await evalMain(page, (max) => Array.from(document.links).slice(0, max * 3).map((a) => [
        (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 120), a.href,
      ]), MAX_LINKS).catch(() => []);
      blocks.push({ type: 'text', text: '--- ПОСИЛАННЯ ---\n' + (formatLinks(links) || '(немає)') });
    }
    const shot = args.screenshot || 'none';
    if (shot === 'viewport' || shot === 'full') {
      const opts = { type: 'jpeg', quality: 70, caret: 'initial' }; // caret:'initial' — без inline-стилів у DOM (stealth)
      if (shot === 'full') {
        const m = await evalMain(page, () => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => null);
        opts.fullPage = true;
        if (m && m.h > MAX_FULL_SHOT_H) opts.clip = { x: 0, y: 0, width: m.w, height: MAX_FULL_SHOT_H };
      }
      const buf = await page.screenshot(opts);
      blocks.push({ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType: 'image/jpeg' });
    }
    return blocks;
  }

  const getConfigTool = {
    name: 'get_config',
    title: 'Конфіг і пресети',
    description: 'Поточний ЗАСТОСОВАНИЙ у UI конфіг браузера (рушій, launch/stealth/behavior-прапорці, fingerprint, проксі без пароля), список пресетів і перелік прапорців, які можна перевизначити в open_page / run_scenario.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler() {
      const prof = profileStore.get();
      const full = fullConfig(prof);
      const { db, presets, error } = await loadPresets();
      return {
        content: [{ type: 'text', text: JSON.stringify({
          applied: {
            engine: engineKind(prof), launch: full.launch, stealth: full.stealth, behavior: full.behavior,
            fingerprint: full.fingerprint, cookiesCount: full.cookiesCount, proxy: publicProxy(prof.proxy),
          },
          presets: presets.map((p) => ({ id: p.id, name: p.name, builtin: !!p.builtin, body: presetBody(p.body).body })),
          presetsNote: db ? undefined : 'БД недоступна — пресетів немає' + (error ? ' (' + error + ')' : ''),
          overridable: { engine: ENGINES, ...MCP_FLAGS, fingerprint: FP_KEYS, proxy: 'false | "схема://[логін:пароль@]host:порт"', cookies: 'false — без cookies' },
          note: 'Перевизначення діють лише на один виклик — профіль у UI не змінюється.',
        }, null, 2) }],
      };
    },
  };

  const openPageTool = {
    name: 'open_page',
    title: 'Відкрити сторінку',
    description: 'Відкриває URL у headless-браузері стенду з обраним рушієм/пресетом/прапорцями (лише на цей запит, без збереження) і повертає статус, заголовок, результат Cloudflare, лог реально застосованого конфігу та контент (текст / HTML / посилання / скрин). Кожен виклик — новий ізольований контекст.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Адреса (http/https; без схеми → https://).' },
        ...CONFIG_PROPS,
        ...OUTPUT_PROPS,
        waitFor: { type: 'string', description: 'CSS/Playwright-селектор, появу якого чекати перед зняттям контенту (до 15 с).' },
        waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, description: 'Додаткова пауза після завантаження, мс.' },
        scroll: { type: 'boolean', description: 'Прокрутити сторінку донизу й назад (lazy-контент) перед зняттям.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, extra = {}) {
      const url = checkUrl(args.url);
      const { presets } = args.preset != null ? await loadPresets() : { presets: [] };
      const { profile, label } = resolveMcpProfile(profileStore.get(), args, presets);
      const t0 = Date.now();
      return withPage(profile, extra.signal, async (page, got) => {
        const { resp, cf } = await gotoSmart(page, url);
        const extraLines = [];
        if (args.waitFor) {
          const ok = await page.waitForSelector(String(args.waitFor), { timeout: 15000 }).then(() => true, () => false);
          extraLines.push('Селектор «' + args.waitFor + '»: ' + (ok ? 'зʼявився' : 'НЕ зʼявився за 15 с'));
        }
        const waitMs = clampInt(args.waitMs, 0, MAX_WAIT_MS, 0);
        if (waitMs) await page.waitForTimeout(waitMs);
        if (args.scroll) await prepareForInteraction(page, { mode: 'replay', humanize: false });
        else await waitForContentSettle(page, 4000);
        const title = await page.title().catch(() => '');
        const blocks = await grabContent(page, args);
        const logs = describeContextLogs(profile, { fromPool: !!got.unit.fromPool, warm: got.warm }).map((l) => '  ' + l.text);
        const header = formatHeader({
          url: page.url(), status: resp ? resp.status() : null, title, label, profile,
          source: got.source, launched: got.launched, cf, ms: Date.now() - t0, extra: extraLines,
        }) + '\nЛог конфігу:\n' + logs.join('\n');
        return { content: [{ type: 'text', text: header }, ...blocks] };
      }).catch((e) => { if (e && e.expected) throw e; throw toolError('Не вдалося відкрити ' + url + ': ' + humanError(e, 600)); });
    },
  };

  const listScenariosTool = {
    name: 'list_scenarios',
    title: 'Сценарії',
    description: 'Збережені в UI сценарії: id, назва, стартовий URL і Дії (id, назва, кількість кроків, чи є кроки з побічним ефектом — сабміт форми). Для run_scenario.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'boolean', description: 'Додати підписи кроків кожної Дії.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args = {}) {
      const pages = await loadPages();
      const out = pages.map((p) => ({
        id: p.id, name: p.name, url: p.url,
        actions: (p.recs || []).map((r) => {
          const subs = (r.subs || []).filter((s) => s && s.type !== 'move');
          return {
            id: r.id, name: r.name, steps: subs.length,
            sideEffects: subs.some(isSideEffectStep) || undefined,
            ...(args.steps ? { labels: subs.map((s) => (s.disabled ? '⏸ ' : '') + stepLabel(s)) } : {}),
          };
        }),
      }));
      return { content: [{ type: 'text', text: out.length ? JSON.stringify(out, null, 2) : 'Сценаріїв немає.' }] };
    },
  };

  const runScenarioTool = {
    name: 'run_scenario',
    title: 'Прогнати сценарій',
    description: 'Відтворює збережений сценарій (стартовий URL + Дії, як ▶ у UI) з обраним конфігом на один запит. Повертає результат кожного кроку, фінальний текст і скрин. Нічого не зберігає (автопокращення локаторів не записуються). Кроки з побічним ефектом (сабміт форм) виконуються лише з confirmSideEffects:true — спершу спитай користувача.',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: ['string', 'number'], description: 'id або назва сценарію (list_scenarios).' },
        upto: { type: ['string', 'number'], description: 'Виконати Дії до цієї (id або назва) включно. Без поля — усі.' },
        confirmSideEffects: { type: 'boolean', description: 'Користувач підтвердив кроки з побічним ефектом (сабміт).' },
        ...CONFIG_PROPS,
        ...OUTPUT_PROPS,
      },
      required: ['scenario'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args, extra = {}) {
      const page0 = findByRef(await loadPages(), args.scenario);
      if (!page0) throw toolError('Сценарій «' + args.scenario + '» не знайдено (див. list_scenarios).');
      let upto = null;
      if (args.upto !== undefined && args.upto !== null && args.upto !== '') {
        const rec = findByRef(page0.recs, args.upto);
        if (!rec) throw toolError('Дію «' + args.upto + '» не знайдено у сценарії «' + page0.name + '».');
        upto = rec.id;
      }
      const url = checkUrl(page0.url);
      const { flat } = flattenScenario(page0, upto);
      const risky = flat.filter((s) => !s.disabled && isSideEffectStep(s));
      if (risky.length && args.confirmSideEffects !== true) {
        throw toolError('Сценарій містить кроки з побічним ефектом (' + risky.map((s) => '«' + stepLabel(s) + '»').join(', ') +
          '). Спитай користувача і повтори з confirmSideEffects:true (або обмеж upto).');
      }
      const { presets } = args.preset != null ? await loadPresets() : { presets: [] };
      const { profile, label } = resolveMcpProfile(profileStore.get(), args, presets);
      const { humanize, singleMove } = behaviorOpts(profile, 'replay');
      const t0 = Date.now();
      return withPage(profile, extra.signal, async (page, got) => {
        const results = [], logs = [];
        const send = (ev) => {
          if (ev.event === 'done-action') results.push(ev);
          else if (ev.event === 'log' && (ev.kind === 'warn' || ev.kind === 'error' || /⚠|❌|🎯→📍/.test(ev.text || ''))) logs.push(ev.text);
        };
        const { resp, cf } = await gotoSmart(page, url);
        const prepOn = !(profile.behavior && profile.behavior.prepareScroll === false);
        if (needsLegacyPrep(flat) && prepOn) await prepareForInteraction(page, { signal: extra.signal, mode: 'replay', humanize });
        else await waitForContentSettle(page, 9000, { signal: extra.signal });
        const r = await runReplay(page, flat, {
          send, humanize, singleMove, signal: extra.signal, failShots: false,
          resolveUpload: (fileId, filename) => resolveUpload(config.UPLOAD_DIR, fileId, filename),
        });
        const last = r.page;
        await waitForContentSettle(last, 1500);
        const title = await last.title().catch(() => '');
        const byIdx = new Map(results.map((e) => [e.index, e]));
        const stepLines = flat.map((s, i) => {
          const e = byIdx.get(i);
          const mark = !e ? '·' : e.skipped ? '⏭' : !e.ok ? '✗' : (e.strategy === 'coord' || e.strategy === 'snap') && s.target ? '⚠' : '✓';
          return '  ' + mark + ' #' + (i + 1) + ' ' + stepLabel(s) + (e ? ' (' + (e.strategy || '—') + ', ' + e.ms + ' мс)' : '') + (e && e.error ? ' — ' + e.error : '');
        });
        const failed = results.filter((e) => !e.ok).length;
        const head = formatHeader({
          url: last.url(), status: resp ? resp.status() : null, title, label, profile,
          source: got.source, launched: got.launched, cf, ms: Date.now() - t0,
          extra: ['Сценарій: «' + page0.name + '» — виконано ' + r.replayed + ' з ' + flat.length + ' кроків' + (failed ? ', помилок ' + failed : '')],
        });
        const blocks = await grabContent(last, { screenshot: 'viewport', ...args });
        return { content: [{ type: 'text', text: head + '\nКроки:\n' + stepLines.join('\n') + (logs.length ? '\nПопередження:\n' + logs.slice(0, 30).map((t) => '  ' + t).join('\n') : '') }, ...blocks] };
      }).catch((e) => { if (e && e.expected) throw e; throw toolError('Прогін не вдався: ' + humanError(e, 600)); });
    },
  };

  return [getConfigTool, openPageTool, listScenariosTool, runScenarioTool];
}
