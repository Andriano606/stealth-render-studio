// Юніт-тести lib/locators.js — кандидати, ранжування, фрейми, геометрія.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isStableToken, implicitRole, kindOf, describeTarget, buildCandidates, buildCssPath,
  rankWithCounts, targetFromDesc, cssEscapeAttr, cssEscapeIdent, frameSelector, frameUrlPattern,
  originPath, matchGlob, frameSpecFrom, matchFrame, pickNearest, pointInBox, specToString, toPlaywright,
  MAX_LOCS,
  stripUnstableClasses, isStableCss,
} from '../lib/locators.js';

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('модуль ізоморфний: жодних імпортів (тим паче node:*)', () => {
  const src = fs.readFileSync(new URL('../lib/locators.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bBuffer\b/);
});

test('isStableToken: стабільні проходять', () => {
  for (const s of ['email', 'submit-btn', 'ashby_embed_iframe', 'firstName', 'col-md-6', 'h1-title', 'step3', 'api2', 'MuiButton-root']) {
    assert.equal(isStableToken(s), true, s);
  }
});

test('isStableToken: згенеровані/хешовані відкидаються', () => {
  for (const s of ['css-1x2y3z', 'sc-bdVaJa', 'jsx-123456', 'emotion-0', 'jss42', 'ember123', 'svelte-xyz12',
    ':r1:', '«r3»', 'headlessui-listbox-button-3', 'radix-:R2a:', 'react-select-2-input', 'mui-17',
    'Button_root__a1B2c', 'x7f3k', 'a1b2c3', '1abc', 'id-1693045', 'deadbeefcafe',
    '978dbfa9-87b8-472d-81b3-b7d048da8b03', '', null, undefined, 'a b', 'x'.repeat(65), 'data-v-7ba5bd90']) {
    assert.equal(isStableToken(s), false, String(s));
  }
});

test('implicitRole: явна роль має пріоритет, неявні з тегу/type', () => {
  assert.equal(implicitRole({ tag: 'DIV', role: 'Button  menuitem' }), 'button');
  assert.equal(implicitRole({ tag: 'BUTTON' }), 'button');
  assert.equal(implicitRole({ tag: 'A', href: '/x' }), 'link');
  assert.equal(implicitRole({ tag: 'A', href: null }), null);
  assert.equal(implicitRole({ tag: 'INPUT', type: 'submit' }), 'button');
  assert.equal(implicitRole({ tag: 'INPUT', type: 'email' }), 'textbox');
  assert.equal(implicitRole({ tag: 'INPUT', type: null }), 'textbox');
  assert.equal(implicitRole({ tag: 'INPUT', type: 'password' }), null);
  assert.equal(implicitRole({ tag: 'INPUT', type: 'file' }), null);
  assert.equal(implicitRole({ tag: 'INPUT', type: 'checkbox' }), 'checkbox');
  assert.equal(implicitRole({ tag: 'SELECT' }), 'combobox');
  assert.equal(implicitRole({ tag: 'SELECT', multiple: true }), 'listbox');
  assert.equal(implicitRole({ tag: 'TEXTAREA' }), 'textbox');
  assert.equal(implicitRole({ tag: 'H2' }), 'heading');
  assert.equal(implicitRole({ tag: 'DIV', editable: true }), 'textbox');
  assert.equal(implicitRole({ tag: 'DIV' }), null);
  assert.equal(implicitRole(null), null);
});

test('kindOf + describeTarget українською', () => {
  assert.equal(kindOf({ tag: 'INPUT', type: 'file' }), 'file');
  assert.equal(kindOf({ tag: 'INPUT', type: 'submit' }), 'button');
  assert.equal(kindOf({ tag: 'DIV', role: 'button' }), 'button');
  assert.equal(kindOf({ tag: 'DIV', editable: true }), 'editable');
  assert.equal(kindOf({ tag: 'DIV', kind: 'link' }), 'link');
  assert.equal(describeTarget({ tag: 'BUTTON', name: 'Submit Application' }), 'кнопка «Submit Application»');
  assert.equal(describeTarget({ tag: 'INPUT', type: 'email', label: 'Email', name: 'Email' }), 'поле «Email»');
  assert.equal(describeTarget({ tag: 'SELECT', label: 'Country' }), 'список «Country»');
  assert.equal(describeTarget({ tag: 'SPAN' }), 'елемент <span>');
  assert.equal(describeTarget({ tag: 'BUTTON' }), 'кнопка');
  assert.match(describeTarget({ tag: 'A', href: '/', text: 'x'.repeat(100) }), /^посилання «x+…»$/);
});

test('buildCandidates: повний порядок testid → role → label → placeholder → name → id → text → css', () => {
  const d = {
    tag: 'INPUT', type: 'email', name: 'Email', label: 'Email', placeholder: 'you@ex.com', nameAttr: 'email',
    id: 'email', testid: { attr: 'data-testid', value: 'email-input' }, text: null,
    path: [{ tag: 'html' }, { tag: 'body' }, { tag: 'form', id: 'apply' }, { tag: 'div', classes: ['field', 'css-1x2y3z'], nth: 2 }, { tag: 'input' }],
    nth: 0, box: { x: 10, y: 20, w: 200, h: 30 },
  };
  const c = buildCandidates(d);
  assert.deepEqual(c.map(l => l.by), ['testid', 'role', 'label', 'placeholder', 'name', 'id', 'css']);
  assert.deepEqual(c[1], { by: 'role', role: 'textbox', name: 'Email', exact: true });
  assert.deepEqual(c[4], { by: 'name', tag: 'input', value: 'email' });
  assert.equal(c[6].value, 'form#apply > div.field:nth-of-type(2) > input');
  assert.equal(c[6].nth, 0);
});

test('buildCandidates: кнопка з текстом, хешованим id і довгим імʼям', () => {
  const c = buildCandidates({ tag: 'BUTTON', type: 'submit', name: 'Submit Application', text: 'Submit Application', id: 'css-9xk2a1', cssPath: 'form button' });
  assert.deepEqual(c.map(l => l.by), ['role', 'text', 'css']);
  assert.equal(c[2].nth, null);
  const long = 'x'.repeat(81);
  const c2 = buildCandidates({ tag: 'BUTTON', name: long, text: long });
  assert.deepEqual(c2.map(l => l.by), []); // ні role (>80), ні text (>50)
  // поле вводу не отримує text-кандидата; label лише для полів
  assert.ok(!buildCandidates({ tag: 'TEXTAREA', text: 'abc', label: 'Bio' }).some(l => l.by === 'text'));
  assert.ok(!buildCandidates({ tag: 'BUTTON', label: 'X', name: 'Go' }).some(l => l.by === 'label'));
  assert.deepEqual(buildCandidates(null), []);
});

test('buildCandidates: testid інших атрибутів, uuid-testid відкидається, дублікати прибрано', () => {
  const c = buildCandidates({ tag: 'DIV', testid: { attr: 'data-qa', value: 'apply' } });
  assert.deepEqual(c, [{ by: 'testid', attr: 'data-qa', value: 'apply' }]);
  assert.deepEqual(buildCandidates({ tag: 'DIV', testid: { attr: 'data-testid', value: 'row-978dbfa9-87b8-472d-81b3-b7d048da8b03' } }), []);
  const dup = buildCandidates({ tag: 'A', href: '/x', name: 'Go', text: 'Go', path: [{ tag: 'a' }], cssPath: 'a' });
  assert.equal(dup.filter(l => l.by === 'css').length, 1);
});

test('buildCssPath: якір на найближчому стабільному id, хешовані класи геть, обрізання довгих', () => {
  assert.equal(buildCssPath([{ tag: 'body' }, { tag: 'div', id: ':r1:' }, { tag: 'span', classes: ['sc-abc', 'label'], nth: 3 }]),
    'body > div > span.label:nth-of-type(3)');
  assert.equal(buildCssPath([{ tag: 'div', id: 'root' }, { tag: 'main', id: 'content' }, { tag: 'p' }]), 'main#content > p');
  const deep = [{ tag: 'html' }, { tag: 'body' }, ...Array.from({ length: 8 }, (_, i) => ({ tag: 'div', nth: i + 1 })), { tag: 'button' }];
  const p = buildCssPath(deep);
  assert.equal(p.split(' > ').length, 5);
  assert.ok(p.endsWith('button'));
  assert.equal(buildCssPath([]), null);
  assert.equal(buildCssPath([{ tag: 'div', id: '1x' }]), 'div'); // невалідний id без якоря
});

test('rankWithCounts: унікальні першими, 0 відкинуто, невідомі між, CSS завжди лишається', () => {
  const cands = [
    { by: 'testid', value: 'a' }, { by: 'role', role: 'button', name: 'Go' }, { by: 'label', value: 'L' },
    { by: 'placeholder', value: 'P' }, { by: 'name', value: 'n' }, { by: 'text', value: 'Go' }, { by: 'css', value: 'form button', nth: null },
  ];
  const r = rankWithCounts(cands, [0, 3, 1, null, 1, 2, 5]);
  assert.equal(r.length, MAX_LOCS);
  assert.deepEqual(r.map(l => l.by), ['label', 'name', 'placeholder', 'role', 'css']);
  assert.deepEqual(r.map(l => l.n), [1, 1, null, 3, 5]);
  // без counts — просто обрізання з n:null
  const r2 = rankWithCounts(cands, null);
  assert.equal(r2.length, 5);
  assert.equal(r2[4].by, 'css');
  // усі 0 → лишаємо як є (краще, ніж нічого)
  assert.equal(rankWithCounts([{ by: 'css', value: 'a' }], [0]).length, 1);
  assert.deepEqual(rankWithCounts([], []), []);
});

test('targetFromDesc: rel із точки, pick, kind/desc, рамки', () => {
  const t = targetFromDesc(
    { tag: 'BUTTON', name: 'Submit', text: 'Submit', cssPath: 'form button', box: { x: 100, y: 200, w: 200, h: 40.4 } },
    { point: { x: 150, y: 230 }, counts: [1, 1, 2] });
  assert.equal(t.pick, 0);
  assert.equal(t.kind, 'button');
  assert.equal(t.tag, 'BUTTON');
  assert.equal(t.desc, 'кнопка «Submit»');
  assert.deepEqual(t.rel, { rx: 0.25, ry: 0.75 });
  assert.deepEqual(t.box, { x: 100, y: 200, w: 200, h: 40 });
  assert.equal(t.frame, null);
  const none = targetFromDesc({ tag: 'DIV' });
  assert.equal(none.pick, -1);
  assert.deepEqual(none.rel, { rx: 0.5, ry: 0.5 });
});

test('cssEscapeAttr / cssEscapeIdent', () => {
  assert.equal(cssEscapeAttr('a"b\\c\nd'), 'a\\"b\\\\c\\a d');
  assert.equal(cssEscapeAttr(null), '');
  assert.equal(cssEscapeIdent('a.b:c'), 'a\\.b\\:c');
  assert.equal(cssEscapeIdent('1abc'), '\\31 abc');
  assert.equal(cssEscapeIdent('-1a'), '-\\31 a');
  assert.equal(cssEscapeIdent('-'), '\\-');
  assert.equal(cssEscapeIdent('ім_я-1'), 'ім_я-1');
});

test('frameUrlPattern / originPath / matchGlob', () => {
  assert.equal(frameUrlPattern('https://jobs.ashbyhq.com/preply/978dbfa9-87b8-472d-81b3-b7d048da8b03/application?embed=js'),
    'https://jobs.ashbyhq.com/preply/*');
  assert.equal(frameUrlPattern('https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc'), 'https://www.google.com/recaptcha/api2/anchor*');
  assert.equal(frameUrlPattern('https://Example.com'), 'https://example.com/*');
  assert.equal(frameUrlPattern('https://x.test/jobs/75664-staff'), 'https://x.test/jobs/*');
  assert.equal(frameUrlPattern('about:blank'), null);
  assert.equal(frameUrlPattern('data:text/html,hi'), null);
  assert.equal(frameUrlPattern(''), null);
  assert.equal(originPath('https://a.test/p/q?x=1#h'), 'https://a.test/p/q');
  assert.equal(originPath('https://a.test'), 'https://a.test/');
  assert.equal(originPath('about:blank'), null);
  assert.ok(matchGlob('https://jobs.ashbyhq.com/preply/*', 'https://jobs.ashbyhq.com/preply/abc/application?x=1'));
  assert.ok(!matchGlob('https://jobs.ashbyhq.com/preply/*', 'https://jobs.ashbyhq.com/other/abc'));
  assert.ok(matchGlob('https://a.test/x?y=(1)*', 'https://a.test/x?y=(1)&z'));
  assert.ok(!matchGlob(null, 'x'));
});

test('frameSelector: id → name → title → src-префікс → cssPath → nth', () => {
  assert.equal(frameSelector({ id: 'ashby_embed_iframe' }), 'iframe#ashby_embed_iframe');
  assert.equal(frameSelector({ id: ':r0:', name: 'payment' }), 'iframe[name="payment"]');
  assert.equal(frameSelector({ title: 'reCAPTCHA' }), 'iframe[title="reCAPTCHA"]');
  assert.equal(frameSelector({ src: 'https://jobs.ashbyhq.com/preply/978dbfa9-87b8-472d-81b3-b7d048da8b03' }),
    'iframe[src^="https://jobs.ashbyhq.com/preply"]');
  assert.equal(frameSelector({ src: 'about:blank', cssPath: 'div > iframe' }), 'div > iframe');
  assert.equal(frameSelector({ index: 2 }), 'iframe >> nth=2');
  assert.equal(frameSelector(null), 'iframe');
});

test('frameSpecFrom: ланцюг від зовнішнього до внутрішнього, null для головного фрейму', () => {
  assert.equal(frameSpecFrom([], { url: 'https://a.test/' }), null);
  const s = frameSpecFrom([{ id: 'outer' }, { name: 'inner' }], { url: 'https://jobs.test/acme/12345/form?a=1', name: 'inner', index: 1 });
  assert.deepEqual(s, { chain: ['iframe#outer', 'iframe[name="inner"]'], url: 'https://jobs.test/acme/*', path: 'https://jobs.test/acme/12345/form', name: 'inner', index: 1 });
});

test('matchFrame: path → url-глоб → name → index (index лише без URL або loose)', () => {
  const frames = [
    { url: 'https://ads.test/x', name: '' },
    { url: 'https://jobs.test/acme/999/form?b=2', name: '' },
    { url: 'about:blank', name: 'cap' },
  ];
  const spec = { url: 'https://jobs.test/acme/*', path: 'https://jobs.test/acme/12345/form', name: '', index: 0 };
  assert.deepEqual(matchFrame(frames, spec), { frame: frames[1], i: 1, by: 'url' });
  assert.equal(matchFrame(frames, { ...spec, path: 'https://jobs.test/acme/999/form' }).by, 'path');
  assert.equal(matchFrame(frames, { name: 'cap' }).i, 2);
  assert.equal(matchFrame(frames, { url: 'https://nope.test/*', index: 0 }), null); // ще не завантажився
  assert.equal(matchFrame(frames, { url: 'https://nope.test/*', index: 0 }, { loose: true }).by, 'index');
  assert.equal(matchFrame(frames, { index: 2 }).by, 'index');
  // кілька збігів → name, далі найближчий index
  const dup = [{ url: 'https://w.test/a', name: 'x', index: 0 }, { url: 'https://w.test/a', name: 'y', index: 3 }, { url: 'https://w.test/a', name: 'y', index: 5 }];
  assert.equal(matchFrame(dup, { path: 'https://w.test/a', name: 'y', index: 6 }).i, 2);
  assert.equal(matchFrame(dup, { path: 'https://w.test/a', index: 0 }).i, 0);
  assert.equal(matchFrame([], spec), null);
  assert.equal(matchFrame(frames, null), null);
});

test('pickNearest: найближчий центр, null-бокси пропущено', () => {
  const rec = { x: 100, y: 1000, w: 100, h: 40 };
  const r = pickNearest([{ x: 100, y: 200, w: 100, h: 40 }, null, { x: 110, y: 990, w: 100, h: 40 }], rec);
  assert.deepEqual(r, { index: 2, dist: 14 });
  assert.deepEqual(pickNearest([], rec), { index: -1, dist: Infinity });
  assert.deepEqual(pickNearest([rec], null), { index: -1, dist: Infinity });
});

test('pointInBox: rel + джитер, затиснуто 10–90%', () => {
  const b = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(pointInBox(b, null), { x: 50, y: 25 });
  assert.deepEqual(pointInBox(b, { rx: 0, ry: 1 }), { x: 10, y: 45 });
  assert.deepEqual(pointInBox(b, { rx: 0.5, ry: 0.5 }, 0.15, seq(1 - 1e-9, 0)), { x: 65, y: 17.5 });
  for (let i = 0; i < 200; i++) {
    const p = pointInBox(b, { rx: 0.95, ry: 0.05 }, 0.5, Math.random);
    assert.ok(p.x >= 10 && p.x <= 90 && p.y >= 5 && p.y <= 45, JSON.stringify(p));
  }
  assert.equal(pointInBox(null, null), null);
});

test('specToString для UI', () => {
  assert.equal(specToString({ by: 'testid', attr: 'data-testid', value: 'go' }), '[data-testid="go"]');
  assert.equal(specToString({ by: 'role', role: 'button', name: 'Submit' }), 'role=button[name="Submit"]');
  assert.equal(specToString({ by: 'label', value: 'Email' }), 'label="Email"');
  assert.equal(specToString({ by: 'placeholder', value: 'you@ex.com' }), 'placeholder="you@ex.com"');
  assert.equal(specToString({ by: 'name', tag: 'input', value: 'email' }), 'input[name="email"]');
  assert.equal(specToString({ by: 'id', value: 'a.b' }), '#a\\.b');
  assert.equal(specToString({ by: 'text', value: 'Go' }), 'text="Go"');
  assert.equal(specToString({ by: 'css', value: 'form button', nth: 1 }), 'form button >> nth=1');
  assert.equal(specToString(null), '📍 координати');
});

test('toPlaywright: дескриптори викликів', () => {
  assert.deepEqual(toPlaywright({ by: 'testid', attr: 'data-testid', value: 'go' }), { method: 'getByTestId', args: ['go'] });
  assert.deepEqual(toPlaywright({ by: 'testid', attr: 'data-qa', value: 'go"x' }), { method: 'locator', args: ['[data-qa="go\\"x"]'] });
  assert.deepEqual(toPlaywright({ by: 'role', role: 'button', name: 'Submit', exact: true }), { method: 'getByRole', args: ['button', { name: 'Submit', exact: true }] });
  assert.deepEqual(toPlaywright({ by: 'role', role: 'checkbox' }), { method: 'getByRole', args: ['checkbox'] });
  assert.deepEqual(toPlaywright({ by: 'label', value: 'Email' }), { method: 'getByLabel', args: ['Email', { exact: true }] });
  assert.deepEqual(toPlaywright({ by: 'placeholder', value: 'P', exact: false }), { method: 'getByPlaceholder', args: ['P', { exact: false }] });
  assert.deepEqual(toPlaywright({ by: 'text', value: 'Go' }), { method: 'getByText', args: ['Go', { exact: true }] });
  assert.deepEqual(toPlaywright({ by: 'name', tag: 'select', value: 'country' }), { method: 'locator', args: ['select[name="country"]'] });
  assert.deepEqual(toPlaywright({ by: 'id', value: 'email' }), { method: 'locator', args: ['#email'] });
  assert.deepEqual(toPlaywright({ by: 'css', value: 'ul > li', nth: 2 }), { method: 'locator', args: ['ul > li'], nth: 2 });
  assert.deepEqual(toPlaywright({ by: 'css', value: 'ul > li', nth: null }), { method: 'locator', args: ['ul > li'] });
  assert.equal(toPlaywright({ by: 'weird' }), null);
  assert.equal(toPlaywright(null), null);
});

// ---------- CSS-модулі та поле файлу (крок «Файл … у поле файлу» був ⚠) ----------
test('isStableToken: хеш-класи CSS-модулів (Vite/webpack/Next) відкидаються', () => {
  for (const t of ['_container_f7cvd_28', '_root_abcde_3', '_btn_Ab-9z_120', 'styles__btn___3xYz9', 'Button_root__xKqzT', 'Home_main__a1B2c']) {
    assert.equal(isStableToken(t), false, t);
  }
});

test('isStableToken: звичайні класи (BEM, kebab, snake, Ashby) — стабільні', () => {
  for (const t of ['ashby-application-form-autofill-uploader', 'ashby-application-form-autofill-input-root', 'card__title', 'block__elem--mod', 'btn_primary', 'nav-item_active', 'Header_wrapper', 'form', '_private', 'col_12']) {
    assert.equal(isStableToken(t), true, t);
  }
});

test('buildCssPath: хеш-клас CSS-модуля не потрапляє в шлях (реальний випадок Ashby)', () => {
  const css = buildCssPath([
    { tag: 'DIV', id: 'form' },
    { tag: 'DIV', classes: ['ashby-application-form-autofill-uploader', '_container_f7cvd_28'] },
    { tag: 'DIV', classes: ['ashby-application-form-autofill-input-root'] },
    { tag: 'INPUT' },
  ]);
  assert.equal(css, 'div#form > div.ashby-application-form-autofill-uploader > div.ashby-application-form-autofill-input-root > input');
  assert.ok(!/f7cvd/.test(css));
});

test('buildCandidates: приховане поле файлу без семантики → input[type=file] перед CSS-шляхом', () => {
  const c = buildCandidates({ tag: 'INPUT', type: 'file', box: { x: 0, y: 0, w: 1, h: 1 }, path: [{ tag: 'DIV', id: 'form' }, { tag: 'INPUT' }] });
  assert.deepEqual(c[0], { by: 'type', tag: 'input', value: 'file' });
  assert.equal(c[c.length - 1].by, 'css');
  // семантичні ознаки, якщо є, — вище за тип
  const labelled = buildCandidates({ tag: 'INPUT', type: 'file', label: 'Резюме', nameAttr: 'cv' });
  assert.deepEqual(labelled.map((l) => l.by), ['label', 'name', 'type']);
  // для інших полів тип не додається
  assert.ok(!buildCandidates({ tag: 'INPUT', type: 'text', path: [{ tag: 'INPUT' }] }).some((l) => l.by === 'type'));
});

test('локатор type: CSS, рядок для UI, Playwright, ранжування з лічильниками', () => {
  const l = { by: 'type', tag: 'input', value: 'file' };
  assert.equal(specToString(l), 'input[type="file"]');
  assert.deepEqual(toPlaywright(l), { method: 'locator', args: ['input[type="file"]'] });
  const cands = [l, { by: 'css', value: 'div > input', nth: null }];
  assert.deepEqual(rankWithCounts(cands, [1, 1]).map((x) => [x.by, x.n]), [['type', 1], ['css', 1]]);
  assert.deepEqual(rankWithCounts(cands, [2, 1]).map((x) => x.by), ['css', 'type'], 'кілька полів файлу → унікальний CSS вище');
});

test('isStableToken: Next.js/CRA з малої (page_main__…) і Turbopack (…-module__хеш__local) відкидаються', () => {
  for (const t of ['page_main__GLmXu', 'layout_header__xYzQw', 'styles_card__aBcDe', 'nav-bar_root__AbCdE',
    'page-module__E0vvGG__main', 'layout-module__PJhD8a__container', 'Details-module-scss-module__MGoXJG__label', 'page-module__a_b-C__x']) {
    assert.equal(isStableToken(t), false, t);
  }
  // BEM-подібні з хвостом-словом і блоки з «-module» — стабільні
  for (const t of ['search_form__input', 'card_title__label', 'my-module__title', 'header__nav-item', 'my-module__title__elem']) {
    assert.equal(isStableToken(t), true, t);
  }
});

test('isStableToken: astro-* (scope-класи Astro) відкидаються', () => {
  assert.equal(isStableToken('astro-J7PVZSFK'), false);
});

test('buildCssPath: хеш styled-components поруч із sc-… не потрапляє в шлях; без sc- класи лишаються', () => {
  assert.equal(buildCssPath([{ tag: 'body' }, { tag: 'div', classes: ['sc-bdVaJa', 'kQfLtv', 'card'] }, { tag: 'input' }]), 'body > div.card > input');
  assert.equal(buildCssPath([{ tag: 'body' }, { tag: 'div', classes: ['sc-bdVaJa', 'kQfLtv'] }, { tag: 'input' }]), 'body > div > input');
  assert.equal(buildCssPath([{ tag: 'body' }, { tag: 'div', classes: ['sc-bdVaJa', 'button'] }, { tag: 'input' }]), 'body > div.button > input', 'звичайний клас на styled-компоненті лишається');
  assert.equal(buildCssPath([{ tag: 'body' }, { tag: 'div', classes: ['navItem', 'myBtnOk'] }, { tag: 'input' }]), 'body > div.navItem.myBtnOk > input');
});

// ---------- Очищення збереженого CSS-шляху від хеш-класів ----------
const ASHBY_CSS = 'div#form > div.ashby-application-form-autofill-uploader._container_f7cvd_28 > div.ashby-application-form-autofill-input-root > input';
test('stripUnstableClasses: прибирає лише згенеровані класи (реальний шлях Ashby)', () => {
  assert.equal(stripUnstableClasses(ASHBY_CSS), 'div#form > div.ashby-application-form-autofill-uploader > div.ashby-application-form-autofill-input-root > input');
  assert.equal(stripUnstableClasses('a.btn.css-1x2y3z > span'), 'a.btn > span');
  assert.equal(stripUnstableClasses('div.card > p.title'), 'div.card > p.title', 'стабільне — без змін');
  assert.equal(stripUnstableClasses('#root > div.Button_root__xKqzT'), '#root > div', 'id лишається, хеш-клас іде');
});

test('isStableCss: стабільні класи/id без nth і з якорем', () => {
  assert.equal(isStableCss(stripUnstableClasses(ASHBY_CSS)), true);
  assert.equal(isStableCss(ASHBY_CSS), false, 'містить хеш');
  assert.equal(isStableCss('div > input'), false, 'без жодного класу/id — лише структура');
  assert.equal(isStableCss('div.a:nth-of-type(2) > input'), false);
  assert.equal(isStableCss('#cv'), true);
  // якір лише на далекому предку + голі теги — це структура DOM, не ознака елемента
  assert.equal(isStableCss('div#app > div > div > input'), false);
  assert.equal(isStableCss('div#root > div > div > button'), false);
  assert.equal(isStableCss('body > div.container > div > input'), false);
  assert.equal(isStableCss('div#form > div > button'), false);
  assert.equal(isStableCss(stripUnstableClasses('div#root > div._a_x7f3k_1 > div._b_q9z2m_4 > input')), false);
  assert.equal(isStableCss('div#root div > div > div > div > input'), false, 'обрізаний довгий шлях');
  // якір на самому елементі або його батькові
  assert.equal(isStableCss('form#login > input'), true);
  assert.equal(isStableCss('div.foo > input'), true);
  assert.equal(isStableCss('div.x input[name="a b"]'), true, 'пробіл в атрибуті не ріже сегмент');
  assert.equal(isStableCss(''), false);
});
