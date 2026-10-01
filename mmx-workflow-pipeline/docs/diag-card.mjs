// Diagnose why sweepCard renders nothing while sweepSidebar works.
import http from 'node:http';
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9331, path: p, timeout: 8000 }, (a) => { let b = ''; a.on('data', (c) => { b += c; }); a.on('end', () => res(b)); }).on('error', rej);
});
const targets = JSON.parse(await get('/json'));
const page = targets.find((t) => t.type === 'page' && /MiniMax/i.test(t.title || '')) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 300); const v = r.result && r.result.result; return v && 'value' in v ? v.value : null; };
await send('Page.enable');
await new Promise((r) => setTimeout(r, 2000));

console.log('host?', await ev(`!!document.getElementById('mmxdwf-run-card')`));
console.log('style?', await ev(`!!document.getElementById('mmxdwf-style')`));
console.log('anchor hits', await ev(`JSON.stringify([...document.querySelectorAll('[data-testid="message-list"], [data-testid="mavis-home-content"]')].map(n=>({sel:n.getAttribute('data-testid')||n.className.slice(0,40),h:n.clientHeight})))`));
console.log('styleId actual', await ev(`(()=>{const s=document.querySelector('style[id^="mmxdwf"]');return s?s.id:'none'})()`));
// 把 tick/sweepCard 的 try/catch 拆开：手动 fetch + 调内部逻辑看异常
console.log('api fetch', await ev(`fetch('http://127.0.0.1:4231/runs').then(r=>r.json()).then(j=>j.runs.length).catch(e=>'ERR:'+e)`));
// 检查 window 上暴露的内部函数（IIFE 可能不暴露）——找 style 元素 id 规则
console.log('all mmxdwf ids', await ev(`JSON.stringify([...document.querySelectorAll('[id*="mmxdwf"]')].map(n=>n.id))`));
console.log('sidebar rows', await ev(`document.querySelectorAll('[data-mmxdwf-line]').length`));
ws.close();
