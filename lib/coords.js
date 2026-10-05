// Чисті (без побічних ефектів) функції перерахунку координат запису → відтворення.
// Винесено з server.js окремо, щоб покрити юніт-тестами (test/coords.test.js).
//
// Модель координат:
//   • Запис зберігає клік у ПІКСЕЛЯХ fullPage-скриншота = CSS × DPR на момент
//     запису. Нові записи також зберігають розміри того скриншота (sw/sh).
//   • Відтворення (миша/скрол Playwright) працює в CSS-пікселях.
//   • Різні Дії могли бути записані на різних рушіях/DPR (Chromium DPR1 vs
//     Camoufox DPR2), тому масштаб визначаємо або точно (через sw), або
//     евристикою по Дії (gid).

// Відстань від точки (px,py) до прямокутника rect={x,y,w,h}; 0 якщо всередині.
export function rectDistance(px, py, rect) {
  const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.w));
  const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

// Множина gid (ідентифікаторів Дій), записаних у "device-просторі": якщо
// максимальний X у Дії виходить за межі viewport × k — координати не в CSS,
// а в пікселях скриншота (DPR>1). Застосовується лише для старих записів без sw.
export function detectDeviceGids(actions, innerW, k = 1.3) {
  const maxX = {};
  for (const a of actions) {
    if ((a.type === 'move' || a.type === 'click') && a.gid != null) {
      maxX[a.gid] = Math.max(maxX[a.gid] || 0, Number(a.x) || 0);
    }
  }
  const set = new Set();
  for (const g of Object.keys(maxX)) {
    if (maxX[g] > innerW * k) set.add(isNaN(Number(g)) ? g : Number(g));
  }
  return set;
}

// Типові DPR, до яких «прилипає» відношення ширин скриншота запису й сторінки.
export const DPR_STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

// Масштаб для запису з відомою шириною скриншота sw при поточній CSS-ширині
// документа liveW. Відношення sw/liveW «прилипає» до найближчого типового DPR
// (допуск tol), бо різниця в 15px класичного скролбару (1265 vs 1280 —
// --hide-scrollbars, Camoufox, сторінка ще не доросла до скролу) інакше дає
// дрейф ~1.2% по Y (+35px внизу форми). Якщо не схоже на DPR — сире відношення.
export function recordScale(sw, liveW, tol = 0.03) {
  sw = Number(sw); liveW = Number(liveW);
  if (!(sw > 0) || !(liveW > 0)) return 1;
  const r = sw / liveW;
  for (const d of DPR_STEPS) if (Math.abs(r - d) / d <= tol) return 1 / d;
  return liveW / sw;
}

// Коефіцієнт масштабу для дії a.
//   opts = { scrollW, dpr, deviceGids:Set }  (scrollW — ЖИВА ширина, міряна перед дією)
//   • a.dpr заданий → 1/a.dpr (точний DPR запису);
//   • a.sw заданий → recordScale(a.sw, scrollW) (DPR-незалежно, стійко до скролбару);
//   • інакше Дія в device-просторі → 1/dpr;
//   • інакше координати вже в CSS → 1.
export function coordScale(a, opts) {
  if (a && Number(a.dpr) > 0) return 1 / Number(a.dpr);
  if (a && a.sw) return recordScale(a.sw, opts.scrollW);
  if (a && a.gid != null && opts.deviceGids && opts.deviceGids.has(a.gid)) return 1 / opts.dpr;
  return 1;
}

// CSS-координати по документу для дії a.
export function toDocCoords(a, opts) {
  const f = coordScale(a, opts);
  return { x: Math.round((Number(a.x) || 0) * f), y: Math.round((Number(a.y) || 0) * f) };
}

// Чи влучив raw-клік у "реальний" елемент (а не в порожнечу body/html).
// hit — результат browser hit-test: { tag, ... } або null. Якщо так — довіряємо
// координатам кліку; якщо ні — потрібен snap до найближчого контрола.
export function isSolidHit(hit) {
  if (!hit || !hit.tag) return false;
  const t = String(hit.tag).toUpperCase();
  return t !== 'BODY' && t !== 'HTML';
}

// Найближчий прямокутник до точки (px,py) у радіусі maxDist. rects — масив
// { x,y,w,h } у координатах viewport. Повертає центр найближчого + відстань,
// або null якщо нічого в радіусі. Використовується для snap-порятунку промахів.
export function nearestRect(px, py, rects, maxDist = 60) {
  let best = null, bestD = maxDist;
  for (const r of rects) {
    if (!r || r.w < 5 || r.h < 5 || r.w > 2000 || r.h > 600) continue;
    const d = rectDistance(px, py, r);
    if (d < bestD) { bestD = d; best = { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), d: Math.round(d) }; }
  }
  return best;
}

// Прокрутка під ціль docY: повертає обмежений scrollY (щоб точка опинилась у
// видимій зоні — центруємо) та відповідну viewportY. Коректно для кліків нижче
// основної видимої зони (треба проскролити) та біля низу сторінки (обмеження).
export function scrollTargetFor(docY, innerH, pageH) {
  const maxScroll = Math.max(0, pageH - innerH);
  const desired = Math.round(docY - innerH / 2);
  const scrollY = Math.min(maxScroll, Math.max(0, desired));
  return { scrollY, viewportY: docY - scrollY };
}

// Межі «безпечної смуги» viewport: ціль docY видно, якщо вона в
// [scrollY + topInset + margin, scrollY + innerH - bottomInset - margin].
// topInset/bottomInset — висота фіксованих/sticky шапок і футерів (щоб ціль не
// опинилась ПІД шапкою).
//
// scrollPlan → { scroll:false, scrollY, viewportY } якщо ціль уже в смузі (НЕ
// скролимо — жодної scroll-події, яка закрила б відкритий дропдаун), інакше
// { scroll:true, scrollY:<новий, обмежений>, viewportY } — ціль по центру
// вільної (не перекритої) частини viewport.
export function scrollPlan(docY, scrollY, innerH, pageH, { margin = 80, topInset = 0, bottomInset = 0 } = {}) {
  docY = Number(docY) || 0; scrollY = Math.max(0, Number(scrollY) || 0);
  topInset = Math.max(0, Number(topInset) || 0); bottomInset = Math.max(0, Number(bottomInset) || 0);
  const lo = scrollY + topInset + margin, hi = scrollY + innerH - bottomInset - margin;
  if (docY >= lo && docY <= hi) return { scroll: false, scrollY, viewportY: docY - scrollY };
  const maxScroll = Math.max(0, pageH - innerH);
  const freeMid = topInset + Math.max(0, innerH - topInset - bottomInset) / 2;
  const target = Math.min(maxScroll, Math.max(0, Math.round(docY - freeMid)));
  if (target === Math.round(scrollY)) return { scroll: false, scrollY, viewportY: docY - scrollY };
  return { scroll: true, scrollY: target, viewportY: docY - target };
}

// Скорочення: чи треба скролити під ціль.
export function needsScroll(docY, scrollY, innerH, pageH, opts) {
  return scrollPlan(docY, scrollY, innerH, pageH, opts).scroll;
}

// Чи «вляглась» прокрутка: останні n вимірів scrollY (по одному на кадр rAF)
// однакові (з допуском 0.5px — дробові scrollY при DPR>1).
export function scrollSettled(samples, n = 2) {
  if (!Array.isArray(samples) || samples.length < n) return false;
  const tail = samples.slice(-n).map(Number);
  return tail.every((v) => Number.isFinite(v) && Math.abs(v - tail[0]) <= 0.5);
}

// Селектор «інтерактивного» елемента: hit-test дивиться closest(INTERACTIVE_SEL).
// Включно з ARIA-ролями, contenteditable, label (клік по label фокусує поле).
export const INTERACTIVE_SEL = [
  'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'option', 'label', 'summary',
  '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=option]', '[role=menuitem]',
  '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=tab]', '[role=switch]', '[role=combobox]',
  '[role=textbox]', '[role=searchbox]', '[role=slider]', '[role=spinbutton]', '[role=treeitem]',
  '[contenteditable]:not([contenteditable=false])', '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(', ');

// Класифікація результату hit-test під точкою кліку:
//   'empty'       — нічого / BODY / HTML / IFRAME без контенту (фрейм ще не відрендерився);
//   'interactive' — елемент або предок відповідає INTERACTIVE_SEL, або має
//                   cursor:pointer, або схожий на опцію списку (клас/ід *option*);
//   'content'     — будь-що інше (обгортка DIV, заголовок, абзац).
export function classifyHit(hit) {
  if (!hit || !hit.tag) return 'empty';
  const t = String(hit.tag).toUpperCase();
  if (t === 'BODY' || t === 'HTML' || t === 'IFRAME' || t === 'FRAME') return 'empty';
  if (hit.interactive || hit.pointer || hit.optionLike) return 'interactive';
  return 'content';
}

// Рішення про snap (порятунок промаху) за класом влучання і найближчим
// контролом nearest = { x, y, d } (або null):
//   interactive → довіряємо координатам (не чіпаємо влучні кліки, напр. опцію);
//   empty       → притягуємо до контрола в радіусі emptyRadius (60px);
//   content     → притягуємо ЛИШЕ якщо контрол зовсім поруч (contentRadius, 24px),
//                 інакше клікаємо як записано (щільна форма: 60px = сусіднє поле).
// → { action: 'trust'|'snap'|'none', to?: {x,y}, d? }  ('none' — порожнеча й нема куди тягнути)
export function decideSnap(cls, nearest, { emptyRadius = 60, contentRadius = 24 } = {}) {
  if (cls === 'interactive') return { action: 'trust' };
  const radius = cls === 'empty' ? emptyRadius : contentRadius;
  if (nearest && Number.isFinite(nearest.d) && nearest.d <= radius) {
    return { action: 'snap', to: { x: nearest.x, y: nearest.y }, d: nearest.d };
  }
  return { action: cls === 'empty' ? 'none' : 'trust' };
}

// Фіксований елемент (банер кукі, шапка, модалка) на скриншоті запису
// намальований у позиції viewport (fullPage-скрин /render знято на scrollY=0),
// тож запис docY < innerH для нього = viewport-координата. Якщо в точці
// (x, docY) поточного viewport є ІНТЕРАКТИВНИЙ елемент — клікаємо туди без
// прокрутки (інакше центрування відвезе точку з банера):
//   • position:fixed — та сама позиція у viewport за БУДЬ-ЯКОГО scrollY → довіряємо;
//   • position:sticky — позиція залежить від scrollY: «прилиплий» сайдбар на
//     прокрученій сторінці накриває точку першого екрана, хоча на записі (scrollY=0)
//     його там не було → довіряємо лише при scrollY = 0.
export function preferFixedHit(docY, innerH, hit, scrollY = 0) {
  if (!(Number(docY) >= 0 && Number(docY) < Number(innerH) && hit && classifyHit(hit) === 'interactive')) return false;
  return !!hit.fixed || (!!hit.sticky && (Number(scrollY) || 0) < 1);
}

// Розклад «роздивляння» (humanWander) — детермінований, без монетки:
//   • phase 'open' — один раз після відкриття сторінки;
//   • перед кліком — кожен every-й клік (clickNo, з 1), АЛЕ ніколи одразу після
//     залежного кроку (click/key/text/select), бо може бути відкритий попап/список,
//     який скрол закриє або прокрутить. Виняток — попередній клік спричинив
//     навігацію (нова сторінка, попапів немає).
export const DEPENDENT_TYPES = new Set(['click', 'key', 'text', 'select']);
export function shouldWander({ humanize, phase, clickNo = 0, prevType = null, prevNavigated = false, every = 4 } = {}) {
  if (!humanize) return false;
  if (phase === 'open') return true;
  if (!every || clickNo <= 0 || clickNo % every !== 0) return false;
  if (prevType && DEPENDENT_TYPES.has(prevType) && !prevNavigated) return false;
  return true;
}
