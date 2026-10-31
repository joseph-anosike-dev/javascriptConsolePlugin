const { Plugin, ItemView, setIcon } = require('obsidian');

const VIEW_TYPE = 'js-console-view';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const geval = (0, eval); // indirect eval = global scope, so variables persist between runs
const MAX_ROWS = 1000;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const GUTTER = { error: '✕', warn: '⚠' };

/* ───────────── value helpers ───────────── */
const isLeaf = v => v === null || (typeof v !== 'object' && typeof v !== 'function');
const ctorName = v => { try { return (v.constructor && v.constructor.name) || 'Object'; } catch { return 'Object'; } };
const canParse = s => { try { new AsyncFunction(s); return true; } catch { return false; } };

function isIncomplete(code) {
  try { new AsyncFunction(code); return false; }
  catch (e) { return e instanceof SyntaxError && /end of input|unterminated|unexpected end/i.test(e.message); }
}

function leafText(v, quote = true) {
  if (typeof v === 'string') return quote ? `'${v}'` : v;
  if (typeof v === 'bigint') return v + 'n';
  return String(v);
}
function leafClass(v) {
  if (v === null || v === undefined) return 'nul';
  const t = typeof v;
  return t === 'string' ? 'str' : (t === 'number' || t === 'bigint' || t === 'boolean') ? 'num' : 'sym';
}

function preview(v, depth = 0) {
  if (isLeaf(v)) return leafText(v);
  if (typeof v === 'function') return `ƒ ${v.name || ''}()`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
  if (v instanceof RegExp) return String(v);
  if (v instanceof Promise) return 'Promise {…}';
  if (v.nodeType === 1) {
    const cls = typeof v.className === 'string' && v.className.trim() ? '.' + v.className.trim().split(/\s+/).join('.') : '';
    return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}${cls}>`;
  }
  if (depth > 1) return Array.isArray(v) ? '[…]' : '{…}';
  try {
    const items = [];
    if (Array.isArray(v)) {
      v.slice(0, 5).forEach(x => items.push(preview(x, depth + 1)));
      if (v.length > 5) items.push('…');
      return `(${v.length}) [${items.join(', ')}]`;
    }
    if (v instanceof Map || v instanceof Set) {
      const isMap = v instanceof Map; let i = 0;
      for (const e of v) {
        if (i++ >= 5) { items.push('…'); break; }
        items.push(isMap ? `${preview(e[0], depth + 1)} => ${preview(e[1], depth + 1)}` : preview(e, depth + 1));
      }
      return `${ctorName(v)}(${v.size}) {${items.join(', ')}}`;
    }
    const keys = Object.keys(v);
    keys.slice(0, 5).forEach(k => { let s; try { s = preview(v[k], depth + 1); } catch { s = '(…)'; } items.push(`${k}: ${s}`); });
    if (keys.length > 5) items.push('…');
    const n = ctorName(v);
    return (n === 'Object' ? '' : n + ' ') + `{${items.join(', ')}}`;
  } catch { return ctorName(v); }
}

/* ───────────── expandable object tree ───────────── */
function renderValue(parent, v, opts = {}) {
  const node = parent.createDiv('jsc-node');
  const head = node.createDiv('jsc-head');
  const key = () => opts.label !== undefined && head.createSpan({ cls: 'jsc-key', text: opts.label + ': ' });

  if (isLeaf(v)) {
    key();
    head.createSpan({ cls: 'jsc-' + leafClass(v), text: leafText(v, !opts.top) });
    return node;
  }
  if (opts.top && v instanceof Error) {
    head.createEl('pre', { cls: 'jsc-errtext', text: v.stack || String(v) });
    return node;
  }
  head.createSpan({ cls: 'jsc-arrow', text: '▸' });
  key();
  head.createSpan({ cls: typeof v === 'function' ? 'jsc-fn' : 'jsc-obj', text: preview(v) });

  let body = null;
  head.addEventListener('click', e => {
    e.stopPropagation();
    if (!body) { body = node.createDiv('jsc-body'); populate(body, v); }
    node.classList.toggle('open');
  });
  return node;
}

function populate(body, v) {
  let names = [];
  try { names = Array.isArray(v) ? [...Object.keys(v), 'length'] : Object.getOwnPropertyNames(v); } catch {}
  for (const k of names.slice(0, 500)) {
    let val;
    try { val = v[k]; } catch (e) { val = e; }
    renderValue(body, val, { label: k });
  }
  if (names.length > 500) body.createDiv({ cls: 'jsc-more', text: `… ${names.length - 500} more` });
  if (v instanceof Map) renderValue(body, [...v.entries()], { label: '[[Entries]]' });
  if (v instanceof Set) renderValue(body, [...v], { label: '[[Entries]]' });
  let proto = null;
  try { proto = Object.getPrototypeOf(v); } catch {}
  if (proto) renderValue(body, proto, { label: '[[Prototype]]' });
}

function renderTable(parent, data) {
  const rows = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
  const prim = v => isLeaf(v) || typeof v === 'function';
  const cols = []; let hasVal = false;
  rows.forEach(([, v]) => {
    if (prim(v)) hasVal = true;
    else Object.keys(v).forEach(k => { if (!cols.includes(k)) cols.push(k); });
  });
  const t = parent.createEl('table', { cls: 'jsc-table' });
  const hr = t.createEl('thead').createEl('tr');
  ['(index)', ...cols, ...(hasVal ? ['Value'] : [])].forEach(c => hr.createEl('th', { text: String(c) }));
  const tb = t.createEl('tbody');
  rows.forEach(([i, v]) => {
    const tr = tb.createEl('tr');
    tr.createEl('td', { text: String(i) });
    cols.forEach(c => tr.createEl('td', { text: !prim(v) && Object.prototype.hasOwnProperty.call(v, c) ? preview(v[c], 1) : '' }));
    if (hasVal) tr.createEl('td', { text: prim(v) ? preview(v) : '' });
  });
}

/* console.log("%s is %d", ...) style formatting */
function formatArgs(args) {
  const out = [];
  if (typeof args[0] === 'string' && args.length > 1 && /%[sdifoOjc%]/.test(args[0])) {
    let i = 1;
    const text = args[0].replace(/%([sdifoOjc%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (f) {
        case 's': return typeof a === 'string' ? a : preview(a);
        case 'd': case 'i': return typeof a === 'object' || typeof a === 'symbol' ? 'NaN' : String(f === 'i' ? parseInt(a) : Number(a));
        case 'f': return String(parseFloat(a));
        case 'c': return '';
        case 'j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
        default: return preview(a);
      }
    });
    out.push({ v: text, top: true });
    args.slice(i).forEach(a => out.push({ v: a, top: typeof a === 'string' }));
  } else args.forEach(a => out.push({ v: a, top: typeof a === 'string' }));
  return out;
}

/* ───────────── the console view ───────────── */
class ConsoleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.groups = [];
    this.counts = new Map();
    this.timers = new Map();
    this.orig = {}; this.wrapped = {};
    this.stick = true;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'JS Console'; }
  getIcon() { return 'terminal'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('jsc');

    const bar = root.createDiv('jsc-bar');
    const clr = bar.createEl('button', { cls: 'jsc-btn clickable-icon', attr: { 'aria-label': 'Clear console (Ctrl+L)' } });
    setIcon(clr, 'ban');
    clr.onclick = () => this.clear();
    const seg = bar.createDiv('jsc-filters');
    this.out = root.createDiv('jsc-out');
    this.out.dataset.f = 'all';
    this.out.addEventListener('scroll', () => {
      this.stick = this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 30;
    });
    [['all', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['log', 'Logs']].forEach(([k, t], i) => {
      const b = seg.createEl('button', { cls: 'jsc-filter' + (i ? '' : ' active'), text: t });
      b.onclick = () => {
        this.out.dataset.f = k;
        seg.querySelectorAll('.jsc-filter').forEach(x => x.classList.toggle('active', x === b));
      };
    });

    const wrap = root.createDiv('jsc-in');
    wrap.createSpan({ cls: 'jsc-gutter', text: '›' });
    this.input = wrap.createEl('textarea', {
      attr: { rows: '1', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', placeholder: 'Evaluate JavaScript' }
    });
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', () => this.grow());

    this.hist = this.plugin.history;
    this.hIdx = this.hist.length;
    this.draft = '';

    this.hook();
    this.registerDomEvent(window, 'error', e => this.addLog('error', ['Uncaught ' + (e.message || e.error)]));
    this.registerDomEvent(window, 'unhandledrejection', e => this.addLog('error', ['Uncaught (in promise)', e.reason]));
    this.row('sys').setText('`app`, `obsidian` and `$_` (last result) are available. Enter runs, Shift+Enter adds a line, Tab completes, ↑/↓ browse history.');
  }

  async onClose() { this.unhook(); }

  grow() {
    const ta = this.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  onKey(e) {
    const ta = this.input;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const code = ta.value;
      if (!code.trim()) return e.preventDefault();
      if (isIncomplete(code)) return; // unfinished block: let Enter insert a newline
      e.preventDefault();
      ta.value = ''; this.grow();
      this.run(code);
    } else if (e.key === 'ArrowUp' && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
      if (this.hIdx > 0) {
        e.preventDefault();
        if (this.hIdx === this.hist.length) this.draft = ta.value;
        ta.value = this.hist[--this.hIdx]; this.grow();
      }
    } else if (e.key === 'ArrowDown' && !ta.value.slice(ta.selectionEnd).includes('\n')) {
      if (this.hIdx < this.hist.length) {
        e.preventDefault();
        this.hIdx++;
        ta.value = this.hIdx === this.hist.length ? this.draft : this.hist[this.hIdx]; this.grow();
      }
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault(); this.complete();
    } else if (e.key.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); this.clear();
    }
  }

  /* ── evaluation ── */
  async run(code) {
    this.hist.push(code);
    if (this.hist.length > 100) this.hist.shift();
    this.hIdx = this.hist.length;
    this.plugin.saveHistory();
    this.stick = true;

    this.row('input', '›').createEl('pre', { cls: 'jsc-code', text: code });
    try {
      this.showResult(await this.evaluate(code));
    } catch (err) {
      const c = this.row('error', '✕');
      if (!(err instanceof Error)) c.createSpan({ text: 'Uncaught ' });
      renderValue(c, err, { top: true });
    }
  }

  async evaluate(code) {
    const src = code.trim().replace(/;+\s*$/, '');
    let v;
    if (!/\bawait\b/.test(src)) {
      // top-level let/const → var so they stay available in the next run
      const body = src.replace(/^(?:const|let)\s/gm, 'var ');
      v = geval(canParse('return (' + body + '\n)') ? '(' + body + '\n)' : body);
    } else {
      // top-level await: wrap in an async function, hoist simple declarations onto globalThis
      const body = src.replace(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, 'globalThis.$1 =');
      const fn = new AsyncFunction(canParse('return (' + body + '\n)') ? 'return (' + body + '\n)' : body);
      v = await fn();
    }
    window.$_ = v;
    return v;
  }

  showResult(v) {
    const c = this.row('result', '‹');
    if (v instanceof Promise) {
      const box = c.createDiv('jsc-promise');
      box.setText('Promise {<pending>}');
      const settle = (state, val) => {
        box.empty();
        box.createSpan({ text: `Promise {<${state}>: ` });
        renderValue(box, val, { top: false });
        box.createSpan({ text: '}' });
        if (state === 'rejected') box.addClass('rejected');
      };
      v.then(r => settle('fulfilled', r), e => settle('rejected', e));
    } else renderValue(c, v);
  }

  /* ── rows ── */
  row(kind, gutter = '') {
    const parent = this.groups.length ? this.groups[this.groups.length - 1] : this.out;
    const r = parent.createDiv({ cls: `jsc-row jsc-${kind}` });
    r.createSpan({ cls: 'jsc-gutter', text: gutter });
    const c = r.createDiv('jsc-msg');
    while (this.out.childElementCount > MAX_ROWS) this.out.firstElementChild.remove();
    requestAnimationFrame(() => { if (this.stick) this.out.scrollTop = this.out.scrollHeight; });
    return c;
  }

  addLog(level, args) {
    const c = this.row(level, GUTTER[level] || '');
    formatArgs(args).forEach(({ v, top }) => renderValue(c, v, { top }));
  }

  group(args, collapsed) {
    const parent = this.groups.length ? this.groups[this.groups.length - 1] : this.out;
    const g = parent.createDiv('jsc-group' + (collapsed ? ' collapsed' : ''));
    const h = g.createDiv('jsc-row jsc-log jsc-ghead');
    const gut = h.createSpan({ cls: 'jsc-gutter', text: collapsed ? '▸' : '▾' });
    formatArgs(args).forEach(({ v, top }) => renderValue(h.createDiv('jsc-msg'), v, { top }));
    h.onclick = () => gut.setText(g.classList.toggle('collapsed') ? '▸' : '▾');
    this.groups.push(g.createDiv('jsc-gbody'));
  }

  clear() { this.out.empty(); this.groups = []; }

  /* ── console hooking: captures everything logged in Obsidian, like DevTools ── */
  hook() {
    this.dead = false;
    const self = this;
    const wrap = (name, fn) => {
      const orig = console[name];
      this.orig[name] = orig;
      console[name] = this.wrapped[name] = function (...a) {
        orig.apply(this, a);
        if (self.dead || self.rendering) return;
        self.rendering = true; // guard against re-entrant logging from our own renderer
        try { fn(...a); } catch (_) {} finally { self.rendering = false; }
      };
    };
    ['log', 'info', 'warn', 'error', 'debug'].forEach(l => wrap(l, (...a) => this.addLog(l, a)));
    wrap('dir', d => this.addLog('log', [d]));
    wrap('table', d => isLeaf(d) ? this.addLog('log', [d]) : renderTable(this.row('log'), d));
    wrap('group', (...a) => this.group(a, false));
    wrap('groupCollapsed', (...a) => this.group(a, true));
    wrap('groupEnd', () => this.groups.pop());
    wrap('assert', (c, ...a) => { if (!c) this.addLog('error', ['Assertion failed:', ...a]); });
    wrap('count', (l = 'default') => { const n = (this.counts.get(l) || 0) + 1; this.counts.set(l, n); this.addLog('log', [`${l}: ${n}`]); });
    wrap('time', (l = 'default') => this.timers.set(l, performance.now()));
    wrap('timeLog', l => this.timeOp(l, false));
    wrap('timeEnd', l => this.timeOp(l, true));
    wrap('clear', () => this.clear());
    window.obsidian = require('obsidian');
  }

  timeOp(l = 'default', end) {
    const t = this.timers.get(l);
    if (t === undefined) return;
    this.addLog('log', [`${l}: ${(performance.now() - t).toFixed(3)} ms`]);
    if (end) this.timers.delete(l);
  }

  unhook() {
    this.dead = true;
    for (const [n, f] of Object.entries(this.orig)) if (console[n] === this.wrapped[n]) console[n] = f;
  }

  /* ── Tab completion ── */
  complete() {
    const ta = this.input;
    const pre = ta.value.slice(0, ta.selectionStart);
    const m = pre.match(/((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)?$/);
    if (!m) return;
    const path = m[1].slice(0, -1), prefix = m[2] || '';
    if (!path && !prefix) return;
    let obj;
    try { obj = path ? geval(path) : globalThis; } catch { return; }
    if (obj === null || obj === undefined) return;
    const names = new Set();
    try {
      for (let o = Object(obj); o; o = Object.getPrototypeOf(o))
        Object.getOwnPropertyNames(o).forEach(n => IDENT.test(n) && names.add(n));
    } catch {}
    const hits = [...names].filter(n => n.startsWith(prefix)).sort();
    if (!hits.length) return;
    let common = hits[0];
    for (const h of hits) while (!h.startsWith(common)) common = common.slice(0, -1);
    if (common.length > prefix.length) {
      ta.setRangeText(common.slice(prefix.length), ta.selectionStart, ta.selectionStart, 'end');
      this.grow();
    }
    if (hits.length > 1) this.row('sys').setText(hits.slice(0, 40).join('   ') + (hits.length > 40 ? '   …' : ''));
  }
}

/* ───────────── plugin ───────────── */
module.exports = class JSConsolePlugin extends Plugin {
  async onload() {
    const d = (await this.loadData()) || {};
    this.history = Array.isArray(d.history) ? d.history : [];
    this.registerView(VIEW_TYPE, leaf => new ConsoleView(leaf, this));
    this.addRibbonIcon('terminal', 'Open JS console', () => this.openConsole());
    this.addCommand({ id: 'open-js-console', name: 'Open JS console', callback: () => this.openConsole() });
  }

  onunload() {
    delete window.obsidian;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  saveHistory() { this.saveData({ history: this.history }); }

  async openConsole() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('split', 'horizontal'); // docks below the current pane
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    if (leaf.view && leaf.view.input) leaf.view.input.focus();
  }
};
