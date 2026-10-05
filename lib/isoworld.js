// Приватний ізольований світ (CDP) для read-only зондів у Chromium.
//
// Навіщо: page.evaluate / frame.evaluate / locator.evaluate у Chromium виконуються в
// ГОЛОВНОМУ світі сторінки — будь-яка обгортка сторінки над querySelectorAll,
// elementFromPoint, getComputedStyle, getBoundingClientRect, requestAnimationFrame
// бачить виклик разом зі стеком «UtilityScript.evaluate» (підпис Playwright, який
// шукають антиботи, напр. bot-detector.rebrowser.net). Ізольований світ ділить DOM,
// але має ВЛАСНІ JS-обгортки (прототипи, window) — обгортки сторінки його не бачать.
//
// Як: одна CDP-сесія на сторінку (context.newCDPSession(page), БЕЗ Runtime.enable),
// Page.createIsolatedWorld на фрейм (кеш contextId, інвалідація на «Cannot find
// context» — після навігації), Runtime.evaluate з contextId і returnByValue.
// Дочірні фрейми: iframe-елемент → DOM.describeNode → frameId; out-of-process iframe
// (увімкнена ізоляція сайтів) — окрема сесія newCDPSession(frame), зіставлена за id.
//
// Camoufox (Firefox/Juggler) CDP не має → isoState() повертає null, і викликачі
// лишаються на frame.evaluate (там evaluate і так ізольований: «Main world evaluation
// is disabled»).
import crypto from 'crypto';

// Вираз виклику функції fn з аргументом (fn — самодостатня стрілкова функція).
export function callExpression(fn, arg) {
  return '(' + String(fn) + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
}

const isStaleCtx = (e) => /Cannot find context|Execution context was destroyed|Cannot find execution context/i.test(String((e && e.message) || e));
const isNoFrame = (e) => /No frame for given id|Frame with the given id was not found|No frame with given id/i.test(String((e && e.message) || e));

// Ядро (чисте від Playwright): sess — {send(method, params)}; mainId — frameId головного.
// opts.oopifFor(frameId) → сесія out-of-process фрейму або null; opts.refreshMain() → новий mainId.
export function createIso(sess, mainId, { oopifFor = async () => null, refreshMain = null, worldName = null } = {}) {
  const name = worldName || ('w' + crypto.randomBytes(6).toString('hex'));
  const perSess = new Map(); // sess → Map(frameId → Promise<contextId>)
  const stats = { created: 0, evals: 0 };

  function cacheOf(s) {
    let m = perSess.get(s);
    if (!m) { m = new Map(); perSess.set(s, m); }
    return m;
  }
  function contextFor(s, frameId) {
    const m = cacheOf(s);
    let p = m.get(frameId);
    if (!p) {
      p = s.send('Page.createIsolatedWorld', { frameId, worldName: name }).then((r) => { stats.created++; return r.executionContextId; });
      m.set(frameId, p);
      p.catch(() => { if (m.get(frameId) === p) m.delete(frameId); }); // невдачу не кешуємо
    }
    return p;
  }
  const drop = (s, frameId) => { cacheOf(s).delete(frameId); };
  const mainRef = () => ({ sess, frameId: mainId });

  // Runtime.evaluate у світі фрейму ref (null — головний) з одним повтором після
  // навігації (контекст знищено) або зміни id головного фрейму.
  async function run(ref, params) {
    let r = ref || mainRef();
    for (let attempt = 0; ; attempt++) {
      try {
        const contextId = await contextFor(r.sess, r.frameId);
        stats.evals++;
        const out = await r.sess.send('Runtime.evaluate', { ...params, contextId });
        if (out && out.exceptionDetails) {
          const d = out.exceptionDetails;
          const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'помилка evaluate';
          if (attempt === 0 && isStaleCtx(msg)) { drop(r.sess, r.frameId); continue; }
          throw new Error(String(msg).split('\n')[0]);
        }
        return out;
      } catch (e) {
        if (attempt > 0) throw e;
        if (isStaleCtx(e)) { drop(r.sess, r.frameId); continue; }
        if (!ref && isNoFrame(e) && refreshMain) { drop(r.sess, r.frameId); mainId = await refreshMain(); r = mainRef(); continue; }
        throw e;
      }
    }
  }

  // fn(arg) у світі фрейму → значення (returnByValue).
  async function evaluate(ref, fn, arg) {
    const out = await run(ref, { expression: callExpression(fn, arg), returnByValue: true, awaitPromise: true });
    return out && out.result ? out.result.value : undefined;
  }

  // Фрейм, вміст якого показує <iframe>, що повертає вираз expression (у світі ref).
  // → { sess, frameId } або null (не iframe / фрейм ще без документа).
  async function childRef(ref, expression) {
    const r = ref || mainRef();
    const out = await run(r, { expression, returnByValue: false });
    const objectId = out && out.result && out.result.objectId;
    if (!objectId) return null;
    let frameId = null;
    try {
      const d = await r.sess.send('DOM.describeNode', { objectId });
      frameId = d && d.node ? d.node.frameId || null : null;
    } finally {
      r.sess.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    if (!frameId) return null;
    try { await contextFor(r.sess, frameId); return { sess: r.sess, frameId }; } catch (e) { if (!isNoFrame(e)) throw e; }
    const os = await oopifFor(frameId); // out-of-process iframe — своя сесія
    if (!os) return null;
    await contextFor(os, frameId);
    return { sess: os, frameId };
  }

  return { evaluate, childRef, stats, get worldName() { return name; }, get mainId() { return mainId; } };
}

// ---------- Прив'язка до Playwright ----------
const states = new WeakMap(); // page → Promise<iso|null>
const frameSess = new WeakMap(); // Playwright Frame → Promise<{sess, id}|null>

// Ізольований світ сторінки (Chromium) або null (Camoufox / фейкова сторінка / помилка).
export function isoState(page) {
  if (!page || typeof page !== 'object') return Promise.resolve(null);
  let p = states.get(page);
  if (p) return p;
  p = (async () => {
    const ctx = typeof page.context === 'function' ? page.context() : null;
    if (!ctx || typeof ctx.newCDPSession !== 'function') return null;
    let sess;
    try { sess = await ctx.newCDPSession(page); } catch (_e) { return null; } // не Chromium
    const tree = async () => (await sess.send('Page.getFrameTree')).frameTree.frame.id;
    const mainId = await tree();
    const oopifFor = async (frameId) => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        let fp = frameSess.get(f);
        if (!fp) {
          fp = (async () => {
            try {
              const s = await ctx.newCDPSession(f); // лише для out-of-process фреймів
              return { sess: s, id: (await s.send('Page.getFrameTree')).frameTree.frame.id };
            } catch (_e) { return null; }
          })();
          frameSess.set(f, fp);
        }
        const r = await fp;
        if (r && r.id === frameId) return r.sess;
      }
      return null;
    };
    return createIso(sess, mainId, { oopifFor, refreshMain: tree });
  })().catch(() => null);
  states.set(page, p);
  return p;
}

// fn(arg) у головному фреймі сторінки: ізольований світ (Chromium) або page.evaluate.
export async function evalMain(page, fn, arg) {
  const iso = await isoState(page);
  if (iso) return iso.evaluate(null, fn, arg);
  return page.evaluate(fn, arg);
}
