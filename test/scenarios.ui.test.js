// Юніт-тести чистих частин сайдбару сценаріїв (F2): persist.js (черга збереження з
// фейковими fetch/таймерами), runner.js (план, події, підсумок, бейджі), stepEditor.js
// (чипи, кандидати, редагування, групування рухів, перестановка). Без DOM і браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistQueue, badgeInfo, savePayload } from '../public/js/persist.js';
import { createRunPlan, applyRunEvent, summarizeRun, strategyBadge, finishRun, runScenario, stopRun, isFallback } from '../public/js/runner.js';
import { nextRecName, guardUndo, UNDO_BLOCKED, subsStamp, subsUnchanged } from '../public/js/scenarioModel.js';
import { createPausableTimer } from '../public/js/dialogs.js';
import { followRecordingRow, followRec } from '../public/js/scenarios.js';
import {
  healthChip, countLevel, candidateOptions, editorValues, applyEdit, insertToken, groupRows, moveStep, pluralUk,
} from '../public/js/stepEditor.js';
import { state } from '../public/js/state.js';
import { pagePayload, mergeTextSteps } from '../lib/steps.js';

// ---------- фейкові таймери ----------
function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    setTimeout(fn, d) { const id = ++seq; q.set(id, { fn, at: now + (d || 0) }); return id; },
    clearTimeout(id) { q.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of q) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    get size() { return q.size; },
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// ---------- persist.js ----------
test('persist: debounce — кілька змін за вікно → один PUT з найсвіжішим станом', async () => {
  const t = fakeTimers();
  const calls = [];
  let cur = 1;
  const q = createPersistQueue({ save: async (id, p) => { calls.push([id, p]); return { ok: true, db: true }; }, delay: 400, timers: t });
  q.schedule(7, () => ({ v: cur }));
  cur = 2; q.schedule(7, () => ({ v: cur }));
  cur = 3; q.schedule(7, () => ({ v: cur }));
  await t.advance(399);
  assert.equal(calls.length, 0);
  assert.equal(q.status().pending, 1);
  assert.equal(q.status().unsaved, true);
  await t.advance(1);
  assert.deepEqual(calls, [[7, { v: 3 }]]);
  assert.equal(q.status().unsaved, false);
});

test('persist: серіалізація — зміна під час польоту → ще один PUT ПІСЛЯ першого (не паралельно)', async () => {
  const t = fakeTimers();
  const d1 = deferred();
  const calls = [];
  let inflight = 0, maxInflight = 0;
  let cur = 'a';
  const q = createPersistQueue({
    timers: t, delay: 100,
    save: async (_id, p) => {
      calls.push(p.v); inflight++; maxInflight = Math.max(maxInflight, inflight);
      if (calls.length === 1) await d1.p;
      inflight--; return { db: true };
    },
  });
  q.schedule(1, () => ({ v: cur }));
  await t.advance(100);
  assert.deepEqual(calls, ['a']);
  cur = 'b'; q.schedule(1, () => ({ v: cur }));
  cur = 'c'; q.schedule(1, () => ({ v: cur }));
  await t.advance(1000);
  assert.deepEqual(calls, ['a'], 'другий PUT чекає завершення першого');
  assert.equal(q.status().saving, 1);
  d1.resolve();
  await flush();
  assert.deepEqual(calls, ['a', 'c']);
  assert.equal(maxInflight, 1);
  assert.equal(q.status().unsaved, false);
});

test('persist: помилка → повтори з затримками, далі «Не збережено» до retryAll', async () => {
  const t = fakeTimers();
  let fail = true, n = 0;
  const states = [];
  const q = createPersistQueue({
    timers: t, delay: 10, retryDelays: [100, 200],
    save: async () => { n++; if (fail) throw new Error('HTTP 503'); return { db: true }; },
    onChange: (st) => states.push(st),
  });
  q.schedule(5, () => ({}));
  await t.advance(10);
  assert.equal(n, 1);
  assert.equal(q.status().failed, 1);
  assert.equal(q.status().lastError.message, 'HTTP 503');
  await t.advance(100); assert.equal(n, 2);
  await t.advance(200); assert.equal(n, 3);
  await t.advance(10000); assert.equal(n, 3, 'після вичерпання повторів — тиша');
  const info = badgeInfo(q.status());
  assert.equal(info.cls, 'error');
  assert.equal(info.clickable, true);
  assert.match(info.title, /HTTP 503/);
  fail = false;
  await q.retryAll();
  assert.equal(n, 4);
  assert.equal(q.status().unsaved, false);
  assert.equal(badgeInfo(q.status()), null);
  assert.ok(states.some((s) => s.failed === 1));
});

test('persist: нова зміна після збою скидає лічильник повторів', async () => {
  const t = fakeTimers();
  let n = 0;
  const q = createPersistQueue({ timers: t, delay: 10, retryDelays: [50], save: async () => { n++; if (n < 3) throw new Error('x'); return { db: true }; } });
  q.schedule(1, () => ({}));
  await t.advance(10); await t.advance(50);
  assert.equal(n, 2);
  q.schedule(1, () => ({}));
  await t.advance(10);
  assert.equal(n, 3);
  assert.equal(q.status().unsaved, false);
});

test('persist: {db:false} → nodb (бейдж «Не збережено», без нескінченних повторів)', async () => {
  const t = fakeTimers();
  let n = 0;
  const q = createPersistQueue({ timers: t, delay: 10, save: async () => { n++; return { ok: true, db: false }; } });
  q.schedule(1, () => ({}));
  await t.advance(10);
  await t.advance(60000);
  assert.equal(n, 1);
  const st = q.status();
  assert.equal(st.nodb, true);
  assert.equal(st.nodbDirty, true);
  assert.equal(st.unsaved, true);
  assert.equal(badgeInfo(st).cls, 'nodb');
  assert.equal(badgeInfo(st).clickable, false);
});

test('persist: {db:false, memory:true} → збережено в памʼяті сервера: без «Не збережено»', async () => {
  const t = fakeTimers();
  let n = 0;
  const q = createPersistQueue({ timers: t, delay: 10, save: async () => { n++; return { ok: true, db: false, memory: true }; },
    remove: async () => ({ ok: true, db: false, memory: true }) });
  q.schedule(1, () => ({}));
  await t.advance(10);
  await t.advance(60000);
  assert.equal(n, 1);
  let st = q.status();
  assert.equal(st.nodb, true);
  assert.equal(st.nodbDirty, false);
  assert.equal(st.unsaved, false);
  assert.equal(badgeInfo(st), null);
  await q.remove(1);
  st = q.status();
  assert.equal(st.nodbDirty, false);
});

test('persist: remove скасовує відкладений PUT і робить DELETE після PUT у польоті', async () => {
  const t = fakeTimers();
  const log = [];
  const d = deferred();
  const q = createPersistQueue({
    timers: t, delay: 10,
    save: async (id) => { log.push('put' + id); await d.p; log.push('put-done' + id); return { db: true }; },
    remove: async (id) => { log.push('del' + id); return { db: true }; },
  });
  q.schedule(1, () => ({}));
  await t.advance(10);
  q.schedule(1, () => ({})); // зміна під час польоту
  const rm = q.remove(1);
  await flush();
  assert.deepEqual(log, ['put1'], 'DELETE чекає PUT');
  d.resolve();
  await rm;
  assert.deepEqual(log, ['put1', 'put-done1', 'del1'], 'після видалення відкладений PUT не відправлено');
  q.schedule(2, () => ({}));
  await q.remove(2);
  await t.advance(100);
  assert.ok(!log.includes('put2'), 'відкладений PUT скасовано');
  assert.equal(q.status().unsaved, false);
});

test('persist: getPayload → null (сценарій зник) — нічого не шлемо; flushAll шле одразу', async () => {
  const t = fakeTimers();
  const calls = [];
  const q = createPersistQueue({ timers: t, delay: 1000, save: async (id) => { calls.push(id); return { db: true }; } });
  q.schedule(1, () => null);
  q.schedule(2, () => ({ a: 1 }));
  await q.flushAll();
  assert.deepEqual(calls, [2]);
  assert.equal(q.status().unsaved, false);
  assert.equal(t.size, 0);
});

test('badgeInfo: без БД — лише після незбереженої зміни; під час збереження без БД — без «Зберігаю…»', () => {
  assert.equal(badgeInfo({ pending: 0, saving: 0, failed: 0, nodb: true, nodbDirty: false }), null);
  assert.equal(badgeInfo({ pending: 1, saving: 0, failed: 0, nodb: true, nodbDirty: false }), null);
  assert.equal(badgeInfo({ pending: 0, saving: 0, failed: 0, nodb: true, nodbDirty: true }).cls, 'nodb');
});

test('savePayload: без тимчасових полів і без pending-кроків живого запису; модель не мутується', () => {
  const page = { id: 1, name: 'n', url: 'u', expanded: true, lastRun: {}, recs: [{ id: 2, name: 'r', expanded: true, running: true, subs: [
    { type: 'click', x: 1, y: 2, status: 'done', strategy: 'coord', ms: 5 }, { type: 'text', text: 'a', pending: true, status: 'running' },
  ] }] };
  assert.deepEqual(savePayload(page), { name: 'n', url: 'u', recs: [{ id: 2, name: 'r', subs: [{ type: 'click', x: 1, y: 2 }] }] });
  assert.equal(page.recs[0].subs.length, 2);
  assert.equal(page.recs[0].subs[0].status, 'done');
});

test('badgeInfo: saving / нічого', () => {
  assert.equal(badgeInfo({ pending: 0, saving: 0, failed: 0, nodb: false }), null);
  assert.equal(badgeInfo({ pending: 1, saving: 0, failed: 0, nodb: false }).cls, 'saving');
  assert.equal(badgeInfo(null), null);
});

// ---------- runner.js ----------
const legacyPage = () => ({
  id: 1, name: 'S', url: 'http://x',
  recs: [
    { id: 10, name: 'Дія A', subs: [
      { type: 'move', x: 1, y: 1 },
      { type: 'click', x: 5, y: 6 },
      { type: 'text', text: 'h' }, { type: 'text', text: 'i', status: 'failed', error: 'old', failShot: 'data:old', strategy: 'coord' },
      { type: 'key', key: 'Enter' },
    ] },
    { id: 11, name: 'Дія B', subs: [
      { v: 2, id: 's_1', type: 'click', target: { locs: [{ by: 'role', role: 'button', name: 'Go', n: 1 }], pick: 0, desc: 'кнопка «Go»' }, x: 9, y: 9 },
    ] },
  ],
});

test('createRunPlan: злиття legacy-тексту, пропуск рухів, скидання тимчасових полів', () => {
  const page = legacyPage();
  const plan = createRunPlan(page, undefined, { skipMoves: true });
  assert.equal(plan.total, 4); // click, text«hi», key, click(v2)
  assert.deepEqual(plan.map.map((m) => m.subIdxs), [[1], [2, 3], [4], [0]]);
  assert.equal(plan.flat[1].text, 'hi');
  const subs = page.recs[0].subs;
  assert.equal(subs[0].status, 'skipped');
  assert.equal(subs[3].status, 'idle');
  assert.equal(subs[3].error, undefined);
  assert.equal(subs[3].failShot, undefined);
  assert.equal(subs[3].strategy, undefined);
  assert.equal(page.recs[0].runTotal, 3);
  assert.equal(page.recs[0].running, true);
  assert.throws(() => createRunPlan(page, 999), /не знайдено/);
  const upto = createRunPlan(legacyPage(), 10, { skipMoves: false });
  assert.equal(upto.total, 4);
  assert.equal(upto.recs.length, 1);
});

test('applyRunEvent: статуси, стратегія, мс, healed, помилка й failShot (лише на першому рядку злитого кроку)', () => {
  const page = legacyPage();
  const plan = createRunPlan(page);
  const subs = page.recs[0].subs;
  applyRunEvent(plan, { event: 'action', index: 1 });
  assert.equal(subs[2].status, 'running');
  assert.equal(subs[3].status, 'running');
  assert.equal(page.recs[0].runCur, 2);
  const r = applyRunEvent(plan, { event: 'done-action', index: 1, ok: false, error: 'немає фокусу', strategy: null, ms: 120, failShot: 'data:x' });
  assert.equal(r.result.failed, true);
  assert.equal(subs[2].status, 'failed');
  assert.equal(subs[3].status, 'failed');
  assert.equal(subs[2].error, 'немає фокусу');
  assert.equal(subs[2].failShot, 'data:x');
  assert.equal(subs[3].failShot, undefined);
  applyRunEvent(plan, { event: 'done-action', index: 3, ok: true, error: null, strategy: 'loc-alt', ms: 340, healed: true });
  const v2 = page.recs[1].subs[0];
  assert.equal(v2.status, 'done');
  assert.equal(v2.strategy, 'loc-alt');
  assert.equal(v2.ms, 340);
  assert.equal(v2.healed, true);
  applyRunEvent(plan, { event: 'done-action', index: 2, ok: false, aborted: true, error: 'Зупинено' });
  assert.equal(subs[4].status, 'skipped');
  assert.equal(subs[4].error, undefined, 'збій через Stop — не помилка кроку');
  assert.equal(applyRunEvent(plan, { event: 'done-action', index: 99 }), null);
  assert.equal(applyRunEvent(plan, { event: 'log' }), null);
  // Тимчасові поля не потрапляють у збереження.
  const saved = pagePayload(page);
  assert.equal(saved.recs[1].subs[0].strategy, undefined);
  assert.equal(saved.recs[1].subs[0].healed, undefined);
  assert.equal(saved.recs[0].subs[2].failShot, undefined);
});

test('summarizeRun: «успішно N, помилок M (крок K у «Дія»: …)», номер кроку — як у рядку сайдбару', () => {
  const page = legacyPage();
  const plan = createRunPlan(page);
  applyRunEvent(plan, { event: 'done-action', index: 0, ok: true, strategy: 'coord', ms: 10 });
  applyRunEvent(plan, { event: 'done-action', index: 1, ok: false, error: 'Execution context was destroyed' });
  applyRunEvent(plan, { event: 'done-action', index: 2, ok: true, skipped: true });
  applyRunEvent(plan, { event: 'done-action', index: 3, ok: true, strategy: 'loc-alt', healed: true });
  const s = summarizeRun(plan, { done: { actionsReplayed: 2, actionsTotal: 4, stopped: false, timing: { totalMs: 4200 } } });
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.firstFail.step, 3);
  assert.equal(s.firstFail.recName, 'Дія A');
  assert.equal(s.status, 'failed');
  assert.equal(s.ms, 4200);
  assert.match(s.text, /^успішно 2, помилок 1 \(крок 3 у «Дія A»: Execution context was destroyed\)/);
  assert.match(s.text, /пропущено 1/);
  assert.match(s.text, /виправлено локаторів: 1/);

  const clean = createRunPlan(legacyPage());
  applyRunEvent(clean, { event: 'done-action', index: 0, ok: true });
  const st = summarizeRun(clean, { stopped: true });
  assert.equal(st.status, 'stopped');
  assert.match(st.text, /^успішно 1, помилок 0, не виконано 3$/);
  assert.equal(summarizeRun(clean, { error: 'HTTP 400' }).status, 'error');
});

test('strategyBadge: іконки і час', () => {
  assert.equal(strategyBadge('loc', 340).text, '🎯 · 340 мс');
  assert.equal(strategyBadge('loc-alt', 12).text, '🔁 · 12 мс');
  assert.equal(strategyBadge('nth', 5).text, '#nth · 5 мс');
  assert.equal(strategyBadge('coord', 15000).text, '📍 · 15.0 с');
  assert.equal(strategyBadge('snap').text, '🧲');
  assert.equal(strategyBadge('snap').cls, 'strat-snap');
  assert.equal(strategyBadge(null, null), null);
});

test('applyRunEvent: pause → plan.pause + a.pausing до наступного action; finishRun прибирає', () => {
  const page = legacyPage();
  const plan = createRunPlan(page);
  const subs = page.recs[0].subs;
  applyRunEvent(plan, { event: 'action', index: 0 });
  applyRunEvent(plan, { event: 'done-action', index: 0, ok: true });
  const r = applyRunEvent(plan, { event: 'pause', index: 0, ms: 1500 });
  assert.equal(r.pause, 1500);
  assert.deepEqual(plan.pause, { index: 0, ms: 1500 });
  assert.equal(subs[plan.map[0].subIdxs[0]].pausing, true);
  assert.equal(subs[plan.map[0].subIdxs[0]].status, 'done', 'крок виконано — пауза ПІСЛЯ нього');
  assert.equal(pagePayload(page).recs[0].subs[plan.map[0].subIdxs[0]].pausing, undefined, 'pausing не зберігається');
  applyRunEvent(plan, { event: 'action', index: 1 });
  assert.equal(plan.pause, null);
  assert.equal(subs[plan.map[0].subIdxs[0]].pausing, undefined);
  // Пауза після останнього кроку → прибирається у finishRun.
  applyRunEvent(plan, { event: 'pause', index: 1, ms: 300 });
  finishRun(page, plan);
  assert.equal(plan.pause, null);
  assert.ok(subs.every((a) => !a.pausing));
  assert.equal(applyRunEvent(plan, { event: 'pause', index: 99, ms: 1 }), null);
});

test('subsStamp/subsUnchanged: відкат обʼєднання відмовляє після перестановки, видалення, ✎ чи додавання', () => {
  const mk = () => {
    const rec = { id: 1, name: 'Д', subs: [{ id: 'a', v: 2, type: 'text', text: 'I' }, { id: 'b', v: 2, type: 'text', text: 'van' }, { id: 'c', type: 'click', x: 1, y: 1 }, { id: 'k', type: 'key', key: 'Tab' }] };
    const res = mergeTextSteps(rec.subs, 0);
    rec.subs = res.subs;
    return { rec, stamp: subsStamp(rec) };
  };
  let { rec, stamp } = mk();
  assert.equal(subsUnchanged(rec, stamp), true, 'одразу після злиття відкат дозволено');
  rec.subs[0].disabled = true; // зміна прапорця на місці — before ділить ті самі обʼєкти, відкат безпечний
  assert.equal(subsUnchanged(rec, stamp), true);
  // перестановка на місці (moveStep сплайсить той самий масив)
  ({ rec, stamp } = mk());
  moveStep(rec.subs, rec.subs.length - 1, -1);
  assert.equal(rec.subs.map((x) => x.id).join(','), 'a,k,c');
  assert.equal(subsUnchanged(rec, stamp), false);
  // видалення + відновлення (та сама довжина, той самий порядок) — знову дозволено
  ({ rec, stamp } = mk());
  const [del] = rec.subs.splice(1, 1);
  assert.equal(subsUnchanged(rec, stamp), false);
  rec.subs.splice(1, 0, del);
  assert.equal(subsUnchanged(rec, stamp), true);
  // ✎: заміна кроку на новий обʼєкт
  ({ rec, stamp } = mk());
  rec.subs[0] = { ...rec.subs[0], delayAfter: 500 };
  assert.equal(subsUnchanged(rec, stamp), false);
  // додавання (файл / запис)
  ({ rec, stamp } = mk());
  rec.subs.push({ type: 'key', key: 'Enter' });
  assert.equal(subsUnchanged(rec, stamp), false);
  // інший масив (напр. ⚡ оптимізація)
  ({ rec, stamp } = mk());
  rec.subs = rec.subs.slice();
  assert.equal(subsUnchanged(rec, stamp), false);
  assert.equal(subsUnchanged(null, stamp), false);
  assert.equal(subsUnchanged(rec, null), false);
});

test('finishRun: running → skipped, idle → без бейджа', () => {
  const page = legacyPage();
  const plan = createRunPlan(page);
  applyRunEvent(plan, { event: 'action', index: 0 });
  finishRun(page, plan);
  assert.equal(page.recs[0].subs[1].status, 'skipped');
  assert.equal(page.recs[0].subs[4].status, undefined);
  assert.equal(page.recs[0].running, false);
  assert.equal(page.running, false);
});

// runScenario/stopRun з фейковим api: runId → Stop шле POST /replay/:id/stop; підсумок на картці.
test('runScenario: стрім подій, Stop через runId, підсумок і скрін', async () => {
  const page = legacyPage();
  state.pages = [page]; state.running = false; state.recording = false; state.run = null;
  const lines = [], lives = [], screens = [];
  let stopCalled = null;
  const gate = deferred();
  const deps = {
    logLine: (k, t) => lines.push([k, t]), logRunSep: () => {}, setLive: (t) => lives.push(t),
    addScreen: (label, src, url, o) => screens.push({ label, src, url, o }),
    ensureCurrentPreset: async () => 'All',
    api: {
      replay: async (body, onEvent, { signal }) => {
        assert.equal(body.url, 'http://x');
        assert.equal(body.actions.length, 4);
        assert.ok(signal);
        onEvent({ event: 'run', runId: 'r1' });
        onEvent({ event: 'action', index: 0 });
        onEvent({ event: 'done-action', index: 0, ok: false, error: 'boom', strategy: 'coord', ms: 5, failShot: 'data:f' });
        await gate.p; // тут користувач тисне ⏹
        onEvent({ event: 'done', actionsReplayed: 0, actionsTotal: 4, stopped: true, screenshot: 'data:s', url: 'http://x/', timing: { totalMs: 1000 } });
      },
      stopReplay: async (id) => { stopCalled = id; gate.resolve(); return { ok: true }; },
    },
  };
  const p = runScenario(page, undefined, { skipMoves: true, deps });
  await flush();
  assert.equal(state.running, true);
  assert.equal(state.run.runId, 'r1');
  assert.equal(await stopRun({ deps }), true);
  const sum = await p;
  assert.equal(stopCalled, 'r1');
  assert.equal(state.running, false);
  assert.equal(state.run, null);
  assert.equal(sum.failed, 1);
  assert.equal(sum.stopped, true);
  assert.equal(page.lastRun, sum);
  assert.equal(screens.length, 1);
  assert.equal(screens[0].o.ok, false);
  assert.match(screens[0].label, /⏹/);
  // Підпис табу — явно з прогону (а не виведений із прапорців running): усі Дії сценарію.
  assert.equal(screens[0].o.scenario, page.name);
  assert.equal(screens[0].o.upto, page.recs.length);
  assert.equal(screens[0].o.total, page.recs.length);
  assert.ok(lines.some(([k, t]) => k === 'error' && /крок 2 \(.*\): boom/.test(t)));
  assert.match(lives.at(-1), /виконано 0\/4 — успішно 0, помилок 1 \(крок 2 у «Дія A»: boom\)/);
  assert.equal(page.recs[0].subs[1].failShot, 'data:f');
});

test('runScenario: Stop до runId — обрив fetch (AbortError) → «перервано»', async () => {
  const page = legacyPage();
  state.pages = [page]; state.running = false; state.recording = false; state.run = null;
  const lives = [];
  const deps = {
    logLine: () => {}, logRunSep: () => {}, setLive: (t) => lives.push(t), addScreen: () => {}, ensureCurrentPreset: async () => 'x',
    api: {
      replay: (_b, _on, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })),
      stopReplay: async () => { throw new Error('не має викликатись'); },
    },
  };
  const p = runScenario(page, undefined, { deps });
  await flush();
  await stopRun({ deps });
  const sum = await p;
  assert.equal(sum.stopped, true);
  assert.match(lives.at(-1), /перервано/);
});

test('runScenario: не-2xx (ApiError) → помилка в підсумку, стан скинуто', async () => {
  const page = legacyPage();
  state.pages = [page]; state.running = false; state.recording = false; state.run = null;
  const lines = [];
  const deps = {
    logLine: (k, t) => lines.push([k, t]), logRunSep: () => {}, setLive: () => {}, addScreen: () => {}, ensureCurrentPreset: async () => 'x',
    api: { replay: async () => { throw new Error('Не передано url'); }, stopReplay: async () => ({}) },
  };
  const sum = await runScenario(page, undefined, { deps });
  assert.equal(sum.status, 'error');
  assert.equal(state.running, false);
  assert.ok(lines.some(([k, t]) => k === 'error' && /Не передано url/.test(t)));
});

// ---------- stepEditor.js ----------
const v2click = (over = {}) => ({
  v: 2, id: 's_a', type: 'click', x: 10, y: 20,
  target: { locs: [{ by: 'role', role: 'button', name: 'Submit', n: 1 }, { by: 'css', value: 'form button', n: 3 }], pick: 0, desc: 'кнопка «Submit»' },
  ...over,
});

test('healthChip / countLevel', () => {
  assert.equal(healthChip(v2click()).icon, '🎯');
  assert.equal(healthChip(v2click({ target: { ...v2click().target, pick: 1 } })).icon, '⚠');
  assert.equal(healthChip({ type: 'click', x: 1, y: 2 }).icon, '📍');
  assert.match(healthChip({ type: 'text', text: 'a' }).label, /фокус/);
  assert.equal(healthChip({ type: 'key', key: 'Enter' }), null);
  assert.equal(countLevel(1), 'ok');
  assert.equal(countLevel(3), 'warn');
  assert.equal(countLevel(0), 'bad');
  assert.equal(countLevel(undefined), 'unknown');
});

test('candidateOptions: specToString + ×n і «лише координати»', () => {
  const o = candidateOptions(v2click());
  assert.deepEqual(o.map((x) => x.value), ['0', '1', '-1']);
  assert.equal(o[0].text, 'role=button[name="Submit"] ×1');
  assert.equal(o[0].level, 'ok');
  assert.equal(o[1].level, 'warn');
  assert.deepEqual(candidateOptions({ type: 'click', x: 1, y: 1 }), []);
  const noXY = v2click(); delete noXY.x; delete noXY.y;
  assert.ok(!candidateOptions(noXY).some((x) => x.value === '-1'));
});

test('editorValues/applyEdit: legacy random → шаблон {d}; незмінений legacy-текст лишається legacy', () => {
  const leg = { type: 'text', random: 'digit', text: '5' };
  const v = editorValues(leg);
  assert.equal(v.text, '{d}');
  assert.equal(v.legacyRandom, 'digit');
  const same = applyEdit(leg, { text: '{d}', optional: false });
  assert.equal(same.step.v, undefined);
  assert.equal(same.step.random, 'digit');
  const ch = applyEdit(leg, { text: 'id{d}{d}', optional: false });
  assert.equal(ch.step.v, 2);
  assert.equal(ch.step.text, 'id{d}{d}');
  assert.equal(ch.step.random, undefined);
  assert.equal(editorValues({ type: 'text', text: 'a{b' }).text, 'a{{b', 'буквальна «{» екранується');
});

test('applyEdit: pick, waitResponse, optional, timeout, coords, key + валідація; тимчасові поля зникають', () => {
  const s = v2click({ status: 'failed', error: 'x', failShot: 'data:', strategy: 'coord', ms: 1 });
  const r = applyEdit(s, { pick: '-1', waitResponse: true, optional: true, timeout: '8000', x: '11', y: '22' });
  assert.deepEqual(r.errors, {});
  assert.equal(r.step.target.pick, -1);
  assert.equal(s.target.pick, 0, 'вхід не мутується');
  assert.equal(r.step.waitResponse, true);
  assert.equal(r.step.optional, true);
  assert.equal(r.step.timeout, 8000);
  assert.equal(r.step.x, 11);
  for (const k of ['status', 'error', 'failShot', 'strategy', 'ms']) assert.equal(r.step[k], undefined, k);
  const off = applyEdit(r.step, { waitResponse: false, optional: false, timeout: '' });
  assert.equal(off.step.waitResponse, undefined);
  assert.equal(off.step.optional, undefined);
  assert.equal(off.step.timeout, undefined);
  assert.ok(applyEdit(s, { timeout: '10' }).errors.timeout);
  assert.ok(applyEdit(s, { x: 'a', y: '1' }).errors.coords);
  assert.ok(applyEdit(s, { pick: '5' }).errors.pick);
  assert.ok(applyEdit({ type: 'key', key: 'Enter' }, { key: '  ' }).errors.key);
  assert.equal(applyEdit({ type: 'key', key: 'Enter' }, { key: ' Tab ' }).step.key, 'Tab');
  assert.equal(applyEdit({ type: 'text', text: 'a' }, { waitResponse: true }).step.waitResponse, undefined, 'waitResponse лише для кліку');
});

test('insertToken: вставка в курсор / заміна виділення', () => {
  assert.deepEqual(insertToken('ab', 1, 1, '{d}'), { value: 'a{d}b', caret: 4 });
  assert.deepEqual(insertToken('abc', 0, 2, '{l}'), { value: '{l}c', caret: 3 });
  assert.deepEqual(insertToken('ab', null, null, '{d}'), { value: 'ab{d}', caret: 5 });
});

test('groupRows: серії рухів → «+N рухів»; showMoves — поштучно', () => {
  const subs = [{ type: 'move' }, { type: 'move' }, { type: 'click' }, { type: 'move' }, { type: 'text' }];
  assert.deepEqual(groupRows(subs, false), [
    { kind: 'moves', sis: [0, 1], count: 2 }, { kind: 'step', si: 2 }, { kind: 'moves', sis: [3], count: 1 }, { kind: 'step', si: 4 },
  ]);
  assert.equal(groupRows(subs, true).length, 5);
  assert.deepEqual(groupRows([], false), []);
});

test('moveStep: ↑↓ серед видимих (через приховані рухи)', () => {
  const A = { type: 'click', n: 'A' }, M = { type: 'move' }, B = { type: 'text', n: 'B' };
  let subs = [A, M, B];
  assert.equal(moveStep(subs, 2, -1, { hideMoves: true }), 0);
  assert.deepEqual(subs, [B, A, M]);
  subs = [A, M, B];
  assert.equal(moveStep(subs, 0, 1, { hideMoves: true }), 2);
  assert.deepEqual(subs, [M, B, A]);
  subs = [A, M, B];
  assert.equal(moveStep(subs, 0, 1), 1);
  assert.deepEqual(subs, [M, A, B]);
  assert.equal(moveStep(subs, 0, -1), -1);
  assert.equal(moveStep([A, M], 0, 1, { hideMoves: true }), -1);
});

test('pluralUk', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 112].map((n) => pluralUk(n, ['рух', 'рухи', 'рухів'])),
    ['рух', 'рухи', 'рухів', 'рухів', 'рух', 'рухи', 'рухів', 'рухів']);
});

// ---------- Запасний шлях (📍/🧲) у підсумку ----------
const locStep = { v: 2, type: 'click', target: { locs: [{ by: 'role', role: 'button', name: 'OK', n: 1 }], pick: 0 } };
test('isFallback: 📍 при робочому локаторі і 🧲 snap — деградація; «лише координати» за задумом — ні; loc-alt — ні', () => {
  assert.equal(isFallback(locStep, { ok: true, strategy: 'coord' }), true);
  assert.equal(isFallback(locStep, { ok: true, strategy: 'snap' }), true);
  assert.equal(isFallback({ type: 'click', x: 1, y: 2 }, { ok: true, strategy: 'coord' }), false); // legacy без target
  assert.equal(isFallback({ ...locStep, target: { ...locStep.target, pick: -1 } }, { ok: true, strategy: 'coord' }), false);
  assert.equal(isFallback({ type: 'click', x: 1, y: 2 }, { ok: true, strategy: 'snap' }), true);
  assert.equal(isFallback(locStep, { ok: true, strategy: 'loc-alt' }), false);
  assert.equal(isFallback(locStep, { ok: true, strategy: 'loc' }), false);
  assert.equal(isFallback(locStep, { ok: false, strategy: 'coord' }), false);
  assert.equal(isFallback(locStep, { ok: true, skipped: true, strategy: 'coord' }), false);
  assert.equal(isFallback(locStep, null), false);
});

function fbPlan() {
  const page = { id: 1, name: 'F', url: 'http://x', recs: [{ id: 1, name: 'Дія 1', subs: [{ ...locStep, id: 'a' }, { ...locStep, id: 'b' }, { type: 'click', x: 5, y: 5 }] }] };
  return { page, plan: createRunPlan(page) };
}
test('summarizeRun: запасний шлях → status degraded, лічильник і ⚠ у тексті; рядок позначено fallback', () => {
  const { page, plan } = fbPlan();
  applyRunEvent(plan, { event: 'done-action', index: 0, ok: true, strategy: 'coord' });
  applyRunEvent(plan, { event: 'done-action', index: 1, ok: true, strategy: 'loc' });
  applyRunEvent(plan, { event: 'done-action', index: 2, ok: true, strategy: 'coord' });
  const s = summarizeRun(plan, {});
  assert.equal(s.status, 'degraded');
  assert.equal(s.fallback, 1);
  assert.equal(s.ok, 3);
  assert.match(s.text, /^успішно 3, помилок 0, ⚠ запасним шляхом \(📍\/🧲\): 1$/);
  assert.equal(page.recs[0].subs[0].fallback, true);
  assert.equal(page.recs[0].subs[2].fallback, undefined);
  // Збій має пріоритет над деградацією.
  applyRunEvent(plan, { event: 'done-action', index: 1, ok: false, error: 'boom' });
  assert.equal(summarizeRun(plan, {}).status, 'failed');
  // Тимчасове поле не зберігається.
  assert.equal(pagePayload(page).recs[0].subs[0].fallback, undefined);
});

test('summarizeRun: помилка до першого кроку → «Не вдалося відкрити URL», без «помилок 0»; ANSI і Call log прибрано', () => {
  const { plan } = fbPlan();
  const raw = 'page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/\nCall log:\n  \x1b[2m - navigating to "http://127.0.0.1:1/"\x1b[22m';
  const s = summarizeRun(plan, { error: raw });
  assert.equal(s.status, 'error');
  assert.equal(s.text, 'Не вдалося відкрити URL: Сторінка недоступна (ERR_UNSAFE_PORT) — http://127.0.0.1:1/');
  assert.ok(!/помилок 0|\[2m|Call log/.test(s.text));
  // Помилка після кроків — лічильники лишаються, помилку дописано.
  applyRunEvent(plan, { event: 'done-action', index: 0, ok: true, strategy: 'loc' });
  assert.match(summarizeRun(plan, { error: 'обрив' }).text, /^успішно 1, помилок 0 · помилка: обрив$/);
});

test('runScenario: недоступний URL → setLive «Помилка «X» — Не вдалося відкрити URL: …» без суперечності', async () => {
  const { page } = fbPlan();
  state.pages = [page]; state.running = false; state.recording = false; state.run = null;
  const lives = [];
  const deps = {
    logLine: () => {}, logRunSep: () => {}, setLive: (t) => lives.push(t), addScreen: () => {}, ensureCurrentPreset: async () => 'x',
    api: { replay: async (_b, onEvent) => { onEvent({ event: 'error', message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://x/\nCall log:\n - nav' }); }, stopReplay: async () => ({}) },
  };
  const sum = await runScenario(page, undefined, { deps });
  assert.equal(sum.status, 'error');
  assert.match(lives.at(-1), /^Помилка «F» — Не вдалося відкрити URL: Сторінка недоступна \(ERR_CONNECTION_REFUSED\)/);
  assert.ok(!/помилок 0|Call log/.test(lives.at(-1)));
});

test('runScenario: підпис табу несе назву останньої Дії ланцюга (uptoName)', async () => {
  const { page } = fbPlan();
  page.recs[0].name = 'Дія 3';
  state.pages = [page]; state.running = false; state.recording = false; state.run = null;
  const screens = [];
  const deps = {
    logLine: () => {}, logRunSep: () => {}, setLive: () => {}, addScreen: (l, s, u, o) => screens.push(o), ensureCurrentPreset: async () => 'x',
    api: { replay: async (_b, onEvent) => { onEvent({ event: 'done-action', index: 0, ok: true, strategy: 'snap' }); onEvent({ event: 'done', actionsReplayed: 1, actionsTotal: 3, screenshot: 'data:s', url: 'http://x' }); }, stopReplay: async () => ({}) },
  };
  await runScenario(page, undefined, { deps });
  assert.equal(screens[0].uptoName, 'Дія 3');
  assert.equal(screens[0].degraded, 1);
});

// ---------- Назви Дій, undo, тости ----------
test('nextRecName: у межах сценарію (не глобальний лічильник); max+1; не менше recs.length+1', () => {
  assert.equal(nextRecName({ recs: [] }), 'Дія 1');
  assert.equal(nextRecName(null), 'Дія 1');
  assert.equal(nextRecName({ recs: [{ name: 'Дія 1' }, { name: 'Дія 5' }] }), 'Дія 6');
  assert.equal(nextRecName({ recs: [{ name: 'Логін' }, { name: 'Сабміт' }] }), 'Дія 3');
  assert.equal(nextRecName({ recs: [{ name: 'Дія 2' }] }), 'Дія 3');
  assert.equal(nextRecName({ recs: [{ name: ' Дія 4 ' }, { name: 'Дія 4б' }] }), 'Дія 5');
});

test('guardUndo: під час прогону/запису не викликає fn, повідомляє причину', () => {
  let busy = true, calls = 0, blocked = null;
  const fn = guardUndo(() => { calls++; return 'ok'; }, { isBusy: () => busy, onBlocked: (m) => { blocked = m; } });
  assert.equal(fn(), false);
  assert.equal(calls, 0);
  assert.equal(blocked, UNDO_BLOCKED);
  busy = false;
  assert.equal(fn(), 'ok');
  assert.equal(calls, 1);
});

test('createPausableTimer: пауза зберігає залишок, resume — не менше minResume', () => {
  let t = 0, fired = 0;
  const q = new Map(); let seq = 0;
  const opts = { now: () => t, setTimer: (f, ms) => { const id = ++seq; q.set(id, { f, at: t + ms }); return id; }, clearTimer: (id) => q.delete(id), minResume: 2000 };
  const run = (to) => { t = to; for (const [id, x] of [...q]) if (x.at <= t) { q.delete(id); x.f(); } };
  const tm = createPausableTimer(() => fired++, 10000, opts);
  tm.start();
  run(9000); tm.pause();
  assert.equal(tm.remaining, 1000);
  run(60000); assert.equal(fired, 0, 'на паузі не спрацьовує');
  tm.resume();
  run(61500); assert.equal(fired, 0, 'resume дає щонайменше 2 с');
  run(62000); assert.equal(fired, 1);
  tm.resume(); run(99999); assert.equal(fired, 1, 'вдруге не спрацьовує');
  const t2 = createPausableTimer(() => fired++, 0, opts); t2.start(); run(200000); assert.equal(fired, 1, 'timeout 0 — без таймера');
});

test('followRecordingRow: на десктопі при старті запису й на кожен новий крок — scrollIntoView останнього рядка; після ручної прокрутки — ні', () => {
  const calls = [];
  const li = (name) => ({ name, scrollIntoView: (o) => calls.push([name, o.block]) });
  let rows = [li('r1')];
  const recEl = { scrollIntoView: () => calls.push(['rec']), querySelector: (sel) => (sel === '.subs li:last-child' ? rows.at(-1) || null : sel === '.subs li.pending' ? null : null) };
  const root = { querySelector: (sel) => (sel === '.rec.rec-on' ? recEl : null) };
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  const rec = { id: 1, subs: [{}] };
  try {
    state.recording = true; state.curRec = rec;
    followRecordingRow(root);
    assert.deepEqual(calls, [['r1', 'nearest']], 'старт запису');
    followRecordingRow(root);
    assert.equal(calls.length, 1, 'без змін — без прокрутки');
    rec.subs.push({}); rows.push(li('r2'));
    followRecordingRow(root);
    assert.deepEqual(calls.at(-1), ['r2', 'nearest'], 'новий крок');
    followRec.manual = true;
    rec.subs.push({}); rows.push(li('r3'));
    followRecordingRow(root);
    assert.equal(calls.length, 2, 'користувач гортає сам — не тягнемо');
    // Вузький екран — нічого (список в іншій панелі).
    globalThis.matchMedia = () => ({ matches: false });
    followRec.manual = false; rec.subs.push({}); rows.push(li('r4'));
    followRecordingRow(root);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.matchMedia = mm;
    state.recording = false; state.curRec = null;
    followRecordingRow(root);
  }
});

// ---------- Пауза після кроку в редакторі ----------
test('editorValues/applyEdit: delayAfter — показ, збереження, очищення, валідація', () => {
  const st = { id: 's', v: 2, type: 'click', x: 1, y: 2 };
  assert.equal(editorValues(st).delayAfter, '');
  assert.equal(editorValues({ ...st, delayAfter: 800 }).delayAfter, '800');
  assert.equal(applyEdit(st, { delayAfter: '1500' }).step.delayAfter, 1500);
  assert.equal(applyEdit({ ...st, delayAfter: 800 }, { delayAfter: '' }).step.delayAfter, undefined, 'порожнє → прибрати');
  assert.equal(applyEdit({ ...st, delayAfter: 800 }, { delayAfter: '0' }).step.delayAfter, undefined, '0 → прибрати');
  for (const bad of ['-5', '1.5', 'abc', '60001']) {
    const r = applyEdit(st, { delayAfter: bad });
    assert.equal(r.step, null, bad);
    assert.match(r.errors.delayAfter, /Пауза/);
  }
  assert.equal(applyEdit(st, { delayAfter: '60000' }).step.delayAfter, 60000);
  // без поля delayAfter у values — не чіпаємо
  assert.equal(applyEdit({ ...st, delayAfter: 300 }, { optional: true }).step.delayAfter, 300);
  // legacy-літера: пауза зберігається, а сам крок лишається legacy (злиття працює)
  const leg = { type: 'text', text: 'a' };
  const r = applyEdit(leg, { text: 'a', delayAfter: '400' });
  assert.equal(r.step.delayAfter, 400);
  assert.equal(r.step.v, undefined);
});
