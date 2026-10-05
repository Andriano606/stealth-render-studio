// Людська поведінка при відтворенні (проти поведінкового детектування):
// криві рухи миші, мікропаузи, друк по буквах, «роздивляння» скролом.
// Генератор випадковості інʼєктується (rng) — для детермінованих тестів.
import { rnd as rndR, rint as rintR } from './rng.js';

// Рухає мишу до (toX,toY) з кількох проміжних точок і легкою «дугою»,
// а не миттєвим стрибком. Повертає нову позицію.
// opts.single — один mouse.move зі steps (Camoufox із camoufoxHumanize сам
// робить людську траєкторію на рівні рушія — свої хопи там зайві).
export async function humanMove(page, from, toX, toY, rng = Math.random, { single = false } = {}) {
  const rnd = (a, b) => rndR(a, b, rng), rint = (a, b) => rintR(a, b, rng);
  if (single) {
    await page.mouse.move(toX, toY, { steps: rint(8, 16) });
    return { x: toX, y: toY };
  }
  const hops = rint(2, 4);
  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    const nx = from.x + (toX - from.x) * t + rnd(-22, 22) * (1 - t);
    const ny = from.y + (toY - from.y) * t + rnd(-22, 22) * (1 - t);
    await page.mouse.move(nx, ny, { steps: rint(8, 18) });
    await page.waitForTimeout(rint(12, 55));
  }
  await page.mouse.move(toX, toY, { steps: rint(6, 12) });
  return { x: toX, y: toY };
}

// «Натискання» в поточній позиції: мікропауза прицілювання, роздільні down/up.
export async function humanPress(page, rng = Math.random) {
  const rint = (a, b) => rintR(a, b, rng);
  await page.waitForTimeout(rint(60, 180));
  await page.mouse.down();
  await page.waitForTimeout(rint(40, 110));
  await page.mouse.up();
}

// Клік із природним рухом, мікропаузою й роздільними down/up.
// (Відтворення використовує humanMove → hit-test → humanPress окремо.)
export async function humanClick(page, from, x, y, rng = Math.random, opts) {
  const pos = await humanMove(page, from, x, y, rng, opts);
  await humanPress(page, rng);
  return pos;
}

// Друк по символу зі змінним ритмом та випадковими «задумами».
export async function humanType(page, text, rng = Math.random) {
  const rint = (a, b) => rintR(a, b, rng);
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(rint(45, 160));
    if (rng() < 0.07) await page.waitForTimeout(rint(200, 550));
  }
}

// Як поводитись у фазі phase ('replay' | 'act' — дії живої сесії | 'prefix' —
// префікс живої сесії) за профілем — ЄДИНЕ місце рішення (нічого не захардкоджено):
//   humanize   — behavior.humanize (дефолт увімкнено); префікс — без humanize лише
//                з явним behavior.fastPrefix;
//   singleMove — Camoufox із camoufoxHumanize сам веде курсор людською траєкторією.
export function behaviorOpts(profile, phase = 'replay') {
  const b = (profile && profile.behavior) || {};
  const L = (profile && profile.launch) || {};
  const humanize = b.humanize !== false && !(phase === 'prefix' && b.fastPrefix === true);
  const singleMove = L.engine === 'camoufox' && L.camoufoxHumanize !== false;
  return { humanize, singleMove };
}

// Кандидати точок для колеса «роздивляння»: поля по краях і випадкові точки
// в центральній зоні (чиста функція). Перевіряє їх dom.pickNeutralPoint.
export function wanderCandidates(w, h, rng = Math.random, n = 6) {
  const rint = (a, b) => rintR(a, b, rng);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: rint(Math.round(w * 0.15), Math.round(w * 0.85)), y: rint(Math.round(h * 0.2), Math.round(h * 0.8)) });
  pts.push({ x: Math.round(w * 0.03), y: Math.round(h / 2) }, { x: Math.round(w * 0.97), y: Math.round(h / 2) });
  return pts;
}

// «Роздивляння»: кілька дрібних скролів колесом із паузами, ніби користувач
// читає сторінку. opts.point — нейтральна точка (під нею немає внутрішніх
// скролерів/списків): спершу ведемо туди мишу, щоб колесо крутило лише документ.
// Повертає позицію миші.
export async function humanWander(page, rng = Math.random, { point = null, from = null, single = false } = {}) {
  const rint = (a, b) => rintR(a, b, rng);
  let pos = from;
  if (point) pos = await humanMove(page, from || point, point.x, point.y, rng, { single });
  const rounds = rint(1, 3);
  for (let i = 0; i < rounds; i++) {
    const dy = rint(-120, 280); // переважно вниз, іноді трохи вгору
    try { await page.mouse.wheel(0, dy); } catch (_e) {}
    await page.waitForTimeout(rint(250, 750));
  }
  return pos;
}
