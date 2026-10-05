// Юніт-тести lib/steps.js — модель кроків, сплющення сценарію (на реальних
// legacy-даних користувача), підписи, клавіатура, буфер тексту, оптимізація.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeStep, newStepId, stripTransient, pagePayload, flattenScenario, escapeTemplate, templatePreview,
  needsFocusClick, sameTarget, inheritTextTarget, healthOf, stepLabel, stepIcon, isSideEffectStep,
  keyToStep, textBufferReduce, flushTextBuffer, countMoves, compactMoves, isLegacyStep, isBareModifier,
  isFocusNeutralKey, TRANSIENT_FIELDS, delayAfterMs, formatDelay, MAX_DELAY_AFTER,
  textTemplateOf, nextVisibleIndex, canMergeText, mergeTextSteps,
} from '../lib/steps.js';
import { detectDeviceGids } from '../lib/coords.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-pages.json', import.meta.url), 'utf8'));
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
// expandTemplate належить lib/textTemplate.js (інший модуль) — перехресна перевірка, якщо він є.
const tpl = await import('../lib/textTemplate.js').catch(() => null);

const tgt = (over = {}) => ({
  frame: null, pick: 0, kind: 'input', desc: 'поле «Email»',
  locs: [{ by: 'label', value: 'Email', n: 1 }, { by: 'css', value: 'form input', nth: 0, n: 3 }],
  box: { x: 10, y: 10, w: 200, h: 30 }, ...over,
});

test('модуль ізоморфний: імпортує лише ./locators.js (теж ізоморфний, у whitelist /lib)', () => {
  const src = fs.readFileSync(new URL('../lib/steps.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./locators.js']);
  assert.doesNotMatch(src, /\brequire\(|\bprocess\.|\bBuffer\b/);
});

test('newStepId: формат і детермінізм з rnd', () => {
  assert.match(newStepId(), /^s_[0-9a-z]{8}$/);
  assert.equal(newStepId(seq(0)), 's_00000000');
  assert.equal(newStepId(seq(0.999999)), 's_zzzzzzzz');
  const ids = new Set(Array.from({ length: 500 }, () => newStepId()));
  assert.equal(ids.size, 500);
});

test('normalizeStep: додає id, не мутує, не чіпає координати, legacy-поля лишаються', () => {
  const legacy = { type: 'click', x: '1117', y: 827, sw: 2530, sh: 7290, gid: 32, random: 'digit', waitResponse: true, text: 'a', key: 'Enter', fileId: 'f', filename: 'cv.pdf' };
  const n = normalizeStep(legacy, { rnd: seq(0) });
  assert.equal(n.id, 's_00000000');
  assert.equal(legacy.id, undefined); // вхід не змінено
  for (const k of Object.keys(legacy)) assert.deepEqual(n[k], legacy[k], k);
  assert.equal(normalizeStep({ id: 'keep', type: 'text' }).id, 'keep');
  assert.equal(normalizeStep({ type: 'text' }, { id: 'L1_0' }).id, 'L1_0');
  assert.equal(normalizeStep(null), null);
  assert.equal(normalizeStep([1]), null);
  assert.equal(normalizeStep('x'), null);
  assert.equal(normalizeStep({ type: 'teleport' }).type, 'teleport'); // невідомий — як є
  assert.ok(isLegacyStep(legacy));
  assert.ok(!isLegacyStep({ type: 'click', v: 2 }));
});

test('normalizeStep: dblclick → click×2; target приводиться до форми', () => {
  const d = normalizeStep({ type: 'dblclick', x: 1, y: 2 });
  assert.equal(d.type, 'click'); assert.equal(d.clicks, 2);
  const t = normalizeStep({ type: 'click', target: { locs: [{ by: 'css', value: 'a' }, null, { nope: 1 }], pick: 7 } });
  assert.equal(t.target.locs.length, 1);
  assert.equal(t.target.pick, 0);
  assert.equal(t.target.frame, null);
  assert.equal(normalizeStep({ type: 'click', target: { locs: [] } }).target.pick, -1);
  assert.equal(normalizeStep({ type: 'click', target: { locs: [{ by: 'css', value: 'a' }], pick: -1 } }).target.pick, -1);
  assert.equal(normalizeStep({ type: 'click', target: 'junk' }).target, undefined);
});

test('stripTransient / pagePayload', () => {
  const s = { id: 'a', type: 'click', x: 1, status: 'done', strategy: 'loc', ms: 5, error: 'e', failShot: 'data:', pending: {}, healed: true };
  const out = stripTransient(s);
  assert.deepEqual(out, { id: 'a', type: 'click', x: 1 });
  assert.equal(s.status, 'done');
  for (const k of ['status', 'strategy', 'ms', 'error', 'failShot', 'pending']) assert.ok(TRANSIENT_FIELDS.includes(k));
  const p = pagePayload({ id: 1, name: 'N', url: 'u', expanded: true, running: true, recs: [{ id: 2, name: 'R', expanded: true, runCur: 1, subs: [s] }] });
  assert.deepEqual(p, { name: 'N', url: 'u', recs: [{ id: 2, name: 'R', subs: [{ id: 'a', type: 'click', x: 1 }] }] });
  // Плейсхолдер живого запису (pending:true, ще не підтверджений сервером) не зберігається.
  const ph = { type: 'click', v: 2, x: 5, y: 6, pending: true, status: 'running', target: { desc: '…⏳', locs: [], pick: -1 } };
  const p2 = pagePayload({ name: 'N', url: 'u', recs: [{ id: 3, name: 'R', subs: [{ type: 'key', key: 'Enter' }, ph] }] });
  assert.deepEqual(p2.recs[0].subs, [{ type: 'key', key: 'Enter' }]);
});

test('escapeTemplate / templatePreview (+ round-trip з expandTemplate)', () => {
  assert.equal(escapeTemplate('a{b}{d}'), 'a{{b}{{d}');
  assert.equal(escapeTemplate(null), '');
  assert.equal(templatePreview('x{d}{l}{{d}'), 'x🎲ц🎲л{d}');
  if (tpl) {
    for (const s of ['plain', '{', '{{', '{d}', '{l}', 'a{b}c{{d}}', '}{']) assert.equal(tpl.expandTemplate(escapeTemplate(s), seq(0.5)), s, s);
  }
});

test('flattenScenario: синтетика — злиття тексту з random і «{», модифікатори, межі key/click', () => {
  const page = { id: 1, url: 'u', recs: [{ id: 7, name: 'Д', subs: [
    { type: 'move', x: 1, y: 1 },                        // 0 skip
    { type: 'click', x: 10, y: 20 },                     // 1
    { type: 'key', key: 'Shift' },                       // 2 ┐
    { type: 'text', text: 'J' },                         // 3 │
    { type: 'text', text: 'o', random: 'letter' },       // 4 │ один text
    { type: 'move', x: 2, y: 2 },                        // 5 │ (skip, не рве групу)
    { type: 'text', text: '{' },                         // 6 │
    { type: 'text', text: '7', random: 'digit' },        // 7 ┘
    { type: 'key', key: 'Tab' },                         // 8
    { type: 'text', text: 'x' },                         // 9 ┐ окремий text після Tab
    { type: 'key', key: 'Shift' },                       // 10 ┘ хвостовий Shift поглинається
    { type: 'click', x: 5, y: 6 },                       // 11
    { type: 'teleport' },                                // 12 unknown
    null,                                                // 13 invalid
  ] }] };
  const before = JSON.stringify(page);
  const { flat, map, skipped, recs } = flattenScenario(page);
  assert.equal(JSON.stringify(page), before, 'вхід не мутується');
  assert.deepEqual(flat.map(s => s.type), ['click', 'text', 'key', 'text', 'click']);
  assert.equal(flat[1].text, 'J{l}{{{d}');
  assert.equal(flat[1].v, 2);
  assert.equal(flat[1].random, undefined);
  assert.equal(flat[3].text, 'x');
  assert.equal(flat[3].v, 2);
  assert.deepEqual(map.map(m => m.subIdxs), [[1], [2, 3, 4, 6, 7], [8], [9, 10], [11]]);
  assert.deepEqual(map.map(m => m.recPos), [1, 2, 3, 4, 5]);
  assert.ok(flat.every(s => s.gid === 7));
  assert.deepEqual(flat.map(s => s.id), ['L7_1', 'L7_2', 'L7_8', 'L7_9', 'L7_11']);
  assert.deepEqual(skipped, [{ recId: 7, si: 0, reason: 'move' }, { recId: 7, si: 5, reason: 'move' }, { recId: 7, si: 12, reason: 'unknown' }, { recId: 7, si: 13, reason: 'invalid' }]);
  assert.deepEqual(recs, [{ recId: 7, total: 5 }]);
  // самотній модифікатор (без тексту поруч) лишається key-кроком
  const lone = flattenScenario({ recs: [{ id: 1, subs: [{ type: 'click', x: 1, y: 1 }, { type: 'key', key: 'Shift' }, { type: 'click', x: 2, y: 2 }] }] });
  assert.deepEqual(lone.flat.map(s => s.type + (s.key ? ':' + s.key : '')), ['click', 'key:Shift', 'click']);
  assert.deepEqual({ x: flat[0].x, y: flat[0].y }, { x: 10, y: 20 });
  if (tpl) {
    const out = tpl.expandTemplate(flat[1].text, seq(0.5));
    assert.match(out, /^J[a-z]\{\d$/);
  }
});

test('flattenScenario: skipMoves=false — рухи лишаються і рвуть текстову групу', () => {
  const page = { recs: [{ id: 1, subs: [{ type: 'text', text: 'a' }, { type: 'move', x: 1, y: 1 }, { type: 'text', text: 'b' }] }] };
  const r = flattenScenario(page, null, { skipMoves: false });
  assert.deepEqual(r.flat.map(s => s.type + ':' + (s.text || '')), ['text:a', 'move:', 'text:b']);
  assert.deepEqual(r.skipped, []);
});

test('flattenScenario: v2/цільові/вимкнені тексти НЕ зливаються; id зберігається', () => {
  const page = { recs: [{ id: 3, subs: [
    { id: 'k1', type: 'text', v: 2, text: 'john{d}' },
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b', disabled: true },
    { type: 'text', text: 'c', target: tgt() },
  ] }] };
  const r = flattenScenario(page);
  assert.deepEqual(r.flat.map(s => s.text), ['john{d}', 'a', 'b', 'c']);
  assert.equal(r.flat[0].id, 'k1');
  assert.equal(r.flat[2].disabled, true);
});

test('flattenScenario: uptoRecId (рядок/число), невідомий id → помилка, порожній сценарій', () => {
  const page = { recs: [{ id: 1, subs: [{ type: 'click', x: 1, y: 1 }] }, { id: 2, subs: [{ type: 'click', x: 2, y: 2 }] }, { id: 3, subs: [] }] };
  assert.equal(flattenScenario(page, 1).flat.length, 1);
  assert.equal(flattenScenario(page, '2').flat.length, 2);
  assert.deepEqual(flattenScenario(page, 3).recs, [{ recId: 1, total: 1 }, { recId: 2, total: 1 }, { recId: 3, total: 0 }]);
  assert.throws(() => flattenScenario(page, 99), /не знайдено/);
  assert.deepEqual(flattenScenario({}).flat, []);
  assert.deepEqual(flattenScenario(null).flat, []);
});

// ---------- Реальні legacy-дані користувача (анонімізована повна копія) ----------
test('legacy-pages: flatten/normalize/label на КОЖНІЙ під-дії без винятків; map покриває все рівно раз', () => {
  let subsTotal = 0;
  for (const page of fixture.pages) {
    for (const rec of page.recs) for (const sub of rec.subs) {
      subsTotal++;
      const n = normalizeStep(sub);
      assert.ok(n && n.id);
      assert.equal(n.x, sub.x); assert.equal(n.y, sub.y); assert.equal(n.sw, sub.sw);
      const label = stepLabel(n);
      assert.ok(typeof label === 'string' && label.length > 0);
      assert.ok(stepIcon(n));
      healthOf(n); isSideEffectStep(n);
    }
    for (const skipMoves of [true, false]) {
      const { flat, map, skipped, recs } = flattenScenario(page, null, { skipMoves });
      assert.equal(flat.length, map.length);
      for (const s of flat) assert.ok(stepLabel(s).length > 0);
      // кожна під-дія або в map рівно раз, або в skipped рівно раз
      const seen = new Map();
      for (const m of map) for (const si of m.subIdxs) { const k = m.recId + ':' + si; seen.set(k, (seen.get(k) || 0) + 1); }
      for (const s of skipped) { const k = s.recId + ':' + s.si; seen.set(k, (seen.get(k) || 0) + 1); }
      for (const rec of page.recs) rec.subs.forEach((sub, si) => {
        assert.equal(seen.get(rec.id + ':' + si), 1, 'rec ' + rec.id + ' si ' + si);
        const inSkipped = skipped.some(s => s.recId === rec.id && s.si === si);
        assert.equal(inSkipped, skipMoves && sub.type === 'move');
      });
      // subIdxs у межах Дії зростають (порядок збережено)
      const byRec = {};
      for (const m of map) { (byRec[m.recId] ||= []).push(...m.subIdxs); }
      for (const ids of Object.values(byRec)) assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      assert.equal(recs.reduce((a, r) => a + r.total, 0), flat.length);
      // координати не переписані, gid = id Дії
      for (let i = 0; i < flat.length; i++) {
        const m = map[i];
        const rec = page.recs.find(r => r.id === m.recId);
        const orig = rec.subs[m.subIdxs[0]];
        assert.equal(flat[i].gid, rec.id);
        if (orig.type === 'click' || orig.type === 'move') { assert.equal(flat[i].x, orig.x); assert.equal(flat[i].y, orig.y); assert.equal(flat[i].sw, orig.sw); }
      }
    }
  }
  assert.ok(subsTotal >= 400, 'фікстура має бути повною (' + subsTotal + ')');
});

test('legacy-pages: злиття тексту відтворює рівно ту саму послідовність символів', () => {
  const page = fixture.pages.find(p => p.recs.some(r => r.id === 32));
  const rec = page.recs.find(r => r.id === 32);
  const { flat, map } = flattenScenario(page, 32);
  const mine = flat.map((s, i) => ({ s, m: map[i] })).filter(e => e.m.recId === 32);
  const texts = mine.filter(e => e.s.type === 'text');
  // У Дії 32 — 5 полів тексту (імʼя, email, телефон, ще 2): 74 text + 3 Shift = 77 під-дій → 5 кроків
  assert.equal(texts.length, 5);
  assert.equal(texts.reduce((a, e) => a + e.m.subIdxs.length, 0), 77);
  assert.equal(mine.filter(e => e.s.type === 'key').length, 0, 'Shift-и поглинуті');
  for (const { s, m } of texts) {
    const expected = m.subIdxs.map(si => rec.subs[si]).filter(x => x.type === 'text')
      .map(x => (x.random === 'digit' ? '{d}' : x.random === 'letter' ? '{l}' : escapeTemplate(x.text))).join('');
    assert.equal(s.text, expected);
    assert.ok(m.subIdxs.every(si => ['text', 'key'].includes(rec.subs[si].type)));
    if (tpl) {
      // розгортання: довжина = кількості текстових під-дій; фіксовані символи на місці
      const subs = m.subIdxs.map(si => rec.subs[si]).filter(x => x.type === 'text');
      const out = [...tpl.expandTemplate(s.text, seq(0.42))];
      assert.equal(out.length, subs.reduce((a, x) => a + [...String(x.text)].length, 0));
      subs.forEach((x, k) => {
        if (x.random === 'digit') assert.match(out[k], /\d/);
        else if (x.random === 'letter') assert.match(out[k], /[a-z]/);
        else assert.equal(out[k], x.text);
      });
    }
  }
  // кількість кліків і файл — без змін
  assert.equal(mine.filter(e => e.s.type === 'click').length, rec.subs.filter(s => s.type === 'click').length);
  assert.equal(mine.filter(e => e.s.type === 'file').length, 1);
});

test('legacy-pages: gid лишає detectDeviceGids робочим (Дія 9 без sw — CSS-простір)', () => {
  const all = fixture.pages.flatMap(p => flattenScenario(p).flat);
  const set = detectDeviceGids(all, 1280);
  assert.ok(!set.has(9)); // x=991 < 1280×1.3 → CSS
  // Дії з sw мають x до ~2500 (px скриншота DPR2) → device-простір за евристикою,
  // але toDocCoords для них бере точний масштаб через sw — gid не заважає.
  assert.ok(set.has(39)); // клік x=2193
});

test('compactMoves / countMoves на реальних даних: рухи геть, текст злитий, ідемпотентно', () => {
  const rec = fixture.pages.flatMap(p => p.recs).find(r => r.id === 32);
  assert.equal(countMoves(rec.subs), rec.subs.filter(s => s.type === 'move').length);
  assert.ok(countMoves(rec.subs) > 50);
  const { subs, movesRemoved, textMerged } = compactMoves(rec.subs);
  assert.equal(movesRemoved, countMoves(rec.subs));
  assert.equal(countMoves(subs), 0);
  assert.ok(textMerged > 50);
  assert.equal(subs.filter(s => s.type === 'text').length, 5);
  assert.ok(subs.every(s => s.merged === undefined));
  // повторна оптимізація нічого не змінює (v:2 тексти не зливаються й не екрануються вдруге)
  const again = compactMoves(subs);
  assert.deepEqual(again.subs, subs);
  assert.equal(again.textMerged, 0);
  // flatten оптимізованого дає той самий текст, що й flatten оригіналу
  const a = flattenScenario({ recs: [{ id: 32, subs: rec.subs }] }).flat.filter(s => s.type === 'text').map(s => s.text);
  const b = flattenScenario({ recs: [{ id: 32, subs }] }).flat.filter(s => s.type === 'text').map(s => s.text);
  assert.deepEqual(b, a);
  // без злиття тексту
  const noMerge = compactMoves(rec.subs, { mergeText: false });
  assert.equal(noMerge.subs.length, rec.subs.length - movesRemoved);
  assert.equal(countMoves(null), 0);
});

test('sameTarget', () => {
  assert.ok(sameTarget(tgt(), tgt()));
  assert.ok(!sameTarget(tgt(), null));
  assert.ok(!sameTarget(tgt(), tgt({ frame: { chain: ['iframe#x'], url: 'https://a/*' } })));
  // обрані різні, але є спільний унікальний
  assert.ok(sameTarget(tgt(), tgt({ pick: 1 })));
  // спільний лише неунікальний css → не та сама
  assert.ok(!sameTarget(
    tgt({ locs: [{ by: 'label', value: 'A', n: 1 }, { by: 'css', value: 'input', n: 3 }] }),
    tgt({ locs: [{ by: 'label', value: 'B', n: 1 }, { by: 'css', value: 'input', n: 3 }] })));
  // без локаторів — по боксу (±2px)
  const nb = (x) => ({ locs: [], pick: -1, box: { x, y: 0, w: 10, h: 10 } });
  assert.ok(sameTarget(nb(0), nb(2)));
  assert.ok(!sameTarget(nb(0), nb(5)));
});

test('inheritTextTarget / needsFocusClick', () => {
  const click = { type: 'click', target: tgt() };
  assert.equal(inheritTextTarget(click), click.target);
  assert.equal(inheritTextTarget({ type: 'click', target: tgt({ kind: 'button' }) }), null);
  assert.equal(inheritTextTarget({ type: 'key', key: 'Tab', target: tgt() }), null);
  assert.equal(inheritTextTarget({ type: 'key', key: 'Backspace', target: click.target }), click.target);
  assert.equal(inheritTextTarget({ ...click, disabled: true }), null);
  assert.ok(inheritTextTarget({ type: 'text', target: tgt({ kind: 'editable' }) }));
  assert.equal(inheritTextTarget(null), null);
  assert.equal(inheritTextTarget({ type: 'click' }), null);

  const text = { type: 'text', text: 'a', target: tgt() };
  assert.equal(needsFocusClick(click, text), false);
  assert.equal(needsFocusClick({ type: 'text', target: tgt() }, text), false);
  assert.equal(needsFocusClick({ type: 'key', key: 'ControlOrMeta+a', target: tgt() }, text), false);
  assert.equal(needsFocusClick({ type: 'key', key: 'Tab', target: tgt() }, text), true);
  assert.equal(needsFocusClick(null, text), true);
  assert.equal(needsFocusClick({ ...click, disabled: true }, text), true);
  assert.equal(needsFocusClick({ type: 'click', target: tgt({ locs: [{ by: 'label', value: 'Name', n: 1 }] }) }, text), true);
  assert.equal(needsFocusClick(click, { type: 'text', text: 'a' }), false); // без цілі — нічого клікати
  assert.equal(needsFocusClick(click, { type: 'key', key: 'a', target: tgt() }), false);
  assert.ok(isFocusNeutralKey('Shift+ArrowLeft'));
  assert.ok(!isFocusNeutralKey('Enter'));
});

test('healthOf', () => {
  assert.equal(healthOf({ type: 'click', target: tgt() }), 'semantic');
  assert.equal(healthOf({ type: 'click', target: tgt({ pick: 1 }) }), 'weak');        // css
  assert.equal(healthOf({ type: 'click', target: tgt({ locs: [{ by: 'role', role: 'button', name: 'X', n: 2 }] }) }), 'weak');
  assert.equal(healthOf({ type: 'click', target: tgt({ locs: [{ by: 'role', role: 'button', name: 'X' }] }) }), 'semantic'); // не рахувався
  assert.equal(healthOf({ type: 'click', target: tgt({ pick: -1 }) }), 'coords');
  assert.equal(healthOf({ type: 'click', x: 1, y: 2 }), 'coords');
  assert.equal(healthOf({ type: 'move', x: 1, y: 2 }), 'coords');
  assert.equal(healthOf({ type: 'text', text: 'a' }), 'weak');
  assert.equal(healthOf({ type: 'file', fileId: 'f' }), 'weak');
  assert.equal(healthOf({ type: 'key', key: 'Enter' }), null);
  assert.equal(healthOf({ type: 'scroll', dy: 100 }), null);
  assert.equal(healthOf(null), null);
});

test('stepLabel: v2 з описом цілі і legacy', () => {
  const btn = { frame: null, locs: [{ by: 'role', role: 'button', name: 'Submit' }], pick: 0, kind: 'button', desc: 'кнопка «Submit»' };
  assert.equal(stepLabel({ type: 'click', v: 2, target: btn }), 'Клік: кнопка «Submit»');
  assert.equal(stepLabel({ type: 'click', v: 2, clicks: 2, target: btn }), 'Подвійний клік: кнопка «Submit»');
  assert.equal(stepLabel({ type: 'text', v: 2, text: 'john.doe.long@example.com', target: tgt() }), 'Ввести «john.doe.long@examp…» у поле «Email»');
  assert.equal(stepLabel({ type: 'text', v: 2, text: 'ab{d}', clear: true, target: tgt() }), 'Замінити на «ab🎲ц» у поле «Email»');
  assert.equal(stepLabel({ type: 'click', x: 991, y: 719 }), '👆 клік (991, 719)');
  assert.equal(stepLabel({ type: 'move', x: 1, y: 2 }), '🖱️ рух (1, 2)');
  assert.equal(stepLabel({ type: 'text', text: 'a', random: 'digit' }), '🎲 рандомна цифра (0–9)');
  assert.equal(stepLabel({ type: 'text', text: 'a', random: 'letter' }), '🎲 рандомна літера (a–z)');
  assert.equal(stepLabel({ type: 'text', text: '{' }), 'Ввести «{»');
  assert.equal(stepLabel({ type: 'text', v: 2, text: '{{' }), 'Ввести «{»');
  assert.equal(stepLabel({ type: 'key', key: 'Enter' }), 'Клавіша: Enter');
  assert.equal(stepLabel({ type: 'file', filename: 'cv.pdf' }), 'Файл «cv.pdf»');
  assert.equal(stepLabel({ type: 'file' }), 'Файл «—»');
  assert.equal(stepLabel({ type: 'select', value: 'UA', label: 'Ukraine', target: { desc: 'список «Country»' } }), 'Вибрати «Ukraine» у список «Country»');
  assert.equal(stepLabel({ type: 'scroll', dy: 400 }), 'Прокрутка ↓400');
  assert.equal(stepLabel({ type: 'scroll', dy: -50, dx: 20 }), 'Прокрутка ↑50 →20');
  assert.equal(stepLabel({ type: 'teleport' }), 'teleport');
  assert.equal(stepLabel(null), '');
});

test('isSideEffectStep', () => {
  assert.ok(isSideEffectStep({ type: 'click', waitResponse: true }));
  assert.ok(isSideEffectStep({ type: 'click', target: { desc: 'кнопка «Submit Application»', locs: [] } }));
  assert.ok(isSideEffectStep({ type: 'click', target: { desc: 'кнопка «Надіслати»', locs: [] } }));
  assert.ok(isSideEffectStep({ type: 'click', target: { desc: 'кнопка', locs: [{ by: 'role', role: 'button', name: 'Apply now' }] } }));
  assert.ok(isSideEffectStep({ type: 'click', target: { desc: 'кнопка', locs: [{ by: 'testid', value: 'send-btn' }] } }));
  assert.ok(!isSideEffectStep({ type: 'click', target: { desc: 'кнопка', locs: [{ by: 'css', value: 'form.apply button' }] } }));
  assert.ok(!isSideEffectStep({ type: 'click', target: { desc: 'поле «Email»', locs: [] } }));
  assert.ok(!isSideEffectStep({ type: 'click', x: 1, y: 2 }));
  assert.ok(!isSideEffectStep(null));
});

test('keyToStep', () => {
  assert.deepEqual(keyToStep({ key: 'a' }), { type: 'text', text: 'a' });
  assert.deepEqual(keyToStep({ key: 'A', shiftKey: true }), { type: 'text', text: 'A' });
  assert.deepEqual(keyToStep({ key: ' ' }), { type: 'text', text: ' ' });
  assert.deepEqual(keyToStep({ key: 'é', altKey: true }), { type: 'text', text: 'é' });        // macOS Option-символ
  assert.deepEqual(keyToStep({ key: '@', ctrlKey: true, altKey: true }), { type: 'text', text: '@' }); // AltGr
  assert.deepEqual(keyToStep({ key: '😀' }), { type: 'text', text: '😀' });
  for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process']) assert.equal(keyToStep({ key: k }), null, k);
  assert.equal(keyToStep({ key: 'a', repeat: true }), null);
  assert.equal(keyToStep({ key: 'MediaPlayPause' }), null);
  assert.equal(keyToStep(null), null);
  assert.equal(keyToStep({}), null);
  assert.deepEqual(keyToStep({ key: 'a', metaKey: true }), { type: 'key', key: 'ControlOrMeta+a' });
  assert.deepEqual(keyToStep({ key: 'A', ctrlKey: true, shiftKey: true }), { type: 'key', key: 'ControlOrMeta+Shift+a' });
  assert.deepEqual(keyToStep({ key: 'a', ctrlKey: true, metaKey: true }), { type: 'key', key: 'Control+Meta+a' });
  assert.deepEqual(keyToStep({ key: ' ', ctrlKey: true }), { type: 'key', key: 'ControlOrMeta+Space' });
  assert.deepEqual(keyToStep({ key: 'Enter', metaKey: true }), { type: 'key', key: 'ControlOrMeta+Enter' });
  assert.deepEqual(keyToStep({ key: 'v', metaKey: true }), { type: 'paste' });
  assert.deepEqual(keyToStep({ key: 'v', ctrlKey: true, shiftKey: true }), { type: 'key', key: 'ControlOrMeta+Shift+v' });
  assert.deepEqual(keyToStep({ key: 'Enter' }), { type: 'key', key: 'Enter' });
  assert.deepEqual(keyToStep({ key: 'Tab', shiftKey: true }), { type: 'key', key: 'Shift+Tab' });
  assert.deepEqual(keyToStep({ key: 'ArrowLeft', altKey: true }), { type: 'key', key: 'Alt+ArrowLeft' });
  assert.deepEqual(keyToStep({ key: 'F5' }), { type: 'key', key: 'F5' });
  assert.ok(isBareModifier('Shift') && !isBareModifier('a'));
});

test('textBufferReduce / flushTextBuffer: «hello» одним кроком, Backspace редагує буфер', () => {
  let st = { buf: '', emit: [] };
  const out = [];
  for (const k of ['h', 'e', 'l', 'l', 'x', 'Backspace', 'o', 'Shift', '{']) {
    st = textBufferReduce(st.buf, k); out.push(...st.emit);
  }
  assert.equal(st.buf, 'hello{');
  assert.deepEqual(out, []);
  st = textBufferReduce(st.buf, { key: 'Enter' }); // подія → keyToStep
  assert.deepEqual(st, { buf: '', emit: [{ type: 'text', v: 2, text: 'hello{{' }, { type: 'key', key: 'Enter' }] });
  // Backspace при порожньому буфері — це вже крок
  assert.deepEqual(textBufferReduce('', 'Backspace'), { buf: '', emit: [{ type: 'key', key: 'Backspace' }] });
  // Backspace видаляє цілу кодову точку (емодзі)
  assert.equal(textBufferReduce('a😀', 'Backspace').buf, 'a');
  // готовий крок і null
  assert.deepEqual(textBufferReduce('ab', { type: 'paste' }), { buf: '', emit: [{ type: 'text', v: 2, text: 'ab' }, { type: 'paste' }] });
  assert.deepEqual(textBufferReduce('ab', null), { buf: 'ab', emit: [] });
  assert.deepEqual(textBufferReduce(null, { type: 'text', text: 'z' }), { buf: 'z', emit: [] });
  assert.deepEqual(flushTextBuffer('a{d}'), { buf: '', emit: [{ type: 'text', v: 2, text: 'a{{d}' }] });
  assert.deepEqual(flushTextBuffer(''), { buf: '', emit: [] });
  if (tpl) assert.equal(tpl.expandTemplate(flushTextBuffer('a{d}').emit[0].text), 'a{d}');
});

test('needsLegacyPrep: лише legacy click/move (не v2 з target/x/y, не legacy text/key/file, не disabled)', async () => {
  const { needsLegacyPrep } = await import('../lib/steps.js');
  assert.equal(needsLegacyPrep([{ type: 'click', x: 1, y: 2 }]), true);
  assert.equal(needsLegacyPrep([{ type: 'move', x: 1, y: 2 }]), true);
  assert.equal(needsLegacyPrep([{ v: 2, type: 'click', x: 1, y: 2, target: { locs: [{ by: 'css', value: '#a' }], pick: 0 } }]), false);
  assert.equal(needsLegacyPrep([{ v: 2, type: 'click', x: 1, y: 2 }]), false);
  assert.equal(needsLegacyPrep([{ type: 'text', text: 'a' }, { type: 'key', key: 'Tab' }, { type: 'file', fileId: 'x' }]), false);
  assert.equal(needsLegacyPrep([{ type: 'click', x: 1, y: 2, disabled: true }]), false);
  assert.equal(needsLegacyPrep([]), false);
  assert.equal(needsLegacyPrep(null), false);
});

// ---------- Пауза після кроку (delayAfter) ----------
test('delayAfterMs: число/рядок, округлення, межі, сміття → 0', () => {
  assert.equal(delayAfterMs({}), 0);
  assert.equal(delayAfterMs(null), 0);
  assert.equal(delayAfterMs({ delayAfter: 500 }), 500);
  assert.equal(delayAfterMs({ delayAfter: '750' }), 750);
  assert.equal(delayAfterMs({ delayAfter: 99.6 }), 100);
  assert.equal(delayAfterMs({ delayAfter: 0 }), 0);
  assert.equal(delayAfterMs({ delayAfter: -300 }), 0);
  assert.equal(delayAfterMs({ delayAfter: 'abc' }), 0);
  assert.equal(delayAfterMs({ delayAfter: Infinity }), 0);
  assert.equal(delayAfterMs({ delayAfter: true }), 0);
  assert.equal(delayAfterMs({ delayAfter: { a: 1 } }), 0);
  assert.equal(delayAfterMs({ delayAfter: 10 * MAX_DELAY_AFTER }), MAX_DELAY_AFTER);
});

test('formatDelay: мс до секунди, секунди з комою, 0 → порожньо', () => {
  assert.equal(formatDelay(0), '');
  assert.equal(formatDelay(undefined), '');
  assert.equal(formatDelay(300), '+300 мс');
  assert.equal(formatDelay(999), '+999 мс');
  assert.equal(formatDelay(1000), '+1 с');
  assert.equal(formatDelay(1500), '+1,5 с');
  assert.equal(formatDelay(12345), '+12,3 с');
});

test('delayAfter переживає збереження (не тимчасове поле) і normalizeStep', () => {
  assert.ok(!TRANSIENT_FIELDS.includes('delayAfter'));
  assert.equal(stripTransient({ type: 'click', delayAfter: 800, status: 'done' }).delayAfter, 800);
  assert.equal(normalizeStep({ type: 'click', x: 1, y: 2, delayAfter: 800 }).delayAfter, 800);
});

test('flattenScenario: пауза на legacy-літері закриває групу злиття й лишається після неї', () => {
  const ch = (c, extra) => ({ type: 'text', text: c, ...extra });
  const page = { id: 1, url: 'u', recs: [{ id: 7, subs: [ch('a'), ch('b', { delayAfter: 1200 }), ch('c'), ch('d')] }] };
  const { flat, map } = flattenScenario(page, null, {});
  assert.equal(flat.length, 2);
  assert.equal(flat[0].text, 'ab');
  assert.equal(flat[0].delayAfter, 1200);
  assert.equal(flat[1].text, 'cd');
  assert.equal(flat[1].delayAfter, undefined, 'пауза не «перетікає» на наступну групу');
  assert.deepEqual(map.map(m => m.subIdxs), [[0, 1], [2, 3]]);
});

test('flattenScenario: пауза ПЕРШОЇ літери групи не дістається злитому кроку, якщо вона не остання', () => {
  // перша літера з паузою сама закриває свою групу → окремий крок
  const page = { id: 1, url: 'u', recs: [{ id: 7, subs: [{ type: 'text', text: 'x', delayAfter: 300 }, { type: 'text', text: 'y' }] }] };
  const { flat } = flattenScenario(page, null, {});
  assert.deepEqual(flat.map(f => [f.text, f.delayAfter]), [['x', 300], ['y', undefined]]);
});

test('flattenScenario: v2-крок зберігає delayAfter як є', () => {
  const page = { id: 1, url: 'u', recs: [{ id: 7, subs: [{ id: 's1', v: 2, type: 'key', key: 'Enter', delayAfter: 2000 }] }] };
  assert.equal(flattenScenario(page, null, {}).flat[0].delayAfter, 2000);
});

test('compactMoves («Оптимізувати») не губить паузу після літери', () => {
  const subs = [{ type: 'move', x: 1, y: 1 }, { type: 'text', text: 'a' }, { type: 'text', text: 'b', delayAfter: 500 }, { type: 'text', text: 'c' }];
  const r = compactMoves(subs);
  assert.deepEqual(r.subs.map(s => [s.text, s.delayAfter]), [['ab', 500], ['c', undefined]]);
});

// ---------- Ручне обʼєднання двох текстових кроків ----------
const fieldTgt = (name) => ({ frame: null, pick: 0, locs: [{ by: 'label', value: name, n: 1 }], box: { x: 0, y: 0, w: 10, h: 10 }, desc: 'поле «' + name + '»' });

test('textTemplateOf: legacy — буквальний текст/рандом → шаблон; v2 — як є', () => {
  assert.equal(textTemplateOf({ type: 'text', text: 'a{b' }), 'a{{b');
  assert.equal(textTemplateOf({ type: 'text', text: 'x', random: 'digit' }), '{d}');
  assert.equal(textTemplateOf({ type: 'text', text: 'x', random: 'letter' }), '{l}');
  assert.equal(textTemplateOf({ type: 'text', v: 2, text: 'id{d}' }), 'id{d}');
  assert.equal(textTemplateOf({ type: 'click' }), '');
});

test('nextVisibleIndex: рухи перескакуються лише коли приховані', () => {
  const subs = [{ type: 'text' }, { type: 'move' }, { type: 'move' }, { type: 'text' }];
  assert.equal(nextVisibleIndex(subs, 0, { hideMoves: true }), 3);
  assert.equal(nextVisibleIndex(subs, 0, { hideMoves: false }), 1);
  assert.equal(nextVisibleIndex(subs, 3, { hideMoves: true }), -1);
  assert.equal(nextVisibleIndex(null, 0), -1);
});

test('canMergeText: лише текст+текст, не вимкнені/не в процесі, те саме поле або без цілі', () => {
  const t = (extra) => ({ type: 'text', v: 2, text: 'a', ...extra });
  assert.equal(canMergeText(t(), t()).ok, true);
  assert.equal(canMergeText(t(), { type: 'click' }).ok, false);
  assert.equal(canMergeText(t({ disabled: true }), t()).ok, false);
  assert.equal(canMergeText(t(), t({ pending: true })).ok, false);
  assert.equal(canMergeText(t({ target: fieldTgt('Email') }), t()).ok, true, 'b без цілі успадковує поле a');
  assert.equal(canMergeText(t({ target: fieldTgt('Email') }), t({ target: fieldTgt('Email') })).ok, true);
  const diff = canMergeText(t({ target: fieldTgt('Email') }), t({ target: fieldTgt('Імʼя') }));
  assert.equal(diff.ok, false);
  assert.match(diff.reason, /різні поля/);
});

test('mergeTextSteps: два v2-тексти → один, ціль/прапорці від першого, пауза від другого; вхід не мутується', () => {
  const subs = [
    { id: 'a', v: 2, type: 'text', text: 'john', target: fieldTgt('Email'), optional: true, delayAfter: 100, status: 'done' },
    { id: 'b', v: 2, type: 'text', text: '{d}@ex.com', delayAfter: 900 },
    { id: 'c', type: 'click', x: 1, y: 1 },
  ];
  const snapshot = JSON.stringify(subs);
  const r = mergeTextSteps(subs, 0);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(subs), snapshot, 'вхід не змінено');
  assert.equal(r.subs.length, 2);
  assert.equal(r.removed, 1);
  assert.deepEqual(
    { id: r.step.id, v: r.step.v, text: r.step.text, desc: r.step.target.desc, optional: r.step.optional, delayAfter: r.step.delayAfter, status: r.step.status },
    { id: 'a', v: 2, text: 'john{d}@ex.com', desc: 'поле «Email»', optional: true, delayAfter: 900, status: undefined });
  assert.equal(r.subs[1].id, 'c');
  assert.equal(r.droppedDelay, 100, 'пауза між двома введеннями прибрана — UI має про це сказати');
});

test('formatDelay {plus:false}: без «+» для тексту', () => {
  assert.equal(formatDelay(1500, { plus: false }), '1,5 с');
  assert.equal(formatDelay(250, { plus: false }), '250 мс');
  assert.equal(formatDelay(0, { plus: false }), '');
});

test('mergeTextSteps: droppedDelay = 0, якщо в першого кроку паузи не було', () => {
  const r = mergeTextSteps([{ v: 2, type: 'text', text: 'a' }, { v: 2, type: 'text', text: 'b', delayAfter: 500 }], 0);
  assert.equal(r.ok, true);
  assert.equal(r.droppedDelay, 0);
  assert.equal(r.step.delayAfter, 500);
});

test('TRANSIENT_FIELDS: pausing (UI-стан паузи під час прогону) не зберігається', () => {
  assert.ok(TRANSIENT_FIELDS.includes('pausing'));
  assert.equal(stripTransient({ type: 'key', key: 'A', delayAfter: 900, pausing: true }).pausing, undefined);
});

test('mergeTextSteps: legacy-символи (з рандомом і «{») → v2-шаблон без random', () => {
  const r = mergeTextSteps([{ type: 'text', text: '{' }, { type: 'text', text: 'x', random: 'digit' }], 0);
  assert.equal(r.ok, true);
  assert.equal(r.step.text, '{{{d}');
  assert.equal(r.step.v, 2);
  assert.equal(r.step.random, undefined);
});

test('mergeTextSteps: через приховані рухи — рухи лишаються, а без hideMoves сусід — рух → відмова', () => {
  const subs = [{ type: 'text', text: 'a' }, { type: 'move', x: 1, y: 1 }, { type: 'text', text: 'b' }];
  const r = mergeTextSteps(subs, 0, { hideMoves: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.subs.map(s => s.type), ['text', 'move']);
  assert.equal(r.step.text, 'ab');
  assert.equal(mergeTextSteps(subs, 0, { hideMoves: false }).ok, false);
});

test('mergeTextSteps: ціль від другого, якщо в першого немає; без наступного кроку → відмова', () => {
  const r = mergeTextSteps([{ v: 2, type: 'text', text: 'a' }, { v: 2, type: 'text', text: 'b', target: fieldTgt('Email') }], 0);
  assert.equal(r.step.target.desc, 'поле «Email»');
  assert.equal(mergeTextSteps([{ type: 'text', text: 'a' }], 0).ok, false);
  assert.equal(mergeTextSteps([], 0).ok, false);
});

test('mergeTextSteps: злитий крок відтворюється як один текстовий крок (flattenScenario)', () => {
  const r = mergeTextSteps([{ type: 'text', text: 'h' }, { type: 'text', text: 'i' }], 0);
  const { flat } = flattenScenario({ id: 1, url: 'u', recs: [{ id: 3, subs: r.subs }] }, null, {});
  assert.equal(flat.length, 1);
  assert.equal(flat[0].text, 'hi');
});

test('healthOf: локатор type (input[type=file]) — 🎯 якщо унікальний, ⚠ якщо кілька збігів', () => {
  const step = (n) => ({ v: 2, type: 'file', target: { pick: 0, locs: [{ by: 'type', tag: 'input', value: 'file', n }] } });
  assert.equal(healthOf(step(1)), 'semantic');
  assert.equal(healthOf(step(2)), 'weak');
  assert.equal(healthOf({ v: 2, type: 'file', target: { pick: 0, locs: [{ by: 'css', value: 'div > input', n: 1 }] } }), 'weak', 'лише CSS-шлях — як і раніше ⚠');
});

test('normalizeStep: старий крок «Файл» лише з CSS → додається input[type=file] перед CSS, pick лишається на CSS', () => {
  const legacy = { id: 's1', v: 2, type: 'file', target: { kind: 'file', pick: 0, frame: null, locs: [{ by: 'css', value: 'div._container_f7cvd_28 > input', n: 1 }] } };
  const n = normalizeStep(legacy);
  assert.deepEqual(n.target.locs.map((l) => l.by), ['type', 'css']);
  assert.equal(n.target.locs[n.target.pick].by, 'css');
  assert.equal(legacy.target.locs.length, 1, 'вхід не мутується');
  // семантичні вище — тип іде після них
  const lab = normalizeStep({ id: 's2', type: 'file', target: { pick: 0, locs: [{ by: 'label', value: 'CV', n: 1 }, { by: 'css', value: 'x' }] } });
  assert.deepEqual(lab.target.locs.map((l) => l.by), ['label', 'type', 'css']);
  assert.equal(lab.target.pick, 0);
  // вже є type / не файл / pick=-1 — без змін
  assert.equal(normalizeStep({ id: 's3', type: 'file', target: { pick: 0, locs: [{ by: 'type', tag: 'input', value: 'file', n: 1 }] } }).target.locs.length, 1);
  assert.equal(normalizeStep({ id: 's4', type: 'click', target: { pick: 0, locs: [{ by: 'css', value: 'x' }] } }).target.locs.length, 1);
  assert.equal(normalizeStep({ id: 's5', type: 'file', target: { pick: -1, locs: [{ by: 'css', value: 'x' }] } }).target.locs.length, 1);
});

test('healthOf: input[type=file] без підрахунку (n невідомий) — ⚠', () => {
  assert.equal(healthOf({ v: 2, type: 'file', target: { pick: 0, locs: [{ by: 'type', tag: 'input', value: 'file' }] } }), 'weak');
});
