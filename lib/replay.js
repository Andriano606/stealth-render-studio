// Відтворення записаних під-дій (координатна legacy-модель) на відкритій сторінці.
// HTTP-стрімінг — у routes/replay.js. Події шлються через send({event,...}) (NDJSON).
//
// Надійність кліку (P0, див. CLAUDE.md «Координати запису → відтворення»):
//   1. Масштаб координат міряється ПЕРЕД кожною дією (recordScale «прилипає» до DPR).
//   2. Прокрутка лише якщо ціль поза безпечною смугою (scrollPlan), миттєво
//      (behavior:'instant'), з очікуванням, доки scrollY вляжеться. Рухи миші не скролять.
//   3. Повторний hit-test ПІСЛЯ руху миші, перед mouse.down; classifyHit → decideSnap.
//   4. Після кліку — очікування стану: навігація (domcontentloaded + Cloudflare) або
//      мережевий спокій waitQuiet (Node-side, без JS у сторінці), а не фіксований сон.
//   5. «Роздивляння» — детермінований розклад (shouldWander), ніколи після залежного кроку.
//
// Кроки v2 з target (synth.md §5) — СПОЧАТКУ локатор: фрейм (ланцюг frameLocator →
// запасний matchFrame), кандидати [pick, …решта] опитуються кожні 200 мс до
// step.timeout; рівно 1 збіг — перемога, >1 — найближчий до записаного боксу
// (strategy 'loc' | 'loc-alt' | 'nth', healed — якщо переміг не pick). Не знайшли →
// координатний шлях (x/y кроку), strategy 'coord'/'snap'. Legacy-кроки без target
// ідуть координатним шляхом без змін.
import { detectDeviceGids, toDocCoords, classifyHit, decideSnap, preferFixedHit, shouldWander } from './coords.js';
import * as realDom from './dom.js';
import { allFramesText, waitForResultChange, waitForContentSettle, waitPastCloudflare } from './nav.js';
import { humanMove, humanPress, humanType, humanWander, wanderCandidates } from './human.js';
import { createNetTracker, waitQuiet, realClock } from './settle.js';
import { stepText } from './textTemplate.js';
import { rint as rintR } from './rng.js';
import { matchFrame, pickNearest, pointInBox, specToString } from './locators.js';
import { needsFocusClick, delayAfterMs, upgradeCandidates, frameKey, sameTarget } from './steps.js';
import { locatorFor } from './capture.js';
import { cleanError } from './errText.js';

// Параметри очікування після кліку / клавіші / файлу.
export const SETTLE_CLICK = { minMs: 150, quietMs: 300, maxMs: 2500 };
export const SETTLE_KEY = { minMs: 50, quietMs: 200, maxMs: 1500 };
// Після друку: форми зберігають поле ВІДКЛАДЕНО (debounce ~300 мс, Ashby — ApiSetFormValue), а
// відповідь несе ВЕСЬ стан форми, і перемагає та, що прийшла останньою. Якщо наступна дія
// (клік «Yes») полетить паралельно зі збереженням тексту — стара відповідь затре її значення.
// quietMs 700 — встигає стартувати відкладене збереження і завершитись.
export const SETTLE_TEXT = { minMs: 100, quietMs: 700, maxMs: 4000 };
// Клік одразу після друку в ІНШЕ поле: багато форм зберігають поле на blur (Ashby: mousedown на
// «Yes» → ApiSetFormValue поля + ApiSetFormValue «Yes» паралельно, і пізніша відповідь зі старим
// станом затирає «Yes» — сабміт: «Missing entry for required field»). Тому mousedown → чекаємо
// мережевий спокій (поле збереглось) → mouseup. Людина так і робить: між down і up — пауза.
export const SETTLE_BLUR = { minMs: 120, quietMs: 250, maxMs: 3000 };
// Файл: сторінка часто обробляє його довгим запитом (Ashby: upload → «autofill з резюме» ~5 с,
// після чого ПЕРЕЗАПИСУЄ поля, введені під час обробки) — чекаємо запити, що змінюють дані й
// викликані кроком, до longMs, а не лише 3 с. quietMs 1,5 с: між upload і autofill буває пауза ~0,2–0,9 с.
export const SETTLE_FILE = { minMs: 300, quietMs: 1500, maxMs: 15000, longMs: 15000 };
// Скільки чекати, доки зʼявиться фрейм цілі (iframe, який сторінка вставляє скриптом):
// вбудована форма Ashby на preply.com зʼявлялась через 0,7–14 с після domcontentloaded.
export const FRAME_TIMEOUT = 30000;

// Людська назва фрейму цілі (target.frame) — для логів.
export function frameLabel(spec) {
  if (!spec) return 'головний фрейм';
  const u = String(spec.url || spec.path || '').replace(/^https?:\/\//, '');
  return u || (spec.name ? 'name=' + spec.name : '') || (spec.chain && spec.chain.length ? spec.chain.join(' › ') : 'iframe');
}
// Чи крок із ціллю пройшов запасним координатним шляхом (фокус/стан після нього — під сумнівом).
export function isCoordFallback(a, strategy) {
  return hasTarget(a) && (strategy === 'coord' || strategy === 'snap');
}

// Пауза ПІСЛЯ кроку a (перед наступним next) — чиста функція.
//   • move → майже без паузи (рухи лише ведуть мишу);
//   • text → text (legacy: по символу на під-дію) → як між літерами одного слова;
//   • інакше — людська пауза (humanize) або мінімальна.
export function pauseAfter(a, next, humanize, rint) {
  if (!next) return 0;
  if (a && a.type === 'move') return humanize ? rint(15, 60) : 0;
  if (a && a.type === 'text' && next.type === 'text') return humanize ? 0 : 25; // humanType уже чекає після символу
  return humanize ? rint(350, 1100) : 80;
}

const errText = (e) => cleanError(String((e && e.message) || e).split('\n')[0], 300);

// Чи має крок придатну семантичну ціль (локатори + pick ≥ 0).
export function hasTarget(a) {
  const t = a && a.target;
  return !!(t && Array.isArray(t.locs) && t.locs.length && Number.isInteger(t.pick) && t.pick >= 0);
}
// Чи має крок координати (x, y) для координатного запасного шляху.
export function hasCoords(a) {
  return !!a && a.x != null && a.y != null && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y));
}

const defaultReadScroll = (page) => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
// Помилка «зупинено» (Stop / відʼєднання): крок обривається ДО будь-якої дії на сторінці.
export const STOP_MSG = 'зупинено';

// Область пошуку для target.frame: Page (головний фрейм) | FrameLocator (ланцюг
// CSS-селекторів <iframe>, кожен рівно 1 збіг) | Frame (запасний matchFrame за
// origin+path → URL-глоб → name → index). null — фрейм ще не зʼявився.
export async function resolveScope(page, spec) {
  if (!spec) return page;
  const chain = Array.isArray(spec.chain) ? spec.chain : [];
  if (chain.length) {
    let sc = page, ok = true;
    for (const sel of chain) {
      const n = await sc.locator(sel).count().catch(() => 0);
      if (n !== 1) { ok = false; break; }
      sc = sc.frameLocator(sel);
    }
    // <iframe> уже в DOM, але документ ще не завантажено — фрейму «ще немає» (інакше таймаут цілі
    // спливає, поки iframe порожній: Camoufox вантажить вбудову Ashby на кілька секунд довше).
    if (ok) return (await chainFrameReady(page, chain)) ? sc : null;
  }
  const main = page.mainFrame();
  const sub = page.frames().filter((f) => f !== main);
  const m = matchFrame(sub.map((f, i) => ({ url: f.url(), name: f.name(), index: i })), spec);
  return m && (await frameReady(sub[m.i])) ? sub[m.i] : null;
}

// Документ фрейму готовий: закомічено справжній URL (не about:blank) і був domcontentloaded.
// Лише протокол Playwright (url / стан завантаження) — жодного JS у сторінці.
export async function frameReady(fr) {
  if (!fr || typeof fr.url !== 'function') return true; // фейки/невідомий API — не блокуємо
  if (typeof fr.isDetached === 'function' && fr.isDetached()) return false;
  const u = String(fr.url() || '');
  if (!u || u === 'about:blank') return false;
  if (typeof fr.waitForLoadState !== 'function') return true;
  return fr.waitForLoadState('domcontentloaded', { timeout: 50 }).then(() => true, () => false);
}
// Фрейм у кінці ланцюга <iframe> (elementHandle → contentFrame); API немає (фейки) → готовий.
async function chainFrameReady(page, chain) {
  let fr = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
  for (const sel of chain) {
    if (!fr || typeof fr.locator !== 'function') return true;
    const h = await fr.locator(sel).elementHandle({ timeout: 300 }).catch(() => null);
    if (!h || typeof h.contentFrame !== 'function') return false;
    const cf = await h.contentFrame().catch(() => null);
    if (typeof h.dispose === 'function') h.dispose().catch(() => {});
    if (!cf) return false;
    fr = cf;
  }
  return frameReady(fr);
}

// Пошук цілі кроку. Опитування: фрейм — кожні framePollMs (250), кандидати —
// кожні pollMs (200). Бюджет: поки фрейму цілі (target.frame) ще НЕМАЄ — чекаємо до
// frameTimeout (вбудовані форми на кшталт Ashby вставляються скриптом через 1–15 с);
// timeout цілі відлічується від ПОЯВИ фрейму (для головного фрейму — від старту).
// → { locator, idx, n, strategy, healed, nth?, dist?, ms, frameMs }
// або null (не знайдено / pick = -1 / перервано); out (якщо передано) отримує причину
// таймауту: { frameMissing, waitedMs }.
export async function resolveTarget(page, target, {
  timeout = 6000, frameTimeout = 0, clock = realClock, signal = null, readScroll = defaultReadScroll, pollMs = 200, framePollMs = 250,
  out = null,
} = {}) {
  if (!hasTarget({ target })) return null;
  const pick = Math.min(target.pick, target.locs.length - 1);
  const order = [pick, ...target.locs.map((_l, i) => i).filter((i) => i !== pick)];
  const start = clock.now();
  const frameLimit = Math.max(timeout, Number(frameTimeout) || 0);
  let frameAt = target.frame ? null : start; // коли фрейм цілі знайшовся (скидається, якщо зник)
  let scopeNow = !target.frame;
  const found = (r) => ({ ...r, ms: clock.now() - start, frameMs: frameAt - start });
  // Сон між опитуваннями переривається Stop-ом одразу (а не через ≤200 мс).
  let wake = null;
  const onAbort = () => { if (wake) wake(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const nap = (ms) => (signal ? Promise.race([clock.sleep(ms), new Promise((r) => { wake = r; })]) : clock.sleep(ms));
  try {
  for (;;) {
    if (signal && signal.aborted) return null;
    const scope = await resolveScope(page, target.frame).catch(() => null);
    scopeNow = !!scope;
    // Фрейм зник (SPA перемонтувала вбудову) — знову чекаємо його в межах frameTimeout від старту.
    if (!scope && target.frame) frameAt = null;
    if (scope) {
      if (frameAt == null) frameAt = clock.now();
      let multi = null, pickLoc = null;
      for (const idx of order) {
        const loc = target.locs[idx];
        // nth-кандидат (CSS + nth): рахуємо БАЗОВИЙ селектор — індекс міг змінитись,
        // тож при кількох збігах обираємо найближчий до запису бокс, а не nth.
        const isNth = !!loc && loc.by === 'css' && loc.nth != null;
        let l = null;
        try { l = locatorFor(scope, isNth ? { ...loc, nth: null } : loc); } catch (_e) { l = null; }
        if (!l) continue;
        if (idx === pick) pickLoc = l;
        const n = await l.count().catch(() => 0);
        if (n === 1 && idx !== pick && pickLoc) {
          // Гонка: між підрахунком pick (0 збігів) і альтернативи сторінка могла домалювати
          // ціль (асинхронні опції дропдауна) — перевіряємо pick ще раз, перш ніж «лікувати».
          const pn = await pickLoc.count().catch(() => 0);
          if (pn === 1) return found({ locator: pickLoc, scope, idx: pick, n: 1, strategy: 'loc', healed: false });
        }
        if (n === 1) return found({ locator: l, scope, idx, n, strategy: idx === pick ? 'loc' : 'loc-alt', healed: idx !== pick });
        if (n > 1 && (!multi || (isNth && !multi.isNth))) multi = { l, idx, n, isNth, nth: isNth ? loc.nth : null, by: loc.by };
      }
      if (multi) {
        // Кілька збігів — найближчий до записаного боксу (CSS px документа головної сторінки).
        const sc = await readScroll(page).catch(() => null);
        const sx = Number(sc && sc.x) || 0, sy = Number(sc && sc.y) || 0;
        const boxes = [];
        for (let k = 0; k < Math.min(multi.n, 20); k++) {
          const bb = await multi.l.nth(k).boundingBox().catch(() => null);
          boxes.push(bb ? { x: bb.x + sx, y: bb.y + sy, w: bb.width, h: bb.height } : null);
        }
        const near = pickNearest(boxes, target.box);
        // input[type=file] ×n без геометрії (приховані поля / бокс не записано) — неоднозначно:
        // nth=0 відправив би кожен файл у перше поле. Повертаємо null одразу (без очікування
        // таймауту) — runReplay візьме поле файлу за порядком (fileIdx).
        if (near.index < 0 && multi.nth == null && multi.by === 'type') return null;
        const k = near.index >= 0 ? near.index : (multi.nth != null && multi.nth < multi.n ? multi.nth : 0);
        return found({
          locator: multi.l.nth(k), scope, idx: multi.idx, n: multi.n, nth: k, dist: Number.isFinite(near.dist) ? near.dist : null,
          strategy: 'nth', healed: multi.idx !== pick,
        });
      }
    }
    const el = clock.now() - start;
    const limit = frameAt == null ? frameLimit : (frameAt - start) + timeout;
    if (el >= limit) {
      if (out) { out.frameMissing = !scopeNow; out.waitedMs = el; }
      return null;
    }
    await nap(Math.max(1, Math.min(scope ? pollMs : framePollMs, limit - el)));
  }
  } finally { if (signal) signal.removeEventListener('abort', onAbort); }
}

const secs = (ms) => Math.round(ms / 100) / 10;
const bbBox = (bb) => ({ x: bb.x, y: bb.y, w: bb.width, h: bb.height });

// page — відкрита сторінка; actions — пласкі під-дії.
// env: { send, humanize, resolveUpload(fileId, filename) → шлях|null, rng, signal,
//        singleMove (Camoufox+humanize: один mouse.move), dom, clock — dom/clock для тестів,
//        stepTimeout (межа таймауту кроку), failShots, handleDialogs (false — діалоги
//        приймає хтось інший, напр. жива сесія), readScroll }
// → { replayed, page (поточна — могла змінитись через попап), aborted }
// Спільний для /replay, префікса живої сесії і POST /live/:sid/run (runSteps).
export async function runReplay(page0, actions, env) {
  const {
    send, humanize, resolveUpload, rng = Math.random, signal = null,
    singleMove = false, dom = realDom, clock = realClock,
    stepTimeout = null,        // верхня межа таймауту кроку (префікс живої сесії — 2500 мс)
    frameTimeout = FRAME_TIMEOUT, // скільки чекати появи фрейму цілі (не входить у таймаут кроку)
    failShots = true,          // скрин viewport при збої кроку (done-action.failShot)
    readScroll = (p) => (typeof dom.readScrollXY === 'function' ? dom.readScrollXY(p) : defaultReadScroll(p)),
    handleDialogs = true,
  } = env;
  const rint = (a, b) => rintR(a, b, rng);
  const log = (kind, text) => send({ event: 'log', kind, text });
  const aborted = () => !!(signal && signal.aborted);
  // Stop під час кроку: жодного fallback-кліку/друку/файлу після переривання —
  // кидаємо STOP перед кожною побічною дією на сторінці.
  const STOP = new Error(STOP_MSG);
  const bailIfAborted = () => { if (aborted()) throw STOP; };
  const abortP = signal ? new Promise((r) => signal.addEventListener('abort', r, { once: true })) : null;
  const pause = async (ms) => { if (ms > 0) await (abortP ? Promise.race([clock.sleep(ms), abortP]) : clock.sleep(ms)); };
  const qopts = { now: clock.now, sleep: clock.sleep, signal };

  // --- поточна сторінка, діалоги, попапи ---
  let page = page0, tracker = null, pendingPopup = null;
  const pages = [page0];
  const dialogPages = [];
  const onDialog = async (d) => {
    let what = '';
    try { what = d.type() + ' «' + String(d.message()).slice(0, 80) + '»'; } catch (_e) {}
    log('info', '💬 Діалог ' + what + ' → прийнято');
    try { await d.accept(); } catch (_e) {}
  };
  const attach = (p) => {
    if (handleDialogs) { try { p.on('dialog', onDialog); dialogPages.push(p); } catch (_e) {} }
    if (tracker) tracker.dispose();
    tracker = createNetTracker(p, { now: clock.now });
  };
  const switchTo = (p, why) => {
    page = p; attach(p);
    log('nav', why);
  };
  const ctx = typeof page0.context === 'function' ? page0.context() : null;
  const onNewPage = (p) => {
    pages.push(p);
    switchTo(p, '🪟 Відкрилась нова вкладка/попап — далі дії в ній');
    pendingPopup = p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    try {
      p.on('close', () => {
        if (page !== p) return;
        const prev = [...pages].reverse().find((x) => x !== p && !(x.isClosed && x.isClosed()));
        if (prev) switchTo(prev, '🪟 Попап закрився — повертаюсь до попередньої вкладки');
      });
    } catch (_e) {}
  };
  attach(page);
  if (ctx && typeof ctx.on === 'function') ctx.on('page', onNewPage);

  let mouse = { x: rint(80, 400), y: rint(80, 400) }; // стартова позиція миші
  const moveTo = async (x, y) => {
    if (humanize) mouse = await humanMove(page, mouse, x, y, rng, { single: singleMove });
    else { await page.mouse.move(x, y); mouse = { x, y }; }
  };

  // «Роздивляння» колесом у нейтральній точці (не над списком/скролером/iframe),
  // з обовʼязковим очікуванням, доки прокрутка вляжеться.
  const wander = async (why) => {
    const vp = await dom.measure(page, { insets: false }).catch(() => null) || { w: 1280, h: 900 };
    const point = await dom.pickNeutralPoint(page, wanderCandidates(vp.w, vp.h, rng));
    if (!point) { log('info', '🧍 Роздивляння пропущено: немає нейтральної точки для колеса'); return; }
    log('info', '🧍 Роздивляння (' + why + ')');
    mouse = (await humanWander(page, rng, { point, from: mouse, single: singleMove })) || mouse;
    await dom.waitScrollSettle(page, { maxMs: 1000, minMs: 120 });
  };

  // Очікування після дії: навігація головного фрейму → domcontentloaded + Cloudflare;
  // інакше мережевий спокій.
  const settleAfter = async (navFlag, opts) => {
    await waitQuiet(tracker, opts, qopts);
    if (navFlag() && !aborted()) {
      log('nav', '🧭 Дія спричинила навігацію → чекаю завантаження сторінки');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const cf = await waitPastCloudflare(page, 40000, { rng }).catch(() => ({}));
      if (cf && cf.wasChallenge) log('info', cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено');
      await waitQuiet(tracker, opts, qopts);
    }
  };
  // Слухач навігації головного фрейму, взведений ДО дії.
  const armNav = () => {
    const p = page, mf = typeof p.mainFrame === 'function' ? p.mainFrame() : null;
    let nav = false;
    const fn = (f) => { if (f === mf) nav = true; };
    try { p.on('framenavigated', fn); } catch (_e) {}
    return { flag: () => nav, off: () => { try { p.off('framenavigated', fn); } catch (_e) {} } };
  };

  if (humanize) {
    log('info', '🧍 Людська поведінка: криві рухи, змінні затримки, друк по буквах, роздивляння (після відкриття і кожен 4-й клік, не після кліку/клавіші)');
    if (shouldWander({ humanize, phase: 'open' })) await wander('після відкриття');
  }

  // --- Узгодження координат ---
  // Координати записані у ПІКСЕЛЯХ fullPage-скриншота (= CSS × DPR на момент запису).
  //   • a.dpr / a.sw (нові записи) → точний масштаб, міряний перед кожною дією;
  //   • інакше (старі) → по Дії (a.gid): якщо макс. X у Дії > viewport → device-простір (÷DPR).
  const vp0 = await dom.measure(page, { insets: false }).catch(() => ({ w: 1280, h: 900, dpr: 1, sw: 1280, sh: 900, scrollY: 0 }));
  const deviceGids = detectDeviceGids(actions, vp0.w);
  if (deviceGids.size) log('info', '🧭 Координати: ' + deviceGids.size + ' Дій у device-просторі масштабовано ÷' + vp0.dpr + ' у CSS');
  const toCss = (a, m) => toDocCoords(a, { scrollW: m.sw, dpr: m.dpr, deviceGids });

  // Дія + очікування стану після неї (навігація / мережевий спокій). Прапорець
  // навігації — у stepNavigated (для розкладу «роздивляння»).
  let stepNavigated = false;
  const actAndSettle = async (fn, opts) => {
    const nav = armNav();
    try {
      await fn();
      await settleAfter(nav.flag, opts);
    } finally { if (nav.flag()) stepNavigated = true; nav.off(); }
  };

  // Натискання з «фіксацією» поля, з якого йде фокус (див. SETTLE_BLUR). commitBlur — на поточний крок.
  let commitBlur = false;
  const press = async () => {
    if (!commitBlur) {
      if (humanize) await humanPress(page, rng);
      else { await page.mouse.down(); await page.mouse.up(); }
      return;
    }
    if (humanize) await page.waitForTimeout(rint(60, 180));
    await page.mouse.down();
    const q = await waitQuiet(tracker, SETTLE_BLUR, qopts);
    if (q.ms >= 400) log('info', '💾 Попереднє поле зберігалось після зняття фокуса ' + q.ms + ' мс — відпускаю кнопку після цього');
    await page.mouse.up();
  };

  // --- Координатний (legacy) клік: масштаб → прокрутка → рух → hit-test → snap → down/up ---
  // → strategy 'coord' | 'snap'
  // strict (крок із ціллю, локатор якої не спрацював): порожнеча під точкою і поряд немає
  // контрола → збій БЕЗ кліку — інакше «⚠ пройдено» маскує, що ціль не знайдено (напр. форма
  // ще не відкрилась), і наступні кроки виконуються наосліп.
  const coordClick = async (a, i, { strict = false } = {}) => {
    const m = await dom.measure(page);
    const { x: docX, y: docY } = toCss(a, m);
    let vx = docX, vy, sy = m.scrollY, fixedMode = false;
    // Фіксований елемент у першому екрані скриншота (банер, шапка) — без прокрутки.
    if (docY < m.h) {
      const h0 = await dom.elementAt(page, docX, docY);
      if (preferFixedHit(docY, m.h, h0, m.scrollY)) {
        fixedMode = true; vy = docY;
        log('info', '📌 Фіксований елемент «' + (h0.text || h0.tag) + '» — клік без прокрутки');
      }
    }
    if (!fixedMode) {
      const s = await dom.scrollDocTo(page, docY, { m });
      sy = s.scrollY; vy = docY - sy;
    }
    await moveTo(vx, vy);
    // Поки миша рухалась, сторінка могла зсунутись (догрузка, scroll anchoring) —
    // перечитуємо scrollY і перераховуємо точку.
    if (!fixedMode) {
      const sy2 = await dom.readScrollY(page);
      if (Math.abs(sy2 - sy) >= 1) {
        let nvy = docY - sy2;
        if (nvy < 0 || nvy >= m.h) { const s2 = await dom.scrollDocTo(page, docY); nvy = docY - s2.scrollY; }
        log('info', '↕️ Прокрутка змінилась під час руху (' + Math.round(sy) + '→' + Math.round(sy2) + ') — точку перераховано');
        vy = nvy;
        await moveTo(vx, vy);
      }
    }
    // Hit-test ПРЯМО перед натисканням.
    const hit = await dom.elementAt(page, vx, vy);
    const cls = classifyHit(hit);
    let decision = { action: 'trust' };
    if (cls !== 'interactive') {
      const nearest = await dom.snapToClickable(page, vx, vy, cls === 'empty' ? 60 : 24);
      decision = decideSnap(cls, nearest);
    }
    let strategy = 'coord';
    if (decision.action === 'snap') {
      const land = await dom.elementAt(page, decision.to.x, decision.to.y);
      log('info', '🧲 ' + (cls === 'empty' ? 'Порожнеча' : 'Неінтерактивний «' + ((hit && hit.text) || (hit && hit.tag)) + '»')
        + ' під кліком — притягнуто до контрола (+' + decision.d + 'px' + (land && land.text ? ', «' + land.text + '»' : '') + ')');
      vx = decision.to.x; vy = decision.to.y; strategy = 'snap';
      await moveTo(vx, vy);
    } else if (decision.action === 'none') {
      if (strict) throw new Error(targetName(a) + ' не знайдено, а під записаними координатами порожньо — клік не виконано');
      log('warn', '⚠️ Під кліком порожнеча і поряд немає контрола (клік#' + i + ', vp ' + Math.round(vx) + ',' + Math.round(vy) + ')');
    } else if (cls === 'content') {
      log('info', 'ℹ️ Клік#' + i + ' на неінтерактивному «' + ((hit && hit.text) || hit.tag) + '» (' + hit.tag + ') — контролів поряд немає, клікаю як записано');
    }
    const dbl = Number(a.clicks) === 2;
    bailIfAborted(); // Stop під час руху/hit-test — не натискаємо
    await actAndSettle(async () => {
      await press();
      if (dbl) { await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); }
    }, SETTLE_CLICK);
    return strategy;
  };

  // --- Клік за знайденим локатором ---
  //   humanize: trial-клік (actionability + scrollIntoView) → бокс → точка rel ±15% →
  //   людський рух → перечитати бокс (зсунувся > 4px — коригуємо) → down/up;
  //   без humanize: locator.click({position}); після друку в інше поле — як humanize, але без
  //   людського руху (down/up роздільні, див. SETTLE_BLUR).
  const locClick = async (r, a, deadline) => {
    const l = r.locator, rel = (a.target && a.target.rel) || null;
    const dbl = Number(a.clicks) === 2;
    const tmo = Math.max(1500, deadline - clock.now());
    if (humanize || (commitBlur && !dbl)) {
      await l.click({ trial: true, timeout: tmo });
      const bb = await l.boundingBox();
      if (!bb) throw new Error('ціль невидима (немає боксу)');
      let pt = pointInBox(bbBox(bb), rel, humanize ? 0.15 : 0, rng);
      await moveTo(pt.x, pt.y);
      const bb2 = await l.boundingBox().catch(() => null);
      if (bb2 && (Math.abs(bb2.x - bb.x) > 4 || Math.abs(bb2.y - bb.y) > 4)) {
        log('info', '↕️ Ціль зсунулась під час руху (' + Math.round(bb.y) + '→' + Math.round(bb2.y) + ') — коригую точку');
        pt = pointInBox(bbBox(bb2), rel, 0, rng);
        await moveTo(pt.x, pt.y);
      }
      await actAndSettle(async () => {
        await press();
        if (dbl) { await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); }
      }, SETTLE_CLICK);
    } else {
      const bb = await l.boundingBox().catch(() => null);
      const opts = { timeout: tmo };
      if (dbl) opts.clickCount = 2;
      if (bb && bb.width > 0 && bb.height > 0) opts.position = pointInBox({ x: 0, y: 0, w: bb.width, h: bb.height }, rel, 0);
      await actAndSettle(() => l.click(opts), SETTLE_CLICK);
    }
  };

  const timeoutOf = (a) => {
    const t = Number(a.timeout) > 0 ? Number(a.timeout) : 6000;
    return stepTimeout ? Math.min(t, stepTimeout) : t;
  };
  const targetName = (a) => (a.target && a.target.desc) || 'ціль';  // напр. «поле «Email»»
  const pickedSpec = (a) => specToString(a.target && a.target.locs ? a.target.locs[a.target.pick] : null);

  // Пошук цілі кроку з логом результату. → результат resolveTarget або null.
  let stepUpgrade = null; // покращення цілі поточного кроку (див. findUpgrade)
  let missWaitMs = 0;     // скільки реально чекали ціль, яку не знайшли (для логу 🎯→📍)
  // Фрейми, що так і не зʼявились за frameTimeout: наступні кроки в них чекають лише свій
  // таймаут (інакше 20 кроків форми × 30 с). Зʼявився — знову повний бюджет.
  const missingFrames = new Set();
  const resolveFor = async (a) => {
    const timeout = timeoutOf(a);
    const fkey = frameKey(a.target.frame);
    const out = {};
    const ft = fkey && missingFrames.has(fkey) ? timeout : frameTimeout;
    const r = await resolveTarget(page, a.target, { timeout, frameTimeout: ft, clock, signal, readScroll, out });
    if (!r) {
      missWaitMs = out.waitedMs || timeout;
      // Фрейму цілі немає взагалі — координати записано всередині нього, тож запасний
      // клік/друк/файл влучив би в хост-сторінку. Збій кроку з причиною.
      if (out.frameMissing && !aborted()) {
        if (fkey) missingFrames.add(fkey);
        throw new Error('фрейм «' + frameLabel(a.target.frame) + '» не зʼявився (або зник) за ' + secs(missWaitMs) + ' с — ' + targetName(a) + ' недоступна, крок не виконано');
      }
      return null;
    }
    if (fkey) missingFrames.delete(fkey);
    if (a.target.frame && r.frameMs >= 1000) log('info', '⏳ Фрейм «' + frameLabel(a.target.frame) + '» зʼявився через ' + secs(r.frameMs) + ' с');
    if (r.healed) log('info', '🔁 Ціль «' + targetName(a) + '» знайдено альтернативним локатором ' + specToString(a.target.locs[r.idx]));
    if (r.strategy === 'nth') log('info', '🎯 «' + targetName(a) + '»: ' + r.n + ' збігів — обрано найближчий до запису (#' + (r.nth + 1) + (r.dist != null ? ', ' + r.dist + 'px' : '') + ')');
    // Захист від «унікального, але не того»: збіг далеко від записаного боксу.
    let far = false;
    if (a.target.box && r.strategy !== 'nth') {
      const bb = await r.locator.boundingBox().catch(() => null);
      const sc = bb ? await readScroll(page).catch(() => null) : null;
      if (bb) {
        const d = pickNearest([{ x: bb.x + (Number(sc && sc.x) || 0), y: bb.y + (Number(sc && sc.y) || 0), w: bb.width, h: bb.height }], a.target.box).dist;
        if (d > 400) far = true;
        if (far) log('warn', '⚠️ «' + targetName(a) + '» знайдено за ' + d + 'px від місця запису — перевір крок');
      }
    }
    // Слабкий локатор (CSS-шлях / n невідомий) → чи знаходить надійніший той самий елемент?
    // Перевірка через locator.and() (selector-engine Playwright, без evaluate у світі сторінки).
    // Далекий збіг (⚠️ >400px) — сумнівний, тож ціль за ним не «покращуємо».
    try { r.upgrade = far ? null : await findUpgrade(a.target, r); } catch (_e) { r.upgrade = null; }
    stepUpgrade = r.upgrade || null;
    return r;
  };
  const findUpgrade = async (target, r) => {
    const c = upgradeCandidates(target, r.idx, r.n);
    if (c.direct != null) return { idx: c.direct };
    if (!c.list.length || !r.scope) return null;
    for (const idx of c.list) {
      let l = null;
      try { l = locatorFor(r.scope, target.locs[idx]); } catch (_e) { l = null; }
      if (!l) continue;
      if ((await l.count().catch(() => 0)) !== 1) continue;
      if ((await l.and(r.locator).count().catch(() => 0)) === 1) return { idx };
    }
    return null;
  };
  const missText = (a) => secs(missWaitMs || timeoutOf(a)) + ' с'; // скільки реально чекали ціль
  const fallbackLog = (a) => log('warn', '🎯→📍 локатор «' + pickedSpec(a) + '» не знайдено за ' + missText(a) + ' — координати');

  // Знімок viewport при збої кроку (q50, scale:'css', без зміни DOM).
  const takeFailShot = async () => {
    if (!failShots || typeof page.screenshot !== 'function') return null;
    try {
      const b = await page.screenshot({ type: 'jpeg', quality: 50, scale: 'css', caret: 'initial', timeout: 5000 });
      return 'data:image/jpeg;base64,' + b.toString('base64');
    } catch (_e) { return null; }
  };

  // Перевірка введеного наприкінці: поле, у яке друкували, стало ПОРОЖНІМ — сторінка перезаписала
  // введене (autofill з резюме, ре-рендер форми), а крок показав ✓. Лише останній текст у кожне
  // поле input/textarea; список скидається навігацією і сабмітом (⏳), поле — клавішею (Enter
  // у чаті/пошуку очищує поле законно). Комбобокси (kind select) не перевіряються: вони очищують
  // введення після вибору.
  const typedFields = [];
  const trackTyped = (a, i) => {
    if (stepNavigated || a.waitResponse === true) { typedFields.length = 0; return; }
    if (a.type === 'key' && !/^(?:Shift\+)?Tab$/.test(String(a.key || ''))) {
      const k = a.target ? typedFields.findIndex((e) => sameTarget(e.a.target, a.target)) : (prevType === 'text' ? typedFields.length - 1 : -1);
      if (k >= 0) typedFields.splice(k, 1);
      return;
    }
    if (a.type !== 'text' || !hasTarget(a) || !String(a.text || '').trim()) return;
    if (a.target.kind !== 'input' && a.target.kind !== 'textarea') return;
    const k = typedFields.findIndex((e) => sameTarget(e.a.target, a.target));
    if (k >= 0) typedFields.splice(k, 1);
    typedFields.push({ a, i });
  };
  const checkTyped = async () => {
    for (const { a, i } of typedFields) {
      if (aborted()) return;
      let v = null;
      try {
        const r = await resolveTarget(page, a.target, { timeout: 300, clock, signal, readScroll });
        if (r && (r.strategy === 'loc' || r.strategy === 'loc-alt')) v = await r.locator.inputValue({ timeout: 1000 });
      } catch (_e) { v = null; }
      if (v === '') {
        log('warn', '⚠️ ' + targetName(a) + ' (крок #' + (i + 1) + ') наприкінці ПОРОЖНЄ, хоча в нього друкували — сторінка перезаписала '
          + 'введене (autofill / ре-рендер форми?). Додай ⏱ паузу перед цим кроком або ⏳ «чекати відповідь» на кроці, що запускає обробку');
      }
    }
  };

  let replayed = 0, fileIdx = 0, clickNo = 0, lastTextTarget = null;
  let prevType = null, prevNavigated = false, prevStep = null;
  for (let i = 0; i < actions.length; i++) {
    if (aborted()) break;
    if (pendingPopup) { await pendingPopup; pendingPopup = null; }
    const a = actions[i] || {};
    send({ event: 'action', index: i }); // яка дія зараз виконується
    const t0 = clock.now();
    let ok = true, errMsg = null, strategy = null, skipped = false, healed = false;
    stepUpgrade = null;
    stepNavigated = false;
    missWaitMs = 0;
    // Фокус зараз у полі, куди щойно друкували, а клік — не в нього → натискання з фіксацією поля.
    commitBlur = a.type === 'click' && prevType === 'text' && !(lastTextTarget && a.target && sameTarget(lastTextTarget, a.target));
    try {
      if (a.disabled) {
        skipped = true;
      } else if (a.type === 'move') {
        // Рухи НІКОЛИ не скролять: ведемо мишу лише якщо точка вже у viewport.
        const m = await dom.measure(page, { insets: false });
        const { x: docX, y: docY } = toCss(a, m);
        const vx = docX, vy = docY - m.scrollY;
        strategy = 'coord';
        if (vx >= 0 && vy >= 0 && vx < m.w && vy < m.h) await moveTo(vx, vy);
        else skipped = true;
      } else if (a.type === 'click') {
        clickNo++;
        if (shouldWander({ humanize, clickNo, prevType, prevNavigated })) await wander('перед кліком #' + clickNo);
        // «чекати відповідь» (a.waitResponse): ДО кліку реєструємо збір POST-відповідей,
        // після — чекаємо їх + дорендер результату. Для сабміт-кнопок.
        const wantWait = a.waitResponse === true;
        const beforeText = wantWait ? await allFramesText(page) : null;
        // Cloudflare постійно шле фонові беакони на /cdn-cgi/challenge-platform/ — відсіюємо.
        const posts = [];
        const onResp = (resp) => {
          try { if (resp.request().method() === 'POST') {
            const u = resp.url();
            if (!/cdn-cgi\/challenge-platform/.test(u)) posts.push(resp.status() + ' ' + u);
          } } catch (_e) {}
        };
        const clickPage = page;
        if (wantWait) clickPage.on('response', onResp);
        // Клік, що відкриває вибір файлу (записаний з chooser:true): перехоплюємо
        // filechooser, щоб не зʼявився системний діалог; файл підставить наступний крок.
        const swallow = () => {};
        if (a.chooser) { try { clickPage.on('filechooser', swallow); } catch (_e) {} }
        try {
          let done = false;
          if (hasTarget(a)) {
            const t0r = clock.now();
            const r = await resolveFor(a);
            bailIfAborted(); // null через Stop ≠ «не знайдено» — без координатного запасного кліку
            if (r) {
              try {
                // Таймаут цілі — від появи фрейму (пізній iframe не зʼїдає час на сам клік).
                await locClick(r, a, t0r + (r.frameMs || 0) + timeoutOf(a));
                strategy = r.strategy; healed = r.healed; done = true;
              } catch (e) {
                if (!hasCoords(a) || aborted()) throw e;
                log('warn', '🎯→📍 «' + targetName(a) + '» знайдено, але клік не вдався (' + errText(e) + ') — координати');
              }
            } else if (hasCoords(a)) fallbackLog(a);
          }
          if (!done) {
            // Крок із ціллю, але без координат — нема куди падати. (Legacy без target —
            // як і раніше, завжди координатний шлях.)
            if (a.target && !hasCoords(a)) throw new Error(targetName(a) + ' не знайдено за ' + missText(a));
            bailIfAborted();
            strategy = await coordClick(a, i, { strict: hasTarget(a) });
          }
          if (wantWait && !aborted()) {
            send({ event: 'status', text: 'Чекаю відповідь сервера після кліку…' });
            const tr0 = Date.now();
            // мережевий спокій усіх фреймів + поява/зміна контенту результату
            await Promise.all(page.frames().map((f) => f.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})));
            const changed = await waitForResultChange(page, beforeText, 12000, { signal });
            await waitForContentSettle(page, 9000, { signal });
            log('info', '📨 POST-и (без CF-беаконів) за ' + (Date.now() - tr0) + ' мс: '
              + (posts.length ? posts.map((p) => p.slice(0, 90)).join('  |  ') : 'ЖОДНОГО'));
            log(changed ? 'info' : 'warn', changed
              ? '✅ Контент результату змінився після сабміту'
              : '⚠️ Контент НЕ змінився — схоже, форма не відправилась (валідація/клік повз кнопку?)');
          }
        } finally {
          if (wantWait) clickPage.off('response', onResp);
          if (a.chooser) { try { clickPage.off('filechooser', swallow); } catch (_e) {} }
        }
      } else if (a.type === 'text') {
        // Крок v2 з ціллю: фокус-клік, якщо фокус ще не на цьому полі (needsFocusClick).
        const focusable = a.target && (hasTarget(a) || hasCoords(a));
        if (focusable && needsFocusClick(prevStep, a)) {
          let done = false;
          if (hasTarget(a)) {
            const t0r = clock.now();
            const r = await resolveFor(a);
            bailIfAborted();
            if (r) { await locClick(r, a, t0r + (r.frameMs || 0) + timeoutOf(a)); strategy = r.strategy; healed = r.healed; done = true; }
            else if (hasCoords(a)) fallbackLog(a);
          }
          if (!done) {
            if (!hasCoords(a)) throw new Error(targetName(a) + ' не знайдено за ' + missText(a));
            bailIfAborted();
            strategy = await coordClick(a, i, { strict: hasTarget(a) });
            // Поле не знайдено локатором, а координатний клік не поставив фокус у редаговане
            // поле — друк пішов би в сторінку (гарячі клавіші сайту). Збій замість друку наосліп.
            if (hasTarget(a) && !(await dom.focusIsEditable(page))) {
              throw new Error(targetName(a) + ' не знайдено, а клік за координатами не дав фокусу полю — текст не надруковано');
            }
          }
        } else if (!a.target && prevType !== 'text' && !(await dom.focusIsEditable(page))) {
          log('warn', '⚠️ Текст без фокусу (крок #' + i + '): активний елемент не редагується — символи можуть піти в нікуди');
        }
        bailIfAborted(); // Stop після фокус-кліку — не друкуємо
        if (a.clear) { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); }
        const txt = stepText(a, rng); // {d}/{l}/{{ та legacy random
        // Наступний крок — текст у те саме поле: збереження ще попереду, не чекаємо між шматками.
        const nx = actions[i + 1];
        const more = nx && nx.type === 'text' && !nx.disabled && (!a.target || !nx.target || sameTarget(a.target, nx.target));
        await actAndSettle(async () => {
          if (humanize) await humanType(page, txt, rng);
          else await page.keyboard.type(txt, { delay: 25 });
        }, more ? { minMs: 0, quietMs: 0, maxMs: 0 } : SETTLE_TEXT);
      } else if (a.type === 'select') {
        const r = hasTarget(a) ? await resolveFor(a) : null;
        if (!r) throw new Error(targetName(a) + ' не знайдено за ' + missText(a));
        strategy = r.strategy; healed = r.healed;
        if (humanize) {
          const bb = await r.locator.boundingBox().catch(() => null);
          if (bb) { const pt = pointInBox(bbBox(bb), null, 0.15, rng); await moveTo(pt.x, pt.y); }
        }
        await actAndSettle(async () => {
          try {
            await r.locator.selectOption({ value: String(a.value) }, { timeout: 2000 });
          } catch (e) {
            if (a.label == null) throw e;
            await r.locator.selectOption({ label: String(a.label) }, { timeout: 2000 });
          }
        }, SETTLE_CLICK);
      } else if (a.type === 'key') {
        await actAndSettle(() => page.keyboard.press(String(a.key)), SETTLE_KEY);
      } else if (a.type === 'scroll') {
        const px = Number(a.vx), py = Number(a.vy);
        if (a.vx != null && a.vy != null && Number.isFinite(px) && Number.isFinite(py)) await moveTo(px, py);
        await page.mouse.wheel(Number(a.dx) || 0, Number(a.dy) || 0);
        await dom.waitScrollSettle(page, { maxMs: 1500, minMs: 120 });
      } else if (a.type === 'file') {
        const fp = resolveUpload(a.fileId, a.filename);
        if (!fp) { ok = false; errMsg = 'файл не знайдено на сервері'; }
        else {
          let input = null;
          if (hasTarget(a)) {
            const r = await resolveFor(a);
            bailIfAborted();
            if (r) { input = r.locator; strategy = r.strategy; healed = r.healed; }
            else log('warn', '🎯→📎 поле файлу «' + pickedSpec(a) + '» не знайдено — беру input[type=file] за порядком');
          }
          if (!input) {
            bailIfAborted();
            // Шукаємо input[type=file] по всіх фреймах (форма може бути в iframe).
            // Якщо поля ще немає — чекаємо довантаження контенту і пробуємо ще раз.
            let inputs = await dom.collectFileInputs(page);
            if (!inputs.length) { await waitForContentSettle(page, 4000, { signal }); inputs = await dom.collectFileInputs(page); }
            input = inputs[fileIdx] || inputs[inputs.length - 1] || null;
          }
          if (input) {
            bailIfAborted();
            const since = clock.now();
            await input.setInputFiles(fp); // підставляємо файл напряму — надійно
            fileIdx++;
            // Чекаємо завантаження (POST у фреймі форми), обробку файлу сервером і дорендер чіпа.
            const q = await waitQuiet(tracker, { ...SETTLE_FILE, since }, qopts);
            await waitForContentSettle(page, 2500, { signal });
            log('info', '📎 Файл підставлено; мережа ' + (q.quiet ? 'заспокоїлась' : 'ще активна') + ' за ' + q.ms + ' мс');
          } else { ok = false; errMsg = 'на сторінці немає поля для файлу'; }
        }
      } else {
        skipped = true;
        log('warn', '⏭ Невідомий тип під-дії «' + a.type + '» (крок #' + i + ') — пропущено');
      }
    } catch (e) {
      ok = false; errMsg = e === STOP ? STOP_MSG : errText(e);
    }
    let failShot = null, optionalSkip = false;
    if (!ok && !aborted()) {
      if (a.optional) {
        ok = true; skipped = true; optionalSkip = true;
        log('info', '⏭ Необовʼязковий крок #' + i + ' пропущено: ' + errMsg);
      } else failShot = await takeFailShot();
    }
    if (ok && !optionalSkip) replayed++;
    const ev = { event: 'done-action', index: i, ok, error: errMsg, strategy, ms: Math.round(clock.now() - t0) };
    if (skipped) ev.skipped = true;
    if (healed) ev.healed = true;
    // Ціль можна зробити надійнішою (той самий елемент, унікальний семантичний локатор) —
    // UI оновить і збереже крок. Лише для успішно виконаного кроку.
    if (ok && !skipped && stepUpgrade && a.target && a.target.locs && a.target.locs[stepUpgrade.idx]) {
      ev.upgrade = { idx: stepUpgrade.idx };
      log('info', '🎯 Ціль «' + targetName(a) + '» стане надійнішою: ' + specToString(a.target.locs[stepUpgrade.idx]) + ' (той самий елемент, 1 збіг)');
    }
    if (!ok && aborted()) ev.aborted = true; // збій через Stop — не «справжня» помилка кроку
    if (failShot) ev.failShot = failShot;
    send(ev);
    if (ok && !skipped) trackTyped(a, i);
    if (a.type === 'text' && !skipped) lastTextTarget = ok ? (a.target || null) : null;
    // prevStep — лише крок, виконаний за ЛОКАТОРОМ: після запасного координатного кліку фокус під
    // сумнівом, тож наступний текст у те саме поле шукає своє поле сам (needsFocusClick).
    if (a.type !== 'move' && !skipped) { prevType = a.type; prevNavigated = stepNavigated; prevStep = ok && !isCoordFallback(a, strategy) ? a : null; }
    if (aborted()) break;
    // Пауза, задана користувачем на кроці («⏱ пауза після») — лише якщо крок виконувався
    // (не вимкнений / не пропущений). Діє і для останнього кроку (перед фінальним скрином).
    const extra = skipped ? 0 : delayAfterMs(a);
    if (extra) {
      log('info', '⏱ Пауза ' + extra + ' мс після кроку #' + (i + 1));
      // Окрема подія — щоб UI показав «⏱ пауза», а не «виконується наступний крок».
      send({ event: 'pause', index: i, ms: extra });
    }
    await pause(pauseAfter(a, actions[i + 1], humanize, rint) + extra);
  }

  if (!aborted() && typedFields.length) await checkTyped();

  if (ctx && typeof ctx.off === 'function') { try { ctx.off('page', onNewPage); } catch (_e) {} }
  for (const p of dialogPages) { try { p.off('dialog', onDialog); } catch (_e) {} }
  if (tracker) tracker.dispose();
  return { replayed, page, aborted: aborted() };
}

// Назва за synth.md: спільний виконавець кроків (той самий цикл).
export const runSteps = runReplay;

// Сумісний інтерфейс: повертає лише кількість успішних під-дій.
export async function replayActions(page, actions, env) {
  return (await runReplay(page, actions, env)).replayed;
}
