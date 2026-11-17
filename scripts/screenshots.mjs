// Regenerates the README screenshots in docs/images from the demo library in docs/demo.
// Needs Playwright:  npm i --no-save playwright && npx playwright install chromium
// Usage:             make build && node scripts/screenshots.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = name => path.join(root, 'docs', 'images', name + '.png');
const PORT = 4788;
const DOC = 'Essays/On Reading Slowly.md';

const server = spawn(path.join(root, 'mdmargin'), ['-no-open', '-port', String(PORT), path.join(root, 'docs', 'demo')], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch();

async function open(settings = {}, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(([s, doc]) => {
    localStorage.setItem('mdr.settings', JSON.stringify(s));
    localStorage.setItem('mdr.last', JSON.stringify(doc));
  }, [{ theme: 'light', font: 'serif', size: 18, leading: 1.7, width: 700, sidebar: true, ...settings }, DOC]);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.querySelector('#docName').textContent.includes('Reading Slowly'));
  await page.waitForTimeout(500);
  return page;
}
// Playwright's default caret hiding touches form controls, which the app would count as an edit.
const shot = (page, name) => page.screenshot({ path: out(name), caret: 'initial' });
// Selects a phrase the way a reader would, so the selection toolbar appears.
const select = (page, text) => page.evaluate(text => {
  const walker = document.createTreeWalker(document.querySelector('#doc'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(text);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + text.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return;
  }
}, text);

try {
  let page = await open();
  await shot(page, 'reader-light');

  await select(page, 'keeps the thought attached to the thing that caused it');
  await page.waitForTimeout(300);
  await shot(page, 'selection-toolbar');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.click('.tab[data-tab="marks"]');
  await page.waitForTimeout(200);
  await shot(page, 'marks-panel');
  await page.click('.tab[data-tab="outline"]');
  await page.click('#appearanceBtn');
  await page.waitForTimeout(200);
  await shot(page, 'appearance');
  await page.context().close();

  page = await open({ theme: 'dark' });
  await shot(page, 'reader-dark');
  await page.context().close();

  page = await open({ theme: 'sepia', font: 'newyork', size: 19 });
  await page.click('#focusBtn');
  await page.waitForTimeout(500);
  await shot(page, 'reading-mode');
  await page.context().close();

  page = await open();
  await page.click('#modeSeg [data-mode="source"]');
  await page.waitForTimeout(200);
  await shot(page, 'markdown-mode');
  await page.context().close();
} finally {
  await browser.close();
  server.kill();
}
