// lib/capture.js без браузера: DESCRIBE_FN / IFRAME_DESC_FN на мінімальному фейковому
// DOM у vm (форма ElementDesc із lib/locators.js), locatorFor, countCandidates (бюджет
// часу), nthForCss, captureTarget (кандидати + лічильники + nth + фрейм).
// Справжній DOM (shadow root, iframe, label) — test/e2e/live.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'vm';
import { DESCRIBE_FN, IFRAME_DESC_FN, HIT_HANDLE_FN, locatorFor, countCandidates, nthForCss, captureTarget } from '../lib/capture.js';
import { buildCandidates } from '../lib/locators.js';

// Мінімальний елемент DOM.
function el(tag, attrs = {}, extra = {}) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, children: [], parentElement: null, previousElementSibling: null,
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    hasAttribute(n) { return n in this.attrs; },
    get classList() { return (this.attrs.class || '').split(/\s+/).filter(Boolean); },
    getRootNode() { return extra.root || null; },
    getBoundingClientRect() { return extra.rect || { left: 10, top: 20, width: 100, height: 30 }; },
    innerText: extra.innerText, textContent: extra.textContent ?? extra.innerText, isContentEditable: false,
    ...extra,
  };
  return e;
}
function append(parent, child) {
  const prev = parent.children.at(-1) || null;
  child.parentElement = parent;
  child.previousElementSibling = prev;
  parent.children.push(child);
  return child;
}
function runIn(fn, arg, { scrollX = 0, scrollY = 0, byId = {} } = {}) {
  const document = { getElementById: (id) => byId[id] || null, querySelectorAll: () => [], body: null };
  const ctx = vm.createContext({ window: { scrollX, scrollY }, document });
  ctx.__arg = arg;
  // JSON — як серіалізація результату evaluate у Playwright (і прибирає чужий realm)
  return JSON.parse(JSON.stringify(vm.runInContext('(' + fn.toString() + ')(__arg)', ctx)));
}

test('серіалізовані функції сторінки парсяться окремо (без замикань на модуль)', () => {
  for (const fn of [DESCRIBE_FN, IFRAME_DESC_FN, HIT_HANDLE_FN]) {
    assert.doesNotThrow(() => new Function('return (' + fn.toString() + ')'));
  }
});

test('DESCRIBE_FN: поле з <label> → форма ElementDesc; бокс у doc-координатах фрейму + vbox', () => {
  const html = el('html'), body = append(html, el('body'));
  const form = append(body, el('form', { id: 'apply', class: 'css-1x2y3z main' }));
  append(form, el('div'));
  const input = append(form, el('input', { id: 'email', name: 'email', placeholder: 'you@ex.com', 'data-testid': 'email-in' }, {
    labels: [{ innerText: '  Email\n address ' }], value: '',
  }));
  const d = runIn(DESCRIBE_FN, input, { scrollY: 500 });
  assert.equal(d.tag, 'INPUT');
  assert.equal(d.type, 'text');           // без атрибута type → text
  assert.equal(d.label, 'Email address');
  assert.equal(d.name, 'Email address');  // accessible name поля — з label
  assert.equal(d.text, null);             // для полів тексту немає
  assert.deepEqual(d.testid, { attr: 'data-testid', value: 'email-in' });
  assert.equal(d.placeholder, 'you@ex.com');
  assert.equal(d.nameAttr, 'email');
  assert.equal(d.id, 'email');
  assert.deepEqual(d.box, { x: 10, y: 520, w: 100, h: 30 });
  assert.deepEqual(d.vbox, { x: 10, y: 20, w: 100, h: 30 });
  assert.deepEqual(d.path.map((p) => p.tag), ['html', 'body', 'form', 'input']);
  assert.deepEqual(d.path[2].classes, ['css-1x2y3z', 'main']);
  assert.equal(d.path[3].nth, 1);
  // з buildCandidates: testid → role+name → label → placeholder → name → id → css
  assert.deepEqual(buildCandidates(d).map((c) => c.by), ['testid', 'role', 'label', 'placeholder', 'name', 'id', 'css']);
});

test('DESCRIBE_FN: кнопка — name з тексту, aria-labelledby пріоритетніший; type=submit value', () => {
  const b = el('button', { class: 'btn' }, { innerText: 'Submit  Application' });
  assert.equal(runIn(DESCRIBE_FN, b).name, 'Submit Application');
  assert.equal(runIn(DESCRIBE_FN, b).text, 'Submit Application');
  const lb = el('button', { 'aria-labelledby': 'l1 l2', 'aria-label': 'ignored' }, { innerText: 'x' });
  assert.equal(runIn(DESCRIBE_FN, lb, { byId: { l1: { textContent: 'Подати' }, l2: { textContent: 'заявку' } } }).name, 'Подати заявку');
  const sub = el('input', { type: 'SUBMIT' }, { value: '' });
  const ds = runIn(DESCRIBE_FN, sub);
  assert.equal(ds.type, 'submit');
  assert.equal(ds.name, 'Submit');
});

test('DESCRIBE_FN: <select> — опції, size, multiple; nth-of-type серед братів', () => {
  const parent = el('div');
  append(parent, el('select'));
  const s = append(parent, el('select', { id: 'country' }, {
    multiple: false, size: 0, labels: [{ innerText: 'Країна' }],
    options: [{ value: 'UA', label: 'Україна', selected: true }, { value: 'PL', text: ' Польща ', disabled: true }],
  }));
  const d = runIn(DESCRIBE_FN, s);
  assert.equal(d.size, 0);
  assert.deepEqual(d.options, [
    { value: 'UA', label: 'Україна', selected: true, disabled: false },
    { value: 'PL', label: 'Польща', selected: false, disabled: true },
  ]);
  assert.equal(d.path.at(-1).nth, 2);
});

test('IFRAME_DESC_FN: id/name/title/src і індекс серед iframe документа', () => {
  const fr = el('iframe', { id: 'ashby_embed', title: 'Форма', src: '/x' }, { src: 'https://jobs.example.test/x' });
  const document = { body: null, querySelectorAll: () => [el('iframe'), fr], getElementById: () => null };
  const ctx = vm.createContext({ document, window: {} });
  ctx.__arg = fr;
  const d = JSON.parse(JSON.stringify(vm.runInContext('(' + IFRAME_DESC_FN.toString() + ')(__arg)', ctx)));
  assert.deepEqual({ ...d, cssPath: undefined }, { id: 'ashby_embed', name: null, title: 'Форма', src: 'https://jobs.example.test/x', cssPath: undefined, index: 1 });
  assert.equal(d.cssPath, 'body > iframe:nth-of-type(1)');
});

// --- фейкова область пошуку Playwright ---
function fakeScope(counts, { delayMs = {}, boxes = {} } = {}) {
  const calls = [];
  const mk = (key) => ({
    key,
    async count() { calls.push(key); if (delayMs[key]) await new Promise((r) => setTimeout(r, delayMs[key])); if (counts[key] instanceof Error) throw counts[key]; return counts[key] ?? 0; },
    nth(i) { return { ...mk(key + '#' + i), async boundingBox() { return (boxes[key] || [])[i] || null; } }; },
  });
  return {
    calls,
    getByRole: (r, o) => mk('role:' + r + ':' + (o && o.name)),
    getByLabel: (v) => mk('label:' + v),
    getByPlaceholder: (v) => mk('ph:' + v),
    getByText: (v) => mk('text:' + v),
    getByTestId: (v) => mk('testid:' + v),
    locator: (css) => mk('css:' + css),
  };
}

test('locatorFor: toPlaywright → виклик на області; nth для CSS; невідомий метод → null', () => {
  const sc = fakeScope({});
  assert.equal(locatorFor(sc, { by: 'role', role: 'button', name: 'Go' }).key, 'role:button:Go');
  assert.equal(locatorFor(sc, { by: 'testid', attr: 'data-qa', value: 'x' }).key, 'css:[data-qa="x"]');
  assert.equal(locatorFor(sc, { by: 'css', value: 'div > a', nth: 2 }).key, 'css:div > a#2');
  assert.equal(locatorFor({}, { by: 'role', role: 'button' }), null);
  assert.equal(locatorFor(sc, { by: 'weird' }), null);
});

test('countCandidates: лічильники в порядку кандидатів; помилка/бюджет → null; не більше max', async () => {
  const cands = [
    { by: 'role', role: 'button', name: 'A' }, { by: 'text', value: 'A' }, { by: 'id', value: 'a' },
    { by: 'css', value: 'b' }, { by: 'label', value: 'L' }, { by: 'placeholder', value: 'P' }, { by: 'css', value: 'z' },
  ];
  const sc = fakeScope({ 'role:button:A': 1, 'text:A': 3, 'css:#a': new Error('x'), 'css:b': 2, 'label:L': 0, 'ph:P': 1 }, { delayMs: { 'css:b': 300 } });
  const t0 = Date.now();
  const counts = await countCandidates(sc, cands, { budgetMs: 80 });
  assert.ok(Date.now() - t0 < 250, 'бюджет дотримано');
  assert.deepEqual(counts, [1, 3, null, null, 0, 1, null]); // 7-й — поза max=6
  assert.equal(sc.calls.includes('css:z'), false);
});

test('nthForCss: індекс збігу, чий бокс збігається з ціллю; інакше null', async () => {
  const boxes = { 'css:div.a > button': [{ x: 0, y: 0, width: 10, height: 10 }, { x: 200, y: 50, width: 100, height: 30 }, null] };
  const sc = fakeScope({ 'css:div.a > button': 3 }, { boxes });
  assert.equal(await nthForCss(sc, { by: 'css', value: 'div.a > button', nth: null }, { x: 200, y: 50, w: 100, h: 30 }), 1);
  assert.equal(await nthForCss(sc, { by: 'css', value: 'div.a > button' }, { x: 900, y: 900, w: 10, h: 10 }), null);
  assert.equal(await nthForCss(sc, { by: 'css', value: 'div.a > button' }, null), null);
});

test('captureTarget: ціль з rel від точки, лічильники ранжують, CSS із кількома збігами отримує nth', async () => {
  const desc = {
    tag: 'BUTTON', type: null, role: null, name: 'Додати', label: null, placeholder: null, nameAttr: null, id: null, testid: null,
    text: 'Додати', href: null, alt: null, editable: false, multiple: false,
    path: [{ tag: 'html', classes: [], nth: 1 }, { tag: 'body', classes: [], nth: 1 }, { tag: 'div', classes: ['card'], nth: 2 },
      { tag: 'div', classes: ['a'], nth: 1 }, { tag: 'div', classes: ['b'], nth: 1 }, { tag: 'div', classes: ['c'], nth: 1 },
      { tag: 'div', classes: ['d'], nth: 1 }, { tag: 'button', classes: ['add'], nth: 1 }],
    cssPath: null, nth: null,
    box: { x: 220, y: 650, w: 100, h: 30 }, vbox: { x: 220, y: 150, w: 100, h: 30 },
  };
  const css = 'div.a > div.b > div.c > div.d > button.add';
  const sc = fakeScope({ 'role:button:Додати': 3, 'text:Додати': 3, ['css:' + css]: 3 }, {
    boxes: { ['css:' + css]: [{ x: 20, y: 150, width: 100, height: 30 }, { x: 220, y: 150, width: 100, height: 30 }, { x: 420, y: 150, width: 100, height: 30 }] },
  });
  const frame = { parentFrame: () => null };
  const t = await captureTarget(null, { frame: Object.assign(sc, frame), desc }, { point: { x: 245, y: 665 } });
  assert.equal(t.frame, null);
  assert.deepEqual(t.locs[0], { by: 'css', value: css, nth: 1, n: 1 });
  assert.deepEqual(t.locs.slice(1).map((l) => [l.by, l.n]), [['role', 3], ['text', 3]]);
  assert.equal(t.pick, 0);
  assert.deepEqual(t.rel, { rx: 0.25, ry: 0.5 });
  assert.deepEqual(t.box, { x: 220, y: 650, w: 100, h: 30 });
  assert.equal(t.kind, 'button');
  assert.equal(t.desc, 'кнопка «Додати»');
});
