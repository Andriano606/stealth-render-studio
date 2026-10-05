// Очікування «стану», а не часу: мережевий спокій після дії (waitQuiet) і
// заспокоєння прокрутки (waitScrollSettle). Мережу рахуємо на боці Node з подій
// Playwright (request / requestfinished / requestfailed) — жодного JS у сторінці.
// Годинник/сон інʼєктуються ({ now, sleep }) — для детермінованих тестів.
import { scrollSettled } from './coords.js';

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Трекер запитів у польоті. emitter — сторінка Playwright (або фейк з on/off).
// Події page.on('request') покривають і всі iframe сторінки.
export function createNetTracker(emitter, { now = realClock.now } = {}) {
  const inflight = new Map(); // request → час старту
  let lastEvent = -Infinity;  // час останньої мережевої події (старт/фініш)
  const onReq = (r) => { inflight.set(r, now()); lastEvent = now(); };
  const onDone = (r) => { inflight.delete(r); lastEvent = now(); };
  const on = (ev, fn) => { try { emitter.on(ev, fn); } catch (_e) {} };
  const off = (ev, fn) => { try { (emitter.off || emitter.removeListener).call(emitter, ev, fn); } catch (_e) {} };
  on('request', onReq); on('requestfinished', onDone); on('requestfailed', onDone);
  return {
    // Скільки запитів у польоті, ігноруючи «довгожителів» (long-poll, SSE,
    // аналітика), старших за ignoreOlderMs — вони не повинні блокувати дію.
    pending(ignoreOlderMs = 3000) {
      const t = now();
      let n = 0;
      for (const [r, t0] of inflight) {
        if (t - t0 < ignoreOlderMs) n++;
        else if (t - t0 > 60000) inflight.delete(r); // прибираємо назавжди завислі
      }
      return n;
    },
    lastEventAt() { return lastEvent; },
    dispose() { off('request', onReq); off('requestfinished', onDone); off('requestfailed', onDone); inflight.clear(); },
  };
}

// Чекає мережевий спокій після дії: мінімум minMs; далі — щойно немає (свіжих)
// запитів у польоті і жодної мережевої події вже quietMs; максимум maxMs.
// → { quiet: boolean, ms, aborted? }
export async function waitQuiet(tracker, opts = {}, { now = realClock.now, sleep = realClock.sleep, signal } = {}) {
  const { minMs = 150, quietMs = 300, maxMs = 2500, ignoreOlderMs = 3000, pollMs = 50 } = opts;
  const start = now();
  for (;;) {
    const t = now(), el = t - start;
    if (signal && signal.aborted) return { quiet: false, ms: el, aborted: true };
    const busy = tracker ? tracker.pending(ignoreOlderMs) : 0;
    const idleFor = tracker ? t - tracker.lastEventAt() : Infinity;
    if (el >= minMs && busy === 0 && idleFor >= quietMs) return { quiet: true, ms: el };
    if (el >= maxMs) return { quiet: false, ms: el };
    await sleep(Math.max(1, Math.min(pollMs, maxMs - el)));
  }
}

// Один вимір scrollY на наступному кадрі (rAF; запасний таймер — якщо кадри не йдуть).
const SAMPLE_FN = () => new Promise((resolve) => {
  let done = false;
  const fin = () => { if (!done) { done = true; resolve(window.scrollY); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 100);
});

// Чекає, доки прокрутка вляжеться: scrollY однаковий на 2 кадрах поспіль
// (ліміт maxMs). minMs — для колеса (анімація стартує не одразу).
// evaluate(fn) — де виконати вимір (lib/dom.js передає ізольований світ Chromium,
// щоб rAF/setTimeout не було видно обгорткам сторінки); за замовчуванням page.evaluate.
// → { settled, scrollY, ms }
export const SCROLL_SAMPLE_FN = SAMPLE_FN;
export async function waitScrollSettle(page, { maxMs = 1000, minMs = 0, n = 2 } = {}, { now = realClock.now, evaluate = null } = {}) {
  const start = now();
  const samples = [];
  const ev = evaluate || ((fn) => page.evaluate(fn));
  for (;;) {
    let y;
    try { y = await ev(SAMPLE_FN); } catch (_e) { return { settled: false, scrollY: samples.at(-1) ?? 0, ms: now() - start }; }
    samples.push(y);
    const el = now() - start;
    if (el >= minMs && scrollSettled(samples, n)) return { settled: true, scrollY: y, ms: el };
    if (el >= maxMs) return { settled: false, scrollY: y, ms: el };
  }
}
