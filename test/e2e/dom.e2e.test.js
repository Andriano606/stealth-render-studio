// E2E (opt-in, E2E=1): зонди lib/dom.js на СПРАВЖНІЙ верстці Chrome (ізольований світ):
// вставки sticky-шапки/футера, нейтральна точка колеса, fixed vs sticky у hit-test,
// спуск у iframe з рамкою/паддінгом (in-process і out-of-process), фокус в iframe, snap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import * as dom from '../../lib/dom.js';
import { isoState } from '../../lib/isoworld.js';

const E2E = process.env.E2E === '1';
let browser, srv, port;
const PAGES = {
  '/child': '<body style="margin:0"><input id="ci" style="position:absolute;left:10px;top:10px;width:120px;height:24px"><button id="cb" style="position:absolute;left:10px;top:60px;width:100px;height:30px">CB</button></body>',
  '/host': (q) => '<body style="margin:0;height:2000px"><iframe id="f" src="' + q.get('child') + '" style="position:absolute;left:100px;top:100px;width:400px;height:200px;border:3px solid #000;padding:5px"></iframe></body>',
};
before(async () => {
  if (!E2E) return;
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = PAGES[u.pathname];
    if (!p) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(typeof p === 'function' ? p(u.searchParams) : p);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { if (browser) await browser.close(); if (srv) srv.close(); });

async function withPage(fn, html) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try { const page = await ctx.newPage(); if (html) await page.setContent(html); return await fn(page); } finally { await ctx.close(); }
}

test('e2e dom: measure — вставки sticky-шапки і fixed-футера; isoState активний у Chromium', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  await withPage(async (page) => {
    assert.ok(await isoState(page), 'очікую CDP-ізольований світ');
    await page.evaluate(() => window.scrollTo(0, 500));
    const m = await dom.measure(page);
    assert.equal(m.topInset, 70);
    assert.equal(m.bottomInset, 50);
    assert.equal(m.scrollY, 500);
    const m0 = await dom.measure(page, { insets: false });
    assert.deepEqual([m0.topInset, m0.bottomInset], [0, 0]);
  }, '<body style="margin:0;height:3000px"><header style="position:sticky;top:0;height:70px;background:#ccc">H</header><footer style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#ddd">F</footer></body>');
});

test('e2e dom: elementAt — fixed і sticky окремо; pickNeutralPoint обходить скролер, iframe, textarea', async (t) => {
  if (!E2E) return t.skip('E2E=1 не задано');
  await withPage(async (page) => {
    const f = await dom.elementAt(page, 50, 880);
    assert.deepEqual([f.tag, f.fixed, f.sticky, f.interactive], ['BUTTON', true, false, true]);
    const s = await dom.elementAt(page, 50, 8);
    assert.deepEqual([s.tag, s.fixed, s.sticky], ['A', false, true]);
    const pts = [{ x: 100, y: 300 }, { x: 400, y: 300 }, { x: 700, y: 300 }, { x: 1000, y: 300 }];
    assert.deepEqual(await dom.pickNeutralPoint(page, pts), { x: 1000, y: 300 });
  }, '<body style="margin:0;height:3000px">'
    + '<nav style="position:sticky;top:0;height:40px"><a href="#" style="display:block;width:100px">Sticky</a></nav>'
    + '<button style="position:fixed;left:0;bottom:0;width:120px;height:40px">Fixed</button>'
    + '<div style="position:absolute;left:0;top:200px;width:250px;height:200px;overflow:auto"><div style="height:900px">list</div></div>'
    + '<iframe style="position:absolute;left:300px;top:200px;width:250px;height:200px" srcdoc="x"></iframe>'
    + '<textarea style="position:absolute;left:600px;top:200px;width:250px;height:200px"></textarea>'
    + '<p style="position:absolute;left:900px;top:200px;width:250px">plain text</p></body>');
});

for (const [name, childHost] of [['in-process', '127.0.0.1'], ['out-of-process (крос-сайт)', 'localhost']]) {
  test('e2e dom: iframe ' + name + ' — elementAt спускається з урахуванням рамки/паддінгу; snap; фокус у полі iframe', async (t) => {
    if (!E2E) return t.skip('E2E=1 не задано');
    await withPage(async (page) => {
      await page.goto('http://127.0.0.1:' + port + '/host?child=' + encodeURIComponent('http://' + childHost + ':' + port + '/child'));
      await page.frameLocator('#f').locator('#cb').waitFor();
      // вміст iframe починається з (100+3+5, 100+3+5) = (108, 108); #cb — (10,60) 100×30 у фреймі
      const h = await dom.elementAt(page, 108 + 60, 108 + 75);
      assert.deepEqual([h.frame, h.tag, h.interactive], ['iframe', 'BUTTON', true]);
      const sn = await dom.snapToClickable(page, 108 + 60, 108 + 75 + 30, 60); // 15px нижче кнопки
      assert.deepEqual([sn.x, sn.y, sn.d], [108 + 60, 108 + 75, 15]);
      assert.equal(await dom.focusIsEditable(page), false);
      await page.frameLocator('#f').locator('#ci').focus();
      assert.equal(await dom.focusIsEditable(page), true);
      const texts = await dom.evalAllFrames(page, () => document.body.innerText);
      assert.ok(texts.some((x) => /CB/.test(x)), JSON.stringify(texts));
    });
  });
}
