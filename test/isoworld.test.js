// lib/isoworld.js з фейковою CDP-сесією: кеш контекстів ізольованого світу, інвалідація
// після навігації («Cannot find context»), зміна id головного фрейму, дочірній фрейм через
// DOM.describeNode, out-of-process фрейм (окрема сесія), відкат на page.evaluate без CDP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIso, callExpression, isoState, evalMain } from '../lib/isoworld.js';

// Фейкова сесія: frames — множина frameId цього таргета; contexts — живі contextId.
function fakeSess(frames, { evalImpl } = {}) {
  let nextCtx = 1;
  const s = {
    calls: [], live: new Map(), frames: new Set(frames),
    async send(method, params = {}) {
      s.calls.push([method, params]);
      if (method === 'Page.createIsolatedWorld') {
        if (!s.frames.has(params.frameId)) throw new Error('Protocol error (Page.createIsolatedWorld): No frame for given id found');
        const id = nextCtx++;
        s.live.set(id, params.frameId);
        return { executionContextId: id };
      }
      if (method === 'Runtime.evaluate') {
        if (!s.live.has(params.contextId)) throw new Error('Protocol error (Runtime.evaluate): Cannot find context with specified id');
        return evalImpl ? evalImpl(params, s.live.get(params.contextId)) : { result: { value: params.expression } };
      }
      if (method === 'DOM.describeNode') return { node: { frameId: params.objectId.replace('obj:', '') } };
      if (method === 'Runtime.releaseObject') return {};
      throw new Error('unexpected ' + method);
    },
    navigate() { s.live.clear(); }, // новий документ — старі контексти знищено
  };
  return s;
}

test('callExpression: функція + JSON-аргумент; без аргументу — порожній виклик', () => {
  assert.equal(callExpression((a) => a.x, { x: 1 }), '((a) => a.x)({"x":1})');
  assert.equal(callExpression(() => 1), '(() => 1)()');
});

test('evaluate: один ізольований світ на фрейм (кеш), returnByValue + awaitPromise, БЕЗ Runtime.enable', async () => {
  const s = fakeSess(['M'], { evalImpl: () => ({ result: { value: 42 } }) });
  const iso = createIso(s, 'M', { worldName: 'w' });
  assert.equal(await iso.evaluate(null, () => 42), 42);
  assert.equal(await iso.evaluate(null, () => 42), 42);
  assert.equal(s.calls.filter(([m]) => m === 'Page.createIsolatedWorld').length, 1);
  const ev = s.calls.find(([m]) => m === 'Runtime.evaluate')[1];
  assert.equal(ev.returnByValue, true);
  assert.equal(ev.awaitPromise, true);
  assert.equal(ev.contextId, 1);
  assert.ok(!s.calls.some(([m]) => m === 'Runtime.enable' || m === 'DOM.enable'));
  assert.equal(s.calls[0][1].worldName, 'w');
});

test('навігація: «Cannot find context» → світ створюється заново, виклик повторюється один раз', async () => {
  const s = fakeSess(['M'], { evalImpl: (_p, fid) => ({ result: { value: fid } }) });
  const iso = createIso(s, 'M');
  assert.equal(await iso.evaluate(null, () => 0), 'M');
  s.navigate();
  assert.equal(await iso.evaluate(null, () => 0), 'M');
  assert.equal(s.calls.filter(([m]) => m === 'Page.createIsolatedWorld').length, 2);
});

test('виняток у функції сторінки → помилка (не тихе значення); stale-контекст у exceptionDetails теж повторюється', async () => {
  let n = 0;
  const s = fakeSess(['M'], {
    evalImpl: () => (++n === 1
      ? { exceptionDetails: { text: 'Uncaught', exception: { description: 'Cannot find context with specified id' } } }
      : { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom\n    at …' } } }),
  });
  const iso = createIso(s, 'M');
  await assert.rejects(iso.evaluate(null, () => 0), /TypeError: boom$/);
  assert.equal(n, 2);
});

test('id головного фрейму змінився (No frame) → refreshMain і повтор', async () => {
  const s = fakeSess(['M2'], { evalImpl: (_p, fid) => ({ result: { value: fid } }) });
  const iso = createIso(s, 'M1', { refreshMain: async () => 'M2' });
  assert.equal(await iso.evaluate(null, () => 0), 'M2');
  assert.equal(iso.mainId, 'M2');
});

test('childRef: iframe → describeNode → frameId у тій самій сесії; out-of-process → сесія з oopifFor; немає → null', async () => {
  const obj = (fid) => ({ result: { objectId: 'obj:' + fid } });
  const s = fakeSess(['M', 'C'], { evalImpl: (p) => (p.returnByValue === false ? obj(p.expression) : { result: { value: 1 } }) });
  const remote = fakeSess(['R']);
  const iso = createIso(s, 'M', { oopifFor: async (fid) => (fid === 'R' ? remote : null) });
  const c = await iso.childRef(null, 'C');
  assert.deepEqual([c.sess === s, c.frameId], [true, 'C']);
  assert.ok(s.calls.some(([m, p]) => m === 'Runtime.releaseObject' && p.objectId === 'obj:C'));
  const r = await iso.childRef(null, 'R');
  assert.deepEqual([r.sess === remote, r.frameId], [true, 'R']);
  assert.ok(remote.calls.some(([m]) => m === 'Page.createIsolatedWorld'));
  assert.equal(await iso.childRef(null, 'GONE'), null);
  // вираз дав null (не iframe) → null без describeNode
  const s2 = fakeSess(['M'], { evalImpl: () => ({ result: { type: 'object', subtype: 'null', value: null } }) });
  assert.equal(await createIso(s2, 'M').childRef(null, 'x'), null);
  assert.ok(!s2.calls.some(([m]) => m === 'DOM.describeNode'));
});

test('isoState/evalMain: без CDP (Camoufox/фейк) → null і page.evaluate; з CDP — ізольований світ, сесія одна на сторінку', async () => {
  const plain = { async evaluate(fn, arg) { return ['page', arg]; } };
  assert.equal(await isoState(plain), null);
  assert.deepEqual(await evalMain(plain, (a) => a, 5), ['page', 5]);
  const firefoxLike = { context: () => ({ async newCDPSession() { throw new Error('CDP session is only available in Chromium'); } }), async evaluate() { return 'pe'; } };
  assert.equal(await evalMain(firefoxLike, () => 0), 'pe');
  let sessions = 0;
  const sess = fakeSess(['M'], { evalImpl: () => ({ result: { value: 'iso' } }) });
  sess.send = ((orig) => async (m, p) => (m === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'M' } } } : orig(m, p)))(sess.send);
  const chromeLike = {
    context: () => ({ async newCDPSession() { sessions++; return sess; } }),
    async evaluate() { throw new Error('головний світ не має використовуватись'); },
    frames: () => [], mainFrame: () => null,
  };
  assert.equal(await evalMain(chromeLike, () => 0), 'iso');
  assert.equal(await evalMain(chromeLike, () => 0), 'iso');
  assert.equal(sessions, 1);
});
