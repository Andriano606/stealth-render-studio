// E2E (opt-in, E2E=1): відтворення координатних (legacy) кліків у справжньому Chrome на
// локальних фікстурах, що відтворюють підтверджені причини «клік спрацьовує через раз»
// (scratchpad/design/causes.json). Кожен кейс проганяється N=5 разів: клік має влучати
// у задуманий елемент ЩОРАЗУ.
//
// «Запис» імітується як у UI: сторінку готуємо як /render (prepareForInteraction), міряємо
// doc-координати цілей і зберігаємо їх у пікселях fullPage-скриншота при DPR 2 (x*2, y*2,
// sw = scrollWidth*2) — тож заразом перевіряється масштаб. Відтворення — у DPR 1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runReplay } from '../../lib/replay.js';
import { gotoSmart, prepareForInteraction } from '../../lib/nav.js';
import { mulberry32 } from '../../lib/rng.js';

const E2E = process.env.E2E === '1';
const N = Number(process.env.E2E_RUNS) || 5;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const VIEWPORT = { width: 1280, height: 900 };

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const ms = Math.min(5000, Number(u.searchParams.get('ms')) || 0);
  if (u.pathname === '/api/options') {
    return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(['UA', 'PL', 'DE', 'FR', 'US'])); }, ms);
  }
  if (u.pathname === '/img') {
    const h = Number(u.searchParams.get('h')) || 300;
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="' + h + '"><rect width="600" height="' + h + '" fill="#9bd"/></svg>');
    }, ms);
  }
  const f = path.join(FIX, path.basename(u.pathname));
  if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}

let srvA, srvB, A, B, browser;
const listen = async (s) => { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + s.address().port; };
before(async () => {
  if (!E2E) return;
  srvA = http.createServer(handler); srvB = http.createServer(handler);
  A = await listen(srvA);
  B = await listen(srvB); // другий порт = інший origin (крос-доменний iframe)
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (srvA) srvA.close();
  if (srvB) srvB.close();
});

// «Запис»: doc-координати цілей (у CSS) → legacy-під-дії у px скриншота DPR 2.
// targets: [{ sel, frame?, dx?, dy? }] або [{ x, y }] (сирі doc-координати).
async function record(url, targets) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await gotoSmart(page, url);
  await prepareForInteraction(page);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, sy: scrollY }));
  const out = [];
  for (const t of targets) {
    let x, y;
    if (t.sel) {
      const loc = t.frame ? page.frameLocator(t.frame).locator(t.sel) : page.locator(t.sel);
      const bb = await loc.boundingBox(); // координати головного viewport (scrollY = 0 після prepare)
      x = bb.x + bb.width / 2 + (t.dx || 0); y = bb.y + bb.height / 2 + m.sy + (t.dy || 0);
    } else { x = t.x; y = t.y; }
    out.push({ type: 'click', x: Math.round(x * 2), y: Math.round(y * 2), sw: m.sw * 2, sh: m.sh * 2, gid: 1 });
  }
  await ctx.close();
  return out;
}

async function replay(url, actions, { humanize = false, seed = 1, before = null } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await gotoSmart(page, url);
  await prepareForInteraction(page);
  if (before) await before(page); // напр. сторінку вже прокручено (роздивлянням після відкриття)
  const events = [];
  const res = await runReplay(page, actions, { send: (e) => events.push(e), humanize, resolveUpload: () => null, rng: mulberry32(seed) });
  return { ctx, page: res.page, events, res };
}

const results = {};
async function runN(t, name, url, actions, check, { humanize = false, before = null } = {}) {
  let pass = 0;
  const fails = [];
  for (let k = 0; k < N; k++) {
    const r = await replay(url, actions, { humanize, seed: 1000 + k, before });
    try {
      await check(r);
      pass++;
    } catch (e) {
      fails.push('run ' + (k + 1) + ': ' + e.message.split('\n')[0] + ' | ' + r.events.filter((x) => x.event === 'log').map((x) => x.text).slice(-4).join(' / '));
    } finally {
      await r.ctx.close();
    }
  }
  results[name] = pass + '/' + N;
  t.diagnostic(name + ': ' + pass + '/' + N);
  assert.equal(pass, N, name + ' — промахи:\n' + fails.join('\n'));
}

const doneOk = (r) => assert.deepEqual(r.events.filter((e) => e.event === 'done-action').map((e) => e.ok), r.events.filter((e) => e.event === 'done-action').map(() => true));

test('e2e: smooth-scroll — кліки вниз/вгору/вниз влучають щоразу (humanize off і on)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/smooth.html';
  const acts = await record(url, [{ sel: '#b1' }, { sel: '#b2' }, { sel: '#b3' }, { sel: '#b1' }]);
  const check = async (r) => { doneOk(r); assert.deepEqual(await r.page.evaluate(() => window.clicks), ['b1', 'b2', 'b3', 'b1']); };
  await runN(t, 'smooth (humanize off)', url, acts, check);
  await runN(t, 'smooth (humanize on)', url, acts, check, { humanize: true });
});

test('e2e: lazy-зображення, IntersectionObserver-блок і пізній банер над ціллю', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/lazy.html';
  const acts = await record(url, [{ sel: '#target' }]);
  await runN(t, 'lazy layout shift', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['target']);
  });
});

test('e2e: асинхронна опція дропдауна (мережа 200-700 мс, меню закривається на scroll)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/dropdown.html';
  // відкривач — за селектором; опцію записано на скриншоті з відкритим меню: 4-та (FR)
  const [openA] = await record(url, [{ sel: '#open' }]);
  const optA = { ...openA, x: 150 * 2, y: (1236 + 1 + 3 * 30 + 15) * 2 };
  const check = async (r) => {
    doneOk(r);
    assert.equal(await r.page.evaluate(() => window.picked), 'FR');
    assert.equal(await r.page.evaluate(() => window.opened), 1);
  };
  await runN(t, 'async dropdown (humanize off)', url, [openA, optA], check);
  await runN(t, 'async dropdown (humanize on)', url, [openA, optA], check, { humanize: true });
});

test('e2e: внутрішній скрол-контейнер — роздивляння колесом не зсуває його (humanize on)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/inner.html';
  const acts = await record(url, [{ sel: '#i1' }, { sel: '#i2' }, { sel: '#i3' }, { sel: '#i4' }]);
  await runN(t, 'inner scroller (humanize on)', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['i1', 'i2', 'i3', 'i4']);
    assert.equal(await r.page.evaluate(() => document.getElementById('sc').scrollTop), 0);
  }, { humanize: true });
});

test('e2e: кнопка в крос-доменному iframe (рамка+паддінг), srcdoc-iframe і snap із порожнечі iframe', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/frame-host.html?child=' + encodeURIComponent(B + '/frame-child.html');
  const acts = await record(url, [
    { sel: '#apply', frame: '#f' },
    { sel: '#sb', frame: '#f2' },
    { sel: '#apply', frame: '#f', dy: 50 }, // промах на 50px нижче — порожній BODY iframe → snap
  ]);
  await runN(t, 'cross-frame iframe', url, acts, async (r) => {
    doneOk(r);
    await r.page.waitForFunction(() => window.clicks.length >= 3, null, { timeout: 2000 }).catch(() => {});
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['apply', 'srcdoc', 'apply']);
    const strategies = r.events.filter((e) => e.event === 'done-action').map((e) => e.strategy);
    assert.deepEqual(strategies, ['coord', 'coord', 'snap']);
  });
});

test('e2e: фіксована шапка над ціллю, cookie-банер і посилання в шапці', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/fixed.html';
  // accept/home — фіксовані, «записані» на скриншоті /render (scrollY 0)
  const acts = await record(url, [{ sel: '#accept' }, { sel: '#a' }, { sel: '#b' }, { sel: '#home' }]);
  await runN(t, 'fixed header/banner', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['accept', 'a', 'b', 'home']);
  });
});

test('e2e: sticky-сайдбар — після прокрутки клік першого екрана йде в записане посилання, а не в «прилиплий» (регресія)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/sticky.html';
  const acts = await record(url, [{ sel: '#low' }, { sel: '#l0' }]);
  await runN(t, 'sticky sidebar', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['low', 'l0']);
    assert.ok(!r.events.some((e) => e.event === 'log' && /Фіксований елемент/.test(e.text)));
  });
});

test('e2e: fixed-банер унизу на ВЖЕ прокрученій сторінці — клік у банер без прокрутки', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/banner.html';
  const acts = await record(url, [{ sel: '#acc' }, { sel: '#c' }]);
  await runN(t, 'scrolled fixed banner', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['acc', 'c']);
  }, { before: (page) => page.evaluate(() => window.scrollTo(0, 700)) });
});

test('e2e: дропдаун — ПЕРША опція за 20 px від відкривача (optionLike → довіра, без snap на відкривач)', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/dropdown.html';
  const [openA] = await record(url, [{ sel: '#open' }]);
  const optA1 = { ...openA, x: 150 * 2, y: (1236 + 1 + 0 * 30 + 15) * 2 };
  await runN(t, 'dropdown first option', url, [openA, optA1], async (r) => {
    doneOk(r);
    assert.equal(await r.page.evaluate(() => window.picked), 'UA');
    assert.equal(await r.page.evaluate(() => window.opened), 1);
    assert.equal(r.events.filter((e) => e.event === 'done-action')[1].strategy, 'coord');
  });
});

test('e2e: пункт з aria-selected (без role/класу option) за 16 px від відкривача — клік у пункт', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/option-near.html';
  const acts = await record(url, [{ sel: '#it0' }]);
  await runN(t, 'aria-selected option near opener', url, acts, async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['it0']);
  });
});

test('e2e: snap — дрейф на обгортку → кнопка; ближча кнопка під модалкою ігнорується; відкривач/disabled → без snap', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  const url = A + '/snap.html';
  const [a, b, c] = await record(url, [{ sel: '#b1', dy: 30 }, { x: 110, y: 440 }, { x: 110, y: 765 }]);
  const strat = (r) => r.events.filter((e) => e.event === 'done-action').map((e) => e.strategy);
  await runN(t, 'snap: wrapper drift', url, [a], async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['b1']);
    assert.deepEqual(strat(r), ['snap']);
  });
  await runN(t, 'snap: hidden under modal', url, [b], async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['vis']);
  });
  await runN(t, 'snap: expanded opener / disabled', url, [c], async (r) => {
    doneOk(r);
    assert.deepEqual(await r.page.evaluate(() => window.clicks), ['wrapC']);
    assert.deepEqual(strat(r), ['coord']);
  });
});

test('e2e: підсумок', (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  t.diagnostic(JSON.stringify(results));
});
