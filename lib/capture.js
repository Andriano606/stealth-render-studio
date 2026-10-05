// Захоплення цілі під час ЖИВОГО запису (і hover-inspect): що під точкою,
// опис елемента (DESCRIBE_FN), ланцюг iframe і лічильники кандидатів-локаторів.
//
// Світи виконання:
//   • HIT_HANDLE_FN / DESCRIBE_FN / IFRAME_DESC_FN лише ЧИТАЮТЬ DOM і не торкаються
//     глобалів сторінки (у Camoufox evaluate працює в ізольованому світі — там
//     доступні лише DOM-API). Викликаються лише для живих дій/inspect, НЕ в /replay.
//   • countCandidates — локатори Playwright (count/boundingBox — утилітний світ).
//
// Координати: desc.box, який повертає hitTest, — у CSS px ДОКУМЕНТА ГОЛОВНОЇ
// сторінки (для головного фрейму = документ фрейму). Так target.box і точка кліку
// (x, y кроку) в одній системі, а /replay порівнює бокси збігів (boundingBox +
// scroll) з target.box без знання про зсуви iframe.
import { INTERACTIVE_SEL } from './coords.js';
import { FRAME_BOX_FN } from './dom.js';
import { toPlaywright, frameSpecFrom, buildCandidates, targetFromDesc, MAX_LOCS } from './locators.js';

// Найглибший елемент під точкою (x, y — viewport ЦЬОГО фрейму): крізь відкриті
// shadow root, з підйомом до найближчого інтерактивного предка (теж крізь shadow
// host). <iframe> повертається як є (далі спускаємось у його фрейм).
export const HIT_HANDLE_FN = ({ x, y, sel }) => {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  let e = document.elementFromPoint(x, y);
  if (!e) return null;
  for (let k = 0; k < 10 && e.shadowRoot; k++) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') return e;
  for (let n = e, k = 0; n && k < 60; k++) {
    if (n.nodeType === 1 && n.matches && n !== document.body && n !== document.documentElement && n.matches(sel)) return n;
    n = n.parentElement || (n.getRootNode && n.getRootNode() !== document ? n.getRootNode().host : null) || null;
  }
  return e;
};

// Опис елемента РІВНО у формі ElementDesc (lib/locators.js) + vbox (бокс у
// viewport фрейму) — для перерахунку в координати головної сторінки.
export const DESCRIBE_FN = (el) => {
  const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const cut = (s, n = 200) => { const t = norm(s); return t ? t.slice(0, n) : null; };
  const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
  const tag = String(el.tagName || '').toUpperCase();
  const rawType = attr('type');
  const type = rawType ? rawType.toLowerCase() : (tag === 'INPUT' ? 'text' : null);
  const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const root = el.getRootNode ? el.getRootNode() : document;
  const byIds = (ids) => cut(String(ids).split(/\s+/).map((id) => {
    const n = (root && root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
    return n ? n.textContent : '';
  }).join(' '));
  const labelledby = attr('aria-labelledby') ? byIds(attr('aria-labelledby')) : null;
  let label = null;
  if (el.labels && el.labels.length) label = cut(el.labels[0].innerText || el.labels[0].textContent);
  if (!label && isField && labelledby) label = labelledby;
  const inner = el.innerText != null ? el.innerText : el.textContent;
  const btnValue = tag === 'INPUT' && /^(button|submit|reset)$/.test(type || '')
    ? (cut(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : null)) : null;
  const altName = (tag === 'IMG' || (tag === 'INPUT' && type === 'image')) ? cut(attr('alt')) : null;
  const name = labelledby || cut(attr('aria-label')) || (isField ? label : null) || btnValue || altName
    || (!isField ? cut(inner) : null) || cut(attr('title'));
  let testid = null;
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    if (el.hasAttribute && el.hasAttribute(a)) { testid = { attr: a, value: el.getAttribute(a) }; break; }
  }
  // Ланцюг предків від кореня (документа або shadow root) до елемента.
  const path = [];
  for (let n = el, k = 0; n && n.nodeType === 1 && k < 40; n = n.parentElement, k++) {
    let nth = 1;
    for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === n.tagName) nth++;
    path.unshift({
      tag: String(n.tagName).toLowerCase(),
      id: n.getAttribute('id') || null,
      classes: n.classList ? Array.from(n.classList).slice(0, 6) : [],
      nth,
    });
  }
  const r = el.getBoundingClientRect();
  const sx = window.scrollX || 0, sy = window.scrollY || 0;
  const out = {
    tag, type, role: attr('role'), name, label,
    placeholder: attr('placeholder'), nameAttr: attr('name'), id: attr('id'), testid,
    text: isField ? null : cut(inner),
    href: (tag === 'A' || tag === 'AREA') ? attr('href') : null,
    alt: attr('alt'),
    editable: !!el.isContentEditable,
    multiple: !!el.multiple,
    path, cssPath: null, nth: null,
    box: { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height },
    vbox: { x: r.left, y: r.top, w: r.width, h: r.height },
  };
  if (tag === 'SELECT') {
    out.size = el.size || 0;
    out.options = Array.from(el.options || []).slice(0, 300).map((o) => ({
      value: o.value, label: norm(o.label || o.text), selected: !!o.selected, disabled: !!o.disabled,
    }));
  }
  return out;
};

// Опис <iframe> у батьківському документі (IframeDesc з lib/locators.js).
export const IFRAME_DESC_FN = (el) => {
  const parts = [];
  for (let n = el, k = 0; n && n.nodeType === 1 && n !== document.body && k < 12; n = n.parentElement, k++) {
    let nth = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) nth++;
    parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
  }
  return {
    id: el.getAttribute('id') || null,
    name: el.getAttribute('name') || null,
    title: el.getAttribute('title') || null,
    src: el.getAttribute('src') ? (el.src || el.getAttribute('src')) : null,
    cssPath: parts.length ? 'body > ' + parts.join(' > ') : null,
    index: Array.from(document.querySelectorAll('iframe, frame')).indexOf(el),
  };
};

// Локатор Playwright для кандидата: scope — Page | Frame | FrameLocator.
export function locatorFor(scope, loc) {
  const d = toPlaywright(loc);
  if (!d || !scope || typeof scope[d.method] !== 'function') return null;
  let l = scope[d.method](...d.args);
  if (d.nth != null && l && typeof l.nth === 'function') l = l.nth(d.nth);
  return l;
}

// Специфікація фрейму (target.frame) для фрейму Playwright: ланцюг селекторів
// <iframe> від зовнішнього до внутрішнього + URL-глоб/імʼя/індекс. null — головний.
export async function describeFrameChain(frame) {
  if (!frame || typeof frame.parentFrame !== 'function' || !frame.parentFrame()) return null;
  const page = frame.page();
  const main = page.mainFrame();
  const iframes = [];
  for (let f = frame; f && f !== main && f.parentFrame(); f = f.parentFrame()) {
    const fe = await f.frameElement();
    try { iframes.unshift(await fe.evaluate(IFRAME_DESC_FN)); } finally { fe.dispose().catch(() => {}); }
  }
  const sub = page.frames().filter((f) => f !== main);
  return frameSpecFrom(iframes, { url: frame.url(), name: frame.name(), index: sub.indexOf(frame) });
}

// Що під точкою (vx, vy — viewport головної сторінки). Спускається в той iframe,
// що реально під точкою (з урахуванням рамки/паддінгу), до 5 рівнів.
// → { handle (ElementHandle — викликач має dispose), frame, desc, offset:{x,y} } або null.
// opts.scroll = {x, y} — прокрутка головної сторінки (інакше міряється).
export async function hitTest(page, vx, vy, { scroll = null } = {}) {
  let frame = page.mainFrame(), ox = 0, oy = 0;
  for (let depth = 0; depth <= 5; depth++) {
    const jh = await frame.evaluateHandle(HIT_HANDLE_FN, { x: vx - ox, y: vy - oy, sel: INTERACTIVE_SEL }).catch(() => null);
    const el = jh ? jh.asElement() : null;
    if (!el) { if (jh) jh.dispose().catch(() => {}); return null; }
    const tag = await el.evaluate((e) => e.tagName).catch(() => '');
    if ((tag === 'IFRAME' || tag === 'FRAME') && depth < 5) {
      const cf = await el.contentFrame().catch(() => null);
      const box = cf ? await el.evaluate(FRAME_BOX_FN, {}).catch(() => null) : null;
      if (cf && box) { el.dispose().catch(() => {}); ox += box.x; oy += box.y; frame = cf; continue; }
    }
    const desc = await el.evaluate(DESCRIBE_FN).catch(() => null);
    if (!desc) { el.dispose().catch(() => {}); return null; }
    const sc = scroll || await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }));
    desc.box = { x: desc.vbox.x + ox + sc.x, y: desc.vbox.y + oy + sc.y, w: desc.vbox.w, h: desc.vbox.h };
    desc.vbox = { x: desc.vbox.x + ox, y: desc.vbox.y + oy, w: desc.vbox.w, h: desc.vbox.h }; // viewport головної сторінки
    return { handle: el, frame, desc, offset: { x: ox, y: oy } };
  }
  return null;
}

// Опис елемента за ElementHandle (напр. chooser.element()) у тій самій формі.
export async function describeHandle(page, handle, { scroll = null } = {}) {
  const desc = await handle.evaluate(DESCRIBE_FN).catch(() => null);
  if (!desc) return null;
  const frame = await handle.ownerFrame().catch(() => null);
  // Зсув фрейму: boundingBox (координати головного viewport) − vbox у фреймі.
  const bb = await handle.boundingBox().catch(() => null);
  const sc = scroll || await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }));
  if (bb) {
    desc.box = { x: bb.x + sc.x, y: bb.y + sc.y, w: bb.width, h: bb.height };
    desc.vbox = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  } else {
    // Прихований (напр. input[type=file] display:none) — бокса немає.
    desc.box = null; desc.vbox = null;
  }
  return { handle, frame: frame || page.mainFrame(), desc };
}

const timeoutNull = (ms) => {
  let t;
  const p = new Promise((r) => { t = setTimeout(() => r(null), ms); });
  return { p, cancel: () => clearTimeout(t) };
};

// Лічильники збігів для кандидатів (не більше max, у межах бюджету часу).
// null — невідомо (вийшов бюджет або помилка). Порядок = порядок cands.
export async function countCandidates(scope, cands, { budgetMs = 400, max = 6 } = {}) {
  const list = (cands || []).slice(0, max);
  const tm = timeoutNull(budgetMs);
  try {
    const counts = await Promise.all(list.map((c) => {
      let l;
      try { l = locatorFor(scope, c); } catch (_e) { l = null; }
      if (!l) return null;
      return Promise.race([l.count().catch(() => null), tm.p]);
    }));
    return (cands || []).map((_c, i) => (i < counts.length ? counts[i] : null));
  } finally { tm.cancel(); }
}

// Для CSS-кандидата з кількома збігами — індекс збігу, найближчого до цілі
// (vbox — у координатах головного viewport). → nth або null.
export async function nthForCss(scope, loc, vbox, { limit = 30 } = {}) {
  if (!vbox) return null;
  const l = locatorFor(scope, { ...loc, nth: null });
  if (!l) return null;
  const n = Math.min(limit, await l.count().catch(() => 0));
  let best = null, bestD = Infinity;
  const cx = vbox.x + vbox.w / 2, cy = vbox.y + vbox.h / 2;
  for (let i = 0; i < n; i++) {
    const bb = await l.nth(i).boundingBox().catch(() => null);
    if (!bb) continue;
    const d = Math.hypot(bb.x + bb.width / 2 - cx, bb.y + bb.height / 2 - cy);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= 2 ? best : null;
}

// Повна ціль запису: кандидати з опису + лічильники (бюджет budgetMs) + nth для
// CSS-кандидата з кількома збігами + специфікація фрейму.
//   point — точка кліку в CSS px документа головної сторінки (для rel).
export async function captureTarget(page, hit, { point = null, budgetMs = 400, count = true } = {}) {
  const frameSpec = await describeFrameChain(hit.frame).catch(() => null);
  const desc = hit.desc;
  const cands = buildCandidates(desc);
  let counts = null;
  if (count && cands.length) {
    counts = await countCandidates(hit.frame, cands, { budgetMs });
    const ci = cands.findIndex((c) => c.by === 'css');
    if (ci >= 0 && counts[ci] > 1 && desc.vbox) {
      const nth = await nthForCss(hit.frame, cands[ci], desc.vbox).catch(() => null);
      if (nth != null) { desc.nth = nth; cands[ci] = { ...cands[ci], nth }; counts[ci] = 1; }
    }
  }
  // targetFromDesc сам будує кандидатів — передаємо desc з nth і counts у тому ж порядку.
  const target = targetFromDesc(desc, { frame: frameSpec, point, counts, max: MAX_LOCS });
  return target;
}
