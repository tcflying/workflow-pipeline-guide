import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const engine = fileURLToPath(new URL('../skills/dynamic-workflow/runtime/wf.mjs', import.meta.url));
const origin = (host, sessionId) => ({ host, sessionId, source: host === 'dsh' ? 'native-shell' : 'native-hook' });
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'wf-session-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = join(cwd, 'task.mjs');
  writeFileSync(script, 'export const meta={name:"session-test",description:"local fixture"};\nreturn "ok";\n');
  const env = { ...process.env, QODER_WF_HOME: join(cwd, 'fakehome') };
  delete env.DSH_SESSION_ID;
  async function call(args, extra = {}) {
    try { const r = await exec(process.execPath, [engine, ...args, '--cwd', cwd, ...(['run', 'resume'].includes(args[0]) ? ['--backend', 'echo', '--quiet'] : [])], { cwd, env: { ...env, ...extra }, timeout: 10000 }); return { code: 0, ...r }; }
    catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  }
  const read = (id, name) => JSON.parse(readFileSync(join(cwd, '.qoder/workflow-runs', id, name + '.json'), 'utf8'));
  return { cwd, script, call, read };
}
for (const host of ['dsh', 'mmx']) {
  test(host + ': exact native attribution is carried through state, progress, output and status', async (t) => {
    const f = fixture(t), expected = origin(host, 'sess-A');
    const args = ['run', f.script, '--run-id', 'one'];
    if (host === 'mmx') args.push('--host-session', encoded(expected));
    const r = await f.call(args, host === 'dsh' ? { DSH_SESSION_ID: 'sess-A' } : {});
    assert.equal(r.code, 0, r.stderr);
    for (const name of ['state', 'progress', 'out']) assert.deepEqual(f.read('one', name).hostSession, expected);
    const status = await f.call(['status', 'one']);
    assert.match(status.stdout, /sess-A/);
    const events = readFileSync(join(f.cwd, '.qoder/workflow-runs/one/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.find(e => e.type === 'run_started').hostSession, expected);
  });
}
test('native sessions in the same workspace remain distinct under concurrent starts', async (t) => {
  const f = fixture(t);
  const results = await Promise.all(['A', 'B'].map(id => f.call(['run', f.script, '--run-id', id], { DSH_SESSION_ID: 'session-' + id })));
  assert.ok(results.every(r => r.code === 0));
  assert.equal(f.read('A', 'progress').hostSession.sessionId, 'session-A');
  assert.equal(f.read('B', 'progress').hostSession.sessionId, 'session-B');
});
test('a standalone run has no inferred native origin', async (t) => {
  const f = fixture(t); const r = await f.call(['run', f.script, '--run-id', 'plain']);
  assert.equal(r.code, 0); assert.equal(f.read('plain', 'progress').hostSession, null);
});
for (const [label, extra, flag] of [
  ['invalid native id', { DSH_SESSION_ID: 'bad\nvalue' }, null],
  ['malformed flag', {}, 'not-json'],
  ['wrong source', {}, encoded({ host: 'mmx', sessionId: 's1', source: 'guess' })],
  ['conflicting hosts', { DSH_SESSION_ID: 'dsh-session' }, encoded(origin('mmx', 'mmx-session'))],
]) {
  test(label + ' fails before creating a run directory or inline draft', async (t) => {
    const f = fixture(t);
    const r = await f.call(['run', '--script', 'export const meta={name:"inline",description:"fixture"};return 1;', '--run-id', 'invalid', ...(flag ? ['--host-session', flag] : [])], extra);
    assert.notEqual(r.code, 0);
    assert.equal(existsSync(join(f.cwd, '.qoder')), false);
  });
}
for (const original of [null, origin('dsh', 'original-session')]) {
  test('resume preserves ' + (original ? 'original attribution' : 'legacy unbound origin') + ' despite another caller', async (t) => {
    const f = fixture(t);
    writeFileSync(f.script, 'export const meta={name:"session-test",description:"local fixture"};throw new Error("fixture failure");');
    assert.notEqual((await f.call(['run', f.script, '--run-id', 'resume'], original ? { DSH_SESSION_ID: original.sessionId } : {})).code, 0);
    writeFileSync(f.script, 'export const meta={name:"session-test",description:"local fixture"};return "resumed";');
    const r = await f.call(['resume', 'resume'], { DSH_SESSION_ID: 'other-session' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(f.read('resume', 'state').hostSession, original);
    assert.deepEqual(f.read('resume', 'progress').hostSession, original);
  });
}
