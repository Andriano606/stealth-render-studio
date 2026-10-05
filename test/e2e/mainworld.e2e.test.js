// E2E (opt-in, E2E=1): read-only зонди відтворення НЕ видно в головному світі сторінки.
// Фікстура обгортає querySelectorAll/querySelector/elementFromPoint/elementsFromPoint/
// getComputedStyle/getBoundingClientRect/requestAnimationFrame/scrollTo/innerText і пише
// кожен виклик, у стеку якого видно Playwright-evaluate («UtilityScript», «eval at
// evaluate») — так робить bot-detector.rebrowser.net та антиботи. Після goto прогін
// prepareForInteraction(replay) + runReplay (snap із порожнечі, клік нижче екрана, fixed-
// шапка, фокус+текст, рух, кнопка в КРОС-САЙТОВОМУ iframe = out-of-process у Chrome)
// має дати 0 таких викликів — зонди йдуть у приватний ізольований світ (lib/isoworld.js).
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
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let srv, port, browser;
before(async () => {
  if (!E2E) return;
  srv = http.createServer((req, res) => {
    const f = path.join(FIX, path.basename(new URL(req.url, 'http://x').pathname));
    if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chrome', headless: true }); // ізоляція сайтів — дефолтна (OOPIF)
});
after(async () => { if (browser) await browser.close(); if (srv) srv.close(); });

// Журнали обгорток з усіх фреймів (читання — з вимкненими обгортками).
async function drain(page) {
  const out = [];
  for (const f of page.frames()) {
    const l = await f.evaluate(() => { window.__mwOff = true; const r = (window.__mw || []).splice(0); window.__mwOff = false; return r; }).catch(() => []);
    out.push(...l);
  }
  return out;
}
const count = (l) => l.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});

for (const humanize of [false, true]) {
  test('e2e: відтворення координатних кліків — 0 викликів обгорток із Playwright-стеком (humanize ' + (humanize ? 'on' : 'off') + ')', async (t) => {
    if (!E2E) return t.skip('E2E=1 не задано');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await ctx.newPage();
      // localhost ≠ 127.0.0.1 — різні сайти → iframe в окремому процесі (OOPIF)
      await gotoSmart(page, 'http://127.0.0.1:' + port + '/mainworld.html?child=' + encodeURIComponent('http://localhost:' + port + '/mainworld-child.html'));
      await page.waitForFunction(() => document.getElementById('f').contentWindow && document.getElementById('f').src, null, { timeout: 5000 });
      await page.frameLocator('#f').locator('#cb').waitFor();
      // Санітарна перевірка: обгортки справді ловлять evaluate у головному світі.
      await drain(page);
      await page.evaluate(() => document.elementFromPoint(1, 1));
      assert.deepEqual(await drain(page), ['efp|PW']);

      await prepareForInteraction(page, { mode: 'replay', humanize, rng: mulberry32(5) });
      const actions = [
        { type: 'click', x: 230, y: 215, gid: 1 },   // порожнеча праворуч від #near → snap
        { type: 'click', x: 200, y: 315, gid: 1 },   // #inp
        { type: 'text', text: 'abc', gid: 1 },       // legacy-текст → перевірка фокусу
        { type: 'move', x: 50, y: 500, gid: 1 },
        { type: 'click', x: 150, y: 2015, gid: 1 },  // нижче екрана → прокрутка + settle
        { type: 'click', x: 70, y: 30, gid: 1 },     // fixed-шапка на прокрученій сторінці
        { type: 'click', x: 472, y: 187, gid: 1 },   // кнопка в OOPIF (рамка 2px)
      ];
      const events = [];
      const res = await runReplay(page, actions, { send: (e) => events.push(e), humanize, resolveUpload: () => null, rng: mulberry32(7) });
      const log = await drain(page);
      t.diagnostic('виклики обгорток: ' + JSON.stringify(count(log)));
      assert.equal(res.replayed, actions.length, JSON.stringify(events.filter((e) => e.event === 'done-action')));
      assert.deepEqual(await page.evaluate(() => window.clicks), ['near', 'inp', 'low', 'home']);
      const child = page.frames().find((f) => f !== page.mainFrame() && /mainworld-child/.test(f.url()));
      assert.deepEqual(await child.evaluate(() => window.clicks), ['cb']);
      await ctx.newCDPSession(child); // кидає для in-process фрейму → тут справді OOPIF
      assert.equal(await page.inputValue('#inp'), 'abc');
      assert.equal(events.filter((e) => e.event === 'done-action')[0].strategy, 'snap');
      assert.deepEqual(log.filter((x) => x.endsWith('|PW')), [], 'зонди видно в головному світі: ' + JSON.stringify(count(log)));
    } finally { await ctx.close(); }
  });
}
