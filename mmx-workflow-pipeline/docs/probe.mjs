// docs/probe.mjs — canonical, reusable DOM probe for MiniMax Code (DEVELOPMENT.md §4 D1, §7 C8).
//
// MiniMax Code's renderer is a Tailwind app whose structure is carried by data-testid /
// data-* attributes, NOT by hashed class names (the class tokens are Tailwind utilities).
// This probe therefore keys off attributes. After a MiniMax Code upgrade re-run:
//
//   node docs/launch-cdp.mjs   # restart MiniMax Code with --remote-debugging-port=9331
//   node docs/probe.mjs        # -> docs/probe-raw.json  (+ human summary on stdout)
//
// If a session is open the conversation area is probed too; otherwise the probe clicks the
// first session row to open one. Nothing is mutated in MiniMax Code; the click is the same
// as a user click and only selects an existing session.
//
// No third-party deps: global fetch + global WebSocket (Node >= 22).
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.MMX_CDP_PORT || 9331);
const OUT = new URL('./probe-raw.json', import.meta.url);

const PROBE = `(() => {
  const out = { url: location.href, title: document.title, at: new Date().toISOString() };
  const trunc = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, n || 700);
  const cls = (el) => (el && el.getAttribute && el.getAttribute('class')) || '';
  const attr = (el, a) => (el && el.getAttribute ? el.getAttribute(a) : null);
  const chain = (el) => { const a = []; let n = el; for (let i = 0; n && i < 8; i++, n = n.parentElement) { const t = attr(n, 'data-testid'); if (t) a.push(t); } return a; };

  // --- localStorage availability ---
  try {
    const k = '__mmx_probe__';
    localStorage.setItem(k, '1');
    out.localStorage = { ok: localStorage.getItem(k) === '1', length: localStorage.length };
    localStorage.removeItem(k);
  } catch (e) { out.localStorage = { ok: false, error: String(e) }; }

  // --- 1) sidebar session rows: [data-session-id] (DSH equivalent of [class*=sessionRow]) ---
  const rows = [...document.querySelectorAll('[data-session-id]')];
  out.sessionRow = {
    selector: '[data-session-id]',
    count: rows.length,
    attrs: [...new Set(rows.flatMap((r) => (r.getAttributeNames ? r.getAttributeNames() : [])))].filter((a) => a.startsWith('data-')),
    titleSelector: 'span.w-0.flex-1.text-sm.truncate',
    samples: rows.slice(0, 4).map((el) => ({
      sessionId: attr(el, 'data-session-id'),
      active: attr(el, 'data-shortcut-session-active'),
      text: trunc(el.textContent, 120),
      outerHTML: trunc(el.outerHTML, 900),
    })),
  };

  // --- 2) group / workspace rows (DSH equivalent of [class*=projectRow]) ---
  const group = rows.length ? rows[rows.length - 1].closest('[data-testid="sidebar-session-group"]') : null;
  out.groupRow = {
    selector: '[data-testid="sidebar-session-group"]',
    headerSelector: '[data-project-header]',
    attr: 'data-workspace-dir',
    workspaceDir: group ? attr(group, 'data-workspace-dir') : null,
    projectKey: group ? attr(group, 'data-project-key') : null,
    titleText: group ? trunc((group.querySelector('[data-testid="sidebar-session-group-title"]') || {}).textContent, 80) : null,
    outerHTML: trunc(group && group.outerHTML, 900),
  };
  // how many rows actually sit inside a group (pinned rows have none)
  out.rowsWithGroup = rows.filter((r) => r.closest('[data-testid="sidebar-session-group"]')).length;

  // --- 3) conversation scroll host: [data-testid="message-list"] ---
  const ml = document.querySelector('[data-testid="message-list"]');
  out.messageList = ml ? {
    selector: '[data-testid="message-list"]',
    cls: cls(ml),
    clientH: ml.clientHeight, clientW: ml.clientWidth, scrollH: ml.scrollHeight,
    tidChain: chain(ml),
    outerHTML: trunc(ml.outerHTML, 500),
  } : null;
  out.homeContent = document.querySelector('[data-testid="mavis-home-content"]') ? 'present' : 'absent';
  out.scrollers = [...document.querySelectorAll('*')].filter((el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 150;
  }).sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth)).slice(0, 10)
    .map((el) => ({ tid: attr(el, 'data-testid'), chain: chain(el), w: el.clientWidth, h: el.clientHeight, sh: el.scrollHeight }));

  return out;
})()`;

async function discoverTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page'); // §7 C7: pages only
  return pages.find((t) => /minimax/i.test(t.title || '')) || pages.find((t) => /archon/.test(t.url || '')) || pages[0];
}
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', (e) => reject(new Error('ws ' + (e.message || e.type))));
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const api = { send, close: () => ws.close() };
  });
}

const target = await discoverTarget();
if (!target) { console.error('[probe] no page target; run docs/launch-cdp.mjs first'); process.exit(1); }
const c = await cdp(target.webSocketDebuggerUrl);
await c.send('Runtime.enable');

// If the home screen is showing, open the first existing session so the conversation area exists.
const pre = await c.send('Runtime.evaluate', { expression: `!!document.querySelector('[data-testid="message-list"]')`, returnByValue: true });
if (!pre.result.value) {
  const click = await c.send('Runtime.evaluate', {
    expression: `(() => { const r = document.querySelector('[data-session-id]'); if (!r) return false; (r.querySelector('button') || r).click(); return true; })()`,
    returnByValue: true,
  });
  if (click.result.value) { console.log('[probe] opened first session to expose the conversation area'); await sleep(4000); }
}

const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
c.close();
if (r.exceptionDetails) { console.error('[probe] eval exception:', JSON.stringify(r.exceptionDetails).slice(0, 1000)); process.exit(1); }
const v = r.result.value;
writeFileSync(OUT, JSON.stringify(v, null, 2), 'utf8');
console.log(JSON.stringify({
  url: v.url, localStorage: v.localStorage,
  sessionRow: { selector: v.sessionRow.selector, count: v.sessionRow.count, titleSelector: v.sessionRow.titleSelector, attrs: v.sessionRow.attrs },
  groupRow: { selector: v.groupRow.selector, attr: v.groupRow.attr, workspaceDir: v.groupRow.workspaceDir, titleText: v.groupRow.titleText },
  rowsWithGroup: v.rowsWithGroup,
  messageList: v.messageList && { selector: v.messageList.selector, h: v.messageList.clientH, sh: v.messageList.scrollH },
  scrollers: v.scrollers,
}, null, 2));
console.log('[probe] wrote', OUT.pathname || OUT.href);