import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.attributes = {};
    this.style = {}; this.listeners = {}; this.value = ''; this.clientHeight = 600;
    this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none';
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (c) => { if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle: (c) => { const on = !this.classList.contains(c); this.classList[on ? 'add' : 'remove'](c); return on; },
    };
  }
  set id(v) { this.setAttribute('id', v); } get id() { return this.getAttribute('id') || ''; }
  set className(v) { this.setAttribute('class', v); } get className() { return this.getAttribute('class') || ''; }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get previousElementSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) - 1] || null; }
  get isConnected() { return this === this.doc.documentElement || !!this.parentNode?.isConnected; }
  get childElementCount() { return this.children.length; }
  get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => c.remove()); this._text = String(v ?? ''); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get disabled() { return this.getAttribute('disabled') !== null; }
  set placeholder(v) { this.setAttribute('placeholder', v); }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  get innerHTML() {
    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return escape(this._text || '') + this.children.map((c) => {
      const attrs = Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
      const tag = c.tagName.toLowerCase();
      return `<${tag}${attrs}>` + (['input', 'br', 'hr'].includes(tag) ? '' : c.innerHTML + `</${tag}>`);
    }).join('');
  }
  set innerHTML(html) {
    this.children.slice().forEach((c) => c.remove()); this._html = html; this._text = '';
    const stack = [this];
    for (const m of String(html).matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (m[2]) {
        const el = new Element(m[2], this.doc);
        for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] || ''));
        el.value = el.getAttribute('value') || '';
        stack.at(-1).appendChild(el);
        if (!['input', 'br', 'hr'].includes(m[2]) && !m[3].endsWith('/')) stack.push(el);
      } else if (m[4]) stack.at(-1)._text = (stack.at(-1)._text || '') + decode(m[4]);
    }
  }
  insertAdjacentHTML(where, html) { const tmp = this.doc.createElement('div'); tmp.innerHTML = html; tmp.children.slice().forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  cloneNode(deep) {
    const el = new Element(this.tagName, this.doc);
    for (const [k, v] of Object.entries(this.attributes)) el.attributes[k] = v;
    el._text = this._text || '';
    if (deep !== false) this.children.forEach((c) => el.appendChild(c.cloneNode(true)));
    return el;
  }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(el) { el.remove(); el.parentNode = this; this.children.push(el); return el; }
  insertBefore(el, before) { el.remove(); el.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, el); return el; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } }
  matches(sel) {
    return sel.split(',').some((s) => {
      s = s.trim();
      if (s === '*') return true;
      const id = s.match(/^#([\w-]+)/); if (id && this.id !== id[1]) return false;
      const tag = s.match(/^[a-z]+/i); if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      for (const c of s.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(c[1])) return false;
      for (const a of s.matchAll(/\[([\w-]+)(\*=|=)?["']?([^\]"']*)["']?\]/g)) {
        const v = this.getAttribute(a[1]);
        if (v === null || (a[2] === '=' && v !== a[3]) || (a[2] === '*=' && !v.includes(a[3]))) return false;
      }
      return true;
    });
  }
  querySelectorAll(sel) { return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { return this.matches(sel) ? this : this.parentNode?.closest(sel) || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extras = {}) { const ev = { target: this, ...extras }; for (let e = this; e; e = e.parentNode) for (const fn of e.listeners[type] || []) fn(ev); }
  focus() { this.doc.activeElement = this; }
  click() { this.dispatch('click'); }
  get nextSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) + 1] || null; }
  setSelectionRange(a, b, d = 'none') { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; }
}

const clients = [
  { name: 'DSH', prefix: 'dwf', path: new URL('../../dsh-workflow-pipeline/client.js', import.meta.url) },
  { name: 'MMX', prefix: 'mmxdwf', path: new URL('../client-inject.js', import.meta.url) },
];

function fixture(client, initial = [], options = {}) {
  const doc = { readyState: options.domReadyPending ? 'loading' : 'complete', activeElement: null };
  const docListeners = {}, winListeners = {};
  // 024-R4: terminal runs in the initial list are pre-marked as user-watched (visible), as
  // if the user had seen them finish while the card was on screen. Content-focused tests
  // rely on this; attribution tests pass { watched: false } and seed visibility themselves.
  if (options.watched !== false) {
    const key = client.name === 'DSH' ? 'dwf-pipeline-visible-runs' : 'mmxdwf-visible-runs';
    const watchedIds = initial.filter((r) => !['running', 'cancelling'].includes(r.status)).map((r) => r.runKey || r.runId);
    if (watchedIds.length) {
      let prev = [];
      try { prev = JSON.parse((options.storage || new Map()).get(key) || '[]'); } catch { prev = []; }
      (options.storage ||= new Map()).set(key, JSON.stringify([...new Set([...prev, ...watchedIds])]));
    }
  }
  doc.createElement = (tag) => new Element(tag, doc);
  doc.documentElement = doc.createElement('html'); doc.head = doc.createElement('head');
  doc.documentElement.appendChild(doc.head);
  // domReadyPending: body does not exist yet, so the client must defer boot to
  // DOMContentLoaded/load instead of throwing or booting early.
  if (!options.domReadyPending) doc.body = doc.createElement('body');
  if (doc.body) doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.addEventListener = (type, fn) => { (docListeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn); };
  const area = doc.createElement('div'); area.className = 'viewArea'; area.setAttribute('data-testid', 'message-list');
  if (doc.body) doc.body.appendChild(area);
  const intervals = [], timeouts = [], storage = options.storage || new Map(), requests = [];
  // Host per-tab session state (MMX reads mavis:activeSessionId from it). Empty by default so
  // the existing marker-less fixtures keep describing the no-current-session host.
  const sessionStorage = { getItem: (k) => sessionState.get(k) ?? null, setItem: (k, v) => sessionState.set(k, v), removeItem: (k) => sessionState.delete(k) };
  const sessionState = options.sessionStorage || new Map();
  const blobs = { created: [], revoked: [], values: [] };
  let data = initial;
  const sandbox = {
    document: doc, console, Set, Map, encodeURIComponent,
    Date: options.now ? class extends Date { static now() { return options.now(); } } : Date,
    getComputedStyle: () => ({ position: 'static', backgroundColor: 'rgb(255, 255, 255)', colorScheme: 'light' }),
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    sessionStorage,
    setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: () => {},
    setTimeout: (f) => { timeouts.push(f); return timeouts.length; }, clearTimeout: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    fetch: async (url, opts) => {
      requests.push({ url, opts });
      if (opts?.method === 'POST' && options.post) return options.post(url, opts);
      if (url.includes('/artifact?')) return {
        ok: true,
        headers: { get: (k) => String(k).toLowerCase() === 'content-type' ? (options.artifactType || 'application/octet-stream') : '' },
        blob: async () => ({ size: 3, type: options.artifactType || 'application/octet-stream' }),
        text: async () => 'artifact-text',
      };
      const body = url.endsWith('/runs') ? { ok: true, runs: structuredClone(data) }
        : url.includes('/result?') ? { ok: true, out: { result: '已完成结果' } }
        : url.includes('/script?') ? { ok: true, script: 'return 1;' }
        : { ok: true };
      return { ok: true, json: async () => body };
    },
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
  };
  sandbox.window = sandbox;
  sandbox.URL = class MockURL {
    static createObjectURL(blob) { const u = 'blob:mock-' + (blobs.created.length + 1); blobs.created.push(u); blobs.values.push(blob); return u; }
    static revokeObjectURL(u) { if (!blobs.revoked.includes(u)) blobs.revoked.push(u); }
  };
  sandbox.Blob = class MockBlob { constructor(parts, opts) { this._text = (parts || []).join(''); this.type = (opts && opts.type) || ''; } get size() { return this._text.length; } };
  let effectTeardown = null;
  sandbox.__ModuleLoader__ = {
    load: ({ factory }) => factory().apply({
      // the effect function RETURNS its teardown; store the return value
      effect: (f) => { effectTeardown = f(); },
      sessions: options.sessionService ? { list: options.sessionService } : undefined,
    }),
  };
  vm.runInNewContext(readFileSync(client.path, 'utf8'), sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  const tick = async () => { intervals[0](); await settle(); await settle(); };
  return {
    doc, tick, setRuns: (v) => { data = v; }, requests, storage, sessionState, area, sandbox, intervals, timeouts, blobs, docListeners, winListeners,
    stop: () => { const t = sandbox.__mmxDwfTeardown || effectTeardown; if (t) t(); },
  };
}
test('MMX: a newer injected bundle replaces the old lifecycle and remains idempotent', async () => {
  const client = clients.find((c) => c.name === 'MMX');
  const f = fixture(client, [run('upgrade', 'completed')]); await f.tick();
  f.doc.querySelector('[data-act="history"]').dispatch('click');
  let tornDown = 0;
  const oldTeardown = f.sandbox.__mmxDwfTeardown;
  f.sandbox.__mmxDwfTeardown = () => { tornDown++; oldTeardown(); };
  f.sandbox.__mmxDwfVersion = 2;
  vm.runInNewContext(readFileSync(client.path, 'utf8'), f.sandbox);
  assert.equal(tornDown, 1);
  assert.equal(f.sandbox.__mmxDwfVersion, 9);
  assert.equal(f.doc.getElementById('mmxdwf-modal'), null);
  vm.runInNewContext(readFileSync(client.path, 'utf8'), f.sandbox);
  assert.equal(tornDown, 1);
});
const run = (id, status = 'running', extra = {}) => ({ runId: id, name: id, status, cwd: 'G:/project', startedAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:01Z', phases: [], calls: [], logs: [], ...extra });

for (const client of clients) {
  const p = client.prefix;
  test(client.name + ': first modal opening is visible', async () => {
    const f = fixture(client, [run('first', 'completed')]); await f.tick();
    f.doc.querySelector('[data-act="history"]').dispatch('click');
    await new Promise((r) => setImmediate(r));
    assert.equal(f.doc.getElementById(p + '-modal').style.display, 'flex');
  });
  test(client.name + ': another run updating preserves typed answer, focus and expanded card', async () => {
    const q = run('question', 'running', { questions: [{ qId: 'q1', question: '继续？', state: 'waiting' }] });
    const f = fixture(client, [q, run('other')]); await f.tick();
    const input = f.doc.querySelector('.' + p + '-qin'); input.value = '还没有输入完成'; input.focus(); input.setSelectionRange(2, 4);
    f.doc.querySelector('[data-run="question"]').querySelector('[data-act="expand"]').dispatch('click');
    f.setRuns([q, run('other', 'running', { updatedAt: '2026-09-29T00:00:02Z' })]); await f.tick();
    assert.ok(f.doc.querySelector('.' + p + '-qin') === input, 'unrelated updates must not replace an input (including IME composition)');
    assert.equal(input.value, '还没有输入完成');
    assert.equal(f.doc.activeElement, input);
    assert.ok(input.closest('[data-run]').classList.contains(p + '-full'));
  });
  test(client.name + ': own progress update preserves question input and selection', async () => {
    const q = run('question', 'running', { questions: [{ qId: 'q1', question: '继续？', state: 'waiting' }] });
    const f = fixture(client, [q]); await f.tick();
    const input = f.doc.querySelector('.' + p + '-qin'); input.value = '保留草稿'; input.focus(); input.setSelectionRange(1, 3);
    f.setRuns([{ ...q, updatedAt: '2026-09-29T00:00:02Z', logs: [{ text: '后台进度' }] }]); await f.tick();
    const current = f.doc.querySelector('.' + p + '-qin');
    assert.ok(current === input, 'input identity must survive own progress updates'); assert.equal(current.value, '保留草稿'); assert.equal(current.selectionStart, 1);
  });
  test(client.name + ': pending and submitted answers survive progress refresh without duplicate POSTs', async () => {
    let reply;
    const pending = new Promise((r) => { reply = r; });
    const q = run('question', 'running', { questions: [{ qId: 'q1', question: '继续？', state: 'waiting' }] });
    const f = fixture(client, [q], { post: () => pending }); await f.tick();
    f.doc.querySelector('.' + p + '-qin').value = '中文回答';
    f.doc.querySelector('[data-act="answer"]').dispatch('click');
    f.setRuns([{ ...q, logs: [{ text: '提交期间更新' }] }]); await f.tick();
    assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, true);
    f.doc.querySelector('[data-act="answer"]').dispatch('click');
    assert.equal(f.requests.filter((r) => r.url.includes('/answer?')).length, 1);
    reply({ ok: true, json: async () => ({ ok: true }) }); await f.tick();
    f.setRuns([{ ...q, logs: [{ text: '已提交之后更新' }] }]); await f.tick();
    assert.equal(f.doc.querySelector('.' + p + '-qin').disabled, true);
    assert.equal(f.doc.querySelector('.' + p + '-qin').placeholder, '已提交，等待工作流接收…');
    assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, true);
  });
  test(client.name + ': rejected answer keeps draft and visible error after refresh', async () => {
    const q = run('question', 'running', { questions: [{ qId: 'q1', question: '继续？', state: 'waiting' }] });
    const f = fixture(client, [q], { post: async () => ({ json: async () => ({ ok: false, error: 'run is not accepting answers' }) }) }); await f.tick();
    f.doc.querySelector('.' + p + '-qin').value = '不要丢失';
    f.doc.querySelector('[data-act="answer"]').dispatch('click'); await f.tick();
    f.setRuns([{ ...q, logs: [{ text: '刷新' }] }]); await f.tick();
    assert.equal(f.doc.querySelector('.' + p + '-qin').value, '不要丢失');
    assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, false);
    assert.match(f.doc.querySelector('[data-run="question"]').textContent, /run is not accepting answers/);
  });
  test(client.name + ': resume pending and cooldown survive replacement of the card header', async () => {
    let reply; const pending = new Promise((r) => { reply = r; });
    const q = run('retry', 'failed'); const f = fixture(client, [q], { post: () => pending }); await f.tick();
    f.doc.querySelector('[data-act="resume"]').dispatch('click');
    f.setRuns([{ ...q, elapsedMs: 5000 }]); await f.tick();
    assert.equal(f.doc.querySelector('[data-act="resume"]').disabled, true);
    f.doc.querySelector('[data-act="resume"]').dispatch('click');
    assert.equal(f.requests.filter((r) => r.url.includes('/resume?')).length, 1);
    reply({ ok: true, json: async () => ({ ok: true }) }); await f.tick();
    f.setRuns([{ ...q, elapsedMs: 6000 }]); await f.tick();
    assert.equal(f.doc.querySelector('[data-act="resume"]').disabled, true);
    for (const timer of f.timeouts.slice(1)) timer(); await f.tick();
    assert.equal(f.doc.querySelector('[data-act="resume"]').disabled, false);
  });
  test(client.name + ': shown terminal cards survive a new document and manual close stays closed', async () => {
    const a = run('persist-a'), b = run('persist-b'); const f = fixture(client, [a, b]); await f.tick();
    const done = [{ ...b, status: 'completed' }, { ...a, status: 'completed' }];
    f.setRuns(done); await f.tick();
    const g = fixture(client, done, { storage: f.storage }); await g.tick();
    assert.deepEqual(g.doc.querySelectorAll('[data-' + p + '-card]').map((c) => c.getAttribute('data-run')).sort(), ['persist-a', 'persist-b']);
    g.doc.querySelector('[data-run="persist-a"]').querySelector('[data-act="close"]').dispatch('click');
    const h = fixture(client, done, { storage: g.storage }); await h.tick();
    assert.equal(h.doc.querySelector('[data-run="persist-a"]'), null);
    assert.ok(h.doc.querySelector('[data-run="persist-b"]'));
  });
  test(client.name + ': closing a card does not evict an older manual dismissal', async () => {
    const key = client.name === 'DSH' ? 'dwf-pipeline-dismissed' : 'mmxdwf-dismissed';
    const storage = new Map([[key, JSON.stringify(Array.from({ length: 200 }, (_, i) => 'closed-' + i))]]);
    const f = fixture(client, [run('closed-new', 'completed')], { storage }); await f.tick();
    f.doc.querySelector('[data-act="close"]').dispatch('click');
    assert.equal(JSON.parse(storage.get(key)).length, 201);
    assert.ok(JSON.parse(storage.get(key)).includes('closed-0'));
  });
  test(client.name + ': failed questions are visible instead of silently disappearing', async () => {
    const f = fixture(client, [run('ask-failed', 'failed', { questions: [{ qId: 'q1', question: '等待超时的问题', state: 'failed' }] })]); await f.tick();
    assert.match(f.doc.querySelector('[data-run="ask-failed"]').textContent, /等待超时的问题/);
    assert.equal(f.doc.querySelector('[data-act="answer"]'), null);
  });
  test(client.name + ': equal log counts in separate runs both animate new log entries', async () => {
    const f = fixture(client, [run('log-a', 'running', { logs: [{ text: 'one' }] }), run('log-b', 'running', { logs: [{ text: 'two' }] })]); await f.tick();
    assert.ok(f.doc.querySelector('[data-run="log-a"]').querySelector('.fresh'));
    assert.ok(f.doc.querySelector('[data-run="log-b"]').querySelector('.fresh'));
  });
  test(client.name + ': completed result preview renders after its asynchronous fetch', async () => {
    const f = fixture(client, [run('done', 'completed')]); await f.tick();
    assert.equal(f.doc.querySelector('.' + p + '-result')?.textContent, '已完成结果');
    await f.tick();
    assert.equal(f.requests.filter((r) => r.url.includes('/result?')).length, 1, 'unchanged terminal results should be cached');
  });
  test(client.name + ': completing another run never silently removes a shown card', async () => {
    const a = run('a'), b = run('b'); const f = fixture(client, [a, b]); await f.tick();
    f.setRuns([{ ...b, status: 'completed' }, { ...a, status: 'completed' }]); await f.tick();
    assert.deepEqual(f.doc.querySelectorAll('[data-' + p + '-card]').map((c) => c.getAttribute('data-run')).sort(), ['a', 'b']);
  });
  test(client.name + ': artifact path is escaped inside its title attribute', async () => {
    const f = fixture(client, [run('art', 'completed', { artifacts: [{ title: 'proof', kind: 'file', path: 'C:/x" onmouseover="bad' }] })]); await f.tick();
    assert.equal(f.doc.querySelector('.' + p + '-art').getAttribute('onmouseover'), null);
  });
  test(client.name + ': light host theme selects a readable plugin palette', async () => {
    const f = fixture(client, [run('light')]); await f.tick();
    assert.equal(f.doc.documentElement.getAttribute('data-' + p + '-theme'), 'light');
    assert.match(f.doc.getElementById(p + '-pipeline-style').textContent, /--wf-strong:#20242d/);
  });
  test(client.name + ': manual dismiss stays hidden and records localStorage', async () => {
    const f = fixture(client, [run('dismiss', 'completed')]); await f.tick();
    f.doc.querySelector('[data-act="close"]').dispatch('click'); await f.tick();
    assert.equal(f.doc.querySelector('[data-run="dismiss"]'), null);
    assert.ok([...f.storage.values()].some((v) => JSON.parse(v).includes('dismiss')));
  });
  test(client.name + ': sidebar lines follow explicit session bindings only', async () => {
    const key = client.name === 'DSH' ? 'dwf-session-bindings' : 'mmxdwf-session-bindings';
    const storage = new Map([[key, JSON.stringify({ 'bound-run': { sessionId: 's1' } })]]);
    const f = fixture(client, [run('bound-run', 'completed'), run('unbound-run', 'completed', { startedAt: '2026-09-29T00:05:00Z' })], { storage });
    const mkRow = (sid) => { const r = f.doc.createElement('div'); r.className = 'sessionRow'; r.setAttribute('data-session-id', sid); r.textContent = 'session ' + sid; f.doc.body.appendChild(r); return r; };
    const r1 = mkRow('s1'); const r2 = mkRow('s2');
    await f.tick();
    assert.match(r1.querySelector('[data-' + p + '-line]').textContent, /bound-run/);
    assert.equal(r2.querySelector('[data-' + p + '-line]'), null, 'unbound runs must not appear under any session row');
  });
  test(client.name + ': terminal header counts settled agents rather than currently running agents', async () => {
    const f = fixture(client, [run('count', 'completed', { calls: [{ callId: 'a', state: 'done' }, { callId: 'b', state: 'done' }], settled: 2 })]); await f.tick();
    assert.match(f.doc.querySelector('.' + p + '-stats').textContent, /2 个子代理已结束/);
  });
  test(client.name + ': live elapsed time advances without a new journal event and freezes at completion', async () => {
    let now = Date.parse('2026-09-29T00:01:01Z');
    const q = run('clock', 'running', { elapsedMs: 7, questions: [{ qId: 'q1', question: '保持草稿', state: 'waiting' }] });
    const f = fixture(client, [q], { now: () => now }); await f.tick();
    const input = f.doc.querySelector('.' + p + '-qin'); input.value = '计时刷新不丢草稿'; input.focus();
    assert.match(f.doc.querySelector('.' + p + '-stats').textContent, /1分01秒/);
    now += 1000; await f.tick();
    assert.match(f.doc.querySelector('.' + p + '-stats').textContent, /1分02秒/);
    assert.equal(f.doc.querySelector('.' + p + '-qin'), input);
    assert.equal(input.value, '计时刷新不丢草稿');
    f.setRuns([{ ...q, status: 'completed', elapsedMs: 63000 }]); now += 100000; await f.tick();
    assert.match(f.doc.querySelector('.' + p + '-stats').textContent, /1分03秒/);
  });
  test(client.name + ': minute rounding never renders sixty seconds', async () => {
    const f = fixture(client, [run('round', 'completed', { elapsedMs: 119999 })]); await f.tick();
    assert.match(f.doc.querySelector('.' + p + '-stats').textContent, /2分00秒/);
  });
  test(client.name + ': modal can be reopened after close', async () => {
    const f = fixture(client, [run('done', 'completed')]); await f.tick();
    f.doc.querySelector('[data-act="history"]').dispatch('click');
    f.doc.querySelector('[data-act="mclose"]').dispatch('click');
    f.doc.querySelector('[data-act="result"]').dispatch('click');
    assert.equal(f.doc.getElementById(p + '-modal').style.display, 'flex');
  });

  // ---------- 0.2.4 contract (REPAIR-024) ----------
  test(client.name + ': phase semantics distinguish failure, rejection, partial and zero-agent completion', async () => {
    const f1 = fixture(client, [run('ph-all-failed', 'failed', { phases: [{ name: 'audit', dispatched: 2, settled: 2, failed: 2, rejected: 0 }] })]); await f1.tick();
    const allFailed = f1.doc.querySelector('.' + p + '-pcol').className;
    assert.match(allFailed, /\bfailed\b/); assert.doesNotMatch(allFailed, /\bdone\b/);

    const f2 = fixture(client, [run('ph-partial', 'completed', { phases: [{ name: 'audit', dispatched: 2, settled: 2, failed: 1, rejected: 0 }] })]); await f2.tick();
    const partial = f2.doc.querySelector('.' + p + '-pcol');
    assert.match(partial.className, /\bpartial\b/); assert.doesNotMatch(partial.className, /\bdone\b/);
    assert.match(partial.textContent, /失败1/);

    const f3 = fixture(client, [run('ph-zero', 'completed', { phases: [{ name: 'planned', dispatched: 0, settled: 0, failed: 0, rejected: 0 }] })]); await f3.tick();
    assert.match(f3.doc.querySelector('.' + p + '-pcol').className, /\bdone\b/, 'a zero-agent phase of a completed run derives completion from the run terminal state');

    const f4 = fixture(client, [run('ph-terminal-zero', 'failed', { currentPhase: 'planned', phases: [{ name: 'planned', dispatched: 0 }] })]); await f4.tick();
    const terminalZero = f4.doc.querySelector('.' + p + '-pcol').className;
    assert.doesNotMatch(terminalZero, /\b(done|now|failed)\b/, 'the current zero-agent phase of a terminated run must not claim success');

    const f5 = fixture(client, [run('ph-early', 'running', { currentPhase: 'second', phases: [
      { name: 'first', dispatched: 2, settled: 2, failed: 0, rejected: 0 },
      { name: 'second', dispatched: 1, settled: 0, failed: 0, rejected: 0 }] })]); await f5.tick();
    const classes = f5.doc.querySelectorAll('.' + p + '-pcol').map((e) => e.className);
    assert.match(classes[0], /\bdone\b/, 'an earlier fully-settled clean phase shows done while a later phase runs');
    assert.match(classes[1], /\bnow\b/);

    const f6 = fixture(client, [run('ph-rejected', 'completed', { phases: [{ name: 'gate', dispatched: 1, settled: 0, failed: 0, rejected: 1 }] })]); await f6.tick();
    const rejected = f6.doc.querySelector('.' + p + '-pcol').className;
    assert.match(rejected, /\brejected\b/); assert.doesNotMatch(rejected, /\bdone\b/);
  });

  test(client.name + ': runKey becomes the DOM, cache and request identity', async () => {
    const f = fixture(client, [run('legacy-id', 'completed', { runKey: 'key-1' })]); await f.tick();
    assert.equal(f.doc.querySelector('[data-' + p + '-card]').getAttribute('data-run'), 'key-1');
    const resultReq = f.requests.find((r) => r.url.includes('/result?'));
    assert.ok(resultReq.url.includes('run=key-1&startedAt='), 'run-scoped requests must carry runKey and startedAt: ' + resultReq.url);
  });

  test(client.name + ': duplicate runIds with distinct runKeys keep independent controls', async () => {
    const a = run('dup', 'running', { runKey: 'ka', questions: [{ qId: 'q1', question: 'A?', state: 'waiting' }] });
    const b = run('dup', 'running', { runKey: 'kb', questions: [{ qId: 'q1', question: 'B?', state: 'waiting' }] });
    const f = fixture(client, [a, b]); await f.tick();
    const cards = f.doc.querySelectorAll('[data-' + p + '-card]');
    assert.deepEqual(cards.map((c) => c.getAttribute('data-run')), ['ka', 'kb']);
    f.doc.querySelector('[data-run="ka"]').querySelector('.' + p + '-qin').value = '回答A';
    f.doc.querySelector('[data-run="ka"]').querySelector('[data-act="answer"]').dispatch('click'); await f.tick();
    assert.equal(f.doc.querySelector('[data-run="ka"]').querySelector('[data-act="answer"]').disabled, true);
    assert.equal(f.doc.querySelector('[data-run="kb"]').querySelector('[data-act="answer"]').disabled, false, 'the same-name run in the other root must not inherit the pending answer');
  });

  test(client.name + ': legacy runId dismissal migrates only when the runId is unique', async () => {
    const key = client.name === 'DSH' ? 'dwf-pipeline-dismissed' : 'mmxdwf-dismissed';
    const visKey = client.name === 'DSH' ? 'dwf-pipeline-visible-runs' : 'mmxdwf-visible-runs';
    // 024-R4: visibility is seeded explicitly; the card pool no longer auto-introduces
    // finished runs, so dismissal semantics are observed on runs the user has watched.
    const f = fixture(client, [run('dup', 'completed', { runKey: 'ka' }), run('dup', 'completed', { runKey: 'kb', startedAt: '2026-09-29T00:05:00Z' })], { watched: false, storage: new Map([[key, JSON.stringify(['dup'])], [visKey, JSON.stringify(['ka', 'kb'])]]) }); await f.tick();
    assert.equal(f.doc.querySelectorAll('[data-' + p + '-card]').length, 2, 'an ambiguous legacy id must not silently dismiss runs');
    assert.equal(f.doc.querySelector('[data-run="ka"]') !== null, true, 'the older same-name run stays visible');
    const g = fixture(client, [run('dup', 'completed', { runKey: 'ka' })], { watched: false, storage: new Map([[key, JSON.stringify(['dup'])], [visKey, JSON.stringify(['ka'])]]) }); await g.tick();
    assert.equal(g.doc.querySelector('[data-' + p + '-card]'), null, 'a unique legacy runId still maps to its single run');
  });

  test(client.name + ': polling is single-flight while a request is pending', async () => {
    const f = fixture(client);
    const pending = [];
    f.sandbox.fetch = (url, opts) => { f.requests.push({ url, opts }); return new Promise((r) => pending.push(r)); };
    await f.tick(); await f.tick();
    assert.equal(pending.filter((_, i) => i < 2).length >= 1, true);
    const runsReqs = f.requests.filter((r) => String(r.url).endsWith('/runs'));
    assert.equal(runsReqs.length, 1, 'an overlapping tick must not issue a second /runs request');
    pending[0]({ ok: true, json: async () => ({ ok: true, runs: [run('sf')] }) });
    await flush();
    assert.ok(f.doc.querySelector('[data-run="sf"]'));
  });

  test(client.name + ': teardown cancels in-flight callbacks and clears all UI', async () => {
    const f = fixture(client, [run('late', 'completed')]); await f.tick();
    const pending = [];
    f.sandbox.fetch = (url) => new Promise((r) => pending.push(r));
    await f.tick();
    f.stop();
    pending.forEach((r) => r({ ok: true, json: async () => ({ ok: true, runs: [run('late2', 'running')] }) }));
    await flush();
    assert.equal(f.doc.getElementById(p + '-run-card'), null);
    assert.equal(f.doc.querySelector('[data-' + p + '-line]'), null);
    assert.equal(f.doc.getElementById(p + '-modal'), null);
    assert.equal(f.doc.getElementById(p + '-pipeline-style'), null);
  });

  test(client.name + ': teardown restores host row styles and the conversation anchor', async () => {
    const key = client.name === 'DSH' ? 'dwf-session-bindings' : 'mmxdwf-session-bindings';
    const storage = new Map([[key, JSON.stringify({ t1: { sessionId: 's1' } })]]);
    // 024-R4: the bound run drives the sidebar line; the unbound live run keeps the card
    // pool non-empty in this no-session fixture so the conversation anchor is claimed.
    const f = fixture(client, [run('t1', 'running'), run('t2', 'running')], { storage });
    const row = f.doc.createElement('div'); row.className = 'sessionRow'; row.setAttribute('data-session-id', 's1'); row.textContent = 'session';
    f.doc.body.appendChild(row);
    await f.tick();
    assert.equal(f.area.style.position, 'relative');
    assert.equal(row.style.flexWrap, 'wrap');
    f.stop();
    assert.equal(row.style.flexWrap, '', 'injected inline styles must be restored on teardown');
    assert.equal(row.style.height, '');
    assert.equal(row.style.minHeight, '');
    assert.equal(f.area.style.position, '', 'conversation anchor position must be restored');
    assert.equal(f.doc.getElementById(p + '-pipeline-style'), null);
    assert.equal(f.doc.querySelector('[data-' + p + '-line]'), null);
  });

  test(client.name + ': stop is single-submit, carries startedAt and surfaces server rejection', async () => {
    const f = fixture(client, [run('stop-err')], { post: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'AUDIT_STOP_REJECTED' }) }) }); await f.tick();
    const button = f.doc.querySelector('[data-act="stop"]');
    button.dispatch('click'); button.dispatch('click'); await flush();
    const stops = f.requests.filter((r) => r.url.includes('/stop?'));
    assert.equal(stops.length, 1, 'double click must not repeat the stop request');
    assert.ok(stops[0].url.includes('&startedAt='), 'stop must carry the expected lifecycle');
    assert.match(f.doc.querySelector('[data-run="stop-err"]').textContent, /AUDIT_STOP_REJECTED/);
    assert.equal(f.doc.querySelector('[data-act="stop"]').disabled, false, 'a rejected stop must re-enable the button');
  });

  test(client.name + ': stop pending state disables the button and confirms once', async () => {
    let reply; const pending = new Promise((r) => { reply = r; });
    const f = fixture(client, [run('stop-ok')], { post: () => pending }); await f.tick();
    f.doc.querySelector('[data-act="stop"]').dispatch('click');
    f.doc.querySelector('[data-act="stop"]').dispatch('click');
    assert.equal(f.requests.filter((r) => r.url.includes('/stop?')).length, 1);
    assert.equal(f.doc.querySelector('[data-act="stop"]').disabled, true);
    reply({ ok: true, json: async () => ({ ok: true }) });
    await flush();
    assert.match(f.doc.querySelector('[data-run="stop-ok"]').textContent, /已发送停止请求/);
  });

  test(client.name + ': network loss keeps cards and shows a stale banner until reconnect', async () => {
    const f = fixture(client, [run('offline')]); await f.tick();
    const realFetch = f.sandbox.fetch;
    f.sandbox.fetch = async () => { throw new Error('AUDIT_OFFLINE'); };
    await f.tick();
    assert.ok(f.doc.querySelector('[data-run="offline"]'), 'existing cards must survive a disconnection');
    assert.match(f.doc.body.textContent, /连接中断/);
    assert.match(f.doc.body.textContent, /最后同步|已过期/);
    f.sandbox.fetch = realFetch;
    await f.tick();
    assert.equal(f.doc.querySelector('.' + p + '-offline'), null, 'reconnect must clear the stale banner');
  });

  test(client.name + ': localStorage persistence failures become visible', async () => {
    const f = fixture(client, [run('persist-fail', 'completed')]); await f.tick();
    f.storage.set = () => { throw new Error('QuotaExceeded'); };
    f.doc.querySelector('[data-act="close"]').dispatch('click');
    await f.tick();
    assert.match(f.doc.body.textContent, /保存失败/);
  });

  test(client.name + ': cards keep a deterministic order (live first, newest started)', async () => {
    const olderLive = run('older-live', 'running', { startedAt: '2026-09-29T00:00:00Z' });
    const newerLive = run('newer-live', 'running', { startedAt: '2026-09-29T00:09:00Z' });
    const fin = run('fin', 'completed', { startedAt: '2026-09-29T00:05:00Z' });
    const f = fixture(client, [olderLive, fin, newerLive]); await f.tick();
    assert.deepEqual(f.doc.querySelectorAll('[data-' + p + '-card]').map((c) => c.getAttribute('data-run')), ['newer-live', 'older-live', 'fin']);
  });

  test(client.name + ': truncated agent list is labelled and offers the full view', async () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({ callId: 'c' + i, label: 'agent-' + i, state: 'done' }));
    const f = fixture(client, [run('many-agents', 'completed', { calls })]); await f.tick();
    assert.match(f.doc.querySelector('[data-run="many-agents"]').textContent, /共 30 个子代理/);
    f.doc.querySelector('[data-act="agentsfull"]').dispatch('click');
    const body = f.doc.querySelector('.' + p + '-mbody').textContent;
    assert.ok(body.includes('agent-0') && body.includes('agent-29'), 'the full list must be reachable');
  });

  test(client.name + ': truncated logs are labelled and offer the full view', async () => {
    const logs = Array.from({ length: 12 }, (_, i) => ({ text: 'log-' + i }));
    const f = fixture(client, [run('many-logs', 'running', { logs })]); await f.tick();
    assert.match(f.doc.querySelector('[data-run="many-logs"]').textContent, /共 12 条/);
    f.doc.querySelector('[data-act="logsfull"]').dispatch('click');
    const body = f.doc.querySelector('.' + p + '-mbody').textContent;
    assert.ok(body.includes('log-0') && body.includes('log-11'));
  });

  test(client.name + ': late modal responses for another run are discarded', async () => {
    const f = fixture(client, [run('A'), run('B')]); await f.tick();
    const pending = [];
    f.sandbox.fetch = (url) => new Promise((r) => pending.push({ url: String(url), resolve: r }));
    f.doc.querySelector('[data-run="A"]').querySelector('[data-act="board"]').dispatch('click');
    f.doc.querySelector('[data-run="B"]').querySelector('[data-act="board"]').dispatch('click');
    assert.equal(pending.length, 2);
    pending[1].resolve({ ok: true, json: async () => ({ ok: true, out: { result: { findings: [{ title: 'MARKER_B', severity: 'P1' }] } } }) });
    await flush();
    pending[0].resolve({ ok: true, json: async () => ({ ok: true, out: { result: { findings: [{ title: 'MARKER_A', severity: 'P1' }] } } }) });
    await flush();
    assert.match(f.doc.getElementById(p + '-mtitle').textContent, /B$/);
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /MARKER_B/);
    assert.doesNotMatch(f.doc.querySelector('.' + p + '-mbody').textContent, /MARKER_A/);
  });

  test(client.name + ': a different view type discards the previous view response', async () => {
    const f = fixture(client, [run('A'), run('B')]); await f.tick();
    const pending = [];
    f.sandbox.fetch = (url) => new Promise((r) => pending.push({ url: String(url), resolve: r }));
    f.doc.querySelector('[data-run="A"]').querySelector('[data-act="board"]').dispatch('click');
    f.doc.querySelector('[data-run="B"]').querySelector('[data-act="result"]').dispatch('click');
    pending[0].resolve({ ok: true, json: async () => ({ ok: true, out: { result: { findings: [{ title: 'MARKER_A' }] } } }) });
    await flush();
    assert.doesNotMatch(f.doc.querySelector('.' + p + '-mbody').textContent, /MARKER_A/);
    pending[1].resolve({ ok: true, json: async () => ({ ok: true, out: { result: 'RESULT_B' } }) });
    await flush();
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /RESULT_B/);
  });

  test(client.name + ': closing the modal discards late responses', async () => {
    const f = fixture(client, [run('C')]); await f.tick();
    const pending = [];
    f.sandbox.fetch = (url) => new Promise((r) => pending.push({ url: String(url), resolve: r }));
    f.doc.querySelector('[data-run="C"]').querySelector('[data-act="board"]').dispatch('click');
    f.doc.querySelector('[data-act="mclose"]').dispatch('click');
    pending[0].resolve({ ok: true, json: async () => ({ ok: true, out: { result: { findings: [{ title: 'LATE_MARKER' }] } } }) });
    await flush();
    assert.doesNotMatch(f.doc.querySelector('.' + p + '-mbody').textContent, /LATE_MARKER/);
  });

  test(client.name + ': only http(s) artifact URLs become links', async () => {
    const f = fixture(client, [run('schemes', 'running', { artifacts: [
      { kind: 'document', title: 'js', url: 'javascript:void(0)' },
      { kind: 'document', title: 'data', url: 'data:text/html,hi' },
      { kind: 'document', title: 'ok', url: 'https://example.com/a' },
    ] })]); await f.tick();
    const links = f.doc.querySelector('[data-run="schemes"]').querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute('href'), 'https://example.com/a');
    assert.match(f.doc.querySelector('[data-run="schemes"]').textContent, /已阻止|不支持/);
  });

  test(client.name + ': file artifacts download through the authenticated API and blob URLs are revoked', async () => {
    const f = fixture(client, [run('art-dl', 'completed', { artifacts: [{ kind: 'file', title: 'report', path: 'G:/x/report.txt' }] })]); await f.tick();
    const btn = f.doc.querySelector('[data-act="artifact"]');
    assert.ok(btn, 'file artifacts must offer an open/download action');
    btn.dispatch('click'); await flush();
    const req = f.requests.find((r) => r.url.includes('/artifact?'));
    assert.ok(req, 'artifact bytes must be fetched through the authenticated API');
    assert.ok(req.url.includes('run=art-dl&startedAt=') && req.url.includes('index=0'));
    assert.deepEqual(f.blobs.created, ['blob:mock-1']);
    f.stop();
    assert.deepEqual(f.blobs.revoked, ['blob:mock-1'], 'blob URLs must be revoked on teardown');
  });

  test(client.name + ': text artifacts preview as plain text', async () => {
    const f = fixture(client, [run('art-txt', 'completed', { artifacts: [{ kind: 'text', title: 'notes', path: 'G:/x/notes.txt' }] })], { artifactType: 'text/plain' }); await f.tick();
    f.doc.querySelector('[data-act="artifact"]').dispatch('click'); await flush();
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /artifact-text/);
  });

  test(client.name + ': artifact fetch failures are visible', async () => {
    const f = fixture(client, [run('art-err', 'completed', { artifacts: [{ kind: 'file', title: 'x', path: 'G:/x/x.bin' }] })]); await f.tick();
    f.sandbox.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'ARTIFACT_GONE' }) });
    f.doc.querySelector('[data-act="artifact"]').dispatch('click'); await flush();
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /ARTIFACT_GONE/);
  });
}

// ---------- MMX-specific: capability injection, version gate, DOM session source ----------
const mmx = clients.find((c) => c.name === 'MMX');

test('MMX: every request carries the injected capability placeholder header', async () => {
  const f = fixture(mmx, [run('cap', 'completed')]); await f.tick();
  assert.ok(f.requests.length > 0);
  for (const req of f.requests) {
    assert.equal(req.opts?.headers?.['X-Workflow-Capability'], '__MMXDWF_CAPABILITY__', 'apiFetch must inject the capability placeholder: ' + req.url);
    assert.ok(!String(req.url).includes('capability'), 'the capability must never travel in a URL');
  }
});

test('MMX: 403 responses surface in the stale banner', async () => {
  const f = fixture(mmx, [run('cap403', 'running')]);
  await f.tick();
  assert.ok(f.doc.querySelector('[data-run="cap403"]'));
  f.sandbox.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'CAPABILITY_MISMATCH' }) });
  await f.tick();
  assert.ok(f.doc.querySelector('[data-run="cap403"]'), 'a 403 must not clear shown cards');
  assert.match(f.doc.body.textContent, /403|连接中断/);
});

test('MMX: explicit binding to the current session filters cards, sidebar and history', async () => {
  const f = fixture(mmx);
  const active = f.doc.createElement('div');
  active.setAttribute('data-shortcut-session-active', 'true');
  active.setAttribute('data-shortcut-session-target', 'sess-9');
  f.doc.body.appendChild(active);
  const row = f.doc.createElement('div'); row.className = 'sessionRow'; row.setAttribute('data-session-id', 'sess-9'); row.textContent = '当前会话';
  const otherRow = f.doc.createElement('div'); otherRow.className = 'sessionRow'; otherRow.setAttribute('data-session-id', 'sess-8'); otherRow.textContent = '别的会话';
  f.doc.body.appendChild(row); f.doc.body.appendChild(otherRow);

  const live = run('live-unbound', 'running');
  f.setRuns([live]); await f.tick();
  assert.ok(f.doc.querySelector('[data-run="live-unbound"]'), 'an unbound live run stays visible so the user can bind it');
  assert.match(f.doc.querySelector('[data-run="live-unbound"]').textContent, /绑定当前会话/);
  assert.equal(row.querySelector('[data-mmxdwf-line]'), null, 'unbound runs get no sidebar line');
  assert.equal(otherRow.querySelector('[data-mmxdwf-line]'), null);

  f.doc.querySelector('[data-run="live-unbound"]').querySelector('[data-act="bind"]').dispatch('click'); await f.tick();
  assert.match(row.querySelector('[data-mmxdwf-line]').textContent, /live-unbound/);
  assert.equal(otherRow.querySelector('[data-mmxdwf-line]'), null, 'another session row must not show the bound run');
  const raw = f.storage.get('mmxdwf-session-bindings');
  assert.ok(raw && JSON.parse(raw)['live-unbound']?.sessionId === 'sess-9', 'binding must persist');

  f.setRuns([live, run('done-unbound', 'completed')]); await f.tick();
  assert.equal(f.doc.querySelector('[data-run="done-unbound"]'), null, 'an unbound finished run belongs to the global history, not the session view');
  assert.ok(f.doc.querySelector('[data-run="live-unbound"]'));

  const bindings = JSON.parse(f.storage.get('mmxdwf-session-bindings'));
  bindings['done-bound'] = { sessionId: 'sess-9' };
  f.storage.set('mmxdwf-session-bindings', JSON.stringify(bindings));
  const g = fixture(mmx, [run('done-bound', 'completed')], { storage: f.storage });
  const gActive = g.doc.createElement('div');
  gActive.setAttribute('data-shortcut-session-active', 'true');
  gActive.setAttribute('data-shortcut-session-target', 'sess-9');
  g.doc.body.appendChild(gActive);
  await g.tick();
  assert.ok(g.doc.querySelector('[data-run="done-bound"]'), 'a bound finished run shows in its session view');
});

test('MMX: history modal binds and unbinds runs to the current session', async () => {
  // an unbound finished run is invisible in the session view, so the entry point is the
  // global history modal; the run only becomes a session card after explicit binding
  const f = fixture(mmx);
  const active = f.doc.createElement('div');
  active.setAttribute('data-shortcut-session-active', 'true');
  active.setAttribute('data-shortcut-session-target', 'sess-9');
  f.doc.body.appendChild(active);
  const hist = run('hist-run', 'completed');
  f.setRuns([hist]); await f.tick();
  assert.equal(f.doc.querySelector('[data-run="hist-run"]'), null, 'unbound finished runs stay out of the session view');
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const bindBtn = f.doc.querySelector('[data-act="bindcurrent"]');
  assert.ok(bindBtn, 'history rows expose the bind action');
  assert.equal(bindBtn.disabled, false);
  bindBtn.dispatch('click'); await flush(); await f.tick();
  assert.ok(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['hist-run'], 'bind from history persists');
  assert.ok(f.doc.querySelector('[data-run="hist-run"]'), 'the bound run now shows in the session view');
  const unbindBtn = f.doc.querySelector('[data-act="unbindcurrent"]');
  assert.ok(unbindBtn);
  unbindBtn.dispatch('click'); await flush(); await f.tick();
  const after = f.storage.get('mmxdwf-session-bindings');
  assert.ok(!after || !JSON.parse(after)['hist-run'], 'unbind removes the mapping');
});

// ---------- DSH-specific: native ctx.sessions adapter ----------
const dsh = clients.find((c) => c.name === 'DSH');

test('DSH: current session comes from ctx.sessions and drives card filtering', async () => {
  let unsubscribed = 0;
  const sessionService = {
    getSnapshot: () => ({ ids: ['sess-9'], byId: { 'sess-9': { id: 'sess-9', cwd: 'G:/project', title: 't' } }, current: 'sess-9', phase: null }),
    subscribe: (fn) => { subs.push(fn); return () => { unsubscribed++; }; },
  };
  const subs = [];
  const f = fixture(dsh, [run('unbound-fin', 'completed')], { sessionService, watched: false }); await f.tick();
  assert.equal(f.doc.querySelector('[data-run="unbound-fin"]'), null, 'an unbound finished run is not attributed to the current session');
  f.setRuns([run('unbound-live', 'running')]); await f.tick();
  assert.ok(f.doc.querySelector('[data-run="unbound-live"]'), 'an unbound live run stays visible for explicit binding');
  assert.match(f.doc.querySelector('[data-run="unbound-live"]').textContent, /绑定当前会话/);
  f.doc.querySelector('[data-run="unbound-live"]').querySelector('[data-act="bind"]').dispatch('click'); await f.tick();
  assert.ok(f.doc.querySelector('[data-run="unbound-live"]'), 'after binding to the current session the run stays visible');
  f.stop();
  assert.equal(unsubscribed, 1, 'the sessions subscription must be released on teardown');
});

test('DSH: without ctx.sessions only unbound live and already-watched runs render (no global fallback)', async () => {
  // 024-R4: the old global fallback showed every finished run in any conversation without
  // a verifiable session — the exact behaviour behind the new-conversation card complaint.
  // The conversation view now stays attribution-safe; the global history modal remains the
  // global surface.
  const f = fixture(dsh, [run('unbound-fin', 'completed'), run('unbound-live', 'running')], { watched: false });
  await f.tick();
  assert.equal(f.doc.querySelector('[data-run="unbound-fin"]'), null, 'a finished run the user never watched must not auto-appear');
  assert.ok(f.doc.querySelector('[data-run="unbound-live"]'), 'an unbound live run stays visible for explicit binding');
  assert.match(f.doc.querySelector('[data-run="unbound-live"]').textContent, /未绑定/);
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const bindBtn = f.doc.querySelector('[data-act="bindcurrent"]');
  assert.ok(bindBtn, 'the global history still offers the bind entry');
  assert.equal(bindBtn.disabled, true, 'binding is impossible without a verifiable current session');
  assert.ok(f.doc.querySelector('.' + 'dwf' + '-mbody').textContent.includes('unbound-fin'), 'the finished run is still listed in the global history');
});

for (const client of clients) {
  const p = client.prefix;
  test(client.name + ': a failing HTTP status cannot be overridden by body ok', async () => {
    const f = fixture(client, [run('http-fail')], { post: async () => ({ ok: false, status: 409, json: async () => ({ ok: true }) }) });
    await f.tick();
    f.doc.querySelector('[data-act="stop"]').dispatch('click'); await flush();
    assert.equal(f.doc.querySelector('[data-act="stop"]').disabled, false);
    assert.match(f.doc.querySelector('[data-run="http-fail"]').textContent, /HTTP 409/);
  });
  test(client.name + ': run-scoped modal rejects a late result from an older lifecycle', async () => {
    const first = run('reuse', 'running');
    const f = fixture(client, [first]); await f.tick();
    const originalFetch = f.sandbox.fetch;
    let reply;
    f.sandbox.fetch = (url, opts) => url.includes('/result?') ? new Promise((r) => { reply = r; }) : originalFetch(url, opts);
    f.doc.querySelector('[data-act="result"]').dispatch('click');
    f.setRuns([{ ...first, startedAt: '2026-09-29T01:00:00Z' }]); await f.tick();
    reply({ ok: true, json: async () => ({ ok: true, out: { result: 'OLD_LIFECYCLE_RESULT' } }) }); await flush();
    assert.doesNotMatch(f.doc.querySelector('.' + p + '-mbody').textContent, /OLD_LIFECYCLE_RESULT/);
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /生命周期|重新打开|已重启/);
  });
  test(client.name + ': sidebar shows the current phase and teardown removes its run marker', async () => {
    const key = client.name === 'DSH' ? 'dwf-session-bindings' : 'mmxdwf-session-bindings';
    const f = fixture(client, [run('run-title', 'running', { currentPhase: '验证阶段' })], { storage: new Map([[key, JSON.stringify({ 'run-title': { sessionId: 's1' } })]]) });
    const row = f.doc.createElement('div'); row.className = 'sessionRow'; row.setAttribute('data-session-id', 's1'); f.doc.body.appendChild(row);
    await f.tick();
    assert.match(row.querySelector('[data-' + p + '-line]').textContent, /验证阶段/);
    f.stop();
    assert.equal(row.getAttribute('data-' + p + '-run'), null);
  });
  for (const view of ['result', 'board']) {
    test(client.name + ': ' + view + ' truncation provides a complete text download', async () => {
      const f = fixture(client, [run('large')]); await f.tick();
      const text = '中文长结果'.repeat(18000) + 'FULL_TEXT_END';
      const originalFetch = f.sandbox.fetch;
      f.sandbox.fetch = (url, opts) => url.includes('/result?') ? Promise.resolve({ ok: true, json: async () => ({ ok: true, out: { result: text } }) }) : originalFetch(url, opts);
      f.doc.querySelector('[data-act="' + view + '"]').dispatch('click'); await flush();
      const body = f.doc.querySelector('.' + p + '-mbody');
      assert.match(body.textContent, /截断/);
      assert.doesNotMatch(body.textContent, /64KB/);
      const link = body.querySelector('a');
      assert.ok(link && link.download, 'a complete text download must be available');
      assert.ok(f.blobs.values.some((value) => value._text.includes('FULL_TEXT_END')));
      f.doc.querySelector('[data-act="mclose"]').dispatch('click');
      assert.deepEqual(f.blobs.revoked, f.blobs.created);
    });
  }
}

for (const client of clients) {
  const p = client.prefix, host = client.name.toLowerCase();
  const native = (sid, otherHost = host) => ({ host: otherHost, sessionId: sid, source: otherHost === 'dsh' ? 'native-shell' : 'native-hook' });
  function nativeFixture(initial, options = {}) {
    let sid = 'same-session';
    const f = fixture(client, initial, { ...options, sessionService: { getSnapshot: () => ({ current: sid }), subscribe: () => () => {} } });
    const active = f.doc.createElement('div'); active.setAttribute('data-shortcut-session-active', 'true'); active.setAttribute('data-shortcut-session-target', sid); f.doc.body.appendChild(active);
    f.switchSession = (value) => { sid = value; active.setAttribute('data-shortcut-session-target', value); };
    return f;
  }
  test(client.name + ': native origin scopes concurrent cards without manual binding', async () => {
    const f = nativeFixture([run('ours', 'running', { hostSession: native('same-session') }), run('theirs', 'running', { hostSession: native('other-session') })]);
    await f.tick();
    assert.ok(f.doc.querySelector('[data-run="ours"]'));
    assert.equal(f.doc.querySelector('[data-run="theirs"]'), null);
    assert.equal(f.doc.querySelector('[data-act="bind"]'), null);
    f.switchSession('other-session'); await f.tick();
    assert.equal(f.doc.querySelector('[data-run="ours"]'), null);
    assert.ok(f.doc.querySelector('[data-run="theirs"]'));
  });
  test(client.name + ': identical session ids in another host never claim this host session', async () => {
    const f = nativeFixture([run('foreign', 'running', { hostSession: native('same-session', host === 'dsh' ? 'mmx' : 'dsh') })]);
    const row = f.doc.createElement('div'); row.className = 'sessionRow'; row.setAttribute('data-session-id', 'same-session'); f.doc.body.appendChild(row);
    await f.tick();
    assert.equal(f.doc.querySelector('[data-run="foreign"]'), null);
    assert.equal(row.querySelector('[data-' + p + '-line]'), null);
  });
  test(client.name + ': native origin overrides obsolete local bindings and cannot be rebound from history', async () => {
    const key = client.name === 'DSH' ? 'dwf-session-bindings' : 'mmxdwf-session-bindings';
    const f = nativeFixture([run('native', 'running', { hostSession: native('other-session') })], { storage: new Map([[key, JSON.stringify({ native: { sessionId: 'same-session' } })]]) });
    await f.tick();
    assert.equal(f.doc.querySelector('[data-run="native"]'), null);
    f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
    const body = f.doc.querySelector('.' + p + '-mbody');
    assert.match(body.textContent, /原生.*other-session/);
    assert.equal(body.querySelector('[data-act="bindcurrent"]'), null);
    assert.equal(body.querySelector('[data-act="unbindcurrent"]'), null);
  });
  test(client.name + ': corrupt native origin is quarantined rather than treated as unbound', async () => {
    const f = nativeFixture([run('bad-origin', 'running', { hostSession: { host, sessionId: 'same-session', source: 'guessed' } })]);
    await f.tick();
    assert.equal(f.doc.querySelector('[data-run="bad-origin"]'), null);
    f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
    assert.match(f.doc.querySelector('.' + p + '-mbody').textContent, /归属数据无效/);
  });
}

// ---------- 024-R4: view-state machine + attribution-safe fallback (new-conversation complaint) ----------

test('MMX: the new-conversation home page never carries conversation cards', async () => {
  // User complaint: opening a new conversation showed a stack of finished workflow cards at
  // the top. mavis-home-content (no message-list) is the home route: the conversation card
  // host must not exist there at all — not for live runs, not for watched runs, not offline.
  const f = fixture(mmx, [run('home-live', 'running'), run('home-fin', 'completed')]);
  f.area.setAttribute('data-testid', 'mavis-home-content');
  await f.tick();
  assert.equal(f.doc.getElementById('mmxdwf-run-card'), null, 'no card host on the home route');
  assert.equal(f.doc.querySelector('[data-run="home-live"]'), null, 'even live runs stay off the home route');
  assert.equal(f.doc.querySelector('[data-run="home-fin"]'), null, 'watched finished runs stay off the home route');
  f.sandbox.fetch = async () => { throw new Error('HOME_OFFLINE'); };
  await f.tick();
  assert.equal(f.doc.getElementById('mmxdwf-run-card'), null, 'the offline banner must not resurrect the host on the home route either');
});

test('MMX: unknown routes (neither home nor conversation) drop the card host', async () => {
  const f = fixture(mmx, [run('route-live', 'running')]); await f.tick();
  assert.ok(f.doc.getElementById('mmxdwf-run-card'), 'a conversation route shows the live card');
  f.area.setAttribute('data-testid', 'settings-page');
  await f.tick();
  assert.equal(f.doc.getElementById('mmxdwf-run-card'), null, 'no known conversation container means no card host');
  f.area.setAttribute('data-testid', 'message-list');
  await f.tick();
  assert.ok(f.doc.getElementById('mmxdwf-run-card'), 'returning to a conversation restores the card');
});

for (const client of clients) {
  const p = client.prefix;
  const curModeFixture = (initial, options = {}) => {
    if (client.name === 'MMX') {
      const f = fixture(client, initial, options);
      const active = f.doc.createElement('div');
      active.setAttribute('data-shortcut-session-active', 'true');
      active.setAttribute('data-shortcut-session-target', 'sess-cur');
      f.doc.body.appendChild(active);
      return f;
    }
    return fixture(client, initial, { ...options, sessionService: { getSnapshot: () => ({ current: 'sess-cur' }), subscribe: () => () => {} } });
  };
  test(client.name + ': an unbound run the user watched keeps its card after finishing in the session view', async () => {
    const f = curModeFixture([run('watchme', 'running')]); await f.tick();
    assert.ok(f.doc.querySelector('[data-run="watchme"]'));
    f.setRuns([run('watchme', 'completed')]); await f.tick();
    assert.ok(f.doc.querySelector('[data-run="watchme"]'), 'a watched run must stay until manually closed, even unbound');
  });
  test(client.name + ': runs native-bound to another session never leak into the no-session fallback', async () => {
    const native = { host: client.name === 'DSH' ? 'dsh' : 'mmx', sessionId: 'other-session', source: client.name === 'DSH' ? 'native-shell' : 'native-hook' };
    const key = client.name === 'DSH' ? 'dwf-pipeline-visible-runs' : 'mmxdwf-visible-runs';
    const f = fixture(client, [run('foreign-fin', 'completed', { hostSession: native })], { watched: false, storage: new Map([[key, JSON.stringify(['foreign-fin'])]]) });
    await f.tick();
    assert.equal(f.doc.querySelector('[data-run="foreign-fin"]'), null, 'a run attributed to another session must not render in this view');
  });
  test(client.name + ': per-run state is pruned when runs leave the /runs list', async () => {
    const key = client.name === 'DSH' ? 'dwf-pipeline-visible-runs' : 'mmxdwf-visible-runs';
    const f = fixture(client, [run('gone', 'running'), run('stay', 'running')], { watched: false, storage: new Map([[key, JSON.stringify(['gone', 'stay', 'zombie'])]]) });
    await f.tick();
    f.setRuns([run('stay', 'running')]); await f.tick();
    assert.deepEqual(JSON.parse(f.storage.get(key)), ['stay'], 'visible ids no longer backed by a run must be evicted');
  });
  test(client.name + ': result previews are hydrated only for runs in the current card pool', async () => {
    const f = fixture(client, [run('far-fin', 'completed'), run('live', 'running')], { watched: false });
    await f.tick(); await flush();
    assert.equal(f.requests.filter((r) => r.url.includes('/result?')).length, 0, 'off-pool finished runs must not be hydrated');
  });
  test(client.name + ': a 404 result is fetched once, never retried every poll', async () => {    // Measured live: a terminal run without out.json was refetched every 2s — thousands of
    // console errors per day. The negative cache must hold for the whole lifecycle key.
    const f = fixture(client, [run('no-out', 'completed')]);
    const realFetch = f.sandbox.fetch;
    f.sandbox.fetch = (url, opts) => {
      f.requests.push({ url: String(url), opts }); // the override bypasses the fixture recorder
      return String(url).includes('/result?')
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({ ok: false, error: 'run has no out.json yet' }) })
        : realFetch(url, opts);
    };
    await f.tick(); await flush();
    await f.tick(); await flush();
    await f.tick(); await flush();
    assert.equal(f.requests.filter((r) => String(r.url).includes('/result?')).length, 1, 'a 404 result must be negatively cached, not refetched');
    assert.ok(f.doc.querySelector('[data-run="no-out"]'), 'the card itself still renders');
    assert.equal(f.doc.querySelector('[data-run="no-out"]').querySelector('.' + p + '-result'), null, 'no result preview section for a resultless run');
  });
  test(client.name + ': returning to a visible window polls immediately (no throttle wait)', async () => {
    // Chromium intensively throttles timers in hidden windows — a focused window must not
    // wait for the next (possibly minute-delayed) frozen tick. visibilitychange fires a
    // catch-up poll directly, plus a trailing one in case the first was single-flight-skipped.
    const f = fixture(client, [run('wake', 'running')]);
    await new Promise((r) => setImmediate(r)); // let start() register the listener
    assert.equal(f.requests.filter((r) => String(r.url).endsWith('/runs')).length, 0, 'no automatic poll before the interval fires');
    f.doc.visibilityState = 'visible';
    (f.docListeners.visibilitychange || []).forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    assert.ok(f.requests.filter((r) => String(r.url).endsWith('/runs')).length >= 1, 'a visible window must trigger an immediate catch-up poll');
    const before = f.requests.length;
    f.doc.visibilityState = 'hidden';
    (f.docListeners.visibilitychange || []).forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    assert.equal(f.requests.length, before, 'hiding the window must not spam extra polls');
    f.doc.visibilityState = 'visible';
    (f.docListeners.visibilitychange || []).forEach((fn) => fn());
    f.stop();
    assert.equal((f.docListeners.visibilitychange || []).length, 0, 'teardown must release the visibility listener');
  });
}

// ---------- 024-R4 续: MMX 无活动标记时的显式会话选择绑定 ----------
test('MMX: without an active-session marker the card offers a session picker that binds and draws the sidebar line', async () => {
  // Measured on the live 3.1.0 build: the active marker is absent entirely, so the one-click
  // "bind current session" can never appear. Picking a row explicitly is still a user action,
  // so attribution stays verifiable — the run lands under the session the user chose.
  const f = fixture(mmx, [run('pick-me', 'running')]);
  const mkRow = (sid, title) => { const r = f.doc.createElement('div'); r.setAttribute('data-session-id', sid); r.textContent = title; f.doc.body.appendChild(r); return r; };
  const rowA = mkRow('447987372052656', '第一个会话');
  const rowB = mkRow('447683061084721', '第二个会话');
  await f.tick();
  assert.equal(f.doc.querySelector('[data-act="bind"]'), null, 'one-click bind needs a verifiable current session');
  assert.ok(f.doc.querySelector('[data-act="bindpick"]'), 'the picker entry must exist without an active marker');

  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  const rows = f.doc.querySelectorAll('.mmxdwf-srow');
  assert.equal(rows.length, 2, 'the picker lists every sidebar session');
  assert.ok(rows[0].textContent.includes('第一个会话'));
  rows[1].dispatch('click'); await f.tick();
  assert.equal(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['pick-me'].sessionId, '447683061084721', 'the chosen session id is what gets bound');
  assert.ok(rowB.querySelector('[data-mmxdwf-line]'), 'the sidebar line appears on the chosen row');
  assert.equal(rowA.querySelector('[data-mmxdwf-line]'), null, 'and never on any other row');
  assert.equal(f.doc.querySelector('[data-act="bindpick"]'), null, 'a bound run offers no further binding');
});

test('MMX: the session picker re-lists current sidebar sessions instead of a stale snapshot', async () => {
  const f = fixture(mmx, [run('pick-live', 'running')]);
  const early = f.doc.createElement('div'); early.setAttribute('data-session-id', 'sid-early'); early.textContent = '早的会话';
  f.doc.body.appendChild(early);
  await f.tick();
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 1);
  f.doc.querySelector('[data-act="mclose"]').dispatch('click');
  const late = f.doc.createElement('div'); late.setAttribute('data-session-id', 'sid-late'); late.textContent = '新的会话';
  f.doc.body.appendChild(late);
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  assert.deepEqual(f.doc.querySelectorAll('.mmxdwf-srow').map((r) => r.textContent.trim()), ['早的会话', '新的会话'],
    'sessions added after the first open must be selectable');
});

test('MMX: an empty sidebar keeps the picker usable and explains itself', async () => {
  const f = fixture(mmx, [run('pick-empty', 'running')]);
  await f.tick();
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /没有可绑定的会话|暂无会话/);
});

function addSession(f, sid, title) {
  const el = f.doc.createElement('div');
  el.setAttribute('data-session-id', sid);
  el.textContent = title;
  f.doc.body.appendChild(el);
}

test('MMX: the picker filters hundreds of sidebar sessions as you type', async () => {
  const f = fixture(mmx, [run('pick-filter', 'running')]);
  for (let i = 0; i < 40; i++) addSession(f, 'mvs_' + i, '会话 ' + i);
  addSession(f, 'mvs_deadbeef', '排查 Codex 无法启动');
  await f.tick();
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 41, 'every session is offered before filtering');
  const filter = f.doc.querySelector('.mmxdwf-filter');
  filter.value = 'codex';
  filter.dispatch('input');
  assert.deepEqual(f.doc.querySelectorAll('.mmxdwf-srow').map((r) => r.textContent), ['排查 Codex 无法启动'],
    'the filter matches the title case-insensitively');
  assert.match(f.doc.querySelector('.mmxdwf-pickhead').textContent, /1 \/ 41/, 'the counter names the subset on screen');
  filter.value = 'DEADBEEF';
  filter.dispatch('input');
  assert.deepEqual(f.doc.querySelectorAll('.mmxdwf-srow').map((r) => r.getAttribute('data-sid')), ['mvs_deadbeef'],
    'the filter also matches the raw session id');
  filter.value = '   ';
  filter.dispatch('input');
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 41, 'whitespace alone is not a filter');
});

test('MMX: a filter that matches nothing says so instead of showing an empty box', async () => {
  const f = fixture(mmx, [run('pick-nomatch', 'running')]);
  addSession(f, 'mvs_a', '第一个会话');
  await f.tick();
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  const filter = f.doc.querySelector('.mmxdwf-filter');
  filter.value = 'zzz-不存在';
  filter.dispatch('input');
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 0);
  const none = f.doc.querySelector('.mmxdwf-picknone');
  assert.equal(none.style.display, 'block');
  assert.match(none.textContent, /zzz-不存在/);
  filter.value = '会话';
  filter.dispatch('input');
  assert.equal(none.style.display, 'none', 'the empty state clears as soon as something matches again');
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 1);
});

test('MMX: reopening the picker starts from a clean filter', async () => {
  const f = fixture(mmx, [run('pick-reopen', 'running')]);
  addSession(f, 'mvs_a', '甲会话');
  addSession(f, 'mvs_b', '乙会话');
  await f.tick();
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  const first = f.doc.querySelector('.mmxdwf-filter');
  first.value = '甲';
  first.dispatch('input');
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 1);
  f.doc.querySelector('[data-act="mclose"]').dispatch('click');
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  assert.equal(f.doc.querySelector('.mmxdwf-filter').value, '', 'a stale query must not silently hide sessions');
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 2);
});

// ---------- v8: marker-less host (3.1.0) must stay fully usable ----------
// Measured 3.1.0 has NO active-session marker: currentSessionId() is always ''. These tests
// run with no data-shortcut-session-active element at all — the real production shape.

test('MMX v8: binding keeps the card instead of deleting it (no active-session marker)', async () => {
  const f = fixture(mmx, [run('bind-keep', 'running')]);
  const row = f.doc.createElement('div');
  row.setAttribute('data-session-id', 'sess-b');
  row.textContent = '真实会话标题';
  f.doc.body.appendChild(row);
  await f.tick();
  assert.ok(f.doc.querySelector('[data-run="bind-keep"]'), 'live card is up');
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-b"]').dispatch('click'); await flush();
  await f.tick(); await f.tick();
  assert.ok(f.doc.querySelector('[data-run="bind-keep"]'), 'the card the user just bound must stay on screen');
  assert.equal(f.doc.querySelector('[data-act="bindpick"]'), null, 'a bound run offers no further binding');
  assert.ok(f.doc.querySelector('[data-mmxdwf-line]'), 'the sidebar line is painted');
});

test('MMX v8: history rows offer the session picker on a marker-less host', async () => {
  const f = fixture(mmx, [run('hist-pick', 'completed')], { watched: false });
  const row = f.doc.createElement('div');
  row.setAttribute('data-session-id', 'sess-h');
  row.textContent = '历史会话';
  f.doc.body.appendChild(row);
  await f.tick();
  assert.equal(f.doc.querySelector('[data-run="hist-pick"]'), null, 'never-watched finished run stays out of the card view');
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const dead = f.doc.querySelector('[data-act="bindcurrent"]');
  const pick = [...f.doc.querySelectorAll('.mmxdwf-hrow')].flatMap((r) => [...r.querySelectorAll('[data-act="bindpick"]')])[0];
  assert.equal(dead, null, 'the one-click bind must not render disabled on a host with no marker');
  assert.ok(pick, 'the history row names the session via the picker instead');
  pick.dispatch('click'); await flush();
  f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-h"]').dispatch('click'); await flush();
  const saved = JSON.parse(f.storage.get('mmxdwf-session-bindings'))['hist-pick'];
  assert.ok(saved, 'binding from the history row persists');
  assert.equal(saved.sessionId, 'sess-h');
  assert.equal(saved.host, 'mmx');
  assert.equal(saved.source, 'mmx-picker', 'the persisted record names its origin');
});

test('MMX v8: a finished run is reachable from global history even with no card on screen', async () => {
  const f = fixture(mmx, [run('orphan-fin', 'completed')], { watched: false });
  await f.tick();
  assert.equal(f.doc.querySelector('[data-run="orphan-fin"]'), null, 'no card: never-watched finished run');
  const notice = f.doc.querySelector('[data-act="history"]');
  assert.ok(notice, 'with runs existing, the no-card view still names the global-history entry');
  notice.dispatch('click'); await flush();
  assert.ok(f.doc.querySelector('.mmxdwf-hrow'), 'the history modal lists the finished run');
  assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /orphan-fin/);
});

test('MMX v8: the picker reads titles without our injected progress line', async () => {
  const f = fixture(mmx, [run('title-clean', 'running')]);
  const row = f.doc.createElement('div');
  row.setAttribute('data-session-id', 'sess-t');
  const title = f.doc.createElement('span');
  title.className = 'w-0 flex-1 text-sm truncate';
  title.textContent = '排查 Codex 无法启动';
  row.appendChild(title);
  f.doc.body.appendChild(row);
  await f.tick();
  // simulate what a previous binding painted into that row: a progress line child
  const line = f.doc.createElement('div');
  line.setAttribute('data-mmxdwf-line', '1');
  line.textContent = '⑂ 收尾阶段';
  row.appendChild(line);
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  const entry = f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-t"]');
  assert.equal(entry.textContent, '排查 Codex 无法启动', 'the picker title must not swallow the injected line text');
});

test('DSH: the client module declares the services it touches for Cordis inject', async () => {
  const source = readFileSync(dsh.path, 'utf8');
  assert.match(source, /exports\.inject = \['sessions'\]/, 'exports.inject must pre-declare ctx.sessions');
  const f = fixture(dsh, [run('inj', 'completed')], { sessionService: { getSnapshot: () => ({ current: 's' }), subscribe: () => () => {} } });
  await f.tick();
  const injected = [];
  const strictCtx = { effect: (fn) => { effectTeardownGlobal = fn(); }, get sessions() { injected.push('sessions'); return { list: { getSnapshot: () => ({ current: 's2' }), subscribe: () => () => {} } }; } };
  let effectTeardownGlobal;
  const captured = {};
  f.sandbox.__ModuleLoader__ = { load: ({ factory }) => { const e = factory(require); captured.inject = e.inject; captured.apply = e.apply; } };
  function require() { return {}; }
  vm.runInNewContext(readFileSync(dsh.path, 'utf8'), f.sandbox);
  assert.equal(captured.inject && captured.inject.join(','), 'sessions');
  captured.apply(strictCtx);
  assert.ok(injected.includes('sessions'), 'ctx.sessions is reachable inside the effect');
});

test('MMX: teardown before DOM readiness prevents all late initialization', async () => {
  const f = fixture(mmx, [], { domReadyPending: true });
  const callbacks = [...(f.docListeners.DOMContentLoaded || []), ...(f.winListeners.load || [])];
  assert.equal(typeof f.sandbox.__mmxDwfTeardown, 'function');
  f.stop();
  f.doc.body = f.doc.createElement('body'); f.doc.documentElement.appendChild(f.doc.body); f.doc.body.appendChild(f.area);
  callbacks.forEach((fn) => fn()); await flush();
  assert.equal(f.intervals.length, 0);
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.doc.getElementById('mmxdwf-pipeline-style'), null);
  assert.equal((f.docListeners.DOMContentLoaded || []).length, 0);
  assert.equal((f.winListeners.load || []).length, 0);
});

// ---------- v9 repairs ----------
// Live measurement (2026-10-03, MiniMax Code 3.1.0): the host writes its active session id into
// sessionStorage['mavis:activeSessionId'] on every tab, and the sidebar row of that session is
// ALSO marked in the DOM. Both are the host telling us which session is active; the DOM marker
// only exists while that row is rendered, so it comes and goes. v8 assumed the marker was never
// there; v9 reads the host state first and keeps every cur and no-cur path working.

const SESSION_STATE_KEY = 'mavis:activeSessionId';
const mvsId = (c) => 'mvs_' + c.repeat(32);
const histPickOf = (f) => f.doc.querySelectorAll('.mmxdwf-hrow').flatMap((r) => [...r.querySelectorAll('[data-act="bindpick"]')])[0];

test('MMX v9: the current session comes from the host session state first, the DOM marker second', async () => {
  const stored = mvsId('a');
  // (1) no DOM marker at all: the host state alone must still drive the one-click bind
  const f = fixture(mmx, [run('ss-only', 'running')], { sessionStorage: new Map([[SESSION_STATE_KEY, stored]]) });
  await f.tick();
  assert.match(f.doc.querySelector('[data-run="ss-only"]').textContent, /绑定当前会话/,
    'the host session state is enough to offer the one-click bind');
  f.doc.querySelector('[data-act="bind"]').dispatch('click'); await f.tick();
  assert.equal(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['ss-only'].sessionId, stored);

  // (2) both sources present and disagreeing: the host state wins
  const marked = mvsId('c');
  const g = fixture(mmx, [run('ss-conflict', 'running')], { sessionStorage: new Map([[SESSION_STATE_KEY, mvsId('b')]]) });
  const marker = g.doc.createElement('div');
  marker.setAttribute('data-shortcut-session-active', 'true');
  marker.setAttribute('data-shortcut-session-target', marked);
  g.doc.body.appendChild(marker);
  await g.tick();
  g.doc.querySelector('[data-act="bind"]').dispatch('click'); await f.tick();
  assert.equal(JSON.parse(g.storage.get('mmxdwf-session-bindings'))['ss-conflict'].sessionId, mvsId('b'),
    'a stale or virtualized-away DOM marker must not outrank the host session state');

  // (3) unusable values are treated as absent — never guessed, never half-trusted
  for (const bad of ['', 'garbage', 'mvs_short', 'mvs_' + 'A'.repeat(32), 'mvs_' + 'g'.repeat(32)]) {
    const h = fixture(mmx, [run('ss-bad', 'running')], { sessionStorage: new Map([[SESSION_STATE_KEY, bad]]) });
    await h.tick();
    assert.equal(h.doc.querySelector('[data-act="bind"]'), null, 'an unusable session value counts as absent: ' + JSON.stringify(bad));
    assert.ok(h.doc.querySelector('[data-act="bindpick"]'), '... and the explicit picker stays available: ' + JSON.stringify(bad));
  }
  const i = fixture(mmx, [run('ss-fallback', 'running')], { sessionStorage: new Map([[SESSION_STATE_KEY, 'garbage']]) });
  const fallback = i.doc.createElement('div');
  fallback.setAttribute('data-shortcut-session-active', 'true');
  fallback.setAttribute('data-shortcut-session-target', stored);
  i.doc.body.appendChild(fallback);
  await i.tick();
  i.doc.querySelector('[data-act="bind"]').dispatch('click'); await f.tick();
  assert.equal(JSON.parse(i.storage.get('mmxdwf-session-bindings'))['ss-fallback'].sessionId, stored,
    'the DOM marker is still the fallback source when the stored value is unusable');
});

test('MMX v9: with no current session, native and quarantined runs get no dead picker button', async () => {
  // bindRunToSession refuses a run that carries a hostSession, so rendering the picker for
  // those rows was a control that looked live and wrote nothing.
  const f = fixture(mmx, [
    run('nat-hist', 'completed', { hostSession: { host: 'mmx', sessionId: 'mvs_native', source: 'native-hook' } }),
    run('bad-hist', 'completed', { hostSession: { host: 'mmx', sessionId: 'mvs_bad', source: 'guessed' } }),
    run('plain-hist', 'completed'),
  ], { watched: false });
  await f.tick();
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const rowFor = (id) => f.doc.querySelectorAll('.mmxdwf-hrow').find((r) => r.textContent.includes(id));
  const nat = rowFor('nat-hist'), bad = rowFor('bad-hist'), plain = rowFor('plain-hist');
  assert.ok(nat && bad && plain, 'all three runs are listed in the global history');
  assert.equal(nat.querySelector('[data-act="bindpick"]'), null, 'a native run must not offer a manual re-bind');
  assert.equal(nat.querySelector('[data-act="bindcurrent"]'), null);
  assert.equal(bad.querySelector('[data-act="bindpick"]'), null, 'a quarantined origin must not either');
  assert.match(nat.textContent, /原生会话/);
  assert.match(bad.textContent, /归属数据无效/);
  assert.ok(plain.querySelector('[data-act="bindpick"]'), 'a plain unbound run still names its session explicitly');
  assert.equal(f.doc.querySelectorAll('[data-act="bindpick"]').length, 1, 'exactly one live bind control');
});

test('MMX v9: a run that has left /runs is still bindable from its history row', async () => {
  // The whole point of the historyRuns fallback: the snapshot is the only place the run exists
  // now, so the picker it opens must survive the next poll and the row click must land.
  const f = fixture(mmx, [run('hist-only', 'completed')], { watched: false });
  const row = f.doc.createElement('div'); row.setAttribute('data-session-id', 'sess-ho'); row.textContent = '历史会话';
  f.doc.body.appendChild(row);
  await f.tick();
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const pick = histPickOf(f);
  assert.ok(pick, 'the history row offers the picker');
  f.setRuns([]); await f.tick();                      // the run leaves the polled list
  pick.dispatch('click'); await flush();
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 1, 'the picker opens for a history-only run');
  await f.tick();                                     // a poll must not tear the picker down
  assert.ok(f.doc.querySelector('.mmxdwf-srow'), 'the picker survives the modal lifecycle check');
  f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-ho"]').dispatch('click'); await flush();
  assert.equal(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['hist-only'].sessionId, 'sess-ho',
    "the user's explicit bind reaches disk instead of being swallowed");
  assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /已绑定会话 sess-ho/,
    'and the history row reports the binding it just made');
});

test('MMX v9: binding from a history row keeps the user in the history list', async () => {
  const f = fixture(mmx, [run('stay-hist', 'completed')], { watched: false });
  addSession(f, 'sess-stay', '留在历史');
  await f.tick();
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  histPickOf(f).dispatch('click'); await flush();
  f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-stay"]').dispatch('click'); await flush();
  const body = f.doc.querySelector('.mmxdwf-mbody');
  assert.equal(f.doc.getElementById('mmxdwf-modal').style.display, 'flex', 'the modal stays open on the history path');
  assert.equal(body.querySelector('.mmxdwf-srow'), null, 'the picker is gone');
  assert.ok(body.querySelector('.mmxdwf-hrow'), 'the global history is rendered again rather than discarded');
  assert.match(body.textContent, /stay-hist/);
  assert.equal(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['stay-hist'].sessionId, 'sess-stay');

  // the card foot is the other entry: the conversation card is what matters there
  const g = fixture(mmx, [run('card-pick', 'running')]);
  addSession(g, 'sess-card', '卡片会话');
  await g.tick();
  g.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  g.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-card"]').dispatch('click'); await flush();
  assert.equal(g.doc.getElementById('mmxdwf-modal').style.display, 'none', 'the card-foot picker closes the modal');
  assert.ok(g.doc.querySelector('[data-run="card-pick"]'), 'and the conversation card stays on screen');
});

test('MMX v9: the card-host banner carries its own stylesheet scope', async () => {
  // The banner is a child of the card HOST, which wraps N cards and must not inherit the card
  // box — so it needs [data-mmxdwf-banner] of its own for the palette and the notice rules.
  const f = fixture(mmx, [run('banner-fin', 'completed')], { watched: false });
  await f.tick();
  const banner = f.doc.querySelector('[data-mmxdwf-banner]');
  assert.ok(banner, 'the no-card global-history notice is rendered in the host banner');
  assert.equal(banner.closest('[data-mmxdwf-card]'), null, 'the banner really is outside every [data-mmxdwf-card]');
  const css = f.doc.getElementById('mmxdwf-pipeline-style').textContent;
  assert.match(css, /\[data-mmxdwf-banner\][^{]*\{--wf-text:#d7d9de/, 'the banner must carry the dark palette variables');
  assert.match(css, /\[data-mmxdwf-theme="light"\] \[data-mmxdwf-banner\][^{]*\{--wf-text:#343944/, 'and the light palette as well');
  assert.match(css, /\[data-mmxdwf-banner\] \.mmxdwf-notice\{/, 'the notice text needs its scoped rule');
  assert.match(css, /\[data-mmxdwf-banner\] \.mmxdwf-more\{/, 'the global-history entry needs its scoped rule');
});

test('MMX v9: a persisted binding keeps the origin it recorded instead of being relabelled mmx', async () => {
  const key = 'mmxdwf-session-bindings';
  const f = fixture(mmx, [run('ours', 'running'), run('foreign', 'running'), run('legacy', 'running'), run('bogus', 'running')], {
    watched: false,
    storage: new Map([[key, JSON.stringify({
      ours: { host: 'mmx', source: 'mmx-picker', sessionId: 'sess-ours' },
      foreign: { host: 'dsh', source: 'native-shell', sessionId: 'sess-foreign' },
      legacy: { sessionId: 'sess-legacy' },
      bogus: { host: 'mmx', source: 'native-hook', sessionId: 'sess-bogus' },
    })]]),
  });
  addSession(f, 'sess-ours', '本站会话'); addSession(f, 'sess-foreign', '他站会话'); addSession(f, 'sess-legacy', '旧记录会话');
  await f.tick();
  const lineOn = (sid) => !!f.doc.querySelector('[data-session-id="' + sid + '"]').querySelector('[data-mmxdwf-line]');
  assert.ok(lineOn('sess-ours'), 'our own picker record still drives the sidebar line');
  assert.ok(lineOn('sess-legacy'), 'a pre-v8 record in our own key stays valid');
  assert.equal(lineOn('sess-foreign'), false, "another host's record must not be relabelled as an mmx binding");
  const bindingOf = f.sandbox.__mmxDwfInternals.bindingOf;
  const ours = bindingOf({ runId: 'ours' });
  assert.equal(ours.host, 'mmx');
  assert.equal(ours.sessionId, 'sess-ours');
  assert.equal(ours.source, 'mmx-picker', 'the runtime attribution object carries {host, sessionId, source}');
  assert.equal(bindingOf({ runId: 'foreign' }), null, 'a foreign-origin record yields no binding at all');
  assert.equal(bindingOf({ runId: 'bogus' }), null, 'a record that did not come from the picker is not ours either');
  assert.equal(bindingOf({ runId: 'unbound' }), null);
});

test('MMX v9: a cached script is dropped when its run leaves /runs', async () => {
  // A live run always holds a card, so the script cell is reachable on both sides of the prune.
  const f = fixture(mmx, [run('script-cache', 'running')]); await f.tick();
  f.doc.querySelector('[data-act="script"]').dispatch('click'); await flush();
  const scriptReqs = () => f.requests.filter((r) => r.url.includes('/script?')).length;
  assert.equal(scriptReqs(), 1);
  f.doc.querySelector('[data-act="mclose"]').dispatch('click');
  f.setRuns([]); await f.tick();                       // the run leaves the polled list
  f.setRuns([run('script-cache', 'running')]); await f.tick();
  f.doc.querySelector('[data-act="script"]').dispatch('click'); await flush();
  assert.equal(scriptReqs(), 2, 'per-run script text must be pruned with the rest of the per-run state');
});

test('MMX v9: closing the history modal drops its run snapshot', async () => {
  const f = fixture(mmx, [run('snap-run', 'completed')], { watched: false });
  addSession(f, 'sess-snap', '快照会话');
  await f.tick();
  f.doc.querySelector('[data-act="history"]').dispatch('click'); await flush();
  const stale = histPickOf(f);
  assert.ok(stale);
  f.doc.querySelector('[data-act="mclose"]').dispatch('click');
  f.setRuns([]); await f.tick();
  stale.dispatch('click'); await flush();               // a row from the discarded snapshot
  assert.equal(f.doc.querySelectorAll('.mmxdwf-srow').length, 0, 'a closed history modal must not keep resolving runs');
  assert.equal(f.doc.getElementById('mmxdwf-modal').style.display, 'none');
});

test('MMX v9: teardown leaves no theme marker on the host document', async () => {
  const f = fixture(mmx, [run('theme-x', 'completed')]); await f.tick();
  assert.equal(f.doc.documentElement.getAttribute('data-mmxdwf-theme'), 'light');
  f.stop();
  assert.equal(f.doc.documentElement.getAttribute('data-mmxdwf-theme'), null,
    'a stopped injection must not leave its palette attribute on <html>');
});

test('MMX v9: the internals seam exposes no session-binding mutator', async () => {
  const f = fixture(mmx, [run('seam', 'running')]);
  addSession(f, 'sess-seam', '接缝会话');
  await f.tick();
  const internals = f.sandbox.__mmxDwfInternals;
  assert.equal(internals.bindRunToSession, undefined, 'page scripts must not be able to mint a binding through our global');
  assert.equal(internals.unbindRun, undefined);
  assert.equal(typeof internals.identity, 'function');
  assert.equal(typeof internals.currentSessionId, 'function');
  assert.equal(typeof internals.bindingOf, 'function');
  // the user-driven path is untouched
  f.doc.querySelector('[data-act="bindpick"]').dispatch('click'); await flush();
  f.doc.querySelector('[data-act="bindpickrow"][data-sid="sess-seam"]').dispatch('click'); await flush();
  assert.equal(JSON.parse(f.storage.get('mmxdwf-session-bindings'))['seam'].sessionId, 'sess-seam');
  f.stop();
  assert.equal(f.sandbox.__mmxDwfInternals, undefined, 'teardown removes the seam');
});

test('MMX v9: the modal openers keep no dead view variable', () => {
  const src = readFileSync(mmx.path, 'utf8');
  assert.doesNotMatch(src, /void view/, 'openSessionPicker kept a "void view" no-op for an unused binding');
  for (const type of ['bindpick', 'agents', 'logs']) {
    assert.doesNotMatch(src, new RegExp("var view = beginView\\('" + type + "'"), type + ' records a view it never reads back');
  }
  for (const type of ['script', 'board', 'result', 'artifact', 'history']) {
    assert.match(src, new RegExp("var view = beginView\\('" + type + "'"), type + ' must keep its guard binding');
  }
});

test('MMX v9: the card host carries no unreachable picker-row handler', () => {
  const src = readFileSync(mmx.path, 'utf8');
  const start = src.indexOf('function onCardClick');
  const end = src.indexOf('// ---------- modals');
  assert.ok(start > 0 && end > start, 'the slice really covers onCardClick');
  const onCardClick = src.slice(start, end);
  assert.doesNotMatch(onCardClick, /act === 'bindpickrow'/,
    'picker rows live in the modal, so the card host never sees their clicks and must not carry a second handler');
  assert.match(src.slice(src.indexOf('function ensureModal')), /act === 'bindpickrow'/,
    'the modal listener owns the picker rows');
});
