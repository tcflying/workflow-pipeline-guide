#!/usr/bin/env node
// Offline test suite for the workflow engine: no model calls, no network.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyzeSource, validateArgs, resolveCliEntry, flushPendingIndex, ENGINE_VERSION, MAX_PROMPT_CHARS, CLI_MAX_OUTPUT_BYTES } from '../skills/dynamic-workflow/runtime/wf.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(HERE, '..', 'skills', 'dynamic-workflow', 'runtime', 'wf.mjs');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const results = [];

async function test(name, fn) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('test timed out after 90000ms')), 90000);
  });
  try {
    await Promise.race([fn(), guard]);
    pass++;
    results.push({ name, ok: true });
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    fail++;
    results.push({ name, ok: false, error: e.message });
    process.stdout.write(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 8).join('\n       ')}\n`);
  } finally {
    clearTimeout(timer);
  }
}

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  return dir;
}

async function wf(args, cwd, opts = {}) {
  const env = { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') };
  try {
    const { stdout, stderr } = await execFileP(NODE, [WF, ...args], { cwd, env, maxBuffer: 32 * 1024 * 1024, timeout: 60000, killSignal: 'SIGKILL', ...opts });
    return { code: 0, stdout, stderr, json: safeJson(stdout) };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '', json: safeJson(e.stdout || '') };
  }
}

function safeJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

// The engine rewrites pending.json in place, so a host read can land mid-write. Retrying the poll
// is the documented host behavior; crashing the test on it is not.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const GOOD = `export const meta = {
  name: 'good-review',
  description: 'Review a diff from two angles then merge',
  args: { target: { type: 'string', required: true }, depth: { type: 'number', default: 2 } },
};
phase('Review');
const found = await parallel([
  () => agent('security pass on ' + args.target),
  () => agent('perf pass on ' + args.target),
]);
log('collected ' + found.length);
phase('Merge');
const merged = await agent('merge ' + JSON.stringify(found) + ' at depth ' + args.depth);
return { found, merged, depth: args.depth };
`;

process.stdout.write('analyzeSource\n');
await test('accepts a well-formed script and keeps meta/args', () => {
  const r = analyzeSource(GOOD, 'good.js');
  assert.deepEqual(r.diags, [], JSON.stringify(r.diags));
  assert.equal(r.meta.name, 'good-review');
  assert.deepEqual(Object.keys(r.meta.args), ['target', 'depth']);
});

await test('rejects a script with no meta block', () => {
  const r = analyzeSource('return agent("x");', 'nometa.js');
  assert.ok(r.diags.some((d) => d.code === 'meta_missing'));
});

await test('rejects a one-line meta object', () => {
  const r = analyzeSource(`export const meta = { name: 'x', description: 'y' };\nreturn 1;\n`, 'oneline.js');
  assert.deepEqual(r.diags, [], JSON.stringify(r.diags));
  assert.equal(r.meta.name, 'x');
});

await test('reports nondeterminism and host access', () => {
  for (const [src, code] of [
    [`export const meta = { name: 'a', description: 'b' };\nreturn Date.now();\n`, 'nondeterministic'],
    [`export const meta = { name: 'a', description: 'b' };\nreturn Math.random();\n`, 'nondeterministic'],
    [`export const meta = { name: 'a', description: 'b' };\nreturn new Date().getFullYear();\n`, 'nondeterministic'],
    [`export const meta = { name: 'a', description: 'b' };\nconst fs = require('fs');\nreturn fs;\n`, 'forbidden_module'],
    [`export const meta = { name: 'a', description: 'b' };\nreturn process.cwd();\n`, 'forbidden_host'],
    [`export const meta = { name: 'a', description: 'b' };\nreturn await import('node:fs');\n`, 'forbidden_module'],
    [`export const meta = { name: 'a', description: 'b' };\nreturn fetch('http://x');\n`, 'forbidden_host'],
  ]) {
    const r = analyzeSource(src, 'bad.js');
    assert.ok(r.diags.some((d) => d.code === code), `${code} not reported: ${JSON.stringify(r.diags)}`);
  }
});

await test('rejects the spellings that reach the realm behind the determinism shim', () => {
  const META = `export const meta = { name: 'a', description: 'b' };\n`;
  for (const expr of [
    'return agent["prototype"];',
    'return ({})["__proto__"];',
    "return agent['constructor']('return process')();",
    'return Function("return Date")();',
    'return eval("Date.now()");',
  ]) {
    const r = analyzeSource(META + expr + '\n', 'escape.js');
    const errs = r.diags.filter((d) => d.severity === 'error');
    assert.ok(errs.length, `check accepted ${expr}: ${JSON.stringify(r.diags)}`);
    assert.ok(errs.every((d) => d.code === 'forbidden_host'), `${expr} → ${JSON.stringify(errs)}`);
  }
  // The same words must stay legal where they are only prose, exactly as for the other bans.
  const prose = analyzeSource(META + "const note = 'constructor, prototype, __proto__, Function(), eval()';\n// Function(x) in a comment\nreturn note;\n", 'clean-escape.js');
  assert.deepEqual(prose.diags, [], JSON.stringify(prose.diags));
});

await test('does not fire on banned words inside strings and comments', () => {
  const src = [
    "export const meta = { name: 'a', description: 'Date.now() and Math.random() and process' };",
    "// require('fs') and fetch(x) live in this comment",
    'const note = "Math.random() inside a string";',
    'const tpl = `process.stdout inside a template`;',
    'const re = /Date\\.now\\(/;',
    'return { note, tpl, re: re.source };',
  ].join('\n');
  const r = analyzeSource(src, 'clean.js');
  assert.deepEqual(r.diags, [], JSON.stringify(r.diags));
});

await test('reports compile errors with a line past the meta block', () => {
  const r = analyzeSource(`export const meta = { name: 'a', description: 'b' };\nconst x = ;\nreturn x;\n`, 'syn.js');
  const diag = r.diags.find((d) => d.code === 'syntax');
  assert.ok(diag, JSON.stringify(r.diags));
});

process.stdout.write('validateArgs\n');
await test('fills defaults and rejects unknown, missing and mistyped args', () => {
  const decl = { target: { type: 'string', required: true }, depth: { type: 'number', default: 2 }, mode: { type: 'string', enum: ['fast', 'slow'] }, flag: { type: 'boolean', default: false } };
  // An optional arg nobody passed stays absent: materialising it as null turns the value the run
  // stores into an argument that fails its own type check on the next validation.
  const r = validateArgs(decl, { target: 'x' });
  assert.deepEqual(r, { ok: true, args: { target: 'x', depth: 2, flag: false }, errors: [] });
  assert.equal('mode' in r.args, false);
  assert.equal(validateArgs(decl, { target: 'x', nope: 1 }).ok, false);
  assert.equal(validateArgs(decl, { depth: 3 }).errors.some((e) => e.includes('missing required')), true);
  assert.equal(validateArgs(decl, { target: 'x', depth: '3' }).errors.some((e) => e.includes('must be number')), true);
  assert.equal(validateArgs(decl, { target: 'x', mode: 'mid' }).errors.some((e) => e.includes('must be one of')), true);
  assert.equal(validateArgs(decl, { target: 'x', flag: 'yes' }).errors.length, 1);
});

process.stdout.write('wf.mjs check / save / list\n');
await test('check exits 2 on a bad script and 0 on a good one', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'good.js'), GOOD);
  fs.writeFileSync(path.join(cwd, 'bad.js'), `export const meta = { name: 'b' };\nreturn Date.now();\n`);
  const good = await wf(['check', 'good.js'], cwd);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.equal(good.json.ok, true);
  const bad = await wf(['check', 'bad.js', '--args', '{"target":"x"}'], cwd);
  assert.equal(bad.code, 2);
  assert.ok(bad.json.diagnostics.length >= 2, JSON.stringify(bad.json));
});

await test('save round-trips meta + body and list shows both scopes', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'draft.js'), GOOD);
  const saved = await wf(['save', 'draft.js', '--name', 'pr-review', '--scope', 'project', '--when-to-use', 'deep PR review'], cwd);
  assert.equal(saved.json.ok, true, saved.stdout + saved.stderr);
  assert.equal(saved.json.roundtrip, true);
  const text = fs.readFileSync(saved.json.path, 'utf8');
  assert.match(text, /export const meta = \{/);
  assert.equal((text.match(/export const meta/g) || []).length, 1, 'meta declared once');
  const recheck = analyzeSource(text, 'saved.js');
  assert.deepEqual(recheck.diags, [], JSON.stringify(recheck.diags));
  assert.equal(recheck.meta.name, 'pr-review');
  assert.deepEqual(Object.keys(recheck.meta.args), ['target', 'depth']);
  const listed = await wf(['list'], cwd);
  assert.equal(listed.json.workflows.length, 1);
  assert.equal(listed.json.workflows[0].name, 'pr-review');
  assert.equal(listed.json.workflows[0].scope, 'project');
  assert.deepEqual(listed.json.workflows[0].args, ['target', 'depth']);
});

await test('refuses to overwrite an existing saved workflow without --overwrite', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'draft.js'), GOOD);
  await wf(['save', 'draft.js', '--name', 'twice'], cwd);
  const again = await wf(['save', 'draft.js', '--name', 'twice'], cwd);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr + again.stdout, /already exists/);
  const forced = await wf(['save', 'draft.js', '--name', 'twice', '--overwrite'], cwd);
  assert.equal(forced.json.ok, true);
});


await test('project and global archives that resolve to one folder are listed once', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'draft.js'), GOOD);
  const same = { ...process.env, QODER_WF_HOME: cwd };
  const saved = await wf(['save', 'draft.js', '--name', 'shared'], cwd, { env: same });
  assert.equal(saved.json.ok, true, saved.stdout + saved.stderr);
  const listed = await wf(['list'], cwd, { env: same });
  assert.equal(listed.json.workflows.length, 1, JSON.stringify(listed.json.workflows));
});

process.stdout.write('wf.mjs run (echo backend)\n');
await test('runs phases, parallel fan-out, pipeline and log', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'good.js'), GOOD);
  const r = await wf(['run', 'good.js', '--args', '{"target":"src/a.ts"}', '--backend', 'echo', '--run-id', 'echo-run'], cwd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.agentCalls, 3);
  assert.deepEqual(r.json.args, { target: 'src/a.ts', depth: 2 });
  assert.equal(r.json.result.found.length, 2);
  assert.match(r.json.result.merged, /echo:merge/);
  const status = await wf(['status', 'echo-run'], cwd);
  assert.deepEqual(status.json.runs[0].phases, ['Review', 'Merge']);
  assert.equal(status.json.runs[0].agentSettled, 3);
  assert.equal(status.json.runs[0].status, 'completed');
});

await test('agent({json:true}) reports a non-JSON reply as a settled failure', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'j.js'), `export const meta = { name: 'jsonx', description: 'd' };
const bad = await agent('give me json', { json: true });
const strict = parallel([() => agent('also not json', { json: true, throwOnError: true })]);
const good = await agent('plain answer');
return { bad, strict: await strict, good };
`);
  const r = await wf(['run', 'j.js', '--backend', 'echo', '--run-id', 'json-bad'], cwd);
  // A16 pair: two settled failures *and* one success is a partial failure, so the run completes and
  // carries the counts. Without the third call every dispatch here fails and the run must be failed.
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  assert.equal(r.json.result.bad.ok, false);
  assert.match(r.json.result.bad.error, /not JSON/);
  assert.match(r.json.result.strict[0].error, /not JSON/);
  assert.match(r.json.result.good, /^echo:/);
  assert.equal(r.json.agentFailed, 0, JSON.stringify(r.json));
  assert.equal(r.json.agentDispatched, 3, JSON.stringify(r.json));
});

await test('a failing agent settles as {ok:false} instead of killing the run', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'f.js'), `export const meta = { name: 'f', description: 'd' };
const bad = parallel([() => { throw new Error('boom'); }, () => agent('fine')]);
return await bad;
`);
  const r = await wf(['run', 'f.js', '--backend', 'echo', '--run-id', 'fail-run'], cwd);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.result[0].ok, false);
  assert.match(r.json.result[0].error, /boom/);
  assert.equal(typeof r.json.result[1], 'string');
});

await test('pipeline runs stages per item', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'p.js'), `export const meta = { name: 'p', description: 'd' };
phase('Fan');
const out = await pipeline([1, 2, 3],
  async (n) => await agent('double ' + n),
  async (txt, orig) => ({ orig, txt })
);
return out;
`);
  const r = await wf(['run', 'p.js', '--backend', 'echo', '--run-id', 'pipe-run'], cwd);
  assert.equal(r.json.status, 'completed', JSON.stringify(r.json));
  assert.deepEqual(r.json.result.map((x) => x.orig), [1, 2, 3]);
  assert.match(r.json.result[1].txt, /echo:double 2/);
});

await test('enforces the agent call budget', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'b.js'), `export const meta = { name: 'b', description: 'd' };
const out = await parallel([1, 2, 3].map((i) => () => agent('call ' + i)));
return out;
`);
  const r = await wf(['run', 'b.js', '--backend', 'echo', '--max-calls', '2', '--run-id', 'budget-run'], cwd);
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.result.filter((x) => x && x.ok === false).length, 1);
  assert.match(r.json.result[2].error, /budget exhausted/);
});

await test('re-running a run id replays settled agents from the journal', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'good.js'), GOOD);
  const first = await wf(['run', 'good.js', '--args', '{"target":"x"}', '--backend', 'echo', '--run-id', 'replay-run'], cwd);
  assert.equal(first.code, 0);
  // file backend would park forever; instant completion proves the cache answered.
  const second = await wf(['run', 'good.js', '--args', '{"target":"x"}', '--backend', 'file', '--run-id', 'replay-run'], cwd);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(second.json.status, 'completed');
  assert.equal(second.json.agentCalls, 0, 'replayed calls must not re-dispatch');
  assert.equal(second.json.replayedCalls, 3);
  assert.deepEqual(second.json.result, first.json.result);
  const journal = fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'replay-run', 'journal.jsonl'), 'utf8');
  assert.ok(journal.includes('"type":"agent_replay"'), 'no replay events recorded');
});

await test('an optional argument left out stays absent across a resume', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'opt.js'), `export const meta = { name: 'opt', description: 'd', args: { target: { type: 'string', required: true }, note: { type: 'string' }, seen: { type: 'boolean', default: false } } };
return { target: args.target, noteType: typeof args.note, note: args.note ?? 'absent', seen: args.seen };
`);
  const first = await wf(['run', 'opt.js', '--args', '{"target":"x"}', '--backend', 'echo', '--run-id', 'opt-run'], cwd);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json.args, { target: 'x', seen: false });
  assert.equal(first.json.result.note, 'absent');
  const again = await wf(['resume', 'opt-run', '--backend', 'echo'], cwd);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.json.status, 'completed', JSON.stringify(again.json));
  assert.deepEqual(again.json.args, { target: 'x', seen: false });
  assert.equal(again.json.replayedCalls, 0);
});

process.stdout.write('wf.mjs run (file backend handshake)\n');
await test('parks on pending.json and completes when a host loop answers inbox', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'h.js'), `export const meta = { name: 'h', description: 'd', args: { q: { type: 'string', required: true } } };
phase('Search');
const hits = await parallel([() => agent('lookup A: ' + args.q), () => agent('lookup B: ' + args.q)]);
phase('Answer');
return await agent('synthesize ' + hits.join(' | '));
`);
  const child = spawn(NODE, [WF, 'run', 'h.js', '--args', '{"q":"token-buckets"}', '--backend', 'file', '--run-id', 'handshake', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', r));
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'handshake');
  // This loop is the documented host protocol: read pending.json, answer each callId once,
  // repeat until out.json exists. Everything is keyed by callId, so batches may interleave.
  const answered = new Set();
  const seenPhases = new Set();
  let out = null;
  for (let i = 0; i < 250 && !out; i++) {
    if (fs.existsSync(path.join(runDir, 'out.json'))) {
      out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
      break;
    }
    const pf = path.join(runDir, 'pending.json');
    if (fs.existsSync(pf)) {
      const p = readJson(pf) || { items: [] };
      for (const item of p.items) {
        if (answered.has(item.callId)) continue;
        answered.add(item.callId);
        seenPhases.add(item.phase);
        assert.ok(item.prompt.length > 0, 'pending item carries no prompt');
        fs.writeFileSync(path.join(runDir, 'inbox', item.callId + '.json'), JSON.stringify({ ok: true, text: `ans[${item.phase}]:${item.label}` }));
      }
    }
    await sleep(100);
  }
  const code = await exited;
  assert.ok(out, 'engine never produced out.json (exit ' + code + '): ' + err);
  assert.equal(code, 0, 'engine exited ' + code + ' ' + err);
  assert.equal(out.status, 'completed');
  assert.equal(out.agentCalls, 3);
  assert.equal(answered.size, 3);
  assert.deepEqual([...seenPhases].sort(), ['Answer', 'Search']);
  assert.match(out.result, /^ans\[Answer\]:synthesize ans\[Search\]:lookup A: token-buckets/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'pending.json'), 'utf8')).outstanding, 0);
});

await test('an inbox error answer becomes a settled failure the script can branch on', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'e.js'), `export const meta = { name: 'e', description: 'd' };
return await parallel([() => agent('will fail'), () => agent('will pass')]);
`);
  const child = spawn(NODE, [WF, 'run', 'e.js', '--backend', 'file', '--run-id', 'err-answer', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'err-answer');
  // Both agent() calls dispatch concurrently, so the first flush of pending.json may legitimately
  // carry one item. Wait for the causal fact (two parked calls), never for the file to exist.
  const items = await waitPending(runDir, 2);
  fs.writeFileSync(path.join(runDir, 'inbox', items[0].callId + '.json'), JSON.stringify({ ok: false, error: 'subagent crashed' }));
  fs.writeFileSync(path.join(runDir, 'inbox', items[1].callId + '.txt'), 'pass text');
  await exited;
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.result[0], { ok: false, error: 'subagent crashed' });
  assert.equal(out.result[1], 'pass text');
});

// Drive one full lifecycle as the documented host: answer every parked call with answer(item),
// skipping a call when answer() returns null, and hand back the settled out.json.
// `viaResume` starts the lifecycle with `resume <runId>` instead of `run <script>`.
async function hostLifecycle(cwd, scriptFile, runId, answer, viaResume, extraEnv) {
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', runId);
  const argv = viaResume
    ? [WF, 'resume', runId, '--backend', 'file', '--quiet']
    : [WF, 'run', scriptFile, '--backend', 'file', '--run-id', runId, '--quiet'];
  const child = spawn(NODE, argv, { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome'), ...extraEnv }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  // Never read a previous lifecycle's out.json: wait until this process owns the run.
  const sf = path.join(runDir, 'state.json');
  let owns = false;
  for (let i = 0; i < 400 && !owns; i++) {
    try {
      owns = JSON.parse(fs.readFileSync(sf, 'utf8')).pid === child.pid;
    } catch {}
    if (!owns) await sleep(100);
  }
  assert.ok(owns, `run ${runId} never took over ${sf}`);
  const answered = new Set();
  let out = null;
  for (let i = 0; i < 300 && !out; i++) {
    if (fs.existsSync(path.join(runDir, 'out.json'))) {
      out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
      break;
    }
    const pf = path.join(runDir, 'pending.json');
    if (fs.existsSync(pf)) {
      for (const item of (readJson(pf)?.items || [])) {
        if (answered.has(item.callId)) continue;
        answered.add(item.callId);
        const payload = answer(item);
        if (payload) fs.writeFileSync(path.join(runDir, 'inbox', item.callId + '.json'), JSON.stringify(payload));
      }
    }
    await sleep(100);
  }
  // A lifecycle that writes out.json and then never exits is a bug worth a red test, not a hung suite:
  // cap the wait so a deadlined park that stops expiring fails instead of blocking the runner forever.
  const code = await Promise.race([exited, sleep(90000).then(() => { child.kill(); return 'hung'; })]);
  return { runDir, code, out, dispatched: answered.size };
}

await test('a half-written inbox answer is retried instead of failing the call', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a8.js'), `export const meta = { name: 'a8', description: 'd' };\nreturn await agent('needs a whole answer');\n`);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'torn-answer');
  const child = spawn(NODE, [WF, 'run', 'a8.js', '--backend', 'file', '--run-id', 'torn-answer', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const [item] = await waitPending(runDir, 1);
  const f = path.join(runDir, 'inbox', item.callId + '.json');
  fs.writeFileSync(f, '{"ok":true,"tex');
  await sleep(1500);
  fs.writeFileSync(f, JSON.stringify({ ok: true, text: 'the whole answer' }));
  const code = await exited;
  assert.equal(code, 0, 'engine exited ' + code);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.result, 'the whole answer');
});

await test('answered and timed-out calls leave no pending or inbox ghosts', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a9.js'), `export const meta = { name: 'a9', description: 'd' };\nreturn await parallel([() => agent('answered'), () => agent('abandoned', { timeoutMs: 1500 })]);\n`);
  const { runDir, code, out } = await hostLifecycle(cwd, 'a9.js', 'ghosts', (item) => (item.prompt === 'answered' ? { ok: true, text: 'done' } : null));
  assert.equal(code, 0, 'engine exited ' + code);
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.result[0], 'done');
  assert.equal(out.result[1].ok, false);
  assert.match(out.result[1].error, /timed out/);
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'pending')), [], 'an abandoned call left a pending/<callId>.json ghost');
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'inbox')), [], 'a consumed answer was never removed from inbox/');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'pending.json'), 'utf8')).outstanding, 0);
});

await test('a settled failure is returned in-run but re-dispatched on the next lifecycle', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a7.js'), `export const meta = { name: 'a7', description: 'd' };\nreturn await parallel([() => agent('will fail'), () => agent('will pass')]);\n`);
  const first = await hostLifecycle(cwd, 'a7.js', 'retry-failure', (item) => (item.prompt === 'will fail' ? { ok: false, error: 'subagent crashed' } : { ok: true, text: 'pass' }));
  assert.equal(first.code, 0, 'engine exited ' + first.code);
  assert.equal(first.out.status, 'completed', JSON.stringify(first.out));
  assert.deepEqual(first.out.result[0], { ok: false, error: 'subagent crashed' }, 'a settled failure must still come back to the script');
  assert.equal(first.out.result[1], 'pass');
  const second = await hostLifecycle(cwd, 'a7.js', 'retry-failure', (item) => {
    assert.equal(item.prompt, 'will fail', `only the failed call may re-dispatch, saw ${JSON.stringify(item)}`);
    return { ok: true, text: 'now it works' };
  });
  assert.equal(second.out.status, 'completed', JSON.stringify(second.out));
  assert.deepEqual(second.out.result, ['now it works', 'pass']);
  assert.equal(second.out.agentCalls, 1, 'the failed call must re-dispatch, not replay');
  assert.equal(second.out.replayedCalls, 1, 'the settled call must still replay');
});

await test('stop cancels a parked run', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), `export const meta = { name: 'c', description: 'd' };
return await agent('never answered');
`);
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'cancel-run', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'cancel-run');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(runDir, 'pending.json')); i++) await sleep(100);
  const stopped = await wf(['stop', 'cancel-run'], cwd);
  assert.equal(stopped.json.cancelled, true);
  const code = await exited;
  assert.equal(code, 1);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'cancelled');
  assert.match(out.error, /cancelled/);
});

// A parked run whose process is gone: the list must still show it, and stop must settle it.
async function parkThenKill(cwd, scriptFile, runId) {
  const child = spawn(NODE, [WF, 'run', scriptFile, '--backend', 'file', '--run-id', runId, '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', runId);
  let parked = false;
  for (let i = 0; i < 400 && !parked; i++) {
    const pf = path.join(runDir, 'pending.json');
    parked = Boolean(readJson(pf)?.items.length);
    if (!parked) await sleep(100);
  }
  assert.ok(parked, `run ${runId} never parked`);
  child.kill();
  await exited;
  // Windows can keep a terminated pid open until the parent drops its handle, so wait for the
  // engine itself to agree the process is gone rather than assuming a fixed delay.
  for (let i = 0; i < 40; i++) {
    const s = await wf(['status', runId], cwd);
    if (s.json.runs[0] && s.json.runs[0].processAlive === false) return runDir;
    await sleep(250);
  }
  throw new Error(`pid for ${runId} still reports alive after kill`);
}

process.stdout.write('cancellations, resumes and the run list\n');
await test('stop refuses a finished or unknown run and says why', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'good.js'), GOOD);
  const r = await wf(['run', 'good.js', '--args', '{"target":"x"}', '--backend', 'echo', '--run-id', 'done-run'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  const stopped = await wf(['stop', 'done-run'], cwd);
  assert.equal(stopped.code, 3);
  assert.equal(stopped.json.ok, false);
  assert.match(stopped.json.reason, /already completed/);
  const unknown = await wf(['stop', 'no-such-run'], cwd);
  assert.equal(unknown.json.ok, false);
  assert.match(unknown.json.reason, /no run named "no-such-run"/);
  assert.ok(unknown.json.knownRuns.includes('done-run'), JSON.stringify(unknown.json));
});

// Park a file-backend run, stop it the documented way, and wait for it to settle as cancelled.
async function parkThenStop(cwd, scriptFile, runId) {
  const child = spawn(NODE, [WF, 'run', scriptFile, '--backend', 'file', '--run-id', runId, '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', runId);
  await waitPending(runDir, 1);
  const stopped = await wf(['stop', runId], cwd);
  assert.equal(stopped.json.cancelled, true, stopped.stdout + stopped.stderr);
  const code = await exited;
  assert.equal(code, 1, 'a stopped run should exit 1, got ' + code);
  return runDir;
}

const ONE_CALL = `export const meta = { name: 'c', description: 'd' };\nreturn await agent('one parked call');\n`;

await test('a stopped run can be re-run under the same id', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), ONE_CALL);
  const runDir = await parkThenStop(cwd, 'c.js', 'rerun-id');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).status, 'cancelled');
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'rerun-id', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  let parked = null;
  try {
    [parked] = await waitPending(runDir, 1);
  } catch (e) {
    await exited;
    const settled = fs.existsSync(path.join(runDir, 'out.json')) ? fs.readFileSync(path.join(runDir, 'out.json'), 'utf8') : 'no out.json at all';
    throw new Error(e.message + ' — the re-run left: ' + settled);
  }
  assert.ok(parked.callId, 'the inherited CANCEL file killed the new lifecycle before it dispatched');
  fs.writeFileSync(path.join(runDir, 'inbox', parked.callId + '.json'), JSON.stringify({ ok: true, text: 'fresh answer' }));
  const code = await exited;
  assert.equal(code, 0, 'engine exited ' + code);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.result, 'fresh answer');
  assert.equal(out.agentCalls, 1);
});

await test('a re-run reports no out.json until it really settles', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), ONE_CALL);
  const runDir = await parkThenStop(cwd, 'c.js', 'out-fresh');
  assert.ok(fs.existsSync(path.join(runDir, 'out.json')), 'the cancelled run wrote its own result');
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'out-fresh', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const [item] = await waitPending(runDir, 1);
  const during = await wf(['status', 'out-fresh'], cwd);
  const row = during.json.runs[0];
  assert.equal(row.status, 'running', JSON.stringify(row));
  assert.equal(row.out, null, 'the host handshake waits on out.json, so a leftover one lies');
  fs.writeFileSync(path.join(runDir, 'inbox', item.callId + '.json'), JSON.stringify({ ok: true, text: 'fresh answer' }));
  await exited;
  const after = await wf(['status', 'out-fresh'], cwd);
  assert.equal(after.json.runs[0].out.status, 'completed', JSON.stringify(after.json.runs[0]));
});

await test('run refuses a run id another live process already holds', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), ONE_CALL);
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'dup-run', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'dup-run');
  await waitPending(runDir, 1);
  const second = await wf(['run', 'c.js', '--backend', 'echo', '--run-id', 'dup-run'], cwd);
  assert.equal(second.code, 3, second.stdout + second.stderr);
  assert.equal(second.json.ok, false, JSON.stringify(second.json));
  assert.equal(second.json.stage, 'run');
  assert.match(second.json.reason, /still going \(pid \d+,/);
  assert.match(second.json.hint, /wf\.mjs stop dup-run/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).pid, child.pid, 'the refused run must not rewrite state.json');
  child.kill();
  await exited;
});

await test('a dead lifecycle answer is not consumed as a fresh one', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), ONE_CALL);
  const runDir = await parkThenKill(cwd, 'c.js', 'ghost-answer');
  const parked = JSON.parse(fs.readFileSync(path.join(runDir, 'pending.json'), 'utf8')).items;
  assert.equal(parked.length, 1, JSON.stringify(parked));
  const f = path.join(runDir, 'inbox', parked[0].callId + '.json');
  fs.writeFileSync(f, JSON.stringify({ ok: true, text: 'answer to a dead lifecycle' }));
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'ghost-answer', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  // Three causal barriers, in order: this process owns state.json (so nothing it writes below is
  // the dead lifecycle's), then the swept answer file is gone, then the call is parked again.
  // Waiting only for the file to vanish also matches the new lifecycle's startup wipe, which lands
  // long before its first dispatch — that raced the re-park assertion and red-flaked.
  const sf = path.join(runDir, 'state.json');
  let owns = false;
  for (let i = 0; i < 400 && !owns; i++) {
    owns = readJson(sf)?.pid === child.pid;
    if (!owns) await sleep(100);
  }
  assert.ok(owns, `the re-run never took over ${sf}`);
  let swept = false;
  for (let i = 0; i < 300 && !swept; i++) {
    swept = !fs.existsSync(f);
    if (!swept) await sleep(100);
  }
  assert.ok(swept, 'the new lifecycle read the previous lifecycle answer file');
  assert.equal(fs.existsSync(path.join(runDir, 'out.json')), false, 'a ghost answer settled the run');
  await waitPending(runDir, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'pending.json'), 'utf8')).items.length, 1, 'the call was never re-parked for a real answer');
  child.kill();
  await exited;
});

await test('stop never downgrades a run that settled while it was reading state', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), ONE_CALL);
  const runDir = await parkThenKill(cwd, 'c.js', 'settled-race');
  // cmdRun writes out.json before state.json, so this is exactly the interleaving a stop can load
  // across: state still says running, the result is already settled on disk.
  fs.writeFileSync(path.join(runDir, 'out.json'), JSON.stringify({ runId: 'settled-race', status: 'completed', result: 'the real answer' }));
  const stopped = await wf(['stop', 'settled-race'], cwd);
  assert.equal(stopped.json.ok, true, stopped.stdout + stopped.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(st.status, 'completed', JSON.stringify(st));
  assert.ok(st.stopRequestedAt, 'the stop request is still recorded');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8')).result, 'the real answer');
  const again = await wf(['stop', 'settled-race'], cwd);
  assert.equal(again.json.ok, false);
  assert.match(again.json.reason, /already completed/);
});

await test('status reports a dead run as stale instead of hiding it', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), `export const meta = { name: 'c', description: 'd' };\nreturn await agent('never answered');\n`);
  await parkThenKill(cwd, 'c.js', 'dead-run');
  fs.mkdirSync(path.join(cwd, '.qoder', 'workflow-runs', 'no-state'), { recursive: true });
  const s = await wf(['status'], cwd);
  const dead = s.json.runs.find((r) => r.runId === 'dead-run');
  assert.ok(dead, JSON.stringify(s.json.runs));
  assert.equal(dead.status, 'stale');
  assert.equal(dead.recordedStatus, 'running');
  assert.equal(dead.processAlive, false);
  assert.equal(dead.resumable, true);
  assert.match(dead.staleReason, /pid .* is not running/);
  const junk = s.json.runs.find((r) => r.runId === 'no-state');
  assert.ok(junk, 'a folder with no state.json must still get a row');
  assert.equal(junk.status, 'untracked');
});

await test('stop settles a run whose process is gone', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), `export const meta = { name: 'c', description: 'd' };\nreturn await agent('never answered');\n`);
  const runDir = await parkThenKill(cwd, 'c.js', 'orphan');
  const stopped = await wf(['stop', 'orphan'], cwd);
  assert.equal(stopped.json.ok, true, stopped.stdout + stopped.stderr);
  assert.equal(stopped.json.settled, true);
  assert.equal(stopped.json.stale, true);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'cancelled');
  assert.match(out.error, /was no longer running/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).status, 'cancelled');
  const again = await wf(['stop', 'orphan'], cwd);
  assert.equal(again.json.ok, false);
  assert.match(again.json.reason, /already cancelled/);
});

await test('resume refuses a live run and names the alternative', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c.js'), `export const meta = { name: 'c', description: 'd' };\nreturn await agent('parked');\n`);
  const child = spawn(NODE, [WF, 'run', 'c.js', '--backend', 'file', '--run-id', 'live-run', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'live-run');
  let parked = false;
  for (let i = 0; i < 400 && !parked; i++) {
    const pf = path.join(runDir, 'pending.json');
    parked = Boolean(readJson(pf)?.items.length);
    if (!parked) await sleep(100);
  }
  assert.ok(parked, 'run never parked');
  const res = await wf(['resume', 'live-run'], cwd);
  assert.equal(res.code, 3);
  assert.equal(res.json.ok, false);
  assert.match(res.json.reason, /still going \(pid \d+,/);
  assert.match(res.json.hint, /wf\.mjs stop live-run/);
  await wf(['stop', 'live-run'], cwd);
  await exited;
  const after = await wf(['resume', 'live-run', '--backend', 'echo'], cwd);
  assert.equal(after.json.status, 'completed', after.stdout + after.stderr);
  assert.equal(after.json.agentCalls, 1);
});

process.stdout.write('mid-flight steering\n');
const STEER = `export const meta = { name: 's', description: 'd' };
phase('One');
const first = await agent('first call');
phase('Two');
const extra = notes();
const second = await agent('second [' + (extra.join('|') || 'nothing') + '] after ' + first);
return { notes: extra, merged: first + ' + ' + second };
`;

async function waitPending(runDir, want, seen = new Set()) {
  for (let i = 0; i < 400; i++) {
    const pf = path.join(runDir, 'pending.json');
    if (fs.existsSync(pf)) {
      // An answered call leaves the index for one tick, so only unseen callIds count as parked.
      const items = (readJson(pf)?.items || []).filter((it) => !seen.has(it.callId));
      if (items.length >= want) return items;
    }
    await sleep(100);
  }
  throw new Error(`run never had ${want} unseen outstanding calls`);
}

await test('a queued note reaches the next agent prompt', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 's.js'), STEER);
  const child = spawn(NODE, [WF, 'run', 's.js', '--backend', 'file', '--run-id', 'steer-run', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'steer-run');
  const seen = new Set();
  const [one] = await waitPending(runDir, 1, seen);
  seen.add(one.callId);
  const queued = await wf(['steer', 'steer-run', 'prefer Windows paths'], cwd);
  assert.equal(queued.json.ok, true, queued.stdout + queued.stderr);
  assert.equal(queued.json.queued, 1);
  fs.writeFileSync(path.join(runDir, 'inbox', one.callId + '.json'), JSON.stringify({ ok: true, text: 'done-one' }));
  const [two] = await waitPending(runDir, 1, seen);
  assert.ok(two.callId !== one.callId, 'second call should be a fresh dispatch');
  assert.match(two.prompt, /prefer Windows paths/, 'the note never reached the second prompt');
  fs.writeFileSync(path.join(runDir, 'inbox', two.callId + '.json'), JSON.stringify({ ok: true, text: 'done-two' }));
  const code = await exited;
  assert.equal(code, 0, 'engine exited ' + code);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.result, { notes: ['prefer Windows paths'], merged: 'done-one + done-two' });
  const st = (await wf(['status', 'steer-run'], cwd)).json.runs[0];
  assert.equal(st.steerQueued, 1);
  assert.equal(st.steerDelivered, 1);
  // Re-running the same id must replay the note read, not re-dispatch on a changed prompt.
  const again = await wf(['run', 's.js', '--backend', 'file', '--run-id', 'steer-run', '--quiet'], cwd);
  assert.equal(again.json.status, 'completed', again.stdout + again.stderr);
  assert.equal(again.json.replayedCalls, 2, JSON.stringify(again.json));
  assert.equal(again.json.agentCalls, 0);
  assert.deepEqual(again.json.result, { notes: ['prefer Windows paths'], merged: 'done-one + done-two' });
});

await test('steer refuses a finished run and explains it', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 's.js'), `export const meta = { name: 's', description: 'd' };\nreturn await agent('one');\n`);
  const r = await wf(['run', 's.js', '--backend', 'echo', '--run-id', 'steer-done'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  const res = await wf(['steer', 'steer-done', 'too late'], cwd);
  assert.equal(res.code, 3);
  assert.equal(res.json.ok, false);
  assert.match(res.json.reason, /already completed/);
  assert.match(res.json.hint, /resume steer-done/);
});

process.stdout.write('the confirmation gate\n');
await test('trust skips the confirmation once, and only for that content', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'draft.js'), GOOD);
  await wf(['save', 'draft.js', '--name', 'pr-review'], cwd);
  const run = (id, extra) => wf(['run', '--saved', 'pr-review', '--args', '{"target":"x"}', '--backend', 'echo', '--run-id', id, ...(extra || [])], cwd);
  const first = await run('cf1');
  assert.deepEqual(first.json.confirmation, { required: true, basis: 'first-run' }, first.stdout + first.stderr);
  assert.equal((await wf(['list'], cwd)).json.workflows[0].trusted, false);
  const t = await wf(['trust', 'pr-review'], cwd);
  assert.equal(t.json.ok, true, t.stdout + t.stderr);
  const second = await run('cf2');
  assert.equal(second.json.confirmation.required, false);
  assert.equal(second.json.confirmation.basis, 'trust-list');
  assert.equal((await wf(['list'], cwd)).json.workflows[0].trusted, true);
  const resave = await wf(['save', 'draft.js', '--name', 'pr-review', '--description', 'v2', '--overwrite'], cwd);
  assert.equal(resave.json.ok, true, resave.stdout + resave.stderr);
  const third = await run('cf3');
  assert.equal(third.json.confirmation.required, true);
  assert.equal(third.json.confirmation.basis, 'script-changed');
  assert.equal((await wf(['list'], cwd)).json.workflows[0].trusted, false);
  const skip = await run('cf4', ['--yes']);
  assert.deepEqual(skip.json.confirmation, { required: false, basis: 'flag' });
  const un = await wf(['untrust', 'pr-review'], cwd);
  assert.equal(un.json.was, true);
  assert.equal((await run('cf5')).json.confirmation.basis, 'first-run');
});

process.stdout.write('run --saved\n');
await test('runs a saved workflow by name with its declared args', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'draft.js'), GOOD);
  const saved = await wf(['save', 'draft.js', '--name', 'pr-review'], cwd);
  const r = await wf(['run', '--saved', 'pr-review', '--args', '{"target":"lib/","depth":5}', '--backend', 'echo', '--run-id', 'from-saved'], cwd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.args.depth, 5);
  assert.match(r.json.scriptPath, /dynamic-workflows.{0,3}pr-review\.js$/);
  const missing = await wf(['run', '--saved', 'pr-review', '--backend', 'echo'], cwd);
  assert.equal(missing.code, 2);
  assert.ok(missing.json.stage === 'args' && missing.json.errors.some((e) => e.includes('missing required')), JSON.stringify(missing.json));
  const absent = await wf(['run', '--saved', 'nope'], cwd);
  assert.equal(absent.code, 2);
  assert.equal(absent.json.stage, 'source');
});

process.stdout.write('runtime determinism enforcement\n');
// Each case is a single expression so the generated body stays valid after `return`.
const denyScript = (expr) => `export const meta = { name: 'nd', description: 'd' };\nreturn (${expr});\n`;

async function runExpr(expr, runId) {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'nd.js'), denyScript(expr));
  const r = await wf(['run', 'nd.js', '--backend', 'echo', '--quiet', '--run-id', runId], cwd);
  return { code: r.code, json: r.json, stderr: r.stderr };
}

await test('bypasses that slip past the static check still throw at runtime', async () => {
  for (const [expr, id] of [
    ['(() => { const D = Date; return D.now(); })()', 'nd-dnow'],
    ['(() => { const D = Date; return new D().getTime(); })()', 'nd-dctor'],
    ["Math['ran' + 'dom']()", 'nd-mrandom'],
    ['(() => { const m = Math; return m["ran"+"dom"](); })()', 'nd-mrand2'],
  ]) {
    const r = await runExpr(expr, id);
    assert.equal(r.json.status, 'failed', `${expr} → ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /disabled in workflows/, `${expr} → ${r.json.error}`);
  }
});

await test('the internals of the determinism shim are out of reach', async () => {
  const seen = await runExpr('typeof __real + typeof __deny + typeof __math + typeof __Clock', 'nd-shim-names');
  assert.equal(seen.json.status, 'completed', JSON.stringify(seen.json));
  assert.equal(seen.json.result, 'undefinedundefinedundefinedundefined', 'the shim must not leave its own bindings in scope');
  const reached = await runExpr('__real', 'nd-shim-reach');
  assert.equal(reached.json.status, 'failed', JSON.stringify(reached.json));
  assert.match(reached.json.error, /__real is not defined/);
  const shim = await runExpr('typeof __shim + ":" + typeof __shim.math + ":" + typeof __shim.Clock', 'nd-shim-shape');
  assert.equal(shim.json.status, 'completed', JSON.stringify(shim.json));
  assert.equal(shim.json.result, 'object:object:function');
});

await test('host capabilities the script must not have are absent', async () => {
  const r = await runExpr('typeof performance + typeof fetch + typeof WebAssembly + typeof require', 'nd-host');
  assert.equal(r.json.status, 'completed', JSON.stringify(r.json));
  assert.equal(r.json.result, 'undefinedundefinedundefinedundefined');
});

await test('deterministic uses of Math and Date still work', async () => {
  const ok = await runExpr('Math.max(1, 2) + Math.floor(Math.PI) + new Date(0).getTime()', 'nd-ok');
  assert.equal(ok.json.status, 'completed', JSON.stringify(ok.json));
  assert.equal(ok.json.result, 5);
});

process.stdout.write('A14: the realm behind a function constructor\n');
// Every function exposes its realm's Function constructor, so these reach the real clock past the
// determinism shim. The static check is expected to accept them: the scanner is not the defense.
const REALM_BODIES = [
  "const F = Reflect.get(function marker() {}, 'constructor');\nconst D = F('return Date')();\nreturn 'REAL ' + String(D.now());",
  "const g = (x) => x;\nconst D = Reflect.get(Object.getPrototypeOf(g), 'constructor')('return Date')();\nreturn 'REAL ' + String(D.now());",
  "const D = Reflect.get(log, 'constructor')('return Date')();\nreturn 'REAL ' + String(D.now());",
];

await test('the Function-constructor route to the real clock fails at runtime, not at check', async () => {
  let i = 0;
  for (const body of REALM_BODIES) {
    i++;
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, 'realm.js'), `export const meta = { name: 'realm', description: 'd' };\n${body}\n`);
    const checked = await wf(['check', 'realm.js'], cwd);
    assert.equal(checked.code, 0, `check must stay silent about ${i}: ${checked.stdout}${checked.stderr}`);
    assert.deepEqual(checked.json.diagnostics, [], JSON.stringify(checked.json));
    const r = await wf(['run', 'realm.js', '--backend', 'echo', '--quiet', '--run-id', `realm-${i}`], cwd);
    assert.equal(r.json.status, 'failed', `${i} → ${r.stdout}${r.stderr}`);
    assert.match(r.json.error, /Code generation from strings disallowed/, `${i} → ${JSON.stringify(r.json)}`);
  }
});

// The route the vm option alone cannot close: agent/log/parallel are built by the engine, so their
// `constructor` is the *host* realm's Function, and codeGeneration only governs the script's realm.
// Until nothing host-realm crosses the boundary these are host code execution, not a determinism slip.
await test('the injected facade and script data hand the script no host realm', async () => {
  let i = 0;
  for (const body of [
    "const HF = Reflect.get(Reflect.get(log, 'constructor'), 'constructor');\nreturn 'HOST ' + String(HF('return process.pid')());",
    "const HF = Reflect.get(Reflect.get(args, 'constructor'), 'constructor');\nreturn 'HOST ' + String(HF('return process.pid')());",
    "const r = await agent('give me json', { json: true });\nconst HF = Reflect.get(Reflect.get(r, 'constructor'), 'constructor');\nreturn 'HOST ' + String(HF('return process.pid')());",
    "let e = null; try { phase(''); } catch (x) { e = x; }\nconst HF = Reflect.get(Reflect.get(e, 'constructor'), 'constructor');\nreturn 'HOST ' + String(HF('return process.pid')());",
  ]) {
    i++;
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, 'host.js'), `export const meta = { name: 'host', description: 'd' };\n${body}\n`);
    const checked = await wf(['check', 'host.js'], cwd);
    assert.equal(checked.code, 0, `check must stay silent about route ${i}: ${checked.stdout}${checked.stderr}`);
    const r = await wf(['run', 'host.js', '--backend', 'echo', '--quiet', '--run-id', `host-${i}`], cwd);
    assert.equal(r.json.status, 'failed', `route ${i} → ${r.stdout}${r.stderr}`);
    assert.match(r.json.error, /Code generation from strings disallowed|is not a function/, `route ${i} → ${JSON.stringify(r.json)}`);
    assert.equal(String(r.json.result || '').includes('HOST '), false, `route ${i} reached the host realm: ${JSON.stringify(r.json)}`);
  }
});

await test('ordinary script code still runs with code generation from strings off', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'norm.js'), `export const meta = { name: 'norm', description: 'd' };
class Box { get value() { return 7 } }
const b = new Box();
let stack = 'none';
try { null.x; } catch (e) { stack = typeof e.stack; }
const spread = await Promise.resolve([1, 1, 2]);
return JSON.stringify({ box: b.value, inst: b instanceof Box, json: JSON.parse('{"ok":true}'), stack, uniq: [...new Set(spread)].length, max: Math.max(1, 2), stamped: new Date(0).getTime() });
`);
  const r = await wf(['run', 'norm.js', '--backend', 'echo', '--quiet', '--run-id', 'norm-code'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.json.result), { box: 7, inst: true, json: { ok: true }, stack: 'string', uniq: 2, max: 2, stamped: 0 });
});

await test('the determinism denials still fire after the code-generation guard', async () => {
  for (const [expr, id] of [
    ['(() => { const D = Date; return D.now(); })()', 'nd-cg-dnow'],
    ['(() => { const m = Math; return m["ran" + "dom"](); })()', 'nd-cg-mrand'],
    ['(() => { const D = Date; return new D().getTime(); })()', 'nd-cg-newdate'],
  ]) {
    const r = await runExpr(expr, id);
    assert.equal(r.json.status, 'failed', `${expr} → ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /disabled in workflows/, `${expr} → ${r.json.error}`);
  }
});

process.stdout.write('\nA10/A11/A12: argv, --script and run id bounds\n');
const PLAIN = `export const meta = { name: 'plain', description: 'd' };\nreturn 'ran-plain';\n`;

await test('a valueless boolean flag keeps the positional that follows it', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), PLAIN);
  const quiet = await wf(['run', '--quiet', 'q.js', '--backend', 'echo', '--run-id', 'bool-mid'], cwd);
  assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr);
  assert.equal(quiet.json.status, 'completed', JSON.stringify(quiet.json));
  assert.equal(quiet.stdout.indexOf('WF '), -1, '--quiet must still suppress progress lines');
  const yes = await wf(['run', '--yes', 'q.js', '--backend', 'echo', '--run-id', 'yes-mid'], cwd);
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.deepEqual(yes.json.confirmation, { required: false, basis: 'flag' });
  const trailing = await wf(['run', 'q.js', '--backend', 'echo', '--run-id', 'yes-tail', '--yes'], cwd);
  assert.equal(trailing.code, 0, trailing.stdout + trailing.stderr);
  // Flags that do take a values keep taking them.
  const valued = await wf(['run', 'q.js', '--backend', 'echo', '--run-id', 'valued', '--name', 'named-run', '--args', '{}', '--concurrency', '3'], cwd);
  assert.equal(valued.code, 0, valued.stdout + valued.stderr);
  assert.equal(valued.json.name, 'named-run');
  assert.match(valued.stdout, /WF run=valued /, 'progress lines are on unless --quiet is set');
});

await test('--script takes a path, inline content and stdin', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), PLAIN);
  const drafts = path.join(cwd, '.qoder', 'workflow-drafts');
  const asPath = await wf(['run', '--script', 'q.js', '--backend', 'echo', '--run-id', 'script-path'], cwd);
  assert.equal(asPath.code, 0, asPath.stdout + asPath.stderr);
  assert.equal(asPath.json.result, 'ran-plain');
  assert.match(asPath.json.scriptPath, /[\\/]q\.js$/, JSON.stringify(asPath.json));
  assert.equal(fs.existsSync(drafts), false, '--script <path> must not copy the script into a draft');
  const inline = await wf(['run', '--script', PLAIN.replace('ran-plain', 'ran-inline'), '--backend', 'echo', '--run-id', 'script-inline'], cwd);
  assert.equal(inline.code, 0, inline.stdout + inline.stderr);
  assert.equal(inline.json.result, 'ran-inline');
  assert.ok(fs.existsSync(drafts), 'inline content still has to land in a draft file');
});

await test('a run id cannot climb out of the runs directory', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), PLAIN);
  for (const bad of ['..', '.', '...', '../../etc']) {
    const r = await wf(['run', 'q.js', '--backend', 'echo', '--quiet', '--run-id', bad], cwd);
    assert.equal(r.code, 1, `${bad} → ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /invalid --run-id/, `${bad} → ${r.stderr}`);
  }
  const qoder = path.join(cwd, '.qoder');
  for (const stray of ['state.json', 'out.json', 'journal.jsonl', 'pending.json', 'inbox', 'pending'])
    assert.equal(fs.existsSync(path.join(qoder, stray)), false, `run wrote ${stray} into ${qoder}`);
  const outside = await wf(['run', 'q.js', '--backend', 'echo', '--quiet', '--run-id', 'ok'], cwd);
  assert.equal(outside.code, 0, outside.stdout + outside.stderr);
  assert.equal(fs.readdirSync(qoder).sort().join(','), 'workflow-runs', JSON.stringify(fs.readdirSync(qoder)));
  for (const bad of ['..', '.', '../../etc']) {
    const s = await wf(['status', bad], cwd);
    assert.equal(s.code, 0, `${bad} → ${s.stdout}${s.stderr}`);
    const row = s.json.runs[0];
    assert.equal(row.status, 'missing', JSON.stringify(row));
    assert.match(row.reason, /invalid run id|invalid --run-id/, JSON.stringify(row));
    assert.equal(JSON.stringify(s.json).includes(path.join(cwd, 'etc')), false, `resolved a path outside the runs root: ${s.stdout}`);
    assert.equal(JSON.stringify(s.json).includes(qoder + path.sep) || JSON.stringify(s.json).includes(qoder + '/'), false, `refusal leaked a path under ${qoder}: ${s.stdout}`);
    const stop = await wf(['stop', bad], cwd);
    assert.equal(stop.code, 3, `${bad} → ${stop.stdout}${stop.stderr}`);
  }
  const good = await wf(['status', 'ok'], cwd);
  assert.equal(good.json.runs[0].status, 'completed', JSON.stringify(good.json.runs[0]));
  assert.equal(good.json.runs[0].dir, path.join(qoder, 'workflow-runs', 'ok'));
});

process.stdout.write('\nA13: engine error contract instead of raw stacks\n');
await test('status survives a torn out.json and says it is unreadable', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), PLAIN);
  const r = await wf(['run', 'q.js', '--backend', 'echo', '--quiet', '--run-id', 'torn-out'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'torn-out');
  fs.writeFileSync(path.join(runDir, 'out.json'), '{"runId":"torn-out","status":"com');
  const list = await wf(['status'], cwd);
  assert.equal(list.code, 0, list.stdout + list.stderr);
  const s = await wf(['status', 'torn-out'], cwd);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.equal(s.stderr.trim(), '', 'a raw stack must not leak: ' + s.stderr);
  const row = s.json.runs[0];
  assert.equal(row.out, null, JSON.stringify(row));
  assert.match(row.outError, /out\.json could not be parsed/, JSON.stringify(row));
  assert.equal(row.recordedStatus, 'completed', 'the run row must still be usable');
});

await test('check reports unparsable --args through the args stage contract', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), `export const meta = { name: 'a', description: 'b', args: { t: { type: 'string', required: true } } };\nreturn args.t;\n`);
  const r = await wf(['check', 'q.js', '--args', '{bad'], cwd);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false, JSON.stringify(r.json));
  assert.equal(r.json.stage, 'args', JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.length, JSON.stringify(r.json));
  assert.match(r.json.errors[0], /could not be parsed as JSON/, JSON.stringify(r.json));
  assert.equal(r.stderr.includes('SyntaxError'), false, 'a raw stack must not leak: ' + r.stderr);
  const good = await wf(['check', 'q.js', '--args', '{"t":"x"}'], cwd);
  assert.equal(good.code, 0, good.stdout + good.stderr);
});

await test('a circular return value settles the run as failed instead of stuck running', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'circ.js'), `export const meta = { name: 'circ', description: 'd' };
const a = { self: null };
a.self = a;
return a;
`);
  const r = await wf(['run', 'circ.js', '--backend', 'echo', '--quiet', '--run-id', 'circ-out'], cwd);
  assert.equal(r.stderr.includes('TypeError'), false, 'a raw stack must not leak: ' + r.stderr);
  assert.ok(r.json, 'the run printed no JSON: ' + r.stdout + r.stderr);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.json.status, 'failed', JSON.stringify(r.json));
  assert.match(r.json.error, /not JSON-serializable/, JSON.stringify(r.json));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'circ-out');
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(st.status, 'failed', JSON.stringify(st));
  assert.ok(st.finishedAt, 'the run must reach a terminal state');
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.equal(out.status, 'failed');
  const s = await wf(['status', 'circ-out'], cwd);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.equal(s.json.runs[0].out.status, 'failed', JSON.stringify(s.json.runs[0]));
});

await test('check on a directory emits a diagnostic instead of a raw stack', async () => {
  const cwd = tmpWorkspace();
  fs.mkdirSync(path.join(cwd, 'dirsim.js'));
  const r = await wf(['check', 'dirsim.js'], cwd);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.ok, false, JSON.stringify(r.json));
  assert.ok(r.json.diagnostics.some((d) => d.code === 'unreadable'), JSON.stringify(r.json.diagnostics));
  assert.equal(r.stderr.includes('readFileUtf8'), false, 'a raw stack must not leak: ' + r.stderr);
  const run = await wf(['run', 'dirsim.js', '--backend', 'echo'], cwd);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.equal(run.json.stage, 'check', JSON.stringify(run.json));
  const missing = await wf(['check', 'nope.js'], cwd);
  assert.equal(missing.code, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /script not found/);
});

process.stdout.write('\npaths / usage\n');await test('paths reports writable locations and a resolved cli entry', async () => {
  const cwd = tmpWorkspace();
  const r = await wf(['paths'], cwd);
  assert.equal(r.json.runs, path.join(cwd, '.qoder', 'workflow-runs'));
  assert.equal(r.json.savedGlobal, path.join(cwd, 'fakehome', '.qoder', 'dynamic-workflows'));
  assert.equal(r.json.savedProject, path.join(cwd, '.qoder', 'dynamic-workflows'));
  // SKILL.md says a null cliEntry is a normal state (a file-backend-only box), so the contract is
  // "null, or a path that exists" -- asserting a string red-flaked on every box without qodercli.
  const entry = r.json.cliEntry;
  assert.ok(entry === null || (typeof entry === 'string' && fs.existsSync(entry)), `cliEntry is neither null nor a real path: ${JSON.stringify(entry)}`);
});

await test('--help lists every subcommand', async () => {
  const r = await wf(['--help'], tmpWorkspace());
  for (const cmd of ['run', 'check', 'save', 'list', 'status', 'result', 'resume', 'stop', 'steer', 'trust', 'untrust', 'paths']) assert.match(r.stdout, new RegExp('wf.mjs ' + cmd));
});

process.stdout.write('\nbatch 3: A25/A26 the wall is the realm, and the boundary is total\n');

// A26: the pre-BRIDGE engine preserved every value by identity; the JSON rebuild crashed the whole
// run on the first value JSON cannot carry. The documented outcome now: primitives round-trip
// exactly (undefined stays undefined, NaN/-0 keep their identity), containers are rebuilt in the
// script realm, and anything unbuildable fails *its own call* naming the type.
const XBOUND = `export const meta = { name: 'xb', description: 'd' };
const kinds = {};
for (const [k, v] of Object.entries({ undef: undefined, nul: null, nan: NaN, inf: Infinity, negZero: -0, str: 's', num: 5, bool: false })) {
  const got = (await parallel([() => v]))[0];
  kinds[k] = { t: typeof got, same: Object.is(got, v), boxed: typeof got === 'object' };
}
for (const [k, v] of Object.entries({ big: 10n, fn: () => 1, map: new Map([['k', 1]]), set: new Set([1, 2]), sym: Symbol('q'), err: new Error('x'), date: new Date(0), regexp: /x/g })) {
  const got = (await parallel([() => v]))[0];
  kinds[k] = { neg: Boolean(got) && got.ok === false, err: got && got.error ? got.error : null };
}
const obj = (await parallel([() => ({ a: undefined, b: NaN, deep: { c: Infinity } })]))[0];
kinds.obj = { aUndef: obj.a === undefined, bNaN: Number.isNaN(obj.b), cInf: obj.deep.c === Infinity, ownRealm: Object.getPrototypeOf(obj) === Object.prototype };
const arr = (await parallel([() => [undefined, NaN, -0]]))[0];
kinds.arr = { isArr: Array.isArray(arr), e0: arr[0] === undefined, e1: Number.isNaN(arr[1]), e2: Object.is(arr[2], -0) };
kinds.sibling = (await parallel([() => 10n, () => 'survivor', () => 7]))[1] === 'survivor';
kinds.after = typeof (await agent('the run is still alive'));
return kinds;
`;

async function runEcho(script, body, runId) {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, `${runId}.js`), script + body + '\n');
  const checked = await wf(['check', `${runId}.js`], cwd);
  const r = await wf(['run', `${runId}.js`, '--backend', 'echo', '--quiet', '--run-id', runId], cwd);
  return { check: checked, code: r.code, json: r.json || {}, stdout: r.stdout, stderr: r.stderr };
}

await test('a value that cannot cross the boundary fails its call and names its type (A26)', async () => {
  const r = await runEcho('', XBOUND, 'xb-types');
  assert.equal(r.json.status, 'completed', r.check.stdout + r.stderr + JSON.stringify(r.json));
  const k = r.json.result;
  for (const [name, want] of Object.entries({ undef: 'undefined', nul: 'object', nan: 'number', inf: 'number', negZero: 'number', str: 'string', num: 'number', bool: 'boolean' })) {
    assert.equal(k[name].t, want, `${name} arrived as ${k[name].t}: ${JSON.stringify(k[name])}`);
    assert.equal(k[name].same, true, `${name} lost its identity: ${JSON.stringify(k[name])}`);
  }
  assert.equal(k.undef.boxed, false, 'undefined came back boxed (the null downgrade)');
  assert.equal(k.nul.boxed, true, 'null should still be the object typeof gives');
  for (const name of ['big', 'fn', 'map', 'set', 'sym', 'date', 'regexp']) {
    assert.equal(k[name].neg, true, `${name} did not fail its call: ${JSON.stringify(k[name])}`);
    assert.match(k[name].err, /cannot cross the workflow boundary/, `${name} → ${k[name].err}`);
  }
  assert.match(k.big.err, /bigint/i);
  assert.match(k.map.err, /Map/);
  assert.match(k.set.err, /Set/);
  assert.match(k.fn.err, /function/i);
  assert.match(k.sym.err, /symbol/i);
  // A29: SKILL.md:81-84 promises Date and RegExp are refused by name, not silently flattened to {}.
  assert.match(k.date.err, /Date/, `a Date was not named: ${k.date.err}`);
  assert.match(k.regexp.err, /RegExp/, `a RegExp was not named: ${k.regexp.err}`);
  assert.equal(k.err.neg, true, 'an Error instance was silently flattened instead of refused');
  assert.deepEqual(k.obj, { aUndef: true, bNaN: true, cInf: true, ownRealm: true });
  assert.deepEqual(k.arr, { isArr: true, e0: true, e1: true, e2: true });
  // The whole point: one un-crossable thunk must not take its batch or the run down with it.
  assert.equal(k.sibling, true, 'a BigInt thunk poisoned its siblings');
  assert.equal(k.after, 'string', 'the run died instead of continuing past an un-crossable value');
});

await test('a JSON-safe script keeps the pre-bridge cross-boundary baselines (A26)', async () => {
  const r = await runEcho(`export const meta = { name: 'xb2', description: 'd' };\n`, `const one = await parallel([() => ({ t: 'object', a: 1 })]);
const two = await parallel([() => undefined, () => { throw new Error('boom'); }]);
const n = notes();
const stamp = new Date(0).toISOString();
let shape = null;
try { null.x; } catch (e) { shape = { hasStack: typeof e.stack, name: e.name, msg: e.message }; }
return { oneType: typeof one[0], oneKeys: Object.keys(one[0]), twoUndef: two[0] === undefined, twoErr: two[1], notesIsArray: Array.isArray(n), notesLen: n.length, stamp, shape, metaKeys: Object.keys(meta) };
`, 'xb-baseline');
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr + JSON.stringify(r.json));
  const k = r.json.result;
  // §J's seven baselines, each measured on the pre-BRIDGE engine.
  assert.deepEqual([k.oneType, k.oneKeys], ['object', ['t', 'a']], 'parallel objects must come back as plain data');
  assert.equal(k.twoUndef, true, 'parallel([() => undefined]) must stay undefined, not null');
  assert.deepEqual(k.twoErr, { ok: false, error: 'boom' });
  assert.deepEqual([k.notesIsArray, k.notesLen], [true, 0], 'notes() must be a real array in the script realm');
  assert.equal(k.stamp, '1970-01-01T00:00:00.000Z');
  assert.equal(k.shape.name, 'TypeError');
  assert.equal(k.shape.hasStack, 'string');
  assert.match(k.shape.msg, /Cannot read properties of null/);
  assert.deepEqual(k.metaKeys, ['name', 'description']);
});

await test('ordinary class and prototype code passes check and runs (A25 positive control)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'cls.js'), `export const meta = { name: 'cls', description: 'd' };
class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  sum() { return this.x + this.y; }
}
const p = new Point(2, 3);
const tagged = Object.prototype.toString.call(new Map());
const viaReflect = Reflect.has(Object.getPrototypeOf(p), 'sum');
return JSON.stringify({ sum: p.sum(), tagged, viaReflect, protoOf: typeof p.constructor.prototype });
`);
  const checked = await wf(['check', 'cls.js'], cwd);
  assert.equal(checked.code, 0, `check refused normal class code: ${checked.stdout}${checked.stderr}`);
  assert.deepEqual(checked.json.diagnostics, [], JSON.stringify(checked.json.diagnostics));
  const r = await wf(['run', 'cls.js', '--backend', 'echo', '--quiet', '--run-id', 'cls-run'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.json.result), { sum: 5, tagged: '[object Map]', viaReflect: true, protoOf: 'object' });
});

await test('the constructor routes A25 leaves spellable still dead-end at runtime (A25 negative)', async () => {
  const routes = [
    ['facade-dot-ctor', "const F = agent.constructor;\nreturn 'HOST ' + String(F('return process.pid')());", 'codegen'],
    ['reflect-get-ctor', "const F = Reflect.get(agent, 'constructor');\nreturn 'HOST ' + String(F('return process.pid')());", 'codegen'],
    ['date-prototype', 'const P = Date.prototype;\nreturn String(typeof P.now) + ":" + String(P === Date.prototype);', 'no-clock'],
    ['bracket-quoted', "return agent['constructor']('return process')();", 'check-refused'],
  ];
  let i = 0;
  for (const [label, body, expect] of routes) {
    i++;
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, 'r.js'), `export const meta = { name: 'r', description: 'd' };\n${body}\n`);
    const checked = await wf(['check', 'r.js'], cwd);
    const r = await wf(['run', 'r.js', '--backend', 'echo', '--quiet', '--run-id', `a25-${i}`], cwd);
    if (expect === 'check-refused') {
      assert.equal(checked.code, 2, `${label} must still be refused by check: ${checked.stdout}`);
      assert.ok(checked.json.diagnostics.some((d) => d.code === 'forbidden_host'), `${label} → ${JSON.stringify(checked.json)}`);
      continue;
    }
    assert.equal(checked.code, 0, `${label}: ${checked.stdout}${checked.stderr}`);
    if (expect === 'codegen') {
      assert.equal(r.json.status, 'failed', `${label} → ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, /Code generation from strings disallowed/, `${label} → ${JSON.stringify(r.json)}`);
      assert.equal(String(r.json.result || '').includes('HOST '), false, `${label} reached the host realm`);
    } else {
      // The shim's Date is the deterministic clock: its prototype carries no real now().
      assert.equal(r.json.status, 'completed', `${label} → ${JSON.stringify(r.json)}`);
      assert.equal(r.json.result, 'undefined:true', `${label} → ${JSON.stringify(r.json)}`);
    }
  }
});

process.stdout.write('\nbatch 3: A15/A16/A17/A22 the failure contract\n');
await test('an inbox answer with no text field fails that call naming the field (A15)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a15.js'), `export const meta = { name: 'a15', description: 'd' };\nreturn await parallel([() => agent('bad shape'), () => agent('good shape')]);\n`);
  const { code, out } = await hostLifecycle(cwd, 'a15.js', 'a15-shape', (item) =>
    item.prompt === 'bad shape' ? { ok: true, result: 'a perfectly real answer, wrong field name' } : { ok: true, text: 'the right field' }
  );
  assert.equal(code, 0, 'engine exited ' + code);
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.result[1], 'the right field', 'the correct shape stopped working');
  assert.equal(out.result[0].ok, false, `a missing text field settled as a success: ${JSON.stringify(out.result[0])}`);
  assert.match(out.result[0].error, /no text field/, JSON.stringify(out.result[0]));
  assert.match(out.result[0].error, /keys present: ok, result/, JSON.stringify(out.result[0]));
  assert.equal(out.agentFailed, 1, JSON.stringify(out));
});

await test('a run whose every agent call failed settles failed with counts, not completed (A16)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a16.js'), `export const meta = { name: 'a16', description: 'd' };\nreturn await parallel([() => agent('one'), () => agent('two')]);\n`);
  const { code, out, runDir } = await hostLifecycle(cwd, 'a16.js', 'a16-all-fail', () => ({ ok: false, error: 'qodercli: Not logged in · Please run /login' }));
  assert.equal(code, 1, 'an all-failed run exited ' + code);
  assert.equal(out.status, 'failed', JSON.stringify(out));
  assert.deepEqual({ d: out.agentDispatched, s: out.agentSettled, f: out.agentFailed }, { d: 2, s: 2, f: 2 });
  assert.match(out.error, /every agent call failed \(2\)/, JSON.stringify(out));
  assert.match(out.error, /Not logged in/, JSON.stringify(out));
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(st.status, 'failed', JSON.stringify(st));
  assert.deepEqual({ d: st.agentDispatched, s: st.agentSettled, f: st.agentFailed }, { d: 2, s: 2, f: 2 }, 'state.json must carry the same counts');
  const row = (await wf(['status', 'a16-all-fail'], cwd)).json.runs[0];
  assert.equal(row.status, 'failed', JSON.stringify(row));
  assert.equal(row.agentFailed, 2);
});

await test('a partially failed run completes and still carries the counts (A16 pair)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a16p.js'), `export const meta = { name: 'a16p', description: 'd' };\nreturn await parallel([() => agent('one'), () => agent('two')]);\n`);
  const { code, out } = await hostLifecycle(cwd, 'a16p.js', 'a16-partial', (item) => (item.prompt === 'one' ? { ok: false, error: 'subagent crashed' } : { ok: true, text: 'fine' }));
  assert.equal(code, 0, 'engine exited ' + code);
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.deepEqual({ d: out.agentDispatched, s: out.agentSettled, f: out.agentFailed }, { d: 2, s: 2, f: 1 });
});

await test('an unanswered parked call times out, frees its slot and says the host stopped (A17)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a17.js'), `export const meta = { name: 'a17', description: 'd' };\nreturn await parallel([() => agent('nobody answers', { timeoutMs: 1500 }), () => agent('nobody answers this either', { timeoutMs: 1500 })]);\n`);
  const { code, out, runDir } = await hostLifecycle(cwd, 'a17.js', 'a17-park', () => null);
  assert.equal(code, 1, 'a run no host answered exited ' + code);
  assert.equal(out.status, 'failed', JSON.stringify(out));
  assert.equal(out.agentFailed, 2, JSON.stringify(out));
  assert.match(out.error, /host stopped driving the handshake/, JSON.stringify(out));
  for (const r of out.result || []) assert.equal(r && r.ok, false, JSON.stringify(out));
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'pending')), [], 'a timed-out park left a pending/<callId>.json ghost');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'pending.json'), 'utf8')).outstanding, 0, 'the index still lists the dead calls');
  // The default deadline is the load-bearing half of A17: every call above passes its own timeoutMs,
  // so a suite that never omits one cannot tell a working default from no default at all (the call
  // would simply hold its semaphore slot forever). WF_PARK_TIMEOUT_MS makes the default reachable.
  fs.writeFileSync(path.join(cwd, 'a17d.js'), `export const meta = { name: 'a17d', description: 'd' };\nreturn await agent('nobody answers, and this call names no timeoutMs');\n`);
  const dflt = await hostLifecycle(cwd, 'a17d.js', 'a17-default', () => null, false, { WF_PARK_TIMEOUT_MS: '1500' });
  assert.equal(dflt.code, 1, `a park on the default deadline hung (no default was applied): ${JSON.stringify(dflt)}`);
  assert.equal(dflt.out.status, 'failed', JSON.stringify(dflt.out));
  assert.match(dflt.out.error, /timed out after 1500ms/, `the default deadline was not the injected one: ${dflt.out.error}`);
  assert.deepEqual(fs.readdirSync(path.join(dflt.runDir, 'pending')), [], 'the default-timeout park left a pending ghost');
  // Positive control (A25/A26 discipline): a raised default still lets a late answer through.
  fs.writeFileSync(path.join(cwd, 'a17e.js'), `export const meta = { name: 'a17e', description: 'd' };\nreturn await agent('answer me slowly');\n`);
  const slow = await hostLifecycle(cwd, 'a17e.js', 'a17-default-ok', (item) => {
    setTimeout(() => fs.writeFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'a17-default-ok', 'inbox', item.callId + '.json'), JSON.stringify({ ok: true, text: 'late but in time' })), 2500);
    return null;
  }, false, { WF_PARK_TIMEOUT_MS: '30000' });
  assert.equal(slow.out.result, 'late but in time', JSON.stringify(slow.out));
  // A7 behavior: the next lifecycle re-dispatches both calls rather than replaying the timeouts.
  const again = await hostLifecycle(cwd, 'a17.js', 'a17-park', (item) => ({ ok: true, text: 'answered at last: ' + item.prompt }));
  assert.equal(again.code, 0, 'engine exited ' + again.code);
  assert.equal(again.out.status, 'completed', JSON.stringify(again.out));
  assert.deepEqual(again.out.result, ['answered at last: nobody answers', 'answered at last: nobody answers this either']);
  assert.equal(again.out.agentCalls, 2, JSON.stringify(again.out));
  // The counts are the journal's, like `status` reports them: cumulative across lifecycles, so the
  // two timed-out calls from the dead lifecycle are still on the record.
  assert.equal(again.out.agentFailed, 2, JSON.stringify(again.out));
  assert.equal(again.out.agentDispatched, 4, JSON.stringify(again.out));
});

await test('an unknown --flag is refused instead of silently ignored (A22)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'q.js'), PLAIN);
  const typo = await wf(['run', 'q.js', '--backend', 'echo', '--max-agent-calls', '2', '--run-id', 'flag-typo'], cwd);
  assert.equal(typo.code, 2, typo.stdout + typo.stderr);
  assert.equal(typo.json.ok, false, JSON.stringify(typo.json));
  assert.equal(typo.json.stage, 'usage', JSON.stringify(typo.json));
  assert.ok(typo.json.errors.some((e) => /unknown --max-agent-calls/.test(e)), JSON.stringify(typo.json));
  assert.ok(typo.json.knownFlags.includes('max-calls'), JSON.stringify(typo.json));
  assert.equal(fs.existsSync(path.join(cwd, '.qoder', 'workflow-runs', 'flag-typo')), false, 'a refused run must not create a run dir');
  const real = await wf(['run', 'q.js', '--backend', 'echo', '--max-calls', '2', '--run-id', 'flag-ok'], cwd);
  assert.equal(real.code, 0, real.stdout + real.stderr);
  assert.equal(real.json.status, 'completed', JSON.stringify(real.json));
  const eqForm = await wf(['run', 'q.js', '--backend=echo', '--quietl', '--run-id', 'flag-eq'], cwd);
  assert.equal(eqForm.code, 2, eqForm.stdout + eqForm.stderr);
  assert.match(eqForm.json.errors.join(), /unknown --quietl/, JSON.stringify(eqForm.json));
  // Per command: --force belongs to stop, not to status.
  const wrongCmd = await wf(['status', 'flag-ok', '--force'], cwd);
  assert.equal(wrongCmd.code, 2, wrongCmd.stdout + wrongCmd.stderr);
  assert.equal(wrongCmd.json.stage, 'usage', JSON.stringify(wrongCmd.json));
  const rightCmd = await wf(['stop', 'flag-ok', '--force'], cwd);
  assert.notEqual(rightCmd.json.stage, 'usage', rightCmd.stdout + rightCmd.stderr);
});

process.stdout.write('\nbatch 3b: A18/A19/A20/A28 the observability contract\n');

// A19: `status` is the host's only dashboard. Two lifecycles of the same run used to double the
// phase list, and the same read gave different answers, so the sequence must be derived once.
await test('status.phases is the declared sequence after a run and after a resume (A19)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'ph.js'), `export const meta = { name: 'ph', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] };
phase('A');
await agent('call-one');
phase('B');
await parallel([() => agent('call-two'), () => agent('call-three')]);
return 'done';
`);
  const run = await wf(['run', 'ph.js', '--backend', 'echo', '--quiet', '--run-id', 'phases'], cwd);
  assert.equal(run.json.status, 'completed', run.stdout + run.stderr);
  const afterRun = (await wf(['status', 'phases'], cwd)).json.runs[0];
  assert.deepEqual(afterRun.phases, ['A', 'B'], `after a single run: ${JSON.stringify(afterRun.phases)}`);
  const again = await wf(['resume', 'phases', '--backend', 'echo', '--quiet'], cwd);
  assert.equal(again.json.status, 'completed', again.stdout + again.stderr);
  const journal = fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'phases', 'journal.jsonl'), 'utf8');
  const phaseEvents = journal.trim().split('\n').filter((l) => /"type":"phase"/.test(l)).length;
  assert.equal(phaseEvents, 4, 'the resumed lifecycle really does re-call phase(), so de-duplication is doing the work');
  const afterResume = (await wf(['status', 'phases'], cwd)).json.runs[0];
  assert.deepEqual(afterResume.phases, ['A', 'B'], `after run+resume: ${JSON.stringify(afterResume.phases)}`);
});

// A18: a 500-item fan-out used to read its whole result back into the host context through stdout.
await test('run truncates a flooding result on stdout and keeps it whole in out.json (A18)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'big.js'), `export const meta = { name: 'big', description: 'd' };\nreturn { blob: 'z'.repeat(200000), n: 1 };\n`);
  const r = await wf(['run', 'big.js', '--backend', 'echo', '--quiet', '--run-id', 'flood'], cwd);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const printed = safeJson(r.stdout);
  assert.equal('result' in printed, false, 'stdout still carries the whole result');
  assert.equal(typeof printed.resultPreview, 'string', JSON.stringify(Object.keys(printed)));
  assert.ok(printed.resultPreview.length <= 2100, `resultPreview is ${printed.resultPreview.length} chars`);
  assert.ok(printed.resultBytes > 200000, `resultBytes says ${printed.resultBytes}`);
  assert.match(printed.resultFull, /out\.json/, JSON.stringify(printed.resultFull));
  assert.ok(r.stdout.length < 20000, `stdout is ${r.stdout.length} bytes`);
  const out = JSON.parse(fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'flood', 'out.json'), 'utf8'));
  assert.equal(out.result.blob.length, 200000, 'out.json must hold the complete result');
  // Positive control: a result that fits is still the answer on stdout, unchanged in shape.
  fs.writeFileSync(path.join(cwd, 'small.js'), `export const meta = { name: 'small', description: 'd' };\nreturn { n: 1 };\n`);
  const small = await wf(['run', 'small.js', '--backend', 'echo', '--quiet', '--run-id', 'no-flood'], cwd);
  assert.equal(small.json.status, 'completed', small.stdout + small.stderr);
  assert.deepEqual(safeJson(small.stdout).result, { n: 1 }, 'a small result stopped coming back on stdout');
  assert.equal(safeJson(small.stdout).resultPreview, undefined, 'the preview machinery fired on a result that fits');
  const fetched = await wf(['result', 'no-flood'], cwd);
  assert.match(fetched.stdout, /"n": 1/);
});

// A20: two ceilings, one on what a spawned cli may pour into the engine, one on what a script may
// paste into a prompt. Both must fail by name, and ordinary sizes must keep working.
await test('an over-cap prompt and an oversized cli reply both fail naming the limit (A20)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'cap.js'), `export const meta = { name: 'cap', description: 'd' };\nreturn await agent('x'.repeat(${MAX_PROMPT_CHARS + 1}));\n`);
  const over = await wf(['run', 'cap.js', '--backend', 'echo', '--quiet', '--run-id', 'prompt-cap'], cwd);
  assert.equal(over.json.status, 'failed', JSON.stringify(over.json));
  assert.match(over.json.error, new RegExp(`prompt is ${MAX_PROMPT_CHARS + 1} characters`), JSON.stringify(over.json.error));
  assert.match(over.json.error, /cap|limit/i, JSON.stringify(over.json.error));
  assert.match(JSON.stringify(over.json.warnings), /prompt-too-large/, `a prompt refusal was blamed on the call budget: ${JSON.stringify(over.json.warnings)}`);
  fs.writeFileSync(path.join(cwd, 'near.js'), `export const meta = { name: 'near', description: 'd' };\nreturn (await agent('x'.repeat(${MAX_PROMPT_CHARS}))).slice(0, 4);\n`);
  const just = await wf(['run', 'near.js', '--backend', 'echo', '--quiet', '--run-id', 'prompt-near'], cwd);
  assert.equal(just.json.status, 'completed', just.stdout + just.stderr);
  assert.equal(just.json.result, 'echo');

  const floodCli = path.join(cwd, 'flood-cli.js');
  fs.writeFileSync(floodCli, `process.stdout.write('z'.repeat(${CLI_MAX_OUTPUT_BYTES} + 4096));\n`);
  const quietCli = path.join(cwd, 'quiet-cli.js');
  fs.writeFileSync(quietCli, "process.stdout.write('short answer');\n");
  fs.writeFileSync(path.join(cwd, 'ask.js'), `export const meta = { name: 'ask', description: 'd' };\nreturn await agent('answer me');\n`);
  const cliEnv = (entry) => ({ env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome'), QODER_WORKFLOW_CLI_JS: entry } });
  const flood = await wf(['run', 'ask.js', '--backend', 'cli', '--quiet', '--run-id', 'cli-flood'], cwd, cliEnv(floodCli));
  assert.equal(flood.json.status, 'failed', JSON.stringify(flood.json));
  assert.match(flood.json.error, new RegExp(`exceeded ${CLI_MAX_OUTPUT_BYTES} bytes`), JSON.stringify(flood.json.error));
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.qoder', 'workflow-runs', 'cli-flood', 'pending')), [], 'the oversized child left a ghost');
  const calm = await wf(['run', 'ask.js', '--backend', 'cli', '--quiet', '--run-id', 'cli-ok'], cwd, cliEnv(quietCli));
  assert.equal(calm.json.status, 'completed', calm.stdout + calm.stderr);
  assert.equal(calm.json.result, 'short answer', 'a cli child under the cap stopped working');
  // R3B-08: the cap is on the answer. A child that screams into stderr while answering normally must
  // not have its call abandoned -- charging stderr to the same budget let progress output kill a run.
  const noisyCli = path.join(cwd, 'noisy-cli.js');
  fs.writeFileSync(noisyCli, `process.stderr.write('w'.repeat(${CLI_MAX_OUTPUT_BYTES} + 4096));\nprocess.stdout.write('answered despite the noise');\n`);
  const noisy = await wf(['run', 'ask.js', '--backend', 'cli', '--quiet', '--run-id', 'cli-noise'], cwd, cliEnv(noisyCli));
  assert.equal(noisy.json.status, 'completed', `a chatty stderr killed a good answer: ${JSON.stringify(noisy.json)}`);
  assert.equal(noisy.json.result, 'answered despite the noise', JSON.stringify(noisy.json));
});

// A28 per §R: a budget rejection happens before any dispatch event, so A16's counts cannot see it.
await test('a budget-rejected call is journalled and counted instead of vanishing (A28)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'three.js'), `export const meta = { name: 'three', description: 'd' };\nreturn await parallel([1, 2, 3].map((i) => () => agent('call ' + i)));\n`);
  const r = await wf(['run', 'three.js', '--backend', 'echo', '--quiet', '--max-calls', '1', '--run-id', 'rejected'], cwd);
  assert.equal(r.json.status, 'completed', `one call really did succeed, so the run is not failed: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.agentDispatched, 1, JSON.stringify(r.json));
  assert.equal(r.json.agentRejected, 2, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.warnings), JSON.stringify(r.json));
  assert.match(r.json.warnings.join('\n'), /budget exhausted after 1 of 3 planned calls/, JSON.stringify(r.json.warnings));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'rejected');
  const events = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === 'agent_rejected').length, 2, 'the rejections never reached the journal');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).agentRejected, 2, 'state.json lost the rejections');
  assert.equal((await wf(['status', 'rejected'], cwd)).json.runs[0].agentRejected, 2, 'status lost the rejections');
  // Positive control: the same script without a tight budget rejects nothing.
  const free = await wf(['run', 'three.js', '--backend', 'echo', '--quiet', '--run-id', 'unbudgeted'], cwd);
  assert.equal(free.json.status, 'completed', free.stdout + free.stderr);
  assert.equal(free.json.agentRejected, 0, JSON.stringify(free.json));
  assert.equal(free.json.warnings, undefined, JSON.stringify(free.json.warnings));
  assert.equal((await wf(['status', 'unbudgeted'], cwd)).json.runs[0].agentRejected, 0);
});

// C1: the budget was per-process, so every resume refilled it; and stop/out.json/status each put a
// different number behind `agentCalls`.
await test('the agent-call budget covers the whole run, not each process (C1)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'b3.js'), `export const meta = { name: 'b3', description: 'd' };\nreturn await parallel([1, 2, 3].map((i) => () => agent('call ' + i)));\n`);
  const first = await wf(['run', 'b3.js', '--backend', 'echo', '--quiet', '--max-calls', '2', '--run-id', 'budget'], cwd);
  assert.equal(first.json.agentCalls, 2, JSON.stringify(first.json));
  assert.equal(first.json.segmentCalls, 2, JSON.stringify(first.json));
  const again = await wf(['run', 'b3.js', '--backend', 'echo', '--quiet', '--max-calls', '2', '--run-id', 'budget'], cwd);
  assert.equal(again.json.agentCalls, 0, 'a second lifecycle was handed a fresh budget');
  assert.equal(again.json.segmentCalls, 0, JSON.stringify(again.json));
  assert.equal(again.json.replayedCalls, 2, JSON.stringify(again.json));
  assert.equal(again.json.agentDispatched, 2, 'the cumulative count must not move when nothing dispatched');
  assert.match(again.json.result[2].error, /budget exhausted/, JSON.stringify(again.json.result));
  // Positive control: raising the budget lets the last call through.
  const raised = await wf(['run', 'b3.js', '--backend', 'echo', '--quiet', '--max-calls', '9', '--run-id', 'budget'], cwd);
  assert.equal(raised.json.status, 'completed', raised.stdout + raised.stderr);
  assert.equal(raised.json.segmentCalls, 1, JSON.stringify(raised.json));
  assert.equal(raised.json.agentDispatched, 3, JSON.stringify(raised.json));
});

await test('--max-calls is clamped to a usable budget like --concurrency (C1 clamp)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'clamp.js'), `export const meta = { name: 'clamp', description: 'd' };\nreturn await parallel([1, 2, 3].map((i) => () => agent('call ' + i)));\n`);
  for (const [given, want] of [['0', 1], ['-3', 1], ['999999', 100000]]) {
    const id = `clamp-${given}`;
    const r = await wf(['run', 'clamp.js', '--backend', 'echo', '--quiet', '--max-calls', given, '--run-id', id], cwd);
    assert.equal(r.code, 0, `${given} → ${r.stdout}${r.stderr}`);
    const st = JSON.parse(fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', id, 'state.json'), 'utf8'));
    assert.equal(st.maxAgentCalls, want, `--max-calls ${given} stored ${st.maxAgentCalls}`);
    if (want === 1) {
      assert.equal(r.json.agentCalls, 1, `--max-calls ${given} dispatched ${r.json.agentCalls}`);
      assert.equal(r.json.agentRejected, 2, `the refused calls are invisible for --max-calls ${given}`);
    }
  }
  // Positive control: a nonsense value falls back to the default, not to zero or to no limit.
  const dflt = await wf(['run', 'clamp.js', '--backend', 'echo', '--quiet', '--max-calls', 'abc', '--run-id', 'clamp-abc'], cwd);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'clamp-abc', 'state.json'), 'utf8')).maxAgentCalls, 500);
  assert.equal(dflt.json.agentCalls, 3, JSON.stringify(dflt.json));
  assert.equal(dflt.json.agentRejected, 0);
});

process.stdout.write('\nbatch 3b: C2-C5 the file-backend and resume contract\n');

// C2 per §N: note identity was the line number, so compacting steer.jsonl swallowed a queued note
// and reordering it re-delivered a spent one.
await test('a steer note survives its file being compacted and reordered, and never repeats (C2)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c2.js'), `export const meta = { name: 'c2', description: 'd' };
phase('A');
const a = await agent('c-one', { label: 's1' });
const n1 = notes();
const b = await agent('after ' + n1.length, { label: 's2' });
const n2 = notes();
const c = await agent('after ' + n2.length, { label: 's3' });
const n3 = notes();
return { a, b, c, n1, n2, n3 };
`);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'c2-notes');
  const sj = path.join(runDir, 'steer.jsonl');
  const noteLines = () => fs.readFileSync(sj, 'utf8').split('\n').filter((l) => l.trim());
  const child = spawn(NODE, [WF, 'run', 'c2.js', '--backend', 'file', '--run-id', 'c2-notes', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const seen = new Set();
  let one = null;
  for (let i = 0; i < 300 && !fs.existsSync(path.join(runDir, 'out.json')); i++) {
    for (const item of readJson(path.join(runDir, 'pending.json'))?.items || []) {
      if (seen.has(item.callId)) continue;
      seen.add(item.callId);
      if (item.label === 's1') {
        await wf(['steer', 'c2-notes', 'NOTE-ONE'], cwd);
      } else if (item.label === 's2') {
        await wf(['steer', 'c2-notes', 'NOTE-TWO'], cwd);
        // Compact: the undelivered note moves from line 1 down to line 0.
        one = noteLines().find((l) => l.includes('NOTE-ONE'));
        fs.writeFileSync(sj, noteLines().find((l) => l.includes('NOTE-TWO')) + '\n');
      } else if (item.label === 's3') {
        // Reorder: both notes were delivered; put the spent one back on a fresh line number.
        fs.writeFileSync(sj, noteLines().find((l) => l.includes('NOTE-TWO')) + '\n' + one + '\n');
      }
      fs.writeFileSync(path.join(runDir, 'inbox', item.callId + '.json'), JSON.stringify({ ok: true, text: 'S:' + item.label }));
    }
    await sleep(100);
  }
  const code = await exited;
  assert.equal(code, 0, 'engine exited ' + code);
  const out = JSON.parse(fs.readFileSync(path.join(runDir, 'out.json'), 'utf8'));
  assert.deepEqual(out.result.n1, ['NOTE-ONE'], JSON.stringify(out.result));
  assert.deepEqual(out.result.n2, ['NOTE-TWO'], 'compacting the note file swallowed a queued note');
  assert.deepEqual(out.result.n3, [], 'a delivered note was re-delivered after the file was reordered');
});

// C3: model/agent/systemPrompt/cwd were in the cache key but never reached the parked call, so the
// host could not honour them while the engine acted as if they meant something.
await test('the parked entry carries the options the cache key hashes (C3)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c3.js'), `export const meta = { name: 'c3', description: 'd' };\nreturn await agent('opts check', { model: 'gpt-x', agent: 'reviewer', systemPrompt: 'be terse', cwd: 'C:/work/here' });\n`);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'c3-opts');
  let parked = null;
  const { code, out } = await hostLifecycle(cwd, 'c3.js', 'c3-opts', (item) => {
    parked = readJson(path.join(runDir, 'pending', item.callId + '.json'));
    return { ok: true, text: 'answered' };
  });
  assert.equal(code, 0, 'engine exited ' + code);
  assert.ok(parked, 'the parked entry was gone before the host could read it');
  for (const [k, v] of Object.entries({ model: 'gpt-x', agent: 'reviewer', systemPrompt: 'be terse', cwd: 'C:/work/here' }))
    assert.equal(parked[k], v, `pending/<callId>.json dropped ${k}: ${JSON.stringify(Object.keys(parked))}`);
  // Positive control: the handshake fields the host drives on are all still there.
  for (const k of ['callId', 'seq', 'key', 'phase', 'label', 'prompt', 'requestedAt'])
    assert.ok(k in parked, `the parked entry lost ${k}`);
  assert.equal(out.status, 'completed', JSON.stringify(out));
  assert.equal(out.result, 'answered');
});

// C4: resume with different --args silently shifted `nth` and reused cached answers for other
// questions, and overwrote the recorded args so the history denied it ever happened.
await test('resume refuses args that differ from the run’s recorded ones (C4)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c4.js'), `export const meta = { name: 'c4', description: 'd', args: { k: { type: 'string', required: true } } };\nreturn await agent('ask ' + args.k);\n`);
  const first = await wf(['run', 'c4.js', '--args', '{"k":"one"}', '--backend', 'echo', '--quiet', '--run-id', 'c4'], cwd);
  assert.equal(first.json.status, 'completed', first.stdout + first.stderr);
  // Positive controls first: the ordinary resumes still work.
  const plain = await wf(['resume', 'c4', '--backend', 'echo', '--quiet'], cwd);
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.deepEqual(plain.json.args, { k: 'one' });
  const same = await wf(['resume', 'c4', '--args', '{"k":"one"}', '--backend', 'echo', '--quiet'], cwd);
  assert.equal(same.code, 0, same.stdout + same.stderr);
  const diff = await wf(['resume', 'c4', '--args', '{"k":"TWO"}', '--backend', 'echo', '--quiet'], cwd);
  assert.equal(diff.code, 3, diff.stdout + diff.stderr);
  assert.equal(diff.json.ok, false, JSON.stringify(diff.json));
  assert.equal(diff.json.stage, 'resume', JSON.stringify(diff.json));
  assert.match(diff.json.reason, /args differ|args are different/, JSON.stringify(diff.json));
  assert.match(diff.json.reason, /"k":"one"/, JSON.stringify(diff.json));
  assert.match(diff.json.hint, /--force/, JSON.stringify(diff.json));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.qoder', 'workflow-runs', 'c4', 'state.json'), 'utf8')).args, { k: 'one' }, 'the refused resume rewrote the recorded args');
  const forced = await wf(['resume', 'c4', '--args', '{"k":"TWO"}', '--backend', 'echo', '--quiet', '--force'], cwd);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.deepEqual(forced.json.args, { k: 'TWO' });
});

// C5: `steerQueued` was "notes ever queued", which reads like backlog.
await test('status says how many queued notes are still undelivered (C5)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'c5.js'), ONE_CALL);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'c5-backlog');
  const child = spawn(NODE, [WF, 'run', 'c5.js', '--backend', 'file', '--run-id', 'c5-backlog', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const [item] = await waitPending(runDir, 1);
  await wf(['steer', 'c5-backlog', 'FIRST'], cwd);
  await wf(['steer', 'c5-backlog', 'SECOND'], cwd);
  const parked = (await wf(['status', 'c5-backlog'], cwd)).json.runs[0];
  assert.equal(parked.steerQueued, 2, JSON.stringify(parked));
  assert.equal(parked.steerDelivered, 0, JSON.stringify(parked));
  assert.equal(parked.steerUndelivered, 2, `undelivered backlog read as ${parked.steerUndelivered}`);
  fs.writeFileSync(path.join(runDir, 'inbox', item.callId + '.json'), JSON.stringify({ ok: true, text: 'done' }));
  await exited;
  const spent = (await wf(['status', 'c5-backlog'], cwd)).json.runs[0];
  assert.equal(spent.steerQueued, 2, JSON.stringify(spent));
  assert.equal(spent.steerUndelivered, 2, 'notes nobody read stopped being reported as a backlog');
  // Positive control: a delivered note is no longer counted as waiting (see the steer case below).
  assert.equal(spent.status, 'completed', JSON.stringify(spent));
});

await test('a delivered note counts as delivered, not as waiting (C5 pair)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 's.js'), STEER);
  const child = spawn(NODE, [WF, 'run', 's.js', '--backend', 'file', '--run-id', 'c5-pair', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'c5-pair');
  const seen = new Set();
  const [one] = await waitPending(runDir, 1, seen);
  seen.add(one.callId);
  await wf(['steer', 'c5-pair', 'only report findings under 30 lines'], cwd);
  fs.writeFileSync(path.join(runDir, 'inbox', one.callId + '.json'), JSON.stringify({ ok: true, text: 'done-one' }));
  const [two] = await waitPending(runDir, 1, seen);
  assert.match(two.prompt, /only report findings under 30 lines/);
  fs.writeFileSync(path.join(runDir, 'inbox', two.callId + '.json'), JSON.stringify({ ok: true, text: 'done-two' }));
  await exited;
  const row = (await wf(['status', 'c5-pair'], cwd)).json.runs[0];
  assert.equal(row.steerQueued, 1, JSON.stringify(row));
  assert.equal(row.steerDelivered, 1, JSON.stringify(row));
  assert.equal(row.steerUndelivered, 0, `a delivered note still looked undelivered: ${JSON.stringify(row)}`);
});

process.stdout.write('\nbatch 3b: B1/B2/B3 the cost contract\n');

// B1: resolveCliEntry() re-scanned every npx cache directory per cli call (4.49 ms each on the
// auditing box). One memo per process, and `paths` keeps doing a real resolve.
await test('the cli entry is resolved once per process and re-resolved for paths (B1)', async () => {
  const cwd = tmpWorkspace();
  const a = path.join(cwd, 'a-cli.js');
  const b = path.join(cwd, 'b-cli.js');
  fs.writeFileSync(a, '');
  fs.writeFileSync(b, '');
  const saved = process.env.QODER_WORKFLOW_CLI_JS;
  try {
    process.env.QODER_WORKFLOW_CLI_JS = a;
    assert.equal(resolveCliEntry(), a);
    process.env.QODER_WORKFLOW_CLI_JS = b;
    assert.equal(resolveCliEntry(), a, 'the memo did not hold: every call still rescans');
    assert.equal(resolveCliEntry(true), b, 'paths must still do a real resolve');
  } finally {
    if (saved === undefined) delete process.env.QODER_WORKFLOW_CLI_JS;
    else process.env.QODER_WORKFLOW_CLI_JS = saved;
  }
});

// B2 narrowed by §T: only the duplicate write. The index keeps `prompt` (that is the test at :375).
await test('flushPendingIndex skips the write when the snapshot is unchanged (B2)', async () => {
  const dir = tmpWorkspace();
  const pf = path.join(dir, 'pending.json');
  const runDir = { dir, runId: 'snap', pending: new Map([['c0', { callId: 'c0', seq: 0, phase: 'A', label: 'one', prompt: 'p one' }]]) };
  await flushPendingIndex(runDir);
  assert.equal(JSON.parse(fs.readFileSync(pf, 'utf8')).outstanding, 1);
  fs.writeFileSync(pf, 'SENTINEL');
  await flushPendingIndex(runDir);
  assert.equal(fs.readFileSync(pf, 'utf8'), 'SENTINEL', 'an unchanged snapshot was rewritten again');
  runDir.pending.set('c1', { callId: 'c1', seq: 1, phase: 'A', label: 'two', prompt: 'p two' });
  await flushPendingIndex(runDir);
  const after = JSON.parse(fs.readFileSync(pf, 'utf8'));
  assert.equal(after.outstanding, 2, 'a changed snapshot was not written');
  assert.ok(after.items[1].prompt.length > 0, 'the index stopped carrying prompt');
});

// B3: `status` re-parsed every run's whole journal. A terminal run's summary is in state.json, so a
// journal that is no longer there must not change what status says.
await test('status reads a terminal run from state.json instead of the whole journal (B3)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'good.js'), GOOD);
  const r = await wf(['run', 'good.js', '--args', '{"target":"x"}', '--backend', 'echo', '--quiet', '--run-id', 'b3'], cwd);
  assert.equal(r.json.status, 'completed', r.stdout + r.stderr);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'b3');
  const journal = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8');
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), '');
  const row = (await wf(['status', 'b3'], cwd)).json.runs[0];
  assert.equal(row.status, 'completed', JSON.stringify(row));
  assert.equal(row.agentDispatched, 3, `status still parsed the journal for the counts: ${JSON.stringify(row)}`);
  assert.equal(row.agentSettled, 3, JSON.stringify(row));
  assert.deepEqual(row.phases, ['Review', 'Merge'], `status still parsed the journal for phases: ${JSON.stringify(row.phases)}`);
  // Positive control: a state.json without the summary still falls back to the journal.
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), journal);
  const st = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  for (const k of ['agentDispatched', 'agentSettled', 'agentFailed', 'agentRejected', 'phases', 'notesDelivered']) delete st[k];
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(st));
  const legacy = (await wf(['status', 'b3'], cwd)).json.runs[0];
  assert.equal(legacy.agentDispatched, 3, JSON.stringify(legacy));
  assert.deepEqual(legacy.phases, ['Review', 'Merge'], JSON.stringify(legacy.phases));
});

// W4: the docs now say a stale run goes straight to resume. That route used to be documented as
// "stop first", and stop settles the run with an out.json the next lifecycle has to look past.
await test('a stale run resumes without stop, replaying the answer it already has (W4)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'w4.js'), `export const meta = { name: 'w4', description: 'd' };\nconst a = await agent('answered-first');\nconst b = await agent('parked-second');\nreturn a + ' + ' + b;\n`);
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', 'w4-stale');
  const child = spawn(NODE, [WF, 'run', 'w4.js', '--backend', 'file', '--run-id', 'w4-stale', '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  const seen = new Set();
  const [one] = await waitPending(runDir, 1, seen);
  seen.add(one.callId);
  fs.writeFileSync(path.join(runDir, 'inbox', one.callId + '.json'), JSON.stringify({ ok: true, text: 'FIRST' }));
  await waitPending(runDir, 1, seen);
  child.kill();
  await exited;
  for (let i = 0; i < 40; i++) {
    if ((await wf(['status', 'w4-stale'], cwd)).json.runs[0]?.processAlive === false) break;
    await sleep(250);
  }
  const stale = (await wf(['status', 'w4-stale'], cwd)).json.runs[0];
  assert.equal(stale.status, 'stale', JSON.stringify(stale));
  assert.equal(stale.resumable, true, JSON.stringify(stale));
  const back = await hostLifecycle(cwd, 'w4.js', 'w4-stale', () => ({ ok: true, text: 'SECOND' }), true);
  assert.equal(back.code, 0, 'the resumed run exited ' + back.code);
  assert.equal(back.out.status, 'completed', JSON.stringify(back.out));
  assert.equal(back.out.result, 'FIRST + SECOND');
  assert.equal(back.out.replayedCalls, 1, 'the settled answer was not replayed');
  assert.equal(back.out.segmentCalls, 1, `the resume re-paid for settled work: ${JSON.stringify(back.out)}`);
});

process.stdout.write('\nbatch 3b: C7/C8/A23 the surface contract\n');
await test('--help documents every live flag and what the exit codes mean (C7)', async () => {
  const r = await wf(['--help'], tmpWorkspace());
  assert.equal(r.code, 0, r.stderr);
  for (const token of ['--trusted', '--text', '--description', '--when-to-use', 'maxOutputTokens', 'permissionMode', 'args-file', 'Exit codes'])
    assert.ok(r.stdout.includes(token), `USAGE never mentions ${token}`);
  assert.match(r.stdout, /0 .*ok/i, 'no exit-code legend');
  assert.match(r.stdout, /3 .*refus/i, 'exit 3 is undocumented');
});

await test('the plugin manifest version is the engine version, and it moved (A23)', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.qoder-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, ENGINE_VERSION, `manifest ${manifest.version} vs engine ${ENGINE_VERSION}`);
  assert.notEqual(ENGINE_VERSION, '0.4.0', 'a batch of behavior changes landed on an unchanged version');
});

process.stdout.write('\nbatch 3c: A31/A30 refusals are counted, refused scripts never execute\n');
await test('a fan-out whose every prompt is over the cap fails the run instead of settling completed (A31)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a31.js'), `export const meta = { name: 'a31', description: 'd' };\nconst r = await parallel([() => agent('x'.repeat(600 * 1024), { label: 'a' }), () => agent('x'.repeat(600 * 1024), { label: 'b' })]);\nreturn r.map((x) => (x && x.ok === false ? 'REFUSED' : 'ok'));\n`);
  const out = (await wf(['run', 'a31.js', '--backend', 'echo', '--run-id', 'a31', '--yes'], cwd)).json;
  assert.equal(out.status, 'failed', JSON.stringify(out).slice(0, 200));
  assert.equal(out.agentDispatched, 0, JSON.stringify(out.agentDispatched));
  assert.equal(out.agentRejected, 2, JSON.stringify(out.agentRejected));
  assert.match(out.error, /refused before dispatch \(2, first reason: prompt-too-large\)/, JSON.stringify(out.error));
  // An empty prompt refuses the same way, and says so with its own reason.
  fs.writeFileSync(path.join(cwd, 'a31e.js'), `export const meta = { name: 'a31e', description: 'd' };\nconst r = await parallel([() => agent('   ', { label: 'e' })]);\nreturn r.map((x) => (x && x.ok === false ? 'REFUSED' : 'ok'));\n`);
  const empty = (await wf(['run', 'a31e.js', '--backend', 'echo', '--run-id', 'a31e', '--yes'], cwd)).json;
  assert.equal(empty.status, 'failed', JSON.stringify(empty).slice(0, 200));
  assert.match(empty.error, /first reason: empty-prompt/, JSON.stringify(empty.error));
  // Positive control: the same fan-out just under the cap must be untouched, zero refusals.
  fs.writeFileSync(path.join(cwd, 'a31ok.js'), `export const meta = { name: 'a31ok', description: 'd' };\nconst r = await parallel([() => agent('y'.repeat(500 * 1024), { label: 'a' }), () => agent('y'.repeat(500 * 1024), { label: 'b' })]);\nreturn r.map((x) => (typeof x === 'string' && x.startsWith('echo:') ? 'answered' : 'BAD'));\n`);
  const ok = (await wf(['run', 'a31ok.js', '--backend', 'echo', '--run-id', 'a31ok', '--yes'], cwd)).json;
  assert.equal(ok.status, 'completed', JSON.stringify(ok).slice(0, 200));
  assert.equal(ok.agentRejected, 0, JSON.stringify(ok.agentRejected));
  assert.deepEqual(ok.result, ['answered', 'answered'], JSON.stringify(ok.result));
});

await test('a script refused by the ban scan never has its meta evaluated (A30)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'a30.js'), `export const meta = { name: Function('return "sneaky"')(), description: 'd' };\nreturn 1;\n`);
  const r = await wf(['check', 'a30.js'], cwd);
  assert.notEqual(r.code, 0, 'check accepted a meta that compiles code from a string');
  assert.ok((r.json.diagnostics || []).some((d) => d.code === 'forbidden_host'), JSON.stringify(r.json.diagnostics));
  assert.equal(r.json.meta, null, 'meta was evaluated even though the script was refused');
  // Positive control: an ordinary computed literal in meta keeps working, defaults included.
  fs.writeFileSync(path.join(cwd, 'a30ok.js'), `export const meta = { name: 'ok-' + ['a', 'b'].join(''), description: 'd', args: { n: { type: 'number', default: 1 + 1 } } };\nreturn args.n;\n`);
  const ok = await wf(['check', 'a30ok.js'], cwd);
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json.diagnostics));
  assert.deepEqual(ok.json.diagnostics, [], JSON.stringify(ok.json.diagnostics));
  const run = (await wf(['run', 'a30ok.js', '--backend', 'echo', '--run-id', 'a30ok', '--yes'], cwd)).json;
  assert.equal(run.status, 'completed', JSON.stringify(run).slice(0, 200));
  assert.equal(run.result, 2, `meta.args default did not survive evaluation: ${JSON.stringify(run.result)}`);
});

await test('the default backend is the one --help says it is, and the env var is the fallback (D-1c)', async () => {
  // Every other case in this file passes --backend explicitly, which is how a default that spawns a
  // real qodercli per call ended up with zero coverage (the same blind spot A17's default deadline had).
  // This script never calls agent(), so asserting the default costs no subagent launch.
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'nocalls.js'), `export const meta = { name: 'nocalls', description: 'd' };\nreturn 'no dispatch';\n`);
  const envOf = (c) => ({ ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome'), ...c });
  const dflt = await wf(['run', 'nocalls.js', '--quiet', '--run-id', 'be-dflt'], cwd, { env: envOf({ QODER_WF_BACKEND: '' }) });
  assert.equal(dflt.code, 0, dflt.stdout + dflt.stderr);
  assert.equal(dflt.json.backend, 'cli', `the undocumented default is ${JSON.stringify(dflt.json.backend)}; --help now claims cli and saved.md names file explicitly`);
  assert.equal(dflt.json.status, 'completed', JSON.stringify(dflt.json));
  assert.equal(dflt.json.agentDispatched, 0, 'a zero-call script must not dispatch anything');
  const viaEnv = await wf(['run', 'nocalls.js', '--quiet', '--run-id', 'be-env'], cwd, { env: envOf({ QODER_WF_BACKEND: 'echo' }) });
  assert.equal(viaEnv.json.backend, 'echo', `QODER_WF_BACKEND was ignored: ${JSON.stringify(viaEnv.json)}`);
  const flagWins = await wf(['run', 'nocalls.js', '--backend', 'echo', '--quiet', '--run-id', 'be-flag'], cwd, { env: envOf({ QODER_WF_BACKEND: 'cli' }) });
  assert.equal(flagWins.json.backend, 'echo', '--backend must outrank QODER_WF_BACKEND');
  const help = await wf(['--help'], cwd);
  assert.match(help.stdout, /default cli/, '--help does not say which backend is the default');
  assert.match(help.stdout, /WF_PARK_TIMEOUT_MS/, '--help does not name the park-deadline knob the engine reads');
});

await test('parallel() accepts thunks spread as arguments, not only as one array (A33)', async () => {
  // The host side always accepted both forms (`parallel(jobs, ...rest)`), but the BRIDGE forwarded
  // only the first argument, so a varargs fan-out inside the sandbox silently ran ONE thunk and
  // settled `completed` -- a 3-angle review that returned 1 angle with no diagnostic anywhere.
  const r = await runEcho(`export const meta = { name: 'a33', description: 'd' };\n`,
    `const spread = await parallel(() => agent('AAA'), () => agent('BBB'), () => agent('CCC'));\n`
    + `const array = await parallel([() => agent('AAA'), () => agent('BBB'), () => agent('CCC')]);\n`
    + `const one = await parallel(() => agent('only'));\n`
    + `return { spread, array, one };`, 'a33-varargs');
  assert.equal(r.json.status, 'completed', r.check.stdout + r.stderr + JSON.stringify(r.json));
  const k = r.json.result;
  assert.deepEqual(k.spread, k.array, `varargs parallel() dropped thunks: ${JSON.stringify(k.spread)}`);
  assert.equal(k.spread.length, 3, `varargs parallel() settled with ${k.spread.length} of 3 answers`);
  assert.deepEqual(k.array, ['echo:AAA', 'echo:BBB', 'echo:CCC'], JSON.stringify(k.array));
  assert.deepEqual(k.one, ['echo:only'], 'the single-thunk form must keep working');
  assert.equal(r.json.agentCalls, 7, `dispatched ${r.json.agentCalls} calls for 3+3+1 requested (the bug dispatched 5)`);
});

await test('a run id cannot be started twice: an unlanded claim is taken over, a landed one is refused (R3B-07)', async () => {
  // Two lifecycles on one journal interleave calls, so `run` claims OWNER with O_EXCL before it
  // wipes anything. The two properties that make that safe are both pinned here, because neither is
  // obvious on Windows: a claim whose holder never lands it in state.json must NOT lock the id
  // forever (pids get recycled, and a killed engine cannot clean up after itself), and a claim that
  // did land must be refused by name.
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'own.js'), `export const meta = { name: 'own', description: 'd' };\nreturn 'claimed';\n`);
  const dir = path.join(cwd, '.qoder', 'workflow-runs', 'own1');
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  // Case 1: a live pid (this test process) holds a claim that will never land -> take over and run.
  fs.writeFileSync(path.join(dir, 'OWNER'), JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }));
  const t0 = Date.now();
  const took = await wf(['run', 'own.js', '--backend', 'echo', '--quiet', '--run-id', 'own1'], cwd);
  assert.equal(took.json?.status, 'completed', `a stale claim blocked the run id: ${took.stdout}${took.stderr}`);
  assert.ok(Date.now() - t0 >= 1500, `the takeover did not wait for the claim to land (${Date.now() - t0}ms) -- the check is vacuous`);
  assert.ok(Date.now() - t0 < 30000, `the takeover waited far too long (${Date.now() - t0}ms) for a claim that never lands`);
  // Case 2: the same pid has landed the claim in state.json as an in-flight run -> refuse, naming it.
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...st, status: 'running', pid: process.pid }));
  fs.writeFileSync(path.join(dir, 'OWNER'), JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }));
  const refused = await wf(['run', 'own.js', '--backend', 'echo', '--quiet', '--run-id', 'own1'], cwd);
  assert.equal(refused.code, 3, `a live owner was not refused (exit ${refused.code}): ${refused.stdout}`);
  // Either gate may win the race to notice, and both are correct: the liveness read on state.json or
  // the claim check. What must hold is that it refuses, by pid, and dispatches nothing.
  assert.match(refused.json.reason, /pid \d+/, JSON.stringify(refused.json));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...st, status: 'running', pid: st.pid }));
});

await test('a failed pending.json write is retried instead of being remembered as done (R3B-01)', async () => {
  // B2's dedup used to record the snapshot *before* the bytes landed, so a write that failed -- disk
  // full, or an AV product holding the file open, both real on this box -- was never retried and the
  // park the host never saw burned its semaphore slot for the whole deadline.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-r3b1-'));
  fs.mkdirSync(path.join(dir, 'pending.json'));
  const runDir = { dir, runId: 'r3b1', pending: new Map([['c1', { callId: 'c1', seq: 0, phase: 'A', label: 'l', prompt: 'p' }]]) };
  await assert.rejects(() => flushPendingIndex(runDir), /EISDIR|EPERM|EBUSY/);
  fs.rmSync(path.join(dir, 'pending.json'), { recursive: true, force: true });
  await flushPendingIndex(runDir);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8'));
  assert.equal(written.outstanding, 1, `the retry was swallowed by the memo: ${JSON.stringify(written)}`);
  assert.equal(written.items[0].callId, 'c1', JSON.stringify(written));
});

await test('a run settled by stop keeps the cached counts so later status reads stay cheap (R3B-03)', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'r3b3.js'), `export const meta = { name: 'r3b3', description: 'd' };\nreturn await parallel([() => agent('one'), () => agent('two')]);\n`);
  const runId = 'r3b3-stop';
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', runId);
  const child = spawn(NODE, [WF, 'run', 'r3b3.js', '--backend', 'file', '--run-id', runId, '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'home') }, stdio: 'ignore' });
  const items = await waitPending(runDir, 2);
  assert.equal(items.length, 2, 'nothing parked, so the stale-settle path was never reached');
  const dead = new Promise((r) => child.on('exit', r));
  child.kill();
  await dead;
  const stopped = await wf(['stop', runId], cwd);
  assert.equal(stopped.json.settled, true, `stop did not settle the dead run: ${JSON.stringify(stopped.json)}`);
  const after = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  assert.equal(after.status, 'cancelled', JSON.stringify(after));
  assert.ok(Number.isInteger(after.agentDispatched), `a stop-settled run has no cached summary: ${JSON.stringify(after)}`);
  assert.equal(after.agentDispatched, 2, JSON.stringify(after));
  // The discriminating half: blank the journal, and status must still report the counts from state.json.
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), '');
  const row = (await wf(['status', runId], cwd)).json.runs[0];
  assert.equal(row.agentDispatched, 2, `status re-parsed an emptied journal instead of the cache: ${JSON.stringify(row)}`);
  assert.equal(row.status, 'cancelled', JSON.stringify(row));
});

// --- wf.mjs ui: the read-only live dashboard ------------------------------------------------
// Starts the server on --port 0 (ephemeral; the fixed default 4230 is for the human's long-lived
// instance, tests must never fight over it) and reads the port back from the startup JSON line.
async function startUi(cwd) {
  const child = spawn(NODE, [WF, 'ui', '--port', '0', '--cwd', cwd], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50; i++) {
    const start = out.indexOf('{');
    if (start >= 0) {
      try {
        const j = JSON.parse(out.slice(start));
        if (j.ok && j.port) return { child, base: `http://127.0.0.1:${j.port}` };
      } catch {}
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`ui never reported its port: ${out || '(no stdout)'}`);
}

await test('ui serves the run list, a run detail and the page over HTTP', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'u.js'), `export const meta = { name: 'u', description: 'd' };
phase('One');
const a = await parallel([() => agent('first', { label: 'A1' }), () => agent('second', { label: 'A2' })]);
phase('Two');
return await agent('merge ' + a.length, { label: 'M' });
`);
  const ran = await wf(['run', 'u.js', '--backend', 'echo', '--run-id', 'ui1'], cwd);
  assert.equal(ran.code, 0, ran.stderr);
  const { child, base } = await startUi(cwd);
  try {
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.ok(list.ok, JSON.stringify(list).slice(0, 200));
    assert.equal(list.engine, ENGINE_VERSION, 'the dashboard must say which engine version is talking');
    assert.equal(list.runs[0].runId, 'ui1');
    assert.ok(list.runs[0].startedAt, 'list rows carry startedAt, or the dashboard cannot show times');
    const detail = await (await fetch(`${base}/api/run/ui1`)).json();
    assert.ok(detail.ok);
    assert.deepEqual(detail.phases.map((p) => p.name), ['One', 'Two']);
    assert.deepEqual(detail.phases.map((p) => p.settled), [2, 1], `per-phase counts came out wrong: ${JSON.stringify(detail.phases)}`);
    assert.equal(detail.calls.length, 3);
    assert.ok(detail.calls.every((c) => c.state === 'done'), JSON.stringify(detail.calls.map((c) => c.state)));
    assert.equal(detail.settled.status, 'completed');
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /动态工作流/);
    assert.match(page, new RegExp(ENGINE_VERSION), 'the page embeds the engine version badge');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    // A path-shaped id must not resolve to anything on disk.
    assert.equal((await fetch(`${base}/api/run/..%2F..`)).status, 404);
    assert.equal((await fetch(`${base}/api/run/%2E%2E`, { method: 'POST' })).status, 405, 'the dashboard is read-only');
  } finally {
    child.kill();
    await new Promise((r) => child.on('exit', r));
  }
});

await test('a parked file-backend run shows waiting cards and steer notes in the detail', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'p.js'), `export const meta = { name: 'p', description: 'd' };
phase('Park');
const a = await parallel([() => agent('park one', { label: 'P1' }), () => agent('park two', { label: 'P2' })]);
phase('Done');
return a.length;
`);
  const runId = 'ui2';
  const runDir = path.join(cwd, '.qoder', 'workflow-runs', runId);
  const child = spawn(NODE, [WF, 'run', 'p.js', '--backend', 'file', '--run-id', runId, '--quiet'], { cwd, env: { ...process.env, QODER_WF_HOME: path.join(cwd, 'fakehome') }, stdio: 'ignore' });
  const items = await waitPending(runDir, 2);
  const { child: ui, base } = await startUi(cwd);
  try {
    const parked = await (await fetch(`${base}/api/run/${runId}`)).json();
    assert.ok(parked.ok);
    assert.equal(parked.status, 'running');
    assert.equal(parked.currentPhase, 'Park');
    assert.ok(parked.calls.every((c) => c.state === 'parked'), JSON.stringify(parked.calls.map((c) => c.state)));
    // One answered call flips exactly that card to done while its sibling stays parked.
    fs.writeFileSync(path.join(runDir, 'inbox', items[0].callId + '.json'), JSON.stringify({ ok: true, text: 'ans' }));
    let half = null;
    for (let i = 0; i < 100 && !half; i++) {
      await sleep(100);
      const d = await (await fetch(`${base}/api/run/${runId}`)).json();
      if (d.calls.some((c) => c.state === 'done') && d.calls.some((c) => c.state === 'parked')) half = d;
    }
    assert.ok(half, 'a half-answered run never showed a done card beside a parked one');
    // A queued steer note is visible before the script reads it.
    await wf(['steer', runId, 'keep it short'], cwd);
    const steered = await (await fetch(`${base}/api/run/${runId}`)).json();
    assert.equal(steered.steer.length, 1, JSON.stringify(steered.steer));
    assert.match(steered.steer[0].text, /keep it short/);
  } finally {
    ui.kill();
    child.kill();
    await Promise.all([new Promise((r) => ui.on('exit', r)), new Promise((r) => child.on('exit', r))]);
  }
});


// ---- v2 (0.8.0): logs / ask / publish (SPEC §1.5) ----
await test('log() lines land in progress.json logs', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'v2log.js'), `export const meta = { name: 'v2log', description: 'd' };
log('第一条');
log('第二条');
return await agent('ok');`);
  const r = await hostLifecycle(cwd, path.join(cwd, 'v2log.js'), 'v2log', () => ({ ok: true, text: 'done' }));
  assert.equal(r.out.status, 'completed');
  const prog = readJson(path.join(r.runDir, 'progress.json'));
  assert.deepEqual(prog.logs.map((l) => l.text), ['第一条', '第二条']);
  assert.ok(prog.logs[0].ts);
});

await test('ask() round-trips through pending.json + inbox and records the question state', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'v2ask.js'), `export const meta = { name: 'v2ask', description: 'd' };
const answer = await ask('请确认发布');
return { got: answer };`);
  const r = await hostLifecycle(cwd, path.join(cwd, 'v2ask.js'), 'v2ask', (item) => {
    assert.equal(item.kind, 'question', 'pending item must be marked kind:question');
    return { ok: true, text: '确认发布' };
  });
  assert.equal(r.out.status, 'completed');
  assert.equal(r.out.result.got, '确认发布');
  const prog = readJson(path.join(r.runDir, 'progress.json'));
  assert.equal(prog.questions.length, 1);
  assert.equal(prog.questions[0].state, 'answered');
  assert.equal(prog.questions[0].answerPreview, '确认发布');
});

await test('ask() replays the recorded answer on resume instead of re-parking', async () => {
  const cwd = tmpWorkspace();
  fs.writeFileSync(path.join(cwd, 'v2askr.js'), `export const meta = { name: 'v2askr', description: 'd' };
const a = await ask('一次就够');
return await agent('after ask');`);
  const r1 = await hostLifecycle(cwd, path.join(cwd, 'v2askr.js'), 'v2askr', () => ({ ok: true, text: 'first' }));
  assert.equal(r1.out.status, 'completed');
  const r2 = await hostLifecycle(cwd, path.join(cwd, 'v2askr.js'), 'v2askr', (item) => {
    if (item.kind === 'question') throw new Error('question re-parked on resume: replay failed');
    return { ok: true, text: 'agent again' };
  }, true);
  assert.equal(r2.out.status, 'completed');
  const journal = fs.readFileSync(path.join(r2.runDir, 'journal.jsonl'), 'utf8');
  assert.ok(journal.includes('"type":"ask_replay"'), 'journal must record the ask replay');
});

await test('ask() on a non-file backend throws a clear error', async () => {
  const out = await runExpr(`(async () => { try { await ask('no host here'); return 'no-throw'; } catch (e) { return 'MSG:' + e.message; } })()`, 'v2askerr');
  assert.match(String((out.json && out.json.result) || ''), /仅 --backend file 可用/);
});

await test('publish() registers artifacts and the newest primary wins', async () => {
  const out = await runExpr(`(async () => {
  publish({ title: '草案', kind: 'document', text: 'v1', primary: true });
  publish({ title: '终稿报告', kind: 'file', path: 'G:/tmp/report.md', primary: true });
  publish({ title: '看板', kind: 'dashboard', url: 'https://example.invalid/b' });
  return 'ok';
})()`, 'v2pub');
  assert.equal(out.json.status, 'completed');
  const prog = readJson(path.join(out.json.dir, 'progress.json'));
  assert.equal(prog.artifacts.length, 3);
  assert.equal(prog.artifacts.filter((a) => a.primary).length, 1);
  assert.equal(prog.artifacts.find((a) => a.primary).title, '终稿报告');
  assert.equal(prog.artifacts[2].kind, 'dashboard');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);fs.writeFileSync(path.join(os.tmpdir(), 'wf-test-results.json'), JSON.stringify({ pass, fail, results }, null, 2));
process.exit(fail ? 1 : 0);
