// test/sidecar.test.mjs — MMX host API contract (REPAIR-024) + CDP injector behavior.
// Run: node --test test/sidecar.test.mjs
//
// Every test is self-contained: it builds its own temporary workspace tree and starts its own
// host API on an ephemeral port (127.0.0.1:0). The fixed production port 4231 is never bound;
// EADDRINUSE discipline is verified in a subprocess against an occupied ephemeral port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createHostApi, buildInjectSource, pickPageTarget, parseArgs, API_PORT, CDP_PORT } from '../sidecar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLIENT = join(ROOT, 'client-inject.js');
const CAP = 'test-capability-0123456789abcdef';

const cleanups = [];
after(() => { for (const fn of cleanups) { try { fn(); } catch {} } });

// A fake workspace tree: <tmp>/<root>/projA/.qoder/workflow-runs/<runId>/{progress,state,out}.json
// Returns the temp root; the run id is fixed ("run-abc") for all fake trees.
function makeFakeRun({ runId = 'run-abc', artifacts = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mmxdwf-test-'));
  const runDir = join(root, 'projA', '.qoder', 'workflow-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const progress = {
    runId, name: 'test-run', cwd: join(root, 'projA').replace(/\\/g, '/'), cwdBase: 'projA',
    backend: 'file', status: 'running', currentPhase: 'D1',
    phases: [{ name: 'D1', dispatched: 2, settled: 1, failed: 0, rejected: 0 }],
    calls: [{ callId: 'c1', label: 'Agent One', phase: 'D1', state: 'running', startedAt: '2026-09-28T00:00:00Z' }],
    dispatched: 2, settled: 1, failed: 0, rejected: 0,
    tokens: { input: 10, output: 20 }, elapsedMs: 1234,
    startedAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:01:00Z',
    artifacts: artifacts || [],
  };
  const state = { runId, status: 'running', pid: process.pid, scriptPath: join(runDir, 'script.mjs') };
  writeFileSync(join(runDir, 'progress.json'), JSON.stringify(progress));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(runDir, 'script.mjs'), 'export default async function(){ return 1; }\n');
  writeFileSync(join(runDir, 'out.json'), JSON.stringify({ ok: true, result: { findings: [{ severity: 'P0', title: 't', detail: 'd' }] } }));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, runDir, runId, progress, state };
}

// Start a fresh host API over the given roots on an ephemeral loopback port.
async function startApi(roots, { capability = CAP } = {}) {
  const api = createHostApi({ roots, quiet: true, capability });
  await new Promise((res, rej) => { api.server.once('error', rej); api.server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  cleanups.push(() => api.close().catch(() => {}));
  const h = { 'x-workflow-capability': api.capability };
  const url = (p, params = {}) => base + p + '?' + new URLSearchParams(params);
  // raw request helper: full control over Host/Origin headers (fetch forbids some of them)
  const raw = ({ path = '/runs', method = 'GET', headers = {} } = {}) => new Promise((res, rej) => {
    const u = new URL(path, base);
    const rq = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (rs) => {
      let body = '';
      rs.on('data', (c) => { body += c; });
      rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body }));
    });
    rq.on('error', rej);
    rq.end();
  });
  return { api, base, h, url, raw };
}

test('/runs returns the documented shape (loopback CLI request: no Origin, capability required)', async () => {
  const fake = makeFakeRun();
  const { base, h } = await startApi([fake.root]);
  const res = await fetch(`${base}/runs`, { headers: h });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO grant without an Origin');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.runs));
  assert.equal(body.runs.length, 1);
  const r = body.runs[0];
  for (const key of ['runId', 'runKey', 'name', 'cwd', 'cwdBase', 'backend', 'status', 'currentPhase', 'phases', 'calls', 'dispatched', 'settled', 'failed', 'rejected', 'tokens', 'elapsedMs', 'updatedAt']) {
    assert.ok(key in r, `RunSummary missing field: ${key}`);
  }
  assert.match(r.runKey, /^[0-9a-f]{64}$/);
  assert.equal(r.runId, 'run-abc');
  assert.ok(Array.isArray(r.phases) && r.phases[0].name === 'D1');
  assert.ok(Array.isArray(r.calls) && r.calls[0].callId === 'c1');
});

test('/script returns state.json scriptPath and its contents', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/script', { run: 'run-abc' }), { headers: h });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.ok, true);
  assert.match(b.scriptPath, /script\.mjs$/);
  assert.match(b.script, /export default async function/);
});

test('ORDER INDEPENDENCE: a fresh server answers /script before /runs is ever called', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/script', { run: 'run-abc' }), { headers: h });
  assert.equal(res.status, 200, 'expected 200 for /script before /runs');
  assert.equal((await res.json()).ok, true);
});

test('ORDER INDEPENDENCE: /result and /stop also work before /runs', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const r = await fetch(url('/result', { run: 'run-abc' }), { headers: h });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const s = await fetch(url('/stop', { run: 'run-abc', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: h });
  assert.equal(s.status, 200);
  assert.equal(existsSync(join(fake.runDir, 'CANCEL')), true);
});

test('/script unknown run -> 404 {ok:false}', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/script', { run: 'nope' }), { headers: h });
  assert.equal(res.status, 404);
  const b = await res.json();
  assert.equal(b.ok, false);
  assert.ok(b.error);
});

test('/result returns out.json', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/result', { run: 'run-abc' }), { headers: h });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.ok, true);
  assert.equal(b.out.result.findings[0].severity, 'P0');
});

test('/result unknown run -> 404', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/result', { run: 'nope' }), { headers: h });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);
});

test('unknown path -> 404 branch', async () => {
  const fake = makeFakeRun();
  const { base, h } = await startApi([fake.root]);
  const res = await fetch(`${base}/nope`, { headers: h });
  assert.equal(res.status, 404);
  const b = await res.json();
  assert.equal(b.ok, false);
  assert.match(b.error, /not found/);
});

test('/stop writes a CANCEL file (allowed-origin preflight is 204 with no body)', async () => {
  const fake = makeFakeRun();
  const { url, raw } = await startApi([fake.root]);

  const pre = await raw({ path: url('/stop', { run: 'run-abc', startedAt: '2026-09-28T00:00:00Z' }).replace(/^[^?]*\?/, '?'), method: 'OPTIONS', headers: { origin: 'app://.', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'app://.');
  assert.match(pre.headers['access-control-allow-methods'] || '', /POST/);
  assert.equal(pre.body, '', '204 response must have an empty body');

  const cancel = join(fake.runDir, 'CANCEL');
  assert.equal(existsSync(cancel), false);
  const res = await fetch(url('/stop', { run: 'run-abc', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: { 'x-workflow-capability': CAP } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(existsSync(cancel), true);
  assert.match(readFileSync(cancel, 'utf8'), /stop requested/);
});

test('/stop unknown run -> 404 and no file written', async () => {
  const fake = makeFakeRun();
  const { url, h } = await startApi([fake.root]);
  const res = await fetch(url('/stop', { run: 'nope', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: h });
  assert.equal(res.status, 404);
});

// ---- REPAIR-024: capability / Host / Origin / CORS boundary ---------------------------------
test('requests without a valid capability are 403 for reads and writes', async () => {
  const fake = makeFakeRun();
  const { base, url, h } = await startApi([fake.root]);
  assert.equal((await fetch(`${base}/runs`)).status, 403, 'no capability header');
  assert.equal((await fetch(`${base}/runs`, { headers: { 'x-workflow-capability': 'wrong-capability-aaaaaaaaaa' } })).status, 403, 'wrong capability');
  assert.equal((await fetch(url('/script', { run: 'run-abc' }))).status, 403, 'reads are gated too');
  const stop = await fetch(url('/stop', { run: 'run-abc', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST' });
  assert.equal(stop.status, 403, 'writes are gated too');
  assert.equal(existsSync(join(fake.runDir, 'CANCEL')), false);
  assert.equal((await fetch(`${base}/runs`, { headers: h })).status, 200, 'valid capability passes');
});

test('untrusted Host header is rejected even with a valid capability', async () => {
  const fake = makeFakeRun();
  const { raw } = await startApi([fake.root]);
  const r = await raw({ path: '/runs', headers: { host: 'untrusted.invalid', 'x-workflow-capability': CAP } });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS grant for untrusted host');
  assert.equal(JSON.parse(r.body).ok, false);
});

test('unknown Origin is rejected without any CORS grant; trusted origins are echoed', async () => {
  const fake = makeFakeRun();
  const { raw } = await startApi([fake.root]);
  const evil = await raw({ path: '/runs', headers: { origin: 'https://example.invalid', 'x-workflow-capability': CAP } });
  assert.equal(evil.status, 403, 'unknown origin is denied');
  assert.equal(evil.headers['access-control-allow-origin'], undefined, 'CORS must not grant unknown origins');

  for (const origin of ['app://.', 'app://./archon', 'null']) {
    const ok = await raw({ path: '/runs', headers: { origin, 'x-workflow-capability': CAP } });
    assert.equal(ok.status, 200, `trusted origin ${origin} passes`);
    assert.equal(ok.headers['access-control-allow-origin'], origin, 'ACAO echoes the trusted origin, never *');
  }
  const noOrigin = await raw({ path: '/runs', headers: { 'x-workflow-capability': CAP } });
  assert.equal(noOrigin.status, 200, 'missing-Origin local CLI passes with capability');
});

test('OPTIONS validates origin, method and headers; it grants nothing to unknown origins', async () => {
  const fake = makeFakeRun();
  const { raw } = await startApi([fake.root]);
  const ok = await raw({ method: 'OPTIONS', headers: { origin: 'app://.', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-workflow-capability' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'app://.');

  const evil = await raw({ method: 'OPTIONS', headers: { origin: 'https://example.invalid', 'access-control-request-method': 'POST' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);

  const badMethod = await raw({ method: 'OPTIONS', headers: { origin: 'app://.', 'access-control-request-method': 'DELETE' } });
  assert.equal(badMethod.status, 403, 'non-allowlisted preflight method is denied');

  const badHeader = await raw({ method: 'OPTIONS', headers: { origin: 'app://.', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-evil' } });
  assert.equal(badHeader.status, 403, 'non-allowlisted preflight header is denied');
});

test('capability is generated randomly, returned for injection, and never logged', async () => {
  const logs = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  let api;
  try {
    api = createHostApi({ roots: [], quiet: false });
    await new Promise((res, rej) => { api.server.once('error', rej); api.server.listen(0, '127.0.0.1', res); });
    await fetch(`http://127.0.0.1:${api.server.address().port}/runs`, { headers: { 'x-workflow-capability': api.capability } });
  } finally {
    await api.close().catch(() => {});
    console.log = origLog;
    console.warn = origWarn;
  }
  assert.match(api.capability, /^[0-9a-f]{64}$/, 'default capability is random 256-bit hex');
  const all = logs.join('\n');
  assert.ok(!all.includes(api.capability), 'capability must never be logged');
  const second = createHostApi({ roots: [], quiet: true });
  cleanups.push(() => second.close().catch(() => {}));
  assert.notEqual(second.capability, api.capability, 'each start generates a fresh capability');
});

test('createHostApi accepts an explicit test capability and does not log it either', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let api;
  try { api = createHostApi({ roots: [], quiet: false, capability: 'explicit-capability-0000001' }); }
  finally { console.log = origLog; }
  assert.equal(api.capability, 'explicit-capability-0000001');
  cleanups.push(() => api.close().catch(() => {}));
  assert.ok(!logs.join('\n').includes('explicit-capability-0000001'));
});

// ---- REPAIR-024: capability placeholder injection (behavioral, vm sandbox) ------------------
test('buildInjectSource replaces only the capability placeholder and refuses unsafe values', () => {
  const src = "var CAP='__MMXDWF_CAPABILITY__';fetch(CAP);";
  assert.equal(buildInjectSource(src, 'abc123DEF456_-x9'), "var CAP='abc123DEF456_-x9';fetch(CAP);");
  assert.equal(buildInjectSource('no placeholder here', 'abc123DEF456_-x9'), 'no placeholder here');
  assert.throws(() => buildInjectSource(src, "o'; evil(); //"), 'capability charset is restricted');
  assert.throws(() => buildInjectSource(src, 'short'));
});

// Execute the real injected bundle in a sandbox DOM and observe the actual request headers.
function runClientInSandbox(source, fetchImpl) {
  const timers = { timeouts: [], intervals: [] };
  const el = () => ({
    style: {}, setAttribute() {}, appendChild() {}, remove() {}, insertBefore() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getAttribute: () => null, children: [], insertAdjacentHTML() {}, textContent: '', innerHTML: '',
  });
  const documentStub = {
    readyState: 'complete',
    head: el(), body: el(), documentElement: el(),
    getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => el(), addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    document: documentStub,
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fetchImpl,
    getComputedStyle: () => ({ backgroundColor: 'rgb(20,20,20)' }),
    matchMedia: () => ({ matches: true }),
    setInterval: (fn) => { timers.intervals.push(fn); return 1; },
    clearInterval() {},
    setTimeout: (fn) => { timers.timeouts.push(fn); return 2; },
    clearTimeout() {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'client-inject.sandbox.js' });
  return timers;
}

test('injected bundle sends X-Workflow-Capability on real polls; uninjected bundle would send the placeholder', async () => {
  const seen = [];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, runs: [] }) });
  const raw = readFileSync(CLIENT, 'utf8');
  const injected = buildInjectSource(raw, 'sandbox-capability-1234567890');
  assert.ok(!injected.includes('__MMXDWF_CAPABILITY__'), 'placeholder is fully replaced');

  const timers = runClientInSandbox(injected, (...args) => { seen.push(args); return fetchImpl(...args); });
  for (const fn of timers.timeouts) fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1, 'exactly one poll fired');
  const [url, opts] = seen[0];
  assert.ok(url.startsWith('http://127.0.0.1:4231/runs'));
  assert.equal(opts.headers['X-Workflow-Capability'], 'sandbox-capability-1234567890', 'closure capability reaches the wire');
  assert.equal(Object.keys(opts.headers).some((k) => /cap/i.test(k) && !/workflow/i.test(k)), false);
});

test('client-inject.js passes node --check and carries exactly one capability placeholder', () => {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
  const src = readFileSync(CLIENT, 'utf8');
  assert.equal(src.split('__MMXDWF_CAPABILITY__').length - 1, 1, 'exactly one placeholder occurrence');
  assert.match(src, /X-Workflow-Capability/);
});

test('client-inject.js carries the idempotency marker and mmxdwf- prefix', () => {
  const src = readFileSync(CLIENT, 'utf8');
  assert.match(src, /window\.__mmxDwfInstalled/);
  assert.match(src, /window\.__mmxDwfVersion >= CLIENT_VERSION\) return;/);
  assert.match(src, /mmxdwf-dismissed/);
  assert.match(src, /http:\/\/127\.0\.0\.1:4231/);
  // D1 selectors + home-screen fallback
  assert.match(src, /\[data-session-id\]/);
  assert.match(src, /\[data-testid="message-list"\]/);
  assert.match(src, /mavis-home-content/);
  assert.match(src, /data-shortcut-session-active="true"/);
  assert.match(src, /data-shortcut-session-target/);
  // No leftover DSH-only markers
  assert.doesNotMatch(src, /__ModuleLoader__/);
  assert.doesNotMatch(src, /dsh-workflow-pipeline/);
});

test('pickPageTarget only injects the real renderer: exact app://./archon URL and a loopback ws on the CURRENT CDP port', () => {
  const archon = 'app://./archon';
  const good = (over = {}) => ({ type: 'page', title: over.title || 'MiniMax Code', url: over.url || archon, webSocketDebuggerUrl: over.ws || 'ws://127.0.0.1:9331/devtools/page/1' });

  assert.equal(pickPageTarget([good()], { port: 9331 })?.webSocketDebuggerUrl, 'ws://127.0.0.1:9331/devtools/page/1', 'the real production target is accepted');
  assert.equal(pickPageTarget([good({ url: archon + '?x=1#frag' })], { port: 9331 })?.url, archon + '?x=1#frag', 'hash/search variants are the same page');
  assert.equal(pickPageTarget([good({ ws: 'ws://localhost:9331/devtools/page/1' })], { port: 9331 })?.url, archon, 'loopback by name is accepted');
  assert.equal(pickPageTarget([good({ ws: `ws://127.0.0.1:${CDP_PORT + 1}/devtools/page/1` })], { port: CDP_PORT + 1 })?.url, archon, 'an explicit test CDP port works');

  // evil titles / lookalike URLs must never receive the capability bundle
  assert.equal(pickPageTarget([good({ title: 'EVIL MiniMax', url: 'https://127.0.0.1.example.invalid/archon', ws: 'ws://127.0.0.1:9331/devtools/page/2' })], { port: 9331 }), null, 'title match alone is not enough');
  assert.equal(pickPageTarget([good({ url: 'http://localhost:9331/archon', ws: 'ws://127.0.0.1:9331/devtools/page/3' })], { port: 9331 }), null, 'a localhost http page is not the renderer');
  assert.equal(pickPageTarget([good({ url: 'app://./archon-evil' })], { port: 9331 }), null, 'path must be exactly /archon');
  assert.equal(pickPageTarget([good({ url: 'app://evil/archon' })], { port: 9331 }), null, 'host must be exactly "."');
  // debugging socket boundaries
  assert.equal(pickPageTarget([good({ ws: 'ws://127.0.0.1:9999/devtools/page/4' })], { port: 9331 }), null, 'wrong CDP port is rejected');
  assert.equal(pickPageTarget([good({ ws: 'ws://203.0.113.5:9331/devtools/page/5' })], { port: 9331 }), null, 'non-loopback ws host is rejected');
  assert.equal(pickPageTarget([good({ ws: 'wss://127.0.0.1:9331/devtools/page/6' })], { port: 9331 }), null, 'only ws: sockets are accepted');
  // helper page and non-page targets stay excluded; never a pages[0] fallback
  const helper = [{ type: 'page', title: 'MiniMax Code', url: 'file:///x/electron.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/7' }];
  assert.equal(pickPageTarget(helper), null, 'helper page alone must NOT be injected');
  assert.equal(pickPageTarget([]), null);
  const list = [
    { type: 'service_worker', title: 'sw', url: archon, webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/sw' },
    { type: 'iframe', title: 'MiniMax', url: archon, webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/iframe' },
  ];
  assert.equal(pickPageTarget(list), null, 'no page target -> null');
});

// Behavioral injector test with a fake CDP transport: verifies capability injection, marker
// reset before re-init, and removal of the previous document-script identifier on re-attach.
test('injector injects the capability bundle and cleans the old document-script identifier on re-attach', async () => {
  const targetA = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'A', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/A' };
  const targetB = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'B', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/B' };
  let list = [targetA];
  const fakeClient = () => {
    const calls = [];
    return {
      calls,
      send: async (method, params) => {
        calls.push([method, params]);
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-' + calls.length };
        if (method === 'Runtime.evaluate') return { result: { value: true } };
        return {};
      },
      close: () => calls.push(['__close']),
    };
  };
  const clients = { A: fakeClient(), B: fakeClient() };
  const waitForTarget = async (inj, id) => {
    const deadline = Date.now() + 2000;
    while (inj.target !== id) {
      assert.ok(Date.now() < deadline, `injector never attached to ${id}`);
      await new Promise((r) => setTimeout(r, 10));
      await inj.attempt();
    }
  };
  const { startCdpInjector } = await import('../sidecar.mjs');
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'inject-capability-123456789', quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => list,
    connect: (wsUrl) => Promise.resolve(wsUrl.endsWith('/page/A') ? clients.A : clients.B),
  });
  try {
    await waitForTarget(inj, 'A');
    const aCalls = clients.A.calls;
    const adds = aCalls.filter(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument');
    assert.equal(adds.length, 1, 'one document script registered');
    const injected = adds[0][1].source;
    assert.ok(!injected.includes('__MMXDWF_CAPABILITY__'), 'placeholder replaced in the registered source');
    assert.ok(injected.includes('inject-capability-123456789'), 'real capability present in the closure bundle');
    const evals = aCalls.filter(([m]) => m === 'Runtime.evaluate').map(([, p]) => p.expression);
    assert.ok(evals.some((e) => e.includes('__mmxDwfTeardown') && e.includes('__mmxDwfInstalled = false')), 'marker reset runs before re-init so capability updates re-initialise');
    assert.ok(evals.some((e) => e === injected), 'the injected source itself is evaluated');
    assert.equal(aCalls.filter(([m]) => m === 'Page.removeScriptToEvaluateOnNewDocument').length, 0, 'fresh session has nothing to remove');

    list = [targetB];
    await waitForTarget(inj, 'B');
    assert.ok(clients.A.calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p && p.identifier), 'old document-script identifier is removed');
    assert.ok(clients.A.calls.some(([m]) => m === '__close'), 'old socket is closed');
    const addsB = clients.B.calls.filter(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument');
    assert.equal(addsB.length, 1, 'new target gets the capability bundle too');
    assert.ok(addsB[0][1].source.includes('inject-capability-123456789'));
  } finally {
    inj.stop();
  }
});

// REPAIR-024 follow-up (security review): an attach that fails midway must not leak the
// socket or the registered document-script identifier, and a stop() during an in-flight
// attach must not leave a late-assigned current handle behind.
const waitFor = async (predicate, what) => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
test('attach half-failure after addScript cleans up socket and document-script identifier', async () => {
  const target = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'X', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/X' };
  const calls = [];
  const flaky = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-leak-1' };
      if (method === 'Runtime.enable') return {};
      if (method === 'Runtime.evaluate' && params.expression === 'window.__mmxDwfInstalled === true') throw new Error('Evaluation failed: page navigated');
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const { startCdpInjector } = await import('../sidecar.mjs');
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'cleanup-capability-1234567', quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [target],
    connect: async () => flaky,
  });
  try {
    await inj.attempt(); // must not throw; must schedule a retry after cleaning up
    await waitFor(() => calls.some(([m]) => m === '__close'), 'half-failure cleanup');
    assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p && p.identifier === 'doc-leak-1'), 'the registered identifier is removed on half-failure');
    assert.ok(calls.some(([m]) => m === '__close'), 'the half-attached socket is closed');
    assert.equal(inj.target, null, 'no current handle is left behind');
  } finally {
    inj.stop();
  }
});

test('stop() during an in-flight attach prevents a late current assignment and cleans the handle', async () => {
  const target = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'Y', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/Y' };
  const calls = [];
  let releasePageEnable;
  const slow = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.enable') await new Promise((r) => { releasePageEnable = r; }); // attach is parked here
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-late-1' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const { startCdpInjector } = await import('../sidecar.mjs');
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'latestop-capability-123456', quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [target],
    connect: async () => slow,
  });
  const attachPromise = inj.attempt();
  await new Promise((r) => setTimeout(r, 20)); // let attach park inside Page.enable
  const stopPromise = inj.stop();
  releasePageEnable();
  await attachPromise.catch(() => {});
  await stopPromise;
  await waitFor(() => calls.some(([m]) => m === '__close'), 'late-stop cleanup');
  assert.equal(slow.calls.some(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument'), false, 'a stopped attach must not register a new document script');
  assert.ok(slow.calls.some(([m]) => m === '__close'), 'the socket of a stopped attach is closed');
  assert.equal(inj.target, null, 'no late current assignment after stop');
});

test('stop() returns a Promise, waits for the in-flight attach, tears a live UI down before closing and is idempotent', async () => {
  const target = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'T', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/T' };
  const calls = [];
  let releaseMarker;
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-stop-1' };
      if (method === 'Runtime.evaluate' && params.expression === 'window.__mmxDwfInstalled === true') {
        await new Promise((r) => { releaseMarker = r; }); // attach parks at the marker check, bundle already live
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const { startCdpInjector } = await import('../sidecar.mjs');
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'stoppromise-capability-123', quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [target],
    connect: async () => client,
  });
  await waitFor(() => typeof releaseMarker === 'function', 'attach parked after bundle installation');
  const firstStop = inj.stop();
  const isPromise = firstStop && typeof firstStop.then === 'function';
  const secondStop = inj.stop();
  releaseMarker();
  await firstStop;
  await waitFor(() => calls.some(([m]) => m === '__close'), 'stop-time cleanup');
  assert.ok(isPromise, 'stop() must return a Promise');
  assert.equal(secondStop, firstStop, 'repeated stop() is idempotent');
  const markerIndex = calls.findIndex(([m, p]) => m === 'Runtime.evaluate' && p.expression === 'window.__mmxDwfInstalled === true');
  const teardownIndex = calls.findIndex(([m, p], i) => i > markerIndex && m === 'Runtime.evaluate' && /__mmxDwfTeardown/.test(p.expression));
  assert.ok(teardownIndex > markerIndex, 'cleanup must tear down a possibly installed renderer UI');
  assert.ok(teardownIndex < calls.findIndex(([m]) => m === '__close'), 'renderer cleanup precedes socket close');
  assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p && p.identifier === 'doc-stop-1'), 'the registered identifier is removed');
  assert.equal(inj.target, null, 'no handle survives stop');
  await inj.stop(); // idempotent await
});

test('stop() before the bundle is sent never registers or evaluates the client', async () => {
  const target = { type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'U', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/U' };
  const calls = [];
  let releaseEnable;
  const client = {
    calls,
    send: async (method) => {
      calls.push([method]);
      if (method === 'Page.enable') await new Promise((r) => { releaseEnable = r; }); // parked before any registration
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const { startCdpInjector } = await import('../sidecar.mjs');
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'earlystop-capability-123456', quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [target],
    connect: async () => client,
  });
  await new Promise((r) => setTimeout(r, 20));
  const sp = inj.stop();
  releaseEnable();
  await sp;
  await waitFor(() => calls.some(([m]) => m === '__close'), 'early-stop cleanup');
  assert.equal(calls.some(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument'), false, 'no document script is registered after stop');
  assert.equal(calls.some(([m, p]) => m === 'Runtime.evaluate' && /mmxDwf/.test(p.expression)), false, 'no bundle or marker evaluation after stop');
  assert.equal(inj.target, null);
});

for (const stage of ['discovery', 'connect', 'command', 'cleanup']) {
  test('injector stop remains bounded when ' + stage + ' never settles', async () => {
    const target = { type: 'page', url: 'app://./archon', id: 'bounded', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/page/bounded' };
    const never = () => new Promise(() => {});
    let reached = false, closed = false;
    const client = {
      send: async (method) => {
        if (stage === 'command' && method === 'Page.enable') { reached = true; return never(); }
        if (stage === 'cleanup' && method === 'Page.removeScriptToEvaluateOnNewDocument') return never();
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'bounded-doc' };
        if (method === 'Runtime.evaluate') return { result: { value: true } };
        return {};
      }, close: () => { closed = true; },
    };
    const { startCdpInjector } = await import('../sidecar.mjs');
    const inj = startCdpInjector({ scriptPath: CLIENT, quiet: true, commandTimeoutMs: 40, pollMs: 3.6e6, retryMs: 3.6e6,
      listTargets: () => { if (stage === 'discovery') { reached = true; return never(); } return Promise.resolve([target]); },
      connect: () => { if (stage === 'connect') { reached = true; return never(); } return Promise.resolve(client); },
    });
    await waitFor(() => stage === 'cleanup' ? inj.target === 'bounded' : reached, 'bounded ' + stage);
    const start = Date.now();
    const outcome = await inj.stop();
    assert.ok(Date.now() - start < 1000);
    assert.equal(inj.target, null);
    if (stage === 'command' || stage === 'cleanup') assert.equal(closed, true);
    if (stage === 'cleanup') { assert.equal(outcome.cleaned, false); assert.ok(outcome.errors.length > 0); }
  });
}

test('target whitelist accepts only bracketed loopback IPv6 on the fixed debug port', () => {
  const target = { type: 'page', url: 'app://./archon', webSocketDebuggerUrl: 'ws://[::1]:9331/devtools/page/v6' };
  assert.equal(pickPageTarget([target]), target);
  assert.equal(pickPageTarget([{ ...target, webSocketDebuggerUrl: 'ws://[::2]:9331/devtools/page/v6' }]), null);
});

test('parseArgs collects repeated --root and flags (including --api-port)', () => {
  const a = parseArgs(['--launch', '--root', 'A', '--root=B', '--kill-on-exit', '--api-port', '4999']);
  assert.equal(a.launch, true);
  assert.equal(a.killOnExit, true);
  assert.deepEqual(a.roots, ['A', 'B']);
  assert.equal(a.apiPort, 4999);
  assert.equal(parseArgs([]).apiPort, API_PORT);
});

test('EADDRINUSE exits 1 with a clear message (verified in a subprocess on an occupied ephemeral port; 4231 is never touched)', async () => {
  const blocker = createServer((req, res) => res.end('busy'));
  await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(0, '127.0.0.1', res); });
  const port = blocker.address().port;
  try {
    const out = await new Promise((res) => {
      const child = spawn(process.execPath, [join(ROOT, 'sidecar.mjs'), '--api-port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '', stdout = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdout.on('data', (d) => { stdout += d; });
      const kill = setTimeout(() => child.kill(), 15000);
      child.on('close', (code) => { clearTimeout(kill); res({ code, stderr, stdout }); });
    });
    assert.equal(out.code, 1, `expected exit 1, got ${out.code}; stderr=${out.stderr}`);
    assert.match(out.stderr, /FATAL/);
    assert.match(out.stderr, /already in use/i);
    assert.match(out.stderr, new RegExp(`port ${port}\\b`));
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// ---- v2 (SPEC §2.2): POST /resume + POST /answer contracts ----
test('v2 /resume rejects invalid scripts and live running ones without false success', async () => {
  const fake = makeFakeRun({ runId: 'res-failed' });
  const stPath = join(fake.runDir, 'state.json');
  const st = JSON.parse(readFileSync(stPath, 'utf8'));
  st.status = 'failed';
  writeFileSync(stPath, JSON.stringify(st));
  const { url, h } = await startApi([fake.root]);
  const ok = await (await fetch(url('/resume', { run: 'res-failed', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: h })).json();
  assert.equal(ok.ok, false);
  assert.equal(ok.code, 'ENGINE_REJECTED');
  const missing = await (await fetch(url('/resume', { run: 'nope', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: h })).json();
  assert.equal(missing.ok, false);

  const fake2 = makeFakeRun({ runId: 'res-live' });
  const sp2 = join(fake2.runDir, 'state.json');
  const st2 = JSON.parse(readFileSync(sp2, 'utf8'));
  st2.status = 'running';
  st2.pid = process.pid; // alive
  writeFileSync(sp2, JSON.stringify(st2));
  const { url: url2, h: h2 } = await startApi([fake2.root]);
  const rej = await (await fetch(url2('/resume', { run: 'res-live', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: h2 })).json();
  assert.equal(rej.ok, false);
  assert.match(String(rej.error || ''), /still alive|running/);
});

test('v2 /answer writes the inbox answer for a waiting question and rejects other states', async () => {
  const fake = makeFakeRun({ runId: 'q-run' });
  const pPath = join(fake.runDir, 'progress.json');
  const prog = JSON.parse(readFileSync(pPath, 'utf8'));
  prog.questions = [
    { qId: 'q000-abc12345', question: '请确认发布', state: 'waiting', askedAt: '2026-09-28T00:00:00Z', answeredAt: null, answerPreview: null },
    { qId: 'q000-done9999', question: '已问过', state: 'answered', askedAt: '2026-09-28T00:00:00Z', answeredAt: '2026-09-28T00:01:00Z', answerPreview: '好' },
  ];
  writeFileSync(pPath, JSON.stringify(prog));
  const { url, h } = await startApi([fake.root]);
  const post = (q, body) => fetch(url('/answer', { run: 'q-run', q, startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ answer: body }) });
  const r = await (await post('q000-abc12345', '确认，发布吧')).json();
  assert.equal(r.ok, true);
  const wrote = JSON.parse(readFileSync(join(fake.runDir, 'inbox', 'q000-abc12345.json'), 'utf8'));
  assert.deepEqual(wrote, { ok: true, text: '确认，发布吧' });
  assert.equal((await post('q000-done9999', 'x')).ok, false);
  assert.equal((await post('q000-zzz', 'x')).ok, false);
  const bad = await fetch(url('/answer', { run: 'q-run', q: 'q000-abc12345', startedAt: '2026-09-28T00:00:00Z' }), { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: 'not json' });
  assert.equal((await bad.json()).ok, false);
});

test('v2 /answer without startedAt is 400 and writes nothing', async () => {
  const fake = makeFakeRun({ runId: 'q-nost' });
  const { url, h } = await startApi([fake.root]);
  const r = await fetch(url('/answer', { run: 'q-nost', q: 'q1' }), { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'x' }) });
  assert.equal(r.status, 400);
  assert.equal(existsSync(join(fake.runDir, 'inbox')), false);
});

test('v2 client-inject bundle carries the v2 markers (four pills, ask input, resume, shake)', () => {
  const src = readFileSync(CLIENT, 'utf8');
  for (const m of ['data-act="script"', 'data-act="board"', 'data-act="result"', 'data-act="history"',
    'mmxdwf-qin', 'data-act="answer"', 'data-act="resume"', 'mmxdwf-shake', 'mmxdwf-arts', 'mmxdwf-logs']) {
    assert.ok(src.includes(m), 'client-inject.js missing marker: ' + m);
  }
});
