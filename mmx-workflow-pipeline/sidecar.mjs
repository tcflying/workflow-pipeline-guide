#!/usr/bin/env node
// mmx-sidecar — the host half of mmx-workflow-pipeline (DEVELOPMENT.md §4 D2).
//
// Two jobs, one process:
//   1) HTTP host API on 127.0.0.1:4231 — the same /runs /script /result /stop contract as the
//      DSH host half (ported from dsh-workflow-pipeline/index.mjs, which used ctx.webServer).
//      Data source: each run's own progress.json (written on every journal append).
//   2) CDP injector into the MiniMax Code renderer on 127.0.0.1:9331 — Page.addScriptToEvaluateOnNewDocument
//      (re-injects after navigation/reload) + an immediate Runtime.evaluate. Reconnect and
//      target-poll so a restarted window is re-injected automatically.
//
// Zero third-party dependencies: node: builtins + global fetch + global WebSocket (Node >= 22).
//
// Usage:
//   node sidecar.mjs [--launch] [--root <dir>]... [--kill-on-exit]
//     --launch        start MiniMax Code only when no existing instance must be replaced
//     --root <dir>    workspace root to scan (repeatable); default G:/qoder-intl-project/else
//     --kill-on-exit  on SIGINT also kill the MiniMax Code instance this process launched
import { createServer } from 'node:http';
import { launchOwnedApplication, parseLaunchArgs } from './launch-policy.mjs';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { processIdentity, resumeRun, sameStateIdentity } from './run-lifecycle.mjs';

// ---- hard contracts (DEVELOPMENT.md §2) -----------------------------------
export const API_PORT = 4231;              // fixed: never change, never drift
export const CDP_PORT = 9331;              // fixed
export const EXE = 'G:\\MiniMax\\MiniMax Code\\MiniMax Code.exe';
const DEFAULT_ROOTS = ['G:/qoder-intl-project/else'];
const CLIENT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'client-inject.js');
// SPEC §2.2: the shared dynamic-workflow engine (0.8.0) used by POST /resume.
const WF_PATH = 'G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';


const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}] [sidecar]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] [sidecar]`, ...a);

// ---- REPAIR-024: capability + closure injection helpers ------------------------------------
// The client bundle carries the literal string "__MMXDWF_CAPABILITY__" as the value of its
// X-Workflow-Capability header. At injection time the sidecar replaces that placeholder with
// the per-start random capability. The capability itself never touches a URL, localStorage,
// the log output, or any readable global property.
export const CAPABILITY_PLACEHOLDER = '__MMXDWF_CAPABILITY__';
const CAPABILITY_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function newCapability() {
  return randomBytes(32).toString('hex');
}

export function buildInjectSource(source, capability) {
  if (!CAPABILITY_RE.test(String(capability || ''))) {
    throw new Error('invalid workflow capability: must match ' + CAPABILITY_RE);
  }
  if (!String(source).includes(CAPABILITY_PLACEHOLDER)) return source;
  return String(source).split(CAPABILITY_PLACEHOLDER).join(capability);
}

// Run identity helpers (self-contained; mirrored in dsh-workflow-pipeline/index.mjs).
const normDir = (p) => {
  let s = resolve(String(p));
  if (process.platform === 'win32') s = s.toLowerCase();
  return s.replace(/\\/g, '/').replace(/\/+$/, '');
};
export function runKeyFor(dir) {
  let real;
  try { real = realpathSync(dir); } catch { real = resolve(String(dir)); }
  return createHash('sha256').update(normDir(real)).digest('hex');
}
const normRunKey = (token) => String(token || '').trim().toLowerCase();

// Published file artifacts are served as text previews (forced text/plain, so even .html
// cannot execute) or as octet-stream attachments. Nothing else is allowed.
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.log', '.csv', '.tsv',
  '.yml', '.yaml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.sh', '.bat', '.ps1', '.ini', '.cfg', '.conf', '.toml', '.env']);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

// ---- host API: data collection (ported from dsh-workflow-pipeline/index.mjs) ----
export function createHostApi({ roots, scriptPath = CLIENT_SCRIPT, quiet = false, capability } = {}) {
  const rootList = (Array.isArray(roots) && roots.length ? roots : DEFAULT_ROOTS).map(String);
  const cache = new Map();  // progress.json path -> { mtime, value }   (valid values only)
  // Run registry keyed by runKey (real directory identity); byId maps a bare runId to the set
  // of keys sharing it, so same-id runs across workspaces never silently alias.
  let runsByKey = new Map();
  let runsById = new Map();
  const say = quiet ? () => {} : log;
  // Per-start random capability held in memory only. Tests may inject a fixed one.
  const CAPABILITY = typeof capability === 'string' && capability ? capability : newCapability();

  // Access boundary (REPAIR-024): loopback Host only; trusted opaque-renderer origins only
  // (app://., app://./archon) plus the literal "null" origin; every actual request must carry
  // the capability. Unknown origins/hosts get no CORS grant at all.
  const ALLOWED_ORIGINS = new Set(['app://.', 'app://./archon', 'null']);
  const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);
  const ALLOWED_PREFLIGHT_HEADERS = new Set(['content-type', 'x-workflow-capability']);
  const isLoopbackHost = (hostHeader) => {
    const bare = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
  };

  const readProgress = (file) => {
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { return undefined; }
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.value;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      cache.set(file, { mtime, value });
      return value;
    } catch (e) {
      // Never cache a parse failure against the file's mtime: a half-written progress.json
      // must not become a long-lived fact. Report stale (keeping the last valid payload
      // underneath, marked recoverable) and retry on every read until the file parses again.
      const last = hit && hit.value && !hit.value.stale ? hit.value : null;
      return last
        ? { ...last, stale: true, recoverable: true, error: String(e && e.message) }
        : { stale: true, error: String(e && e.message) };
    }
  };

  const effectiveProgress = async (dir, value) => {
    if (!value || value.stale || !['running', 'cancelling'].includes(value.status)) return value;
    try {
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      let status = value.status;
      if (['completed', 'failed', 'cancelled', 'stale'].includes(state.status)) status = state.status;
      else if (Number.isInteger(state.pid) && state.pid > 0 && !(await processIdentity(state)).alive) status = 'stale';
      if (status === value.status) return value;
      return { ...value, status,
        calls: (value.calls || []).map((call) => call.state === 'running' ? { ...call, state: status === 'stale' ? 'stale' : 'failed' } : call),
        questions: (value.questions || []).map((q) => q.state === 'waiting' ? { ...q, state: 'failed' } : q),
      };
    } catch { return value; }
  };

  // Two levels deep: <root>/.qoder/workflow-runs/* and <root>/<project>/.qoder/workflow-runs/*.
  // The registry maps are rebuilt from scratch on every scan, so directories that left the
  // scan roots (moved/deleted) are evicted instead of lingering as stale mappings.
  const scanRoot = async (root, out, byKey, byId) => {
    if (!root || !existsSync(root)) return;
    const candidates = [root];
    try {
      for (const entry of readdirSync(root)) {
        const child = join(root, entry);
        try { if (statSync(child).isDirectory()) candidates.push(child); } catch {}
      }
    } catch {}
    for (const base of candidates) {
      const runsDir = join(base, '.qoder', 'workflow-runs');
      if (!existsSync(runsDir)) continue;
      let ids = [];
      try { ids = readdirSync(runsDir); } catch { continue; }
      for (const id of ids) {
        const dir = join(runsDir, id);
        const file = join(dir, 'progress.json');
        if (!existsSync(file)) continue;
        const key = runKeyFor(dir);
        if (byKey.has(key)) continue; // same real directory reached via two roots: list once
        const value = readProgress(file);
        const entry = { dir, runId: id, key, value };
        byKey.set(key, entry);
        if (!byId.has(id)) byId.set(id, new Set());
        byId.get(id).add(key);
        if (value && !value.stale) out.push({ ...(await effectiveProgress(dir, value)), runKey: key });
      }
    }
  };

  const collect = async () => {
    const out = [];
    const byKey = new Map(), byId = new Map();
    for (const root of rootList) await scanRoot(root, out, byKey, byId);
    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    runsByKey = byKey;
    runsById = byId;
    return out;
  };

  // Resolve ?run= to a registry entry. runKey wins; a bare runId must be unique. Rescan on a
  // miss so the API is order-independent (a run created after startup is still found).
  const lookupRun = async (token) => {
    if (!token) return { code: 'UNKNOWN' };
    let entry = runsByKey.get(normRunKey(token));
    if (entry) return { code: 'OK', entry };
    await collect(); // repopulates the registry
    entry = runsByKey.get(normRunKey(token));
    if (entry) return { code: 'OK', entry };
    const set = runsById.get(String(token));
    if (!set || set.size === 0) return { code: 'UNKNOWN' };
    if (set.size > 1) return { code: 'AMBIGUOUS' };
    return { code: 'OK', entry: runsByKey.get([...set][0]) };
  };

  // FRESH lifecycle reads (REPAIR-024 follow-up): a runKey cache hit must never trust the
  // scanned entry.value — the same directory can hold a NEW engine lifecycle (same runId and
  // runKey after a same-directory restart). Every mutation and every validated read compares
  // the provided startedAt against a value read from disk at operation time.
  const readFreshProgress = (entry) => {
    try {
      return { ok: true, value: JSON.parse(readFileSync(join(entry.dir, 'progress.json'), 'utf8')) };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: false, status: 404, body: { ok: false, error: 'unknown run' } };
      return { ok: false, status: 409, body: { ok: false, error: 'run progress is unreadable; refusing to proceed' } };
    }
  };
  const lifecycleCheckValue = (current, provided, required) => {
    if (provided === null || provided === undefined || provided === '') {
      return required ? { status: 400, body: { ok: false, code: 'MISSING_STARTED_AT', error: 'startedAt is required for this operation (take it from the run entry in /runs)' } } : null;
    }
    if (String(provided) !== String(current || '')) {
      return { status: 409, body: { ok: false, code: 'STALE_LIFECYCLE', error: 'startedAt does not match the current run lifecycle; refresh /runs and retry' } };
    }
    return null;
  };
  const lifecycleCheck = (entry, provided, required) => {
    const fresh = readFreshProgress(entry);
    if (!fresh.ok) return fresh;
    return lifecycleCheckValue(fresh.value && fresh.value.startedAt, provided, required);
  };

  const readFreshState = (entry) => {
    try { return { ok: true, value: JSON.parse(readFileSync(join(entry.dir, 'state.json'), 'utf8')) }; }
    catch { return { ok: false }; }
  };
  const stateChanged = (before, after) => !before.ok || !after.ok || !sameStateIdentity(before.value, after.value);

  const runWorkspace = (entry) => {
    try {
      const state = JSON.parse(readFileSync(join(entry.dir, 'state.json'), 'utf8'));
      if (state && state.cwd) return String(state.cwd);
    } catch {}
    if (entry.value && entry.value.cwd) return String(entry.value.cwd);
    return resolve(entry.dir, '..', '..', '..');
  };

  const sanitizeFilename = (name) => {
    const base = basename(String(name || 'artifact.bin')).replace(/[^\w.\- ()\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '_') || 'artifact.bin';
    return base.slice(0, 120);
  };

  const serveArtifact = (res, entry, art) => {
    const rel = art && typeof art.path === 'string' ? art.path : '';
    if (!rel) return { status: 404, body: { ok: false, error: 'artifact is not a published file' } };
    const workspace = runWorkspace(entry);
    let baseReal, real;
    try { baseReal = realpathSync(workspace); } catch { return { status: 404, body: { ok: false, error: 'run workspace is not accessible' } }; }
    try { real = realpathSync(resolve(workspace, rel)); } catch { return { status: 404, body: { ok: false, error: 'artifact file does not exist' } }; }
    const normBase = normDir(baseReal);
    const normReal = normDir(real);
    if (normReal !== normBase && !normReal.startsWith(normBase + '/')) {
      return { status: 403, body: { ok: false, error: 'artifact path escapes the run workspace' } };
    }
    let st;
    try { st = statSync(real); } catch { return { status: 404, body: { ok: false, error: 'artifact file does not exist' } }; }
    if (!st.isFile()) return { status: 403, body: { ok: false, error: 'artifact is not a regular file' } };
    if (st.size > MAX_ARTIFACT_BYTES) return { status: 413, body: { ok: false, error: 'artifact exceeds 32MB; open it in the workspace instead' } };
    const fname = sanitizeFilename(art.title || basename(real));
    const rawName = encodeURIComponent(basename(real));
    if (TEXT_EXTS.has(extname(real).toLowerCase())) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `inline; filename="${fname}"; filename*=UTF-8''${rawName}` });
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${fname}"; filename*=UTF-8''${rawName}` });
    }
    res.end(readFileSync(real));
    return null;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const originAllowed = origin === undefined ? true : ALLOWED_ORIGINS.has(String(origin));
    // CORS headers are granted per-request and only echo a TRUSTED origin — never "*".
    const corsHeaders = origin !== undefined && originAllowed ? {
      'access-control-allow-origin': String(origin),
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-workflow-capability',
      'access-control-max-age': '600',
      'vary': 'Origin',
    } : {};
    const deny = (code, msg) => {
      // Deliberately without CORS headers: an untrusted caller must not be able to read the reply.
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    };
    const send = (code, obj) => {
      res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, corsHeaders));
      res.end(JSON.stringify(obj));
    };
    try {
      if (!isLoopbackHost(req.headers.host)) return deny(403, 'forbidden: untrusted Host');
      if (!originAllowed) return deny(403, 'forbidden: untrusted Origin');
      if (req.method === 'OPTIONS') {
        // Preflight validates source + requested method/headers only; the actual request still
        // has to authenticate with the capability.
        const method = String(req.headers['access-control-request-method'] || req.method).toUpperCase();
        if (!ALLOWED_METHODS.has(method)) return deny(403, 'forbidden: method not allowed');
        const reqHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
        if (reqHeaders.some((h) => !ALLOWED_PREFLIGHT_HEADERS.has(h))) return deny(403, 'forbidden: header not allowed');
        res.writeHead(204, origin === undefined ? { allow: 'GET,POST,OPTIONS' } : corsHeaders);
        res.end();
        return;
      }
      const presented = req.headers['x-workflow-capability'];
      if (typeof presented !== 'string' || presented !== CAPABILITY) {
        return deny(403, 'forbidden: missing or invalid workflow capability');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname; // served at the root: /runs /script /result /artifact /stop
      const resolveRun = async (params) => {
        const found = await lookupRun(params.get('run') || '');
        if (found.code === 'AMBIGUOUS') {
          send(409, { ok: false, code: 'AMBIGUOUS_RUN', error: 'this runId exists in more than one workspace; address the run by its runKey from /runs' });
          return null;
        }
        if (found.code !== 'OK') {
          send(404, { ok: false, error: 'unknown run' });
          return null;
        }
        return found.entry;
      };
      if (req.method === 'GET' && (path === '/runs' || path === '/')) {
        const cwd = url.searchParams.get('cwd');
        let runs = await collect();
        // Full normalized workspace match — basename matching caused cross-workspace bleed.
        if (cwd) runs = runs.filter((r) => normDir(r.cwd) === normDir(cwd));
        return send(200, { ok: true, runs });
      }
      if (req.method === 'GET' && path === '/script') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        const lc = lifecycleCheck(entry, url.searchParams.get('startedAt'), false);
        if (lc) return send(lc.status, lc.body);
        try {
          const state = JSON.parse(readFileSync(join(entry.dir, 'state.json'), 'utf8'));
          const sp = state && state.scriptPath ? String(state.scriptPath) : null;
          // Relative scriptPaths belong to the run workspace, never to the host process cwd.
          const resolved = sp ? resolve(runWorkspace(entry), sp) : null;
          return send(200, { ok: true, scriptPath: sp || null, script: resolved && existsSync(resolved) ? readFileSync(resolved, 'utf8') : '' });
        } catch (e) {
          return send(404, { ok: false, error: 'run state is unreadable: ' + String(e instanceof Error ? e.message : e) });
        }
      }
      if (req.method === 'GET' && path === '/result') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        const lc = lifecycleCheck(entry, url.searchParams.get('startedAt'), false);
        if (lc) return send(lc.status, lc.body);
        try {
          return send(200, { ok: true, out: JSON.parse(readFileSync(join(entry.dir, 'out.json'), 'utf8')) });
        } catch (e) {
          if (e && e.code === 'ENOENT') return send(404, { ok: false, error: 'run has no out.json yet' });
          return send(500, { ok: false, error: 'out.json is corrupt: ' + String(e instanceof Error ? e.message : e) });
        }
      }
      if (req.method === 'GET' && path === '/artifact') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        const lc = lifecycleCheck(entry, url.searchParams.get('startedAt'), false);
        if (lc) return send(lc.status, lc.body);
        const idx = Number(url.searchParams.get('index'));
        if (!Number.isInteger(idx) || idx < 0) return send(400, { ok: false, error: 'index must be a non-negative integer into the run artifacts list' });
        const freshArt = readFreshProgress(entry);
        if (!freshArt.ok) return send(freshArt.status, freshArt.body);
        const arts = Array.isArray(freshArt.value && freshArt.value.artifacts) ? freshArt.value.artifacts : [];
        const art = arts[idx];
        if (!art || typeof art !== 'object') return send(404, { ok: false, error: 'no artifact at index ' + idx });
        if (typeof art.url === 'string' && art.url && !art.path) return send(404, { ok: false, error: 'artifact is a remote URL, not a published file' });
        const err = serveArtifact(res, entry, art);
        if (err) return send(err.status, err.body);
        return;
      }
      if (req.method === 'POST' && path === '/stop') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        try {
          // Fresh read first: a deleted directory is 404, a rewritten one carries the NEW
          // lifecycle, and the provided startedAt is judged against that — never the scan cache.
          const fresh = readFreshProgress(entry);
          if (!fresh.ok) return send(fresh.status, fresh.body);
          const lc = lifecycleCheckValue(fresh.value && fresh.value.startedAt, url.searchParams.get('startedAt'), true);
          if (lc) return send(lc.status, lc.body);
          const beforeS = readFreshState(entry);
          const eff = await effectiveProgress(entry.dir, fresh.value);
          // FINAL SYNCHRONOUS RE-CHECK — no awaits after this point: the CANCEL write must
          // never land in a lifecycle that rotated during the status await above.
          const finalP = readFreshProgress(entry);
          if (!finalP.ok) return send(finalP.status, finalP.body);
          if (String((finalP.value && finalP.value.startedAt) || '') !== String((fresh.value && fresh.value.startedAt) || '')) {
            return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'the run lifecycle rotated while the stop was being verified; refresh /runs and retry' });
          }
          const finalS = readFreshState(entry);
          if (!finalS.ok) return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'state.json is unreadable; refusing to write a stop marker' });
          if (stateChanged(beforeS, finalS)) return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'state identity changed during verification; refresh /runs and retry' });
          if (!['running', 'cancelling'].includes(finalS.value.status) || !['running', 'cancelling'].includes(finalP.value.status) || !['running', 'cancelling'].includes(eff.status)) {
            return send(409, { ok: false, code: 'RUN_TERMINAL', error: `run is ${!['running', 'cancelling'].includes(finalP.value.status) ? finalP.value.status : eff.status}: terminal runs cannot be stopped` });
          }
          writeFileSync(join(entry.dir, 'CANCEL'), 'stop requested from pipeline card');
          return send(200, { ok: true });
        } catch (e) {
          return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) });
        }
      }
      if (req.method === 'POST' && path === '/resume') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        const lc = lifecycleCheck(entry, url.searchParams.get('startedAt'), true);
        if (lc) return send(lc.status, lc.body);
        try {
          const state = JSON.parse(readFileSync(join(entry.dir, 'state.json'), 'utf8'));
          // The UI-visible progress startedAt is the expectation; resumeRun re-reads fresh
          // state/progress itself and never compares against the passed-in state snapshot.
          const result = await resumeRun(entry.dir, entry.runId, state, WF_PATH, url.searchParams.get('startedAt'));
          return send(result.status, result.body);
        } catch (e) {
          return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) });
        }
      }
      if (req.method === 'POST' && path === '/answer') {
        const entry = await resolveRun(url.searchParams);
        if (!entry) return;
        const lc = lifecycleCheck(entry, url.searchParams.get('startedAt'), true);
        if (lc) return send(lc.status, lc.body);
        const qId = url.searchParams.get('q') || '';
        let answer = '';
        try {
          const body = await new Promise((res, rej) => {
            let b = '';
              req.setEncoding('utf8');
            req.on('data', (c) => { if (b.length > 262144) return; b += c; if (b.length > 262144) rej(new Error('answer body too large')); });
            req.on('end', () => res(b));
            req.on('error', rej);
          });
          const parsed = JSON.parse(body || '{}');
          if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
            return send(400, { ok: false, error: 'body must be JSON {"answer":"…"} with a non-empty string' });
          }
          answer = parsed.answer;
        } catch (e) {
          return send(400, { ok: false, error: 'bad body: ' + String(e instanceof Error ? e.message : e) });
        }
        try {
          // Re-validate after the awaited body read: the lifecycle may have rotated while the
          // request body was in flight, and the write below must never land in a lifecycle the
          // client was not shown.
          const fresh = readFreshProgress(entry);
          if (!fresh.ok) return send(fresh.status, fresh.body);
          const lc2 = lifecycleCheckValue(fresh.value && fresh.value.startedAt, url.searchParams.get('startedAt'), true);
          if (lc2) return send(lc2.status, lc2.body);
          const beforeS = readFreshState(entry);
          const progress = await effectiveProgress(entry.dir, fresh.value);
            if (!progress || progress.status !== 'running') return send(409, { ok: false, error: 'run is not accepting answers' });
          // FINAL SYNCHRONOUS RE-CHECK — no awaits before the inbox write: lifecycle, status
          // and question state are re-read from disk one last time.
          const finalP = readFreshProgress(entry);
          if (!finalP.ok) return send(finalP.status, finalP.body);
          if (String((finalP.value && finalP.value.startedAt) || '') !== String((fresh.value && fresh.value.startedAt) || '')) {
            return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'the run lifecycle rotated while the answer was being verified; refresh /runs and retry' });
          }
          const finalS = readFreshState(entry);
          if (!finalS.ok) return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'state.json is unreadable; refusing to write an answer' });
          if (stateChanged(beforeS, finalS)) return send(409, { ok: false, code: 'STALE_LIFECYCLE', error: 'state identity changed during verification; refresh /runs and retry' });
          const finalProgress = finalP.value;
            if (finalS.value.status !== 'running' || !finalProgress || finalProgress.status !== 'running') return send(409, { ok: false, error: 'run is not accepting answers' });
            if (!/^[a-zA-Z0-9_-]+$/.test(qId)) return send(400, { ok: false, error: 'invalid question id' });
          const q = finalProgress && Array.isArray(finalProgress.questions) ? finalProgress.questions.find((x) => x && x.qId === qId) : null;
          if (!q) return send(404, { ok: false, error: `unknown question ${qId}` });
          if (q.state !== 'waiting') return send(409, { ok: false, error: `question ${qId} is ${q.state}, not waiting` });
          mkdirSync(join(entry.dir, 'inbox'), { recursive: true });
          try {
              writeFileSync(join(entry.dir, 'inbox', `${qId}.json`), JSON.stringify({ ok: true, text: answer }), { flag: 'wx' });
            } catch (e) {
              if (e.code === 'EEXIST') return send(409, { ok: false, error: 'answer already submitted' });
              throw e;
            }
          return send(200, { ok: true });
        } catch (e) {
          return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) });
        }
      }
      return send(404, { ok: false, error: 'not found: ' + path });
    } catch (e) {
      return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) });
    }
  });

  const start = (port = API_PORT) => new Promise((resolveP, rejectP) => {
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // §7 C6: fixed-port discipline — report clearly and exit 1, never silently rebind.
        console.error(`[sidecar] FATAL: port ${port} is already in use (EADDRINUSE).`);
        console.error(`[sidecar] Find the owner: netstat -ano | findstr :${port}  then  tasklist /FI "PID eq <pid>".`);
        console.error('[sidecar] The API port is fixed by contract; free it and retry. Exiting with code 1.');
        process.exit(1);
      }
      rejectP(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      say(`host API listening on http://127.0.0.1:${port}  (roots: ${rootList.join(', ')})`);
      resolveP(server);
    });
  });

  const close = () => new Promise((r) => server.close(() => r()));

  // capability is returned for the sidecar's own injector (closure injection) and for
  // isolated tests; it is never printed or persisted.
  return { server, start, close, collect, lookupRun, capability: CAPABILITY, roots: rootList };
}

// ---- CDP injector ----------------------------------------------------------
async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error('CDP /json/list HTTP ' + res.status);
  return await res.json();
}

// Target selection (§4 D2 + §7 C7, tightened by the REPAIR-024 security review): the
// capability-carrying bundle may only be injected into the real renderer page. The page URL
// must be exactly app://./archon (hash/search variants allowed) — never matched by title or a
// generic localhost fallback — and the debugging socket must point back at THIS sidecar's
// loopback CDP port. Anything else (helper pages, localhost lookalikes, foreign ws hosts or
// ports) is never a candidate.
export function isInjectableTarget(target, port = CDP_PORT) {
  try {
    const u = new URL(target.url || '');
    if (u.protocol !== 'app:' || u.hostname !== '.' || u.pathname !== '/archon') return false;
    const ws = new URL(target.webSocketDebuggerUrl || '');
    if (ws.protocol !== 'ws:') return false;
    const host = ws.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false;
    if (ws.port !== String(port)) return false;
    return true;
  } catch { return false; }
}

export function pickPageTarget(list, { port = CDP_PORT } = {}) {
  const pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => isInjectableTarget(t, port)) || null;
}

export async function isCdpUp(port, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

// Minimal CDP transport. The connection deadline also covers a socket that never opens.
export function connectCdp(wsUrl, { onClose, onError, timeoutMs = 3000 } = {}) {
  return new Promise((resolveP, rejectP) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { rejectP(e); return; }
    let id = 0, opened = false;
    const pending = new Map();
    const fail = (error) => {
      clearTimeout(timer);
      rejectP(error);
      for (const p of pending.values()) p.rej(error);
      pending.clear();
    };
    const timer = setTimeout(() => {
      fail(new Error('CDP connection timed out'));
      try { ws.close(); } catch {}
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      opened = true;
      const send = (method, params) => new Promise((res, rej) => {
        const myId = ++id;
        pending.set(myId, { res, rej });
        try { ws.send(JSON.stringify({ id: myId, method, params: params || {} })); }
        catch (e) { pending.delete(myId); rej(e); }
      });
      resolveP({ send, close: () => { fail(new Error('CDP client closed')); try { ws.close(); } catch {} }, socket: ws });
    });
    ws.addEventListener('error', () => { fail(new Error('CDP WebSocket error')); if (onError) onError(); });
    ws.addEventListener('close', () => { fail(new Error(opened ? 'CDP WebSocket closed' : 'CDP WebSocket closed before open')); if (onClose) onClose(); });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error('CDP command rejected')) : p.res(msg.result);
    });
  });
}

function readClientScript(scriptPath) {
  if (!existsSync(scriptPath)) throw new Error('client script not found');
  return readFileSync(scriptPath, 'utf8');
}

export function startCdpInjector({ port = CDP_PORT, scriptPath = CLIENT_SCRIPT, capability, quiet = false, pollMs = 10000, retryMs = 5000, commandTimeoutMs = 3000, listTargets: listTargetsImpl = listTargets, connect = connectCdp } = {}) {
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) throw new Error('invalid CDP timeout');
  const say = quiet ? () => {} : log;
  const cap = typeof capability === 'string' && capability ? capability : newCapability();
  const PRELUDE = 'try { if (typeof window.__mmxDwfTeardown === "function") window.__mmxDwfTeardown(); } catch (e) {}'
    + ' try { window.__mmxDwfInstalled = false; window.__mmxDwfVersion = 0; } catch (e) {}';
  let stopped = false, current = null, inFlight = null, stopPromise = null;
  let pollTimer = null, retryTimer = null;
  const cleanupErrors = [];
  const bounded = (operation, label, late) => new Promise((resolveP, rejectP) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; rejectP(new Error(label + ' timed out')); }, commandTimeoutMs);
    Promise.resolve().then(operation).then((value) => {
      clearTimeout(timer);
      if (expired) { if (late) late(value); return; }
      resolveP(value);
    }, () => { clearTimeout(timer); if (!expired) rejectP(new Error(label + ' failed')); });
  });
  const send = (handle, method, params) => bounded(() => handle.client.send(method, params), method);
  const clearTimers = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pollTimer = retryTimer = null;
  };
  async function cleanup(handle) {
    if (!handle || handle.cleaned) return;
    handle.cleaned = true;
    const tasks = [];
    if (handle.docScriptId) tasks.push(['Page.removeScriptToEvaluateOnNewDocument', { identifier: handle.docScriptId }]);
    if (handle.mayHaveUi) tasks.push(['Runtime.evaluate', { expression: PRELUDE, awaitPromise: false }]);
    try {
      for (const [method, params] of tasks) {
        try { await send(handle, method, params); }
        catch { cleanupErrors.push(method + ': renderer cleanup unconfirmed'); }
      }
    } finally { try { handle.client.close(); } catch { cleanupErrors.push('socket close unconfirmed'); } }
  }
  async function detach() {
    const handle = current;
    current = null;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    await cleanup(handle);
  }
  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; attempt(); }, retryMs);
  };
  const schedulePoll = () => {
    if (stopped || pollTimer) return;
    pollTimer = setTimeout(() => { pollTimer = null; attempt(); }, pollMs);
  };
  async function attach(target) {
    await detach();
    if (stopped) return;
    let handle;
    const client = await bounded(() => connect(target.webSocketDebuggerUrl, {
      timeoutMs: commandTimeoutMs,
      onClose: () => {
        if (current === handle && handle) { detach().finally(scheduleRetry); }
      },
      onError: () => {},
    }), 'CDP connect', (lateClient) => { try { lateClient.close(); } catch {} });
    handle = { id: target.id, client, docScriptId: null, mayHaveUi: false, cleaned: false };
    try {
      if (stopped) return;
      await send(handle, 'Page.enable');
      if (stopped) return;
      await send(handle, 'Runtime.enable');
      if (stopped) return;
      const source = buildInjectSource(readClientScript(scriptPath), cap);
      const added = await send(handle, 'Page.addScriptToEvaluateOnNewDocument', { source });
      handle.docScriptId = added && added.identifier;
      if (!handle.docScriptId) throw new Error('document registration unconfirmed');
      // A new-document script can run during navigation even before the immediate evaluation.
      handle.mayHaveUi = true;
      if (stopped) return;
      await send(handle, 'Runtime.evaluate', { expression: PRELUDE, awaitPromise: false });
      if (stopped) return;
      await send(handle, 'Runtime.evaluate', { expression: source, awaitPromise: false });
      if (stopped) return;
      const check = await send(handle, 'Runtime.evaluate', { expression: 'window.__mmxDwfInstalled === true', returnByValue: true });
      if (stopped) return;
      if (check?.result?.value !== true) throw new Error('renderer installation unconfirmed');
      current = handle;
      say('workflow renderer attached');
    } finally { if (current !== handle) await cleanup(handle); }
  }
  function attempt() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      try {
        const list = await bounded(() => listTargetsImpl(port), 'CDP target discovery');
        if (stopped) return;
        const target = pickPageTarget(list, { port });
        if (!target) { await detach(); scheduleRetry(); return; }
        if (current?.id !== target.id) await attach(target);
        schedulePoll();
      } catch { scheduleRetry(); }
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  attempt();
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearTimers();
      stopPromise = (async () => {
        if (inFlight) await inFlight;
        await detach();
        const errors = [...new Set(cleanupErrors)];
        if (errors.length) say('renderer cleanup was not fully confirmed; native page reload is required');
        return { cleaned: errors.length === 0, errors };
      })();
      return stopPromise;
    },
    get target() { return current && current.id; },
    attempt,
    capability: cap,
  };
}

// ---- MiniMax Code launch (§4 D2.3, §7 C1) ----------------------------------
export async function launchMiniMaxCode({ port = CDP_PORT, exe = EXE, waitMs = 90000, quiet = false } = {}, operations = {}) {
  const launched = await launchOwnedApplication({ exe, port, waitMs }, { waitForCdp: (p, timeout) => waitForCdp(p, timeout, quiet), ...operations });
  if (!quiet) log(`started owned MiniMax Code process ${launched.pid}; existing instances were not closed`);
  return launched;
}

export async function waitForCdp(port = CDP_PORT, timeoutMs = 90000, quiet = false) {
  const say = quiet ? () => {} : log;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpUp(port)) { say(`CDP ready on ${port}`); return true; }
    await sleep(1000);
  }
  throw new Error(`CDP on ${port} not ready after ${timeoutMs}ms`);
}

export function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`Node >= 22 required (native WebSocket), found v${process.versions.node}.`);
}

// ---- CLI -------------------------------------------------------------------
export const parseArgs = parseLaunchArgs;

const USAGE = `mmx-workflow-pipeline sidecar
  node sidecar.mjs [--launch | --no-launch] [--root <dir>]... [--kill-on-exit]
    --launch         start MiniMax Code only if no existing instance needs to be closed
    --no-launch      require an already available CDP endpoint; never launch or restart
    --root <dir>     workspace root to scan (repeatable; default ${DEFAULT_ROOTS.join(', ')})
    --kill-on-exit   stop only a verified process created by this launcher
  API: http://127.0.0.1:${API_PORT}   CDP: 127.0.0.1:${CDP_PORT}   exe: ${EXE}`;

export async function main(argv = process.argv.slice(2), operations = {}) {
  requireNode22();
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }
  const api = (operations.createHostApi || createHostApi)({ roots: args.roots });
  const host = operations.process || process;
  let launched = null, injector;
  try {
    await api.start(args.apiPort);
    const available = await (operations.isCdpUp || isCdpUp)(args.cdpPort);
    if (!available && args.noLaunch) throw new Error(`CDP_UNAVAILABLE: --no-launch requires an existing MiniMax Code CDP endpoint on ${args.cdpPort}.`);
    if (!available && args.launch) {
      launched = await (operations.launchMiniMaxCode || launchMiniMaxCode)({ port: args.cdpPort });
      await launched.waitReady();
    } else if (!available) warn(`CDP on ${args.cdpPort} is unavailable; UI injection is pending. No application was started or stopped.`);
    injector = (operations.startCdpInjector || startCdpInjector)({ port: args.cdpPort, capability: api.capability });
  } catch (error) {
    try { if (injector) await injector.stop(); } catch {}
    await api.close().catch(() => {});
    throw error;
  }
  log(`API :${args.apiPort} | CDP :${args.cdpPort} | roots ${api.roots.join(', ')} | injector started, confirmation pending`);
  let shutdownPromise;
  const shutdown = () => shutdownPromise ||= (async () => {
    host.removeListener('SIGINT', onSignal); host.removeListener('SIGTERM', onSignal);
    const errors = [];
    try { await injector.stop(); } catch (error) { errors.push(error); }
    try { await api.close(); } catch (error) { errors.push(error); }
    if (launched && args.killOnExit) {
      try { await launched.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Sidecar cleanup did not finish completely; unverified applications were not terminated.');
  })();
  const onSignal = () => { shutdown().catch((error) => { warn(error.message); host.exitCode = 1; }); };
  host.on('SIGINT', onSignal); host.on('SIGTERM', onSignal);
  return { api, injector, launched, shutdown };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => { console.error('[sidecar] uncaught:', e && e.stack || e); process.exit(1); });
}