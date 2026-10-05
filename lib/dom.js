// Браузер-залежні DOM-хелпери відтворення: вимір viewport, детермінована
// прокрутка до цілі (scrollDocTo), hit-test під точкою з урахуванням iframe,
// snap до найближчого видимого контрола, пошук input[type=file], перевірка фокусу.
// Усе — read-only зонди (стилі сторінки НЕ змінюємо: stealth), крім самого scrollTo.
// Рішення приймають чисті функції з lib/coords.js.
//
// Світ виконання (stealth): у Chromium зонди йдуть у ПРИВАТНИЙ ізольований світ
// (lib/isoworld.js, CDP) — обгортки сторінки над querySelectorAll/elementFromPoint/
// getComputedStyle/getBoundingClientRect/rAF їх не бачать. У Camoufox (без CDP) —
// frame.evaluate (там він і так ізольований). Функції *_FN — самодостатні (без
// замикань), бо серіалізуються в рядок.
import { nearestRect, scrollPlan, INTERACTIVE_SEL } from './coords.js';
import { waitScrollSettle as waitScrollSettleRaw } from './settle.js';
import { isoState, evalMain } from './isoworld.js';

export { evalMain };

// Вимір viewport + висоти фіксованих/sticky шапки й футера (topInset/bottomInset),
// щоб ціль не опинилась під ними. Міряємо ПЕРЕД кожною координатною дією
// (ширина документа могла змінитись: зʼявився скролбар, догрузився контент).
export const MEASURE_FN = (withInsets) => {
  const se = document.scrollingElement || document.documentElement;
  const H = innerHeight, W = innerWidth;
  const insetAt = (y, top) => {
    let best = 0;
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const els = document.elementsFromPoint ? document.elementsFromPoint(W * fx, y).slice(0, 3) : [];
      for (const el of els) {
        for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
          const pos = getComputedStyle(n).position;
          if (pos === 'fixed' || pos === 'sticky') {
            const r = n.getBoundingClientRect();
            if (r.height > 0 && r.height < H * 0.4) best = Math.max(best, top ? r.bottom : H - r.top);
            break;
          }
        }
      }
    }
    return Math.max(0, Math.min(Math.round(best), Math.round(H * 0.4)));
  };
  return {
    w: W, h: H, dpr: window.devicePixelRatio || 1,
    sw: document.documentElement.scrollWidth, sh: Math.max(se.scrollHeight, document.documentElement.scrollHeight),
    scrollY: window.scrollY,
    topInset: withInsets ? insetAt(1, true) : 0, bottomInset: withInsets ? insetAt(H - 2, false) : 0,
  };
};
// insets:false — легкий вимір (для рухів миші), без пошуку фіксованих шапок.
export async function measure(page, { insets = true } = {}) {
  return evalMain(page, MEASURE_FN, insets);
}

// Очікування, доки прокрутка вляжеться — вимір у тому ж (ізольованому) світі.
export function waitScrollSettle(page, opts = {}, deps = {}) {
  return waitScrollSettleRaw(page, opts, { evaluate: (fn) => evalMain(page, fn), ...deps });
}

export async function readScrollY(page) {
  return evalMain(page, () => window.scrollY);
}
export async function readScrollXY(page) {
  return evalMain(page, () => ({ x: window.scrollX, y: window.scrollY }));
}

const SCROLL_TO_FN = (top) => { window.scrollTo({ top, left: window.scrollX, behavior: 'instant' }); return window.scrollY; };

// Прокрутка під ціль docY — ЛИШЕ якщо ціль поза безпечною смугою (scrollPlan).
// Миттєво (behavior:'instant' перекриває CSS scroll-behavior:smooth за специфікацією,
// без зміни inline-стилів), потім чекаємо, доки scrollY однаковий 2 кадри (≤1с),
// і повертаємо ВИМІРЯНИЙ scrollY. → { scrollY, scrolled, m }
export async function scrollDocTo(page, docY, { margin = 80, m = null } = {}) {
  m = m || await measure(page);
  const plan = scrollPlan(docY, m.scrollY, m.h, m.sh, { margin, topInset: m.topInset, bottomInset: m.bottomInset });
  if (!plan.scroll) return { scrollY: m.scrollY, scrolled: false, m };
  await evalMain(page, SCROLL_TO_FN, plan.scrollY);
  const s = await waitScrollSettle(page, { maxMs: 1000 });
  return { scrollY: s.scrollY, scrolled: true, m };
}

// Hit-test у фреймі (точка в координатах viewport ЦЬОГО фрейму).
//   fixed  — предок position:fixed (та сама позиція у viewport за будь-якого scrollY);
//   sticky — предок position:sticky (позиція у viewport ЗАЛЕЖИТЬ від scrollY);
//   fbox   — для <iframe>/<frame>: зсув і розмір вмісту (рамка/паддінг);
//   stash  — (лише ізольований світ) запамʼятати iframe для DOM.describeNode.
export const HIT_FN = ({ x, y, sel, stash }) => {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  let e = document.elementFromPoint(x, y);
  if (!e) return null;
  // відкриті shadow root — до найглибшого елемента
  for (let k = 0; k < 10 && e.shadowRoot; k++) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  const ia = e.closest ? e.closest(sel) : null;
  const cs = getComputedStyle(e);
  const pointer = cs.cursor === 'pointer';
  let optionLike = false, fixed = false, sticky = false, k = 0;
  for (let n = e; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null, k++) {
    if (k < 4 && !optionLike) {
      const cls = typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '';
      if (/(^|[\s_-])(option|menu-?item|dropdown-?item|select__option|listbox-?item)/i.test(cls + ' ' + (n.id || ''))
        || n.hasAttribute('aria-selected')) optionLike = true;
    }
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed') fixed = true;
    else if (pos === 'sticky') sticky = true;
    if (k > 60) break;
  }
  const t = ia || e;
  const txt = ia ? (ia.innerText || ia.value || '') : (e.textContent || '');
  let fbox = null;
  if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
    const r = e.getBoundingClientRect(), fcs = getComputedStyle(e);
    fbox = {
      x: r.left + e.clientLeft + (parseFloat(fcs.paddingLeft) || 0),
      y: r.top + e.clientTop + (parseFloat(fcs.paddingTop) || 0),
      w: e.clientWidth, h: e.clientHeight,
    };
    if (stash) globalThis.__srsHitFrame = e;
  }
  return {
    tag: e.tagName, type: e.getAttribute('type') || '',
    interactive: !!ia, itag: ia ? ia.tagName : null, pointer, optionLike, fixed, sticky,
    expanded: !!(ia && ia.getAttribute('aria-expanded') === 'true'),
    text: (txt || t.getAttribute('placeholder') || t.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    fbox,
  };
};
const TAKE_STASH = (name) => '(() => { const e = globalThis.' + name + '; globalThis.' + name + ' = null; return e || null; })()';

// Зсув вмісту дочірнього фрейму у viewport батьківського фрейму + чи саме цей
// <iframe> під точкою (а не перекритий модалкою).
export const FRAME_BOX_FN = (el, { px, py } = {}) => {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const x = r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0);
  const y = r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0);
  let hit = true;
  if (px != null) { const top = document.elementFromPoint(px, py); hit = top === el; }
  return { x, y, w: el.clientWidth, h: el.clientHeight, hit };
};

export async function childFramesWithBox(frame, px, py) {
  const out = [];
  for (const cf of frame.childFrames ? frame.childFrames() : []) {
    const fe = await cf.frameElement().catch(() => null);
    if (!fe) continue;
    const box = await fe.evaluate(FRAME_BOX_FN, { px, py }).catch(() => null);
    if (box) out.push({ frame: cf, box });
  }
  return out;
}

// Що під точкою (vx,vy у координатах головного viewport): спускаємось у
// той iframe, який реально під точкою (з урахуванням рамки/паддінгу), тож
// крос-доменні форми (Ashby) теж. Повертає опис + interactive/fixed/sticky/pointer.
export async function elementAt(page, vx, vy) {
  const iso = await isoState(page);
  if (iso) return isoHit(iso, null, vx, vy, 0, 0, 0);
  return hitFrame(page.mainFrame(), vx, vy, 0, 0, 0, page);
}
// Ізольований світ: фрейм = ref {sess, frameId}; дочірній — через describeNode.
async function isoHit(iso, ref, vx, vy, ox, oy, depth) {
  const lx = vx - ox, ly = vy - oy;
  const info = await iso.evaluate(ref, HIT_FN, { x: lx, y: ly, sel: INTERACTIVE_SEL, stash: true }).catch(() => null);
  if (!info) return null;
  const { fbox, ...rest } = info;
  const res = { frame: depth === 0 ? 'main' : 'iframe', ...rest };
  if (fbox) {
    const child = depth < 5 ? await iso.childRef(ref, TAKE_STASH('__srsHitFrame')).catch(() => null) : null;
    if (child) {
      const sub = await isoHit(iso, child, vx, vy, ox + fbox.x, oy + fbox.y, depth + 1);
      if (sub) return sub;
    }
  }
  return res;
}
async function hitFrame(frame, vx, vy, ox, oy, depth, page) {
  const lx = vx - ox, ly = vy - oy;
  const raw = await frame.evaluate(HIT_FN, { x: lx, y: ly, sel: INTERACTIVE_SEL }).catch(() => null);
  if (!raw) return null;
  const { fbox: _fb, ...info } = raw;
  const res = { frame: depth === 0 ? 'main' : 'iframe', ...info };
  const tag = String(info.tag).toUpperCase();
  if ((tag === 'IFRAME' || tag === 'FRAME') && depth < 5) {
    for (const { frame: cf, box } of await childFramesWithBox(frame, lx, ly)) {
      if (!box.hit) continue;
      const sub = await hitFrame(cf, vx, vy, ox + box.x, oy + box.y, depth + 1, page);
      if (sub) return sub;
    }
  }
  return res;
}

// Кандидати для snap у фреймі: видимі (не перекриті) контроли в радіусі maxDist.
// Один evaluate на фрейм (а не boundingBox на кожен елемент). Пропускаємо
// відкривачі з aria-expanded=true (snap на них закрив би відкрите меню).
export const SNAP_FN = ({ x, y, sel, maxDist }) => {
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) continue;
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    if (Math.hypot(dx, dy) > maxDist) continue;
    if (el.getAttribute('aria-expanded') === 'true' || el.disabled) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
    const top = document.elementFromPoint(cx, cy);
    const visible = top && (top === el || el.contains(top) || (top.tagName === 'LABEL' && top.control === el));
    if (!visible) continue;
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
};

export const SNAP_SEL = 'button, a[href], input:not([type=hidden]), textarea, select, label, [role="button"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [role="tab"], [role="switch"], [onclick]';

// Найближчий до точки видимий клікабельний елемент по ВСІХ фреймах → центр
// (у координатах головного viewport) + відстань, або null.
// <iframe>/<frame> фрейму: бокс вмісту (у viewport фрейму); stash — запамʼятати
// елементи (ізольований світ) для DOM.describeNode.
export const IFRAMES_FN = ({ stash }) => {
  const els = Array.from(document.querySelectorAll('iframe, frame'));
  if (stash) globalThis.__srsFrames = els;
  return els.map((el, i) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return {
      i, x: r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0),
      w: el.clientWidth, h: el.clientHeight,
    };
  });
};

export async function snapToClickable(page, vx, vy, maxDist = 60) {
  const iso = await isoState(page);
  if (iso) return isoSnap(iso, vx, vy, maxDist);
  const rects = [];
  async function walk(frame, ox, oy, depth) {
    const rs = await frame.evaluate(SNAP_FN, { x: vx - ox, y: vy - oy, sel: SNAP_SEL, maxDist }).catch(() => []);
    for (const r of rs) rects.push({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h });
    if (depth >= 5) return;
    for (const { frame: cf, box } of await childFramesWithBox(frame, null, null)) {
      const fx = ox + box.x, fy = oy + box.y;
      // фрейм поза радіусом — пропускаємо
      const dx = Math.max(fx - vx, 0, vx - (fx + box.w)), dy = Math.max(fy - vy, 0, vy - (fy + box.h));
      if (Math.hypot(dx, dy) > maxDist) continue;
      await walk(cf, fx, fy, depth + 1);
    }
  }
  await walk(page.mainFrame(), 0, 0, 0);
  return nearestRect(vx, vy, rects, maxDist);
}

async function isoSnap(iso, vx, vy, maxDist) {
  const rects = [];
  async function walk(ref, ox, oy, depth) {
    const rs = await iso.evaluate(ref, SNAP_FN, { x: vx - ox, y: vy - oy, sel: SNAP_SEL, maxDist }).catch(() => []);
    for (const r of rs || []) rects.push({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h });
    if (depth >= 5) return;
    const boxes = await iso.evaluate(ref, IFRAMES_FN, { stash: true }).catch(() => []);
    for (const box of boxes || []) {
      const fx = ox + box.x, fy = oy + box.y;
      const dx = Math.max(fx - vx, 0, vx - (fx + box.w)), dy = Math.max(fy - vy, 0, vy - (fy + box.h));
      if (Math.hypot(dx, dy) > maxDist) continue; // фрейм поза радіусом
      const child = await iso.childRef(ref, '(globalThis.__srsFrames || [])[' + Number(box.i) + '] || null').catch(() => null);
      if (child) await walk(child, fx, fy, depth + 1);
    }
    await iso.evaluate(ref, () => { globalThis.__srsFrames = null; }).catch(() => {});
  }
  await walk(null, 0, 0, 0);
  return nearestRect(vx, vy, rects, maxDist);
}

// fn(arg) у КОЖНОМУ фреймі сторінки → масив результатів (порядок стабільний між
// викликами). Chromium — обхід дерева iframe в ізольованих світах (до 5 рівнів);
// інакше — page.frames() + frame.evaluate. Помилка фрейму → onError(e) (дефолт null).
export async function evalAllFrames(page, fn, arg, { onError = () => null } = {}) {
  const iso = await isoState(page);
  if (!iso) {
    const out = [];
    for (const f of page.frames()) out.push(await f.evaluate(fn, arg).catch(onError));
    return out;
  }
  const out = [];
  async function walk(ref, depth) {
    out.push(await iso.evaluate(ref, fn, arg).catch(onError));
    if (depth >= 5) return;
    const boxes = await iso.evaluate(ref, IFRAMES_FN, { stash: true }).catch(() => []);
    for (const box of boxes || []) {
      const child = await iso.childRef(ref, '(globalThis.__srsFrames || [])[' + Number(box.i) + '] || null').catch(() => null);
      if (child) await walk(child, depth + 1);
    }
  }
  await walk(null, 0);
  return out;
}

// Збирає всі <input type="file"> з головного фрейму та всіх iframe.
export async function collectFileInputs(page) {
  const inputs = [];
  for (const fr of page.frames()) {
    const hs = await fr.$$('input[type="file"]').catch(() => []);
    inputs.push(...hs);
  }
  return inputs;
}

// Чи є фокус у редагованому полі (в будь-якому фреймі) — для попередження
// «текст без фокусу». Read-only. → 'edit' | 'frame' (фокус в iframe) | 'no'.
export const FOCUS_FN = ({ stash } = {}) => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'no';
  if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') { if (stash) globalThis.__srsFocus = a; return 'frame'; }
  if (a.isContentEditable) return 'edit';
  if (a.tagName === 'TEXTAREA') return !a.readOnly && !a.disabled ? 'edit' : 'no';
  if (a.tagName === 'INPUT') return !a.readOnly && !a.disabled && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(a.type) ? 'edit' : 'no';
  return 'no';
};
export async function focusIsEditable(page) {
  const iso = await isoState(page);
  if (iso) {
    // Ланцюг activeElement крізь iframe (до 5 рівнів).
    let ref = null;
    for (let d = 0; d <= 5; d++) {
      const r = await iso.evaluate(ref, FOCUS_FN, { stash: true }).catch(() => 'no');
      if (r !== 'frame') return r === 'edit';
      ref = await iso.childRef(ref, TAKE_STASH('__srsFocus')).catch(() => null);
      if (!ref) return false;
    }
    return false;
  }
  for (const f of page.frames()) {
    const ok = await f.evaluate(FOCUS_FN, {}).catch(() => 'no');
    if (ok === 'edit') return true;
  }
  return false;
}

// Перша «нейтральна» точка для колеса: під нею немає внутрішнього скролера
// (dropdown/модалка/overflow-контейнер), iframe чи інтерактивного елемента —
// тож колесо прокрутить лише сам документ. → {x,y} або null.
export const NEUTRAL_FN = ({ pts, sel }) => {
    for (const p of pts) {
      if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) continue;
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) continue;
      if (el.closest(sel)) continue;
      let bad = false;
      for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        if (n.tagName === 'IFRAME' || n.tagName === 'FRAME' || n.tagName === 'SELECT' || n.tagName === 'TEXTAREA') { bad = true; break; }
        const cs = getComputedStyle(n);
        if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) { bad = true; break; }
        if (/(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) { bad = true; break; }
      }
      if (!bad) return p;
    }
    return null;
};
export async function pickNeutralPoint(page, candidates) {
  return evalMain(page, NEUTRAL_FN, { pts: candidates, sel: INTERACTIVE_SEL }).catch(() => null);
}
