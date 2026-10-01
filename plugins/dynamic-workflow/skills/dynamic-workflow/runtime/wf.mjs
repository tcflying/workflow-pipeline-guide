#!/usr/bin/env node
// Qoder dynamic workflows: one script, many isolated subagents, journal on disk.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ENGINE_VERSION = '0.8.1';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// NAME_RE happily accepts "." and "..", which resolve out of whatever directory they are joined to.
const ALL_DOT_RE = /^\.+$/;
// Flags that never take a value, so they must not swallow the positional that follows them.
const BOOL_FLAGS = new Set(['quiet', 'yes', 'trusted', 'force', 'overwrite', 'help']);
const RUNS_DIR = '.qoder/workflow-runs';
// Not ".qoder/workflows": Qoder's plugin loader scans a `workflows` component directory, and a
// saved script landing there gets registered as an extension by the app, not by this engine.
const SAVED_PROJECT_DIR = '.qoder/dynamic-workflows';
const SAVED_GLOBAL_DIR = path.join('.qoder', 'dynamic-workflows');
const DRAFTS_DIR = '.qoder/workflow-drafts';
const TRUST_FILE = path.join('.qoder', 'dynamic-workflow-trust.json');
const STEER_MAX_NOTES = 200;
const STEER_MAX_CHARS = 4000;
// A20 size ceilings. Two numbers, on purpose: a workflow must not be able to grow the engine's
// memory or a prompt without bound, and a third knob nobody needs is not worth a config surface.
export const CLI_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// R3B-08: stderr is diagnostics, not the answer. It is kept as a bounded tail so a chatty child can
// neither grow the engine nor kill a call whose stdout was fine.
export const CLI_ERR_TAIL_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 512 * 1024;
const ARG_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const print = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function die(msg) {
  process.stderr.write(`wf: ${msg}\n`);
  process.exit(1);
}

function parseArgv(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      flags._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--') || BOOL_FLAGS.has(key)) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isNaN(n)) return dflt ?? lo;
  return Math.max(lo, Math.min(hi, n));
}

function safeName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !ALL_DOT_RE.test(name);
}

// Blank out strings, template literals, comments and regex bodies so textual guards never
// fire on prose. Character count is preserved so line numbers stay meaningful.
function blankLiterals(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(src.length, j + 2));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      blank(i, Math.min(src.length, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '/' && /[[\s(,=:&|!?*%~^;+-]/.test(src[i - 1] || ' ')) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        blank(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function findMetaStatement(src) {
  const m = /export\s+const\s+meta\s*=\s*/.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0 || src[open] !== '{') return null;
  const scan = blankLiterals(src);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (scan[i] === '{') depth++;
    else if (scan[i] === '}') {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        let k = end;
        while (k < src.length && /[ \t\r]/.test(src[k])) k++;
        if (src[k] === ';') end = k + 1;
        return { start: m.index, end, objectText: src.slice(open, i + 1) };
      }
    }
  }
  return null;
}

const BANNED = [
  [/\bDate\s*\.\s*now\s*\(/, 'nondeterministic', 'Date.now() is disabled in workflows: a resumed run must replay identically. Pass time through `args` instead.'],
  [/\bnew\s+Date\s*\(\s*\)/, 'nondeterministic', 'argless new Date() is disabled in workflows. Pass time through `args` instead.'],
  [/\bMath\s*\.\s*random\s*\(/, 'nondeterministic', 'Math.random() is disabled in workflows. Derive variation from `args`.'],
  [/\brequire\s*\(/, 'forbidden_module', 'require() is unavailable in workflows: no module access.'],
  [/\bimport\s*\(/, 'forbidden_module', 'dynamic import() is unavailable in workflows.'],
  [/^\s*import\s+[^(]/m, 'forbidden_module', 'static import is not allowed in workflows.'],
  [/\bprocess\b/, 'forbidden_host', 'process is unavailable in workflows: pass what you need through `args`.'],
  [/\bglobalThis\b/, 'forbidden_host', 'globalThis is unavailable in workflows.'],
  [/\bfetch\s*\(/, 'forbidden_host', 'fetch is unavailable in workflows: gather through agent() instead.'],
  // Only spellings that are themselves the reach get refused here. Bare `constructor` and
  // `prototype` do NOT: `class P { constructor() {} }` and `Object.prototype.toString.call(x)` are
  // ordinary code, and since A14/A24 the wall is the realm (codeGeneration + BRIDGE), not the
  // spelling — refusing them made the gate permanently red on valid scripts (A25). The runtime
  // guards and the quoted bracket form below still close the route.
  [/__proto__/, 'forbidden_host', '__proto__ is unavailable in workflows: it reaches the realm the determinism shim shadows.'],
  [/\bFunction\s*\(/, 'forbidden_host', 'Function() is unavailable in workflows: it rebuilds the globals the shim shadows.'],
  [/\beval\s*\(/, 'forbidden_host', 'eval() is unavailable in workflows: it rebuilds the globals the shim shadows.'],
  [/\[\s*['"](?:constructor|prototype|__proto__)['"]\s*\]/, 'forbidden_host', 'bracketed constructor/prototype access is unavailable in workflows.', 'raw'],
];

// One honest parse of a script file: meta object, wrapped body (with the original meta
// statement removed so `meta` is declared once), and every static error we can find.
export function analyzeSource(src, fileLabel = 'workflow') {
  const diags = [];
  const found = findMetaStatement(src);
  let meta = null;
  let body = src;
  let bodyLineOffset = 0;
  if (!found) {
    diags.push({ severity: 'error', code: 'meta_missing', line: 1, message: 'script must start with `export const meta = { name, description, ... };`' });
  } else {
    // A30: meta used to be evaluated before a single rule was consulted, so `check`/`list` on an
    // unapproved file ran whatever code its `meta` expression held. That realm cannot reach the host
    // (proven: it dies on `process is not defined`), but running it to decide whether to run the file
    // is backwards. Judge the text first; the scan below still reports the offence, and `meta` stays
    // null because nothing was evaluated.
    const metaScan = blankLiterals(found.objectText);
    const bannedInMeta = BANNED.some(([re, , , where]) => re.exec(where === 'raw' ? found.objectText : metaScan));
    if (!bannedInMeta) {
      try {
        meta = vm.runInNewContext('(' + found.objectText + '\n)', Object.create(null), { timeout: 1000 });
      } catch (e) {
        diags.push({ severity: 'error', code: 'meta_unparseable', line: lineOf(src, found.start), message: 'meta could not be evaluated as a literal: ' + e.message });
      }
    }
    body = 'const meta = ' + found.objectText + ';\n' + src.slice(found.end);
    bodyLineOffset = src.slice(0, found.end).split('\n').length - 1;
  }

  if (meta && typeof meta === 'object') {
    if (typeof meta.name !== 'string' || !meta.name.trim()) diags.push({ severity: 'error', code: 'meta_name', message: 'meta.name must be a non-empty string' });
    if (typeof meta.description !== 'string' || !meta.description.trim()) diags.push({ severity: 'error', code: 'meta_description', message: 'meta.description must be a non-empty string' });
    if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') diags.push({ severity: 'error', code: 'meta_whentouse', message: 'meta.whenToUse must be a string when present' });
    if (meta.args !== undefined) {
      if (!meta.args || typeof meta.args !== 'object' || Array.isArray(meta.args)) {
        diags.push({ severity: 'error', code: 'meta_args', message: 'meta.args must be an object of argument declarations' });
      } else {
        for (const [k, decl] of Object.entries(meta.args)) {
          if (!/^[A-Za-z_$][\w$]*$/.test(k)) diags.push({ severity: 'error', code: 'meta_args', message: `meta.args key "${k}" is not a valid identifier` });
          else if (!decl || typeof decl !== 'object' || Array.isArray(decl)) diags.push({ severity: 'error', code: 'meta_args', message: `meta.args.${k} must be an object like { type, required, default }` });
          else if (decl.type !== undefined && !ARG_TYPES.includes(decl.type)) diags.push({ severity: 'error', code: 'meta_args', message: `meta.args.${k}.type must be one of ${ARG_TYPES.join(', ')}` });
        }
      }
    }
  }

  const scan = blankLiterals(body);
  for (const [re, code, message, where] of BANNED) {
    const m = re.exec(where === 'raw' ? body : scan);
    if (m) diags.push({ severity: 'error', code, line: lineOf(body, m.index) + bodyLineOffset, message });
  }
  try {
    new vm.Script('(async()=>{' + body + '\n})()', { filename: fileLabel });
  } catch (e) {
    diags.push({ severity: 'error', code: 'syntax', line: 0, message: 'script does not compile: ' + e.message });
  }
  return { meta, body, bodyLineOffset, diags, metaStatement: found };
}

export function analyzeFile(file) {
  let src = '';
  let readError = null;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    readError = e;
  }
  const parsed = analyzeSource(readError ? '' : src, path.basename(file));
  // A directory named foo.js, a file without read permission or a vanished file all land here
  // instead of throwing a raw stack out of check/run/save.
  if (readError) parsed.diags.unshift({ severity: 'error', code: 'unreadable', line: 1, message: `${file} could not be read: ${readError.message}` });
  return { file, src, ...parsed };
}

const errorsOf = (diags) => diags.filter((d) => d.severity === 'error');

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

// Unknown keys, missing required values, wrong types and out-of-range enums all fail here,
// before any agent is dispatched.
export function validateArgs(decl, given) {
  const errors = [];
  const out = {};
  const g = given && typeof given === 'object' && !Array.isArray(given) ? given : given === undefined ? {} : null;
  if (g === null) return { ok: false, errors: ['args must be a JSON object'], args: {} };
  for (const [k, v] of Object.entries(g)) {
    if (!decl || decl[k] === undefined) errors.push(`unknown argument "${k}"`);
    else out[k] = v;
  }
  for (const [k, d] of Object.entries(decl || {})) {
    if (out[k] === undefined) {
      if (d.default !== undefined) out[k] = d.default;
      else if (d.required) errors.push(`missing required argument "${k}" (${d.type || 'any'})`);
      continue;
    }
    if (d.type && typeOf(out[k]) !== d.type) errors.push(`argument "${k}" must be ${d.type}, got ${typeOf(out[k])}`);
    if (Array.isArray(d.enum) && !d.enum.includes(out[k])) errors.push(`argument "${k}" must be one of ${d.enum.join(', ')}`);
  }
  return { ok: errors.length === 0, args: out, errors };
}

// A refused cancel or resume must say why, not just fail: the host has to tell the user what to do.
function reject(command, detail) {
  print({ ok: false, command, ...detail });
  process.exitCode = 3;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function loadRun(cwd, runId) {
  const root = path.join(cwd, RUNS_DIR);
  const id = String(runId);
  // Refuse before joining: `path.join(root, '..')` is the runs dir's parent, and reporting a
  // resolved path outside the runs root tells the host it looked somewhere it has no business.
  if (!safeName(id)) return { ok: false, dir: null, reason: `invalid run id "${id}": a run id is a name, not a path` };
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) {
    return { ok: false, dir, reason: `no run named "${id}" under ${root}`, knownRuns: fs.existsSync(root) ? fs.readdirSync(root).sort().slice(-8) : [] };
  }
  const sf = path.join(dir, 'state.json');
  if (!fs.existsSync(sf)) return { ok: false, dir, reason: `${dir} holds no state.json, so this engine never recorded it` };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(sf, 'utf8'));
  } catch (e) {
    return { ok: false, dir, reason: `${sf} could not be read: ${e.message}` };
  }
  const inFlight = !TERMINAL.has(state.status);
  const alive = pidAlive(state.pid);
  return { ok: true, dir, state, inFlight, alive, stale: inFlight && !alive };
}

function trustFile(cwd) {
  return path.join(cwd, TRUST_FILE);
}

const sfOf = (dir) => path.join(dir, 'state.json');

// R3B-07: `state.json` is written *after* the destructive cleanup, so a read-then-wipe-then-claim
// sequence let two lifecycles started on one run id both pass the liveness check and then share the
// journal. OWNER is claimed with O_EXCL before anything is deleted, so exactly one of them proceeds.
// The loser must not trust `pidAlive` on its own: this engine runs on Windows, where a killed
// lifecycle leaves its claim behind and the operating system hands its pid to an unrelated process.
// A claim is only real once the claimer has landed it in state.json, so the loser waits a bounded
// two seconds for that to happen -- refuse if it does, take the claim over if it never does.
const CLAIM_SETTLE_MS = 2000;
const Int32ArrayShared = new Int32Array(new SharedArrayBuffer(4));

function claimOwnership(runDir) {
  const file = path.join(runDir.dir, 'OWNER');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }), { flag: 'wx' });
      // Release on the way out so a settled run is never blocked by its own old claim. Correctness
      // does not depend on this: a killed process leaves the file and the landing check clears it.
      process.on('exit', () => {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: `cannot claim ${file}: ${e.message}` };
      let holder = 0;
      try {
        holder = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid);
      } catch {}
      // `resume` claims and then delegates to `run`, which claims again: the same pid already holds
      // it. Without this the second claim mistakes itself for a rival and waits out the window.
      if (holder === process.pid) return { ok: true };
      if (!Number.isInteger(holder) || holder <= 0 || !pidAlive(holder)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      // The holder is a live process: give it the bounded window to land its claim before deciding
      // the claim is orphaned. A claim that never lands is a starter killed mid-start.
      const landedAt = Date.now() + CLAIM_SETTLE_MS;
      while (Date.now() < landedAt) {
        try {
          const st = JSON.parse(fs.readFileSync(sfOf(runDir.dir), 'utf8'));
          if (Number(st.pid) === holder && !TERMINAL.has(st.status))
            return { ok: false, busy: holder, reason: `run ${runDir.runId} is claimed by pid ${holder}` };
        } catch {}
        Atomics.wait(Int32ArrayShared, 0, 0, 250);
      }
      fs.rmSync(file, { force: true });
    }
  }
  return { ok: false, reason: `run ${runDir.runId} is being claimed by another process at this instant; run the command again` };
}

function summariseJournal(dir) {
  const jf = path.join(dir, 'journal.jsonl');
  const s = { dispatched: 0, settled: 0, failed: 0, rejected: 0, firstReject: null, delivered: 0, phases: [], firstError: null };
  if (!fs.existsSync(jf)) return s;
  // A killed process can leave a half-written last line; skipping it keeps the run reportable.
  for (const line of fs.readFileSync(jf, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'agent_dispatch') s.dispatched++;
    // A call refused before dispatch (budget) produces no dispatch/result event, so A16's counts
    // cannot see it. It gets its own event and its own number (A28).
    if (ev.type === 'agent_rejected') {
      s.rejected++;
      if (!s.firstReject) s.firstReject = ev.reason || 'unknown';
    }
    if (ev.type === 'notes') s.delivered += (ev.ids || []).length;
    if (ev.type === 'agent_result') {
      s.settled++;
      if (ev.ok === false) {
        s.failed++;
        if (!s.firstError) s.firstError = String((ev.result && ev.result.error) || 'agent call failed');
      }
    }
    // One lifecycle re-issues every phase() call it already made, so a resume used to append the
    // whole label sequence a second time and `status.phases` lied (A19). First mention wins: that
    // is the order the script declared, and it is the same answer however many times you read it.
    if (ev.type === 'phase' && !s.phases.includes(ev.name)) s.phases.push(ev.name);
  }
  return s;
}

function readTrust(cwd) {
  const f = trustFile(cwd);
  const empty = { version: 1, workflows: {} };
  if (!fs.existsSync(f)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const map = raw && typeof raw.workflows === 'object' && raw.workflows ? raw.workflows : {};
    return { version: 1, workflows: map };
  } catch (e) {
    return { ...empty, warning: `${f} is unreadable (${e.message}); every workflow counts as untrusted` };
  }
}

function writeTrust(cwd, trust) {
  const f = trustFile(cwd);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...trust, updatedAt: new Date().toISOString() }, null, 2));
}

// Trust binds to content, not to a name: re-saving under the same name revokes it, so the gate
// always covers the exact script the run is about to execute.
function confirmationFor(cwd, { name, src, flags }) {
  if (flags.yes || flags.trusted) return { required: false, basis: 'flag' };
  const hash = sha256(String(src ?? ''));
  const rec = safeName(name) ? readTrust(cwd).workflows[name] : null;
  if (!rec) return { required: true, basis: 'first-run' };
  if (rec.sha256 !== hash) return { required: true, basis: 'script-changed', trustedAt: rec.addedAt, trustedFrom: String(rec.sha256).slice(0, 8), nowFrom: hash.slice(0, 8) };
  return { required: false, basis: 'trust-list', scope: rec.scope, trustedAt: rec.addedAt };
}

function savedDirs(cwd) {
  const home = process.env.QODER_WF_HOME || os.homedir();
  return [
    { scope: 'project', dir: path.join(cwd, SAVED_PROJECT_DIR) },
    { scope: 'global', dir: path.join(home, SAVED_GLOBAL_DIR) },
  ];
}

export function listSaved(cwd) {
  const workflows = [];
  const invalid = [];
  const scanned = new Set();
  const trusted = readTrust(cwd).workflows;
  for (const c of savedDirs(cwd)) {
    // With cwd == home the project and global archives are the same folder; list each once.
    const real = fs.existsSync(c.dir) ? fs.realpathSync(c.dir) : c.dir;
    if (scanned.has(real)) continue;
    scanned.add(real);
    if (!fs.existsSync(c.dir)) continue;
    for (const entry of fs.readdirSync(c.dir).sort()) {
      if (!entry.endsWith('.js')) continue;
      const file = path.join(c.dir, entry);
      const parsed = analyzeFile(file);
      const errs = errorsOf(parsed.diags);
      if (errs.length) invalid.push({ path: file, scope: c.scope, detail: errs.map((d) => d.message).join('; ') });
      else
        workflows.push({
          name: entry.slice(0, -3),
          scope: c.scope,
          path: file,
          description: parsed.meta?.description,
          whenToUse: parsed.meta?.whenToUse,
          args: parsed.meta?.args ? Object.keys(parsed.meta.args) : [],
          trusted: Boolean(trusted[entry.slice(0, -3)] && trusted[entry.slice(0, -3)].sha256 === sha256(parsed.src)),
        });
    }
  }
  return { workflows, invalid };
}

function findSaved(cwd, name, scope) {
  if (!safeName(name)) return { ok: false, reason: 'invalid_name', detail: `"${name}" is not a workflow name: letters, digits, ".", "-", "_" only, max 64 chars` };
  const candidates = scope ? savedDirs(cwd).filter((d) => d.scope === scope) : savedDirs(cwd);
  for (const c of candidates) {
    const file = path.join(c.dir, name + '.js');
    if (!fs.existsSync(file)) continue;
    const parsed = analyzeFile(file);
    const errs = errorsOf(parsed.diags);
    if (errs.length) return { ok: false, reason: 'parse_error', path: file, detail: errs.map((d) => d.message).join('; ') };
    return { ok: true, ...parsed, path: file, scope: c.scope };
  }
  return { ok: false, reason: 'not_found', detail: `no saved workflow "${name}" under ${candidates.map((c) => c.dir).join(' or ')}` };
}

// ponytail: replay reads the whole journal into strings and keeps the answers in a Map, so a resume
// costs roughly 2x journal.jsonl in resident memory. The measured time side is benign (12.5 ms per MB
// of journal at a 30-call run); the ceiling to watch is RAM, not latency, if --max-calls is raised
// with very large prompts. Upgrade path: stream the file line by line and keep only the answer map.
class Journal {
  constructor(dir) {
    this.file = path.join(dir, 'journal.jsonl');
    this.cache = new Map();
    this.askCache = new Map();
    this.noteCache = new Map();
    this.consumed = new Set();
    this.seq = 0;
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        // Only a settled *answer* may replay. Caching a transient failure (crashed subagent, host
        // saying ok:false) would hand the same failure back on every resume and make "fix the
        // script, resume" impossible; inside the run the failure still returns to the script.
        if (ev.type === 'agent_result' && ev.key && ev.result && ev.result.ok !== false) this.cache.set(ev.key, ev.result);
        // ask() answers replay by (question, nth) exactly like agent results; failures are not
        // cached so a resumed run can re-ask (same contract as the agent failure path).
        if (ev.type === 'ask_result' && ev.key && ev.ok !== false && typeof ev.answer === 'string') this.askCache.set(ev.key, ev.answer);
        if (ev.type === 'notes' && ev.key) {
          this.noteCache.set(ev.key, ev.texts || []);
          for (const id of ev.ids || []) this.consumed.add(id);
        }
        if (ev.type === 'agent_dispatch' && typeof ev.seq === 'number' && ev.seq >= this.seq) this.seq = ev.seq + 1;
      }
    }
  }

  append(ev) {
    fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
  }
}

// Mid-flight steering arrives as one JSON line per note. A note is identified by what it says and
// when it was queued, not by its line number: pruning or reordering steer.jsonl used to move a
// queued note onto a spent id (never delivered) or a spent note onto a fresh id (delivered twice).
function readSteerNotes(dir) {
  const f = path.join(dir, 'steer.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = [];
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev.text === 'string' && ev.text)
      out.push({ id: sha256(`${ev.at ?? ''}\u0000${ev.from ?? 'host'}\u0000${ev.text}`).slice(0, 12), text: ev.text, from: ev.from || 'host' });
  }
  return out;
}

// B1: this scanned every npx cache directory with a stat per call (4.49 ms each on the auditing
// box, ~2.25 s over a 500-call run), and it is only ever used by the cli backend. One memo per
// process; `paths` passes force so what it prints is a real resolve, not a cached guess.
let cliEntryCache;
export function resolveCliEntry(force) {
  if (!force && cliEntryCache !== undefined) return cliEntryCache;
  const env = process.env.QODER_WORKFLOW_CLI_JS;
  if (env && fs.existsSync(env)) return (cliEntryCache = env);
  const roots = [
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js'),
  ];
  const npxRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  if (fs.existsSync(npxRoot)) {
    for (const h of fs.readdirSync(npxRoot)) roots.push(path.join(npxRoot, h, 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js'));
  }
  roots.sort((a, b) => (fs.existsSync(b) ? fs.statSync(b).mtimeMs : 0) - (fs.existsSync(a) ? fs.statSync(a).mtimeMs : 0));
  return (cliEntryCache = roots.find((r) => fs.existsSync(r)) || null);
}

// The host session injects SDK-entrypoint env into children; qodercli then demands
// stream-json flags and dies, so spawned agents must not inherit them.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^QODER_(AGENT_SDK|SDK_|SESSION_|WORKER_|MCP_LAZY)/.test(k) || k === 'QODER_CLI' || k === 'QODERCLI_RUNTIME_PACKAGING') delete env[k];
  }
  return env;
}

function runCliAgent({ prompt, opts, runDir, callId }) {
  return new Promise((resolve) => {
    const entry = resolveCliEntry();
    if (!entry) {
      resolve({ ok: false, error: 'qodercli entry not found: set QODER_WORKFLOW_CLI_JS to bundle/qodercli.js, or run with --backend file' });
      return;
    }
    const args = [entry, '-p'];
    if (opts.model) args.push('--model', String(opts.model));
    if (opts.agent) args.push('--agent', String(opts.agent));
    if (opts.systemPrompt) args.push('--append-system-prompt', String(opts.systemPrompt));
    if (opts.maxOutputTokens) args.push('--max-output-tokens', String(opts.maxOutputTokens));
    if (opts.tools) args.push('--tools', String(opts.tools));
    if (opts.permissionMode) args.push('--permission-mode', String(opts.permissionMode));
    args.push('--', prompt);
    const t0 = Date.now();
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: opts.cwd || runDir.cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: 'spawn failed: ' + e.message });
      return;
    }
    runDir.children.add(child);
    let out = '';
    let err = '';
    let bytes = 0;
    let overBudget = false;
    // A20: `out += chunk` had no ceiling at all, so one chatty subagent could grow the engine until
    // the OS killed it. Past the cap the child is stopped and the call fails naming the byte count.
    const collect = (which) => (d) => {
      if (overBudget) return;
      if (which !== 'out') {
        err = (err + d).slice(-CLI_ERR_TAIL_BYTES);
        return;
      }
      bytes += d.length;
      if (bytes > CLI_MAX_OUTPUT_BYTES) {
        overBudget = true;
        clearTimeout(timer);
        runDir.children.delete(child);
        child.kill('SIGTERM');
        resolve({ ok: false, error: `qodercli output exceeded ${CLI_MAX_OUTPUT_BYTES} bytes, so the call was abandoned: ask for a shorter answer or have the subagent write a file` });
        return;
      }
      out += d;
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs || 900000);
    child.on('error', (e) => {
      if (overBudget) return;
      clearTimeout(timer);
      runDir.children.delete(child);
      resolve({ ok: false, error: 'spawn failed: ' + e.message });
    });
    child.on('close', (code) => {
      if (overBudget) return;
      clearTimeout(timer);
      runDir.children.delete(child);
      const text = out.trim();
      if (!text) resolve({ ok: false, error: `qodercli produced no output (exit ${code}): ${err.slice(-1500)}` });
      else resolve({ ok: true, text, ms: Date.now() - t0 });
    });
  });
}

// Concurrent agent() calls each rewrite this one file, so writes are serialized through a chain
// and the snapshot is taken inside the queued task: an unserialized writer can leave a stale
// batch as the last thing on disk, and the host then never sees the newer calls.
// ponytail: items carry the full prompt so one host read is enough to fan out. That makes each
// rewrite O(concurrency x prompt) -- measured 3.28 MB / 4.26 ms per rewrite at 8 parked calls with
// 200 KB prompts, about 16x the journal bytes for the same calls -- so a 500-call run of huge prompts
// writes gigabytes. Upgrade path if that ever bites: keep callId/seq/phase/label here and let the
// host read pending/<callId>.json, which already carries the prompt and the four `wants` fields.
export function flushPendingIndex(runDir) {
  const write = async () => {
    const items = [...runDir.pending.values()].sort((a, b) => a.seq - b.seq);
    const snapshot = JSON.stringify({ runId: runDir.runId, outstanding: items.length, items }, null, 2);
    // B2 (narrowed by the ledger to this half): dispatching used to write this file twice in a row
    // with byte-identical content. Same snapshot means nothing the host has not already been shown.
    if (snapshot === runDir.lastPendingSnapshot) return;
    await fsp.writeFile(path.join(runDir.dir, 'pending.json'), snapshot);
    // The memo is written only once the bytes are on disk: R3B-01 -- remembering the snapshot first
    // meant a failed write (disk full, an AV lock holding the file open) was never retried, and the
    // park the host never saw then burned its semaphore slot for the whole deadline.
    runDir.lastPendingSnapshot = snapshot;
  };
  runDir.flushChain = (runDir.flushChain || Promise.resolve()).then(write, write);
  return runDir.flushChain;
}

// Park a call on disk; the host agent answers it with inbox/<callId>.json ({"text":...} or
// {"ok":false,"error":...}) or inbox/<callId>.txt for plain text.
// An unanswered park expires like every other call: without a default the file backend held a
// semaphore slot forever the moment the host stopped driving the handshake (A17), while the cli
// backend already gave up at 900 s.
// WF_PARK_TIMEOUT_MS exists so the default itself is testable: a suite cannot wait 15 minutes for
// an unanswered park, and without the knob no test could tell a default that works from no default.
const PARK_TIMEOUT_MS = clampInt(process.env.WF_PARK_TIMEOUT_MS, 1000, 86400000, 900000);

async function runFileAgent({ prompt, opts, runDir, callId, phaseName, label }) {
  const pendingFile = path.join(runDir.dir, 'pending', callId + '.json');
  const cancelFile = path.join(runDir.dir, 'CANCEL');
  // C3: these four options are part of the cache key, so they change what a call *is* -- and until
  // now the host never saw them, so it could not honour them either. They are requests, not
  // guarantees: a host may ignore them, but it can no longer be unaware of them.
  const wants = { model: opts.model ?? null, agent: opts.agent ?? null, systemPrompt: opts.systemPrompt ?? null, cwd: opts.cwd ?? null };
  await fsp.writeFile(pendingFile, JSON.stringify({ callId, seq: opts.seq, key: opts.key, phase: phaseName, label, prompt, requestedAt: new Date().toISOString(), ...wants }, null, 2));
  await flushPendingIndex(runDir);
  const ms = opts.timeoutMs || PARK_TIMEOUT_MS;
  const deadline = Date.now() + ms;
  const answerFile = path.join(runDir.dir, 'inbox', callId + '.json');
  try {
    for (;;) {
      for (const ext of ['json', 'txt']) {
        const f = path.join(runDir.dir, 'inbox', callId + '.' + ext);
        if (!fs.existsSync(f)) continue;
        let payload;
        try {
          const raw = await fsp.readFile(f, 'utf8');
          payload = ext === 'json' ? JSON.parse(raw) : { ok: true, text: raw };
        } catch {
          // A host can be caught mid-write, or delete the file between the stat and the read. That
          // is not an answer: keep polling and only fail it at the deadline.
          await sleep(120);
          continue;
        }
        runDir.pending.delete(callId);
        await flushPendingIndex(runDir);
        // The answer file itself is removed by agent() once the result is in the journal, so a
        // crash between the two re-dispatches the call instead of losing the answer.
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          return { ok: false, error: `${answerFile} is not an answer object: expected {"ok":true,"text":"…"} or {"ok":false,"error":"why"}` };
        }
        if (payload.ok === false) return { ok: false, error: String(payload.error || 'agent reported failure') };
        // A typo'd field name must not become a silent empty answer that the journal then replays as
        // a real success for the rest of the run's life (A15).
        if (typeof payload.text !== 'string') {
          return { ok: false, error: `${answerFile} had no text field (keys present: ${Object.keys(payload).join(', ') || 'none'}): write {"ok":true,"text":"the answer"}, or inbox/${callId}.txt for plain text` };
        }
        return { ok: true, text: payload.text, ...(payload.usage && typeof payload.usage === 'object' ? { usage: payload.usage } : {}) };
      }
      if (runDir.cancelled()) return { ok: false, error: `run cancelled (${cancelFile})`, cancelled: true };
      if (Date.now() > deadline) {
        return { ok: false, error: `agent call ${callId} timed out after ${ms}ms with no answer in inbox/${callId}.json — the host stopped driving the handshake (answer pending.json, or raise timeoutMs)` };
      }
      await sleep(400);
    }
  } finally {
    await fsp.rm(pendingFile, { force: true });
  }
}

class Semaphore {
  constructor(n) {
    this.free = n;
    this.waiters = [];
  }

  async acquire() {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise((res) => this.waiters.push(res));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

function extractJson(text) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const cand of [fence?.[1], text]) {
    if (!cand) continue;
    const t = cand.trim();
    try {
      return JSON.parse(t);
    } catch {}
    const opens = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
    const s = opens.length ? Math.min(...opens) : -1;
    const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {}
    }
  }
  return undefined;
}

export function buildFacade(runDir, st) {
  const sem = new Semaphore(runDir.concurrency);

  function settle(result, opts) {
    if (result.ok === false) {
      if (opts.throwOnError) throw new Error(result.error);
      return { ok: false, error: result.error };
    }
    const text = typeof result.text === 'string' ? result.text : String(result.text ?? '');
    if (!opts.json) return text;
    const parsed = extractJson(text);
    if (parsed === undefined) {
      if (opts.throwOnError) throw new Error(`agent(json): reply was not JSON: ${text.slice(0, 200)}`);
      return { ok: false, error: `agent(json): reply was not JSON: ${text.slice(0, 200)}` };
    }
    return parsed;
  }

  async function agent(prompt, opts = {}) {
    if (runDir.cancelled()) throw new Error(`run cancelled (${path.join(runDir.dir, 'CANCEL')})`);
    const phaseName = opts.phase || st.phase || '(unlabelled)';
    const label = opts.label || (typeof prompt === 'string' ? prompt.trim().split('\n')[0].slice(0, 70) : `(${typeof prompt} prompt)`);
    // A call is addressed by (prompt, options, nth occurrence) rather than by wall-clock order, so a
    // resumed run lands on the same key for the same script position and replays the stored answer.
    const base = sha256(`${prompt}\u0000${JSON.stringify({ m: opts.model ?? null, a: opts.agent ?? null, s: opts.systemPrompt ?? null, c: opts.cwd ?? null })}`);
    const nth = st.callCounts.get(base) || 0;
    st.callCounts.set(base, nth + 1);
    const key = sha256(`${base}\u0000${nth}`);
    const callId = `c${String(nth).padStart(3, '0')}-${key.slice(0, 8)}`;
    // A31: these two refusals used to throw before anything was journalled, so inside `parallel` the
    // rejection became a plain slot value, A16's guard saw zero dispatches and a fan-out that did no
    // work at all settled "completed". A refusal is now journalled exactly like a budget refusal
    // (:767) and still consumes its call position, so replay stays deterministic.
    const refusal = typeof prompt !== 'string' || !prompt.trim() ? 'empty-prompt'
      // A20: a prompt is pasted into a subagent's context, so an unbounded one is an unbounded cost.
      : prompt.length > MAX_PROMPT_CHARS ? 'prompt-too-large' : null;
    if (refusal) {
      st.journal.append({ type: 'agent_rejected', reason: refusal, callId, phase: phaseName, label });
      throw new Error(refusal === 'empty-prompt'
        ? 'agent(prompt): prompt must be a non-empty string'
        : `agent(prompt): prompt is ${prompt.length} characters, over the ${MAX_PROMPT_CHARS}-character cap — hand the subagent a path or a range to read instead of the whole body`);
    }
    if (st.journal.cache.has(key)) {
      st.replayed++;
      st.journal.append({ type: 'agent_replay', key, callId, phase: phaseName, label });
      return settle(st.journal.cache.get(key), opts);
    }
    // C1: the budget is the run's, not the process's: `journal.seq` counts every dispatch this run id
    // ever made, so a resume can no longer refill it.
    if (st.journal.seq >= runDir.maxAgentCalls) {
      // A28: refusing a call before it dispatches left no trace at all -- `parallel` swallowed the
      // throw as a slot failure and A16's dispatch/result counts never saw it. Say it out loud.
      st.journal.append({ type: 'agent_rejected', reason: 'budget', callId, phase: phaseName, label });
      throw new Error(`agent() call budget exhausted (${runDir.maxAgentCalls}); raise --max-calls or shrink the fan-out`);
    }
    const seq = st.journal.seq++;
    await sem.acquire();
    try {
      st.journal.append({ type: 'agent_dispatch', seq, key, callId, phase: phaseName, label, prompt });
      runDir.pending.set(callId, { callId, seq, phase: phaseName, label, prompt });
      let result;
      try {
        if (runDir.backend === 'file') {
          await flushPendingIndex(runDir);
          result = await runFileAgent({ prompt, opts: { ...opts, key, seq }, runDir, callId, phaseName, label });
        } else if (runDir.backend === 'echo') {
          await sleep(0);
          result = { ok: true, text: `echo:${prompt.trim().slice(0, 80)}` };
        } else {
          await flushPendingIndex(runDir);
          result = await runCliAgent({ prompt, opts: { ...opts, key, seq }, runDir, callId });
        }
      } catch (e) {
        result = { ok: false, error: e.message };
      } finally {
        runDir.pending.delete(callId);
        await flushPendingIndex(runDir);
      }
      // Cancellation is an engine control event, not a subagent failure: never settle it away.
      if (result.cancelled) throw new Error(result.error);
      st.journal.append({ type: 'agent_result', seq, key, callId, phase: phaseName, label, ok: result.ok !== false, result });
      // The answer stays on disk until its result is journalled, then it is gone: a leftover
      // inbox/<callId>.json would otherwise be read as the answer to the next lifecycle's call.
      for (const ext of ['json', 'txt']) await fsp.rm(path.join(runDir.dir, 'inbox', `${callId}.${ext}`), { force: true });
      return settle(result, opts);
    } finally {
      sem.release();
    }
  }

  // ask(): a blocking question from the script to the driving host (SPEC §1.3). Only the file
  // backend has a host to answer; the answer parks through the same inbox mechanism as an agent
  // call, keyed by (question, nth) so a resumed run replays the recorded answer instead of re-asking.
  async function ask(question, opts = {}) {
    if (runDir.backend !== 'file') throw new Error('ask() 仅 --backend file 可用：cli/echo 后端没有宿主可回答');
    if (typeof question !== 'string' || !question.trim()) throw new Error('ask(question): question must be a non-empty string');
    const base = sha256(String(question));
    const nth = st.askCounts.get(base) || 0;
    st.askCounts.set(base, nth + 1);
    const key = sha256(`${base}\u0000${nth}`);
    const qId = `q${String(nth).padStart(3, '0')}-${key.slice(0, 8)}`;
    if (st.journal.askCache.has(key)) {
      const cached = st.journal.askCache.get(key);
      st.journal.append({ type: 'ask_replay', key, qId, question: String(question), answer: cached });
      return cached;
    }
    const phaseName = opts.phase || st.phase || '(问答)';
    const label = `问答:${String(question).trim().slice(0, 50)}`;
    st.journal.append({ type: 'ask_dispatch', seq: st.journal.seq, key, qId, question: String(question) });
    await flushPendingIndex(runDir);
    runDir.pending.set(qId, { callId: qId, seq: st.journal.seq, phase: phaseName, label, prompt: String(question), kind: 'question' });
    let result;
    try {
      result = await runFileAgent({ prompt: String(question), opts: { ...opts, timeoutMs: opts.timeoutMs || 3600000 }, runDir, callId: qId, phaseName, label });
    } finally {
      runDir.pending.delete(qId);
      await flushPendingIndex(runDir);
    }
    if (result.cancelled) throw new Error(result.error);
    st.journal.append({ type: 'ask_result', key, qId, ok: result.ok !== false, answer: result.ok !== false ? result.text : undefined, error: result.ok === false ? result.error : undefined, result });
    if (result.ok === false) throw new Error(`ask(): 宿主拒绝回答: ${result.error}`);
    return result.text;
  }

  // publish(): register a deliverable on the run (SPEC §1.3). Validation throws before the
  // journal sees anything, so a bad publish is an ordinary script error, not a poisoned record.
  function publish(artifact) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('publish(artifact): pass { title, kind, path?, url?, text?, primary? }');
    if (typeof artifact.title !== 'string' || !artifact.title.trim()) throw new Error('publish(artifact).title must be a non-empty string');
    const kind = artifact.kind === undefined ? 'text' : String(artifact.kind);
    if (!['file', 'document', 'dashboard', 'text'].includes(kind)) throw new Error(`publish(artifact).kind must be file|document|dashboard|text, got ${kind}`);
    let url = artifact.url === undefined ? null : String(artifact.url);
    if (url !== null && !/^https?:\/\//.test(url)) throw new Error('publish(artifact).url must start with http:// or https://');
    const text = artifact.text === undefined ? null : String(artifact.text).slice(0, 4000);
    const id = `a${st.publishedCount++}-${sha256(String(artifact.title)).slice(0, 8)}`;
    st.journal.append({ type: 'artifact', id, title: String(artifact.title), kind, path: artifact.path === undefined ? null : String(artifact.path), url, text, primary: artifact.primary === true });
  }

  function parallel(jobs, ...rest) {
    const thunks = Array.isArray(jobs) ? jobs : [jobs, ...rest];
    if (thunks.some((t) => typeof t !== 'function')) throw new Error('parallel(): pass an array of thunks, e.g. parallel([() => agent(a), () => agent(b)])');
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return await t(i);
        } catch (e) {
          return { ok: false, error: e.message };
        }
      })
    );
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new Error('pipeline(items, ...stages): items must be an array');
    if (!stages.length || stages.some((s) => typeof s !== 'function')) throw new Error('pipeline(items, ...stages): stages must be functions');
    return Promise.all(
      items.map(async (item, i) => {
        let acc = item;
        for (const stage of stages) {
          try {
            acc = await stage(acc, item, i);
          } catch (e) {
            return { ok: false, error: e.message, item };
          }
          if (acc && acc.ok === false) return acc;
        }
        return acc;
      })
    );
  }

  // Notes the host injected with `wf.mjs steer`, as an array of strings. Each read is journalled,
  // so a resumed run replays the same list and the prompts built from it keep matching their
  // cached answers. Unread notes come back empty; nothing here blocks waiting for one.
  function notes() {
    const nth = st.noteReads++;
    const key = sha256(`notes\0${nth}`);
    if (st.journal.noteCache.has(key)) return [...st.journal.noteCache.get(key)];
    const fresh = readSteerNotes(runDir.dir).filter((n) => !st.journal.consumed.has(n.id));
    const texts = fresh.map((n) => n.text);
    const ids = fresh.map((n) => n.id);
    st.journal.append({ type: 'notes', key, ids, texts });
    for (const id of ids) st.journal.consumed.add(id);
    if (texts.length) progress(runDir, `notes=${texts.length} delivered`);
    return texts;
  }

  return {
    agent,
    ask,
    publish,
    parallel,
    pipeline,
    notes,
    phase(name) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('phase(name): name must be a non-empty string');
      st.phase = name;
      st.journal.append({ type: 'phase', name });
      progress(runDir, `phase=${name}`);
    },
    log(msg) {
      const text = typeof msg === 'string' ? msg : safeStringify(msg);
      st.journal.append({ type: 'log', text });
      progress(runDir, `log ${text}`);
    },
  };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// A18: the engine exists to keep intermediate output out of the host's context, and then `run`
// printed the entire result back into it (200 787 bytes measured for one 200 KB return value).
// A result that fits inside the preview stays on stdout, because that is the answer the host wants
// to read; anything bigger is replaced by a bounded preview plus the pointer to out.json. The cap
// is the whole contract: no flood, no ceremony for the small case.
const RESULT_PREVIEW_CHARS = 2000;
function withResultPreview(out) {
  if (!('result' in out)) return out;
  const full = safeStringify(out.result);
  if (full.length <= RESULT_PREVIEW_CHARS) return out;
  const view = { ...out };
  delete view.result;
  view.resultBytes = Buffer.byteLength(full, 'utf8');
  view.resultPreview = `${full.slice(0, RESULT_PREVIEW_CHARS)}… ${full.length} chars total`;
  view.resultFull = `wf.mjs result ${out.runId} — or read ${out.dir}/out.json`;
  return view;
}

function progress(runDir, line) {
  if (runDir.quiet) return;
  process.stdout.write(`WF ${line}\n`);
}

function writeState(runDir, patch) {
  Object.assign(runDir.state, patch);
  fs.writeFileSync(path.join(runDir.dir, 'state.json'), JSON.stringify(runDir.state, null, 2));
}

export async function runScript({ body, meta }, runDir, args) {
  const st = { journal: runDir.journal, phase: null, callCounts: new Map(), askCounts: new Map(), publishedCount: 0, noteReads: 0, replayed: 0 };
  runDir.st = st;
  const facade = buildFacade(runDir, st);
  // The wall is the realm, not the spelling. `codeGeneration: { strings: false }` refuses runtime
  // string-to-code inside this context (so `Reflect.get(f, 'constructor')('return Date')()` can no
  // longer reach the real clock), but it only governs *that* realm: a host function handed to the
  // script still exposes the host realm's Function two hops away, and
  // `Reflect.get(Reflect.get(agent, 'constructor'), 'constructor')('return process')()` runs in the
  // engine's own process — measured before this existed. So nothing host-realm may cross: the facade
  // and the script data are rebuilt as context values by BRIDGE, which keeps the raw host bindings
  // in a closure the script cannot name (the same trick that hides `__real` from the shim).
  // Rebuild means CLONE, not JSON: a JSON round trip threw "Do not know how to serialize a BigInt"
  // out of a thunk and killed the run (A26), and it silently turned `undefined` into `null`. Cloning
  // copies primitives by identity (so undefined/NaN/Infinity/-0 keep their exact value) and builds
  // containers with this realm's constructors; a value it cannot rebuild fails the one call that
  // returned it, naming the type, and the run goes on.
  const ctx = vm.createContext({}, { name: 'workflow', codeGeneration: { strings: false } });
  const BRIDGE = `(host) => {
  const msg = (e) => (e && e.message ? String(e.message) : String(e));
  const rebuild = (v) => {
    const t = typeof v;
    if (t === 'function' || t === 'bigint' || t === 'symbol') throw new Error('a ' + t + ' value cannot cross the workflow boundary: return JSON-safe data (string, number, boolean, null, array, plain object)');
    if (v === null || t !== 'object') return v;
    if (Array.isArray(v)) { const a = []; for (let i = 0; i < v.length; i++) a[i] = rebuild(v[i]); return a; }
    const tag = Object.prototype.toString.call(v);
    if (tag !== '[object Object]') throw new Error('a ' + tag.slice(8, -1) + ' value cannot cross the workflow boundary: return JSON-safe data (string, number, boolean, null, array, plain object)');
    const o = {};
    for (const k of Object.keys(v)) o[k] = rebuild(v[k]);
    return o;
  };
  // A rejection carries its reason by prototype, so a host Error handed straight to the script is
  // the host realm's Function one hop away (A24 route 4): every error here is rebuilt in this realm.
  const call = async (fn) => { try { return rebuild(await fn()); } catch (e) { throw new Error(msg(e)); } };
  const sync = (fn) => { try { return rebuild(fn()); } catch (e) { throw new Error(msg(e)); } };
  // parallel()/pipeline() answer one slot per thunk, so an unbuildable value fails that slot as
  // data instead of rejecting the batch the run is waiting on.
  const slot = (v) => { try { return rebuild(v); } catch (e) { return { ok: false, error: msg(e) }; } };
  const fan = async (fn) => {
    let v;
    try { v = await fn(); } catch (e) { throw new Error(msg(e)); }
    const a = [];
    for (let i = 0; i < v.length; i++) a[i] = slot(v[i]);
    return a;
  };
  agent = (...a) => call(() => host.agent(...a));
  ask = (...a) => call(() => host.ask(...a));
  publish = (...a) => sync(() => host.publish(...a));
  parallel = (...t) => fan(() => host.parallel(...t));
  pipeline = (...s) => fan(() => host.pipeline(...s));
  notes = () => sync(() => host.notes());
  phase = (n) => sync(() => host.phase(n));
  log = (m) => sync(() => host.log(m));
  args = rebuild(host.args);
  meta = rebuild(host.meta);
}`;
  new vm.Script(BRIDGE, { filename: 'workflow-bridge' }).runInContext(ctx)({ ...facade, args, meta });
  // A script reaching Math.random or a wall-clock read would make journal replay diverge, so
  // those names are shadowed by parameters rather than only rejected by the static check.
  // The real intrinsics stay inside the builder IIFE: naming them outside it left `__real` in the
  // script's own lexical scope, which is a one-hop bypass of everything the shim exists to stop.
  const shim = [
    'const __shim = (() => {',
    '  const __real = { Date, Math };',
    '  const __deny = (what) => { throw new Error(what + " is disabled in workflows: a resumed run must replay identically. Feed time and variation in through args."); };',
    '  const __math = Object.freeze({ ...Object.fromEntries(Object.getOwnPropertyNames(__real.Math).filter((k) => k !== "random").map((k) => [k, __real.Math[k]])), random: () => __deny("Math.random()") });',
    '  class __Clock { constructor(...a) { if (!a.length) __deny("argless new Date()"); return new __real.Date(...a); } static now() { __deny("Date.now()"); } static parse(t) { return __real.Date.parse(t); } static UTC(...a) { return __real.Date.UTC(...a); } }',
    '  return { math: __math, Clock: __Clock };',
    '})();',
    '(async (Math, Date, performance, fetch, WebAssembly) => {',
    body,
    '\n})(__shim.math, __shim.Clock, undefined, undefined, undefined);',
  ].join('\n');
  const code = new vm.Script(shim, { filename: runDir.scriptPath || 'workflow.js' });
  return code.runInContext(ctx, runDir.scriptTimeoutMs ? { timeout: runDir.scriptTimeoutMs } : undefined);
}

function newRunId(name) {
  const slug = safeName(name) ? name : 'run';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${slug}-${stamp}-${Math.floor(Math.random() * 46656).toString(36)}`;
}

function makeRunDir({ cwd, runId, backend, concurrency, maxAgentCalls, quiet, scriptTimeoutMs, hostSession = null }) {
  const dir = path.join(cwd, RUNS_DIR, runId);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  const journal = new Journal(dir);
  // progress.json: a small always-current summary of the run for live dashboards (the DSH
  // plugin's sidebar line and run card read this instead of tailing the whole journal).
  const progress = { runId, hostSession, name: null, cwd, cwdBase: path.basename(cwd), backend, status: 'running', currentPhase: null, phases: [], calls: [], dispatched: 0, settled: 0, failed: 0, rejected: 0, notesDelivered: 0, logs: [], questions: [], artifacts: [], startedAt: new Date().toISOString(), finishedAt: null, updatedAt: null };
  const phaseOf = (name) => {
    let p = progress.phases.find((x) => x.name === name);
    if (!p) { p = { name, dispatched: 0, settled: 0, failed: 0, rejected: 0 }; progress.phases.push(p); }
    return p;
  };
  const writeProgress = () => {
    try {
      progress.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ ...progress, calls: progress.calls.slice(-400) }));
    } catch {}
  };
  const baseAppend = journal.append.bind(journal);
  const ref = { r: null };
  journal.append = (ev) => {
    if (!ev.ts) ev.ts = new Date().toISOString();
    baseAppend(ev);
    try {
      if (ev.type === 'run_started') progress.status = 'running';
      else if (ev.type === 'phase') { progress.currentPhase = ev.name; phaseOf(ev.name); }
      else if (ev.type === 'agent_dispatch') { progress.dispatched++; phaseOf(ev.phase).dispatched++; progress.calls.push({ callId: ev.callId, label: ev.label, phase: ev.phase, state: 'running', startedAt: ev.ts }); }
      else if (ev.type === 'agent_result') { progress.settled++; if (ev.ok === false) progress.failed++; phaseOf(ev.phase).settled++; if (ev.ok === false) phaseOf(ev.phase).failed++; const call = [...progress.calls].reverse().find((c) => c.callId === ev.callId); if (call) { call.state = ev.ok === false ? 'failed' : 'done'; call.settledAt = ev.ts; if (call.startedAt) call.durationMs = Date.parse(ev.ts) - Date.parse(call.startedAt); const usage = ev.result && typeof ev.result.usage === 'object' && ev.result.usage ? ev.result.usage : null; if (usage) call.usage = { input: Number(usage.input) || 0, output: Number(usage.output) || 0 }; const text = ev.result && typeof ev.result.text === 'string' ? ev.result.text : null; if (text) call.preview = text.slice(0, 160); else if (ev.ok === false && ev.result && ev.result.error) call.preview = String(ev.result.error).slice(0, 160); } }
      else if (ev.type === 'agent_replay') { const call = [...progress.calls].reverse().find((c) => c.callId === ev.callId); if (call) call.state = 'replayed'; else progress.calls.push({ callId: ev.callId, label: ev.label, phase: ev.phase, state: 'replayed' }); }
      else if (ev.type === 'agent_rejected') { progress.rejected++; phaseOf(ev.phase).rejected++; progress.calls.push({ callId: ev.callId, label: ev.label, phase: ev.phase, state: 'rejected', reason: String(ev.reason || 'unknown') }); }
      else if (ev.type === 'notes') progress.notesDelivered += (ev.ids || []).length;
      else if (ev.type === 'log') { progress.logs.push({ ts: ev.ts, text: String(ev.text) }); if (progress.logs.length > 50) progress.logs.shift(); }
      else if (ev.type === 'ask_dispatch') { progress.questions.push({ qId: ev.qId, question: ev.question, state: 'waiting', askedAt: ev.ts, answeredAt: null, answerPreview: null }); }
      else if (ev.type === 'ask_result') { const q = [...progress.questions].reverse().find((x) => x.qId === ev.qId); if (q) { q.state = ev.ok === false ? 'failed' : 'answered'; q.answeredAt = ev.ts; q.answerPreview = ev.ok === false ? String(ev.error || '').slice(0, 200) : String(ev.answer || '').slice(0, 200); } }
      else if (ev.type === 'ask_replay') { progress.questions.push({ qId: ev.qId, question: ev.question, state: 'answered', askedAt: ev.ts, answeredAt: ev.ts, answerPreview: String(ev.answer || '').slice(0, 200) }); }
      else if (ev.type === 'artifact') { if (ev.primary) for (const a of progress.artifacts) a.primary = false; const existing = progress.artifacts.find((a) => a.id === ev.id); const row = { id: ev.id, title: ev.title, kind: ev.kind, path: ev.path ?? null, url: ev.url ?? null, text: ev.text ?? null, primary: ev.primary === true, publishedAt: ev.ts }; if (existing) Object.assign(existing, row); else progress.artifacts.push(row); }
      else if (ev.type === 'run_completed') { progress.status = 'completed'; progress.finishedAt = ev.ts || new Date().toISOString(); }
      else if (ev.type === 'run_failed') { progress.status = 'failed'; progress.finishedAt = ev.ts || new Date().toISOString(); }
      else if (ev.type === 'run_cancelled') { progress.status = 'cancelled'; progress.finishedAt = ev.ts || new Date().toISOString(); }
      if (ref.r && ref.r.state && ref.r.state.name) progress.name = ref.r.state.name;
      const tok = { input: 0, output: 0 };
      for (const c of progress.calls) if (c.usage) { tok.input += c.usage.input; tok.output += c.usage.output; }
      progress.tokens = tok;
      progress.elapsedMs = Date.parse(progress.finishedAt || new Date().toISOString()) - Date.parse(progress.startedAt);
      writeProgress();
    } catch {}
  };
  const runDir = {
    dir,
    runId,
    cwd,
    backend,
    concurrency,
    maxAgentCalls,
    scriptTimeoutMs,
    journal,
    startSeq: journal.seq,
    pending: new Map(),
    children: new Set(),
    quiet,
    state: {},
    cancelled: () => fs.existsSync(path.join(dir, 'CANCEL')),
  };
  ref.r = runDir;
  return runDir;
}

async function loadSource(cwd, flags) {
  if (flags.saved) {
    const found = findSaved(cwd, String(flags.saved), flags.scope ? String(flags.scope) : undefined);
    if (!found.ok) {
      const err = new Error(found.reason === 'not_found' ? found.detail : `${found.reason}: ${found.detail}`);
      err.stage = 'source';
      throw err;
    }
    return { ...found, scriptPath: found.path };
  }
  if (flags.script !== undefined || flags._[0]) {
    let file;
    // `--script` takes a path, inline content or `-` for stdin. A value that names an existing file
    // is a path: writing it out as script content used to turn `run --script q.js` into a draft whose
    // body was the string "q.js", and broke `resume --script <path>` with it.
    const sv = flags.script;
    const svPath = sv === undefined || sv === '-' || sv === true ? null : path.resolve(cwd, String(sv));
    if (svPath && fs.existsSync(svPath)) {
      file = svPath;
    } else if (sv !== undefined) {
      const text = sv === '-' || sv === true ? await readStdin() : String(sv);
      const dir = path.join(cwd, DRAFTS_DIR);
      await fsp.mkdir(dir, { recursive: true });
      file = path.join(dir, `inline-${new Date().toISOString().replace(/[:.]/g, '')}.js`);
      await fsp.writeFile(file, text);
    } else {
      file = path.resolve(cwd, String(flags._[0]));
    }
    if (!fs.existsSync(file)) {
      const err = new Error(`script not found: ${file}`);
      err.stage = 'source';
      throw err;
    }
    const parsed = analyzeFile(file);
    return { ...parsed, src: parsed.src, scriptPath: file };
  }
  const err = new Error('nothing to run: pass <script.js>, --script <path|->, or --saved <name>');
  err.stage = 'source';
  throw err;
}

// C4 helpers: read the caller's args the way cmdRun will, and compare them the way a person reads
// them (top-level key order is not a difference). givenArgs returns undefined for input cmdRun's
// own args stage already knows how to report, so it never competes with that message.
function givenArgs(cwd, flags) {
  try {
    const raw = flags['args-file'] !== undefined ? fs.readFileSync(path.resolve(cwd, String(flags['args-file'])), 'utf8') : String(flags.args);
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ponytail: sorts the top level only, so a re-ordered object *inside* an arg reads as different and
// costs the caller one --force. Sorting recursively would be more code than the case deserves.
function argsKey(o) {
  try {
    return JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));
  } catch {
    return String(o);
  }
}

function validHostSession(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ((value.host === 'dsh' && value.source === 'native-shell') || (value.host === 'mmx' && value.source === 'native-hook'))
    && typeof value.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.sessionId)
    && Object.keys(value).every((key) => ['host', 'sessionId', 'source'].includes(key));
}
function callerHostSession(flags) {
  let value = null;
  if (flags['host-session'] !== undefined) {
    const token = flags['host-session'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error('invalid --host-session');
    try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new Error('invalid --host-session JSON'); }
    if (!validHostSession(value) || value.host !== 'mmx') throw new Error('invalid native hook session');
  }
  if (process.env.DSH_SESSION_ID !== undefined) {
    const native = { host: 'dsh', sessionId: process.env.DSH_SESSION_ID, source: 'native-shell' };
    if (!validHostSession(native)) throw new Error('invalid native DSH_SESSION_ID');
    if (value) throw new Error('conflicting native session sources');
    value = native;
  }
  return value;
}

async function cmdRun(flags, preservedOrigin) {
  let hostSession;
  try {
    hostSession = preservedOrigin ? preservedOrigin.hostSession : callerHostSession(flags);
    if (hostSession !== null && !validHostSession(hostSession)) throw new Error('invalid stored host session');
  } catch (e) {
    print({ ok: false, stage: 'session', error: e.message });
    process.exitCode = 2;
    return;
  }
  const cwd = path.resolve(flags.cwd || process.cwd());
  const backend = String(flags.backend || process.env.QODER_WF_BACKEND || 'cli');
  if (!['cli', 'file', 'echo'].includes(backend)) die(`unknown --backend "${backend}" (cli | file | echo)`);
  let loaded;
  try {
    loaded = await loadSource(cwd, flags);
  } catch (e) {
    print({ ok: false, stage: e.stage || 'source', error: e.message });
    process.exitCode = 2;
    return;
  }
  const errs = errorsOf(loaded.diags);
  if (errs.length) {
    print({ ok: false, stage: 'check', scriptPath: loaded.scriptPath, meta: loaded.meta, diagnostics: loaded.diags });
    process.exitCode = 2;
    return;
  }
  let given = {};
  try {
    if (flags.args) given = typeof flags.args === 'string' ? JSON.parse(flags.args) : flags.args;
    if (flags['args-file']) given = JSON.parse(fs.readFileSync(path.resolve(cwd, String(flags['args-file'])), 'utf8'));
  } catch (e) {
    print({ ok: false, stage: 'args', error: 'args could not be parsed as JSON: ' + e.message });
    process.exitCode = 2;
    return;
  }
  const v = validateArgs(loaded.meta?.args || {}, given);
  if (!v.ok) {
    print({ ok: false, stage: 'args', errors: v.errors, declared: loaded.meta?.args || {}, given });
    process.exitCode = 2;
    return;
  }

  const runId = String(flags['run-id'] || newRunId(flags.name || loaded.meta?.name || path.basename(loaded.scriptPath, '.js')));
  if (!safeName(runId)) die(`invalid --run-id "${runId}"`);
  const runName = String(flags.name || loaded.meta?.name || path.basename(loaded.scriptPath, '.js'));
  const confirmation = confirmationFor(cwd, { name: runName, src: loaded.src, flags });
  const runDir = makeRunDir({
    cwd,
    hostSession,
    runId,
    backend,
    concurrency: clampInt(flags.concurrency ?? process.env.QODER_WF_MAX_CONCURRENCY, 1, 32, 8),
    maxAgentCalls: clampInt(flags['max-calls'], 1, 100000, 500),
    quiet: Boolean(flags.quiet),
    scriptTimeoutMs: flags['script-timeout'] ? clampInt(flags['script-timeout'], 1000, 86400000, 0) : undefined,
  });
  const prev = loadRun(cwd, runId);
  if (prev.ok && prev.inFlight && prev.alive)
    return reject('run', {
      runId,
      stage: 'run',
      reason: `run ${runId} is still going (pid ${prev.state.pid}, started ${prev.state.startedAt})`,
      hint: `a second process on one journal would interleave calls; run \`wf.mjs stop ${runId}\` and wait for it to settle, then resume`,
    });
  // The liveness read above is not atomic against a simultaneous sibling, so take the exclusive
  // claim before deleting anything another lifecycle may already be using (R3B-07).
  const claim = claimOwnership(runDir);
  if (!claim.ok)
    return reject('run', { runId, stage: 'run', reason: claim.reason, hint: claim.busy ? `pid ${claim.busy} claimed ${runId} in the window between the check and the wipe; run \`wf.mjs stop ${runId}\` if that process is yours` : 'run the command again' });
  // Nothing is alive on this run id, so this lifecycle owns it: a leftover CANCEL would kill the
  // new run at its first agent() call, a leftover out.json tells the host it already finished, and
  // a leftover answer/pending entry from the dead process would be taken as this run's.
  for (const control of ['CANCEL', 'out.json']) fs.rmSync(path.join(runDir.dir, control), { force: true });
  for (const sub of ['inbox', 'pending']) {
    fs.rmSync(path.join(runDir.dir, sub), { recursive: true, force: true });
    fs.mkdirSync(path.join(runDir.dir, sub), { recursive: true });
  }
  await flushPendingIndex(runDir);
  runDir.scriptPath = loaded.scriptPath;
  writeState(runDir, {
    runId,
    hostSession,
    name: runName,
    status: 'running',
    backend,
    cwd,
    pid: process.pid,
    scriptPath: loaded.scriptPath,
    args: v.args,
    confirmation,
    concurrency: runDir.concurrency,
    maxAgentCalls: runDir.maxAgentCalls,
    startedAt: new Date().toISOString(),
  });
  runDir.journal.append({ type: 'run_started', runId, hostSession, scriptPath: loaded.scriptPath, backend, args: v.args });
  progress(runDir, `run=${runId} backend=${backend} dir=${runDir.dir}`);
  if (confirmation.required)
    progress(runDir, `confirmation=required basis=${confirmation.basis} — show ${loaded.scriptPath} and get the user's go-ahead, or run \`wf.mjs trust ${runName}\` to skip this step next time`);

  let value;
  let failure = null;
  try {
    value = await runScript(loaded, runDir, v.args);
  } catch (e) {
    failure = e;
  }
  // agent() failures are data, not thrown errors, so a script whose every call failed used to
  // settle "completed" with exit 0 while `status` computed failed=N from the same journal (A16).
  // If nothing on this run's record ever settled ok, the run did not do its work: say so.
  const counts = summariseJournal(runDir.dir);
  const okSettled = counts.settled - counts.failed;
  if (!failure && !runDir.cancelled() && counts.dispatched + counts.rejected > 0 && okSettled === 0) {
    failure = new Error(counts.dispatched
      ? `every agent call failed (${counts.dispatched}): ${counts.firstError}`
      : `every agent call was refused before dispatch (${counts.rejected}, first reason: ${counts.firstReject || 'unknown'}) — fix the ${counts.firstReject === 'budget' ? 'call budget' : 'prompts'} or shrink the fan-out`);
  }
  let status = failure ? (runDir.cancelled() ? 'cancelled' : 'failed') : runDir.cancelled() ? 'cancelled' : 'completed';
  const segmentCalls = runDir.journal.seq - runDir.startSeq;
  const out = {
    runId,
    hostSession,
    name: runDir.state.name,
    status,
    backend,
    dir: runDir.dir,
    scriptPath: loaded.scriptPath,
    args: v.args,
    confirmation,
    // C1: one meaning per name. `agentCalls` is this lifecycle's new dispatches (`segmentCalls` says
    // the same thing out loud); the Dispatched/Settled/Failed/Rejected family is the whole run,
    // counted from the journal, on every surface that reports it.
    agentCalls: segmentCalls,
    segmentCalls,
    agentDispatched: counts.dispatched,
    agentSettled: counts.settled,
    agentFailed: counts.failed,
    agentRejected: counts.rejected,
    replayedCalls: runDir.st ? runDir.st.replayed : 0,
    // The warning must name the reason the journal recorded: after A31 a refusal can be a prompt
    // that is too large, and blaming the call budget for that would be the same wrong-cause report
    // A28 exists to stop.
    ...(counts.rejected
      ? {
          warnings: [
            counts.firstReject === 'budget'
              ? `agent() call budget exhausted after ${counts.dispatched} of ${counts.dispatched + counts.rejected} planned calls: ${counts.rejected} call(s) were refused and never dispatched`
              : `agent() call(s) refused (${counts.firstReject}): ${counts.rejected} of ${counts.dispatched + counts.rejected} planned calls were never dispatched`,
          ],
        }
      : {}),
    ...(failure ? { error: failure.message, stack: String(failure.stack || '').split('\n').slice(0, 5).join('\n') } : { result: value }),
  };
  // A circular or BigInt return value is not the reason to leave state.json stuck at "running":
  // settle as failed with the serialization complaint instead of throwing before the terminal write.
  let outText;
  try {
    outText = JSON.stringify(out, null, 2);
  } catch (e) {
    failure = new Error(`the script return value is not JSON-serializable: ${e.message}`);
    status = 'failed';
    delete out.result;
    Object.assign(out, { status, error: failure.message });
    outText = safeStringify(out);
  }
  await fsp.writeFile(path.join(runDir.dir, 'out.json'), outText);
  // B3: a terminal run's summary stops changing, so `status` can read it from here instead of
  // re-parsing the whole journal per run.
  writeState(runDir, {
    status,
    finishedAt: new Date().toISOString(),
    agentDispatched: counts.dispatched,
    agentSettled: counts.settled,
    agentFailed: counts.failed,
    agentRejected: counts.rejected,
    phases: counts.phases,
    notesDelivered: counts.delivered,
  });
  runDir.journal.append({ type: status === 'completed' ? 'run_completed' : 'run_' + status, runId, status, error: failure?.message });
  for (const child of runDir.children) child.kill('SIGTERM');
  print(withResultPreview(out));
  if (failure) process.exitCode = 1;
}

async function cmdResume(flags) {
  if (flags['host-session'] !== undefined) return reject('resume', { stage: 'session', reason: 'resume preserves the original host session; --host-session cannot reassign it' });
  const cwd = path.resolve(flags.cwd || process.cwd());
  const runId = flags._[0];
  if (!runId) die('usage: wf.mjs resume <runId> [--script <path>]');
  const found = loadRun(cwd, runId);
  if (!found.ok) return reject('resume', { runId, stage: 'resume', reason: found.reason, ...(found.knownRuns?.length ? { knownRuns: found.knownRuns } : {}) });
  const prev = found.state;
  if (found.inFlight && found.alive)
    return reject('resume', {
      runId,
      stage: 'resume',
      reason: `run ${runId} is still going (pid ${prev.pid}, started ${prev.startedAt})`,
      hint: `a second process on one journal would interleave calls; run \`wf.mjs stop ${runId}\` and wait for it to settle, then resume`,
    });
  // Same window as cmdRun: the check above is a read, so claim exclusively before touching the run.
  const claim = claimOwnership({ dir: found.dir, runId });
  if (!claim.ok)
    return reject('resume', { runId, stage: 'resume', reason: claim.reason, hint: claim.busy ? `pid ${claim.busy} is on ${runId} right now; run \`wf.mjs stop ${runId}\` if that process is yours` : 'run the command again' });
  const script = flags.script || prev.scriptPath;
  if (!script || !fs.existsSync(path.resolve(cwd, script)))
    return reject('resume', {
      runId,
      stage: 'resume',
      reason: `the script this run executed is not readable (${prev.scriptPath || 'no path was recorded'})`,
      hint: `pass --script <path> to resume against a replacement script; calls already in the journal replay, new ones dispatch`,
    });
  if (found.stale) process.stderr.write(`wf: pid ${prev.pid} is gone; resuming ${runId} from its journal\n`);
  // C4: answers are cached by call position, so changing the args under a resume shifts `nth` and
  // replays an answer to a different question — and used to rewrite the recorded args, so the run
  // history denied it happened. Refuse, name what is stored, and let --force override.
  if (flags.args !== undefined || flags['args-file'] !== undefined) {
    const given = givenArgs(cwd, flags);
    if (given !== undefined && argsKey(given) !== argsKey(prev.args || {}) && !flags.force)
      return reject('resume', {
        runId,
        stage: 'resume',
        reason: `the args differ from the ones ${runId} was started with: recorded ${argsKey(prev.args || {})}, passed ${argsKey(given)}`,
        hint: 'cached answers are keyed by call position, so new args can replay an answer to a different question; resume without --args to keep the recorded ones, or with --force to accept the new ones',
      });
  } else flags.args = JSON.stringify(prev.args || {});
  flags._ = [path.resolve(cwd, script)];
  flags['run-id'] = runId;
  flags.name = prev.name;
  await cmdRun(flags, { hostSession: prev.hostSession ?? null });
}

async function cmdCheck(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (!flags._[0]) die('usage: wf.mjs check <script.js> [--args JSON]');
  const file = path.resolve(cwd, String(flags._[0]));
  if (!fs.existsSync(file)) die(`script not found: ${file}`);
  const parsed = analyzeFile(file);
  let args = null;
  try {
    if (flags.args) args = validateArgs(parsed.meta?.args || {}, typeof flags.args === 'string' ? JSON.parse(flags.args) : flags.args);
  } catch (e) {
    print({ ok: false, stage: 'args', errors: ['args could not be parsed as JSON: ' + e.message] });
    process.exitCode = 2;
    return;
  }
  const ok = errorsOf(parsed.diags).length === 0 && (!args || args.ok);
  print({ ok, file, meta: parsed.meta, diagnostics: parsed.diags, ...(args ? { args } : {}) });
  if (!ok) process.exitCode = 2;
}

async function cmdSave(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (!flags._[0]) die('usage: wf.mjs save <script.js> --name <name> [--scope project|global] [--overwrite]');
  const file = path.resolve(cwd, String(flags._[0]));
  const parsed = analyzeFile(file);
  if (errorsOf(parsed.diags).length) {
    print({ ok: false, stage: 'check', file, diagnostics: parsed.diags });
    process.exitCode = 2;
    return;
  }
  const name = String(flags.name || parsed.meta?.name || '');
  if (!safeName(name)) die(`invalid workflow name "${name}": letters, digits, ".", "-", "_" only, max 64 chars`);
  const scope = String(flags.scope || 'project');
  if (!['project', 'global'].includes(scope)) die('--scope must be project or global');
  const target = path.join(savedDirs(cwd).find((d) => d.scope === scope).dir, name + '.js');
  if (fs.existsSync(target) && !flags.overwrite) die(`${target} already exists (pass --overwrite)`);
  const meta = {
    name,
    description: String(flags.description || parsed.meta?.description || name),
    ...(flags['when-to-use'] || parsed.meta?.whenToUse ? { whenToUse: String(flags['when-to-use'] || parsed.meta.whenToUse) } : {}),
    ...(parsed.meta?.args && Object.keys(parsed.meta.args).length ? { args: parsed.meta.args } : {}),
  };
  const rest = parsed.metaStatement ? parsed.src.slice(parsed.metaStatement.end) : parsed.src;
  const text = `export const meta = ${JSON.stringify(meta, null, 2)};\n${rest}`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text);
  const recheck = analyzeFile(target);
  const reErrors = errorsOf(recheck.diags);
  print({ ok: reErrors.length === 0, name, scope, path: target, roundtrip: reErrors.length === 0, ...(reErrors.length ? { diagnostics: recheck.diags } : {}) });
  if (reErrors.length) process.exitCode = 1;
}

async function cmdList(flags) {
  print({ cwd: path.resolve(flags.cwd || process.cwd()), ...listSaved(path.resolve(flags.cwd || process.cwd())) });
}

// The run rows behind `status` — also the /api/runs feed of `wf.mjs ui`, so the CLI and the
// dashboard can never disagree about what a run is. Returns null when there is no runs root yet.
function collectRuns(cwd, onlyId) {
  const root = path.join(cwd, RUNS_DIR);
  if (!fs.existsSync(root)) return null;
  const ids = onlyId ? [String(onlyId)] : fs.readdirSync(root).sort();
  const runs = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    const found = loadRun(cwd, id);
    // A run folder that cannot be summarised still gets a row: hiding it is how an in-flight or
    // half-written run disappears from the list exactly when it is the thing you need to find.
    if (!found.ok) {
      runs.push({ runId: id, status: found.dir && fs.existsSync(found.dir) ? 'untracked' : 'missing', dir: found.dir ?? null, reason: found.reason });
      continue;
    }
    const st = found.state;
    // B3: a terminal run's summary cannot move any more, and cmdRun wrote it into state.json, so a
    // list of 200 finished runs no longer re-reads 200 journals. An older state.json (or a run still
    // in flight) falls back to the journal, which is the live record.
    const summary = TERMINAL.has(st.status) && Number.isInteger(st.agentDispatched)
      ? { dispatched: st.agentDispatched, settled: st.agentSettled ?? 0, failed: st.agentFailed ?? 0, rejected: st.agentRejected ?? 0, delivered: st.notesDelivered ?? 0, phases: Array.isArray(st.phases) ? st.phases : [] }
      : summariseJournal(dir);
    const queued = readSteerNotes(dir).length;
    const pf = path.join(dir, 'pending.json');
    let outstanding = [];
    try {
      if (fs.existsSync(pf)) outstanding = JSON.parse(fs.readFileSync(pf, 'utf8')).items.map((i) => ({ callId: i.callId, phase: i.phase, label: i.label }));
    } catch (e) {
      outstanding = [{ callId: '(unreadable)', label: `pending.json could not be parsed: ${e.message}` }];
    }
    const script = st.scriptPath ? path.resolve(cwd, st.scriptPath) : null;
    const hasScript = Boolean(script && fs.existsSync(script));
    let blocked = null;
    if (found.inFlight && found.alive) blocked = `pid ${st.pid} is still on it${outstanding.length ? `, waiting on ${outstanding.length} call(s)` : ''}`;
    else if (!hasScript) blocked = `its script (${st.scriptPath || 'no path was recorded'}) is gone; resume needs --script <path>`;
    const run = {
      runId: st.runId,
      hostSession: st.hostSession ?? null,
      name: st.name,
      status: found.stale ? 'stale' : st.status,
      recordedStatus: st.status,
      backend: st.backend,
      pid: st.pid ?? null,
      startedAt: st.startedAt ?? null,
      processAlive: found.alive,
      agentDispatched: summary.dispatched,
      agentSettled: summary.settled,
      agentFailed: summary.failed,
      agentRejected: summary.rejected,
      steerQueued: queued,
      // C5: steerQueued is every note the file holds, which reads like a backlog. This is the part
      // of it no script has picked up yet.
      steerDelivered: summary.delivered,
      steerUndelivered: Math.max(0, queued - summary.delivered),
      phases: summary.phases,
      outstanding,
      resumable: !blocked,
      ...(blocked ? { resumableReason: blocked } : {}),
      dir,
    };
    if (found.stale) run.staleReason = `status says ${st.status} but pid ${st.pid} is not running, so nothing will pick the run up`;
    if (onlyId) {
      run.scriptPath = st.scriptPath;
      run.args = st.args;
      run.confirmation = st.confirmation ?? null;
      run.startedAt = st.startedAt;
      run.finishedAt = st.finishedAt ?? null;
      const of_ = path.join(dir, 'out.json');
      run.out = null;
      // out.json is written in one shot, but a host that crashed mid-write can leave a torn one,
      // and losing the whole status row over it is worse than saying it is unreadable.
      try {
        if (fs.existsSync(of_)) run.out = JSON.parse(fs.readFileSync(of_, 'utf8'));
      } catch (e) {
        run.outError = `out.json could not be parsed: ${e.message}`;
      }
    }
    runs.push(run);
  }
  return runs;
}

async function cmdStatus(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const runs = collectRuns(cwd, flags._[0]);
  if (runs === null) {
    print({ cwd, runs: [], note: `no runs yet under ${path.join(cwd, RUNS_DIR)}` });
    return;
  }
  print({ cwd, runs });
}

async function cmdResult(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (!flags._[0]) die('usage: wf.mjs result <runId>');
  const runId = String(flags._[0]);
  const f = safeName(runId) ? path.join(cwd, RUNS_DIR, runId, 'out.json') : null;
  if (fs.existsSync(f)) {
    process.stdout.write(fs.readFileSync(f, 'utf8'));
    return;
  }
  const found = loadRun(cwd, runId);
  if (!found.ok) die(found.reason);
  die(found.inFlight ? `run ${runId} has no result yet: pid ${found.state.pid} is still going` : `run ${runId} is ${found.state.status} but wrote no out.json (the process died mid-settle)`);
}

async function cmdStop(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (!flags._[0]) die('usage: wf.mjs stop <runId> [--force]');
  const runId = String(flags._[0]);
  const found = loadRun(cwd, runId);
  if (!found.ok) return reject('stop', { runId, reason: found.reason, ...(found.knownRuns?.length ? { knownRuns: found.knownRuns } : {}) });
  const st = found.state;
  const dir = found.dir;
  if (TERMINAL.has(st.status))
    return reject('stop', { runId, reason: `run ${runId} already ${st.status}${st.finishedAt ? ` at ${st.finishedAt}` : ''}`, status: st.status, hint: 'use `wf.mjs resume` to replay it, or `wf.mjs result` to read the output' });
  if (st.status === 'cancelling' && !flags.force)
    return reject('stop', { runId, reason: `cancellation was already requested at ${st.stopRequestedAt || 'an earlier time'}`, status: st.status, hint: 'the run settles at its next agent boundary; pass --force to write CANCEL again' });
  const now = new Date().toISOString();
  // cmdRun writes out.json before state.json, so the snapshot loaded above can already be behind
  // the run: re-read both at write time and never downgrade what they agree on.
  const current = () => {
    let cur = st;
    try {
      cur = JSON.parse(fs.readFileSync(sfOf(dir), 'utf8'));
    } catch {}
    if (TERMINAL.has(cur.status)) return cur;
    try {
      const settled = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).status;
      if (TERMINAL.has(settled)) return { ...cur, status: settled };
    } catch {}
    return cur;
  };
  await fsp.writeFile(path.join(dir, 'CANCEL'), `stopped at ${now}\n`);
  if (found.stale) {
    // Nobody is left to read CANCEL, so settle the run here instead of leaving it in-flight forever.
    const cur = current();
    const status = TERMINAL.has(cur.status) ? cur.status : 'cancelled';
    const summary = summariseJournal(dir);
    const of_ = path.join(dir, 'out.json');
    if (!fs.existsSync(of_)) {
      await fsp.writeFile(
        of_,
        JSON.stringify(
          // C1: same names, same meanings as cmdRun's out.json — this lifecycle dispatched nothing
          // (there was no lifecycle left), and the run's totals are the cumulative family.
          { runId, name: cur.name, status, backend: cur.backend, dir, scriptPath: cur.scriptPath, args: cur.args || {}, confirmation: cur.confirmation, agentCalls: 0, segmentCalls: 0, agentDispatched: summary.dispatched, agentSettled: summary.settled, agentFailed: summary.failed, agentRejected: summary.rejected, replayedCalls: 0, error: `run stopped: pid ${st.pid} was no longer running, so this command settled the run` },
          null,
          2
        )
      );
    }
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ type: 'run_' + status, runId, status, error: status === 'cancelled' ? 'stopped after the process was found dead' : undefined }) + '\n', { flag: 'a' });
    // R3B-03: the counts have to land in state.json too, or this run is terminal forever without the
    // cached summary and every later `status` re-parses its whole journal (B3's fast path requires
    // Number.isInteger(agentDispatched), which cmdRun's terminal write supplies and this one did not).
    fs.writeFileSync(sfOf(dir), JSON.stringify({
      ...cur,
      status,
      finishedAt: cur.finishedAt ?? now,
      stopRequestedAt: cur.stopRequestedAt ?? now,
      settledBy: 'stop',
      agentDispatched: summary.dispatched,
      agentSettled: summary.settled,
      agentFailed: summary.failed,
      agentRejected: summary.rejected,
      notesDelivered: summary.delivered,
      phases: summary.phases,
    }, null, 2));
    print({ ok: true, runId, cancelled: status === 'cancelled', settled: true, stale: true, status, reason: status === 'cancelled' ? `pid ${st.pid} was gone, so nothing could pick CANCEL up; the run is marked cancelled` : `the run had already settled as ${status} and its own result stands`, dir });
    return;
  }
  const cur = current();
  const status = cur.status === 'running' ? 'cancelling' : cur.status;
  fs.writeFileSync(sfOf(dir), JSON.stringify({ ...cur, status, stopRequestedAt: cur.stopRequestedAt ?? now }, null, 2));
  print({ ok: true, runId, cancelled: true, status, pid: st.pid, dir, effect: 'the run stops at its next agent boundary and writes out.json with status cancelled' });
}

async function cmdSteer(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  if (!flags._[0]) die('usage: wf.mjs steer <runId> "<note>" [--from L]');
  const runId = String(flags._[0]);
  const text = (typeof flags.text === 'string' ? flags.text : flags._.slice(1).join(' ')).trim();
  if (!text) return reject('steer', { runId, reason: 'no note text: wf.mjs steer <runId> "what to change"' });
  if (text.length > STEER_MAX_CHARS) return reject('steer', { runId, reason: `notes are capped at ${STEER_MAX_CHARS} characters (got ${text.length})` });
  const found = loadRun(cwd, runId);
  if (!found.ok) return reject('steer', { runId, reason: found.reason });
  const dir = found.dir;
  if (TERMINAL.has(found.state.status))
    return reject('steer', { runId, reason: `run ${runId} already ${found.state.status}, so no script is left to read the note`, hint: `resume ${runId} first if you want it taken into account` });
  const existing = readSteerNotes(dir);
  if (existing.length >= STEER_MAX_NOTES)
    return reject('steer', { runId, reason: `${dir} already holds ${existing.length} notes (cap ${STEER_MAX_NOTES})`, hint: 'finish or archive the run instead of queueing more' });
  await fsp.appendFile(path.join(dir, 'steer.jsonl'), JSON.stringify({ at: new Date().toISOString(), from: String(flags.from || 'host'), text }) + '\n');
  print({
    ok: true,
    runId,
    queued: existing.length + 1,
    reaches: 'the next notes() call in the script',
    ...(found.alive ? {} : { warning: `pid ${found.state.pid ?? 'unknown'} is gone: the note stays queued until the run is resumed` }),
  });
}

async function cmdTrust(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const name = String(flags._[0] || '');
  if (!safeName(name)) die('usage: wf.mjs trust <name> [--scope project|global] — name must be a saved workflow');
  const found = findSaved(cwd, name, flags.scope ? String(flags.scope) : undefined);
  if (!found.ok) die(`cannot trust "${name}": ${found.reason === 'not_found' ? found.detail : `${found.reason}: ${found.detail}`}`);
  const trust = readTrust(cwd);
  const rec = { name, scope: found.scope, path: found.path, sha256: sha256(found.src), addedAt: new Date().toISOString() };
  trust.workflows[name] = rec;
  writeTrust(cwd, trust);
  print({ ok: true, trusted: true, name, scope: found.scope, path: found.path, sha256: rec.sha256.slice(0, 16), trustFile: trustFile(cwd), note: 'trust expires as soon as the saved script changes' });
}

async function cmdUntrust(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const name = String(flags._[0] || '');
  if (!safeName(name)) die('usage: wf.mjs untrust <name>');
  const trust = readTrust(cwd);
  const was = Boolean(trust.workflows[name]);
  delete trust.workflows[name];
  writeTrust(cwd, trust);
  print({ ok: true, trusted: false, name, was });
}

async function cmdPaths(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const [project, global] = savedDirs(cwd);
  print({
    cwd,
    runs: path.join(cwd, RUNS_DIR),
    savedProject: project.dir,
    savedGlobal: global.dir,
    trustFile: trustFile(cwd),
    homeOverride: process.env.QODER_WF_HOME || null,
    drafts: path.join(cwd, DRAFTS_DIR),
    cliEntry: resolveCliEntry(true),
    node: process.execPath,
    engine: ENGINE_VERSION,
    engineFile: path.join(HERE, 'wf.mjs'),
  });
}

// --- live dashboard (wf.mjs ui) ---------------------------------------------------------------
// The ZCode-native workflow run has a run pane: phases as a timeline, one card per subagent, live
// counts. This engine's equivalent surface is a read-only local page over the same files `status`
// reads — no new state, no writer, nothing the host must keep alive for it.

// Fixed on purpose: a dashboard that drifts to a new port every restart is a dashboard nobody can
// find again. DW = D(4) W(23). A busy port is an error, never a silent hop to another one.
const UI_DEFAULT_PORT = 4230;

function readJournalEvents(dir) {
  const jf = path.join(dir, 'journal.jsonl');
  if (!fs.existsSync(jf)) return [];
  const out = [];
  for (const line of fs.readFileSync(jf, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A killed process can leave a half-written last line; the live tail is still the truth.
    }
  }
  return out;
}

// One row per agent call, plus the phase timeline built from the same journal the CLI counts from.
function runDetail(cwd, runId) {
  const found = loadRun(cwd, runId);
  if (!found.ok) return { ok: false, reason: found.reason };
  const dir = found.dir;
  const st = found.state;
  const summary = TERMINAL.has(st.status) && Number.isInteger(st.agentDispatched)
    ? { dispatched: st.agentDispatched, settled: st.agentSettled ?? 0, failed: st.agentFailed ?? 0, rejected: st.agentRejected ?? 0, delivered: st.notesDelivered ?? 0, phases: Array.isArray(st.phases) ? st.phases : [] }
    : summariseJournal(dir);
  // Parked-right-now is read from two sources on purpose: the index is rewritten in place, so a
  // single read can land mid-write (the same race the host protocol documents for pending.json),
  // while the per-call files under pending/ appear and vanish atomically.
  let parkedIds = new Set();
  try {
    parkedIds = new Set((JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8')).items || []).map((i) => i.callId));
  } catch {}
  try {
    for (const f of fs.readdirSync(path.join(dir, 'pending'))) if (f.endsWith('.json')) parkedIds.add(f.slice(0, -'.json'.length));
  } catch {}
  const phases = [];
  const phaseStats = new Map();
  const statsOf = (name) => {
    if (!phaseStats.has(name)) phaseStats.set(name, { dispatched: 0, settled: 0, failed: 0, rejected: 0 });
    return phaseStats.get(name);
  };
  const calls = [];
  const byId = new Map();
  const logs = [];
  const noteFeeds = [];
  let lastPhase = null;
  for (const ev of readJournalEvents(dir)) {
    if (ev.type === 'phase') {
      if (!phases.includes(ev.name)) phases.push(ev.name);
      lastPhase = ev.name;
    } else if (ev.type === 'log') {
      if (logs.length < 50) logs.push(String(ev.text));
    } else if (ev.type === 'notes') {
      noteFeeds.push({ count: (ev.ids || []).length, texts: (ev.texts || []).map(String) });
    } else if (ev.type === 'agent_dispatch') {
      const c = { callId: ev.callId, seq: ev.seq, phase: ev.phase, label: ev.label, promptPreview: String(ev.prompt || '').slice(0, 200), state: 'running' };
      byId.set(ev.callId, c);
      calls.push(c);
      statsOf(ev.phase).dispatched++;
    } else if (ev.type === 'agent_result') {
      const c = byId.get(ev.callId);
      if (c) {
        c.state = ev.ok === false ? 'failed' : 'done';
        if (ev.ok === false) c.errorPreview = String((ev.result && ev.result.error) || 'agent call failed').slice(0, 200);
        else c.textPreview = String((ev.result && ev.result.text) || '').slice(0, 160);
      }
      statsOf(ev.phase).settled++;
      if (ev.ok === false) statsOf(ev.phase).failed++;
    } else if (ev.type === 'agent_replay') {
      const c = byId.get(ev.callId);
      if (c) c.state = 'replayed';
    } else if (ev.type === 'agent_rejected') {
      calls.push({ callId: ev.callId, phase: ev.phase, label: ev.label, state: 'rejected', reason: String(ev.reason || 'unknown') });
      statsOf(ev.phase).rejected++;
    }
  }
  if (!found.inFlight) {
    for (const c of calls) if (c.state === 'running') c.state = 'lost';
  } else {
    for (const c of calls) if (c.state === 'running') c.state = parkedIds.has(c.callId) ? 'parked' : 'running';
  }
  const of_ = path.join(dir, 'out.json');
  let out = null;
  let outError = null;
  try {
    if (fs.existsSync(of_)) out = JSON.parse(fs.readFileSync(of_, 'utf8'));
  } catch (e) {
    outError = `out.json could not be parsed: ${e.message}`;
  }
  return {
    ok: true,
    runId: st.runId,
    name: st.name,
    status: found.stale ? 'stale' : st.status,
    backend: st.backend,
    pid: st.pid ?? null,
    processAlive: found.alive,
    startedAt: st.startedAt ?? null,
    finishedAt: st.finishedAt ?? null,
    scriptPath: st.scriptPath ?? null,
    counts: { dispatched: summary.dispatched, settled: summary.settled, failed: summary.failed, rejected: summary.rejected, notesDelivered: summary.delivered },
    // `phases` is declaration order (A19); `currentPhase` is the last phase() the script executed.
    phases: phases.map((name) => ({ name, ...statsOf(name) })),
    currentPhase: lastPhase,
    calls,
    logs,
    notes: noteFeeds,
    steer: readSteerNotes(dir).map((n) => ({ id: n.id, at: n.at, from: n.from, text: String(n.text).slice(0, 300) })),
    ...(out
      ? { settled: { status: out.status, error: out.error ?? null, resultPreview: out.result === undefined ? null : safeStringify(out.result).slice(0, 1200), agentCalls: out.agentCalls, replayedCalls: out.replayedCalls, warnings: out.warnings ?? null } }
      : { settled: null }),
    ...(outError ? { outError } : {}),
    dir,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>动态工作流 · 实时看板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #16171a; color: #e6e6e9; font: 13px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #1b1c20; border-bottom: 1px solid #2a2b30; position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .badge { font-size: 11px; color: #9a9ca3; border: 1px solid #33353b; border-radius: 10px; padding: 1px 8px; }
  header .cwd { margin-left: auto; font-size: 11px; color: #6f7278; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
  .conn { width: 8px; height: 8px; border-radius: 50%; background: #34c759; }
  .conn.off { background: #ff453a; }
  .layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; padding: 14px 16px; max-width: 1400px; margin: 0 auto; }
  aside { background: #1b1c20; border: 1px solid #2a2b30; border-radius: 10px; align-self: start; overflow: hidden; }
  aside h2 { font-size: 12px; color: #9a9ca3; margin: 0; padding: 10px 12px 6px; font-weight: 600; }
  .runrow { padding: 8px 12px; border-top: 1px solid #232428; cursor: pointer; }
  .runrow:hover { background: #202126; }
  .runrow.sel { background: #232429; box-shadow: inset 2px 0 0 #4f8ef7; }
  .runrow .nm { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .runrow .id { color: #6f7278; font-size: 11px; }
  .runrow .cnt { color: #9a9ca3; font-size: 11px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.completed, .dot.done { background: #34c759; }
  .dot.running, .dot.cancelling { background: #ff9f0a; animation: pulse 1.6s infinite; }
  .dot.failed { background: #ff453a; }
  .dot.cancelled { background: #8e8e93; }
  .dot.stale { background: #ffd60a; }
  .dot.untracked, .dot.missing { background: #6f7278; }
  main { min-width: 0; }
  .empty { color: #6f7278; padding: 40px 0; text-align: center; }
  .panel { background: #1b1c20; border: 1px solid #2a2b30; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .runhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .runhead h2 { margin: 0; font-size: 16px; }
  .stbadge { font-size: 11px; border-radius: 10px; padding: 2px 10px; border: 1px solid; }
  .stbadge.running, .stbadge.cancelling { color: #ff9f0a; border-color: #ff9f0a; }
  .stbadge.completed { color: #34c759; border-color: #34c759; }
  .stbadge.failed { color: #ff453a; border-color: #ff453a; }
  .stbadge.cancelled { color: #8e8e93; border-color: #8e8e93; }
  .stbadge.stale { color: #ffd60a; border-color: #ffd60a; }
  .meta { color: #6f7278; font-size: 11px; margin-top: 4px; word-break: break-all; }
  .summary { color: #c9cbd1; font-size: 12px; margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
  .summary b { color: #e6e6e9; }
  .phases { display: flex; margin-top: 16px; }
  .ph { flex: 1; text-align: center; position: relative; min-width: 0; }
  .ph::before { content: ""; position: absolute; top: 8px; left: calc(-50% + 16px); width: calc(100% - 32px); height: 2px; background: #33353b; }
  .ph:first-child::before { display: none; }
  .ph.done::before { background: #2e7d46; }
  .ph .d { width: 18px; height: 18px; border-radius: 50%; background: #33353b; margin: 0 auto; position: relative; z-index: 1; }
  .ph.done .d { background: #34c759; }
  .ph.now .d { background: #ff9f0a; animation: pulse 1.6s infinite; }
  .ph .n { margin-top: 6px; font-size: 11px; color: #c9cbd1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ph .c { font-size: 10px; color: #6f7278; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
  .ag { background: #202126; border: 1px solid #2a2b30; border-radius: 8px; padding: 9px 11px; min-width: 0; }
  .ag .top { display: flex; gap: 8px; align-items: center; }
  .avatar { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .ag .lb { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ag .st { font-size: 11px; margin-top: 3px; display: flex; align-items: center; gap: 6px; }
  .ag .pr { color: #6f7278; font-size: 11px; margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .spin { width: 11px; height: 11px; border: 2px solid #4d3313; border-top-color: #ff9f0a; border-radius: 50%; animation: rot 0.8s linear infinite; flex: none; }
  .st.done { color: #34c759; } .st.failed { color: #ff453a; } .st.parked { color: #74a7ff; }
  .st.replayed { color: #5ac8fa; } .st.rejected { color: #c78a7a; } .st.lost { color: #8e8e93; } .st.running { color: #ff9f0a; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { background: #262219; border: 1px solid #4d3f13; color: #ffd60a; border-radius: 8px; padding: 4px 10px; font-size: 11px; }
  .chip.info { background: #1d2430; border-color: #24406e; color: #74a7ff; }
  pre { background: #16171a; border: 1px solid #2a2b30; border-radius: 8px; padding: 10px; overflow: auto; max-height: 260px; font-size: 11px; color: #c9cbd1; white-space: pre-wrap; word-break: break-all; margin: 8px 0 0; }
  details > summary { cursor: pointer; color: #9a9ca3; font-size: 12px; }
  h3.sec { font-size: 12px; color: #9a9ca3; margin: 0 0 10px; font-weight: 600; }
  @keyframes rot { to { transform: rotate(360deg); } }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,159,10,.45); } 70% { box-shadow: 0 0 0 7px rgba(255,159,10,0); } 100% { box-shadow: 0 0 0 0 rgba(255,159,10,0); } }
</style>
</head>
<body>
<header>
  <div class="conn" id="conn"></div>
  <h1>动态工作流 · 实时看板</h1>
  <span class="badge">wf.mjs ${ENGINE_VERSION}</span>
  <span class="badge" id="cwdbadge"></span>
  <span class="cwd" id="cwdpath"></span>
</header>
<div class="layout">
  <aside>
    <h2>运行列表</h2>
    <div id="runs"></div>
  </aside>
  <main id="main"><div class="empty">加载中…</div></main>
</div>
<script>
var SEL = location.hash.replace('#', '');
var RUNS = [];
var CWD = '';
var RUNST = { running: '运行中', cancelling: '取消中', completed: '已完成', failed: '失败', cancelled: '已取消', stale: '已过期', untracked: '未跟踪', missing: '丢失' };
var CALLST = { running: '运行中', parked: '等待应答', done: '已完成', failed: '失败', replayed: '重放命中', rejected: '已拒绝', lost: '中断' };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function hue(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
function rel(iso) {
  if (!iso) return '';
  var t = Date.now() - new Date(iso).getTime();
  if (!(t >= 0)) return '';
  var m = Math.floor(t / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
function el(id) { return document.getElementById(id); }
function renderList() {
  el('cwdbadge').textContent = RUNS.length + ' 个运行';
  el('cwdpath').textContent = CWD;
  var html = '';
  for (var i = 0; i < RUNS.length; i++) {
    var r = RUNS[i];
    html += '<div class="runrow' + (r.runId === SEL ? ' sel' : '') + '" data-id="' + esc(r.runId) + '">' +
      '<div class="nm"><span class="dot ' + esc(r.status) + '"></span>' + esc(r.name || r.runId) + '</div>' +
      '<div class="id">' + esc(r.runId) + ' · ' + esc(RUNST[r.status] || r.status) + ' · ' + rel(r.startedAt) + '</div>' +
      '<div class="cnt">派发 ' + r.agentDispatched + ' · 结算 ' + r.agentSettled + (r.agentFailed ? ' · 失败 ' + r.agentFailed : '') + (r.steerUndelivered ? ' · 待读便条 ' + r.steerUndelivered : '') + '</div></div>';
  }
  if (!html) html = '<div class="empty" style="padding:18px 0">还没有运行</div>';
  el('runs').innerHTML = html;
}
function phaseHtml(d) {
  if (!d.phases.length) return '';
  var html = '<div class="phases">';
  for (var i = 0; i < d.phases.length; i++) {
    var p = d.phases[i];
    var cls = 'ph';
    var settledAll = p.dispatched > 0 && p.settled + p.rejected >= p.dispatched && d.status !== 'running' && d.status !== 'cancelling';
    if (settledAll) cls += ' done';
    else if (p.name === d.currentPhase && (d.status === 'running' || d.status === 'cancelling' || d.status === 'stale')) cls += ' now';
    html += '<div class="' + cls + '"><div class="d"></div><div class="n" title="' + esc(p.name) + '">' + esc(p.name) + '</div><div class="c">' + (p.settled + p.rejected) + '/' + p.dispatched + '</div></div>';
  }
  return html + '</div>';
}
function callHtml(c) {
  var st = '<span class="spin"></span>' + esc(CALLST[c.state] || c.state);
  if (c.state === 'done' || c.state === 'replayed' || c.state === 'failed' || c.state === 'lost' || c.state === 'rejected' || c.state === 'parked') st = esc(CALLST[c.state] || c.state) + (c.reason ? ' · ' + esc(c.reason) : '');
  var sub = c.errorPreview ? esc(c.errorPreview) : c.textPreview ? esc(c.textPreview) : esc(c.promptPreview || '');
  return '<div class="ag"><div class="top"><span class="avatar" style="background:hsl(' + hue(c.callId) + ',55%,52%)"></span><span class="lb" title="' + esc(c.label) + '">' + esc(c.label || c.callId) + '</span></div>' +
    '<div class="st ' + esc(c.state) + '">' + st + '</div>' +
    (sub ? '<div class="pr">' + sub + '</div>' : '') + '</div>';
}
function renderDetail(d) {
  if (!d.ok) { el('main').innerHTML = '<div class="panel"><div class="empty">' + esc(d.reason || '读不到这个运行') + '</div></div>'; return; }
  var inFlight = d.status === 'running' || d.status === 'cancelling';
  var html = '<div class="panel"><div class="runhead"><h2>' + esc(d.name || d.runId) + '</h2>' +
    '<span class="stbadge ' + esc(d.status) + '">' + esc(RUNST[d.status] || d.status) + '</span>' +
    '<span class="badge">' + esc(d.runId) + '</span><span class="badge">' + esc(d.backend) + ' 后端</span>' +
    (d.processAlive ? '<span class="badge">pid ' + esc(d.pid) + ' 存活</span>' : '') + '</div>' +
    '<div class="meta">' + esc(d.scriptPath || '') + (d.startedAt ? ' · 开始于 ' + esc(d.startedAt).replace('T', ' ').slice(0, 19) : '') + (d.finishedAt ? ' · 结束于 ' + esc(d.finishedAt).replace('T', ' ').slice(0, 19) : '') + '</div>' +
    '<div class="summary"><span><b>' + d.phases.length + '</b> 个阶段</span><span><b>' + d.counts.dispatched + '</b> 次派发</span><span><b>' + d.counts.settled + '</b> 次结算</span>' +
    (d.counts.failed ? '<span><b>' + d.counts.failed + '</b> 次失败</span>' : '') + (d.counts.rejected ? '<span><b>' + d.counts.rejected + '</b> 次拒绝</span>' : '') +
    (d.steer && d.steer.length ? '<span>便条 ' + d.steer.length + ' 条</span>' : '') + '</div>' +
    phaseHtml(d) + '</div>';
  html += '<div class="panel"><h3 class="sec">子代理 · ' + d.calls.length + ' 个调用</h3><div class="cards">';
  for (var i = 0; i < d.calls.length; i++) html += callHtml(d.calls[i]);
  html += '</div></div>';
  var chips = '';
  for (var s = 0; s < (d.steer || []).length; s++) chips += '<span class="chip" title="' + esc(d.steer[s].at) + ' 来自 ' + esc(d.steer[s].from) + '">steer：' + esc(d.steer[s].text) + '</span>';
  for (var n = 0; n < (d.notes || []).length; n++) {
    var feed = d.notes[n];
    for (var t = 0; t < feed.texts.length; t++) chips += '<span class="chip info">已投递：' + esc(feed.texts[t]) + '</span>';
  }
  if (chips) html += '<div class="panel"><h3 class="sec">转向便条</h3><div class="chips">' + chips + '</div></div>';
  if (d.logs && d.logs.length) html += '<div class="panel"><details><summary>脚本日志 · ' + d.logs.length + ' 条</summary><pre>' + esc(d.logs.join('\\n')) + '</pre></details></div>';
  if (d.settled || d.outError) {
    html += '<div class="panel"><h3 class="sec">结果</h3>';
    if (d.outError) html += '<div class="meta">' + esc(d.outError) + '</div>';
    if (d.settled) {
      html += '<div class="summary"><span>状态 <b>' + esc(RUNST[d.settled.status] || d.settled.status) + '</b></span>' +
        (d.settled.agentCalls !== undefined ? '<span>本段派发 <b>' + d.settled.agentCalls + '</b></span>' : '') +
        (d.settled.replayedCalls ? '<span>重放 <b>' + d.settled.replayedCalls + '</b></span>' : '') + '</div>';
      if (d.settled.warnings) html += '<div class="chips" style="margin-top:8px">' + d.settled.warnings.map(function (w) { return '<span class="chip">' + esc(w) + '</span>'; }).join('') + '</div>';
      if (d.settled.error) html += '<pre>' + esc(d.settled.error) + '</pre>';
      else if (d.settled.resultPreview) html += '<pre>' + esc(d.settled.resultPreview) + '</pre>';
    }
    html += '</div>';
  }
  html += '<div class="panel"><details><summary>命令</summary><pre>wf.mjs status ' + esc(d.runId) + '\\nwf.mjs steer ' + esc(d.runId) + ' 「调整指令」' + '\\nwf.mjs stop ' + esc(d.runId) + '\\nwf.mjs result ' + esc(d.runId) + '</pre></details></div>';
  el('main').innerHTML = html;
}
async function tick() {
  try {
    var r = await (await fetch('/api/runs')).json();
    RUNS = r.runs || [];
    CWD = r.cwd || '';
    el('conn').classList.remove('off');
    if (!SEL) {
      for (var i = 0; i < RUNS.length; i++) if (RUNS[i].status === 'running' || RUNS[i].status === 'cancelling') { SEL = RUNS[i].runId; break; }
      if (!SEL && RUNS.length) SEL = RUNS[RUNS.length - 1].runId;
    }
    renderList();
    if (SEL) {
      var d = await (await fetch('/api/run/' + encodeURIComponent(SEL))).json();
      renderDetail(d);
    } else el('main').innerHTML = '<div class="empty">还没有运行。用 wf.mjs run 启动一个，这里每 1.2 秒刷新。</div>';
  } catch (e) {
    el('conn').classList.add('off');
  }
}
document.addEventListener('click', function (ev) {
  var row = ev.target.closest && ev.target.closest('.runrow');
  if (row) { SEL = row.getAttribute('data-id'); location.hash = SEL; renderList(); tick(); }
});
setInterval(tick, 1200);
tick();
</script>
</body>
</html>
`;
}

async function cmdUi(flags) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const port = clampInt(flags.port ?? process.env.QODER_WF_UI_PORT, 0, 65535, UI_DEFAULT_PORT);
  const server = http.createServer((req, res) => {
    const send = (code, body, type) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return send(400, JSON.stringify({ ok: false, reason: 'unparseable path' }), 'application/json');
    }
    if (req.method !== 'GET') return send(405, JSON.stringify({ ok: false, reason: 'GET only: the dashboard is read-only' }), 'application/json');
    if (p === '/' || p === '/index.html') return send(200, dashboardHtml(), 'text/html; charset=utf-8');
    if (p === '/api/runs') {
      const runs = collectRuns(cwd, null);
      return send(200, JSON.stringify({ ok: true, cwd, engine: ENGINE_VERSION, runs: runs ?? [] }), 'application/json');
    }
    const m = /^\/api\/run\/([^/]+)$/.exec(p);
    if (m) {
      const id = m[1];
      if (!safeName(id)) return send(400, JSON.stringify({ ok: false, reason: `invalid run id "${id}": a run id is a name, not a path` }), 'application/json');
      const detail = runDetail(cwd, id);
      return send(detail.ok ? 200 : 404, JSON.stringify(detail), 'application/json');
    }
    return send(404, JSON.stringify({ ok: false, reason: `no route ${p}` }), 'application/json');
  });
  // Loopback only: this is a private view of prompts and answers, never a LAN service.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (e) {
    die(`cannot serve the dashboard on 127.0.0.1:${port}: ${e.code === 'EADDRINUSE' ? `the port is already in use — the dashboard keeps a fixed port and does not drift; free it, or pass --port <N> (QODER_WF_UI_PORT)` : e.message}`);
  }
  const bound = server.address().port;
  print({
    ok: true,
    command: 'ui',
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    defaultPort: UI_DEFAULT_PORT,
    cwd,
    pid: process.pid,
    engine: ENGINE_VERSION,
    note: 'read-only live view (phase timeline, per-agent cards, steer backlog); Ctrl+C to stop',
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const USAGE = `Qoder dynamic workflows (wf.mjs ${ENGINE_VERSION})

  wf.mjs run <script.js> [--name L] [--args JSON|--args-file f] [--backend cli|file|echo (default cli)]
             [--concurrency N] [--cwd DIR] [--run-id ID] [--quiet] [--script <path|inline|->]
             [--saved NAME] [--scope project|global] [--max-calls N] [--script-timeout MS]
             [--yes] [--trusted]
  wf.mjs check <script.js> [--args JSON]
  wf.mjs save <script.js> --name N [--scope project|global] [--description TEXT]
             [--when-to-use TEXT] [--overwrite]
  wf.mjs list
  wf.mjs status [runId]
  wf.mjs result <runId>
  wf.mjs resume <runId> [--script <path>] [--args JSON] [--force]
  wf.mjs stop <runId> [--force]
  wf.mjs steer <runId> "<note>" [--text NOTE] [--from L]
  wf.mjs trust <name> [--scope project|global]
  wf.mjs untrust <name>
  wf.mjs paths
  wf.mjs ui [--port N]          live dashboard for this project's runs (127.0.0.1:4230)

Exit codes: 0 ok | 1 the run failed or the command hit an error | 2 usage, args, source or check
refused (nothing dispatched) | 3 refused: a live process holds that run id, the run already
settled, the note or args do not fit, or resume was handed different args (--force overrides).

Confirmation: run reports confirmation.required, and the engine does not block on it — asking is
the host's job, before the run is launched. \`wf.mjs trust <name>\` (or --yes, or --trusted for this
run once) answers it; trust is stored per directory in <cwd>/.qoder/dynamic-workflow-trust.json and
is bound to the script's content hash, so editing the saved workflow revokes it.

Script shape (one script, one run):
  export const meta = { name, description, whenToUse?, args?: { key: { type, required?, default?, enum? } } };
  phase('Review');
  const found = await parallel([() => agent('check security'), () => agent('check perf')]);
  return found;

Facade: agent(prompt, { label, phase, model, agent, systemPrompt, cwd, json, timeoutMs,
              throwOnError, maxOutputTokens, tools, permissionMode })
        parallel(thunks|…thunks)  pipeline(items, ...stages)  phase(name)  log(msg)  notes()  args
model / agent / systemPrompt / cwd are part of the call's cache key and are written into the parked
pending/<callId>.json as well, so a file-backend host can honour them (or ignore them, but never
miss them). maxOutputTokens / tools / permissionMode are cli-backend flags only.
notes() returns the strings queued by "wf.mjs steer <runId> <note>", empty when nothing arrived.
Status reports steerQueued / steerDelivered / steerUndelivered, where only the last one is a backlog.
Limits: --concurrency 1..32 (default 8), --max-calls 1..100000 (default 500) for the whole run, not
per resume; a prompt over ${MAX_PROMPT_CHARS} characters and a cli reply over ${CLI_MAX_OUTPUT_BYTES} bytes fail that call. Backend: default cli spawns qodercli per call; file parks each call for a host session and gives up on an unanswered park after ${PARK_TIMEOUT_MS / 1000} s (WF_PARK_TIMEOUT_MS=1000..86400000 to retune, or timeoutMs per call).
Output: a result over ${RESULT_PREVIEW_CHARS} characters is not echoed back — stdout carries
resultPreview, resultBytes and the pointer instead, and the whole value is only in
<run dir>/out.json, which "wf.mjs result <runId>" prints.
Counts: agentCalls and segmentCalls are what this lifecycle dispatched; agentDispatched,
agentSettled, agentFailed and agentRejected are the run's totals over every lifecycle, in out.json,
state.json and status alike.
Dashboard: "wf.mjs ui" serves a read-only live view on 127.0.0.1 only — a phase timeline, one card
per agent call with its live state, the steer backlog and the settled result. The port is fixed
(default ${UI_DEFAULT_PORT}; QODER_WF_UI_PORT or --port to retune, --port 0 for an ephemeral one),
and a busy port is an error, not a silent drift onto another one.
Backends: cli    spawns "node <qodercli.js> -p" per agent call (needs qodercli login)
          file   parks each call in pending.json; the host session answers inbox/<callId>.json
                 (an unanswered park expires after ${PARK_TIMEOUT_MS / 1000} s, or the call's timeoutMs)
          echo   returns a stub (tests)`;

const COMMANDS = { run: cmdRun, check: cmdCheck, save: cmdSave, list: cmdList, status: cmdStatus, result: cmdResult, resume: cmdResume, stop: cmdStop, steer: cmdSteer, trust: cmdTrust, untrust: cmdUntrust, paths: cmdPaths, ui: cmdUi };

// A mistyped safety valve (--max-agent-calls for --max-calls, --quietl, --concorrency) used to be
// dropped on the floor: the run reported the flag had as missing and did the unbounded thing (A22).
// One table of the flags each subcommand actually reads, checked before the command runs.
const RUN_FLAGS = ['host-session', 'name', 'args', 'args-file', 'backend', 'concurrency', 'run-id', 'quiet', 'script', 'saved', 'scope', 'max-calls', 'script-timeout', 'yes', 'trusted'];
const KNOWN_FLAGS = {
  run: ['cwd', 'help', ...RUN_FLAGS],
  check: ['cwd', 'help', 'args'],
  save: ['cwd', 'help', 'name', 'scope', 'overwrite', 'description', 'when-to-use'],
  list: ['cwd', 'help'],
  status: ['cwd', 'help'],
  result: ['cwd', 'help'],
  resume: ['cwd', 'help', 'force', ...RUN_FLAGS],
  stop: ['cwd', 'help', 'force'],
  steer: ['cwd', 'help', 'from', 'text'],
  trust: ['cwd', 'help', 'scope'],
  untrust: ['cwd', 'help'],
  paths: ['cwd', 'help'],
  ui: ['cwd', 'help', 'port'],
};

function unknownFlags(command, flags) {
  const known = new Set(KNOWN_FLAGS[command]);
  return Object.keys(flags).filter((k) => k !== '_' && !known.has(k));
}

async function main(argv) {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const command = argv[0];
  const fn = COMMANDS[command];
  if (!fn) die(`unknown command "${command}" (try --help)`);
  const flags = parseArgv(argv.slice(1));
  const unknown = unknownFlags(command, flags);
  if (unknown.length) {
    print({ ok: false, command, stage: 'usage', errors: unknown.map((k) => `unknown --${k} for "${command}"`), knownFlags: KNOWN_FLAGS[command].slice().sort() });
    process.exitCode = 2;
    return;
  }
  await fn(flags);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2));
}
