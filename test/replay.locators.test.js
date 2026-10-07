// Відтворення кроків v2 з target (lib/replay.js): resolveScope/resolveTarget і
// гілки runReplay «спершу локатор» — на фейкових локаторах Playwright (без браузера).
// Legacy-шлях (координати) покривають test/replay.test.js і e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { runReplay, resolveTarget, resolveScope, hasTarget, hasCoords } from '../lib/replay.js';
import { nearestRect, scrollPlan } from '../lib/coords.js';
import { mulberry32 } from '../lib/rng.js';
import { normalizeStep, applyTargetUpgrade, healthOf } from '../lib/steps.js';

function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    async sleep(ms) {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const nx = timers[0];
        if (!nx || nx.at > until) break;
        timers.shift(); t = nx.at; nx.fn();
      }
      t = until;
    },
    at(ms, fn) { timers.push({ at: t + ms, fn }); },
  };
}

// --- Фейковий DOM-світ для локаторів ---
// el: { id, role, name, label, text, css, box:{x,y,width,height} (viewport), frame: null|'f1',
//       options?:[{value,label}], hidden? }
function makeWorld(els = [], opts = {}) {
  const w = { els, clicks: [], selects: [], files: [], scroll: { x: 0, y: 0 }, iframes: {}, ...opts };
  const matchIn = (frame, pred) => w.els.filter((e) => (e.frame || null) === frame && !e.gone && pred(e));
  function loc(list, desc) {
    const one = () => {
      const l = list();
      if (l.length !== 1) throw new Error('strict mode violation: ' + desc + ' → ' + l.length);
      return l[0];
    };
    return {
      desc,
      _list: list,
      async count() { return list().length; },
      // locator.and(other): перетин збігів (той самий елемент — за ідентичністю).
      and(o) { return loc(() => { const b = o._list(); return list().filter((e) => b.includes(e)); }, desc + ' & ' + o.desc); },
      nth(k) { return loc(() => { const l = list(); return l[k] ? [l[k]] : []; }, desc + '>>nth=' + k); },
      first() { return this.nth(0); },
      async boundingBox() { const e = one(); return e.hidden ? null : { ...e.box }; },
      async click(o = {}) {
        const e = one();
        if (e.blocked) throw new Error('element intercepts pointer events (timeout ' + o.timeout + ')');
        w.clicks.push({ id: e.id, ...o });
        if (!o.trial && e.onClick) e.onClick(w);
      },
      async selectOption(v) {
        const e = one();
        const opt = (e.options || []).find((o) => (v.value != null ? o.value === v.value : o.label === v.label));
        if (!opt) throw new Error('no option ' + JSON.stringify(v));
        w.selects.push({ id: e.id, value: opt.value });
      },
      async setInputFiles(p) { const e = one(); if (e.filesFail) throw new Error('setInputFiles: element is not attached'); w.files.push({ id: e.id, path: p }); },
    };
  }
  function scope(frame) {
    return {
      getByRole: (role, o = {}) => loc(() => matchIn(frame, (e) => e.role === role && (o.name == null || e.name === o.name)), 'role=' + role + '[' + o.name + ']'),
      getByLabel: (v) => loc(() => matchIn(frame, (e) => e.label === v), 'label=' + v),
      getByPlaceholder: (v) => loc(() => matchIn(frame, (e) => e.placeholder === v), 'ph=' + v),
      getByText: (v) => loc(() => matchIn(frame, (e) => e.text === v), 'text=' + v),
      getByTestId: (v) => loc(() => matchIn(frame, (e) => e.testid === v), 'testid=' + v),
      locator: (css) => {
        if (css.startsWith('iframe')) return loc(() => (w.iframes[css] && !w.iframes[css].gone ? [{ id: css, box: { x: 0, y: 0, width: 1, height: 1 } }] : []), css);
        return loc(() => matchIn(frame, (e) => e.css === css || (e.alsoCss || []).includes(css)), css);
      },
      frameLocator: (sel) => scope(w.iframes[sel] ? w.iframes[sel].frame : '?'),
    };
  }
  w.scope = scope;
  return w;
}

function fakePage(w, extra = {}) {
  const em = new EventEmitter();
  const main = { name: () => '', url: () => 'https://site.test/', async evaluate() { return 100; } };
  const subFrames = (w.frames || []).map((f) => ({ ...scopeFrame(w, f), name: () => f.name || '', url: () => f.url }));
  let mouse = { x: 0, y: 0 };
  const page = Object.assign(em, w.scope(null), {
    mainFrame: () => main,
    frames: () => [main, ...subFrames],
    async waitForTimeout() {},
    async waitForLoadState() {},
    async title() { return 'T'; },
    async evaluate(fn) {
      const s = String(fn);
      if (s.includes('scrollX')) return { ...w.scroll };
      return String(fn).includes('querySelector') ? false : 'body';
    },
    isClosed: () => false,
    mouse: {
      async move(x, y) { mouse = { x, y }; (w.moves = w.moves || []).push([x, y]); if (w.onMove) w.onMove(w, x, y); },
      async down() { (w.downs = w.downs || []).push({ ...mouse }); },
      async up() { (w.ups = w.ups || []).push({ ...mouse }); },
      async wheel() {},
    },
    keyboard: {
      async type(t) { (w.typed = w.typed || []).push(t); },
      async press(k) { (w.keys = w.keys || []).push(k); },
    },
    ...extra,
  });
  return page;
}
function scopeFrame(w, f) { return w.scope(f.id); }

// Мінімальний dom для координатного запасного шляху.
function fakeDom(w) {
  return {
    async measure() { return { w: 1280, h: 900, dpr: 1, sw: 1280, sh: 3000, scrollY: w.scroll.y, topInset: 0, bottomInset: 0 }; },
    async readScrollY() { return w.scroll.y; },
    async scrollDocTo(_p, docY) {
      const plan = scrollPlan(docY, w.scroll.y, 900, 3000);
      if (plan.scroll) w.scroll.y = plan.scrollY;
      return { scrollY: w.scroll.y, scrolled: plan.scroll };
    },
    async elementAt(_p, vx, vy) {
      const e = (w.coordEls || []).find((c) => vx >= c.x && vx <= c.x + c.w && vy + w.scroll.y >= c.y && vy + w.scroll.y <= c.y + c.h);
      return e ? { tag: 'BUTTON', interactive: true, text: e.id } : { tag: 'BODY', interactive: false };
    },
    async snapToClickable(_p, vx, vy, max) { return nearestRect(vx, vy, [], max); },
    async waitScrollSettle() { return { settled: true, scrollY: w.scroll.y }; },
    async pickNeutralPoint(_p, pts) { return pts[0]; },
    async focusIsEditable() { return true; },
    async collectFileInputs() { return (w.legacyInputs || []).map((id) => ({ async setInputFiles(p) { w.files.push({ id, path: p, legacy: true }); } })); },
  };
}

async function run(steps, w, { humanize = false, page = null, ...env } = {}) {
  const p = page || fakePage(w);
  const events = [];
  const res = await runReplay(p, steps, {
    send: (e) => events.push(e), humanize, rng: mulberry32(3), clock: fakeClock(), dom: fakeDom(w),
    resolveUpload: () => '/up/cv.pdf', ...env,
  });
  const dones = events.filter((e) => e.event === 'done-action');
  return { events, res, dones, logs: events.filter((e) => e.event === 'log').map((e) => e.text) };
}

const role = (r, name) => ({ by: 'role', role: r, name, exact: true, n: 1 });
const tgt = (locs, extra = {}) => ({ frame: null, locs, pick: 0, rel: { rx: 0.5, ry: 0.5 }, box: null, kind: 'button', desc: 'кнопка «Submit»', ...extra });
const btn = (id, extra = {}) => ({ id, role: 'button', name: 'Submit', text: 'Submit', css: '#' + id, box: { x: 100, y: 100, width: 200, height: 40 }, ...extra });

// ---------- hasTarget / hasCoords ----------

test('hasTarget / hasCoords', () => {
  assert.equal(hasTarget({ target: tgt([role('button', 'A')]) }), true);
  assert.equal(hasTarget({ target: tgt([role('button', 'A')], { pick: -1 }) }), false);
  assert.equal(hasTarget({ target: tgt([]) }), false);
  assert.equal(hasTarget({ type: 'click', x: 1, y: 2 }), false);
  assert.equal(hasCoords({ x: 0, y: 5 }), true);
  assert.equal(hasCoords({ x: null, y: 5 }), false);
  assert.equal(hasCoords({}), false);
});

// ---------- resolveTarget ----------

test('resolveTarget: унікальний pick → loc; pick без збігів, альтернатива унікальна → loc-alt + healed', async () => {
  const w = makeWorld([btn('b1')]);
  const page = fakePage(w);
  const r1 = await resolveTarget(page, tgt([role('button', 'Submit'), { by: 'css', value: '#b1' }]), { clock: fakeClock() });
  assert.equal(r1.strategy, 'loc'); assert.equal(r1.healed, false); assert.equal(r1.idx, 0);
  const r2 = await resolveTarget(page, tgt([role('button', 'Надіслати'), { by: 'css', value: '#b1' }]), { clock: fakeClock() });
  assert.equal(r2.strategy, 'loc-alt'); assert.equal(r2.healed, true); assert.equal(r2.idx, 1);
});

test('resolveTarget: ціль домалювалась між підрахунками pick і альтернативи → pick перевіряється ще раз → loc, не loc-alt', async () => {
  // Асинхронний дропдаун: на момент count() pick опцій ще немає, а до count() альтернативи — вже є.
  const opt = { id: 'lv', role: 'option', name: 'Львів', css: 'div.dd-option:nth-child(2)', gone: true, box: { x: 10, y: 10, width: 50, height: 20 } };
  const w = makeWorld([opt]);
  const page = fakePage(w);
  const roleScope = page.getByRole;
  page.getByRole = (r, o) => {
    const l = roleScope(r, o);
    const count = l.count.bind(l);
    let first = true;
    l.count = async () => { const n = await count(); if (first) { first = false; opt.gone = false; } return n; };
    return l;
  };
  const r = await resolveTarget(page, tgt([role('option', 'Львів'), { by: 'css', value: 'div.dd-option:nth-child(2)' }]), { clock: fakeClock() });
  assert.equal(r.strategy, 'loc');
  assert.equal(r.healed, false);
  assert.equal(r.idx, 0);
  // Pick справді не збігається — лишається loc-alt.
  const r2 = await resolveTarget(fakePage(makeWorld([{ ...opt, gone: false }])), tgt([role('option', 'Київ'), { by: 'css', value: 'div.dd-option:nth-child(2)' }]), { clock: fakeClock() });
  assert.equal(r2.strategy, 'loc-alt');
});

test('resolveTarget: порядок [pick, …решта] — pick не перший у списку', async () => {
  const w = makeWorld([btn('b1')]);
  const t = tgt([{ by: 'text', value: 'Submit' }, role('button', 'Submit')], { pick: 1 });
  const r = await resolveTarget(fakePage(w), t, { clock: fakeClock() });
  assert.equal(r.idx, 1); assert.equal(r.strategy, 'loc');
});

test('resolveTarget: кілька збігів → найближчий до записаного боксу (з урахуванням scroll) → nth', async () => {
  const w = makeWorld([
    btn('a', { box: { x: 20, y: 100, width: 100, height: 30 } }),
    btn('b', { box: { x: 220, y: 100, width: 100, height: 30 } }),
    btn('c', { box: { x: 420, y: 100, width: 100, height: 30 } }),
  ], { scroll: { x: 0, y: 500 } });
  // запис: бокс у doc-координатах (y = 600 = 100 + scroll 500)
  const t = tgt([role('button', 'Submit')], { box: { x: 225, y: 605, w: 100, h: 30 } });
  const r = await resolveTarget(fakePage(w), t, { clock: fakeClock() });
  assert.equal(r.strategy, 'nth');
  assert.equal(r.nth, 1);
  assert.equal(r.dist, 7);
  await r.locator.click();
  assert.equal(w.clicks.at(-1).id, 'b');
});

test('resolveTarget: nth-кандидат (CSS+nth) рахує БАЗОВИЙ селектор і обирає найближчий, а не індекс', async () => {
  const els = ['a', 'b', 'c'].map((id, i) => ({ id, role: 'button', name: 'Додати', css: 'div.d > button.add', box: { x: 20 + 200 * i, y: 50, width: 100, height: 30 } }));
  const w = makeWorld(els);
  // записано: 2-й (nth=1), але тепер порядок інший — бокс запису збігається з 'c'
  const t = tgt([{ by: 'css', value: 'div.d > button.add', nth: 1, n: 1 }, { ...role('button', 'Додати'), n: 3 }], { box: { x: 420, y: 50, w: 100, h: 30 } });
  const r = await resolveTarget(fakePage(w), t, { clock: fakeClock() });
  assert.equal(r.strategy, 'nth'); assert.equal(r.idx, 0); assert.equal(r.healed, false);
  await r.locator.click();
  assert.equal(w.clicks.at(-1).id, 'c');
  // без боксу — записаний nth
  const r2 = await resolveTarget(fakePage(w), { ...t, box: null }, { clock: fakeClock() });
  await r2.locator.click();
  assert.equal(w.clicks.at(-1).id, 'b');
});

test('resolveTarget: ціль зʼявляється пізно — опитування кожні 200 мс до таймауту', async () => {
  const w = makeWorld([]);
  const clock = fakeClock();
  clock.at(900, () => w.els.push(btn('late')));
  const r = await resolveTarget(fakePage(w), tgt([role('button', 'Submit')]), { clock, timeout: 6000 });
  assert.equal(r.strategy, 'loc');
  assert.ok(r.ms >= 900 && r.ms <= 1100, 'ms=' + r.ms);
});

test('resolveTarget: не знайдено за timeout → null; pick=-1 → одразу null; abort → null', async () => {
  const w = makeWorld([]);
  const clock = fakeClock();
  assert.equal(await resolveTarget(fakePage(w), tgt([role('button', 'X')]), { clock, timeout: 2500 }), null);
  assert.equal(clock.now(), 2500);
  const c2 = fakeClock();
  assert.equal(await resolveTarget(fakePage(w), tgt([role('button', 'X')], { pick: -1 }), { clock: c2 }), null);
  assert.equal(c2.now(), 0);
  const ac = new AbortController(); ac.abort();
  assert.equal(await resolveTarget(fakePage(w), tgt([role('button', 'X')]), { clock: fakeClock(), signal: ac.signal }), null);
});

// ---------- resolveScope ----------

test('resolveScope: null → сторінка; ланцюг iframe → frameLocator; ланцюгу немає → matchFrame за URL; нічого → null', async () => {
  const w = makeWorld([btn('in', { frame: 'f1' })], {
    iframes: { 'iframe#frm': { frame: 'f1' } },
    frames: [{ id: 'f1', url: 'https://jobs.example.test/acme/123456/apply', name: '' }],
  });
  const page = fakePage(w);
  assert.equal(await resolveScope(page, null), page);
  const spec = { chain: ['iframe#frm'], url: 'https://jobs.example.test/acme/*', path: 'https://jobs.example.test/acme/123456/apply', name: '', index: 0 };
  const s1 = await resolveScope(page, spec);
  assert.equal(await s1.getByRole('button', { name: 'Submit' }).count(), 1);
  // id iframe змінився — ланцюг не резолвиться, але фрейм знаходимо за URL
  w.iframes['iframe#frm'].gone = true;
  const s2 = await resolveScope(page, spec);
  assert.equal(await s2.getByRole('button', { name: 'Submit' }).count(), 1);
  // фрейму з таким URL немає → null (чекаємо, а не клікаємо в чужий)
  assert.equal(await resolveScope(page, { ...spec, url: 'https://other.test/*', path: 'https://other.test/x' }), null);
});

test('resolveTarget у iframe: фрейм зʼявляється пізно (опитування фрейму)', async () => {
  const w = makeWorld([btn('in', { frame: 'f1' })], { iframes: {} });
  const clock = fakeClock();
  clock.at(1000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; });
  const t = tgt([role('button', 'Submit')], { frame: { chain: ['iframe#frm'], url: null, path: null, name: '', index: 0 } });
  const r = await resolveTarget(fakePage(w), t, { clock, timeout: 6000 });
  assert.ok(r);
  assert.ok(r.ms >= 1000 && r.ms <= 1300);
});

// ---------- runReplay: клік ----------

test('клік v2, humanize off: locator.click({position}) за rel, strategy loc; done-action без healed', async () => {
  const w = makeWorld([btn('b1')]);
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')], { rel: { rx: 0.25, ry: 0.5 } }), x: 9999, y: 9999 };
  const { dones, res } = await run([step], w);
  assert.equal(dones[0].ok, true);
  assert.equal(dones[0].strategy, 'loc');
  assert.equal(dones[0].healed, undefined);
  assert.equal(res.replayed, 1);
  assert.deepEqual(w.clicks, [{ id: 'b1', timeout: 6000, position: { x: 50, y: 20 } }]);
});

test('клік v2, humanize on: trial → рух у точку боксу → down/up (НЕ locator.click)', async () => {
  const w = makeWorld([btn('b1')]);
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')]) };
  const { dones } = await run([step], w, { humanize: true });
  assert.equal(dones[0].ok, true);
  assert.equal(w.clicks.length, 1);
  assert.equal(w.clicks[0].trial, true);
  assert.equal(w.downs.length, 1);
  const p = w.ups[0];
  // точка в межах 10–90% боксу
  assert.ok(p.x >= 120 && p.x <= 280 && p.y >= 104 && p.y <= 136, JSON.stringify(p));
});

test('клік v2, humanize on: ціль зсунулась під час руху > 4px → коригуюча точка в новому боксі', async () => {
  const w = makeWorld([btn('b1')]);
  let moved = false;
  w.onMove = (ww) => { if (!moved && ww.clicks.length === 1) { moved = true; ww.els[0].box = { x: 100, y: 400, width: 200, height: 40 }; } };
  const { logs } = await run([{ v: 2, type: 'click', target: tgt([role('button', 'Submit')]) }], w, { humanize: true });
  assert.ok(logs.some((t) => /зсунулась/.test(t)));
  const p = w.ups[0];
  assert.ok(p.y >= 404 && p.y <= 436, JSON.stringify(p));
});

test('клік v2: локатор не знайдено → координатний шлях (x/y) з логом 🎯→📍, strategy coord', async () => {
  const w = makeWorld([]);
  w.coordEls = [{ id: 'c', x: 90, y: 1490, w: 40, h: 40 }];
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')]), x: 110, y: 1510, sw: 1280, sh: 3000 };
  const { dones, logs } = await run([step], w, { stepTimeout: 2500 });
  assert.equal(dones[0].ok, true);
  assert.equal(dones[0].strategy, 'coord');
  assert.ok(logs.some((t) => /🎯→📍 локатор «role=button\[name="Submit"\]» не знайдено за 2.5 с/.test(t)), logs.join('\n'));
  assert.equal(w.ups.length, 1);
  assert.equal(w.ups[0].y + w.scroll.y, 1510);
});

test('клік v2: знайдено, але не клікається (перекрито) → координати', async () => {
  const w = makeWorld([btn('b1', { blocked: true })]);
  w.coordEls = [{ id: 'c', x: 0, y: 0, w: 400, h: 400 }];
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')]), x: 150, y: 120 };
  const { dones, logs } = await run([step], w);
  assert.equal(dones[0].strategy, 'coord');
  assert.ok(logs.some((t) => /знайдено, але клік не вдався/.test(t)));
});

test('клік v2 без координат і без збігу → збій + failShot; optional → skipped, не рахується', async () => {
  const w = makeWorld([]);
  const shots = [];
  const page = fakePage(w, { async screenshot(o) { shots.push(o); return Buffer.from('JPG'); } });
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')]), timeout: 1000 };
  const r1 = await run([step], w, { page });
  assert.equal(r1.dones[0].ok, false);
  assert.match(r1.dones[0].error, /не знайдено за 1 с/);
  assert.equal(r1.dones[0].failShot, 'data:image/jpeg;base64,' + Buffer.from('JPG').toString('base64'));
  assert.deepEqual(shots[0], { type: 'jpeg', quality: 50, scale: 'css', caret: 'initial', timeout: 5000 });
  assert.equal(r1.res.replayed, 0);
  const r2 = await run([{ ...step, optional: true }, { type: 'key', key: 'Tab' }], w, { page });
  assert.deepEqual([r2.dones[0].ok, r2.dones[0].skipped, r2.dones[0].failShot], [true, true, undefined]);
  assert.ok(r2.logs.some((t) => /Необовʼязковий крок #0 пропущено/.test(t)));
  assert.equal(r2.res.replayed, 1);
});

test('stepTimeout обмежує таймаут кроку (префікс живої сесії)', async () => {
  const w = makeWorld([]);
  const clock = fakeClock();
  const page = fakePage(w);
  const events = [];
  await runReplay(page, [{ v: 2, type: 'click', target: tgt([role('button', 'Submit')]), timeout: 10000 }], {
    send: (e) => events.push(e), humanize: false, clock, dom: fakeDom(w), stepTimeout: 2500, resolveUpload: () => null,
  });
  const d = events.find((e) => e.event === 'done-action');
  assert.match(d.error, /не знайдено за 2.5 с/);
  assert.ok(d.ms >= 2500 && d.ms < 3000);
});

test('done-action.healed, коли переміг не pick', async () => {
  const w = makeWorld([btn('b1')]);
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Старе імʼя'), { by: 'css', value: '#b1' }]) };
  const { dones, logs } = await run([step], w);
  assert.equal(dones[0].strategy, 'loc-alt');
  assert.equal(dones[0].healed, true);
  assert.ok(logs.some((t) => /альтернативним локатором #b1/.test(t)));
});

test('попередження, якщо унікальний збіг далеко (> 400px) від записаного боксу', async () => {
  const w = makeWorld([btn('b1', { box: { x: 100, y: 1200, width: 200, height: 40 } })]);
  const step = { v: 2, type: 'click', target: tgt([role('button', 'Submit')], { box: { x: 100, y: 100, w: 200, h: 40 } }) };
  const { logs } = await run([step], w);
  assert.ok(logs.some((t) => /1100px від місця запису/.test(t)), logs.join('\n'));
});

test('клік з chooser:true — filechooser перехоплюється на час кліку', async () => {
  const w = makeWorld([btn('b1')]);
  const page = fakePage(w);
  let during = 0;
  w.els[0].onClick = () => { during = page.listenerCount('filechooser'); };
  await run([{ v: 2, type: 'click', chooser: true, target: tgt([role('button', 'Submit')]) }], w, { page });
  assert.equal(during, 1);
  assert.equal(page.listenerCount('filechooser'), 0);
});

// ---------- текст / select / file ----------

const input = (id, label, extra = {}) => ({ id, role: 'textbox', name: label, label, css: '#' + id, box: { x: 20, y: 40, width: 300, height: 30 }, ...extra });
const inTgt = (label, extra = {}) => tgt([{ ...role('textbox', label) }, { by: 'label', value: label, exact: true, n: 1 }], { kind: 'input', desc: 'поле «' + label + '»', ...extra });

test('текст v2: попередній клік по тому ж полю → без фокус-кліку; шаблон розгортається', async () => {
  const w = makeWorld([input('email', 'Email')]);
  const t = inTgt('Email');
  const { dones } = await run([{ v: 2, type: 'click', target: t }, { v: 2, type: 'text', text: 'a{d}{{', target: t }], w);
  assert.deepEqual(dones.map((d) => d.ok), [true, true]);
  assert.equal(w.clicks.length, 1);
  assert.match(w.typed[0], /^a[0-9]\{$/);
});

test('текст v2: фокус був деінде → фокус-клік у поле; clear → ControlOrMeta+a, Backspace', async () => {
  const w = makeWorld([input('email', 'Email'), input('name', 'Name', { box: { x: 20, y: 140, width: 300, height: 30 } })]);
  const { dones } = await run([
    { v: 2, type: 'click', target: inTgt('Name') },
    { v: 2, type: 'text', text: 'x', clear: true, target: inTgt('Email') },
  ], w);
  assert.deepEqual(dones.map((d) => d.strategy), ['loc', 'loc']);
  assert.deepEqual(w.clicks.map((c) => c.id), ['name', 'email']);
  assert.deepEqual(w.keys, ['ControlOrMeta+a', 'Backspace']);
  assert.deepEqual(w.typed, ['x']);
});

test('текст v2: поле не знайдено, є x/y → фокус координатним кліком; немає → збій', async () => {
  const w = makeWorld([]);
  w.coordEls = [{ id: 'c', x: 0, y: 0, w: 400, h: 400 }];
  const r1 = await run([{ v: 2, type: 'text', text: 'hi', target: inTgt('Email'), x: 50, y: 50, timeout: 500 }], w);
  assert.equal(r1.dones[0].strategy, 'coord');
  assert.deepEqual(w.typed, ['hi']);
  const r2 = await run([{ v: 2, type: 'text', text: 'hi', target: inTgt('Email'), timeout: 500 }], makeWorld([]));
  assert.equal(r2.dones[0].ok, false);
  assert.match(r2.dones[0].error, /поле «Email» не знайдено/);
});

test('текст без target (legacy-злитий v2) — як раніше: без пошуку цілі', async () => {
  const w = makeWorld([]);
  const { dones } = await run([{ v: 2, type: 'text', text: 'abc' }], w);
  assert.equal(dones[0].ok, true);
  assert.equal(dones[0].strategy, null);
  assert.deepEqual(w.typed, ['abc']);
});

test('select: value; якщо value немає — за label; без цілі → збій', async () => {
  const sel = { id: 'country', role: 'combobox', name: 'Країна', label: 'Країна', css: '#country', box: { x: 0, y: 0, width: 100, height: 30 },
    options: [{ value: 'UA', label: 'Україна' }, { value: 'PL', label: 'Польща' }] };
  const w = makeWorld([sel]);
  const t = tgt([role('combobox', 'Країна')], { kind: 'select' });
  const { dones } = await run([
    { v: 2, type: 'select', value: 'PL', label: 'Польща', target: t },
    { v: 2, type: 'select', value: 'pl-old', label: 'Україна', target: t },
  ], w);
  assert.deepEqual(dones.map((d) => d.ok), [true, true]);
  assert.deepEqual(w.selects.map((s) => s.value), ['PL', 'UA']);
  const r = await run([{ v: 2, type: 'select', value: 'PL', target: tgt([role('combobox', 'Інше')]), timeout: 300 }], w);
  assert.equal(r.dones[0].ok, false);
});

test('file v2: setInputFiles на знайдений локатор; не знайдено → input за порядком (legacy)', async () => {
  const w = makeWorld([{ id: 'cv', css: '#cv', box: null, hidden: true }]);
  w.legacyInputs = ['first'];
  const t = tgt([{ by: 'id', value: 'cv', n: 1 }], { kind: 'file' });
  const r1 = await run([{ v: 2, type: 'file', fileId: 'x', filename: 'cv.pdf', target: t }], w);
  assert.equal(r1.dones[0].strategy, 'loc');
  assert.deepEqual(w.files, [{ id: 'cv', path: '/up/cv.pdf' }]);
  w.files.length = 0;
  const r2 = await run([{ v: 2, type: 'file', fileId: 'x', filename: 'cv.pdf', target: tgt([{ by: 'id', value: 'nope', n: 1 }], { kind: 'file' }), timeout: 300 }], w);
  assert.equal(r2.dones[0].ok, true);
  assert.deepEqual(w.files, [{ id: 'first', path: '/up/cv.pdf', legacy: true }]);
  assert.ok(r2.logs.some((t2) => /поле файлу/.test(t2)));
});

test('file v2: input[type=file] ×2 без геометрії (приховані поля, CSS зламано) → не «перше поле», а за порядком', async () => {
  // Обидва поля display:none → boundingBox null; записаний бокс теж null.
  const fi = (id) => ({ id, css: 'input[type="file"]', box: null, hidden: true });
  const w = makeWorld([fi('cover'), fi('resume')]);
  const typeLoc = { by: 'type', tag: 'input', value: 'file', n: 2 };
  const t1 = tgt([typeLoc, { by: 'css', value: 'div.old > input', n: 2 }], { kind: 'file', box: null });
  const t2 = tgt([{ by: 'css', value: 'div.old:nth-of-type(2) > input', n: 1 }, typeLoc], { kind: 'file', box: null });
  assert.equal(await resolveTarget(fakePage(w), t1, { clock: fakeClock() }), null);
  assert.equal(await resolveTarget(fakePage(w), t2, { clock: fakeClock() }), null);
  w.legacyInputs = ['cover', 'resume'];
  const r = await run([
    { v: 2, type: 'file', fileId: 'a', filename: 'cl.pdf', target: t1 },
    { v: 2, type: 'file', fileId: 'b', filename: 'cv.pdf', target: t2 },
  ], w);
  assert.deepEqual(w.files.map((f) => f.id), ['cover', 'resume']);
  assert.deepEqual(r.dones.map((d) => d.ok), [true, true]);
  // з геометрією — найближчий бокс (nth), як і раніше
  const w2 = makeWorld([{ id: 'cover', css: 'input[type="file"]', box: { x: 20, y: 100, width: 1, height: 1 } }, { id: 'resume', css: 'input[type="file"]', box: { x: 20, y: 700, width: 1, height: 1 } }]);
  const r2 = await resolveTarget(fakePage(w2), { ...t2, box: { x: 20, y: 700, w: 1, h: 1 } }, { clock: fakeClock() });
  assert.equal(r2.strategy, 'nth'); assert.equal(r2.nth, 1);
});

// ---------- Покращення цілі після успішного кроку (findUpgrade → done-action.upgrade) ----------
// Старий крок «Файл» (як Ashby): pick — CSS-шлях із хеш-класом, серед кандидатів — input[type=file].
const OLD_CSS = 'div._container_f7cvd_28 > input._input_f7cvd_50';
const typeFile = { by: 'type', tag: 'input', value: 'file' };
const fileStep = (locs, extra = {}) => ({ v: 2, type: 'file', fileId: 'x', filename: 'cv.pdf', target: tgt(locs, { kind: 'file', box: null, desc: 'поле файлу' }), ...extra });

test('upgrade: знайдено CSS-шляхом, input[type=file] — той самий елемент і 1 збіг → done-action.upgrade {idx} + лог 🎯', async () => {
  const w = makeWorld([{ id: 'cv', css: OLD_CSS, alsoCss: ['input[type="file"]'], box: { x: 20, y: 100, width: 1, height: 1 } }]);
  const r = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile])], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].strategy, 'loc');
  assert.deepEqual(r.dones[0].upgrade, { idx: 1 });
  assert.deepEqual(w.files, [{ id: 'cv', path: '/up/cv.pdf' }]);
  assert.ok(r.logs.some((l) => /🎯 Ціль .* стане надійнішою: input\[type="file"\]/.test(l)), r.logs.join('\n'));
});

test('upgrade: input[type=file] має 1 збіг, але це ІНШИЙ елемент → без upgrade і без логу', async () => {
  const w = makeWorld([
    { id: 'real', css: OLD_CSS, box: { x: 20, y: 100, width: 1, height: 1 } }, // не input[type=file]
    { id: 'other', css: 'input[type="file"]', box: { x: 20, y: 700, width: 1, height: 1 } },
  ]);
  const r = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile])], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].upgrade, undefined);
  assert.deepEqual(w.files.map((f) => f.id), ['real']);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)));
});

test('upgrade: кандидат — той самий елемент, але збігів 2 → без upgrade', async () => {
  const w = makeWorld([
    { id: 'cv', css: OLD_CSS, alsoCss: ['input[type="file"]'], box: { x: 20, y: 100, width: 1, height: 1 } },
    { id: 'cl', css: 'input[type="file"]', box: { x: 20, y: 700, width: 1, height: 1 } },
  ]);
  const r = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile])], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].upgrade, undefined);
});

test('upgrade: крок упав (знайдено CSS-шляхом, але клік перекрито і координат немає) → без upgrade', async () => {
  const w = makeWorld([btn('b', { css: OLD_CSS, blocked: true })]);
  const t = tgt([{ by: 'css', value: OLD_CSS, n: 1 }, role('button', 'Submit')]);
  const r = await run([{ v: 2, type: 'click', target: t, timeout: 300 }], w);
  assert.equal(r.dones[0].ok, false);
  assert.equal(r.dones[0].upgrade, undefined);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)));
  // Контроль: той самий крок без перекриття — upgrade на role=button (тобто відмова вище — через збій).
  const w2 = makeWorld([btn('b', { css: OLD_CSS })]);
  const r2 = await run([{ v: 2, type: 'click', target: t, timeout: 300 }], w2);
  assert.equal(r2.dones[0].ok, true);
  assert.deepEqual(r2.dones[0].upgrade, { idx: 1 });
});

test('upgrade: вимкнений (disabled) крок → без upgrade', async () => {
  const w = makeWorld([{ id: 'cv', css: OLD_CSS, alsoCss: ['input[type="file"]'], box: { x: 20, y: 100, width: 1, height: 1 } }]);
  const r = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile], { disabled: true })], w);
  assert.equal(r.dones[0].upgrade, undefined);
});

test('upgrade: семантичний локатор з невідомим n знайшов 1 збіг → пряме upgrade {idx: pick} (без перевірки інших)', async () => {
  const w = makeWorld([{ id: 'cv', css: '#cv', box: { x: 20, y: 100, width: 1, height: 1 } }]);
  const r = await run([fileStep([{ by: 'id', value: 'cv' }, { by: 'css', value: OLD_CSS, n: 1 }])], w);
  assert.equal(r.dones[0].ok, true);
  assert.deepEqual(r.dones[0].upgrade, { idx: 0 });
  assert.ok(r.logs.some((l) => /стане надійнішою: #cv/.test(l)), r.logs.join('\n'));
});

test('upgrade: pick 🎯 (role n=1) не знайдено, 🔁 через text → pick не міняється', async () => {
  const w = makeWorld([btn('b1')]);
  const t = tgt([role('button', 'Надіслати'), { by: 'text', value: 'Submit' }]);
  const r = await run([{ v: 2, type: 'click', target: t }], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].healed, true);
  assert.equal(r.dones[0].upgrade, undefined);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)), r.logs.join('\n'));
});

test('upgrade: знайдено далеко (> 400px) від записаного боксу → без upgrade', async () => {
  const far = { box: { x: 20, y: 1200, width: 1, height: 1 } };
  const w = makeWorld([{ id: 'cv', css: OLD_CSS, alsoCss: ['input[type="file"]'], ...far }]);
  const r = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile], { target: tgt([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile], { kind: 'file', desc: 'поле файлу', box: { x: 20, y: 100, w: 1, h: 1 } }) })], w);
  assert.equal(r.dones[0].ok, true);
  assert.ok(r.logs.some((l) => /від місця запису/.test(l)), r.logs.join('\n'));
  assert.equal(r.dones[0].upgrade, undefined);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)));
  // контроль: той самий світ і бокс поруч → upgrade є
  const w2 = makeWorld([{ id: 'cv', css: OLD_CSS, alsoCss: ['input[type="file"]'], box: { x: 20, y: 100, width: 1, height: 1 } }]);
  const r2 = await run([fileStep([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile], { target: tgt([{ by: 'css', value: OLD_CSS, n: 1 }, typeFile], { kind: 'file', desc: 'поле файлу', box: { x: 20, y: 100, w: 1, h: 1 } }) })], w2);
  assert.deepEqual(r2.dones[0].upgrade, { idx: 1 });
});

test('upgrade: уже 🎯 (семантичний n=1) → без upgrade', async () => {
  const w = makeWorld([{ id: 'cv', css: '#cv', alsoCss: ['input[type="file"]'], box: { x: 20, y: 100, width: 1, height: 1 } }]);
  const r = await run([fileStep([{ by: 'id', value: 'cv', n: 1 }, { ...typeFile, n: 1 }])], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].upgrade, undefined);
});

// ---------- Реальний кейс Ashby: input[type=file] ×2 (автозаповнення + резюме) ----------
// Збережений крок користувача: pick = input[type=file] (без n), запасний — CSS-шлях із хеш-класом
// CSS-модуля. Міграція (normalizeStep) додає очищену копію шляху перед хешованим оригіналом.
const ASHBY_HASHED = 'div#form > div.ashby-application-form-autofill-uploader._container_f7cvd_28 > div.ashby-application-form-autofill-input-root > input';
const ASHBY_CLEAN = 'div#form > div.ashby-application-form-autofill-uploader > div.ashby-application-form-autofill-input-root > input';
const ASHBY_HASHED2 = ASHBY_HASHED.replace('f7cvd', 'h2k8p'); // новий білд сайту
const TYPE_SEL = 'input[type="file"]';
const ashbyStep = (extra = {}) => normalizeStep({
  v: 2, id: 's_ashby', type: 'file', fileId: 'x', filename: 'cv.pdf',
  target: { pick: 0, frame: null, kind: 'file', box: null, desc: 'поле файлу',
    locs: [{ by: 'type', tag: 'input', value: 'file' }, { by: 'css', value: ASHBY_HASHED, nth: null, n: 1 }] },
  ...extra,
});
// Два поля файлу: ціль (autofill, під стабільними класами + хеш) і резюме (інша гілка форми).
const ashbyWorld = (autofill = {}, hashed = ASHBY_HASHED) => makeWorld([
  { id: 'autofill', css: hashed, alsoCss: [TYPE_SEL, ASHBY_CLEAN], box: { x: 20, y: 100, width: 1, height: 1 }, ...autofill },
  { id: 'resume', css: 'div#form > div.ashby-application-form-field-entry > input', alsoCss: [TYPE_SEL], box: { x: 20, y: 700, width: 1, height: 1 } },
]);

test('Ashby: міграція старого кроку — очищений CSS перед хешованим, pick лишається на input[type=file]', () => {
  const s = ashbyStep();
  assert.deepEqual(s.target.locs.map((l) => [l.by, l.value]), [['type', 'file'], ['css', ASHBY_CLEAN], ['css', ASHBY_HASHED]]);
  assert.equal(s.target.pick, 0);
  assert.equal(healthOf(s), 'weak');
  // ідемпотентно: повторна нормалізація не дублює кандидатів
  assert.deepEqual(normalizeStep(s).target.locs, s.target.locs);
});

test('Ashby: type неоднозначний (2 поля) + очищений CSS унікальний → 🔁 alt, файл у правильне поле, upgrade → очищений CSS; повтор — без heal і без upgrade', async () => {
  const s = ashbyStep();
  const w = ashbyWorld();
  const r = await run([s], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].strategy, 'loc-alt');
  assert.equal(r.dones[0].healed, true);
  assert.deepEqual(r.dones[0].upgrade, { idx: 1 });
  assert.deepEqual(w.files, [{ id: 'autofill', path: '/up/cv.pdf' }]);
  const up = r.logs.find((l) => /стане надійнішою/.test(l));
  assert.ok(up, r.logs.join('\n'));
  assert.ok(up.startsWith('🎯 Ціль «'), up);
  assert.ok(up.includes('стане надійнішою: ' + ASHBY_CLEAN + ' '), up);
  assert.ok(!up.includes('f7cvd'), 'у лозі — очищений шлях, не хешований: ' + up);

  // UI застосовує upgrade до збереженого кроку: pick → очищений CSS з n=1 → 🎯.
  const t2 = applyTargetUpgrade(s.target, r.dones[0].upgrade.idx);
  assert.deepEqual(t2.locs[t2.pick], { by: 'css', value: ASHBY_CLEAN, nth: null, n: 1 });
  const s2 = normalizeStep({ ...s, target: t2 });
  assert.equal(healthOf(s2), 'semantic');
  assert.deepEqual(s2.target.locs.length, 3, 'нормалізація оновленого кроку нічого не додає');

  // Повторний прогін: знайдено самим pick-ом → loc, без 🔁 і без 🎯.
  const w2 = ashbyWorld();
  const r2 = await run([s2], w2);
  assert.equal(r2.dones[0].ok, true);
  assert.equal(r2.dones[0].strategy, 'loc');
  assert.equal(r2.dones[0].healed, undefined);
  assert.equal(r2.dones[0].upgrade, undefined);
  assert.deepEqual(w2.files.map((f) => f.id), ['autofill']);
  assert.ok(!r2.logs.some((l) => /альтернативним|стане надійнішою/.test(l)), r2.logs.join('\n'));

  // Новий білд (хеш змінився): очищений pick і далі знаходить те саме поле.
  const w3 = ashbyWorld({}, ASHBY_HASHED2);
  const r3 = await run([s2], w3);
  assert.equal(r3.dones[0].ok, true);
  assert.equal(r3.dones[0].strategy, 'loc');
  assert.deepEqual(w3.files.map((f) => f.id), ['autofill']);
  assert.ok(!r3.logs.some((l) => /альтернативним|стане надійнішою/.test(l)), r3.logs.join('\n'));
});

test('Ashby: знайдено хешованим pick-ом, очищений CSS унікальний, але це ІНШИЙ елемент → без upgrade', async () => {
  // pick — хешований шлях (n=1); очищена копія знаходить рівно 1 елемент, але не той.
  const s = normalizeStep({
    v: 2, id: 's_x', type: 'file', fileId: 'x', filename: 'cv.pdf',
    target: { pick: 0, frame: null, kind: 'file', box: null, locs: [{ by: 'css', value: ASHBY_HASHED, nth: null, n: 1 }, { by: 'type', tag: 'input', value: 'file' }] },
  });
  assert.deepEqual(s.target.locs.map((l) => l.value), [ASHBY_CLEAN, ASHBY_HASHED, 'file']);
  assert.equal(s.target.pick, 1);
  const w = makeWorld([
    { id: 'real', css: ASHBY_HASHED, alsoCss: [TYPE_SEL], box: { x: 20, y: 100, width: 1, height: 1 } },
    { id: 'decoy', css: ASHBY_CLEAN, alsoCss: [TYPE_SEL], box: { x: 20, y: 700, width: 1, height: 1 } },
  ]);
  const r = await run([s], w);
  assert.equal(r.dones[0].ok, true);
  assert.equal(r.dones[0].strategy, 'loc');
  assert.equal(r.dones[0].upgrade, undefined);
  assert.deepEqual(w.files.map((f) => f.id), ['real']);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)), r.logs.join('\n'));
});

test('Ashby: крок упав (setInputFiles кинув) → без upgrade і без логу 🎯', async () => {
  const w = ashbyWorld({ filesFail: true });
  const r = await run([ashbyStep()], w);
  assert.equal(r.dones[0].ok, false);
  assert.equal(r.dones[0].upgrade, undefined);
  assert.deepEqual(w.files, []);
  assert.ok(!r.logs.some((l) => /стане надійнішою/.test(l)), r.logs.join('\n'));
});

test('scroll v2 з vx/vy — спершу рух миші в точку, потім колесо', async () => {
  const w = makeWorld([]);
  await run([{ v: 2, type: 'scroll', dx: 0, dy: 300, vx: 640, vy: 450 }], w);
  assert.deepEqual(w.moves.at(-1), [640, 450]);
});

test('handleDialogs:false — runReplay не вішає власний обробник діалогів; після прогону слухачі зняті', async () => {
  const w = makeWorld([]);
  const page = fakePage(w);
  await run([{ type: 'key', key: 'A' }], w, { page, handleDialogs: false });
  assert.equal(page.listenerCount('dialog'), 0);
  await run([{ type: 'key', key: 'A' }], w, { page });
  assert.equal(page.listenerCount('dialog'), 0);
});

// ---------- Stop під час пошуку цілі (регресія: null через abort ≠ «не знайдено») ----------

async function runAbortAt(steps, w, ms) {
  const clock = fakeClock();
  const ac = new AbortController();
  if (ms != null) clock.at(ms, () => ac.abort());
  const events = [];
  const res = await runReplay(fakePage(w), steps, {
    send: (e) => events.push(e), humanize: false, rng: mulberry32(3), clock, dom: fakeDom(w),
    resolveUpload: () => '/up/cv.pdf', signal: ac.signal,
  });
  return { res, events, logs: events.filter((e) => e.event === 'log').map((e) => e.text), dones: events.filter((e) => e.event === 'done-action') };
}

test('Stop під час пошуку цілі кліку: жодного координатного кліку, без «не знайдено» в лозі', async () => {
  const w = makeWorld([]);
  w.coordEls = [{ id: 'SUBMIT', x: 0, y: 0, w: 2000, h: 3000 }];
  const r = await runAbortAt([{ type: 'click', x: 300, y: 300, sw: 1280, target: tgt([role('button', 'Submit')]) }], w, 500);
  assert.equal(r.res.aborted, true);
  assert.equal(w.downs, undefined);
  assert.ok(!r.logs.some((t) => /не знайдено/.test(t)), r.logs.join('\n'));
  assert.equal(r.dones[0].ok, false);
  assert.equal(r.dones[0].error, 'зупинено');
  assert.equal(r.dones[0].aborted, true);
  assert.equal(r.dones[0].failShot, undefined);
});

test('Stop під час пошуку цілі тексту: без фокус-кліку і без друку', async () => {
  const w = makeWorld([]);
  w.coordEls = [{ id: 'F', x: 0, y: 0, w: 2000, h: 3000 }];
  const r = await runAbortAt([{ type: 'text', text: 'secret', x: 300, y: 300, sw: 1280, target: tgt([role('textbox', 'Email')], { kind: 'field', desc: 'поле' }) }], w, 500);
  assert.equal(r.res.aborted, true);
  assert.equal(w.downs, undefined);
  assert.equal(w.typed, undefined);
  assert.ok(!r.logs.some((t) => /не знайдено/.test(t)));
});

test('Stop під час пошуку поля файлу: setInputFiles не викликається (і запасні input теж)', async () => {
  const w = makeWorld([]);
  w.legacyInputs = ['legacy0'];
  const r = await runAbortAt([{ type: 'file', fileId: 'f', filename: 'cv.pdf', target: tgt([{ by: 'css', value: '#cv' }], { kind: 'file' }) }], w, 500);
  assert.equal(r.res.aborted, true);
  assert.deepEqual(w.files, []);
  assert.ok(!r.logs.some((t) => /не знайдено/.test(t)));
});

test('контроль: без Stop ціль так і не зʼявилась → координатний запасний клік після таймауту', async () => {
  const w = makeWorld([]);
  w.coordEls = [{ id: 'SUBMIT', x: 0, y: 0, w: 2000, h: 3000 }];
  const r = await runAbortAt([{ type: 'click', x: 300, y: 300, sw: 1280, target: tgt([role('button', 'Submit')]) }], w, null);
  assert.equal(r.res.aborted, false);
  assert.equal(w.downs.length, 1);
  assert.ok(r.logs.some((t) => /не знайдено за 6 с — координати/.test(t)));
  assert.equal(r.dones[0].strategy, 'coord');
});

// ---------- Фрейм цілі зʼявляється пізно / не зʼявляється (вбудована форма, напр. Ashby) ----------

const frmSpec = { chain: ['iframe#frm'], url: 'https://jobs.example.test/acme/*', path: 'https://jobs.example.test/acme/1/apply', name: 'embed', index: 1 };
const inFrame = (t) => ({ ...t, frame: frmSpec });

test('resolveTarget: таймаут цілі відлічується від ПОЯВИ фрейму; фрейм чекаємо до frameTimeout', async () => {
  // фрейм вставлено через 14 с (заміряно на preply.com: 0,7–14 с), кнопка — ще через 2 с
  const w = makeWorld([], { iframes: {} });
  const clock = fakeClock();
  clock.at(14000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; });
  clock.at(16000, () => { w.els.push(btn('in', { frame: 'f1' })); });
  const out = {};
  const r = await resolveTarget(fakePage(w), inFrame(tgt([role('button', 'Submit')])), { clock, timeout: 6000, frameTimeout: 30000, out });
  assert.ok(r, 'знайдено після пізньої появи фрейму');
  assert.equal(r.strategy, 'loc');
  assert.ok(r.frameMs >= 14000 && r.frameMs <= 14300, String(r.frameMs));
  assert.ok(r.ms >= 16000 && r.ms <= 16300, String(r.ms));
  assert.deepEqual(out, {});
});

test('resolveTarget: без frameTimeout — як раніше (усе в межах timeout); out пояснює причину null', async () => {
  const w = makeWorld([], { iframes: {} });
  const clock = fakeClock();
  clock.at(9000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; w.els.push(btn('in', { frame: 'f1' })); });
  const out = {};
  assert.equal(await resolveTarget(fakePage(w), inFrame(tgt([role('button', 'Submit')])), { clock, timeout: 6000, out }), null);
  assert.equal(out.frameMissing, true);
  assert.ok(out.waitedMs >= 6000 && out.waitedMs < 6300, String(out.waitedMs));
  // фрейм є, а цілі в ньому немає → frameMissing:false, чекали лише timeout (від появи фрейму)
  const w2 = makeWorld([], { iframes: { 'iframe#frm': { frame: 'f1' } } });
  const out2 = {};
  assert.equal(await resolveTarget(fakePage(w2), inFrame(tgt([role('button', 'Submit')])), { clock: fakeClock(), timeout: 6000, frameTimeout: 30000, out: out2 }), null);
  assert.equal(out2.frameMissing, false);
  assert.ok(out2.waitedMs >= 6000 && out2.waitedMs < 6300, String(out2.waitedMs));
  // фрейму так і немає → чекали frameTimeout
  const out3 = {};
  assert.equal(await resolveTarget(fakePage(makeWorld([], { iframes: {} })), inFrame(tgt([role('button', 'Submit')])), { clock: fakeClock(), timeout: 6000, frameTimeout: 30000, out: out3 }), null);
  assert.equal(out3.frameMissing, true);
  assert.ok(out3.waitedMs >= 30000 && out3.waitedMs < 30300, String(out3.waitedMs));
});

test('прогін: iframe форми зʼявився через 9 с → перший крок знайдено локатором (а не 📍 у порожнечу) + лог ⏳', async () => {
  const w = makeWorld([], { iframes: {} });
  const clock = fakeClock();
  clock.at(9000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; w.els.push(btn('tab', { frame: 'f1' })); });
  const step = { v: 2, type: 'click', target: inFrame(tgt([role('button', 'Submit')])), x: 697, y: 146, sw: 1280 };
  const { dones, logs } = await run([step], w, { clock });
  assert.equal(dones[0].ok, true);
  assert.equal(dones[0].strategy, 'loc');
  assert.deepEqual(w.clicks.map((c) => c.id), ['tab']);
  assert.equal((w.downs || []).length, 0, 'жодного координатного кліку');
  assert.ok(logs.some((t) => /⏳ Фрейм «jobs\.example\.test\/acme\/\*» зʼявився через 9 с/.test(t)), logs.join('\n'));
});

test('прогін: фрейм так і не зʼявився → збій кроку з причиною, без координатного кліку/друку; далі в тому ж фреймі — лише таймаут кроку', async () => {
  const w = makeWorld([], { iframes: {} });
  w.coordEls = [{ id: 'host-link', x: 0, y: 0, w: 2000, h: 3000 }]; // під координатами — щось на хост-сторінці
  const clock = fakeClock();
  const steps = [
    { v: 2, type: 'click', target: inFrame(tgt([role('button', 'Submit')])), x: 300, y: 300, sw: 1280 },
    { v: 2, type: 'click', target: inFrame(inTgt('Email')), x: 300, y: 500, sw: 1280 },
    { v: 2, type: 'text', text: 'a@b.c', target: inFrame(inTgt('Email')), x: 300, y: 500, sw: 1280 },
  ];
  const { dones } = await run(steps, w, { clock });
  assert.deepEqual(dones.map((d) => d.ok), [false, false, false]);
  assert.match(dones[0].error, /фрейм «jobs\.example\.test\/acme\/\*» не зʼявився \(або зник\) за 30 с/);
  assert.match(dones[1].error, /не зʼявився \(або зник\) за 6 с/); // памʼять «фрейму немає» — не 30 с на кожен крок
  assert.equal((w.downs || []).length, 0);
  assert.equal((w.typed || []).length, 0);
  assert.ok(clock.now() < 30000 + 6000 * 2 + 3000, String(clock.now()));
});

test('прогін: фрейм зʼявився пізніше, ніж збій попереднього кроку → повний бюджет фрейму повертається', async () => {
  const w = makeWorld([], { iframes: {} });
  const clock = fakeClock();
  clock.at(33000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; w.els.push(btn('b', { frame: 'f1' })); });
  const s = { v: 2, type: 'click', target: inFrame(tgt([role('button', 'Submit')])) };
  const { dones } = await run([s, s, s], w, { clock });
  // 1) 30 с — фрейму немає; 2) лише 6 с (памʼять) — фрейм зʼявився на 33-й с → знайдено; 3) знайдено одразу
  assert.deepEqual(dones.map((d) => d.ok), [false, true, true]);
});

test('клік v2: локатор не знайдено, під координатами порожнеча → збій БЕЗ кліку; legacy і «📍 лише координати» — клікають як раніше', async () => {
  const w = makeWorld([]);
  const v2 = await run([{ v: 2, type: 'click', target: tgt([role('button', 'Submit')]), x: 300, y: 300, sw: 1280, timeout: 500 }], w);
  assert.equal(v2.dones[0].ok, false);
  assert.match(v2.dones[0].error, /кнопка «Submit» не знайдено, а під записаними координатами порожньо/);
  assert.equal((w.downs || []).length, 0);
  const w2 = makeWorld([]);
  const legacy = await run([{ type: 'click', x: 300, y: 300, sw: 1280 }], w2);
  assert.equal(legacy.dones[0].ok, true);
  assert.equal(w2.downs.length, 1);
  const w3 = makeWorld([]);
  const coordsOnly = await run([{ v: 2, type: 'click', target: tgt([role('button', 'Submit')], { pick: -1 }), x: 300, y: 300, sw: 1280 }], w3);
  assert.equal(coordsOnly.dones[0].ok, true);
  assert.equal(w3.downs.length, 1);
});

test('текст після запасного 📍-кліку по тому ж полю: шукає поле сам; не дав фокусу полю → збій без друку', async () => {
  const mk = () => { const w = makeWorld([]); w.coordEls = [{ id: 'c', x: 0, y: 0, w: 400, h: 400 }]; return w; };
  const steps = [
    { v: 2, type: 'click', target: inTgt('Email'), x: 50, y: 50, timeout: 500 },
    { v: 2, type: 'text', text: 'hi', target: inTgt('Email'), x: 50, y: 50, timeout: 500 },
  ];
  // фокус не в полі → текст не друкується
  const w = mk();
  const r = await run(steps, w, { dom: { ...fakeDom(w), async focusIsEditable() { return false; } } });
  assert.deepEqual(r.dones.map((d) => [d.ok, d.strategy]), [[true, 'coord'], [false, 'coord']]);
  assert.match(r.dones[1].error, /не дав фокусу полю — текст не надруковано/);
  assert.equal((w.typed || []).length, 0);
  // фокус у полі → друкує (повторний координатний фокус-клік)
  const w2 = mk();
  const r2 = await run(steps, w2);
  assert.deepEqual(r2.dones.map((d) => d.ok), [true, true]);
  assert.deepEqual(w2.typed, ['hi']);
  assert.equal(w2.downs.length, 2);
  // поле зʼявилось між кроками → текстовий крок знаходить його локатором
  const w3 = mk();
  const clock = fakeClock();
  clock.at(600, () => { w3.els.push(input('email', 'Email')); });
  const r3 = await run(steps, w3, { clock });
  assert.deepEqual(r3.dones.map((d) => d.strategy), ['coord', 'loc']);
  assert.deepEqual(w3.clicks.map((c) => c.id), ['email']);
  assert.deepEqual(w3.typed, ['hi']);
});

test('resolveTarget: фрейм зʼявився і зник → frameMissing (без координат у хост-сторінку); повернувся → знайдено', async () => {
  const w = makeWorld([btn('in', { frame: 'f1' })], { iframes: { 'iframe#frm': { frame: 'f1', gone: true } } });
  w.els[0].gone = true;
  const clock = fakeClock();
  clock.at(500, () => { w.iframes['iframe#frm'].gone = false; });
  clock.at(700, () => { w.iframes['iframe#frm'].gone = true; });
  const out = {};
  assert.equal(await resolveTarget(fakePage(w), inFrame(tgt([role('button', 'Submit')])), { clock, timeout: 6000, frameTimeout: 30000, out }), null);
  assert.equal(out.frameMissing, true);
  assert.ok(out.waitedMs >= 30000, String(out.waitedMs)); // бюджет фрейму відновився після зникнення
  const clock2 = fakeClock();
  const w2 = makeWorld([btn('in', { frame: 'f1' })], { iframes: { 'iframe#frm': { frame: 'f1' } } });
  clock2.at(300, () => { w2.iframes['iframe#frm'].gone = true; });
  clock2.at(12000, () => { w2.iframes['iframe#frm'].gone = false; });
  w2.els[0].gone = true;
  clock2.at(12500, () => { w2.els[0].gone = false; });
  const r = await resolveTarget(fakePage(w2), inFrame(tgt([role('button', 'Submit')])), { clock: clock2, timeout: 6000, frameTimeout: 30000 });
  assert.ok(r && r.frameMs >= 12000, JSON.stringify(r && r.frameMs));
});

test('клік у пізньому фреймі: таймаут самого кліку — від появи фрейму, а не залишок від старту кроку', async () => {
  const w = makeWorld([], { iframes: {} });
  const clock = fakeClock();
  clock.at(14000, () => { w.iframes['iframe#frm'] = { frame: 'f1' }; w.els.push(btn('tab', { frame: 'f1' })); });
  const { dones } = await run([{ v: 2, type: 'click', target: inFrame(tgt([role('button', 'Submit')])) }], w, { clock });
  assert.equal(dones[0].strategy, 'loc');
  assert.ok(w.clicks[0].timeout > 5000, String(w.clicks[0].timeout));
});

test('клік після друку в ІНШЕ поле: mousedown → чекаємо збереження поля (blur-запит) → mouseup; у те саме поле — звичайний клік', async () => {
  const w = makeWorld([input('li', 'Linkedin'), btn('yes', { name: 'Yes', text: 'Yes' })]);
  const clock = fakeClock();
  const page = fakePage(w);
  const t = { down: null, up: null, saved: null };
  const blurReq = { method: () => 'POST', resourceType: () => 'fetch' };
  const down0 = page.mouse.down, up0 = page.mouse.up;
  page.mouse.down = async () => {
    t.down = clock.now(); await down0();
    page.emit('request', blurReq); // blur поля → сайт зберігає його
    clock.at(600, () => { t.saved = clock.now(); page.emit('requestfinished', blurReq); });
  };
  page.mouse.up = async () => { t.up = clock.now(); await up0(); };
  const { dones } = await run([
    { v: 2, type: 'click', target: inTgt('Linkedin') },
    { v: 2, type: 'text', text: 'asd', target: inTgt('Linkedin') },
    { v: 2, type: 'click', target: tgt([role('button', 'Yes')]) },
  ], w, { page, clock });
  assert.deepEqual(dones.map((d) => d.ok), [true, true, true]);
  assert.deepEqual(w.clicks.map((c) => c.id + (c.trial ? ':trial' : '')), ['li', 'yes:trial']); // поле — звичайний click; «Yes» — down/up
  assert.ok(t.up > t.saved && t.saved > t.down, JSON.stringify(t));
});

test('resolveScope: <iframe> є, але документ ще about:blank / без domcontentloaded → фрейму «ще немає»', async () => {
  const { frameReady } = await import('../lib/replay.js');
  const w = makeWorld([btn('in', { frame: 'f1' })], { iframes: { 'iframe#frm': { frame: 'f1' } } });
  const page = fakePage(w);
  let child = { url: () => 'about:blank', async waitForLoadState() {} };
  const main = page.mainFrame();
  main.locator = () => ({ async elementHandle() { return { async contentFrame() { return child; }, async dispose() {} }; } });
  assert.equal(await resolveScope(page, frmSpec), null);
  child = { url: () => 'https://jobs.example.test/acme/1', async waitForLoadState() { throw new Error('Timeout 50ms'); } };
  assert.equal(await resolveScope(page, frmSpec), null);
  child = { url: () => 'https://jobs.example.test/acme/1', async waitForLoadState() {} };
  assert.ok(await resolveScope(page, frmSpec));
  assert.equal(await frameReady({ url: () => 'https://x.test/', isDetached: () => true }), false);
  // клік: таймаут цілі (6 с) рахується від ГОТОВНОСТІ документа, а не від появи <iframe>
  const clock = fakeClock();
  child = { url: () => 'about:blank', async waitForLoadState() {} };
  clock.at(9000, () => { child = { url: () => 'https://jobs.example.test/acme/1', async waitForLoadState() {} }; });
  const r = await resolveTarget(page, inFrame(tgt([role('button', 'Submit')])), { clock, timeout: 6000, frameTimeout: 30000 });
  assert.ok(r && r.frameMs >= 9000, JSON.stringify(r && r.frameMs));
});
