// runner.js — прогін сценарію через POST /replay (NDJSON-стрім) і його відображення.
// ЧИСТІ частини (тестуються в node:test):
//   createRunPlan(page, uptoRecId, {skipMoves}) — план через спільний flattenScenario
//       (/lib/steps.js: злиття legacy-тексту, gid, пропуск рухів) + скидання тимчасових
//       полів під-дій і прогрес Дій; map[i].subIdxs — які рядки сайдбару оновлює крок i;
//   applyRunEvent(plan, ev) — 'action'/'done-action' → status/strategy/ms/healed/error/failShot;
//       'pause' (⏱ пауза після кроку) → plan.pause = {index, ms} + a.pausing (до наступного 'action');
//   summarizeRun(plan, {done, error, stopped}) — підсумок «успішно N, помилок M (крок K: …)»;
//       кроки, що пройшли ЗАПАСНИМ шляхом (📍 координати при наявному локаторі / 🧲 snap) —
//       окремий лічильник fallback і статус 'degraded' (⚠, а не чистий ✓); помилка до
//       першого кроку → «Не вдалося відкрити URL: …» (без суперечливого «помилок 0»);
//   isFallback(step, result) — чи крок пройшов запасним шляхом;
//   strategyBadge(strategy, ms) — бейдж стратегії (🎯 loc / 🔁 loc-alt / #nth / 📍 coord / 🧲 snap · мс);
//   finishRun(page, plan) — скинути прапорці прогону.
// ІМПУРНІ: runScenario(page, uptoRecId, opts) і stopRun() — стан у state.run, події 'busy'/'pages'.
// Під час імпорту DOM не чіпається.
import { flattenScenario, stepLabel, formatDelay, applyTargetUpgrade } from '../../lib/steps.js';
import { specToString } from '../../lib/locators.js';
import { cleanError, humanError } from '../../lib/errText.js';
import { state, emit, isBusy } from './state.js';
import { pluralUk } from './stepEditor.js';

const RUN_FIELDS = ['status', 'strategy', 'ms', 'error', 'failShot', 'healed', 'fallback', 'pausing'];

// Крок мав робочий локатор (target.pick ≥ 0), а пройшов за координатами — це деградація.
// Кроки «лише координати» (legacy без target, pick = -1, рухи) — 'coord' за задумом.
const hadLocator = (step) => !!(step && step.target && Array.isArray(step.target.locs)
  && step.target.pick >= 0 && step.target.locs[step.target.pick]);
export function isFallback(step, r) {
  if (!r || !r.ok || r.skipped) return false;
  return r.strategy === 'snap' || (r.strategy === 'coord' && hadLocator(step));
}
const clearRunFields = (a) => { if (a && typeof a === 'object') for (const k of RUN_FIELDS) delete a[k]; };
// Пауза після кроку закінчилась (почався наступний крок / кінець прогону).
function clearPause(plan) {
  const p = plan && plan.pause;
  if (!p) return;
  const m = plan.map[p.index];
  for (const si of (m && m.subIdxs) || []) { const a = m.rec.subs[si]; if (a && typeof a === 'object') delete a.pausing; }
  plan.pause = null;
}

// План прогону. Мутує ЛИШЕ UI-поля (status… під-дій, running/runCur/runTotal Дій).
// Невідома Дія → throw (а не тихий порожній прогін).
export function createRunPlan(page, uptoRecId, { skipMoves = true } = {}) {
  const fl = flattenScenario(page, uptoRecId, { skipMoves });
  const byId = new Map((page.recs || []).map((r) => [String(r.id), r]));
  const recs = fl.recs.map((ri) => byId.get(String(ri.recId)));
  for (const rec of recs) {
    rec.running = true;
    rec.runCur = 0;
    for (const a of rec.subs || []) { clearRunFields(a); if (a && typeof a === 'object') a.status = 'idle'; }
  }
  for (const s of fl.skipped) {
    const a = (byId.get(String(s.recId)).subs || [])[s.si];
    if (a && typeof a === 'object') a.status = 'skipped';
  }
  for (const ri of fl.recs) byId.get(String(ri.recId)).runTotal = ri.total;
  const map = fl.map.map((m) => ({ rec: byId.get(String(m.recId)), subIdxs: m.subIdxs, recPos: m.recPos }));
  return { flat: fl.flat, map, recs, total: fl.flat.length, results: new Array(fl.flat.length).fill(null) };
}

// Подія стріму → стан рядків. Повертає {rec, subs, index, result?} або null.
export function applyRunEvent(plan, ev) {
  if (!plan || !ev || (ev.event !== 'action' && ev.event !== 'done-action' && ev.event !== 'pause')) return null;
  const m = plan.map[ev.index];
  if (!m) return null;
  const subs = m.subIdxs.map((si) => m.rec.subs[si]).filter((a) => a && typeof a === 'object');
  if (ev.event === 'pause') {
    clearPause(plan);
    const ms = Number.isFinite(ev.ms) ? ev.ms : 0;
    plan.pause = { index: ev.index, ms };
    if (subs[0]) subs[0].pausing = true;
    return { rec: m.rec, subs, index: ev.index, pause: ms };
  }
  if (ev.event === 'action') {
    clearPause(plan);
    subs.forEach((a) => { a.status = 'running'; });
    m.rec.runCur = m.recPos;
    return { rec: m.rec, subs, index: ev.index };
  }
  const failed = !ev.ok && !ev.aborted;
  const st = ev.aborted || ev.skipped ? 'skipped' : ev.ok ? 'done' : 'failed';
  const result = {
    ok: !!ev.ok, skipped: !!ev.skipped, aborted: !!ev.aborted, failed,
    error: ev.error ? String(ev.error) : null, strategy: ev.strategy || null,
    ms: Number.isFinite(ev.ms) ? ev.ms : null, healed: !!ev.healed,
  };
  result.fallback = isFallback(plan.flat && plan.flat[ev.index], result);
  plan.results[ev.index] = result;
  subs.forEach((a, k) => {
    clearRunFields(a);
    a.status = st;
    if (result.strategy && !result.skipped) a.strategy = result.strategy;
    if (result.ms != null && !result.skipped) a.ms = result.ms;
    if (result.healed) a.healed = true;
    if (result.fallback) a.fallback = true;
    if (failed && result.error) a.error = result.error;
    if (result.skipped && result.error && !ev.aborted) a.error = result.error; // напр. необовʼязковий
    if (failed && ev.failShot && k === 0) a.failShot = ev.failShot; // знімок — лише на першому рядку злитого кроку
  });
  // Покращення цілі (той самий елемент, унікальний надійний локатор): оновлюємо збережений
  // крок — ⚠ стає 🎯 без перезапису. Лише для кроку з однієї під-дії (злитий текст не чіпаємо).
  const fl = plan.flat && plan.flat[ev.index];
  if (ev.upgrade && ev.ok && subs.length === 1 && m.subIdxs.length === 1 && fl && fl.target) {
    const t = applyTargetUpgrade(fl.target, ev.upgrade.idx);
    if (t) {
      subs[0].target = t;
      fl.target = t;
      result.upgraded = specToString(t.locs[t.pick]);
      plan.upgraded = (plan.upgraded || 0) + 1;
    }
  }
  return { rec: m.rec, subs, index: ev.index, result };
}

export function finishRun(page, plan) {
  if (page) page.running = false;
  clearPause(plan);
  for (const r of (plan && plan.recs) || []) {
    r.running = false;
    // Перерваний прогін: «▶» на кроці, що не встиг завершитись, → ⏭; «idle» → без бейджа.
    for (const a of r.subs || []) {
      if (!a || typeof a !== 'object') continue;
      if (a.status === 'running') a.status = 'skipped';
      else if (a.status === 'idle') delete a.status;
    }
  }
}

const trimErr = (s, max = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

// Підсумок прогону. done — подія 'done' (або null), error — повідомлення 'error' (або null).
export function summarizeRun(plan, { done = null, error = null, stopped = false } = {}) {
  const res = (plan && plan.results) || [];
  let ok = 0, failed = 0, skipped = 0, healed = 0, fallback = 0, firstFail = null;
  res.forEach((r, i) => {
    if (!r) return;
    if (r.failed) {
      failed++;
      if (!firstFail) {
        const m = plan.map[i];
        // Номер кроку — як у рядку сайдбару (позиція під-дії в Дії), а не в пласкому списку.
        firstFail = { index: i, step: m && m.subIdxs && m.subIdxs.length ? m.subIdxs[0] + 1 : i + 1, recName: m && m.rec ? m.rec.name : '', label: stepLabel(plan.flat[i]), error: cleanError(r.error) || 'помилка' };
      }
    } else if (r.skipped || r.aborted) skipped++;
    else if (r.ok) { ok++; if (r.fallback) fallback++; }
    if (r.healed) healed++;
  });
  const total = plan ? plan.total : 0;
  const isStopped = !!(stopped || (done && done.stopped));
  const ms = done && done.timing && done.timing.totalMs;
  const ran = res.filter(Boolean).length;
  const err = error ? humanError(error) : null;
  let text;
  if (err && !ran) {
    // Нічого не виконалось (напр. URL недоступний) — без «успішно 0, помилок 0».
    text = 'Не вдалося відкрити URL: ' + err;
  } else {
    text = 'успішно ' + ok + ', помилок ' + failed;
    if (firstFail) text += ' (крок ' + firstFail.step + (firstFail.recName ? ' у «' + firstFail.recName + '»' : '') + ': ' + trimErr(firstFail.error) + ')';
    if (fallback) text += ', ⚠ запасним шляхом (📍/🧲): ' + fallback;
    if (skipped) text += ', пропущено ' + skipped;
    if (healed) text += ', 🔁 виправлено локаторів: ' + healed;
    const notRun = total - ran;
    if (isStopped && notRun > 0) text += ', не виконано ' + notRun;
    if (err) text += ' · помилка: ' + err;
  }
  return {
    ok, failed, skipped, healed, fallback, total, firstFail, stopped: isStopped,
    error: err, ms: Number.isFinite(ms) ? ms : null,
    replayed: done ? done.actionsReplayed : ok,
    text,
    status: err ? 'error' : failed ? 'failed' : isStopped ? 'stopped' : fallback ? 'degraded' : 'ok',
  };
}

// Бейдж стратегії, якою знайдено ціль кроку.
const STRATEGIES = {
  loc: { icon: '🎯', name: 'локатор', title: 'Знайдено основним локатором' },
  'loc-alt': { icon: '🔁', name: 'alt', title: 'Основний локатор не спрацював — знайдено альтернативним' },
  nth: { icon: '#', name: 'nth', title: 'Кілька збігів — обрано найближчий до записаного місця' },
  coord: { icon: '📍', name: 'коорд.', title: 'Клік за записаними координатами' },
  snap: { icon: '🧲', name: 'snap', title: 'Під точкою було порожньо — притягнуто до найближчого контрола' },
};
export function strategyBadge(strategy, ms) {
  if (!strategy && !Number.isFinite(ms)) return null;
  const s = STRATEGIES[strategy] || null;
  const t = Number.isFinite(ms) ? (ms >= 10000 ? (ms / 1000).toFixed(1) + ' с' : Math.round(ms) + ' мс') : '';
  const text = (s ? s.icon + (strategy === 'nth' ? 'nth' : '') : '') + (s && t ? ' · ' : '') + t;
  return { cls: 'strat-' + (strategy || 'none'), text, title: (s ? s.title : 'Тривалість кроку') + (t ? ' — ' + t : '') };
}

// ---------- Імпурна частина ----------
// deps інʼєктуються (тести / інші викликачі); за замовчуванням — модулі UI.
let defaultDeps = null;
async function getDefaultDeps() {
  if (defaultDeps) return defaultDeps;
  const [{ api }, log, viewer, config] = await Promise.all([
    import('./api.js'), import('./log.js'), import('./viewer.js'), import('./config.js'),
  ]);
  defaultDeps = {
    api, logLine: log.logLine, logRunSep: log.logRunSep, setLive: log.setLive,
    addScreen: viewer.addScreen, ensureCurrentPreset: config.ensureCurrentPreset,
  };
  return defaultDeps;
}

// Прогін сценарію (або до Дії uptoRecId включно). Повертає підсумок summarizeRun або null.
export async function runScenario(page, uptoRecId, { skipMoves = true, deps } = {}) {
  if (!page || isBusy()) return null;
  const d = deps || await getDefaultDeps();
  let plan;
  try { plan = createRunPlan(page, uptoRecId, { skipMoves }); }
  catch (e) { d.setLive('Помилка: ' + e.message, false); return null; }

  const ac = new AbortController();
  const t0 = Date.now();
  state.running = true; page.running = true;
  state.run = { pageId: page.id, runId: null, ac, stopping: false, plan, startedAt: t0 };
  delete page.lastRun;
  emit('busy'); emit('pages');
  d.logRunSep('Старт «' + page.name + '» — ' + plan.recs.length + ' ' + pluralUk(plan.recs.length, ['Дія', 'Дії', 'Дій']) + ', '
    + plan.total + ' ' + pluralUk(plan.total, ['крок', 'кроки', 'кроків']) + (plan.total ? '' : ' (лише відкриття URL)'));
  try { d.logLine('info', '⚙ Пресет: ' + await d.ensureCurrentPreset()); } catch (_e) { /* не критично */ }
  d.setLive(plan.total ? '«' + page.name + '»: відкриваю стартову сторінку…' : 'Відкриваю «' + page.name + '»…', true);

  // Підпис табу результату: «Сценарій · до Дії N» / «· усі Дії (N)» / «· лише URL».
  const recs = page.recs || [];
  const uptoIdx = uptoRecId != null ? recs.findIndex((r) => String(r.id) === String(uptoRecId)) : recs.length - 1;
  const ctx = { done: null, error: null, meta: { scenario: page.name, upto: uptoIdx + 1, total: recs.length, uptoName: uptoIdx >= 0 ? recs[uptoIdx].name : '' } };
  const onEvent = (ev) => handleEvent(d, page, plan, ctx, ev);
  try {
    await d.api.replay({ url: page.url, actions: plan.flat }, onEvent, { signal: ac.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') ctx.aborted = true;
    else { ctx.error = humanError(err) || 'помилка'; d.logLine('error', '❌ ' + ctx.error); }
  } finally {
    const stopped = !!(state.run && state.run.stopping) || !!ctx.aborted;
    state.running = false; state.run = null;
    finishRun(page, plan);
    if (plan.upgraded) {
      d.logLine('info', '🎯 Надійнішу ціль отримали ' + plan.upgraded + ' ' + pluralUk(plan.upgraded, ['крок', 'кроки', 'кроків']) + ' — сценарій збережено.');
      emit('page:changed', { page, pageId: page.id, reason: 'upgrade' });
    }
    const sum = summarizeRun(plan, { done: ctx.done, error: ctx.error, stopped });
    if (!sum.ms) sum.ms = Date.now() - t0;
    page.lastRun = sum;
    let head;
    if (ctx.done) head = '«' + page.name + '» виконано ' + ctx.done.actionsReplayed + '/' + ctx.done.actionsTotal + ' — ';
    else if (ctx.aborted) head = 'Прогін «' + page.name + '» перервано — ';
    else if (ctx.error) head = 'Помилка «' + page.name + '» — ';
    else head = 'Прогін «' + page.name + '» завершився без результату — ';
    d.setLive(head + sum.text + (sum.stopped && ctx.done ? ' (зупинено)' : '') + ' за ' + (sum.ms / 1000).toFixed(1) + ' с.', false);
    d.logLine(sum.failed || ctx.error || sum.fallback ? 'warn' : 'info', '🏁 Підсумок: ' + sum.text);
    emit('busy'); emit('pages');
    emit('run:finished', { page, summary: sum, screen: !!ctx.screen });
  }
  return page.lastRun;
}

function handleEvent(d, page, plan, ctx, ev) {
  switch (ev.event) {
    case 'run': if (state.run) state.run.runId = ev.runId; emit('pages'); break;
    case 'log': d.logLine(ev.kind, ev.text); break;
    case 'status':
    case 'opened': d.setLive('«' + page.name + '»: ' + (ev.text || '…'), true); break;
    case 'action': {
      const r = applyRunEvent(plan, ev);
      if (r) {
        d.setLive('«' + r.rec.name + '» — крок ' + (ev.index + 1) + '/' + plan.total + ': ' + stepLabel(plan.flat[ev.index]), true);
        emit('pages');
      }
      break;
    }
    case 'pause': {
      const r = applyRunEvent(plan, ev);
      if (r) {
        d.setLive('«' + r.rec.name + '» — ⏱ пауза ' + formatDelay(r.pause, { plus: false }) + ' після кроку ' + (ev.index + 1) + '/' + plan.total, true);
        emit('pages');
      }
      break;
    }
    case 'done-action': {
      const r = applyRunEvent(plan, ev);
      if (r) {
        if (r.result.failed) d.logLine('error', '✗ «' + r.rec.name + '», крок ' + (plan.map[ev.index].subIdxs[0] + 1) + ' (' + stepLabel(plan.flat[ev.index]) + '): ' + (cleanError(r.result.error) || 'помилка'));
        else if (r.result.fallback) d.logLine('warn', '⚠️ «' + r.rec.name + '», крок ' + (plan.map[ev.index].subIdxs[0] + 1) + ' (' + stepLabel(plan.flat[ev.index]) + '): локатор не спрацював — пройдено запасним шляхом (' + (r.result.strategy === 'snap' ? '🧲 snap' : '📍 координати') + ')');
        emit('pages');
      }
      break;
    }
    case 'done':
      ctx.done = ev;
      if (ev.screenshot) {
        ctx.screen = true;
        d.addScreen('🎬 ' + page.name + ' (' + ev.actionsReplayed + '/' + ev.actionsTotal + ')' + (ev.stopped ? ' ⏹' : ''), ev.screenshot, ev.url,
          { ...ctx.meta, ok: !plan.results.some((x) => x && x.failed), stopped: !!ev.stopped, failed: plan.results.filter((x) => x && x.failed).length,
            degraded: plan.results.filter((x) => x && x.fallback).length });
      }
      break;
    case 'error':
      ctx.error = humanError(ev.message) || 'помилка';
      d.logLine(ev.stopped ? 'warn' : 'error', (ev.stopped ? '⏹ ' : '❌ ') + ctx.error);
      if (ev.stopped) { ctx.error = null; ctx.aborted = true; }
      break;
    case 'parse-error': d.logLine('warn', '⚠️ Нерозбірний рядок стріму: ' + String(ev.line).slice(0, 200)); break;
    default: break;
  }
}

// ⏹ Стоп: штатна зупинка через сервер (фінальний скрін буде); якщо runId ще немає
// або сервер не відповів — обриваємо fetch (сервер закриє контекст сам).
export async function stopRun({ deps } = {}) {
  const run = state.run;
  if (!run || run.stopping) return false;
  run.stopping = true;
  emit('pages');
  const d = deps || await getDefaultDeps();
  d.setLive('Зупиняю прогін…', true);
  if (!run.runId) { run.ac.abort(); return true; }
  try { await d.api.stopReplay(run.runId); }
  catch (e) { d.logLine('warn', '⚠️ Stop: ' + e.message + ' — обриваю зʼєднання.'); run.ac.abort(); }
  return true;
}
