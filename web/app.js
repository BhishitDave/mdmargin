(() => {
'use strict';

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const unwrap = node => node.replaceWith(...node.childNodes);
const excerpt = (node, n = 80) => {
  const t = (node?.textContent || '').trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('mdr.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mdr.' + k, JSON.stringify(v)); } catch {} },
};
// Directory handles can't go in localStorage, so the last folder is kept in IndexedDB.
const idb = {
  open() {
    return this.db ||= new Promise((res, rej) => {
      const r = indexedDB.open('mdreader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } catch { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      db.transaction('kv', 'readwrite').objectStore('kv').put(v, k);
    } catch {}
  },
};

const el = {
  doc: $('#doc'), source: $('#source'), page: $('#page'), scroller: $('#scroller'), main: $('#main'),
  notes: $('#notesLayer'), bubble: $('#bubble'), tree: $('#tree'), outline: $('#outline'), marks: $('#marks'),
  appearance: $('#appearance'), menu: $('#menu'), dialog: $('#confirm'), toast: $('#toast'),
};

const COLORS = ['yellow', 'green', 'pink', 'blue'];
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote';
const MD_RE = /\.(md|markdown|mdx|txt)$/i;
const MD_TYPE = { description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } };

const state = {
  mode: 'read', name: 'Welcome.md', path: null, handle: null, dirty: false,
  src: '', frontMatter: '', lead: '', defs: [], count: 0, sourceTouched: false,
  root: null, rootName: '', entries: [], blobUrls: [],
  server: null, remote: false, // set when served by the mdmargin binary, which reads and writes files for us
};

const api = (url, opts = {}) => fetch(url, { ...opts, headers: { 'X-Mdmargin': '1', ...opts.headers } });
const fileUrl = (path, extra = '') => `/api/file?path=${encodeURIComponent(path)}${extra}`;
async function apiOk(res) {
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
  return res;
}
const serverLibrary = () => !!state.server && !state.root && state.entries.every(e => e.remote);

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

function ask({ title, text = '', input = null, actions }) {
  return new Promise(res => {
    const dlg = el.dialog, box = $('#confirmActions');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmText').classList.toggle('hidden', !text);
    $('input', dlg)?.remove();
    box.replaceChildren();
    let field = null, primary = null;
    if (input !== null) {
      field = document.createElement('input');
      field.type = 'text';
      field.value = input;
      box.before(field);
    }
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
      b.textContent = a.label;
      b.onclick = () => { res({ value: a.value, text: field ? field.value : '' }); dlg.close(); };
      if (a.primary) primary = b;
      box.append(b);
    }
    if (field) field.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); primary?.click(); } };
    dlg.onclose = () => res({ value: null, text: '' });
    dlg.showModal();
    field ? field.select() : primary?.focus();
  });
}

/* ---------- Markdown in ---------- */
// Annotations live in the file: ==text== / <mark data-hl> for highlights,
// <!--mdr:note {...}--> and <!--mdr:bookmark {...}--> for notes and bookmarks.
const ANCHOR_RE = /^<!--mdr:(note|bookmark) ([\s\S]*?)-->/;

function anchorHTML(kind, data) {
  if (kind === 'note') {
    const color = COLORS.includes(data.color) ? data.color : 'yellow';
    return `<span class="mdr-anchor mdr-note" data-color="${color}" data-n="${encodeURIComponent(data.text || '')}"></span>`;
  }
  return `<span class="mdr-anchor mdr-bm" data-n="${encodeURIComponent(data.label || '')}"></span>`;
}
function anchorComment(node) {
  const isNote = node.classList.contains('mdr-note');
  const data = isNote
    ? { text: node.getAttribute('data-note') || '', color: node.getAttribute('data-color') || 'yellow' }
    : { label: node.getAttribute('data-label') || '' };
  // "--" would end the comment early, so it is written as a JSON escape.
  return `<!--mdr:${isNote ? 'note' : 'bookmark'} ${JSON.stringify(data).replace(/--/g, '-\\u002d')}-->`;
}

marked.use({
  gfm: true,
  extensions: [
    {
      name: 'mdrMark', level: 'inline',
      start(src) { return src.indexOf('=='); },
      tokenizer(src) {
        const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
        if (m) return { type: 'mdrMark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(tok) { return `<mark data-hl="yellow">${this.parser.parseInline(tok.tokens)}</mark>`; },
    },
    {
      name: 'mdrAnchor', level: 'inline',
      start(src) { return src.indexOf('<!--mdr:'); },
      tokenizer(src) {
        const m = ANCHOR_RE.exec(src);
        if (!m) return;
        let data;
        try { data = JSON.parse(m[2]); } catch { data = { text: m[2], label: m[2] }; }
        return { type: 'mdrAnchor', raw: m[0], kind: m[1], data };
      },
      renderer(tok) { return anchorHTML(tok.kind, tok.data); },
    },
    {
      // A paragraph that starts with an annotation comment would otherwise be read as a raw HTML block.
      name: 'mdrLead', level: 'block',
      tokenizer(src) {
        if (!/^ {0,3}<!--mdr:(note|bookmark) /.test(src)) return;
        const raw = /^(?:[^\n]+\n?)+/.exec(src)[0];
        const token = { type: 'paragraph', raw, text: raw.trim(), tokens: [] };
        this.lexer.inline(token.text, token.tokens);
        return token;
      },
    },
  ],
});

const PURIFY = { FORBID_TAGS: ['style', 'form', 'iframe'] };
const sanitize = html => DOMPurify.sanitize(html, PURIFY);

function renderDoc(src) {
  observer.disconnect();
  state.blobUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  state.src = src;
  let body = src.replace(/\r\n?/g, '\n');
  const fm = /^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(body);
  state.frontMatter = fm ? fm[0] : '';
  if (fm) body = body.slice(fm[0].length);
  state.lead = '';
  state.defs = [];

  // Each top-level block remembers its exact source so untouched blocks are saved back verbatim.
  const frag = document.createDocumentFragment();
  const tpl = document.createElement('template');
  let last = null, i = 0;
  const invisible = raw => { if (last) last._mdr.tail += raw; else state.lead += raw; };
  let pos = 0;
  for (const tok of marked.lexer(body)) {
    // The lexer swallows link reference definitions; whatever it skipped is kept and re-added on save.
    const at = body.indexOf(tok.raw, pos);
    if (at > pos && body.slice(pos, at).trim()) state.defs.push(body.slice(pos, at).trim());
    if (at >= 0) pos = at + tok.raw.length;
    if (tok.type === 'space') { invisible(tok.raw); continue; }
    tpl.innerHTML = sanitize(marked.parser([tok]));
    const nodes = [...tpl.content.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim());
    if (!nodes.length) { invisible(tok.raw); continue; }
    let node = nodes[0];
    if (tok.type === 'html' || nodes.length > 1 || node.nodeType !== 1) {
      node = document.createElement('div');
      node.className = 'mdr-html';
      node.contentEditable = 'false';
      node.append(...nodes);
    }
    node._mdr = { raw: tok.raw, tail: '', i: i++ };
    frag.append(node);
    last = node;
  }
  if (body.slice(pos).trim()) state.defs.push(body.slice(pos).trim());
  state.count = i;
  prepare(frag);
  el.doc.replaceChildren(frag);
  watch();
  refresh();
  resolveImages();
}

function prepare(root) {
  // Annotation text travels URI-encoded through the sanitiser, which drops attributes containing "-->".
  $$('.mdr-anchor', root).forEach(a => {
    let text = '';
    try { text = decodeURIComponent(a.dataset.n || ''); } catch {}
    a.dataset[a.classList.contains('mdr-note') ? 'note' : 'label'] = text;
    delete a.dataset.n;
    a.contentEditable = 'false';
  });
  $$('input[type="checkbox"]', root).forEach(c => c.removeAttribute('disabled'));
}

/* ---------- Markdown out ---------- */
const td = new TurndownService({
  headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced',
  emDelimiter: '*', strongDelimiter: '**',
  blankReplacement(content, node) {
    if (node.classList && node.classList.contains('mdr-anchor')) return anchorComment(node);
    if (content.includes('<!--mdr:')) return node.isBlock ? `\n\n${content.trim()}\n\n` : content;
    return node.isBlock ? '\n\n' : '';
  },
});
td.use(turndownPluginGfm.gfm);
td.keep(['kbd', 'sub', 'sup', 'u', 'details', 'summary']);
td.addRule('strike', { filter: ['del', 's', 'strike'], replacement: c => `~~${c}~~` });
td.addRule('mark', {
  filter: 'mark',
  replacement(content, node) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
    if (!m[2]) return content;
    const c = node.getAttribute('data-hl');
    const body = c && c !== 'yellow' ? `<mark data-hl="${c}">${m[2]}</mark>` : `==${m[2]}==`;
    return m[1] + body + m[3];
  },
});
td.addRule('img', {
  filter: 'img',
  replacement(content, node) {
    const src = node.getAttribute('data-mdr-src') || node.getAttribute('src') || '';
    const title = node.getAttribute('title');
    return src ? `![${node.getAttribute('alt') || ''}](${src}${title ? ` "${title}"` : ''})` : '';
  },
});
td.addRule('li', {
  filter: 'li',
  replacement(content, node, options) {
    const parent = node.parentNode;
    let prefix = options.bulletListMarker + ' ';
    if (parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = (start ? Number(start) + index : index + 1) + '. ';
    }
    content = content.replace(/^\n+/, '').replace(/^(\[[ x]\]) +/, '$1 ').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
    return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
  },
});

const hasAnnotations = node => node.matches('mark,.mdr-anchor') || !!node.querySelector('mark,.mdr-anchor');
function stripAnnotations(root) {
  $$('.mdr-anchor', root).forEach(a => a.remove());
  $$('mark', root).forEach(unwrap);
  root.normalize();
}
function blockToMd(node, clean) {
  if (clean) { node = node.cloneNode(true); stripAnnotations(node); }
  return td.turndown(node.outerHTML).trim();
}

function serialize(clean = false) {
  let out = state.frontMatter + state.lead;
  let lastI = -1, lastExact = true, allExact = true, n = 0;
  const push = text => { out = out.replace(/\n+$/, ''); out += (out ? '\n\n' : '') + text; };
  for (const node of el.doc.childNodes) {
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (t) { push(t); lastExact = allExact = false; }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const m = node._mdr;
    const exact = m && (node.classList.contains('mdr-html') || (!node._dirty && !(clean && hasAnnotations(node))));
    if (exact) {
      if (lastExact && m.i === lastI + 1) out += m.raw;
      else { push(m.raw); allExact = false; }
      out += m.tail;
      lastI = m.i;
      lastExact = true;
      n++;
    } else {
      const md = blockToMd(node, clean);
      if (md) push(md);
      if (m && m.tail.trim()) push(m.tail.trim());
      lastExact = allExact = false;
    }
  }
  if (allExact && n === state.count) return state.src;
  if (state.defs.length) push(state.defs.join('\n'));
  return out.replace(/\n*$/, '\n');
}

function currentMarkdown(clean = false) {
  if (state.mode !== 'source') return serialize(clean);
  if (!clean) return el.source.value;
  commitSource();
  return serialize(true);
}

/* ---------- Change tracking ---------- */
function onMutations(records) {
  let changed = false;
  for (const r of records) {
    if (r.target === el.doc && r.type === 'attributes') continue;
    let n = r.target;
    while (n && n.parentNode !== el.doc) n = n.parentNode;
    if (n && n.nodeType === 1) n._dirty = true;
    changed = true;
  }
  if (changed) { setDirty(true); scheduleRefresh(); }
}
const observer = new MutationObserver(onMutations);
const watch = () => observer.observe(el.doc, { subtree: true, childList: true, characterData: true, attributes: true });
// For cosmetic DOM changes that must not count as edits.
function quiet(fn) {
  onMutations(observer.takeRecords());
  fn();
  observer.takeRecords();
}

function setDirty(v) {
  state.dirty = v;
  $('#dirtyDot').classList.toggle('hidden', !v);
  $('#saveBtn').classList.toggle('hidden', !v);
}

function refresh() { buildOutline(); buildMarks(); syncNotes(); }
const scheduleRefresh = debounce(refresh, 180);

/* ---------- Outline ---------- */
let outlineItems = [];
function buildOutline() {
  const heads = $$('h1,h2,h3,h4,h5,h6', el.doc).filter(h => h.textContent.trim());
  el.outline.replaceChildren();
  outlineItems = heads.map(h => {
    const a = document.createElement('a');
    a.dataset.l = h.tagName[1];
    a.textContent = h.textContent.trim();
    a.onclick = () => jumpTo(h);
    el.outline.append(a);
    return { h, a };
  });
  if (!heads.length) el.outline.innerHTML = '<p class="hint">Headings in this document will appear here.</p>';
  updateOutlineActive();
}
function updateOutlineActive() {
  const line = el.scroller.getBoundingClientRect().top + 110;
  let current = null;
  for (const it of outlineItems) {
    if (it.h.getBoundingClientRect().top <= line) current = it; else break;
  }
  for (const it of outlineItems) it.a.classList.toggle('active', it === current);
}
function jumpTo(node) {
  if (state.mode === 'source') setMode('read');
  const top = node.getBoundingClientRect().top - el.scroller.getBoundingClientRect().top + el.scroller.scrollTop - 84;
  el.scroller.scrollTo({ top, behavior: 'smooth' });
  const target = node.closest(BLOCKS) || node;
  target.animate?.([{ backgroundColor: 'rgba(180, 83, 42, .2)' }, { backgroundColor: 'transparent' }], { duration: 1300, easing: 'ease-out' });
}

/* ---------- Marks panel ---------- */
function markItem(text, sub, color, onJump, onRemove) {
  const item = document.createElement('div');
  item.className = 'mark-item';
  if (color) item.style.setProperty('--c', color);
  item.append(text || '(empty)');
  if (sub) { const s = document.createElement('small'); s.textContent = sub; item.append(s); }
  const x = document.createElement('button');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'Remove';
  x.onclick = e => { e.stopPropagation(); onRemove(); };
  item.append(x);
  item.onclick = onJump;
  return item;
}
function buildMarks() {
  const box = el.marks;
  box.replaceChildren();
  const section = (title, items) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'marks-title';
    h.textContent = `${title} · ${items.length}`;
    box.append(h, ...items);
  };
  section('Bookmarks', $$('.mdr-bm', el.doc).map(a =>
    markItem(a.dataset.label || excerpt(a.closest(BLOCKS), 60), a.dataset.label ? excerpt(a.closest(BLOCKS), 60) : '', 'var(--accent)',
      () => jumpTo(a), () => a.remove())));
  section('Notes', $$('.mdr-note', el.doc).map(a => {
    const prev = a.previousElementSibling;
    const context = prev?.matches('mark') ? prev : a.closest(BLOCKS);
    return markItem(a.dataset.note || 'Empty note', excerpt(context, 60), `var(--note-${a.dataset.color || 'yellow'})`,
      () => { jumpTo(a); openNote(a); }, () => a.remove());
  }));
  section('Highlights', $$('mark', el.doc).map(m =>
    markItem(excerpt(m, 110), '', `var(--hl-${m.dataset.hl || 'yellow'})`, () => jumpTo(m), () => unwrap(m))));
  if (!box.children.length) {
    box.innerHTML = '<p class="hint">Select text to highlight it or pin a sticky note. Bookmarks, notes and highlights are collected here.</p>';
  }
}

/* ---------- Highlights ---------- */
function selRange() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  return el.doc.contains(r.commonAncestorContainer) ? r : null;
}
function marksInRange(range) {
  return $$('mark', el.doc).filter(m => range.intersectsNode(m));
}

// Wraps the range in <mark>, one per block, and returns the last mark created.
function highlight(range, color) {
  const walker = document.createTreeWalker(el.doc, NodeFilter.SHOW_TEXT);
  const runs = [];
  let run = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!range.intersectsNode(t)) { if (runs.length && range.comparePoint(t, 0) > 0) break; continue; }
    const parent = t.parentElement;
    if (parent.closest('pre,.mdr-html,.mdr-anchor')) continue;
    const start = t === range.startContainer ? range.startOffset : 0;
    const end = t === range.endContainer ? range.endOffset : t.length;
    if (end <= start || !t.data.slice(start, end).trim()) continue;
    const block = parent.closest(BLOCKS) || el.doc;
    if (run && run.block === block) { run.last = t; run.end = end; }
    else runs.push(run = { block, first: t, start, last: t, end });
  }
  let lastMark = null;
  for (const { first, start, last, end } of runs) {
    const r = document.createRange();
    r.setStart(first, start);
    r.setEnd(last, end);
    // Markdown can't express a highlight that starts or stops partway through code or another highlight.
    const a = first.parentElement.closest('code,mark'), b = last.parentElement.closest('code,mark');
    if (a && a === b && a.matches('mark')) { a.dataset.hl = color; lastMark = a; continue; }
    if (a) r.setStartBefore(a);
    if (b) r.setEndAfter(b);
    const frag = r.extractContents();
    $$('mark', frag).forEach(unwrap);
    const mark = document.createElement('mark');
    mark.dataset.hl = color;
    mark.append(frag);
    r.insertNode(mark);
    for (const sib of [mark.previousSibling, mark.nextSibling]) {
      if (sib && sib.nodeType === 1 && !sib.textContent && !sib.matches('br,img,input,.mdr-anchor') && !sib.querySelector('img,br')) sib.remove();
    }
    mark.parentNode.normalize();
    lastMark = mark;
  }
  return lastMark;
}

/* ---------- Bookmarks ---------- */
function toggleBookmark(block) {
  if (!block) return toast('Nothing to bookmark here');
  const existing = $(':scope > .mdr-bm', block);
  if (existing) { existing.remove(); return toast('Bookmark removed'); }
  const a = document.createElement('span');
  a.className = 'mdr-anchor mdr-bm';
  a.dataset.label = '';
  a.contentEditable = 'false';
  const nested = $(':scope > ul, :scope > ol', block);
  if (nested) nested.before(a); else block.append(a);
  toast('Bookmarked');
}
function visibleBlock() {
  const line = el.scroller.getBoundingClientRect().top + 70;
  return $$('p,h1,h2,h3,h4,h5,h6,li,td', el.doc)
    .find(b => !b.closest('.mdr-html') && !b.querySelector('p') && b.getBoundingClientRect().bottom > line);
}
function bookmarkHere() {
  if (state.mode === 'source') return toast('Switch to Read or Edit to bookmark');
  const s = getSelection();
  const node = s.rangeCount && el.doc.contains(s.anchorNode) ? s.anchorNode : null;
  const from = node && (node.nodeType === 1 ? node : node.parentElement);
  toggleBookmark((from && from !== el.doc && from.closest(BLOCKS)) || visibleBlock());
}
async function editBookmark(a) {
  const r = await ask({
    title: 'Bookmark', text: 'Give this bookmark a label, or leave it blank to use the text beside it.',
    input: a.dataset.label || '',
    actions: [{ label: 'Remove', value: 'remove', danger: true }, { label: 'Cancel', value: null }, { label: 'Done', value: 'ok', primary: true }],
  });
  if (r.value === 'remove') a.remove();
  else if (r.value === 'ok' && r.text !== (a.dataset.label || '')) a.dataset.label = r.text.trim();
}

/* ---------- Sticky notes ---------- */
const cards = new Map();
const autosize = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

function addNote(after) {
  const a = document.createElement('span');
  a.className = 'mdr-anchor mdr-note';
  a.dataset.color = 'yellow';
  a.dataset.note = '';
  a.contentEditable = 'false';
  after.after(a);
  syncNotes();
  openNote(a);
}
function makeCard(a) {
  const card = document.createElement('div');
  card.className = 'sticky';
  card.dataset.color = a.dataset.color || 'yellow';
  card.innerHTML = `<div class="sticky-bar">${COLORS.map(c => `<i data-c="${c}" title="${c}"></i>`).join('')}<button title="Delete note">×</button></div><textarea placeholder="Write a note…"></textarea>`;
  const ta = $('textarea', card);
  ta.value = a.dataset.note || '';
  ta.addEventListener('input', () => { a.dataset.note = ta.value; autosize(ta); layoutNotes(); });
  card.addEventListener('click', e => {
    const c = e.target.dataset.c;
    if (c) { a.dataset.color = c; card.dataset.color = c; }
    else if (e.target.tagName === 'BUTTON') a.remove();
  });
  card.addEventListener('mouseenter', () => quiet(() => a.classList.add('lit')));
  card.addEventListener('mouseleave', () => quiet(() => a.classList.remove('lit')));
  el.notes.append(card);
  return card;
}
function syncNotes() {
  const anchors = new Set($$('.mdr-note', el.doc));
  for (const [a, card] of cards) if (!anchors.has(a)) { card.remove(); cards.delete(a); }
  for (const a of anchors) if (!cards.has(a)) cards.set(a, makeCard(a));
  layoutNotes();
}
function layoutNotes() {
  el.notes.classList.toggle('hidden', state.mode === 'source');
  if (state.mode === 'source') return;
  // Notes sit in the right margin when there is room; the page shifts left a little to make it.
  const free = el.scroller.clientWidth - el.page.offsetWidth;
  const wide = cards.size > 0 && free >= 300;
  el.page.classList.toggle('narrow', !wide);
  el.page.style.marginLeft = wide && free / 2 < 266 ? (free - 266) + 'px' : '';
  const top0 = el.page.getBoundingClientRect().top;
  const items = [...cards].map(([a, card]) => ({ card, top: a.getBoundingClientRect().top - top0 })).sort((x, y) => x.top - y.top);
  let floor = 0;
  for (const { card, top } of items) {
    if (!wide) { card.style.top = (top + 28) + 'px'; continue; }
    autosize($('textarea', card));
    const y = Math.max(top - 10, floor);
    card.style.top = y + 'px';
    floor = y + card.offsetHeight + 10;
  }
}
function openNote(a) {
  const card = cards.get(a);
  if (!card) return;
  if (el.page.classList.contains('narrow')) {
    const open = !card.classList.contains('open');
    $$('.sticky.open', el.notes).forEach(c => c.classList.remove('open'));
    card.classList.toggle('open', open);
    if (!open) return;
    autosize($('textarea', card));
  }
  $('textarea', card).focus({ preventScroll: true });
}

/* ---------- Selection bubble ---------- */
let bubbleMark = null;
function showBubble(rect, mark = null) {
  bubbleMark = mark;
  const b = el.bubble;
  const r = selRange();
  b.classList.toggle('on-mark', !!mark || (!!r && marksInRange(r).length > 0));
  b.classList.toggle('editing', state.mode === 'edit' && !mark);
  b.classList.remove('hidden');
  const w = b.offsetWidth, h = b.offsetHeight;
  let top = rect.top - h - 10;
  if (top < 8) top = rect.bottom + 10;
  b.style.top = top + 'px';
  b.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
}
function hideBubble() { bubbleMark = null; el.bubble.classList.add('hidden'); }
function updateBubble() {
  if (state.mode === 'source') return;
  const r = selRange();
  if (r && r.toString().trim()) showBubble(r.getBoundingClientRect());
  else if (!bubbleMark) hideBubble();
}

function toggleCode(range) {
  const c = range.commonAncestorContainer;
  const inCode = (c.nodeType === 1 ? c : c.parentElement).closest('code');
  if (inCode && !inCode.closest('pre')) return unwrap(inCode);
  const code = document.createElement('code');
  code.textContent = range.toString();
  range.deleteContents();
  range.insertNode(code);
}

el.bubble.addEventListener('mousedown', e => e.preventDefault());
el.bubble.addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const range = selRange(), mark = bubbleMark, act = btn.dataset.act, color = btn.dataset.hl;
  if (!range && !mark) return hideBubble();
  if (color) {
    if (mark) mark.dataset.hl = color;
    else if (!highlight(range, color)) toast('Code blocks can’t be highlighted');
  } else if (act === 'unmark') {
    (mark ? [mark] : marksInRange(range)).forEach(unwrap);
    el.doc.normalize();
  } else if (act === 'note') {
    const target = mark || highlight(range, 'yellow');
    if (target) addNote(target); else toast('Code blocks can’t hold notes');
  } else if (act === 'bookmark') {
    const from = mark || (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
    toggleBookmark(from.closest(BLOCKS));
  } else if (act === 'bold' || act === 'italic') {
    document.execCommand(act);
    return;
  } else if (act === 'code') {
    toggleCode(range);
  } else if (act === 'link') {
    const saved = range.cloneRange();
    const r = await ask({ title: 'Link', input: 'https://', actions: [{ label: 'Cancel', value: null }, { label: 'Add link', value: 'ok', primary: true }] });
    if (r.value !== 'ok' || !r.text.trim()) return;
    getSelection().removeAllRanges();
    getSelection().addRange(saved);
    document.execCommand('createLink', false, r.text.trim());
  }
  getSelection().removeAllRanges();
  hideBubble();
});
document.addEventListener('mouseup', () => setTimeout(updateBubble, 0));
document.addEventListener('keyup', e => { if (e.shiftKey || e.key.startsWith('Arrow')) updateBubble(); });
document.addEventListener('mousedown', e => {
  if (!el.bubble.contains(e.target)) hideBubble();
  for (const pop of [el.appearance, el.menu]) {
    if (!pop.contains(e.target) && !e.target.closest('#appearanceBtn,#menuBtn')) pop.classList.add('hidden');
  }
});

/* ---------- Document interactions ---------- */
const slug = t => t.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function resolvePath(base, rel) {
  const segs = (base || '').split('/').slice(0, -1);
  let clean = rel.split(/[?#]/)[0];
  try { clean = decodeURIComponent(clean); } catch {}
  for (const part of clean.split('/')) {
    if (part === '..') segs.pop();
    else if (part && part !== '.') segs.push(part);
  }
  return segs.join('/');
}
function followLink(href) {
  if (href.startsWith('#')) {
    const id = slug(decodeURIComponent(href.slice(1)));
    const h = outlineItems.find(it => slug(it.h.textContent) === id);
    return h ? jumpTo(h.h) : undefined;
  }
  if (/^(https?:|mailto:)/i.test(href)) return void window.open(href, '_blank', 'noopener');
  if (/^[a-z][\w+.-]*:/i.test(href)) return;
  const entry = state.entries.find(e => e.path === resolvePath(state.path, href));
  if (entry) openEntry(entry); else toast('That file isn’t in the open folder');
}

el.doc.addEventListener('click', e => {
  const link = e.target.closest('a[href]');
  if (link) {
    if (state.mode === 'edit' && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    return followLink(link.getAttribute('href'));
  }
  const anchor = e.target.closest('.mdr-anchor');
  if (anchor) return anchor.classList.contains('mdr-note') ? openNote(anchor) : editBookmark(anchor);
  const mark = e.target.closest('mark');
  if (mark && getSelection().isCollapsed) showBubble(mark.getBoundingClientRect(), mark);
});
el.doc.addEventListener('change', e => {
  if (e.target.matches('input[type="checkbox"]')) e.target.toggleAttribute('checked', e.target.checked);
});

/* ---------- Editing ---------- */
const exec = (cmd, value) => document.execCommand(cmd, false, value);
function caretIn(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function newPara() {
  const p = document.createElement('p');
  p.append(document.createElement('br'));
  return p;
}
function topBlock() {
  let n = getSelection().anchorNode;
  if (!n || !el.doc.contains(n) || n === el.doc) return null;
  while (n.parentNode !== el.doc) n = n.parentNode;
  return n.nodeType === 1 ? n : null;
}

// Markdown shortcuts: "# ", "- ", "1. ", "> " at the start of a paragraph.
el.doc.addEventListener('input', e => {
  if (state.mode !== 'edit' || e.inputType !== 'insertText' || e.data !== ' ') return;
  const s = getSelection(), node = s.anchorNode;
  if (!s.isCollapsed || !node || node.nodeType !== 3) return;
  const block = node.parentElement;
  if (block.tagName !== 'P' || block.parentElement !== el.doc || node !== block.firstChild) return;
  const m = /^(#{1,6}|[-*+]|1[.)]|>) $/.exec(node.data.slice(0, s.anchorOffset).replace(/ /g, ' '));
  if (!m) return;
  node.deleteData(0, s.anchorOffset);
  if (!block.textContent) block.replaceChildren(document.createElement('br'));
  caretIn(block);
  const k = m[1];
  if (k[0] === '#') exec('formatBlock', 'h' + k.length);
  else if (k === '>') exec('formatBlock', 'blockquote');
  else exec(k[0] === '1' ? 'insertOrderedList' : 'insertUnorderedList');
});

el.doc.addEventListener('keydown', e => {
  if (state.mode !== 'edit' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const block = topBlock();
  if (!block) return;
  if (block.tagName === 'P') {
    const t = block.textContent.trim();
    const fence = /^```([\w+-]*)$/.exec(t);
    if (fence) {
      e.preventDefault();
      const pre = document.createElement('pre'), code = document.createElement('code');
      if (fence[1]) code.className = 'language-' + fence[1];
      code.append(document.createElement('br'));
      pre.append(code);
      const after = newPara();
      block.replaceWith(pre, after);
      return caretIn(code);
    }
    if (t === '---' || t === '***') {
      e.preventDefault();
      const p = newPara();
      block.replaceWith(document.createElement('hr'), p);
      return caretIn(p);
    }
  }
  // ⌘Enter always starts a fresh paragraph below, which is the way out of code blocks and quotes.
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    const p = newPara();
    block.after(p);
    caretIn(p);
  }
});

el.doc.addEventListener('paste', e => {
  if (state.mode !== 'edit') return;
  e.preventDefault();
  const html = e.clipboardData.getData('text/html'), text = e.clipboardData.getData('text/plain');
  const anchor = getSelection().anchorNode;
  const inPre = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement).closest('pre');
  if (!html || inPre) return exec('insertText', text);
  const md = td.turndown(sanitize(html));
  const multi = /\n\s*\n|^\s*(#{1,6}|[-*+>]|\d+\.)\s/m.test(md);
  exec('insertHTML', sanitize(multi ? marked.parse(md) : marked.parseInline(md)));
});

// Clicking the empty space under the last block gives you somewhere to type.
el.page.addEventListener('click', e => {
  if (state.mode !== 'edit' || (e.target !== el.page && e.target !== el.doc)) return;
  const last = el.doc.lastElementChild;
  if (last && e.clientY < last.getBoundingClientRect().bottom) return;
  let p = last;
  if (!last || last.tagName !== 'P' || last.textContent.trim()) { p = newPara(); el.doc.append(p); }
  el.doc.focus();
  caretIn(p);
});

/* ---------- Modes ---------- */
function commitSource() {
  if (!state.sourceTouched) return;
  state.sourceTouched = false;
  renderDoc(el.source.value);
}
function setMode(mode) {
  if (mode === state.mode) return;
  if (state.mode === 'source') commitSource();
  if (mode === 'source') { el.source.value = serialize(); state.sourceTouched = false; }
  state.mode = mode;
  el.doc.classList.toggle('hidden', mode === 'source');
  el.source.classList.toggle('hidden', mode !== 'source');
  if (mode === 'edit') el.doc.contentEditable = 'true'; else el.doc.removeAttribute('contenteditable');
  $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  hideBubble();
  if (mode === 'source') { autosize(el.source); el.source.focus({ preventScroll: true }); }
  layoutNotes();
}
el.source.addEventListener('input', () => { state.sourceTouched = true; setDirty(true); autosize(el.source); });
el.source.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  exec('insertText', '  ');
});
$('#modeSeg').addEventListener('click', e => { const m = e.target.dataset.mode; if (m) setMode(m); });

/* ---------- Files ---------- */
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function ensureWritable(handle) {
  if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
}
async function writeHandle(handle, text) {
  if (!await ensureWritable(handle)) throw new Error('permission was not granted');
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

async function save() {
  const text = currentMarkdown();
  try {
    if (state.remote) {
      await apiOk(await api(fileUrl(state.path), { method: 'PUT', body: text }));
      toast('Saved');
      setDirty(false);
      return true;
    }
    if (!state.handle && window.showSaveFilePicker) {
      state.handle = await showSaveFilePicker({ suggestedName: state.name, types: [MD_TYPE] });
      state.name = state.handle.name;
      $('#docName').textContent = state.name;
    }
    if (state.handle) { await writeHandle(state.handle, text); toast('Saved'); }
    else { download(state.name, text); toast('Downloaded a copy'); }
    setDirty(false);
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn’t save: ' + err.message);
    return false;
  }
}

async function saveClean() {
  const text = currentMarkdown(true);
  const name = state.name.replace(/(\.\w+)?$/, m => '.clean' + (m || '.md'));
  try {
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName: name, types: [MD_TYPE] });
      await writeHandle(h, text);
      toast('Clean copy saved');
    } else { download(name, text); toast('Clean copy downloaded'); }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn’t save: ' + err.message);
  }
}

async function guardDirty() {
  if (!state.dirty) return true;
  const r = await ask({
    title: 'Unsaved changes', text: `Save your changes to ${state.name} first?`,
    actions: [{ label: 'Discard', value: 'discard', danger: true }, { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
  });
  if (r.value === 'save') return save();
  return r.value === 'discard';
}

function rememberScroll() {
  if (!state.path) return;
  const pos = store.get('pos', {});
  pos[state.path] = Math.round(el.scroller.scrollTop);
  const keys = Object.keys(pos);
  if (keys.length > 200) delete pos[keys[0]];
  store.set('pos', pos);
}

function loadDoc({ name, path = null, handle = null, remote = false, text }) {
  rememberScroll();
  Object.assign(state, { name, path, handle, remote, sourceTouched: false });
  if (state.mode === 'source') setMode('read');
  renderDoc(text);
  setDirty(false);
  $('#docName').textContent = name;
  document.title = `${name} — Margin`;
  el.scroller.scrollTo({ top: path ? store.get('pos', {})[path] || 0 : 0, behavior: 'instant' });
  if (path) store.set('last', path);
  renderTree();
  onScroll();
}

async function openEntry(entry) {
  if (!await guardDirty()) return;
  try {
    const source = entry.remote ? await apiOk(await api(fileUrl(entry.path))) : entry.handle ? await entry.handle.getFile() : entry.file;
    loadDoc({ name: entry.name, path: entry.path, handle: entry.handle || null, remote: !!entry.remote, text: await source.text() });
  } catch (err) { toast('Couldn’t open: ' + err.message); }
}

async function openFile() {
  if (!window.showOpenFilePicker) return $('#fallbackFile').click();
  try {
    const [handle] = await showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdx'], 'text/plain': ['.txt'] } }] });
    if (!await guardDirty()) return;
    loadDoc({ name: handle.name, handle, text: await (await handle.getFile()).text() });
  } catch (err) { if (err.name !== 'AbortError') toast('Couldn’t open: ' + err.message); }
}

async function scan(dir, prefix = '', depth = 0, out = []) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.') || name === 'node_modules' || out.length > 3000) continue;
    if (h.kind === 'directory') { if (depth < 7) await scan(h, prefix + name + '/', depth + 1, out); }
    else if (MD_RE.test(name)) out.push({ name, path: prefix + name, handle: h });
  }
  return out;
}
async function setRoot(dir) {
  state.root = dir;
  state.rootName = dir.name;
  state.entries = await scan(dir);
  showFolder();
}
function showFolder() {
  $('#folderName').textContent = state.rootName;
  $('#folderHead').classList.remove('hidden');
  $('#fileFilter').classList.remove('hidden');
  $('#newFile').classList.toggle('hidden', !state.root && !serverLibrary());
  $('#reopenFolder').classList.add('hidden');
  $('#filesHint').classList.toggle('hidden', state.entries.length > 0);
  if (!state.entries.length) $('#filesHint').textContent = 'No Markdown files found in this folder.';
  renderTree();
}
async function openFolder() {
  if (!window.showDirectoryPicker) return $('#fallbackFolder').click();
  try {
    const dir = await showDirectoryPicker({ mode: 'readwrite' });
    await setRoot(dir);
    idb.set('root', dir);
    selectTab('files');
  } catch (err) { if (err.name !== 'AbortError') toast('Couldn’t open folder: ' + err.message); }
}
async function newFile() {
  const r = await ask({ title: 'New file', input: 'Untitled.md', actions: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }] });
  let name = r.text.trim().replace(/[\\/:]/g, '-');
  if (r.value !== 'ok' || !name) return;
  if (!MD_RE.test(name)) name += '.md';
  if (state.entries.some(e => e.path === name)) return toast('A file with that name already exists');
  try {
    const starter = `# ${name.replace(MD_RE, '')}\n\n`;
    if (serverLibrary()) {
      await apiOk(await api(fileUrl(name, '&create=1'), { method: 'PUT', body: starter }));
      await loadServerList();
    } else {
      await writeHandle(await state.root.getFileHandle(name, { create: true }), starter);
      state.entries = await scan(state.root);
    }
    await openEntry(state.entries.find(e => e.path === name));
    setMode('edit');
  } catch (err) { toast('Couldn’t create file: ' + err.message); }
}

const ICON = {
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
};
const openDirs = new Set(store.get('openDirs', []));
function renderTree() {
  const q = $('#fileFilter').value.trim().toLowerCase();
  const sorted = [...state.entries].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  const fileRow = (entry, showPath) => {
    const b = document.createElement('button');
    b.className = 'row' + (entry.path === state.path ? ' active' : '');
    b.innerHTML = `${ICON.file}<span>${esc(entry.name.replace(/\.(md|markdown)$/i, ''))}</span>`;
    if (showPath && entry.path.includes('/')) b.insertAdjacentHTML('beforeend', `<span class="path">${esc(entry.path.slice(0, entry.path.lastIndexOf('/')))}</span>`);
    b.title = entry.path;
    b.onclick = () => openEntry(entry);
    return b;
  };
  el.tree.replaceChildren();
  if (q) return el.tree.append(...sorted.filter(e => e.path.toLowerCase().includes(q)).slice(0, 200).map(e => fileRow(e, true)));

  const root = { dirs: new Map(), files: [] };
  for (const entry of sorted) {
    let node = root;
    for (const part of entry.path.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(entry);
  }
  const build = (node, prefix, into) => {
    for (const [name, sub] of node.dirs) {
      const path = prefix + name + '/';
      const dir = document.createElement('div');
      dir.className = 'dir' + (openDirs.has(path) || (state.path || '').startsWith(path) ? ' open' : '');
      const row = document.createElement('button');
      row.className = 'row';
      row.innerHTML = `${ICON.chevron}<span>${esc(name)}</span>`;
      row.onclick = () => {
        dir.classList.toggle('open') ? openDirs.add(path) : openDirs.delete(path);
        store.set('openDirs', [...openDirs].slice(-100));
      };
      const kids = document.createElement('div');
      kids.className = 'children';
      build(sub, path, kids);
      dir.append(row, kids);
      into.append(dir);
    }
    into.append(...node.files.map(f => fileRow(f, false)));
  };
  build(root, '', el.tree);
}

async function resolveImages() {
  const relative = src => src && !/^([a-z][\w+.-]*:|\/\/|#)/i.test(src);
  if (state.remote && state.path) {
    for (const img of $$('img', el.doc)) {
      const src = img.getAttribute('src') || '';
      if (relative(src)) quiet(() => { img.dataset.mdrSrc = src; img.src = '/api/raw?path=' + encodeURIComponent(resolvePath(state.path, src)); });
    }
    return;
  }
  if (!state.root || !state.path) return;
  for (const img of $$('img', el.doc)) {
    const src = img.getAttribute('src') || '';
    if (!relative(src)) continue;
    try {
      const segs = resolvePath(state.path, src).split('/');
      let dir = state.root;
      for (const seg of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
      const url = URL.createObjectURL(await (await dir.getFileHandle(segs.at(-1))).getFile());
      state.blobUrls.push(url);
      quiet(() => { img.dataset.mdrSrc = src; img.src = url; });
    } catch {}
  }
  layoutNotes();
}

// Fallbacks for browsers without the File System Access API: read-only open, download on save.
$('#fallbackFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && await guardDirty()) loadDoc({ name: file.name, text: await file.text() });
});
$('#fallbackFolder').addEventListener('change', e => {
  const files = [...e.target.files].filter(f => MD_RE.test(f.name) && !/(^|\/)(\.|node_modules\/)/.test(f.webkitRelativePath));
  if (!e.target.files.length) return;
  state.root = null;
  state.rootName = e.target.files[0].webkitRelativePath.split('/')[0];
  state.entries = files.map(f => ({ name: f.name, path: f.webkitRelativePath.split('/').slice(1).join('/'), file: f }));
  e.target.value = '';
  showFolder();
});

// Drag and drop
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#dropVeil').classList.add('show'); } });
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropVeil').classList.remove('show'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropVeil').classList.remove('show');
  const item = e.dataTransfer.items[0];
  const file = e.dataTransfer.files[0];
  try {
    const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
    if (handle?.kind === 'directory') { await setRoot(handle); idb.set('root', handle); return selectTab('files'); }
    if (!file || !await guardDirty()) return;
    loadDoc({ name: file.name, handle, text: await file.text() });
  } catch (err) { toast('Couldn’t open: ' + err.message); }
});

async function restoreFolder() {
  const dir = await idb.get('root');
  if (!dir || !dir.queryPermission) return;
  const reopen = async () => {
    await setRoot(dir);
    const last = state.entries.find(e => e.path === store.get('last', null));
    if (last && !state.dirty) openEntry(last);
  };
  try {
    if (await dir.queryPermission({ mode: 'readwrite' }) === 'granted') return await reopen();
  } catch { return; }
  const btn = $('#reopenFolder');
  btn.textContent = `Reopen “${dir.name}”`;
  btn.classList.remove('hidden');
  btn.onclick = async () => {
    try { if (await dir.requestPermission({ mode: 'readwrite' }) === 'granted') await reopen(); }
    catch (err) { toast('Couldn’t reopen: ' + err.message); }
  };
}

async function loadServerList() {
  const paths = await (await apiOk(await api('/api/list'))).json();
  state.root = null;
  state.rootName = state.server.root;
  state.entries = paths.map(p => ({ name: p.split('/').pop(), path: p, remote: true }));
  showFolder();
}
// When the page is served by the mdmargin binary, its folder becomes the library.
async function connectServer() {
  if (!location.protocol.startsWith('http')) return false;
  try {
    const info = await (await api('/api/info')).json();
    if (info.app !== 'mdmargin') return false;
    state.server = info;
    await loadServerList();
    const want = info.file || store.get('last', null);
    const entry = state.entries.find(e => e.path === want);
    if (entry) await openEntry(entry);
    return true;
  } catch { return false; }
}

/* ---------- Appearance ---------- */
const FONTS = [
  { id: 'serif', name: 'Iowan', stack: '"Iowan Old Style", "Charter", "Palatino Linotype", Georgia, serif' },
  { id: 'newyork', name: 'New York', stack: '"New York", ui-serif, Georgia, serif' },
  { id: 'sans', name: 'System Sans', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'georgia', name: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'literata', name: 'Literata', stack: '"Literata", Georgia, serif', web: 'Literata:ital,opsz,wght@0,7..72,400..700;1,7..72,400..700' },
  { id: 'newsreader', name: 'Newsreader', stack: '"Newsreader", Georgia, serif', web: 'Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..700' },
  { id: 'lora', name: 'Lora', stack: '"Lora", Georgia, serif', web: 'Lora:ital,wght@0,400..700;1,400..700' },
  { id: 'inter', name: 'Inter', stack: '"Inter", system-ui, sans-serif', web: 'Inter:wght@400..700' },
  { id: 'atkinson', name: 'Atkinson', stack: '"Atkinson Hyperlegible", system-ui, sans-serif', web: 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700' },
  { id: 'mono', name: 'JetBrains Mono', stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace', web: 'JetBrains+Mono:ital,wght@0,400..700;1,400..700' },
];
const settings = Object.assign({ theme: 'auto', font: 'serif', size: 18, leading: 1.7, width: 700, sidebar: true }, store.get('settings', {}));
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const loadedFonts = new Set();

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : settings.theme;
  const font = FONTS.find(f => f.id === settings.font) || FONTS[0];
  // Web fonts are fetched from Google Fonts only once chosen; offline they fall back to a system face.
  if (font.web && !loadedFonts.has(font.id)) {
    loadedFonts.add(font.id);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font.web}&display=swap`;
    document.head.append(link);
    document.fonts?.ready.then(() => setTimeout(layoutNotes, 400));
  }
  root.style.setProperty('--font', font.stack);
  root.style.setProperty('--size', settings.size + 'px');
  root.style.setProperty('--leading', settings.leading);
  root.style.setProperty('--width', settings.width + 'px');
  $$('#themes button').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === settings.theme));
  $$('#fonts button').forEach(b => b.classList.toggle('active', b.dataset.font === settings.font));
  for (const [id, key, unit] of [['optSize', 'size', 'px'], ['optLeading', 'leading', ''], ['optWidth', 'width', '']]) {
    const input = $('#' + id);
    input.value = settings[key];
    input.nextElementSibling.textContent = settings[key] + unit;
  }
  store.set('settings', settings);
  requestAnimationFrame(layoutNotes);
}
darkQuery.addEventListener('change', applySettings);
$('#fonts').append(...FONTS.map(f => {
  const b = document.createElement('button');
  b.dataset.font = f.id;
  b.textContent = f.name;
  b.style.fontFamily = f.stack;
  b.title = f.web ? 'Loaded from Google Fonts the first time you pick it' : 'Built into your system';
  return b;
}));
$('#fonts').addEventListener('click', e => { const f = e.target.dataset.font; if (f) { settings.font = f; applySettings(); } });
$('#themes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { settings.theme = b.dataset.themeOpt; applySettings(); } });
for (const [id, key] of [['optSize', 'size'], ['optLeading', 'leading'], ['optWidth', 'width']]) {
  $('#' + id).addEventListener('input', e => { settings[key] = Number(e.target.value); applySettings(); });
}

function togglePopover(pop, btn) {
  const show = pop.classList.contains('hidden');
  el.appearance.classList.add('hidden');
  el.menu.classList.add('hidden');
  if (!show) return;
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 10, r.right - pop.offsetWidth)) + 'px';
}
$('#appearanceBtn').onclick = e => togglePopover(el.appearance, e.currentTarget);
$('#menuBtn').onclick = e => togglePopover(el.menu, e.currentTarget);

/* ---------- Chrome ---------- */
function selectTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
}
$('.tabs').addEventListener('click', e => { const t = e.target.dataset.tab; if (t) selectTab(t); });

const relayoutSoon = () => setTimeout(layoutNotes, 320);
function toggleSidebar(force) {
  const hide = force === undefined ? !document.body.classList.contains('no-sidebar') : !force;
  document.body.classList.toggle('no-sidebar', hide);
  settings.sidebar = !hide;
  store.set('settings', settings);
  relayoutSoon();
}
function toggleFocus(force) {
  document.body.classList.toggle('focus', force);
  hideBubble();
  relayoutSoon();
}

async function stripAll() {
  const r = await ask({
    title: 'Remove all annotations?', text: 'Every highlight, sticky note and bookmark will be removed from this document. Nothing is written to disk until you save.',
    actions: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'ok', primary: true }],
  });
  if (r.value !== 'ok') return;
  if (state.mode === 'source') setMode('read');
  stripAnnotations(el.doc);
  toast('Annotations removed');
}

const actions = {
  openFile, openFolder, save, cleanSave: saveClean, strip: stripAll,
  async cleanCopy() {
    try { await navigator.clipboard.writeText(currentMarkdown(true)); toast('Clean Markdown copied'); }
    catch { toast('Clipboard isn’t available here'); }
  },
  async welcome() { if (await guardDirty()) loadDoc({ name: 'Welcome.md', text: window.WELCOME_MD }); },
};
el.menu.addEventListener('click', e => {
  const key = e.target.closest('button')?.dataset.menu;
  if (!key) return;
  el.menu.classList.add('hidden');
  actions[key]();
});
$('#openFile').onclick = openFile;
$('#openFolder').onclick = openFolder;
$('#newFile').onclick = newFile;
$('#saveBtn').onclick = save;
$('#bookmarkBtn').onclick = bookmarkHere;
$('#toggleSidebar').onclick = () => toggleSidebar();
$('#focusBtn').onclick = () => toggleFocus();
$('#exitFocus').onclick = () => toggleFocus(false);
$('#fileFilter').addEventListener('input', renderTree);

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const s = el.scroller, max = s.scrollHeight - s.clientHeight;
    $('#progress').style.width = (max > 0 ? Math.min(100, s.scrollTop / max * 100) : 0) + '%';
    el.main.classList.toggle('scrolled', s.scrollTop > 4);
    updateOutlineActive();
    if (!el.bubble.classList.contains('hidden')) {
      if (bubbleMark) showBubble(bubbleMark.getBoundingClientRect(), bubbleMark); else updateBubble();
    }
  });
}
el.scroller.addEventListener('scroll', onScroll, { passive: true });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (el.dialog.open) return;
    hideBubble();
    el.appearance.classList.add('hidden');
    el.menu.classList.add('hidden');
    if (document.body.classList.contains('focus')) toggleFocus(false);
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const run = {
    s: save,
    e: () => setMode(state.mode === 'edit' ? 'read' : 'edit'),
    '/': () => setMode(state.mode === 'source' ? 'read' : 'source'),
    '.': () => toggleFocus(),
    '\\': () => toggleSidebar(),
    d: bookmarkHere,
    k: () => { toggleSidebar(true); selectTab('files'); $('#fileFilter').focus(); },
  }[e.key.toLowerCase()];
  if (!run || e.shiftKey) return;
  e.preventDefault();
  run();
});

addEventListener('beforeunload', e => {
  rememberScroll();
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});
if (window.ResizeObserver) new ResizeObserver(debounce(layoutNotes, 60)).observe(el.scroller);

/* ---------- Start ---------- */
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
if (!settings.sidebar || innerWidth < 760) document.body.classList.add('no-sidebar');
applySettings();
loadDoc({ name: 'Welcome.md', text: window.WELCOME_MD });
connectServer().then(ok => { if (!ok) restoreFolder(); });

window.__mdr = { state, renderDoc, serialize, highlight, setMode };
})();
