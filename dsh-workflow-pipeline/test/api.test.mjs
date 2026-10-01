// test/api.test.mjs — DSH host v2 contract tests (SPEC §2.2).
// index.mjs is a cordis plugin (apply(ctx, config) registering a prefix route). We stub the
// cordis surface (ctx.effect runs immediately, ctx.webServer.register captures the handler)
// and mount that handler on a plain http server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { apply } from '../index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STARTED = '2026-09-28T00:00:00Z';
const cleanups = [];
after(() => { for (const fn of cleanups) { try { fn(); } catch {} } });

function makeFakeRun({ runId, status = 'running', pid = null, questions = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dshwf-test-'));
  const runDir = join(root, 'projA', '.qoder', 'workflow-runs', runId);
  mkdirSync(join(runDir, 'inbox'), { recursive: true });
  const prog = {
    runId, name: 'n-' + runId, cwd: join(root, 'projA').replace(/\\/g, '/'), cwdBase: 'projA',
    backend: 'file', status, phases: [], calls: [], dispatched: 0, settled: 0, failed: 0, rejected: 0,
    logs: [], questions: questions || [], artifacts: [],
    startedAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:01:00Z',
  };
  writeFileSync(join(runDir, 'progress.json'), JSON.stringify(prog));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify({ runId, status, pid, cwd: join(root, 'projA'), scriptPath: join(runDir, 'script.mjs') }));
  writeFileSync(join(runDir, 'script.mjs'), "export const meta = { name: 'x', description: 'd' };\nreturn 1;\n");
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  return { root, runDir };
}

async function startHost(roots) {
  let handler = null;
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (r) => { handler = r.handler; } },
  };
  apply(ctx, { roots });
  assert.ok(handler, 'plugin registered a handler');
  const server = createServer(handler);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = 'http://127.0.0.1:' + server.address().port;
  cleanups.push(() => { try { server.close(); } catch {} });
  return base;
}

test('v2 /runs exposes a runKey per run', async () => {
  const fake = makeFakeRun({ runId: 'dsh-rk' });
  const base = await startHost([fake.root]);
  const runs = (await (await fetch(base + '/runs')).json()).runs;
  assert.match(runs[0].runKey, /^[0-9a-f]{64}$/);
});

test('v2 /resume spawns wf.mjs resume with the run cwd for a failed run', async () => {
  const fake = makeFakeRun({ runId: 'dsh-res1', status: 'failed' });
  const base = await startHost([fake.root]);
  await fetch(base + '/runs');
  // The local script has no external calls; the real engine must accept a new lifecycle.
  const r = await (await fetch(base + '/resume?run=dsh-res1&startedAt=' + encodeURIComponent(STARTED), { method: 'POST' })).json();
  assert.equal(r.ok, true);
  assert.equal(r.spawned, true);
  assert.equal(r.accepted, true);
  const missing = await (await fetch(base + '/resume?run=nope&startedAt=' + encodeURIComponent(STARTED), { method: 'POST' })).json();
  assert.equal(missing.ok, false);
});

test('v2 /resume without startedAt is 400; with a stale startedAt is 409 STALE_LIFECYCLE', async () => {
  const fake = makeFakeRun({ runId: 'dsh-st', status: 'failed' });
  const base = await startHost([fake.root]);
  const noSt = await fetch(base + '/resume?run=dsh-st', { method: 'POST' });
  assert.equal(noSt.status, 400);
  const stale = await fetch(base + '/resume?run=dsh-st&startedAt=2000-01-01T00%3A00%3A00Z', { method: 'POST' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'STALE_LIFECYCLE');
});

test('v2 /resume returns 409 for a live running run', async () => {
  const fake = makeFakeRun({ runId: 'dsh-live', status: 'running', pid: process.pid });
  const base = await startHost([fake.root]);
  const r = await (await fetch(base + '/resume?run=dsh-live&startedAt=' + encodeURIComponent(STARTED), { method: 'POST' })).json();
  assert.equal(r.ok, false);
  assert.match(String(r.error || ''), /alive|running/);
});

test('v2 /answer writes the inbox answer and guards question state', async () => {
  const questions = [
    { qId: 'q000-aaa11111', question: 'Q1', state: 'waiting', askedAt: '2026-09-28T00:00:00Z', answeredAt: null, answerPreview: null },
    { qId: 'q000-bbb22222', question: 'Q2', state: 'answered', askedAt: '2026-09-28T00:00:00Z', answeredAt: '2026-09-28T00:01:00Z', answerPreview: 'y' },
  ];
  const fake = makeFakeRun({ runId: 'dsh-q', questions });
  const base = await startHost([fake.root]);
  await fetch(base + '/runs');
  const r = await (await fetch(base + '/answer?run=dsh-q&q=q000-aaa11111&startedAt=' + encodeURIComponent(STARTED), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: '好的' }),
  })).json();
  assert.equal(r.ok, true);
  const wrote = JSON.parse(readFileSync(join(fake.runDir, 'inbox', 'q000-aaa11111.json'), 'utf8'));
  assert.deepEqual(wrote, { ok: true, text: '好的' });
  const rej = await (await fetch(base + '/answer?run=dsh-q&q=q000-bbb22222&startedAt=' + encodeURIComponent(STARTED), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'x' }),
  })).json();
  assert.equal(rej.ok, false);
  const bad = await (await fetch(base + '/answer?run=dsh-q&q=q000-aaa11111&startedAt=' + encodeURIComponent(STARTED), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();
  assert.equal(bad.ok, false);
});

test('v2 client.js carries the v2 markers', () => {
  const src = readFileSync(join(ROOT, 'client.js'), 'utf8');
  for (const m of ['data-act="result"', 'data-act="history"', 'dwf-qin', 'data-act="answer"', 'data-act="resume"', 'dwf-shake']) {
    assert.ok(src.includes(m), 'client.js missing marker: ' + m);
  }
});
