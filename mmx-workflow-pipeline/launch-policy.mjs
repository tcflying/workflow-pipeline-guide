import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';

const exec = promisify(execFile);
const canonical = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

export function parseLaunchArgs(argv) {
  const out = { launch: false, noLaunch: false, roots: [], killOnExit: false, apiPort: 4231, cdpPort: 9331 };
  const valueAfter = (index, flag) => {
    const value = argv[index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--launch') out.launch = true;
    else if (arg === '--no-launch') out.noLaunch = true;
    else if (arg === '--kill-on-exit') out.killOnExit = true;
    else if (arg === '--root') out.roots.push(valueAfter(++i, arg));
    else if (arg.startsWith('--root=')) {
      if (!arg.slice(7).trim()) throw new Error('--root requires a value.');
      out.roots.push(arg.slice(7));
    } else if (arg === '--api-port') {
      const value = valueAfter(++i, arg);
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid --api-port: expected an integer from 1 to 65535.');
      out.apiPort = Number(value);
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('Unknown launcher argument: ' + arg);
  }
  if (out.launch && out.noLaunch) throw new Error('Conflicting --launch and --no-launch arguments.');
  return out;
}

async function inspectWindows(filter) {
  if (process.platform !== 'win32') throw new Error('PROCESS_INSPECTION_UNSUPPORTED: this MiniMax Code launcher requires Windows.');
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process -Filter '${filter.replace(/'/g, "''")}' -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId; executablePath=$_.ExecutablePath; createdAt=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null})} }) | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 7000, maxBuffer: 1024 * 1024 });
  const rows = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(rows) ? rows : [rows];
}
async function inspectInstances(exe) {
  const name = basename(exe).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return inspectWindows(`Name = '${name}'`);
}
async function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return (await inspectWindows(`ProcessId = ${pid}`))[0] || null;
}
function sameIdentity(actual, expected, exe) {
  return !!(actual && expected && actual.createdAt && expected.createdAt && actual.executablePath && expected.executablePath &&
    Number(actual.pid) === Number(expected.pid) && actual.createdAt === expected.createdAt &&
    canonical(actual.executablePath) === canonical(exe) && canonical(expected.executablePath) === canonical(exe));
}

export async function launchOwnedApplication({ exe, port = 9331, waitMs = 90000 } = {}, operations = {}) {
  if (!exe) throw new Error('Application executable is required.');
  const inspect = operations.inspectProcess || inspectProcess;
  const existing = await (operations.inspectInstances || inspectInstances)(exe);
  if (existing.length) throw new Error('EXISTING_INSTANCE_NO_CDP: MiniMax Code is already running without a usable debugging endpoint. The existing application was not closed or replaced.');
  const child = (operations.spawnProcess || spawn)(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', env: process.env });
  let exited = false, spawnError;
  child.on('exit', () => { exited = true; });
  child.on('error', (error) => { spawnError = error; });
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  let identity;
  try { identity = await inspect(child.pid); } catch { identity = null; }
  child.unref();
  let stopping;
  return {
    pid: child.pid,
    async waitReady() {
      if (spawnError) throw spawnError;
      if (exited || child.exitCode !== null || child.signalCode !== null) throw new Error('LAUNCHED_PROCESS_EXITED: the application exited before CDP became ready.');
      if (typeof operations.waitForCdp !== 'function') throw new Error('A CDP readiness check is required.');
      const ready = await operations.waitForCdp(port, waitMs);
      if (exited || spawnError) throw spawnError || new Error('LAUNCHED_PROCESS_EXITED: the application exited during startup.');
      return ready;
    },
    async stop() {
      if (stopping) return stopping;
      if (exited || child.exitCode !== null || child.signalCode !== null) return { stopped: false, reason: 'already-exited' };
      if (!sameIdentity(identity, identity, exe)) throw new Error('UNVERIFIED_PROCESS_OWNERSHIP: the application was left running.');
      stopping = (async () => {
        const current = await inspect(child.pid);
        if (exited || child.exitCode !== null || child.signalCode !== null) return { stopped: false, reason: 'already-exited' };
        if (!sameIdentity(current, identity, exe)) throw new Error('PROCESS_IDENTITY_CHANGED: refusing to stop a different or unverified process.');
        // ChildProcess retains the handle of the process we created; no image-name or process-tree kill is used.
        await new Promise((done, fail) => {
          let timer;
          const finish = (error) => { clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError); error ? fail(error) : done(); };
          const onExit = () => finish();
          const onError = (error) => finish(error);
          child.once('exit', onExit); child.once('error', onError);
          timer = setTimeout(() => finish(new Error('OWNED_PROCESS_STOP_UNCONFIRMED: the application has not confirmed exit.')), 5000);
          try { if (!child.kill()) finish(new Error('OWNED_PROCESS_STOP_REFUSED')); } catch (error) { finish(error); }
        });
        return { stopped: true };
      })().finally(() => { stopping = null; });
      return stopping;
    },
  };
}
