// Headless checks of the Markdown round trip: render, annotate, save, clean.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const app = path.resolve(process.argv[2] || path.join(__dirname, '..', 'web'));
const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', e => console.log('PAGE ERROR:', e.detail?.stack || e.stack || e.message));
vc.on('error', (...a) => console.log('console.error:', ...a));
const dom = new JSDOM(html, {
  url: 'file://' + app + '/index.html', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.document.execCommand = () => false;
    w.HTMLElement.prototype.scrollTo = function () {};
    w.Element.prototype.animate = () => {};
    w.HTMLDialogElement.prototype.showModal ||= function () {};
    w.Range.prototype.getBoundingClientRect ||= () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0 });
  },
});
const w = dom.window;
let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '\n' + extra)); if (!cond) fails++; };

w.addEventListener('load', () => setTimeout(() => {
  const m = w.__mdr, d = w.document, doc = d.getElementById('doc');
  if (!m) { console.log('FAIL app did not start'); process.exit(1); }
  const flush = () => new Promise(r => setTimeout(r, 30));

  (async () => {
    // 1. Welcome doc renders with annotations
    ok('welcome renders', doc.children.length > 10);
    ok('highlights parsed', doc.querySelectorAll('mark').length === 2);
    ok('green mark', !!doc.querySelector('mark[data-hl="green"]'));
    ok('note parsed', doc.querySelector('.mdr-note')?.dataset.note.startsWith('Sticky notes'));
    ok('bookmark parsed', doc.querySelector('.mdr-bm')?.dataset.label === 'Shortcuts live here');
    ok('sticky card built', d.querySelectorAll('.sticky').length === 1);
    ok('outline built', d.querySelectorAll('#outline a').length === 6, d.querySelectorAll('#outline a').length);
    ok('untouched = byte-identical', m.serialize() === w.WELCOME_MD);

    // 2. Messy source is preserved exactly when untouched, and only touched blocks change
    const src = [
      '---', 'title: Test', 'tags: [a, b]', '---', '',
      'Setext Heading', '==============', '',
      '* star bullet', '* another   with   spaces', '',
      'Para with [ref link][r] and trailing spaces.  ', 'second line', '',
      '<!-- a plain comment -->', '',
      '<details><summary>Raw</summary>html block</details>', '',
      '| a | b |', '|---|:-:|', '| 1 | 2 |', '',
      '```py', 'x = "==not a highlight=="', '```', '',
      'Final paragraph to edit.', '',
      '[r]: https://example.com', '',
    ].join('\n');
    m.renderDoc(src);
    ok('messy untouched = identical', m.serialize() === src);
    ok('no mark inside code', doc.querySelectorAll('mark').length === 0);
    const paras = [...doc.querySelectorAll(':scope > p')];
    const final = paras.at(-1);
    final.firstChild.data = 'Final paragraph, edited.';
    await flush();
    const out = m.serialize();
    ok('dirty flag set', m.state.dirty === true);
    ok('edit applied', out.includes('Final paragraph, edited.'));
    ok('front matter kept', out.startsWith('---\ntitle: Test\ntags: [a, b]\n---\n'));
    ok('setext kept verbatim', out.includes('Setext Heading\n=============='));
    ok('star bullets kept verbatim', out.includes('* another   with   spaces'));
    ok('comment kept', out.includes('<!-- a plain comment -->'));
    ok('raw html kept', out.includes('<details><summary>Raw</summary>html block</details>'));
    ok('table kept verbatim', out.includes('|---|:-:|'));
    ok('ref def kept', out.includes('[r]: https://example.com'));
    ok('only one line differs', src.split('\n').filter(l => !out.split('\n').includes(l)).length === 1, out);

    // 3. Highlighting a selection across inline formatting and blocks
    m.renderDoc('First **bold** word here.\n\nSecond paragraph with `code` inside.\n\n- item one\n- item two\n');
    const p1 = doc.children[0], p2 = doc.children[1];
    let r = d.createRange();
    r.setStart(p1.firstChild, 2);            // "rst **bold** wo"
    r.setEnd(p1.lastChild, 3);
    m.highlight(r, 'yellow');
    await flush();
    let md = m.serialize();
    ok('inline highlight', md.includes('Fi==rst **bold** wo==rd here.'), md);

    r = d.createRange();
    r.setStart(p2.firstChild, 7);            // across paragraph 2 into list
    r.setEnd(doc.querySelector('li').firstChild, 4);
    m.highlight(r, 'pink');
    await flush();
    md = m.serialize();
    ok('multi-block highlight p', md.includes('Second <mark data-hl="pink">paragraph with `code` inside.</mark>'), md);
    ok('multi-block highlight li', md.includes('- <mark data-hl="pink">item</mark> one'), md);

    // 4. Round trip: what we wrote parses back to the same thing
    m.renderDoc(md);
    ok('reparse marks', doc.querySelectorAll('mark').length === 3);
    ok('reparse stable', m.serialize() === md);

    // 5. Notes and bookmarks serialise, survive a round trip, and are removed by clean
    const mark = doc.querySelector('mark');
    const note = d.createElement('span');
    note.className = 'mdr-anchor mdr-note';
    note.dataset.color = 'blue';
    note.dataset.note = 'tricky --> "text" -- <b>';
    mark.after(note);
    const bm = d.createElement('span');
    bm.className = 'mdr-anchor mdr-bm';
    bm.dataset.label = 'Here';
    doc.querySelector('li').append(bm);
    await flush();
    md = m.serialize();
    ok('note comment written', md.includes('<!--mdr:note {"text":"tricky -\\u002d> \\"text\\" -\\u002d <b>","color":"blue"}-->'), md);
    ok('bookmark comment written', md.includes('<!--mdr:bookmark {"label":"Here"}-->'), md);
    m.renderDoc(md);
    ok('note round trip', doc.querySelector('.mdr-note')?.dataset.note === 'tricky --> "text" -- <b>');
    ok('note colour round trip', doc.querySelector('.mdr-note')?.dataset.color === 'blue');
    ok('bookmark round trip', doc.querySelector('.mdr-bm')?.dataset.label === 'Here');
    const clean = m.serialize(true);
    ok('clean has no annotations', !/==|<mark|mdr:/.test(clean), clean);
    ok('clean keeps text', clean.includes('First **bold** word here.') && clean.includes('- item one') && clean.includes('with `code` inside.'), clean);
    ok('clean leaves doc intact', doc.querySelectorAll('mark').length === 3);

    // 6. Annotation at the very start of a paragraph still parses as a paragraph
    m.renderDoc('<!--mdr:bookmark {"label":"x"}-->Leading **text**\n');
    ok('leading anchor paragraph', doc.children[0].tagName === 'P' && !!doc.querySelector('p > .mdr-bm') && !!doc.querySelector('p > strong'), doc.innerHTML);

    // 7. Task list toggle
    m.renderDoc('- [ ] todo\n- [x] done\n');
    const box = doc.querySelector('input');
    ok('checkbox enabled', !box.disabled);
    box.checked = true;
    box.dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush();
    md = m.serialize();
    ok('task toggled', md.includes('- [x] todo') && md.includes('- [x] done'), md);

    // 8. Source mode round trip
    m.renderDoc('# Title\n\nBody\n');
    m.setMode('source');
    const ta = d.getElementById('source');
    ok('source shows md', ta.value === '# Title\n\nBody\n');
    ta.value = '# Title\n\nBody changed\n\n## New\n';
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    m.setMode('read');
    ok('source commit renders', doc.querySelector('h2')?.textContent === 'New' && m.serialize() === ta.value);

    // 9. Sanitising
    m.renderDoc('Hello <img src=x onerror="window.pwned=1"> <script>window.pwned=1</script>\n\n[x](javascript:alert(1))\n');
    ok('xss stripped', !doc.innerHTML.includes('onerror') && !doc.querySelector('script') && !doc.innerHTML.includes('javascript:') && !w.pwned, doc.innerHTML);

    console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
    process.exit(fails ? 1 : 0);
  })().catch(e => { console.log('TEST CRASH', e); process.exit(1); });
}, 300));
