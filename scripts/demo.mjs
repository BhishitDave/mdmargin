// Records the animated README demo (docs/images/demo.gif) by driving the real app with a real mouse and keyboard.
// Needs Playwright and ffmpeg:  npm i --no-save playwright && npx playwright install chromium
// Usage:                        make build && node scripts/demo.mjs
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4787;
const SIZE = { width: 1280, height: 800 };

// Work on a throwaway copy of the demo library, with the essay's annotations removed so the demo can add them.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmargin-demo-'));
const lib = path.join(work, 'Notes');
fs.cpSync(path.join(root, 'docs', 'demo'), lib, { recursive: true });
const essay = path.join(lib, 'Essays', 'On Reading Slowly.md');
fs.writeFileSync(essay, fs.readFileSync(essay, 'utf8')
  .replace(/ ?<!--mdr:[\s\S]*?-->/g, '').replace(/==(.+?)==/g, '$1').replace(/<mark[^>]*>(.*?)<\/mark>/g, '$1'));

const server = spawn(path.join(root, 'mdmargin'), ['-no-open', '-port', String(PORT), lib], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: work, size: SIZE } });
await ctx.addInitScript(() => {
  localStorage.setItem('mdr.settings', JSON.stringify({ theme: 'light', font: 'serif', size: 17, leading: 1.65, width: 620, sidebar: true }));
  localStorage.setItem('mdr.last', JSON.stringify('Essays/On Reading Slowly.md'));
  // Headless video has no pointer, so draw one.
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:9999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(180,83,42,.35);border:2px solid rgba(180,83,42,.9);pointer-events:none;left:-50px;top:-50px;transition:transform .1s';
    document.body.append(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });
});
const page = await ctx.newPage();
const pause = ms => page.waitForTimeout(ms);

// Screen coordinates of a phrase in the document.
const locate = text => page.evaluate(text => {
  const walker = document.createTreeWalker(document.querySelector('#doc'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(text);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + text.length);
    const rects = r.getClientRects(), a = rects[0], b = rects[rects.length - 1];
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
  }
  throw new Error('phrase not found: ' + text);
}, text);
async function dragSelect(text) {
  const p = await locate(text);
  await page.mouse.move(p.x1, p.y1, { steps: 18 });
  await page.mouse.down();
  await page.mouse.move(p.x2, p.y2, { steps: 28 });
  await page.mouse.up();
  await pause(500);
}
async function click(selector, wait = 500) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
  await pause(150);
  await page.mouse.down();
  await page.mouse.up();
  await pause(wait);
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.querySelector('#docName').textContent.includes('Reading Slowly'));
  await pause(1200);

  // Highlight
  await dragSelect('Slow reading is the opposite habit: staying with a page long enough for it to change your mind.');
  await click('#bubble .dot[data-hl="yellow"]', 700);

  // Sticky note
  await dragSelect('The annotation and its context travel together.');
  await click('#bubble [data-act="note"]', 400);
  await page.keyboard.type('Use this line in the intro.', { delay: 38 });
  await pause(700);

  // Bookmark
  await dragSelect('Readers have always written in books.');
  await click('#bubble [data-act="bookmark"]', 700);

  // Everything collected in the sidebar
  await click('.tab[data-tab="marks"]', 1300);

  // Edit in place and save
  await click('#modeSeg [data-mode="edit"]', 300);
  const end = await locate('a note to a future self.');
  await page.mouse.move(end.x2, end.y2, { steps: 16 });
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('End');
  await page.keyboard.type(' Writing is how reading becomes thinking.', { delay: 34 });
  await pause(500);
  await page.keyboard.press('Meta+s');
  await pause(1300);
  await click('#modeSeg [data-mode="read"]', 300);

  // Dark theme, then reading mode
  await click('#appearanceBtn', 500);
  await click('#themes [data-theme-opt="dark"]', 900);
  await page.keyboard.press('Escape');
  await click('#focusBtn', 1800);
} finally {
  const video = await page.video().path();
  await ctx.close();
  await browser.close();
  server.kill();
  const gif = path.join(root, 'docs', 'images', 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.6', '-i', video,
    '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    gif]);
  console.log('wrote', path.relative(root, gif), (fs.statSync(gif).size / 1e6).toFixed(1) + ' MB');
  console.log('--- saved essay ---\n' + fs.readFileSync(essay, 'utf8').split('\n').slice(0, 9).join('\n'));
  fs.rmSync(work, { recursive: true, force: true });
}
