// Host half of dsh-workflow-pipeline: serves /dsh-workflow-pipeline/api/runs — the live
// progress of every dynamic-workflow run found under the configured workspace roots.
// Data source is each run's own progress.json (written by the engine on every journal
// append), so this service only walks directories and caches by mtime.
//
// REPAIR-024 identity contract:
//   - every run carries a runKey (SHA-256 of the normalized REAL run directory;
//     Windows path comparison is case-insensitive) so identical runIds across
//     workspaces never alias;
//   - ?run= prefers the runKey; a bare runId resolves only when unique, ambiguous
//     ids are rejected with 409 AMBIGUOUS_RUN, unknown/deleted runs are 404;
//   - mutating endpoints require the run's startedAt (400 when missing,
//     409 STALE_LIFECYCLE when stale); read-only endpoints validate it when present;
//   - terminal runs refuse stop; /artifact serves published file artifacts only,
//     strictly inside the run workspace;
//   - /runs?cwd= matches the full normalized workspace, never the basename.
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, basename, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { processIdentity, resumeRun, sameStateIdentity } from './run-lifecycle.mjs';

export const name = 'dsh-workflow-pipeline';
export const inject = ['webServer'];

// ---- run identity helpers (self-contained; mirrored in mmx-workflow-pipeline/sidecar.mjs) ----
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

// Published file artifacts are served as text previews (forced text/plain, so even
// .html cannot execute) or as octet-stream attachments. Nothing else is allowed.
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.log', '.csv', '.tsv',
  '.yml', '.yaml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.sh', '.bat', '.ps1', '.ini', '.cfg', '.conf', '.toml', '.env']);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function apply(ctx, config) {
  const roots = Array.isArray(config?.roots) ? config.roots.map(String) : [];
  const cache = new Map(); // progress.json path -> { mtime, value }   (valid values only)
  // Run registry keyed by runKey (real directory identity). byId maps a bare runId to the set
  // of keys sharing it, so ambiguity is detectable instead of silently last-write-wins.
  let runsByKey = new Map();
  let runsById = new Map();
  // SPEC §2.2: shared engine used by POST /resume.
  const WF_PATH = 'G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';

  const readProgress = (file) => {
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
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
        try {
          if (statSync(child).isDirectory()) candidates.push(child);
        } catch {}
      }
    } catch {}
    for (const base of candidates) {
      const runsDir = join(base, '.qoder', 'workflow-runs');
      if (!existsSync(runsDir)) continue;
      let ids = [];
      try {
        ids = readdirSync(runsDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        const dir = join(runsDir, id);
        const file = join(dir, 'progress.json');
        if (!existsSync(file)) continue;
        const key = runKeyFor(dir);
        if (byKey.has(key)) continue; // the same real directory reached via two roots: list once
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
    for (const root of roots) await scanRoot(root, out, byKey, byId);
    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    runsByKey = byKey;
    runsById = byId;
    return out;
  };

  // Resolve ?run= to a registry entry. runKey wins; a bare runId must be unique.
  const lookupRun = async (token) => {
    if (!token) return { code: 'UNKNOWN' };
    let entry = runsByKey.get(normRunKey(token));
    if (entry) return { code: 'OK', entry };
    await collect(); // repopulate on miss so /script /result /stop /resume /answer are order-independent
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-workflow-pipeline/api',
    handler: async (req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/^\/dsh-workflow-pipeline\/api/, '') || '/';
        if (req.method === 'GET' && (path === '/runs' || path === '/')) {
          const cwd = url.searchParams.get('cwd');
          let runs = await collect();
          if (cwd) runs = runs.filter((r) => normDir(r.cwd) === normDir(cwd));
          return send(200, { ok: true, runs });
        }
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
          const fresh = readFreshProgress(entry);
          if (!fresh.ok) return send(fresh.status, fresh.body);
          const arts = Array.isArray(fresh.value && fresh.value.artifacts) ? fresh.value.artifacts : [];
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
            // Re-validate after the awaited body read: the lifecycle may have rotated while
            // the request body was in flight, and the write below must never land in a
            // lifecycle the client was not shown.
            const fresh = readFreshProgress(entry);
            if (!fresh.ok) return send(fresh.status, fresh.body);
            const lc2 = lifecycleCheckValue(fresh.value && fresh.value.startedAt, url.searchParams.get('startedAt'), true);
            if (lc2) return send(lc2.status, lc2.body);
            const beforeS = readFreshState(entry);
          const progress = await effectiveProgress(entry.dir, fresh.value);
            if (!progress || progress.status !== 'running') return send(409, { ok: false, error: 'run is not accepting answers' });
            // FINAL SYNCHRONOUS RE-CHECK — no awaits before the inbox write: lifecycle,
            // status and question state are re-read from disk one last time.
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
            const q = Array.isArray(finalProgress.questions) ? finalProgress.questions.find((x) => x && x.qId === qId) : null;
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
    },
  }), 'dsh-workflow-pipeline: api');
}
