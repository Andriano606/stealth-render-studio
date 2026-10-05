// Навігація та очікування: Cloudflare-aware goto, «заспокоєння» контенту,
// текст усіх фреймів, очікування результату сабміту, autoScroll для lazy-контенту.
// Чиста частина — isChallenge(title, body, marker) (юніт-тестована).
import { rint } from './rng.js';
import { evalMain } from './isoworld.js';
import * as realDom from './dom.js';

// Текстові ознаки інтерстиціалу Cloudflare (кілька мов).
export const CF_TEXT_RE = /just a moment|checking your browser|attention required|verifying you are|performing security verification|security service to protect|cf-browser-verification|needs to review the security|un momento|трохи зачекайте|перевірка безпеки|перевіряє/i;
// Мовно-незалежний маркер САМЕ інтерстиціалу челенджу (не фонового скрипта
// bot-management, який присутній на звичайних сайтах за Cloudflare).
export const CF_MARKER_SELECTOR = '#challenge-running, #challenge-stage, #cf-challenge-running, #trk_jschal_js';

// Чи зараз на екрані челендж: DOM-маркер або текст у title/body.
export function isChallenge(title, body, marker) {
  return !!marker || CF_TEXT_RE.test(String(title || '')) || CF_TEXT_RE.test(String(body || ''));
}

// Чекає проходження Cloudflare-челенджу («Just a moment…»): опитує title/контент,
// поки заставка не зникне й не з'явиться реальна сторінка (або таймаут).
export async function waitPastCloudflare(page, maxMs = 40000, { rng = Math.random } = {}) {
  const ri = (a, b) => rint(a, b, rng);
  const start = Date.now();
  let wasChallenge = false, iter = 0;
  while (Date.now() - start < maxMs) {
    iter++;
    let title = '', body = '', marker = false;
    try { title = (await page.title()) || ''; } catch (_e) {}
    try { body = await evalMain(page, () => (document.body ? document.body.innerText.slice(0, 600) : '')); } catch (_e) {}
    // Мовно-незалежний маркер САМЕ інтерстиціалу челенджу (не фонового скрипта
    // bot-management, який присутній на звичайних сайтах за Cloudflare).
    try {
      marker = await evalMain(page, (sel) => !!document.querySelector(sel), CF_MARKER_SELECTOR);
    } catch (_e) {}
    const onChallenge = isChallenge(title, body, marker);
    if (onChallenge) {
      wasChallenge = true;
      // ЛЮДСЬКА АКТИВНІСТЬ поки крутиться челендж — Cloudflare Managed Challenge
      // пропускає, коли бачить ознаки живого користувача (рухи миші).
      try { await page.mouse.move(ri(80, 1000), ri(80, 650), { steps: ri(6, 16) }); } catch (_e) {}
      if (iter % 3 === 0) { try { await page.mouse.wheel(0, ri(-60, 160)); } catch (_e) {} }
      await page.waitForTimeout(ri(900, 1400));
      continue;
    }
    // Челенджу зараз немає.
    // Якщо його НІКОЛИ не було — це звичайна сторінка (контент може бути в iframe),
    // не чекаємо даремно: одразу далі. Cloudflare-челендж завжди присутній одразу
    // в початковому HTML, тож пара перших перевірок його б уже зловила.
    if (!wasChallenge) { if (iter >= 2) return { passed: true, wasChallenge: false }; await page.waitForTimeout(300); continue; }
    // Був челендж і зник → переконаємось, що з'явився реальний контент.
    if (body.replace(/\s+/g, '').length > 80 || Date.now() - start > 2000) return { passed: true, wasChallenge };
    await page.waitForTimeout(500);
  }
  return { passed: false, wasChallenge };
}

// Навігація, стійка до Cloudflare: domcontentloaded + очікування проходження челенджу.
export async function gotoSmart(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const cf = await waitPastCloudflare(page);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  return { resp, cf };
}

export async function waitForContentSettle(page, maxMs = 9000, { signal } = {}) {
  const start = Date.now();
  let prev = -1, stable = 0;
  while (Date.now() - start < maxMs) {
    if (signal && signal.aborted) return;
    // Зонди — в ізольованому світі (Chromium): обгортки сторінки їх не бачать.
    const lens = await realDom.evalAllFrames(page, () => (document.body ? document.body.innerText.length : 0), undefined, { onError: () => 0 }).catch(() => [0]);
    const total = lens.reduce((a, b) => a + (Number(b) || 0), 0);
    if (total > 0 && total === prev) { if (++stable >= 2) break; }
    else { stable = 0; prev = total; }
    await page.waitForTimeout(500);
  }
}

// Текст з УСІХ фреймів (головного + iframe) — для детекції появи результату сабміту.
export async function allFramesText(page) {
  const parts = await realDom.evalAllFrames(page, () => (document.body ? document.body.innerText : ''), undefined, { onError: () => '' }).catch(() => []);
  return parts.join('');
}
// Чекає, доки контент (у будь-якому фреймі) зміниться відносно `before` — тобто
// з'явиться результат сабміту (напр. «Application received» у формі Ashby).
export async function waitForResultChange(page, before, maxMs = 9000, { signal } = {}) {
  const start = Date.now();
  const norm = (s) => s.replace(/\s+/g, '');
  const b = norm(before);
  while (Date.now() - start < maxMs) {
    if (signal && signal.aborted) return false;
    const now = norm(await allFramesText(page));
    if (now !== b && Math.abs(now.length - b.length) >= 5) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

// Сценарій прокрутки сторінки ВСЕРЕДИНІ сторінки (виконується в ізольованому світі
// Chromium — обгортки сторінки над querySelectorAll/getComputedStyle його не бачать).
//   eager:true  (/render) — ще й форсує lazy-зображення/iframe (loading='eager',
//                data-src → src), щоб fullPage-скриншот був повним;
//   eager:false (/replay) — БЕЗ мутацій DOM: крокова прокрутка й так запускає нативний
//                lazy-load і IntersectionObserver.
export const AUTOSCROLL_FN = async ({ eager }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Знаходимо реальний елемент прокрутки: або window, або найвищий контейнер
  // з внутрішнім скролом (деякі сайти скролять не body, а div).
  function scrollHeightOf(el) { return el === window ? document.scrollingElement.scrollHeight : el.scrollHeight; }
  let scroller = window;
  let maxH = document.scrollingElement.scrollHeight;
  document.querySelectorAll('*').forEach((el) => {
    const st = getComputedStyle(el);
    if ((st.overflowY === 'auto' || st.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 200 && el.scrollHeight > maxH) {
      maxH = el.scrollHeight; scroller = el;
    }
  });
  // behavior:'instant' — перекриває CSS scroll-behavior:smooth (без зміни стилів сторінки),
  // інакше кроки «анімуються» і lazy-контент не встигає довантажитись.
  const doScroll = (y) => (scroller === window
    ? window.scrollTo({ top: y, left: 0, behavior: 'instant' })
    : scroller.scrollTo({ top: y, left: scroller.scrollLeft, behavior: 'instant' }));
  const vh = scroller === window ? window.innerHeight : scroller.clientHeight;

  // Крокуємо донизу з паузами, щоб довантажувався lazy-контент.
  let last = -1;
  for (let i = 0; i < 80; i++) {
    const h = scrollHeightOf(scroller);
    doScroll(i * Math.floor(vh * 0.8));
    await sleep(160);
    if (i * Math.floor(vh * 0.8) >= h - vh) {
      if (h === last) break; // висота перестала рости — весь контент довантажено
      last = h;
    }
  }
  if (eager) {
    // Форсуємо завантаження lazy-зображень/iframe (лише /render — для повного скрина)
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
      el.loading = 'eager';
      if (el.dataset && el.dataset.src && !el.src) el.src = el.dataset.src;
    });
  }
  doScroll(0);
};

// Порція колеса для людської прокрутки (60–90% висоти viewport) — чиста.
export function wheelChunk(vh, rng = Math.random) {
  return Math.max(120, Math.round(Number(vh || 900) * (0.6 + 0.3 * rng())));
}
// Чи дійшли до низу документа (допуск 2 px) — чиста.
export function sweepAtBottom(m) {
  return Number(m.scrollY) + Number(m.h) >= Number(m.sh) - 2;
}

// Людська прокрутка донизу й назад колесом миші (page.mouse.wheel — справжні
// wheel-події з Node, а не scrollTo зі сторінки) у нейтральній точці (не над
// списком/скролером/iframe). Стоп: низ документа і висота стабільна 2 виміри.
// → true; false — немає нейтральної точки / колесо не крутить документ (тоді
// викликач робить звичайний autoScroll).
// deps — інʼєкція для тестів: { measure, pickNeutralPoint, waitScrollSettle, candidates }.
export async function wheelSweep(page, { rng = Math.random, signal = null, deps = null } = {}) {
  const d = deps || realDom;
  const ri = (a, b) => rint(a, b, rng);
  const aborted = () => !!(signal && signal.aborted);
  let m = await d.measure(page, { insets: false });
  const cands = d.candidates ? d.candidates(m) : [
    { x: Math.round(m.w * 0.03), y: Math.round(m.h / 2) }, { x: Math.round(m.w * 0.97), y: Math.round(m.h / 2) },
    { x: Math.round(m.w * 0.5), y: Math.round(m.h * 0.5) }, { x: Math.round(m.w * 0.2), y: Math.round(m.h * 0.7) },
  ];
  const pt = await d.pickNeutralPoint(page, cands);
  if (!pt) return false;
  await page.mouse.move(pt.x, pt.y, { steps: ri(8, 16) });
  let stable = 0, lastH = -1, stuck = 0, prevY = m.scrollY;
  for (let i = 0; i < 150 && !aborted(); i++) {
    if (sweepAtBottom(m)) {
      if (m.sh === lastH) { if (++stable >= 2) break; } else stable = 0;
      lastH = m.sh;
      await page.waitForTimeout(ri(250, 700)); // чекаємо, чи догрузиться ще
    } else {
      await page.mouse.wheel(0, wheelChunk(m.h, rng));
      await page.waitForTimeout(ri(250, 700));
    }
    m = await d.measure(page, { insets: false });
    if (!sweepAtBottom(m) && Math.abs(m.scrollY - prevY) < 1) { if (++stuck >= 3) return false; } else stuck = 0;
    prevY = m.scrollY;
  }
  // Назад угору порціями (а не стрибком у 0).
  for (let i = 0; i < 150 && !aborted() && m.scrollY > 0; i++) {
    await page.mouse.wheel(0, -Math.min(Math.ceil(m.scrollY), 2 * wheelChunk(m.h, rng)));
    await page.waitForTimeout(ri(120, 350));
    const before = m.scrollY;
    m = await d.measure(page, { insets: false });
    if (Math.abs(m.scrollY - before) < 1) break;
  }
  await d.waitScrollSettle(page, { maxMs: 1000, minMs: 120 });
  return true;
}

// autoScroll: mode 'render' (дефолт; з форсуванням lazy) | 'replay' (без мутацій DOM;
// з humanize — людське колесо, wheelSweep). Помилки ігноруються.
export async function autoScroll(page, { mode = 'render', humanize = false, rng = Math.random, signal = null } = {}) {
  try {
    let done = false;
    if (mode === 'replay' && humanize) done = await wheelSweep(page, { rng, signal }).catch(() => false);
    if (!done && !(signal && signal.aborted)) await evalMain(page, AUTOSCROLL_FN, { eager: mode !== 'replay' });
    // Чекаємо, доки довантажене "заспокоїться"
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
  } catch (_e) { /* ігноруємо */ }
}


// Підготовка сторінки до взаємодії — ТА САМА, що в /render перед скриншотом,
// на якому користувач записує: заспокоєння контенту (iframe-и) + autoScroll
// (lazy-зображення/IntersectionObserver-блоки отримують реальну висоту) і назад
// угору. Тоді верстка під час відтворення збігається з версткою скриншота запису.
// opts: { signal, mode ('render'|'replay'), humanize, rng } — див. autoScroll.
export async function prepareForInteraction(page, { signal, mode = 'render', humanize = false, rng } = {}) {
  await waitForContentSettle(page, 9000, { signal });
  if (signal && signal.aborted) return;
  await autoScroll(page, { mode, humanize, rng, signal });
}
