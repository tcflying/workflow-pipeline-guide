import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const vmEnabled = typeof vm.SourceTextModule === 'function';
if (!vmEnabled) {
  test('launcher tests run in an isolated native VM-module process', () => {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /(?:pass 16|# pass 16)/);
  });
}
const launchTest = vmEnabled ? test : () => {};
const policyURL = new URL('../launch-policy.mjs', import.meta.url);
const policy = await import(policyURL.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const exe = resolve('test-owned-app.exe');

function childFixture() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 43210, exitCode: null, signalCode: null, unref() {}, killedByTest: false,
    kill() { this.killedByTest = true; this.exitCode = 0; this.emit('exit', 0, null); return true; } });
  return child;
}
function launchDependencies(child, overrides = {}) {
  return { inspectInstances: async () => [], inspectProcess: async () => ({ pid: child.pid, executablePath: exe, createdAt: '2026-09-29T00:00:00.000Z' }),
    spawnProcess: () => { queueMicrotask(() => child.emit('spawn')); return child; }, waitForCdp: async () => true, ...overrides };
}

launchTest('CLI rejects ignored and malformed arguments instead of silently falling back', () => {
  for (const argv of [['--unknown'], ['--api-port', 'abc'], ['--api-port', '0'], ['--api-port', '65536'], ['--root'], ['--root='], ['--launch', '--no-launch']]) {
    assert.throws(() => policy.parseLaunchArgs(argv), /unknown|invalid|requires|conflict/i);
  }
});
launchTest('sidecar exported parser enforces no-launch and invalid port rejection', async () => {
  const sidecar = await import('../sidecar.mjs');
  assert.equal(sidecar.parseArgs(['--no-launch']).noLaunch, true);
  assert.throws(() => sidecar.parseArgs(['--api-port', 'invalid']), /Invalid/);
});
launchTest('CLI supports no-launch and preserves explicit test-port overrides', () => {
  const args = policy.parseLaunchArgs(['--no-launch', '--root', 'one', '--root=two', '--api-port', '51234']);
  assert.deepEqual(args.roots, ['one', 'two']);
  assert.equal(args.noLaunch, true);
  assert.equal(args.apiPort, 51234);
  assert.equal(args.cdpPort, 9331);
  assert.equal(policy.parseLaunchArgs([]).apiPort, 4231);
});
launchTest('an existing application without CDP is never killed or replaced', async () => {
  const child = childFixture();
  await assert.rejects(() => policy.launchOwnedApplication({ exe }, launchDependencies(child, {
    inspectInstances: async () => [{ pid: 111, executablePath: exe }],
    spawnProcess: () => { throw new Error('UNEXPECTED_SPAWN'); },
  })), /EXISTING_INSTANCE_NO_CDP/);
  assert.equal(child.killedByTest, false);
});
launchTest('ownership can stop only the same process created by this launcher', async () => {
  const child = childFixture();
  const app = await policy.launchOwnedApplication({ exe }, launchDependencies(child));
  await app.waitReady();
  assert.equal((await app.stop()).stopped, true);
  assert.equal(child.killedByTest, true);
  assert.equal((await app.stop()).stopped, false);
});
launchTest('reused PID refuses shutdown even when executable matches', async () => {
  const child = childFixture();
  let reused = false;
  const app = await policy.launchOwnedApplication({ exe }, launchDependencies(child, {
    inspectProcess: async () => ({ pid: child.pid, executablePath: exe, createdAt: reused ? '2026-09-29T00:01:00.000Z' : '2026-09-29T00:00:00.000Z' }),
  }));
  reused = true;
  await assert.rejects(() => app.stop(), /PROCESS_IDENTITY_CHANGED/);
  assert.equal(child.killedByTest, false);
});
launchTest('unknown process identity fails closed without killing the launched application', async () => {
  const child = childFixture();
  const app = await policy.launchOwnedApplication({ exe }, launchDependencies(child, { inspectProcess: async () => null }));
  await assert.rejects(() => app.stop(), /UNVERIFIED_PROCESS_OWNERSHIP/);
  assert.equal(child.killedByTest, false);
});
launchTest('spawn errors reject normally rather than emitting an uncaught error', async () => {
  const child = childFixture();
  await assert.rejects(() => policy.launchOwnedApplication({ exe }, launchDependencies(child, {
    spawnProcess: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; },
  })), /ENOENT/);
});
launchTest('real OS identity lookup confirms and stops only an isolated launcher-owned child', async (t) => {
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once('exit', done)); child.kill(); await exited;
    }
  });
  const app = await policy.launchOwnedApplication({ exe: process.execPath }, {
    inspectInstances: async () => [],
    spawnProcess: () => child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }),
    waitForCdp: async () => true,
  });
  assert.equal(app.pid, child.pid);
  const result = await app.stop();
  assert.equal(result.stopped, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the owned child confirmed exit by code or signal');
});
launchTest('sidecar no-launch fails closed with no application or injector side effects', async () => {
  const sidecar = await import('../sidecar.mjs');
  let closed = false;
  await assert.rejects(() => sidecar.main(['--no-launch'], {
    createHostApi: () => ({ start: async () => {}, close: async () => { closed = true; }, roots: [] }),
    isCdpUp: async () => false,
    launchMiniMaxCode: () => { throw new Error('UNEXPECTED_LAUNCH'); },
    startCdpInjector: () => { throw new Error('UNEXPECTED_INJECTOR'); },
    process: new EventEmitter(),
  }), /CDP_UNAVAILABLE/);
  assert.equal(closed, true);
});
launchTest('sidecar shutdown never calls a reused application stop path', async () => {
  const sidecar = await import('../sidecar.mjs');
  const emitter = new EventEmitter();
  let closed = false;
  const result = await sidecar.main(['--launch', '--kill-on-exit'], {
    createHostApi: () => ({ start: async () => {}, close: async () => { closed = true; }, roots: [], capability: 'test-only' }),
    isCdpUp: async () => true,
    launchMiniMaxCode: () => { throw new Error('UNEXPECTED_LAUNCH'); },
    startCdpInjector: () => ({ stop: async () => {}, target: 'fixture' }),
    process: emitter,
  });
  assert.equal(result.launched, null);
  await result.shutdown();
  assert.equal(closed, true);
  assert.equal(emitter.listenerCount('SIGINT'), 0);
});
launchTest('CDP wait failure leaves the application untouched', async () => {
  const child = childFixture();
  const app = await policy.launchOwnedApplication({ exe }, launchDependencies(child, { waitForCdp: async () => { throw new Error('CDP_NOT_READY'); } }));
  await assert.rejects(() => app.waitReady(), /CDP_NOT_READY/);
  assert.equal(child.killedByTest, false);
});
launchTest('importing launchers has no launch, process exit, or listener side effects', async () => {
  for (const name of ['../launch-mmcode.mjs', '../docs/launch-cdp.mjs']) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8');
  const calls = [];
  const context = vm.createContext({ fetch: async () => ({ ok: true, json: async () => ({}) }), console: { log() {}, error() {} }, process: { env: {}, versions: { node: '24.18.0' }, argv: ['node', 'unrelated.mjs'], on: () => calls.push('signal'), exit: () => calls.push('exit') } });
  const exports = { parseArgs: () => ({}), createHostApi: () => { calls.push('API'); return { start: async () => {}, roots: [] }; },
    startCdpInjector: () => ({}), launchMiniMaxCode: () => { calls.push('launch'); return { waitReady: async () => {} }; },
    waitForCdp: async () => {}, isCdpUp: async () => true, CDP_PORT: 9331, API_PORT: 4231, EXE: exe, requireNode22: () => {},
    sleep: async () => {}, setTimeout: async () => {}, pathToFileURL, fileURLToPath, resolve,
    execFileSync: () => { calls.push('process-kill'); return ''; }, spawn: () => { calls.push('spawn'); return { unref() {} }; } };
  const module = new vm.SourceTextModule(source, { context, initializeImportMeta: (meta) => { meta.url = new URL(name, import.meta.url).href; } });
  await module.link(async () => new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context }));
  await module.evaluate();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, []);
  }
});

async function loadLauncher() {
  const source = readFileSync(new URL('../launch-mmcode.mjs', import.meta.url), 'utf8');
  const emitter = new EventEmitter();
  Object.assign(emitter, { versions: { node: '24.18.0' }, argv: ['node', 'unrelated.mjs'], exit() {} });
  const context = vm.createContext({ console: { log() {}, error() {} }, process: emitter });
  const defaults = { parseArgs: (args) => policy.parseLaunchArgs(args), createHostApi: () => { throw new Error('UNEXPECTED_API'); },
    startCdpInjector: () => { throw new Error('UNEXPECTED_INJECTION'); }, launchMiniMaxCode: () => { throw new Error('UNEXPECTED_LAUNCH'); },
    waitForCdp: async () => {}, isCdpUp: async () => false, CDP_PORT: 9331, API_PORT: 4231, EXE: exe, requireNode22: () => {},
    sleep: async () => {}, setTimeout: async () => {}, pathToFileURL, fileURLToPath, resolve };
  const module = new vm.SourceTextModule(source, { context, initializeImportMeta: (meta) => { meta.url = new URL('../launch-mmcode.mjs', import.meta.url).href; } });
  await module.link(async () => new vm.SyntheticModule(Object.keys(defaults), function () { for (const [key, value] of Object.entries(defaults)) this.setExport(key, value); }, { context }));
  await module.evaluate();
  return module.namespace;
}

launchTest('no-launch with unavailable CDP closes its API and never spawns', async () => {
  let closed = false, spawned = false;
  const module = await loadLauncher();
  await assert.rejects(() => module.main(['--no-launch'], {
    createHostApi: () => ({ start: async () => {}, close: async () => { closed = true; }, roots: [], capability: 'test-only' }),
    isCdpUp: async () => false,
    launchMiniMaxCode: async () => { spawned = true; throw new Error('UNEXPECTED_SPAWN'); },
    process: new EventEmitter(), log: () => {}, sleep: async () => {},
  }), /CDP_UNAVAILABLE/);
  assert.equal(spawned, false);
  assert.equal(closed, true);
});
launchTest('API port conflict aborts before any application launch', async () => {
  const module = await loadLauncher();
  let spawned = false;
  await assert.rejects(() => module.main([], {
    createHostApi: () => ({ start: async () => { throw new Error('EADDRINUSE'); }, close: async () => {}, roots: [] }),
    launchMiniMaxCode: async () => { spawned = true; }, process: new EventEmitter(), log: () => {}, sleep: async () => {},
  }), /EADDRINUSE/);
  assert.equal(spawned, false);
});
launchTest('launcher passes capability privately and removes its signal handlers on shutdown', async () => {
  const module = await loadLauncher();
  const emitter = new EventEmitter();
  let closed = false, stopped = false, injection;
  const result = await module.main(['--no-launch', '--kill-on-exit'], {
    createHostApi: () => ({ start: async () => {}, close: async () => { closed = true; }, roots: [], capability: 'unit-capability' }),
    isCdpUp: async () => true,
    startCdpInjector: (args) => { injection = args; return { target: 'fixture', stop: async () => { stopped = true; } }; },
    launchMiniMaxCode: () => { throw new Error('UNEXPECTED_SPAWN'); }, process: emitter, log: () => {}, sleep: async () => {},
  });
  assert.equal(injection.capability, 'unit-capability');
  assert.equal(emitter.listenerCount('SIGINT'), 1);
  await result.shutdown();
  assert.equal(emitter.listenerCount('SIGINT'), 0);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
  assert.equal(closed, true);
  assert.equal(stopped, true);
});
