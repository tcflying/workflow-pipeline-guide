import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { sameStateIdentity } from '../run-lifecycle.mjs';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!vm.SourceTextModule) {
  test('mutation boundaries run in a native VM-module child', () => {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
const boundaryTest = vm.SourceTextModule ? test : () => {};
const S1 = '2026-09-29T00:00:00.000Z';
const S2 = '2026-09-29T00:00:00.100Z';
const sources = [
  { name: 'MMX', host: new URL('../sidecar.mjs', import.meta.url), helper: new URL('../run-lifecycle.mjs', import.meta.url) },
  { name: 'DSH', host: new URL('../../dsh-workflow-pipeline/index.mjs', import.meta.url), helper: new URL('../../dsh-workflow-pipeline/run-lifecycle.mjs', import.meta.url) },
];
function tree(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-boundary-'));
  const dir = join(root, '.qoder', 'workflow-runs', 'boundary');
  mkdirSync(dir, { recursive: true });
  const state = { runId: 'boundary', cwd: root, pid: 987654, status: 'running', startedAt: S1, scriptPath: join(root, 'missing-script.mjs') };
  const progress = { runId: 'boundary', cwd: root, status: 'running', startedAt: S1, questions: [{ qId: 'q1', state: 'waiting' }], calls: [] };
  const save = (name, value) => writeFileSync(join(dir, name + '.json'), JSON.stringify(value));
  save('state', state); save('progress', progress);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, dir, state, progress, save };
}
async function load(url, overrides = {}, customProcess = process) {
  const context = vm.createContext({ process: customProcess, console, URL, URLSearchParams, Buffer, fetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval });
  const mod = new vm.SourceTextModule(readFileSync(url, 'utf8'), { context, initializeImportMeta: (meta) => { meta.url = url.href; } });
  await mod.link(async (specifier) => {
    const values = overrides[specifier] || await import(specifier.startsWith('node:') ? specifier : new URL(specifier, url).href);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await mod.evaluate();
  return mod.namespace;
}
for (const source of sources) {
  for (const action of ['stop', 'answer']) {
    for (const change of ['progress epoch', 'state epoch only', 'state terminal', 'question answered']) {
      if (action === 'stop' && change === 'question answered') continue;
      boundaryTest(`${source.name}: ${action} rechecks ${change} after identity await`, async (t) => {
        const f = tree(t);
        let armed = false, observed = false;
        const lifecycle = {
          sameStateIdentity,
          processIdentity: async () => {
            if (armed) {
              observed = true;
              if (change === 'progress epoch') f.save('progress', { ...f.progress, startedAt: S2 });
              if (change === 'state epoch only') f.save('state', { ...f.state, startedAt: S2 });
              if (change === 'state terminal') f.save('state', { ...f.state, status: 'completed' });
              if (change === 'question answered') f.save('progress', { ...f.progress, questions: [{ qId: 'q1', state: 'answered' }] });
            }
            return { alive: true, reused: false, verified: true };
          },
          resumeRun: async () => { throw new Error('UNEXPECTED_RESUME'); },
        };
        const host = await load(source.host, { './run-lifecycle.mjs': lifecycle });
        let server, capability;
        if (source.name === 'MMX') { const api = host.createHostApi({ roots: [f.root], quiet: true }); server = api.server; capability = api.capability; }
        else { let handler; host.apply({ effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; } } }, { roots: [f.root] }); server = createServer(handler); }
        await new Promise((done) => server.listen(0, '127.0.0.1', done));
        t.after(() => new Promise((done) => server.close(done)));
        const base = 'http://127.0.0.1:' + server.address().port;
        const headers = capability ? { 'x-workflow-capability': capability } : {};
        const body = await (await fetch(base + '/runs', { headers })).json();
        armed = true;
        const response = await fetch(base + '/' + action + '?' + new URLSearchParams({ run: body.runs[0].runKey, startedAt: S1, q: 'q1' }), { method: 'POST', headers, ...(action === 'answer' ? { body: JSON.stringify({ answer: 'boundary' }) } : {}) });
        assert.ok(observed, 'mutation must occur inside the awaited identity lookup');
        assert.equal(response.status, 409, await response.text());
        assert.equal(existsSync(join(f.dir, 'CANCEL')), false);
        assert.equal(existsSync(join(f.dir, 'inbox', 'q1.json')), false);
      });
    }
  }
  for (const change of ['state epoch only', 'both epochs']) {
    boundaryTest(`${source.name}: resume guards ${change} independently after the final identity lookup`, async (t) => {
      const f = tree(t);
      f.state.status = 'failed'; f.progress.status = 'failed';
      f.save('state', f.state); f.save('progress', f.progress);
      let queries = 0;
      const execFile = () => {};
      execFile[promisify.custom] = async () => {
        queries++;
        f.save('state', { ...f.state, startedAt: S2 });
        if (change === 'both epochs') f.save('progress', { ...f.progress, startedAt: S2 });
        return { stdout: JSON.stringify([{ pid: f.state.pid, start: '2026-09-28T23:00:00.000Z' }]), stderr: '' };
      };
      const customProcess = { ...process, platform: 'win32', kill: () => true };
      const helper = await load(source.helper, { 'node:child_process': { execFile, spawn: () => { throw new Error('UNEXPECTED_SPAWN'); } } }, customProcess);
      const result = await helper.resumeRun(f.dir, 'boundary', f.state, 'UNUSED_ENGINE', S1);
      assert.ok(queries > 0);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'STALE_LIFECYCLE', JSON.stringify(result.body));
      assert.equal(existsSync(join(f.dir, 'pipeline-resume.log')), false);
    });
  }
}
