// docs/capture.mjs — capture a CDP screenshot of the MiniMax Code renderer (for evidence).
// Usage: node docs/capture.mjs [out.png]
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.MMX_CDP_PORT || 9331);
const OUT = new URL(process.argv[2] || './evidence-d2.png', import.meta.url);

async function discoverTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
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
const t = await discoverTarget();
if (!t) { console.error('no page target'); process.exit(1); }
const c = await cdp(t.webSocketDebuggerUrl);
await c.send('Runtime.enable');
// Scroll the conversation host to the top so the injected card (first child) is visible.
await c.send('Runtime.evaluate', { expression: `(() => { const m = document.querySelector('[data-testid="message-list"]'); if (m) m.scrollTop = 0; return !!m; })()`, returnByValue: true });
await sleep(1000);
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
if (shot && shot.data) writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('wrote', OUT.pathname || OUT.href);
c.close();