// D6 终审取证：对 MiniMax Code 原生 UI 做四态证据（运行中卡/完成卡/发现看板/侧栏行）。
// 前提：MiniMax Code 带 CDP 9331 运行、sidecar 4231 已注入（__mmxDwfInstalled）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const WS = 'G:/qoder-intl-project/else';
const WF = WS + '/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';
const DRAFT = WS + '/.qoder/workflow-drafts/final-review932.js'; // 与 DSH 同款 4审查员+裁判
const RUN = WS + '/.qoder/workflow-runs/mmx941';
const RUN_ID = 'mmx941';
const OUT = WS + '/mmx-workflow-pipeline/docs/evidence-d6';

const get = (p, port) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (a) => { let b = ''; a.on('data', (c) => { b += c; }); a.on('end', () => res(b)); }).on('error', rej);
});
const jget = async (p, port) => JSON.parse(await get(p, port));

// 1) API 实证（sidecar 4231）
const runsApi = await jget('/runs', 4231);
console.log('API /runs ->', runsApi.ok, 'count=' + (runsApi.runs || []).length, 'CORS-side sample:', JSON.stringify((runsApi.runs || [])[0] || {}).slice(0, 120));

// 2) CDP 连 MiniMax Code
const targets = await jget('/json', 9331);
const page = targets.find((t) => t.type === 'page' && /MiniMax/i.test(t.title || '')) || targets.find((t) => t.type === 'page');
if (!page) { console.log('NO-PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); const v = r.result && r.result.result; return v && 'value' in v ? v.value : null; };
await send('Page.enable');
await send('Page.bringToFront');

console.log('INJECTED', await ev('window.__mmxDwfInstalled'));

// 3) 起真实 run（file 后端，3600s 超时停在运行中）
const c = spawn('node', [WF, 'run', DRAFT, '--backend', 'file', '--run-id', RUN_ID, '--yes', '--quiet'], { cwd: WS, detached: true, stdio: 'ignore' });
c.unref();
await new Promise((r) => setTimeout(r, 6000));

// 4) 运行中态断言+截图
await new Promise((r) => setTimeout(r, 9000)); // 等 client 轮询
const PROBE = '(() => { const card=document.getElementById("mmxdwf-run-card"); const cards=card?[...card.querySelectorAll("[data-dwf-card]")]:[]; return JSON.stringify({installed:window.__mmxDwfInstalled,cards:cards.map(x=>({run:x.getAttribute("data-run"),title:(x.querySelector(".dwf-title")||{}).textContent,stats:(x.querySelector(".dwf-stats")||{}).textContent,pills:[...x.querySelectorAll(".dwf-pill")].map(p=>String(p.textContent).trim()),stop:!!x.querySelector("[data-act=stop]")})),sidebar:[...document.querySelectorAll("[data-mmxdwf-line]")].map(l=>String(l.textContent).trim())}); })()';
let p1 = null;
for (let i = 0; i < 6; i++) { p1 = JSON.parse(await ev(PROBE) || '{}'); if ((p1.cards || []).some(x => x.run === RUN_ID)) break; await new Promise((r) => setTimeout(r, 4000)); }
console.log('RUNNING', JSON.stringify(p1).slice(0, 600));
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '-running.png', Buffer.from(shot.result.data, 'base64'));

// 5) 驱动完成 + 完成态/看板/×截图
const A = (text, i, o) => ({ ok: true, text, usage: { input: i, output: o } });
const answers = [
  [/四个文件/i, () => A('audit-targets/ 四个文件：plugin.json（287B 清单）；README.md（5948B）；SKILL.md（14283B）；file-audit.js（1161B）。', 1200, 260)],
  [/终审角度/i, () => A('打包、文档、示例、安全四个角度。', 950, 210)],
  [/plugin\.json|审查-打包/i, () => A('打包：清单 0.6.0 vs 引擎 0.7.1 版本漂移 P2；其余字段完好。', 1800, 420)],
  [/README|审查-文档/i, () => A('文档：标题与描述一致；示例文件缺失 P3。', 2300, 510)],
  [/file-audit|审查-示例/i, () => A('示例：meta.args 匹配、phase 用法合规。', 1500, 330)],
  [/最小权限|审查-安全/i, () => A('安全：无网络无进程访问，无 P0/P1。', 1100, 280)],
];
const judge = [
  { severity: 'P2', title: '清单版本漂移', detail: 'plugin.json 0.6.0 vs 引擎 0.7.1。' },
  { severity: 'P3', title: '示例文件缺失', detail: 'README 引用 a.js/b.js 不存在。' },
];
for (let i = 0; i < 100; i++) {
  if (fs.existsSync(RUN + '/out.json')) break;
  let pend2 = null;
  try { pend2 = JSON.parse(fs.readFileSync(RUN + '/pending.json', 'utf8')); } catch (e) {}
  if (pend2 && pend2.items) for (const it of pend2.items) {
    const f = RUN + '/inbox/' + it.callId + '.json';
    if (fs.existsSync(f)) continue;
    const isJudge = /汇总裁判|P0-P3/.test(String(it.prompt));
    const ans = isJudge ? A(JSON.stringify(judge), 9500, 2150) : answers.find(([re]) => re.test(String(it.prompt)))?.[1]?.();
    if (ans) { fs.writeFileSync(f, JSON.stringify(ans)); console.log('ANSWERED', it.callId); }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('out.json', fs.existsSync(RUN + '/out.json'));
await new Promise((r) => setTimeout(r, 8000)); // 完成态刷新

let p2 = null;
for (let i = 0; i < 6; i++) { p2 = JSON.parse(await ev(PROBE) || '{}'); if ((p2.cards || []).some(x => /已完成/.test(x.title || ''))) break; await new Promise((r) => setTimeout(r, 4000)); }
console.log('COMPLETED', JSON.stringify(p2).slice(0, 600));
shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '-completed.png', Buffer.from(shot.result.data, 'base64'));

// 6) 发现看板模态框
console.log('BOARD-CLICK', await ev('(() => { const b=document.querySelector("#mmxdwf-run-card .dwf-pill[data-act=board]"); if(b){b.click();return "clicked";} return "no-pill"; })()'));
await new Promise((r) => setTimeout(r, 2500));
console.log('BOARD', await ev('(() => { const m=document.getElementById("mmxdwf-modal"); return m&&m.style.display!=="none"?JSON.stringify({groups:[...m.querySelectorAll(".dwf-sev")].map(s=>String(s.textContent).trim())}):"hidden"; })()'));
shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '-board.png', Buffer.from(shot.result.data, 'base64'));

// 7) reload 重注验证
await send('Page.reload');
await new Promise((r) => setTimeout(r, 9000));
console.log('RELOAD-REINJECT', await ev(PROBE));
ws.close();
console.log('D6-EVIDENCE-DONE');
