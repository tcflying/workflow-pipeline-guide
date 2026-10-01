// test/host-lifecycle.test.mjs — REPAIR-024 contract tests, run against BOTH host halves.
// DSH mounts dsh-workflow-pipeline/index.mjs on a plain http server (cordis stub);
// MMX mounts mmx-workflow-pipeline/sidecar.mjs createHostApi directly.
// Every test builds its own temporary workspace tree and binds an ephemeral loopback port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, statSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHostApi } from '../sidecar.mjs';
import { apply } from '../../dsh-workflow-pipeline/index.mjs';

const STARTED = '2026-09-29T00:00:00Z';
const NEWSTARTED2 = '2026-09-29T18:00:00Z';
const normPath = (p) => { const r = resolve(String(p)); return (process.platform === 'win32' ? r.toLowerCase() : r).replace(/\\/g, '/'); };

for (const kind of ['DSH', 'MMX']) {
  // A run directory: <root>/.qoder/workflow-runs/<runId>/{progress,state,out,script}.json|mjs
  function makeRunTree(t, { runId = 'lifecycle', status = 'running', pid = process.pid, script = 'return 1;', relativeScript = false, cwdDir = null, setup = null, root = mkdtempSync(join(tmpdir(), 'wf-lifecycle-')) } = {}) {
    const dir = join(root, '.qoder', 'workflow-runs', runId);
    mkdirSync(dir, { recursive: true });
    const cwd = cwdDir ? join(root, cwdDir) : root;
    const progress = {
      runId, name: 'n-' + runId, status, cwd, cwdBase: cwdDir || 'proj',
      startedAt: STARTED, updatedAt: '2026-09-29T00:00:00Z',
      calls: [{ callId: 'c1', state: 'running' }], questions: [{ qId: 'q1', question: '确认', state: 'waiting' }],
      artifacts: [],
    };
    const state = { runId, status, cwd, pid, scriptPath: relativeScript ? 'script.mjs' : join(dir, 'script.mjs') };
    writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress));
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    writeFileSync(join(dir, 'script.mjs'), script);
    if (relativeScript) writeFileSync(join(root, 'script.mjs'), script); // relative scriptPath lives in the workspace
    writeFileSync(join(dir, 'out.json'), JSON.stringify({ result: 'done' }));
    if (setup) progress.artifacts = setup(root, dir) || [];
    writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress));
    t.after(async () => {
      const latest = (() => { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); } catch { return state; } })();
      if (latest.pid && latest.pid !== state.pid && latest.pid !== process.pid) {
        const deadline = Date.now() + 5000;
        for (;;) {
          let alive = false;
          try { process.kill(latest.pid, 0); alive = true; } catch {}
          if (!alive) break;
          assert.ok(Date.now() < deadline, 'the local resume fixture must exit before cleanup');
          await sleep(25);
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    return { root, dir, progress, state };
  }

  async function hostFor(t, roots) {
    let server, cap = null;
    if (kind === 'MMX') { const api = createHostApi({ roots, quiet: true }); server = api.server; cap = api.capability; }
    else { let handler; apply({ effect: (f) => f(), webServer: { register: (r) => { handler = r.handler; } } }, { roots }); server = createServer(handler); }
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const H = () => (cap ? { 'x-workflow-capability': cap } : {});
    const url = (p, params = {}) => base + p + '?' + new URLSearchParams(params);
    t.after(async () => { await new Promise((r) => server.close(r)); });
    return { base, cap, H, url, runs: async () => (await (await fetch(base + '/runs', { headers: H() })).json()).runs };
  }

  async function fixture(t, opts = {}) {
    const tree = makeRunTree(t, opts);
    const host = await hostFor(t, [tree.root]);
    return { ...tree, ...host };
  }

  test(kind + ': dead running pid is reported stale without changing journal data', async (t) => {
    const f = await fixture(t, { pid: 2147483647 });
    const b = await (await fetch(f.base + '/runs', { headers: f.H() })).json();
    assert.equal(b.runs[0].status, 'stale');
    assert.equal(b.runs[0].calls[0].state, 'stale');
    assert.equal(b.runs[0].questions[0].state, 'failed');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'progress.json'), 'utf8')).status, 'running');
  });
  test(kind + ': live pid remains running and liveness is not stuck in the progress cache', async (t) => {
    const f = await fixture(t);
    assert.equal((await (await fetch(f.base + '/runs', { headers: f.H() })).json()).runs[0].status, 'running');
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, pid: 2147483647 }));
    assert.equal((await (await fetch(f.base + '/runs', { headers: f.H() })).json()).runs[0].status, 'stale');
  });
  test(kind + ': /runs exposes a stable runKey derived from the real run directory', async (t) => {
    const f = await fixture(t);
    const first = (await f.runs())[0];
    assert.match(first.runKey, /^[0-9a-f]{64}$/, 'runKey must be sha-256 hex');
    assert.equal((await f.runs())[0].runKey, first.runKey, 'runKey is stable across scans');
  });
  test(kind + ': identical runIds in two roots are isolated by runKey; ambiguous bare ids get 409', async (t) => {
    const a = makeRunTree(t, { runId: 'same-id', script: 'MARKER_A' });
    const b = makeRunTree(t, { runId: 'same-id', script: 'MARKER_B' });
    const h = await hostFor(t, [a.root, b.root]);
    const runs = await h.runs();
    assert.equal(runs.length, 2, 'both roots are listed');
    const keyA = runs.find((r) => normPath(r.cwd) === normPath(a.root)).runKey;
    const keyB = runs.find((r) => normPath(r.cwd) === normPath(b.root)).runKey;
    assert.notEqual(keyA, keyB, 'same runId in different real directories must have different keys');
    const sa = await (await fetch(h.url('/script', { run: keyA }), { headers: h.H() })).json();
    assert.match(sa.script, /MARKER_A/);
    const sb = await (await fetch(h.url('/script', { run: keyB }), { headers: h.H() })).json();
    assert.match(sb.script, /MARKER_B/);

    const ambScript = await fetch(h.url('/script', { run: 'same-id' }), { headers: h.H() });
    assert.equal(ambScript.status, 409, 'bare ambiguous runId must be rejected');
    assert.equal((await ambScript.json()).code, 'AMBIGUOUS_RUN');
    const ambStop = await fetch(h.url('/stop', { run: 'same-id', startedAt: STARTED }), { method: 'POST', headers: h.H() });
    assert.equal(ambStop.status, 409);
    assert.equal(existsSync(join(a.dir, 'CANCEL')), false);
    assert.equal(existsSync(join(b.dir, 'CANCEL')), false);

    const stopB = await fetch(h.url('/stop', { run: keyB, startedAt: STARTED }), { method: 'POST', headers: h.H() });
    assert.equal(stopB.status, 200);
    assert.equal(existsSync(join(a.dir, 'CANCEL')), false, 'the addressed key must hit only its own root');
    assert.equal(existsSync(join(b.dir, 'CANCEL')), true);
  });
  test(kind + ': a unique bare runId still resolves for legacy clients', async (t) => {
    const f = await fixture(t);
    const r = await fetch(f.url('/script', { run: 'lifecycle' }), { headers: f.H() });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
  test(kind + ': an unknown or deleted run is 404', async (t) => {
    const f = await fixture(t);
    assert.equal((await fetch(f.url('/script', { run: 'nope' }), { headers: f.H() })).status, 404);
    assert.equal((await fetch(f.url('/script', { run: '0'.repeat(64) }), { headers: f.H() })).status, 404);
  });
  test(kind + ': stop requires startedAt (400) and rejects a stale lifecycle (409) without writing CANCEL', async (t) => {
    const f = await fixture(t);
    const noSt = await fetch(f.url('/stop', { run: 'lifecycle' }), { method: 'POST', headers: f.H() });
    assert.equal(noSt.status, 400, 'missing startedAt on stop must be 400');
    assert.equal(existsSync(join(f.dir, 'CANCEL')), false);
    const stale = await fetch(f.url('/stop', { run: 'lifecycle', startedAt: '2000-01-01T00:00:00Z' }), { method: 'POST', headers: f.H() });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'STALE_LIFECYCLE');
    assert.equal(existsSync(join(f.dir, 'CANCEL')), false);
    const ok = await fetch(f.url('/stop', { run: 'lifecycle', startedAt: STARTED }), { method: 'POST', headers: f.H() });
    assert.equal(ok.status, 200);
    assert.equal(existsSync(join(f.dir, 'CANCEL')), true);
  });
  test(kind + ': terminal runs refuse stop with 409 and no CANCEL marker', async (t) => {
    const f = await fixture(t, { runId: 'done-run', status: 'completed' });
    const term = await fetch(f.url('/stop', { run: 'done-run', startedAt: STARTED }), { method: 'POST', headers: f.H() });
    assert.equal(term.status, 409);
    assert.equal((await term.json()).ok, false);
    assert.equal(existsSync(join(f.dir, 'CANCEL')), false);
  });
  test(kind + ': read-only endpoints validate startedAt only when provided', async (t) => {
    const f = await fixture(t);
    assert.equal((await fetch(f.url('/script', { run: 'lifecycle', startedAt: '2000-01-01T00:00:00Z' }), { headers: f.H() })).status, 409);
    assert.equal((await fetch(f.url('/script', { run: 'lifecycle', startedAt: STARTED }), { headers: f.H() })).status, 200);
    assert.equal((await fetch(f.url('/script', { run: 'lifecycle' }), { headers: f.H() })).status, 200);
  });
  test(kind + ': /runs?cwd= matches the full normalized workspace exactly, never the basename', async (t) => {
    const a = makeRunTree(t, { runId: 'cwd-a', cwdDir: 'proj' });
    const b = makeRunTree(t, { runId: 'cwd-b', cwdDir: 'proj' });
    const h = await hostFor(t, [a.root, b.root]);
    const onlyB = await h.runs();
    const filtered = (await (await fetch(h.url('/runs', { cwd: join(b.root, 'proj') }), { headers: h.H() })).json()).runs;
    assert.equal(filtered.length, 1, 'same-basename workspaces must not cross-match');
    assert.equal(filtered[0].runId, 'cwd-b');
    const exactA = (await (await fetch(h.url('/runs', { cwd: join(a.root, 'proj') }), { headers: h.H() })).json()).runs;
    assert.equal(exactA.length, 1);
    assert.equal(exactA[0].runId, 'cwd-a');
  });
  test(kind + ': a corrupt progress.json is retried on every read, not cached as a permanent failure', async (t) => {
    const f = await fixture(t, { status: 'completed' });
    const pFile = join(f.dir, 'progress.json');
    const good = readFileSync(pFile);
    const mtime = statSync(pFile).mtime;
    writeFileSync(pFile, '{broken');
    utimesSync(pFile, mtime, mtime);
    assert.equal((await f.runs()).some((r) => r.runId === 'lifecycle'), false, 'broken progress is not listed');
    writeFileSync(pFile, good);
    utimesSync(pFile, mtime, mtime); // deliberately keep the same mtime as the broken write
    assert.equal((await f.runs()).some((r) => r.runId === 'lifecycle'), true, 'repair must be visible even with an unchanged mtime');
  });
  test(kind + ': a run directory moved out of the scan roots is evicted, not half-served', async (t) => {
    const f = await fixture(t, { status: 'completed' });
    await f.runs();
    renameSync(f.dir, join(f.root, 'moved-out'));
    const s = await fetch(f.url('/script', { run: 'lifecycle' }), { headers: f.H() });
    assert.equal(s.status, 404, 'stale mapping must be recycled, not 500');
    const r = await fetch(f.url('/result', { run: 'lifecycle' }), { headers: f.H() });
    assert.equal(r.status, 404);
  });
  test(kind + ': relative scriptPath resolves against the run workspace', async (t) => {
    const f = await fixture(t, { relativeScript: true, script: 'RELATIVE_SCRIPT_BODY' });
    const b = await (await fetch(f.url('/script', { run: 'lifecycle' }), { headers: f.H() })).json();
    assert.equal(b.ok, true);
    assert.match(b.script, /RELATIVE_SCRIPT_BODY/, 'must resolve relative to the run cwd, not the host process cwd');
  });
  test(kind + ': /artifact serves published file artifacts only, inside the workspace', async (t) => {
    let escFile, outDir;
    const f = await fixture(t, {
      setup(root) {
        mkdirSync(join(root, 'reports'), { recursive: true });
        mkdirSync(join(root, 'adir'), { recursive: true });
        writeFileSync(join(root, 'reports', 'rep.md'), '# hello artifact');
        writeFileSync(join(root, 'data.bin'), Buffer.from([0, 1, 2, 65]));
        escFile = join(root, '..', 'escape-' + kind + '.txt');
        writeFileSync(escFile, 'outside');
        outDir = join(root, '..', 'wf024-outside-' + kind);
        let junction = false;
        try {
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'secret.txt'), 'secret');
          symlinkSync(outDir, join(root, 'leak'), 'junction');
          junction = true;
        } catch { junction = false; }
        return [
          { kind: 'file', path: 'reports/rep.md', title: 'Report' },
          { kind: 'file', path: '../escape-missing.txt', title: 'Nope' },
          { kind: 'file', path: '../escape-' + kind + '.txt', title: 'Escape' },
          { kind: 'url', url: 'https://example.invalid/x', title: 'Web' },
          { kind: 'file', path: 'data.bin', title: 'Binary' },
          { kind: 'file', path: 'adir', title: 'Dir' },
          ...(junction ? [{ kind: 'file', path: 'leak/secret.txt', title: 'Leak' }] : []),
        ];
      },
    });
    t.after(() => { try { rmSync(escFile, { force: true }); } catch {} try { rmSync(outDir, { recursive: true, force: true }); } catch {} });
    const get = (index, extra = {}) => fetch(f.url('/artifact', { run: 'lifecycle', startedAt: STARTED, index: String(index), ...extra }), { headers: f.H() });

    const text = await get(0);
    assert.equal(text.status, 200);
    assert.ok(String(text.headers.get('content-type')).startsWith('text/plain'), 'text artifacts preview as text/plain');
    assert.equal(await text.text(), '# hello artifact');

    assert.equal((await get(1)).status, 404, 'missing artifact file is 404');
    assert.equal((await get(2)).status, 403, 'existing file outside the workspace is rejected');
    assert.equal((await get(3)).status, 404, 'url artifacts are not served as files');
    const bin = await get(4);
    assert.equal(bin.status, 200);
    assert.match(String(bin.headers.get('content-type')), /octet-stream/);
    assert.match(String(bin.headers.get('content-disposition') || ''), /attachment/);
    assert.match(String(bin.headers.get('content-disposition') || ''), /data\.bin/);
    assert.deepEqual(Buffer.from(await bin.arrayBuffer()), Buffer.from([0, 1, 2, 65]));
    assert.equal((await get(5)).status, 403, 'directories are rejected');
    const f2 = await get(0);
    assert.equal(f2.status, 200);
    assert.equal((await get(99)).status, 404, 'index out of range is 404');
    assert.equal((await get(-1)).status, 400);
    assert.equal((await get('abc')).status, 400);
    assert.equal((await get(0, { startedAt: '2000-01-01T00:00:00Z' })).status, 409, 'stale startedAt on a read is 409');
    const leak = f.progress.artifacts.findIndex((a) => a.path === 'leak/secret.txt');
    if (leak >= 0) assert.equal((await get(leak)).status, 403, 'symlink/junction escape is rejected');
    const noSt = await fetch(f.url('/artifact', { run: 'lifecycle', index: '0' }), { headers: f.H() });
    assert.equal(noSt.status, 200, 'read-only artifact access does not require startedAt');
  });
  test(kind + ': answer cannot overwrite an already submitted inbox value', async (t) => {
    const f = await fixture(t);
    const post = (answer) => fetch(f.url('/answer', { run: 'lifecycle', q: 'q1', startedAt: STARTED }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer }) });
    assert.equal((await post('first')).status, 200);
    assert.equal((await post('second')).status, 409);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'inbox', 'q1.json'), 'utf8')).text, 'first');
  });
  test(kind + ': answer without startedAt is 400', async (t) => {
    const f = await fixture(t);
    const r = await fetch(f.url('/answer', { run: 'lifecycle', q: 'q1' }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'x' }) });
    assert.equal(r.status, 400);
    assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);
  });
  test(kind + ': terminal runs cannot receive answers for an obsolete waiting question', async (t) => {
    const f = await fixture(t, { status: 'cancelled' });
    const r = await fetch(f.url('/answer', { run: 'lifecycle', q: 'q1', startedAt: STARTED }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'too late' }) });
    assert.equal(r.status, 409);
  });
  test(kind + ': a reused live PID is stale and cannot accept answers or pass the engine resume guard', async (t) => {
    const f = await fixture(t);
    // A real engine writes state and progress with the SAME lifecycle; a fabricated old state
    // alone would look like a handoff and fail closed instead of reaching the PID guard.
    const OLD = '2000-01-01T00:00:00Z';
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, startedAt: OLD }));
    writeFileSync(join(f.dir, 'progress.json'), JSON.stringify({ ...f.progress, startedAt: OLD }));
    const oldState = readFileSync(join(f.dir, 'state.json'), 'utf8');
    const b = await (await fetch(f.base + '/runs', { headers: f.H() })).json();
    assert.equal(b.runs[0].status, 'stale');
    const answer = await fetch(f.url('/answer', { run: 'lifecycle', q: 'q1', startedAt: OLD }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'too late' }) });
    assert.equal(answer.status, 409);
    assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);
    const resume = await fetch(f.url('/resume', { run: 'lifecycle', startedAt: OLD }), { method: 'POST', headers: f.H() });
    assert.equal(resume.status, 409);
    assert.equal((await resume.json()).code, 'PID_REUSED_ENGINE_GUARD');
    assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), oldState);
    process.kill(process.pid, 0);
  });
  test(kind + ': OS creation time detects a reused PID belonging to a real separate process', async (t) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    t.after(() => child.kill());
    const f = await fixture(t, { pid: child.pid });
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, startedAt: '2000-01-01T00:00:00Z' }));
    assert.equal((await (await fetch(f.base + '/runs', { headers: f.H() })).json()).runs[0].status, 'stale');
    process.kill(child.pid, 0);
  });
  test(kind + ': a process older than the run remains live', async (t) => {
    const f = await fixture(t);
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, startedAt: new Date().toISOString() }));
    assert.equal((await (await fetch(f.base + '/runs', { headers: f.H() })).json()).runs[0].status, 'running');
  });
  test(kind + ': the run list does not silently evict older runs after sixty entries', async (t) => {
    const f = await fixture(t, { status: 'completed' });
    for (let i = 0; i < 65; i++) {
      const dir = join(f.dir, '..', 'more-' + i); mkdirSync(dir);
      writeFileSync(join(dir, 'progress.json'), JSON.stringify({ ...f.progress, runId: 'more-' + i }));
    }
    const b = await (await fetch(f.base + '/runs', { headers: f.H() })).json();
    assert.equal(b.runs.length, 66);
    assert.ok(b.runs.some((r) => r.runId === 'lifecycle'));
  });
  test(kind + ': resume reports an engine rejection instead of claiming success on spawn', async (t) => {
    const f = await fixture(t, { status: 'failed' });
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, scriptPath: join(f.dir, 'missing.mjs') }));
    const r = await fetch(f.url('/resume', { run: 'lifecycle', startedAt: STARTED }), { method: 'POST', headers: f.H() });
    assert.notEqual(r.status, 200);
    const body = await r.json(); assert.equal(body.ok, false);
    assert.match(body.error, /readable|missing|script/i);
  });
  test(kind + ': resume without startedAt is 400', async (t) => {
    const f = await fixture(t, { status: 'failed' });
    const r = await fetch(f.url('/resume', { run: 'lifecycle' }), { method: 'POST', headers: f.H() });
    assert.equal(r.status, 400);
  });
  test(kind + ': resume confirms a new engine lifecycle before reporting success', async (t) => {
    const f = await fixture(t, { status: 'failed' });
    writeFileSync(join(f.dir, 'script.mjs'), "export const meta = { name: 'resume-fixture', description: 'local test' };\nreturn 1;");
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, backend: 'file' }));
    const r = await fetch(f.url('/resume', { run: 'lifecycle', startedAt: STARTED }), { method: 'POST', headers: f.H() });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(body.accepted, true);
    const next = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
    assert.notEqual(next.pid, process.pid); assert.equal(next.backend, 'file');
  });
  test(kind + ': script is available before the first runs poll', async (t) => {
    const f = await fixture(t);
    const r = await fetch(f.base + '/script?run=lifecycle', { headers: f.H() });
    assert.equal(r.status, 200); assert.equal((await r.json()).script, 'return 1;');
  });

  // REPAIR-024 follow-up: a same-directory restart keeps runId AND runKey but rotates the
  // lifecycle (fresh state/progress startedAt). Cached scan entries must never let an old
  // startedAt act on the new lifecycle.
  test(kind + ': same-directory restart invalidates the old lifecycle for mutations and validated reads', async (t) => {
    const f = await fixture(t);
    const key = (await f.runs())[0].runKey; // runKey cache hit path: no rescan happens on lookup
    // Future stamp: the fixture claims pid=process.pid, so a past startedAt would (correctly)
    // trip the PID-reuse guard once the real clock passes it and turn the run stale.
    const NEWSTARTED = new Date(Date.now() + 60000).toISOString();
    const freshProgress = { ...f.progress, status: 'running', startedAt: NEWSTARTED, calls: [{ callId: 'c1', state: 'running' }], questions: [{ qId: 'q1', question: '确认', state: 'waiting' }] };
    writeFileSync(join(f.dir, 'progress.json'), JSON.stringify(freshProgress)); // engine also wipes inbox/CANCEL on claim
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, status: 'running', startedAt: NEWSTARTED, pid: process.pid }));

    const stopStale = await fetch(f.url('/stop', { run: key, startedAt: STARTED }), { method: 'POST', headers: f.H() });
    assert.equal(stopStale.status, 409, 'old startedAt must not stop the new lifecycle');
    assert.equal((await stopStale.json()).code, 'STALE_LIFECYCLE');
    assert.equal(existsSync(join(f.dir, 'CANCEL')), false);

    const answerStale = await fetch(f.url('/answer', { run: key, q: 'q1', startedAt: STARTED }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: '旧生命周期的回答' }) });
    assert.equal(answerStale.status, 409, 'old startedAt must not answer the reused qId of the new lifecycle');
    assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);

    assert.equal((await fetch(f.url('/result', { run: key, startedAt: STARTED }), { headers: f.H() })).status, 409, 'stale startedAt on a validated read is 409');
    assert.equal((await fetch(f.url('/script', { run: key, startedAt: STARTED }), { headers: f.H() })).status, 409);

    const stopFresh = await fetch(f.url('/stop', { run: key, startedAt: NEWSTARTED }), { method: 'POST', headers: f.H() });
    assert.equal(stopFresh.status, 200, 'the fresh lifecycle accepts its own startedAt');
    assert.equal(existsSync(join(f.dir, 'CANCEL')), true);

    const f2 = await fixture(t);
    const key2 = (await f2.runs())[0].runKey;
    writeFileSync(join(f2.dir, 'progress.json'), JSON.stringify({ ...f2.progress, startedAt: NEWSTARTED }));
    const answerFresh = await fetch(f2.url('/answer', { run: key2, q: 'q1', startedAt: NEWSTARTED }), { method: 'POST', headers: { ...f2.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: '新生命周期的回答' }) });
    assert.equal(answerFresh.status, 200, 'same qId reused by the new lifecycle accepts a fresh answer');
    assert.equal(JSON.parse(readFileSync(join(f2.dir, 'inbox', 'q1.json'), 'utf8')).text, '新生命周期的回答');
  });
  test(kind + ': a run directory deleted between scan and operation is 404 everywhere, never written to', async (t) => {
    const f = await fixture(t);
    const key = (await f.runs())[0].runKey;
    rmSync(f.root, { recursive: true, force: true });
    assert.equal((await fetch(f.url('/stop', { run: key, startedAt: STARTED }), { method: 'POST', headers: f.H() })).status, 404);
    assert.equal((await fetch(f.url('/answer', { run: key, q: 'q1', startedAt: STARTED }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'x' }) })).status, 404);
    assert.equal((await fetch(f.url('/script', { run: key, startedAt: STARTED }), { headers: f.H() })).status, 404);
    assert.equal((await fetch(f.url('/result', { run: key }), { headers: f.H() })).status, 404);
    assert.equal((await fetch(f.url('/artifact', { run: key, startedAt: STARTED, index: '0' }), { headers: f.H() })).status, 404);
  });

  // R3: the window between the last lifecycle check and the disk write. effectiveProgress
  // awaits a cold CIM identity query (~0.8s measured); a same-directory restart landing inside
  // that window must fail the write closed via a final SYNCHRONOUS re-read (no further awaits).
  const LIVE_START = new Date(Date.now() + 60000).toISOString(); // future stamp: the live child is never "reused"
  async function liveWindowFixture(t) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    t.after(() => child.kill());
    const f = await fixture(t);
    writeFileSync(join(f.dir, 'progress.json'), JSON.stringify({ ...f.progress, startedAt: LIVE_START }));
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, pid: child.pid, startedAt: LIVE_START }));
    const key = (await f.runs())[0].runKey; // warms the registry (and one cold CIM query)
    await sleep(5200); // expire the run-lifecycle identity cache so the handler awaits a COLD query
    return { f, key };
  }
  const rotateLifecycle = (f, startedAt = NEWSTARTED2) => {
    writeFileSync(join(f.dir, 'progress.json'), JSON.stringify({ ...f.progress, startedAt }));
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...f.state, startedAt }));
  };
  test(kind + ': a lifecycle rotation during the stop status await is caught by the final synchronous re-read', async (t) => {
    const { f, key } = await liveWindowFixture(t);
    const rewrite = setTimeout(() => rotateLifecycle(f), 50); // lands inside the cold CIM await
    try {
      const r = await fetch(f.url('/stop', { run: key, startedAt: LIVE_START }), { method: 'POST', headers: f.H() });
      assert.equal(r.status, 409, 'the write must not land in the rotated lifecycle');
      assert.equal((await r.json()).code, 'STALE_LIFECYCLE');
    } finally { clearTimeout(rewrite); }
    assert.equal(existsSync(join(f.dir, 'CANCEL')), false);
  });
  test(kind + ': a lifecycle rotation during the answer status await is caught by the final synchronous re-read', async (t) => {
    const { f, key } = await liveWindowFixture(t);
    const rewrite = setTimeout(() => rotateLifecycle(f), 50);
    try {
      const r = await fetch(f.url('/answer', { run: key, q: 'q1', startedAt: LIVE_START }), { method: 'POST', headers: { ...f.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: '窗口期回答' }) });
      assert.equal(r.status, 409, 'the inbox write must not land in the rotated lifecycle');
    } finally { clearTimeout(rewrite); }
    assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);
  });
  test(kind + ': an answer body arriving after a rotation is rejected by the post-body re-read', async (t) => {
    const f = await fixture(t);
    const key = (await f.runs())[0].runKey;
    // Deliver the body slowly and rotate the lifecycle while the body is in flight: the
    // re-validation after the awaited body read must reject it.
    const res = await new Promise((resolve) => {
      const u = new URL(f.base + '/answer?run=lifecycle&q=q1&startedAt=' + encodeURIComponent(STARTED));
      const rq = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: kind === 'MMX' ? { 'x-workflow-capability': f.cap, 'content-type': 'application/json' } : { 'content-type': 'application/json' } }, (rs) => {
        let body = '';
        rs.on('data', (c) => { body += c; });
        rs.on('end', () => resolve({ status: rs.statusCode, body }));
      });
      rq.write('{"answer":"');
      setTimeout(() => {
        rotateLifecycle(f); // the lifecycle rotates while the body is still streaming
        rq.end('慢速回答"}');
      }, 100);
    });
    assert.equal(res.status, 409, 'a body that lands after a rotation must be rejected');
    assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);
  });
  test(kind + ': independent stable state/progress timestamps tolerate normal millisecond skew', async (t) => {
    const f2 = await fixture(t);
    const epoch = new Date(Date.now()).toISOString();
    writeFileSync(join(f2.dir, 'progress.json'), JSON.stringify({ ...f2.progress, startedAt: epoch }));
    const skewed = new Date(Date.parse(epoch) + 30).toISOString();
    writeFileSync(join(f2.dir, 'state.json'), JSON.stringify({ ...f2.state, startedAt: skewed }));
    const key2 = (await f2.runs())[0].runKey;
    const ok = await fetch(f2.url('/stop', { run: key2, startedAt: epoch }), { method: 'POST', headers: f2.H() });
    assert.equal(ok.status, 200, 'millisecond skew is not a handoff');
    assert.equal(existsSync(join(f2.dir, 'CANCEL')), true);
  });
  test(kind + ': resumeRun re-reads state/progress after its identity await and refuses a rotated lifecycle', async (t) => {
    const f = await fixture(t, { status: 'failed' });
    f.state = { ...f.state, status: 'failed', scriptPath: join(f.dir, 'missing.mjs') };
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify(f.state));
    const rl = await import(kind === 'MMX' ? '../run-lifecycle.mjs' : '../../dsh-workflow-pipeline/run-lifecycle.mjs');
    let hookCalled = false;
    const result = await rl.resumeRun(f.dir, 'lifecycle', f.state, 'ENGINE', STARTED, {
      afterIdentity: () => { hookCalled = true; rotateLifecycle(f); },
    });
    assert.equal(hookCalled, true, 'the identity await window was exercised');
    assert.equal(result.status, 409, 'the spawn basis must be re-read after the await, not the pre-await snapshot');
    assert.equal(result.body.code, 'STALE_LIFECYCLE');
  });
}
