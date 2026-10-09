// Експорт/імпорт ПРЕСЕТІВ і СЦЕНАРІЇВ (файл-бандл JSON, формат — lib/transfer.js).
//
// GET  /export?presets=<id,id|all>&pages=<id,id|all>&files=0|1
//   → бандл (attachment stealth-bundle-<…>-<дата>.json). Без обох параметрів — усе.
//   Порожній/відсутній параметр (коли інший задано) — нічого цього типу. Невідомі id — просто не
//   потрапляють. files=1 (за замовч.) — вміст файлів кроків type:'file' (base64, сумарно
//   ≤ EXPORT_FILES_MAX_BYTES; більше → data:null, skipped:'too_large'; немає на диску → missing:true);
//   files=0 → data:null, skipped:'excluded'. Профіль/cookies НЕ експортуються.
// POST /import { bundle, select?, onConflict?, dryRun? }
//   Сервер авторитетно перевалідовує бандл (parseBundle) і будує план проти ПОТОЧНОГО стану
//   (planImport): однаковий зміст → пропуск; конфлікт назви → rename (за замовч.) | replace | skip.
//   Файли кроків клієнт завантажує сам через /upload і робить remapFileRefs ДО цього запиту;
//   files[].data тут ігнорується.
import fs from 'fs';
import express from 'express';
import { asyncHandler, httpError } from '../lib/http.js';
import { resolveUpload } from '../lib/uploads.js';
import {
  CONFLICT_STRATEGIES, buildBundle, parseBundle, planImport, collectFileRefs, summarizeImport, bundleFilename,
  planProxy, proxyImportPatch,
} from '../lib/transfer.js';
import { applyProfilePatch } from '../lib/profile.js';
import { proxyLabel } from '../lib/proxy.js';
import { humanError } from '../lib/errText.js';

export const IMPORT_PATH = '/import';
export const DEFAULT_EXPORT_FILES_MAX_BYTES = 50 * 1024 * 1024;

// '1,2, 3' → [1,2,3]; 'all' → 'all'; undefined/'' → []. Сміття → null.
export function parseIdList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) v = v.join(',');
  const s = String(v).trim();
  if (!s) return [];
  if (s.toLowerCase() === 'all') return 'all';
  const out = [];
  for (const tok of s.split(',')) {
    const t = tok.trim();
    if (!t) continue;
    if (!/^\d{1,16}$/.test(t)) return null;
    out.push(Number(t));
  }
  return out;
}

const pick = (list, ids) => (ids === 'all' ? list : list.filter((x) => ids.includes(Number(x.id))));

// Вміст файлів кроків → записи бандла. exists/readFile/stat — інʼєкція для тестів не потрібна:
// тести працюють зі справжньою tmp-текою UPLOAD_DIR.
async function readFiles(refs, { uploadDir, maxBytes, include }) {
  const files = [];
  let total = 0;
  for (const ref of refs) {
    const entry = { fileId: ref.fileId, filename: ref.filename, size: 0, data: null };
    const p = resolveUpload(uploadDir, ref.fileId, ref.filename);
    if (!p) { files.push({ ...entry, missing: true }); continue; }
    let size = 0;
    try { size = (await fs.promises.stat(p)).size; } catch (_e) { files.push({ ...entry, missing: true }); continue; }
    entry.size = size;
    if (!include) { files.push({ ...entry, skipped: 'excluded' }); continue; }
    if (total + size > maxBytes) { files.push({ ...entry, skipped: 'too_large' }); continue; }
    try {
      const buf = await fs.promises.readFile(p);
      total += buf.length;
      files.push({ ...entry, size: buf.length, data: buf.toString('base64') });
    } catch (_e) {
      files.push({ ...entry, missing: true });
    }
  }
  return files;
}

// select.presets / select.scenarios: масив цілих індексів ≥ 0 або відсутнє (= усі). Сміття → помилка.
function parseSelect(sel) {
  if (sel === undefined || sel === null) return {};
  if (typeof sel !== 'object' || Array.isArray(sel)) return { error: 'Вибір (select) має бути обʼєктом {presets?, scenarios?, proxy?}' };
  const out = {};
  if (sel.proxy !== undefined && sel.proxy !== null) {
    if (typeof sel.proxy !== 'boolean') return { error: 'Вибір (select.proxy) має бути true або false' };
    out.proxy = sel.proxy;
  }
  for (const k of ['presets', 'scenarios']) {
    if (sel[k] === undefined || sel[k] === null) continue;
    if (!Array.isArray(sel[k]) || !sel[k].every((i) => Number.isInteger(i) && i >= 0)) {
      return { error: 'Вибір (select.' + k + ') має бути масивом індексів — цілих ≥ 0' };
    }
    out[k] = new Set(sel[k]);
  }
  return out;
}

function parseOnConflict(v) {
  if (v === undefined || v === null) return { presets: 'rename', scenarios: 'rename' };
  if (typeof v !== 'object' || Array.isArray(v)) return { error: 'Стратегія конфліктів (onConflict) має бути обʼєктом {presets?, scenarios?}' };
  const out = {};
  for (const k of ['presets', 'scenarios']) {
    const s = v[k] === undefined || v[k] === null ? 'rename' : v[k];
    if (!CONFLICT_STRATEGIES.includes(s)) return { error: 'Невідома стратегія конфліктів (onConflict.' + k + ') — очікується ' + CONFLICT_STRATEGIES.join(' | ') };
    out[k] = s;
  }
  return out;
}

const maxNum = (nums) => nums.reduce((m, n) => (Number.isFinite(n) && n > m ? n : m), 0);

// profileStore/engine — для проксі (глобальний експорт переносить його окремо від пресетів, з паролем).
export function transferRoutes({ config, getDb, pagesMem, profileStore = null, engine = null, log = console }) {
  const r = express.Router();
  const mem = pagesMem || new Map();
  const uploadDir = config.UPLOAD_DIR;
  const maxBytes = Number(config.EXPORT_FILES_MAX_BYTES) || DEFAULT_EXPORT_FILES_MAX_BYTES;
  const listPages = async (db) => (db ? db.pages.list() : [...mem.values()].sort((a, b) => a.id - b.id));

  // Імпорти — строго по черзі: план будується проти стану, який не змінить паралельний імпорт.
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  r.get('/export', asyncHandler(async (req, res) => {
    const q = req.query || {};
    const none = q.presets === undefined && q.pages === undefined;
    const presetIds = none ? 'all' : parseIdList(q.presets);
    const pageIds = none ? 'all' : parseIdList(q.pages);
    if (presetIds === null) throw httpError(400, 'Параметр presets — очікується список id через кому або all');
    if (pageIds === null) throw httpError(400, 'Параметр pages — очікується список id через кому або all');
    const files = String(q.files === undefined ? '1' : q.files);
    if (files !== '0' && files !== '1') throw httpError(400, 'Параметр files — очікується 0 або 1');
    // proxy=1 — додати проксі (усі налаштування, з логіном і паролем). Без presets/pages («усе») — теж.
    const proxyQ = String(q.proxy === undefined ? (none ? '1' : '0') : q.proxy);
    if (proxyQ !== '0' && proxyQ !== '1') throw httpError(400, 'Параметр proxy — очікується 0 або 1');

    const db = getDb();
    const presets = db && (presetIds === 'all' || presetIds.length) ? pick(await db.presets.list(), presetIds) : [];
    const pages = pageIds === 'all' || pageIds.length ? pick(await listPages(db), pageIds) : [];
    const proxy = proxyQ === '1' && profileStore ? profileStore.get().proxy : null;
    const bundle = buildBundle({ presets, scenarios: pages, proxy });
    bundle.files = await readFiles(collectFileRefs(bundle.scenarios), { uploadDir, maxBytes, include: files === '1' });

    const { filename, asciiFilename } = bundleFilename(bundle);
    res.set('Content-Disposition', 'attachment; filename="' + asciiFilename + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
    res.type('application/json; charset=utf-8');
    res.send(JSON.stringify(bundle, null, 2));
  }));

  // Власний парсер із більшим лімітом (глобальний express.json цей шлях пропускає — lib/app.js).
  const importJson = express.json({ limit: config.IMPORT_JSON_LIMIT || '20mb' });
  const parseImportBody = (req, res, next) => importJson(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(httpError(413, 'Файл імпорту завеликий (ліміт ' + (config.IMPORT_JSON_LIMIT || '20mb') + ')'));
    if (err.status === 400 || err.type === 'entity.parse.failed') return next(httpError(400, 'Тіло запиту — некоректний JSON'));
    next(err);
  });

  r.post(IMPORT_PATH, parseImportBody, asyncHandler(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (body.bundle === undefined || body.bundle === null) throw httpError(400, 'Немає даних для імпорту (bundle)');
    const parsed = parseBundle(body.bundle);
    if (!parsed.ok) throw httpError(400, parsed.error);
    const sel = parseSelect(body.select);
    if (sel.error) throw httpError(400, sel.error);
    const strat = parseOnConflict(body.onConflict);
    if (strat.error) throw httpError(400, strat.error);
    const dryRun = body.dryRun === true;

    const result = await serial(() => runImport(parsed, sel, strat, dryRun));
    res.json(result);
  }));

  async function runImport(parsed, sel, strat, dryRun) {
    const db = getDb();
    const { bundle } = parsed;
    const warnings = [...parsed.warnings];

    // Вибрані елементи з їхніми ІНДЕКСАМИ в бандлі (index у плані — індекс у бандлі).
    const chosen = (list, set) => list.map((item, index) => ({ item, index })).filter((x) => !set || set.has(x.index));
    const selPresets = chosen(bundle.presets, sel.presets);
    const selScenarios = chosen(bundle.scenarios, sel.scenarios);
    const withBundleIndex = (plan, sel2) => plan.map((p) => ({ ...p, index: sel2[p.index].index }));

    // --- Пресети ---
    let presetPlan;
    if (!db) {
      presetPlan = selPresets.map(({ item, index }) => ({ index, action: 'skip', name: item.name, originalName: item.name, reason: 'no_db' }));
      if (presetPlan.length) warnings.push('БД недоступна — пресети не імпортовано');
    } else {
      const existing = selPresets.length ? await db.presets.list() : [];
      presetPlan = withBundleIndex(planImport(existing, selPresets.map((x) => x.item), { onConflict: strat.presets, kind: 'presets' }), selPresets);
    }

    // --- Сценарії ---
    const existingPages = selScenarios.length ? await listPages(db) : [];
    const scenarioPlan = withBundleIndex(planImport(existingPages, selScenarios.map((x) => x.item), { onConflict: strat.scenarios, kind: 'scenarios' }), selScenarios);

    // Файли кроків, яких немає на цьому сервері (клієнт не завантажив/не вкладено) — попередження.
    const seenMissing = new Set();
    for (const p of scenarioPlan) {
      if (p.action === 'skip') continue;
      for (const ref of collectFileRefs([bundle.scenarios[p.index]])) {
        if (seenMissing.has(ref.fileId) || resolveUpload(uploadDir, ref.fileId, ref.filename)) continue;
        seenMissing.add(ref.fileId);
        warnings.push('Сценарій «' + p.name + '»: файл «' + (ref.filename || ref.fileId) + '» відсутній на сервері — крок файлу потребуватиме перевибору файлу');
      }
    }

    if (!dryRun) {
      // Спершу — усі записи сценаріїв (без побічних ефектів), потім запис ОДНІЄЮ транзакцією (db.tx):
      // збій посередині не лишає частково імпортованих даних. Без БД — у памʼять лише після побудови всіх.
      let nextPageId = Math.max(maxNum(existingPages.map((x) => Number(x.id))) + 1, Date.now());
      let recId = maxNum(existingPages.flatMap((x) => (Array.isArray(x.recs) ? x.recs : []).map((rec) => Number(rec && rec.id))));
      const pageWrites = [];
      for (const p of scenarioPlan) {
        if (p.action === 'skip') continue;
        const src = bundle.scenarios[p.index];
        const id = p.action === 'replace' ? Number(p.targetId) : nextPageId++;
        pageWrites.push({ p, id, page: { name: p.name, url: src.url, recs: src.recs.map((rec) => ({ id: ++recId, name: rec.name, subs: rec.subs })) } });
      }
      const presetIds = new Map(); // план → {id, action}: застосовуємо до звіту лише після успішного запису
      const write = async (repo) => {
        for (const p of presetPlan) {
          if (p.action === 'skip') continue;
          const { body } = bundle.presets[p.index];
          if (p.action === 'replace' && await repo.presets.update(p.targetId, { name: p.name, body })) { presetIds.set(p, { id: p.targetId, action: 'replace' }); continue; }
          // replace, чия ціль зникла між планом і записом, → create
          presetIds.set(p, { id: await repo.presets.create({ name: p.name, body }), action: 'create' });
        }
        for (const w of pageWrites) await repo.pages.upsert(w.id, w.page);
      };
      if (db) await (typeof db.tx === 'function' ? db.tx(write) : write(db));
      else for (const w of pageWrites) mem.set(w.id, { id: w.id, ...w.page });
      for (const [p, r] of presetIds) { p.id = r.id; if (r.action !== p.action) { p.action = r.action; delete p.targetId; } }
      for (const w of pageWrites) w.p.id = w.id;
    } // dryRun — нічого не пишемо (ні в БД, ні в памʼять).

    // Проксі — ПІСЛЯ успішного запису пресетів/сценаріїв (збій вище → проксі не чіпаємо).
    // Звіт без пароля: лише підпис. Зміна проксі = перезапуск браузера (як POST /profile).
    let proxyPlan = null;
    if (bundle.proxy) {
      if (!profileStore) {
        proxyPlan = { action: 'skip', reason: 'unavailable' };
      } else {
        proxyPlan = planProxy(profileStore.get().proxy, bundle.proxy, { selected: sel.proxy !== false });
        proxyPlan.label = proxyLabel(bundle.proxy);
        if (!dryRun && proxyPlan.action !== 'skip') {
          const { profile, launchChanged, proxyWarning } = applyProfilePatch(profileStore.get(), { proxy: proxyImportPatch(bundle.proxy) });
          profileStore.set(profile);
          profileStore.save();
          if (proxyWarning) warnings.push('Проксі: ' + proxyWarning);
          if (launchChanged && engine) {
            try { await engine.relaunchBrowser(); proxyPlan.relaunched = true; }
            catch (e) { warnings.push('Проксі застосовано, але браузер не перезапустився: ' + humanError(e)); }
          }
        }
      }
    }

    const report = { presets: presetPlan, scenarios: scenarioPlan, proxy: proxyPlan };
    const summary = summarizeImport(report);
    if (!dryRun) log.log('📥 Імпорт: ' + summary);
    return { ok: true, dryRun, db: !!db, presets: presetPlan, scenarios: scenarioPlan, proxy: proxyPlan, warnings, summary };
  }

  return r;
}
