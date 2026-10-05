// Випадковість з інʼєкцією генератора (rng: () => [0,1)) — щоб тести були
// детермінованими. За замовчуванням — Math.random.

export const rnd = (a, b, rng = Math.random) => a + rng() * (b - a);
export const rint = (a, b, rng = Math.random) => Math.round(rnd(a, b, rng));

// Детермінований генератор із seed (для тестів).
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
