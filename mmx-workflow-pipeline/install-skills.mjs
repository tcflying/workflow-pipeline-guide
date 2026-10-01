#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, realpathSync, mkdtempSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'plugins', 'dynamic-workflow', 'skills', 'dynamic-workflow');
const DST = 'C:/Users/datoo/.minimax/skills/dynamic-workflow';
const EXPECTED_ENGINE = '0.8.1';

export function readEngineVersion(wfPath) {
  const match = readFileSync(wfPath, 'utf8').match(/ENGINE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}
function manifest(directory) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not accepted in a skill installation: ' + path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(directory, path).replace(/\\/g, '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      else throw new Error('Unsupported installation entry: ' + path);
    }
  };
  walk(directory);
  return files;
}
function assertSkill(directory) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Unrecognized installation directory: ' + directory);
  const skill = join(directory, 'SKILL.md'), engine = join(directory, 'runtime', 'wf.mjs');
  if (!existsSync(skill) || !existsSync(engine) || !/^name:\s*['"]?dynamic-workflow['"]?\s*$/m.test(readFileSync(skill, 'utf8')) || !readEngineVersion(engine)) {
    throw new Error('Unrecognized or unrelated skill at ' + directory + '; it will not be replaced.');
  }
}
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))); };

export function canonicalDestinationPath(destination) {
  const dst = resolve(destination);
  return join(realpathSync(dirname(dst)), basename(dst));
}

function acquireInstallLock(lockPath) {
  try { return openSync(lockPath, 'wx'); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    let owner = 'Owner metadata unavailable.';
    try {
      const stat = lstatSync(lockPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
        const value = JSON.parse(readFileSync(lockPath, 'utf8'));
        const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : 'unknown';
        const startedAt = typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? new Date(value.startedAt).toISOString() : 'unknown';
        owner = `Recorded owner PID ${pid}, created ${startedAt}.`;
      }
    } catch {}
    throw Object.assign(new Error(`Installation lock exists: ${lockPath}. ${owner} Verify the owner before any manual cleanup; the lock was not changed.`, { cause }), { code: 'INSTALL_LOCKED' });
  }
}

export function installSkill({ source = SRC, destination = DST, force = false, operations = {} } = {}) {
  const src = realpathSync(resolve(source)), dst = resolve(destination);
  assertSkill(src);
  const engineVersion = readEngineVersion(join(src, 'runtime', 'wf.mjs'));
  if (engineVersion !== EXPECTED_ENGINE) throw new Error(`Unsupported engine ${engineVersion}; expected ${EXPECTED_ENGINE}.`);
  if (within(src, dst) || within(dst, src)) throw new Error('Source and destination must not overlap.');
  if (existsSync(dst)) {
    assertSkill(dst);
    if (!force) throw new Error('An installation already exists; inspect it and use --force to replace it with a retained backup.');
  }
  const expected = manifest(src);
  mkdirSync(dirname(dst), { recursive: true });
  const canonicalDestination = canonicalDestinationPath(dst);
  if (within(src, canonicalDestination) || within(canonicalDestination, src)) throw new Error('Source and destination must not overlap through a link.');
  const lockPath = dst + '.install.lock';
  const lock = acquireInstallLock(lockPath);
  const rename = operations.rename || renameSync;
  const copy = operations.copy || cpSync;
  let stage, backupPath = null, movedBackup = false, activated = false;
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), exe: process.execPath }) + '\n');
    stage = mkdtempSync(dst + '.stage-');
    copy(src, stage, { recursive: true, errorOnExist: true, force: false });
    assertSkill(stage);
    if (JSON.stringify(manifest(stage)) !== JSON.stringify(expected)) throw new Error('Staged installation verification failed; the current installation was not changed.');
    if (existsSync(dst)) {
      assertSkill(dst);
      if (!force) throw new Error('Destination appeared during staging; use --force only after inspecting it.');
      backupPath = dst + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
      rename(dst, backupPath); movedBackup = true;
    }
    rename(stage, dst); activated = true;
    if (JSON.stringify(manifest(dst)) !== JSON.stringify(expected)) throw new Error('Activated installation verification failed.');
    return { engineVersion, destination: dst, backupPath, files: expected };
  } catch (error) {
    if (movedBackup) {
      try {
        if (activated && existsSync(dst)) rename(dst, dst + '.failed-' + randomUUID());
        if (existsSync(dst)) throw new Error('Destination exists unexpectedly; no files were overwritten.');
        rename(backupPath, dst);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Install failed; rollback could not finish. The original installation is retained at ${backupPath}.`);
      }
    } else if (activated && existsSync(dst)) {
      rename(dst, dst + '.failed-' + randomUUID());
    }
    throw error;
  } finally {
    if (stage && existsSync(stage)) rmSync(stage, { recursive: true, force: false });
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function parseInstallArgs(argv) {
  const args = { force: false, help: false };
  for (const flag of argv) {
    if (flag === '--force') args.force = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error('Unknown installer argument: ' + flag);
  }
  return args;
}
export function main(argv) {
  const args = parseInstallArgs(argv);
  if (args.help) { console.log('node install-skills.mjs [--force]\nStages and verifies engine ' + EXPECTED_ENGINE + '. Replacement requires --force and retains a verified backup.'); return 0; }
  const result = installSkill(args);
  console.log(`[install-skills] installed engine ${result.engineVersion}: ${result.files.length} verified files at ${result.destination}`);
  if (result.backupPath) console.log('[install-skills] retained original:', result.backupPath);
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('[install-skills] FATAL:', error.message); process.exitCode = 1; }
}
export { SRC, DST, EXPECTED_ENGINE };
