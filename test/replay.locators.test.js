// Відтворення кроків v2 з target (lib/replay.js): resolveScope/resolveTarget і
// гілки runReplay «спершу локатор» — на фейкових локаторах Playwright (без браузера).
// Legacy-шлях (координати) покривають test/replay.test.js і e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { runReplay, resolveTarget, resolveScope, hasTarget, hasCoords } from '../lib/replay.js';
import { nearestRect, scrollPlan } from '../lib/coords.js';
import { mulberry32 } from '../lib/rng.js';

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
      async count() { return list().length; },
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
      async setInputFiles(p) { w.files.push({ id: one().id, path: p }); },
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
        return loc(() => matchIn(frame, (e) => e.css === css), css);
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
