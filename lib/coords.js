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

// Коефіцієнт масштабу для дії a.
//   opts = { scrollW, dpr, deviceGids:Set }
//   • a.sw заданий → scrollW / a.sw (точно, DPR-незалежно);
//   • інакше Дія в device-просторі → 1/dpr;
//   • інакше координати вже в CSS → 1.
export function coordScale(a, opts) {
  if (a && a.sw) return opts.scrollW / a.sw;
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
