// Живі сесії запису (synth.md §4): сервер тримає відкриту сторінку, клієнт бачить
// viewport-скриншоти (опитування за хешем) і шле дії (клік/текст/клавіша/скрол/
// файл/список). Кожна записана дія повертає крок v2 з семантичною ціллю (target)
// + координати документа (x, y, sw, sh), тож старі шляхи теж уміють його відтворити.
//
// Ресурси сесії: слот семафора (acquire ≤15 с) + власний контекст (НЕ з пулу —
// drainPool її не чіпає). Закриття — через SessionStore (lib/session.js): s.dispose.
// Скриншоти viewport: jpeg q60, scale:'css' (px скрина = CSS px viewport, DPR не
// важить), caret:'initial' (дефолтний 'hide' пише стилі в DOM — stealth).
import crypto from 'crypto';
import { describeContextLogs } from './logs.js';
import { gotoSmart, prepareForInteraction, waitPastCloudflare, allFramesText, waitForResultChange, waitForContentSettle } from './nav.js';
import { runSteps, resolveTarget, hasTarget, SETTLE_CLICK, SETTLE_KEY, SETTLE_FILE } from './replay.js';
import { hitTest, captureTarget, describeHandle } from './capture.js';
import { createNetTracker, waitQuiet } from './settle.js';
import { collectFileInputs, evalMain, waitScrollSettle } from './dom.js';
import { newStepId, inheritTextTarget, needsLegacyPrep } from './steps.js';
import { behaviorOpts, humanMove, humanPress, humanType } from './human.js';
import { rint } from './rng.js';
import { expandTemplate } from './textTemplate.js';
import { resolveUpload as resolveUploadFile } from './uploads.js';
import { engineKind } from './engine.js';
import { httpError } from './http.js';
import { sessionError } from './session.js';
import { cleanError } from './errText.js';

export const ACT_TYPES = new Set(['click', 'dblclick', 'text', 'key', 'scroll', 'file', 'select']);
export const NAV_ACTIONS = new Set(['goto', 'back', 'forward', 'reload']);
export const PREFIX_STEP_TIMEOUT = 2500;
export const ACQUIRE_TIMEOUT = 15000;
// Межі виконання викликів у черзі сесії (sessions.run): зависла дія (сторінка
// заблокувала головний потік) закриває сесію, а не тримає слот і контекст вічно.
export const ACT_TIMEOUTS = Object.freeze({ act: 60000, inspect: 15000, nav: 120000, run: Infinity });
export const PROBE_TIMEOUT = 5000;

// Дешевий хеш буфера скриншота (md5, 16 hex).
export function shotHash(buf) {
  return crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
}

export const normalizeUrl = (url) => (/^https?:\/\//i.test(url) ? url : 'https://' + url);

const VP_FN = () => {
  const de = document.documentElement;
  return {
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1,
    scrollX: window.scrollX, scrollY: window.scrollY,
    docW: de.scrollWidth, docH: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
};
// Promise із межею часу (зонд на замороженій сторінці не висить вічно).
export function withTimeout(p, ms, what = 'операція') {
  let t;
  const to = new Promise((_r, reject) => { t = setTimeout(() => reject(new Error(what + ': немає відповіді сторінки за ' + Math.round(ms / 1000) + ' с')), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
// Вимір viewport — у приватному ізольованому світі (Chromium), з межею часу.
export async function readVp(page, ms = PROBE_TIMEOUT) {
  return withTimeout(evalMain(page, VP_FN), ms, 'вимір viewport');
}

const errText = (e) => cleanError(String((e && e.message) || e).split('\n')[0], 300);

// deps: { engine, sem, profileStore, config, sessions, log, acquireTimeoutMs }
export function createLive({ engine, sem, profileStore, config, sessions, log = console, acquireTimeoutMs = ACQUIRE_TIMEOUT }) {
  const uploadPath = (fileId, filename) => resolveUploadFile(config.UPLOAD_DIR, fileId, filename);
  const configChanged = (s) => !!(typeof engine.profileSig === 'function' && s.profileSig && engine.profileSig() !== s.profileSig);
  const slog = (s, kind, text) => { s.logs.push({ kind, text }); if (s.logs.length > 200) s.logs.splice(0, s.logs.length - 200); };

  // Закриття ресурсів сесії (викликає SessionStore.close).
  function makeDispose(s) {
    return async (reason) => {
      try { s.ac.abort(); } catch (_e) {}
      for (const d of s.detachers.splice(0)) { try { d(); } catch (_e) {} }
      if (s.tracker) { s.tracker.dispose(); s.tracker = null; }
      if (s.lastHandle) { s.lastHandle.dispose().catch(() => {}); s.lastHandle = null; }
      if (s.unit) { const u = s.unit; s.unit = null; await engine.closeUnit(u).catch(() => {}); }
      if (s.permit) { s.permit = false; sem.release(); }
      log.log('Жива сесія ' + s.sid + ' закрита: ' + reason);
    };
  }

  function setPage(s, p) {
    s.page = p;
    if (s.tracker) s.tracker.dispose();
    s.tracker = createNetTracker(p);
  }

  // Слухачі сторінки сесії: закриття/краш → закрити сесію; діалоги → прийняти.
  function attachPage(s, p) {
    const onClose = () => {
      if (s.state === 'closed' || s.page !== p) return;
      const ctx = s.unit && s.unit.context;
      const alive = ctx && typeof ctx.pages === 'function' ? ctx.pages().filter((x) => !x.isClosed()) : [];
      if (alive.length) { setPage(s, alive[alive.length - 1]); slog(s, 'nav', '🪟 Вкладку закрито — повертаюсь до попередньої'); }
      else sessions.close(s.sid, 'сторінку закрито');
    };
    const onCrash = () => { sessions.close(s.sid, 'сторінка впала (crash)'); };
    const onDialog = async (d) => {
      let what = '';
      try { what = d.type() + ' «' + String(d.message()).slice(0, 80) + '»'; } catch (_e) {}
      slog(s, 'info', '💬 Діалог ' + what + ' → прийнято');
      try { await d.accept(); } catch (_e) {}
    };
    p.on('close', onClose); p.on('crash', onCrash); p.on('dialog', onDialog);
    s.detachers.push(() => { p.off('close', onClose); p.off('crash', onCrash); p.off('dialog', onDialog); });
  }

  function attachContext(s, ctx) {
    if (!ctx || typeof ctx.on !== 'function') return;
    const onPage = (p) => {
      if (s.state === 'closed') return;
      attachPage(s, p);
      setPage(s, p);
      slog(s, 'nav', '🪟 Відкрилась нова вкладка/попап — далі дії в ній');
    };
    ctx.on('page', onPage);
    s.detachers.push(() => { try { ctx.off('page', onPage); } catch (_e) {} });
  }

  // Знімок viewport + метадані. knownHash — хеш, який клієнт уже має (тоді без shot).
  async function snapshot(s, knownHash) {
    const page = s.page;
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css', caret: 'initial', timeout: 10000 });
    const hash = shotHash(buf);
    const vp = await readVp(page).catch(() => null);
    const out = { hash, vp, url: page.url(), title: await page.title().catch(() => ''), configChanged: configChanged(s) };
    if (hash !== knownHash) out.shot = 'data:image/jpeg;base64,' + buf.toString('base64');
    s.hash = hash;
    return out;
  }

  // Очікування після дії: навігація головного фрейму → domcontentloaded + Cloudflare;
  // інакше мережевий спокій (Node-side, без JS у сторінці).
  function armNav(page) {
    const mf = page.mainFrame();
    let nav = false;
    const fn = (f) => { if (f === mf) nav = true; };
    page.on('framenavigated', fn);
    return { flag: () => nav, off: () => page.off('framenavigated', fn) };
  }
  async function settle(s, navFlag, opts) {
    await waitQuiet(s.tracker, opts, { signal: s.ac.signal });
    if (navFlag() && s.state !== 'closed') {
      slog(s, 'nav', '🧭 Дія спричинила навігацію → чекаю завантаження сторінки');
      await s.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const cf = await waitPastCloudflare(s.page, 40000).catch(() => ({}));
      if (cf && cf.wasChallenge) slog(s, 'info', cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено');
      await waitQuiet(s.tracker, opts, { signal: s.ac.signal });
    }
  }
  // «чекати відповідь»: POST-и + зміна контенту результату (як у /replay).
  async function waitResponse(s, beforeText, posts) {
    const page = s.page, t0 = Date.now();
    await Promise.all(page.frames().map((f) => f.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})));
    const changed = await waitForResultChange(page, beforeText, 12000, { signal: s.ac.signal });
    await waitForContentSettle(page, 9000, { signal: s.ac.signal });
    slog(s, 'info', '📨 POST-и за ' + (Date.now() - t0) + ' мс: ' + (posts.length ? posts.map((p) => p.slice(0, 90)).join('  |  ') : 'ЖОДНОГО'));
    slog(s, changed ? 'info' : 'warn', changed ? '✅ Контент результату змінився після сабміту' : '⚠️ Контент НЕ змінився — схоже, форма не відправилась');
  }

  const keepHandle = (s, h) => {
    if (s.lastHandle && s.lastHandle !== h) s.lastHandle.dispose().catch(() => {});
    s.lastHandle = h || null;
  };
  const docPoint = (vp, vx, vy) => ({ x: Math.round(vx + vp.scrollX), y: Math.round(vy + vp.scrollY) });
  const coordFields = (vp, pt) => ({ x: pt.x, y: pt.y, sw: vp.docW, sh: vp.docH, vw: vp.w, vh: vp.h, scrollY: Math.round(vp.scrollY) });

  // ---------- Відкриття ----------
  // body: {url, actions (плаский префікс), recId}. send — NDJSON-подія. onSession(s) —
  // щойно сесію створено (роут вішає на неї обробник відʼєднання клієнта).
  async function open(body, send, { onSession } = {}) {
    let { url, actions } = body || {};
    if (!url) throw httpError(400, 'Не передано url');
    url = normalizeUrl(String(url));
    if (!Array.isArray(actions)) actions = [];
    const profile = profileStore.get();
    const s = await sessions.create({
      engine: engineKind(profile),
      profileSig: typeof engine.profileSig === 'function' ? engine.profileSig() : null,
      recId: body.recId == null ? null : body.recId,
      ac: new AbortController(),
      detachers: [], logs: [], unit: null, page: null, permit: false,
      tracker: null, lastStep: null, lastHandle: null, hash: null, mouse: null,
    });
    s.dispose = makeDispose(s);
    if (onSession) onSession(s);
    send({ event: 'session', sid: s.sid });
    const closed = () => s.state === 'closed';
    // Сесію закрили під час відкриття (relaunch «config changed», закриття сторінки,
    // DELETE з іншої вкладки, зупинка сервера) — потік має закінчитись подією error
    // з причиною, а не тихо (контракт: кінець — {event:'live'} або {event:'error'}).
    const closedErr = () => sessionError(410, 'session_closed',
      'Сесію закрито під час відкриття: ' + (s.closeReason || 'закрито'), { reason: s.closeReason || null });
    try {
      send({ event: 'status', text: 'Чекаю вільний слот браузера…' });
      try { await sem.acquire(acquireTimeoutMs); } catch (e) {
        await sessions.close(s.sid, 'немає вільного слота');
        throw httpError(503, 'Немає вільного слота браузера за ' + acquireTimeoutMs / 1000 + ' с (усі зайняті)');
      }
      if (closed()) { sem.release(); throw closedErr(); }
      s.permit = true;
      const warm = engine.engineReady();
      const unit = await engine.takeUnit();
      if (closed()) { await engine.closeUnit(unit).catch(() => {}); throw closedErr(); }
      s.unit = unit;
      setPage(s, unit.page);
      attachPage(s, unit.page);
      attachContext(s, unit.context);
      for (const l of describeContextLogs(profile, { fromPool: unit.fromPool, warm })) send({ event: 'log', ...l });
      send({ event: 'log', kind: 'info', text: '🔴 Жива сесія ' + s.sid + ' (' + s.engine + ')' });
      send({ event: 'log', kind: 'nav', text: '➡️ goto ' + url + ' (Cloudflare-aware)' });
      send({ event: 'status', text: 'Відкриваю сторінку…' });
      const { cf } = await gotoSmart(s.page, url);
      if (cf.wasChallenge) send({ event: 'log', kind: 'info', text: cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено' });
      // Поведінка (behavior.humanize) — і для дій сесії, і для префікса (префікс
      // швидкий лише з явним behavior.fastPrefix). Логуємо, що реально застосовано.
      const actB = behaviorOpts(profile, 'act'), preB = behaviorOpts(profile, 'prefix');
      send({ event: 'log', kind: 'info', text: '🧍 Поведінка: ' + (actB.humanize ? 'людська' : 'вимкнена')
        + (actions.length && preB.humanize !== actB.humanize ? ' (префікс: швидкий, behavior.fastPrefix)' : '') });
      if (actions.length) {
        // Legacy-координатні кроки записані на fullPage-скрині після /render-підготовки —
        // готуємо сторінку так само (як /replay; behavior.prepareScroll). Кроки v2 цього не потребують.
        if (needsLegacyPrep(actions) && !(profile.behavior && profile.behavior.prepareScroll === false)) {
          send({ event: 'status', text: 'Чекаю дозавантаження контенту (як у рендері)…' });
          await prepareForInteraction(s.page, { signal: s.ac.signal, mode: 'replay', humanize: preB.humanize });
        }
        if (closed()) throw closedErr();
        send({ event: 'status', text: 'Відтворюю префікс: ' + actions.length + ' кроків…' });
        const res = await runSteps(s.page, actions, {
          send, humanize: preB.humanize, signal: s.ac.signal, stepTimeout: PREFIX_STEP_TIMEOUT, handleDialogs: false,
          singleMove: preB.singleMove,
          resolveUpload: uploadPath,
        });
        if (closed()) throw closedErr();
        if (res.page && res.page !== s.page) setPage(s, res.page);
        const failed = actions.length - res.replayed;
        send({ event: 'log', kind: failed ? 'warn' : 'info', text: failed
          ? '⚠️ Префікс: ' + failed + ' з ' + actions.length + ' кроків не вдались — сесія відкрита у стані, якого досягли'
          : '✅ Префікс відтворено (' + actions.length + ')' });
      }
      if (closed()) throw closedErr();
      sessions.markReady(s.sid);
      const snap = await snapshot(s, null);
      for (const l of s.logs.splice(0)) send({ event: 'log', ...l });
      send({ event: 'live', sid: s.sid, engine: s.engine, ...snap });
      return s;
    } catch (e) {
      if (!closed()) { await sessions.close(s.sid, 'помилка відкриття: ' + errText(e)); throw e; }
      // Закрито ззовні: Playwright-помилка («Target closed») → справжня причина закриття.
      // (Наші HTTP-помилки — напр. 503 «немає слота» — передаємо як є.)
      throw (e && (e.code === 'session_closed' || e.status)) ? e : closedErr();
    }
  }

  // ---------- Дії ----------
  async function act(sid, b) {
    b = b || {};
    const type = String(b.type || '');
    if (!ACT_TYPES.has(type)) throw httpError(400, 'Невідомий тип дії: ' + type);
    return sessions.run(sid, async (s) => {
      const t0 = Date.now();
      const out = { ok: true, k: b.k == null ? undefined : b.k, step: null };
      const rec = b.rec !== false;
      // Незавершені «очікування» стосуються лише наступної відповідної дії.
      if (type !== 'select') s.pending.select = null;
      if (type === 'click' || type === 'dblclick') s.pending.chooser = null;
      try {
        const step = await ACT[type](s, b, out, rec);
        out.step = rec && step ? step : null;
      } catch (e) {
        if (e && e.status && e.status < 500) throw e; // валідація → 4xx
        if (s.state === 'closed') throw e;
        out.ok = false;
        out.error = errText(e);
        slog(s, 'error', '❌ ' + type + ': ' + out.error);
      }
      let snap = null;
      try { snap = await snapshot(s, b.h == null ? s.hash : String(b.h)); } catch (e) { slog(s, 'warn', '📸 Скриншот не вдався: ' + errText(e)); }
      out.ms = Date.now() - t0;
      out.logs = s.logs.splice(0);
      return { ...out, ...(snap || { configChanged: configChanged(s) }) };
    }, { timeoutMs: ACT_TIMEOUTS.act });
  }

  const num = (v, name) => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) throw httpError(400, 'Некоректне ' + name);
    return n;
  };

  const ACT = {
    async click(s, b, out, rec) {
      const page = s.page;
      const vp = await readVp(page);
      const vx = num(b.vx, 'vx'), vy = num(b.vy, 'vy');
      if (vx < 0 || vy < 0 || vx >= vp.w || vy >= vp.h) throw httpError(400, 'Точка поза viewport');
      const dbl = b.type === 'dblclick';
      const pt = docPoint(vp, vx, vy);
      const hit = await hitTest(page, vx, vy, { scroll: { x: vp.scrollX, y: vp.scrollY } });
      let target = null;
      if (hit) {
        keepHandle(s, hit.handle);
        target = await captureTarget(page, hit, { point: pt, count: rec });
      }
      // Нативний <select>: не клікаємо (системний список у headless не видно) — UI покаже поповер.
      if (hit && hit.desc.tag === 'SELECT' && !hit.desc.multiple) {
        s.pending.select = { handle: hit.handle, target, pt, vp, options: hit.desc.options || [] };
        out.needSelect = { options: hit.desc.options || [] };
        slog(s, 'info', '🔽 ' + (target ? target.desc : 'Список') + ' — обери значення');
        s.lastStep = { type: 'click', target };
        return null;
      }
      const wantWait = b.waitResponse === true;
      const beforeText = wantWait ? await allFramesText(page) : null;
      const posts = [];
      const onResp = (resp) => {
        try { if (resp.request().method() === 'POST' && !/cdn-cgi\/challenge-platform/.test(resp.url())) posts.push(resp.status() + ' ' + resp.url()); } catch (_e) {}
      };
      let chooser = null;
      const onFc = (fc) => { chooser = fc; };
      page.on('filechooser', onFc);
      if (wantWait) page.on('response', onResp);
      const nav = armNav(page);
      const { humanize, singleMove } = behaviorOpts(profileStore.get(), 'act');
      try {
        if (humanize) {
          // Як у /replay: людський рух від попередньої позиції, мікропауза, роздільні down/up.
          s.mouse = await humanMove(page, s.mouse || { x: rint(80, 400), y: rint(80, 400) }, vx, vy, Math.random, { single: singleMove });
          await humanPress(page);
          if (dbl) {
            await page.waitForTimeout(rint(70, 140));
            await page.mouse.down({ clickCount: 2 });
            await page.waitForTimeout(rint(40, 100));
            await page.mouse.up({ clickCount: 2 });
          }
        } else {
          await page.mouse.move(vx, vy, { steps: 4 });
          await page.mouse.down(); await page.mouse.up();
          if (dbl) { await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); }
          s.mouse = { x: vx, y: vy };
        }
        await settle(s, nav.flag, SETTLE_CLICK);
        if (wantWait) await waitResponse(s, beforeText, posts);
      } finally {
        nav.off(); page.off('filechooser', onFc);
        if (wantWait) page.off('response', onResp);
      }
      if (chooser) {
        s.pending.chooser = { chooser, target };
        out.needFile = { multiple: typeof chooser.isMultiple === 'function' ? chooser.isMultiple() : false };
        slog(s, 'info', '📎 Відкрився вибір файлу — обери файл');
      }
      const step = { id: newStepId(), v: 2, type: 'click', ...coordFields(vp, pt), button: 'left', clicks: dbl ? 2 : 1 };
      if (target) step.target = target;
      if (wantWait) step.waitResponse = true;
      if (chooser) step.chooser = true; // клік відкриває вибір файлу (при відтворенні — без системного діалогу)
      s.lastStep = step;
      return step;
    },
    async dblclick(s, b, out, rec) { return ACT.click(s, { ...b, type: 'dblclick' }, out, rec); },

    async text(s, b) {
      const text = b.text == null ? '' : String(b.text);
      if (!text) throw httpError(400, 'Порожній текст');
      // b.text — шаблон ({d}, {l}, {{): на сторінку йде розгорнутий, у крок — як є.
      // humanize — друк по буквах зі змінним ритмом (як /replay); інакше як runSteps (25 мс).
      if (behaviorOpts(profileStore.get(), 'act').humanize) await humanType(s.page, expandTemplate(text));
      else await s.page.keyboard.type(expandTemplate(text), { delay: 25 });
      await waitQuiet(s.tracker, SETTLE_KEY, { signal: s.ac.signal });
      const inherited = inheritTextTarget(s.lastStep);
      const step = { id: newStepId(), v: 2, type: 'text', text };
      if (inherited) {
        step.target = inherited;
        const src = s.lastStep;
        if (src && src.x != null) Object.assign(step, { x: src.x, y: src.y, sw: src.sw, sh: src.sh });
      }
      s.lastStep = step;
      return step;
    },

    async key(s, b) {
      const key = String(b.key || '');
      if (!key) throw httpError(400, 'Не передано key');
      const page = s.page;
      const nav = armNav(page);
      try {
        if (behaviorOpts(profileStore.get(), 'act').humanize) await page.keyboard.press(key, { delay: rint(30, 90) });
        else await page.keyboard.press(key);
        await settle(s, nav.flag, SETTLE_KEY);
      } finally { nav.off(); }
      const step = { id: newStepId(), v: 2, type: 'key', key };
      const inherited = inheritTextTarget(s.lastStep);
      if (inherited) step.target = inherited;
      s.lastStep = step;
      return step;
    },

    async scroll(s, b) {
      const page = s.page;
      const vp = await readVp(page);
      const dx = Number(b.dx) || 0, dy = Number(b.dy) || 0;
      const vx = Number.isFinite(Number(b.vx)) ? Number(b.vx) : vp.w / 2;
      const vy = Number.isFinite(Number(b.vy)) ? Number(b.vy) : vp.h / 2;
      await page.mouse.move(vx, vy);
      s.mouse = { x: vx, y: vy };
      await page.mouse.wheel(dx, dy);
      await waitScrollSettle(page, { maxMs: 1500, minMs: 120 });
      return { id: newStepId(), v: 2, type: 'scroll', dx, dy, vx: Math.round(vx), vy: Math.round(vy) };
    },

    async file(s, b, out, rec) {
      const fp = uploadPath(b.fileId, b.filename);
      if (!fp) throw httpError(400, 'Файл не знайдено на сервері (спершу /upload)');
      const page = s.page;
      let target = null, how = '';
      const pc = s.pending.chooser;
      if (pc) {
        s.pending.chooser = null;
        const el = pc.chooser.element();
        const d = await describeHandle(page, el).catch(() => null);
        if (d) target = await captureTarget(page, d, { count: rec }).catch(() => null);
        await pc.chooser.setFiles(fp);
        how = 'через вибір файлу';
      } else if (s.lastStep && s.lastStep.target && s.lastStep.target.kind === 'file' && hasTarget(s.lastStep)) {
        const r = await resolveTarget(page, s.lastStep.target, { timeout: 2000 });
        if (!r) throw new Error('поле файлу з попереднього кліку не знайдено');
        await r.locator.setInputFiles(fp);
        target = s.lastStep.target; how = 'у поле з останнього кліку';
      } else {
        const inputs = await collectFileInputs(page);
        if (!inputs.length) throw new Error('на сторінці немає поля для файлу');
        const input = inputs[0];
        const d = await describeHandle(page, input).catch(() => null);
        if (d) target = await captureTarget(page, d, { count: rec }).catch(() => null);
        await input.setInputFiles(fp);
        how = 'у перше input[type=file]';
      }
      const q = await waitQuiet(s.tracker, SETTLE_FILE, { signal: s.ac.signal });
      await waitForContentSettle(page, 2500, { signal: s.ac.signal });
      slog(s, 'info', '📎 Файл «' + b.filename + '» підставлено ' + how + '; мережа ' + (q.quiet ? 'заспокоїлась' : 'ще активна') + ' за ' + q.ms + ' мс');
      const step = { id: newStepId(), v: 2, type: 'file', fileId: String(b.fileId), filename: String(b.filename || '') };
      if (target) step.target = target;
      s.lastStep = step;
      return step;
    },

    async select(s, b) {
      const p = s.pending.select;
      if (!p) throw httpError(400, 'Немає відкритого списку (спершу клікни по <select>)');
      const value = b.value == null ? '' : String(b.value);
      const opt = (p.options || []).find((o) => o.value === value) || (p.options || []).find((o) => o.label === value);
      const nav = armNav(s.page);
      try {
        let el = p.handle;
        try {
          await el.selectOption(opt ? { value: opt.value } : { value }, { timeout: 2000 });
        } catch (e) {
          // Хендл застарів (перерендер) — шукаємо за ціллю.
          const r = p.target && hasTarget({ target: p.target }) ? await resolveTarget(s.page, p.target, { timeout: 2000 }) : null;
          if (!r) throw e;
          await r.locator.selectOption(opt ? { value: opt.value } : { label: value }, { timeout: 2000 });
        }
        await settle(s, nav.flag, SETTLE_CLICK);
      } finally { nav.off(); }
      s.pending.select = null;
      const step = { id: newStepId(), v: 2, type: 'select', value: opt ? opt.value : value, label: opt ? opt.label : value, ...coordFields(p.vp, p.pt) };
      if (p.target) step.target = p.target;
      s.lastStep = step;
      return step;
    },
  };

  // ---------- Решта ----------
  async function shot(sid, h) {
    const s = sessions.require(sid);
    if (s.state === 'prefix') throw sessionBusy();
    let snap;
    try { snap = await snapshot(s, h == null ? null : String(h)); } catch (e) {
      // Опитування в польоті, а сесію щойно закрили (DELETE) → 410 замість 500.
      if (s.state === 'closed' && !(e && e.status)) throw sessions.closedError ? sessions.closedError(sid) : e;
      throw e;
    }
    return { ok: true, ...snap, logs: s.logs.splice(0) };
  }

  async function nav(sid, b) {
    b = b || {};
    const action = String(b.action || (b.url ? 'goto' : ''));
    if (!NAV_ACTIONS.has(action)) throw httpError(400, 'Невідома навігація: ' + action);
    if (action === 'goto' && !b.url) throw httpError(400, 'Не передано url');
    return sessions.run(sid, async (s) => {
      const t0 = Date.now();
      const page = s.page;
      s.pending.chooser = null; s.pending.select = null; s.lastStep = null;
      let ok = true, error;
      try {
        if (action === 'goto') {
          const url = normalizeUrl(String(b.url));
          slog(s, 'nav', '➡️ goto ' + url);
          const { cf } = await gotoSmart(page, url);
          if (cf.wasChallenge) slog(s, 'info', cf.passed ? '🛡️ Cloudflare челендж ПРОЙДЕНО' : '🛡️ Cloudflare челендж НЕ пройдено');
        } else {
          const opts = { waitUntil: 'domcontentloaded', timeout: 30000 };
          if (action === 'back') await page.goBack(opts);
          else if (action === 'forward') await page.goForward(opts);
          else await page.reload(opts);
          await waitPastCloudflare(page, 40000).catch(() => {});
          await waitQuiet(s.tracker, SETTLE_CLICK, { signal: s.ac.signal });
        }
      } catch (e) { ok = false; error = errText(e); slog(s, 'error', '❌ ' + action + ': ' + error); }
      const snap = await snapshot(s, b.h == null ? s.hash : String(b.h));
      return { ok, error, ms: Date.now() - t0, logs: s.logs.splice(0), ...snap };
    }, { timeoutMs: ACT_TIMEOUTS.nav });
  }

  // Що під точкою (без кліку): {box (viewport головної сторінки), target, desc}.
  async function inspect(sid, x, y) {
    const vx = num(x, 'x'), vy = num(y, 'y');
    return sessions.run(sid, async (s) => {
      const vp = await readVp(s.page);
      if (vx < 0 || vy < 0 || vx >= vp.w || vy >= vp.h) throw httpError(400, 'Точка поза viewport');
      const hit = await hitTest(s.page, vx, vy, { scroll: { x: vp.scrollX, y: vp.scrollY } });
      if (!hit) return { ok: true, box: null, target: null, desc: null };
      try {
        const target = await captureTarget(s.page, hit, { point: docPoint(vp, vx, vy) });
        return { ok: true, box: hit.desc.vbox, target, desc: target.desc };
      } finally { hit.handle.dispose().catch(() => {}); }
    }, { timeoutMs: ACT_TIMEOUTS.inspect });
  }

  // «▶ спробувати»: прогін кроків у живій сесії тим самим runSteps (NDJSON).
  async function run(sid, steps, send, { signal } = {}) {
    if (!Array.isArray(steps)) throw httpError(400, 'steps має бути масивом');
    return sessions.run(sid, async (s) => {
      const profile = profileStore.get();
      const { humanize, singleMove } = behaviorOpts(profile, 'replay');
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      s.ac.signal.addEventListener('abort', onAbort, { once: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await runSteps(s.page, steps, {
          send, signal: ac.signal, handleDialogs: false, humanize, singleMove,
          resolveUpload: uploadPath,
        });
        if (res.page && res.page !== s.page && !res.page.isClosed()) setPage(s, res.page);
        s.lastStep = null;
        for (const l of s.logs.splice(0)) send({ event: 'log', ...l });
        const snap = await snapshot(s, null);
        send({ event: 'live', sid: s.sid, engine: s.engine, replayed: res.replayed, total: steps.length, ...snap });
        return res;
      } finally {
        s.ac.signal.removeEventListener('abort', onAbort);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }, { timeoutMs: ACT_TIMEOUTS.run }); // довгий прогін має власне переривання (відʼєднання клієнта)
  }

  async function close(sid, reason = 'закрито клієнтом') {
    return sessions.close(sid, reason);
  }

  return { open, act, shot, nav, inspect, run, close, snapshot };
}

function sessionBusy() {
  return sessionError(409, 'session_busy', 'Сесія ще відкривається (відтворюю префікс) — зачекай');
}
