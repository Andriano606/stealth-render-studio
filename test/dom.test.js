// Зонди сторінки з lib/dom.js (HIT_FN, SNAP_FN, MEASURE_FN, NEUTRAL_FN, FOCUS_FN) на
// мінімальному фейковому DOM у vm — ЛОГІКА гілок (optionLike, fixed/sticky, видимість
// snap-кандидата, пропуск відкривачів/disabled, вставки шапок, нейтральна точка).
// Справжня геометрія — test/e2e/dom.e2e.test.js (E2E=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'vm';
import { HIT_FN, SNAP_FN, MEASURE_FN, NEUTRAL_FN, FOCUS_FN, IFRAMES_FN } from '../lib/dom.js';

// --- фейковий DOM ---
// spec: { tag, rect:[l,t,w,h], style:{position,cursor,overflowY,overflowX}, attrs, cls, id,
//         match (відповідає INTERACTIVE_SEL / SNAP_SEL), noHit (pointer-events:none), kids:[spec] }
function build(specs, { W = 1280, H = 900, scrollY = 0 } = {}) {
  const all = [];
  const mk = (sp, parent) => {
    const [l, t, w, h] = sp.rect || [0, 0, 0, 0];
    const e = {
      nodeType: 1, tagName: (sp.tag || 'div').toUpperCase(), id: sp.id || '', parentElement: parent || null,
      className: sp.svg ? { baseVal: sp.cls || '' } : (sp.cls || ''), attrs: { ...(sp.attrs || {}) },
      style: { position: 'static', cursor: 'auto', overflowX: 'visible', overflowY: 'visible', paddingLeft: '0px', paddingTop: '0px', ...(sp.style || {}) },
      match: !!sp.match, noHit: !!sp.noHit, disabled: !!sp.disabled, readOnly: !!sp.readOnly, type: sp.type || '',
      isContentEditable: !!sp.editable, textContent: sp.text || '', innerText: sp.text || '', value: sp.value || '',
      scrollHeight: sp.scrollHeight || h, clientHeight: h, scrollWidth: sp.scrollWidth || w, clientWidth: w,
      clientLeft: sp.border || 0, clientTop: sp.border || 0, shadowRoot: null, kids: [],
      getAttribute(n) { return n in this.attrs ? this.attrs[n] : (n === 'type' && this.type ? this.type : null); },
      hasAttribute(n) { return n in this.attrs; },
      getBoundingClientRect() { return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h }; },
      getRootNode() { return sp.host ? { host: sp.host() } : DOC; },
      closest() { for (let n = this; n; n = n.parentElement) if (n.match) return n; return null; },
      matches() { return this.match; },
      contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; },
    };
    all.push(e);
    for (const k of sp.kids || []) e.kids.push(mk(k, e));
    return e;
  };
  const html = mk({ tag: 'html', rect: [0, 0, W, H] }, null);
  const body = mk({ tag: 'body', rect: [0, 0, W, H] }, html);
  const DOC = {
    documentElement: html, body, scrollingElement: { scrollHeight: 4000 },
    activeElement: body,
    elementsFromPoint(x, y) {
      return all.filter((e) => !e.noHit && (() => { const r = e.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; })()).reverse();
    },
    elementFromPoint(x, y) { return this.elementsFromPoint(x, y)[0] || null; },
    querySelectorAll(sel) { return all.filter((e) => (sel === 'iframe, frame' ? /^I?FRAME$/.test(e.tagName) : e.match)); },
  };
  html.scrollWidth = W;
  html.scrollHeight = 4000;
  const roots = specs.map((sp) => mk(sp, body));
  const run = (fn, arg) => {
    const ctx = vm.createContext({
      document: DOC, innerWidth: W, innerHeight: H, getComputedStyle: (n) => n.style,
      window: { devicePixelRatio: 2, scrollY, scrollX: 0 },
    });
    ctx.globalThis = ctx;
    ctx.__arg = arg;
    const out = vm.runInContext('(' + fn.toString() + ')(__arg)', ctx);
    return { out: out === undefined ? undefined : JSON.parse(JSON.stringify(out)), ctx };
  };
  return { DOC, all, body, roots, run };
}

test('серіалізовані зонди парсяться окремо (без замикань на модуль)', () => {
  for (const fn of [HIT_FN, SNAP_FN, MEASURE_FN, NEUTRAL_FN, FOCUS_FN, IFRAMES_FN]) {
    assert.doesNotThrow(() => new Function('return (' + fn.toString() + ')'));
  }
});

test('HIT_FN: optionLike за класом/id/aria-selected (до 4 предків), SVG className.baseVal; глибше — ні', () => {
  const opt = (sp) => build([sp]).run(HIT_FN, { x: 50, y: 50, sel: 'X' }).out.optionLike;
  assert.equal(opt({ rect: [0, 0, 100, 100], cls: 'dd-option' }), true);
  assert.equal(opt({ rect: [0, 0, 100, 100], cls: 'select__option--is-focused' }), true);
  assert.equal(opt({ rect: [0, 0, 100, 100], id: 'menu-item-3' }), true);
  assert.equal(opt({ rect: [0, 0, 100, 100], attrs: { 'aria-selected': 'false' } }), true);
  assert.equal(opt({ rect: [0, 0, 100, 100], cls: 'listbox-item', svg: true }), true);
  assert.equal(opt({ rect: [0, 0, 100, 100], cls: 'adoption-form' }), false); // «option» не на межі слова
  assert.equal(opt({ rect: [0, 0, 100, 100], cls: 'heading' }), false);
  // клас опції на предкові глибини 2 — так; глибини 5 — ні
  const nest = (depth) => {
    let sp = { rect: [0, 0, 100, 100] };
    for (let i = 0; i < depth; i++) sp = { rect: [0, 0, 100, 100], kids: [sp] };
    sp.cls = 'menu-item';
    return sp;
  };
  assert.equal(opt(nest(2)), true);
  assert.equal(opt(nest(5)), false);
});

test('HIT_FN: fixed і sticky — окремі прапорці (sticky залежить від scrollY)', () => {
  const hit = (pos) => build([{ rect: [0, 0, 300, 300], style: { position: pos }, kids: [{ rect: [0, 0, 100, 100], match: true }] }])
    .run(HIT_FN, { x: 50, y: 50, sel: 'X' }).out;
  assert.deepEqual([hit('fixed').fixed, hit('fixed').sticky], [true, false]);
  assert.deepEqual([hit('sticky').fixed, hit('sticky').sticky], [false, true]);
  assert.deepEqual([hit('static').fixed, hit('static').sticky], [false, false]);
});

test('HIT_FN: interactive через closest, cursor:pointer, expanded; поза viewport → null; iframe → fbox і stash', () => {
  let d = build([{ rect: [0, 0, 200, 50], match: true, attrs: { 'aria-expanded': 'true' }, kids: [{ rect: [0, 0, 100, 50], tag: 'span', text: 'Країна' }] }]);
  let r = d.run(HIT_FN, { x: 10, y: 10, sel: 'X' }).out;
  assert.equal(r.tag, 'SPAN');
  assert.equal(r.interactive, true);
  assert.equal(r.expanded, true);
  assert.equal(r.fbox, null);
  d = build([{ rect: [0, 0, 100, 100], style: { cursor: 'pointer' } }]);
  assert.equal(d.run(HIT_FN, { x: 10, y: 10, sel: 'X' }).out.pointer, true);
  assert.equal(d.run(HIT_FN, { x: -1, y: 10, sel: 'X' }).out, null);
  assert.equal(d.run(HIT_FN, { x: 10, y: 900, sel: 'X' }).out, null);
  d = build([{ tag: 'iframe', rect: [100, 200, 400, 300], border: 2, style: { paddingLeft: '3px', paddingTop: '4px' } }]);
  const { out, ctx } = d.run(HIT_FN, { x: 150, y: 250, sel: 'X', stash: true });
  assert.deepEqual(out.fbox, { x: 105, y: 206, w: 400, h: 300 });
  assert.equal(ctx.__srsHitFrame.tagName, 'IFRAME');
  const noStash = d.run(HIT_FN, { x: 150, y: 250, sel: 'X' });
  assert.equal(noStash.ctx.__srsHitFrame, undefined); // без stash — жодних глобалів
});

test('SNAP_FN: лише видимі (не перекриті), не відкривачі aria-expanded, не disabled, у радіусі й у viewport; LABEL.control', () => {
  const d = build([
    { id: 'near', rect: [120, 100, 100, 30], match: true },                       // 20px — видимий
    { id: 'hidden', rect: [100, 130, 80, 30], match: true },                      // 15px, але під модалкою
    { id: 'opener', rect: [100, 60, 80, 30], match: true, attrs: { 'aria-expanded': 'true' } },
    { id: 'dis', rect: [60, 110, 30, 30], match: true, disabled: true },
    { id: 'far', rect: [400, 100, 50, 30], match: true },
    { id: 'tiny', rect: [100, 112, 3, 3], match: true },
    { id: 'modal', rect: [90, 128, 200, 60], noHit: false },                      // перекриває hidden
  ]);
  const out = d.run(SNAP_FN, { x: 100, y: 115, sel: 'X', maxDist: 60 }).out;
  assert.deepEqual(out, [{ x: 120, y: 100, w: 100, h: 30 }]);
  // LABEL поверх поля, що його контролює, — поле видиме
  const d2 = build([{ id: 'inp', tag: 'input', rect: [100, 100, 100, 30], match: true }]);
  const inp = d2.roots[0];
  d2.DOC.elementFromPoint = () => ({ tagName: 'LABEL', control: inp });
  assert.equal(d2.run(SNAP_FN, { x: 90, y: 110, sel: 'X', maxDist: 60 }).out.length, 1);
  d2.DOC.elementFromPoint = () => ({ tagName: 'LABEL', control: null }); // чужий label поверх — невидимий
  assert.equal(d2.run(SNAP_FN, { x: 90, y: 110, sel: 'X', maxDist: 60 }).out.length, 0);
});

test('MEASURE_FN: вставки fixed-шапки/футера через elementsFromPoint (≤ 40% висоти); insets:false → 0', () => {
  const d = build([
    { id: 'hdr', rect: [0, 0, 1280, 64], style: { position: 'fixed' } },
    { id: 'ftr', rect: [0, 840, 1280, 60], style: { position: 'sticky' } },
    { id: 'huge', rect: [0, 0, 10, 900], style: { position: 'fixed' } },        // > 40% — ігнор
  ], { scrollY: 123 });
  const m = d.run(MEASURE_FN, true).out;
  assert.equal(m.topInset, 64);
  assert.equal(m.bottomInset, 60);
  assert.equal(m.scrollY, 123);
  assert.equal(m.dpr, 2);
  assert.equal(m.w, 1280);
  const m0 = d.run(MEASURE_FN, false).out;
  assert.deepEqual([m0.topInset, m0.bottomInset], [0, 0]);
});

test('NEUTRAL_FN: пропускає інтерактивне, iframe/select/textarea і внутрішні скролери; поза viewport', () => {
  const d = build([
    { id: 'btn', rect: [0, 0, 100, 100], match: true },
    { tag: 'iframe', rect: [100, 0, 100, 100] },
    { id: 'list', rect: [200, 0, 100, 100], style: { overflowY: 'auto' }, scrollHeight: 500, kids: [{ rect: [200, 0, 100, 100] }] },
    { id: 'plain', rect: [300, 0, 100, 100] },
  ]);
  const pts = [{ x: -5, y: 5 }, { x: 50, y: 50 }, { x: 150, y: 50 }, { x: 250, y: 50 }, { x: 350, y: 50 }];
  assert.deepEqual(d.run(NEUTRAL_FN, { pts, sel: 'X' }).out, { x: 350, y: 50 });
  assert.equal(d.run(NEUTRAL_FN, { pts: pts.slice(0, 4), sel: 'X' }).out, null);
});

test('FOCUS_FN: поле → edit; readOnly/кнопка/body → no; фокус в iframe → frame (+stash лише за запитом)', () => {
  const d = build([
    { id: 'in', tag: 'input', rect: [0, 0, 10, 10], type: 'text' },
    { id: 'ro', tag: 'textarea', rect: [0, 0, 10, 10], readOnly: true },
    { id: 'cb', tag: 'input', rect: [0, 0, 10, 10], type: 'checkbox' },
    { id: 'fr', tag: 'iframe', rect: [0, 0, 10, 10] },
    { id: 'ce', rect: [0, 0, 10, 10], editable: true },
  ]);
  const [inp, ro, cb, fr, ce] = d.roots;
  const at = (el, arg) => { d.DOC.activeElement = el; return d.run(FOCUS_FN, arg); };
  assert.equal(at(inp).out, 'edit');
  assert.equal(at(ce).out, 'edit');
  assert.equal(at(ro).out, 'no');
  assert.equal(at(cb).out, 'no');
  assert.equal(at(d.body).out, 'no');
  const f = at(fr, { stash: true });
  assert.equal(f.out, 'frame');
  assert.equal(f.ctx.__srsFocus.tagName, 'IFRAME');
  assert.equal(at(fr, {}).ctx.__srsFocus, undefined);
});
