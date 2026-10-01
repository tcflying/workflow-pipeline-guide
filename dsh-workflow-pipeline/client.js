// Client bundle of dsh-workflow-pipeline — ZCode-style live workflow progress inside the
// DSH native web UI. Loaded by the client-modules system (window.__ModuleLoader__).
//  - Sidebar: a progress line under a session row, driven ONLY by an explicit
//    run→session binding (REPAIR-024: no title/cwd-basename guessing). A row without a
//    verifiable data-session-id never gets a line.
//  - Conversation: run cards bound to the current session (ctx.sessions.list snapshot
//    `current`); unbound LIVE runs stay visible so the user can bind them explicitly;
//    unbound finished runs live only in the clearly-labelled global history.
//  - Identity: every DOM node, cache, close set and API request uses run.runKey||run.runId;
//    runId is display/resume only. Run-scoped requests carry &startedAt=<expected lifecycle>.
// Data comes from the host half's API (same-origin /dsh-workflow-pipeline/api/*).
// No host source is modified; everything here is additive DOM.
window.__ModuleLoader__.load({
	id: '@dsh-external/dsh-workflow-pipeline',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var POLL_MS = 2000;
		var NS = 'dwf';
		var CARD_ID = 'dwf-run-card';
		var CARD_ATTR = 'dwf-card'; // DOM attribute: data-dwf-card
		var LINE_ATTR = 'dwf-line'; // DOM attribute: data-dwf-line
		var DISMISS_KEY = 'dwf-pipeline-dismissed';
		var VISIBLE_KEY = 'dwf-pipeline-visible-runs';
		var BINDINGS_KEY = 'dwf-session-bindings';
		var MODAL_ID = 'dwf-modal';
		var STYLE_ID = 'dwf-pipeline-style';
		var API = '/dsh-workflow-pipeline/api';
		var SESSION_ROW_SEL = '[class*="sessionRow"]';
		var SESSION_ID_ATTR = 'data-session-id';

		// DSH talks to the same-origin native webServer with the host's own auth; no
		// capability header applies here (MMX wraps this with X-Workflow-Capability).
		function apiFetch(url, opts) { return fetch(url, opts); }

		var runs = [];
		var stopped = false;
		var pollInFlight = false;
		var pollGen = 0;
		var offline = false;
		var lastSyncAt = 0;
		var lastHttpError = '';
		var persistWarning = '';
		var cardAnchor = null;
		var activeBlobUrls = [];

		// ---------- persistence (failures are visible, never silent) ----------
		var loadDismissed = function () {
			try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); }
			catch (e) { persistWarning = '关闭记录读取失败（localStorage 异常），已忽略旧关闭状态'; return new Set(); }
		};
		var saveDismissed = function (set) {
			try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set])); return true; }
			catch (e) { persistWarning = '关闭状态保存失败（localStorage 不可用），刷新后已关闭的卡片可能重新出现'; return false; }
		};
		var dismissed = loadDismissed();
		var visibleRuns;
		try { visibleRuns = new Set(JSON.parse(localStorage.getItem(VISIBLE_KEY) || '[]')); } catch (e) { visibleRuns = new Set(); }
		function saveVisible() {
			try { localStorage.setItem(VISIBLE_KEY, JSON.stringify([...visibleRuns])); return true; }
			catch (e) { persistWarning = '卡片显示状态保存失败（localStorage 不可用），刷新后可能丢失'; return false; }
		}
		// Manual bindings are only for legacy runs without native origin metadata.
		var bindings;
		try {
			bindings = JSON.parse(localStorage.getItem(BINDINGS_KEY) || '{}');
			if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) bindings = {};
		} catch (e) { bindings = {}; persistWarning = '会话绑定数据读取失败（localStorage 异常），已忽略旧绑定'; }
		function saveBindings() {
			try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); return true; }
			catch (e) { persistWarning = '会话绑定保存失败（localStorage 不可用），刷新后可能丢失'; return false; }
		}

		// ---------- session adapters (REPAIR-024 + native ctx.sessions) ----------
		// Current DSH session comes from the native Cordis service ctx.sessions.list:
		// getSnapshot() -> { ids, byId, current, phase }; subscribe(fn) is an invalidation
		// notification — always re-read the snapshot. When the service is absent we return
		// '' and the UI falls back to the clearly-labelled GLOBAL view; we never guess a
		// session from titles or cwd. Sidebar rows expose no session id in this host, so a
		// row only ever gets a line for an explicitly bound run (main session may land a
		// row-slot adapter later).
		var sessionsService = null;
		var unsubscribeSessions = null;
		function currentSessionId() {
			if (!sessionsService) return '';
			try {
				var snap = sessionsService.getSnapshot();
				return (snap && snap.current) ? String(snap.current) : '';
			} catch (e) { return ''; }
		}
		function identity(run) { return (run && (run.runKey || run.runId)) || ''; }
		function bindingOf(run) {
			if (run && run.hostSession != null) {
				var native = run.hostSession;
				var valid = native && typeof native === 'object' && !Array.isArray(native)
					&& typeof native.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(native.sessionId)
					&& ((native.host === 'dsh' && native.source === 'native-shell') || (native.host === 'mmx' && native.source === 'native-hook'));
				return valid ? { host: native.host, sessionId: native.sessionId, native: true } : { host: '', sessionId: '', native: true, invalid: true };
			}
			var manual = bindings[identity(run)];
			return manual && typeof manual.sessionId === 'string' ? { host: 'dsh', sessionId: manual.sessionId } : null;
		}
		function bindRunToSession(run, sid) {
			if (!run || !sid || run.hostSession != null) return;
			bindings[identity(run)] = { sessionId: String(sid), runId: run.runId || '', name: run.name || '', savedAt: new Date().toISOString() };
			saveBindings();
			try { sweepSidebar(); } catch (e) {}
			try { sweepCard(); } catch (e) {}
		}
		function unbindRun(run) {
			if (!run || run.hostSession != null) return;
			delete bindings[identity(run)];
			saveBindings();
			try { sweepSidebar(); } catch (e) {}
			try { sweepCard(); } catch (e) {}
		}

		var controls = new Map();
		function controlsFor(run) {
			var id = identity(run);
			var state = controls.get(id);
			if (!state || state.startedAt !== run.startedAt) {
				state = { startedAt: run.startedAt, answers: new Map(), resume: '', stop: '', error: '' };
				controls.set(id, state);
			}
			return state;
		}
		var resultCache = new Map();
		var resultPending = new Set();
		var scriptCache = {};

		var CSS = ''
			+ '[data-dwf-card]{font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--wf-text);background:var(--wf-surface);border:1px solid var(--wf-border);border-radius:14px;padding:16px 18px 14px;margin:2px 2px 14px;box-shadow:0 1px 8px var(--wf-inset);}'
			+ '[data-dwf-card].dwf-full{position:fixed;inset:20px;z-index:99990;overflow:auto;background:var(--wf-surface);}'
			+ '[data-dwf-card] .dwf-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}'
			+ '[data-dwf-card] .dwf-title{font-weight:650;font-size:14px;letter-spacing:.2px;color:var(--wf-strong);display:inline-flex;align-items:center;gap:7px;}'
			+ '[data-dwf-card] .dwf-title .dwf-gear{opacity:.9;font-size:14px;}'
			+ '[data-dwf-card] .dwf-runname{color:var(--wf-muted);font-size:12.5px;padding-left:10px;border-left:1px solid var(--wf-border);}'
			+ '[data-dwf-card] .dwf-stats{margin-left:auto;color:var(--wf-muted);font-size:11.5px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}'
			+ '[data-dwf-card] .dwf-stats .dwf-live-dot{width:6px;height:6px;border-radius:50%;background:var(--wf-accent);animation:dwf-pulse 1.6s infinite;}'
			+ '[data-dwf-card] .dwf-icos{display:inline-flex;gap:6px;margin-left:4px;}'
			+ '[data-dwf-card] .dwf-ico{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--wf-border);border-radius:8px;background:var(--wf-subtle);color:var(--wf-text);cursor:pointer;font-size:11px;padding:0;transition:all .15s ease;}'
			+ '[data-dwf-card] .dwf-ico:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.22);background:var(--wf-border);}'
			+ '[data-dwf-card] .dwf-ico.dwf-close:hover{color:#ff6b60;}'
			+ '[data-dwf-card] .dwf-pills{display:flex;gap:10px;margin:13px 0 4px;flex-wrap:wrap;}'
			+ '[data-dwf-card] .dwf-pill{display:inline-flex;align-items:center;gap:7px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:999px;padding:5px 14px;font-size:11.5px;color:var(--wf-text);cursor:pointer;transition:all .15s ease;}'
			+ '[data-dwf-card] .dwf-pill:hover{border-color:rgba(255,255,255,.24);color:var(--wf-strong);background:rgba(255,255,255,.065);}'
			+ '[data-dwf-card] .dwf-phasecols{display:flex;align-items:flex-start;margin:14px 2px 2px;}'
			+ '[data-dwf-card] .dwf-pcol{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:0 10px 0 0;}'
			+ '[data-dwf-card] .dwf-pcol + .dwf-pcol{padding-left:18px;}'
			+ '[data-dwf-card] .dwf-pcol + .dwf-pcol::before{content:"";position:absolute;top:4px;left:0;width:13px;height:2px;background:var(--wf-border);border-radius:1px;}'
			+ '[data-dwf-card] .dwf-pdot{width:9px;height:9px;border-radius:50%;background:#3a3d44;border:1px solid #3c4048;box-sizing:border-box;flex:none;}'
			+ '[data-dwf-card] .dwf-pcol.done .dwf-pdot{background:var(--wf-success);border-color:rgba(52,199,89,.4);}'
			+ '[data-dwf-card] .dwf-pcol.now .dwf-pdot{background:var(--wf-accent);border-color:rgba(255,159,10,.45);animation:dwf-pulse 1.6s infinite;}'
			+ '[data-dwf-card] .dwf-pcol.failed .dwf-pdot{background:var(--wf-failure);border-color:rgba(255,113,105,.45);}'
			+ '[data-dwf-card] .dwf-pcol.rejected .dwf-pdot,[data-dwf-card] .dwf-pcol.partial .dwf-pdot{background:var(--wf-accent);opacity:.75;}'
			+ '[data-dwf-card] .dwf-pname{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550;color:var(--wf-text);}'
			+ '[data-dwf-card] .dwf-pc{font-size:10.5px;color:var(--wf-muted);font-variant-numeric:tabular-nums;}'
			+ '[data-dwf-card] .dwf-pcol.failed .dwf-pc{color:var(--wf-failure);font-weight:600;}'
			+ '[data-dwf-card] .dwf-pcol.partial .dwf-pc,[data-dwf-card] .dwf-pcol.rejected .dwf-pc{color:var(--wf-accent);}'
			+ '[data-dwf-card] .dwf-workrow{display:flex;gap:16px;align-items:flex-start;margin-top:12px;flex-wrap:wrap;}'
			+ '[data-dwf-card] .dwf-scriptcell{display:inline-flex;align-items:center;gap:10px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:8px 13px;font-size:12px;font-weight:550;color:var(--wf-text);cursor:pointer;flex:none;min-width:120px;justify-content:space-between;}'
			+ '[data-dwf-card] .dwf-scriptcell:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.2);}'
			+ '[data-dwf-card] .dwf-sct{font-family:"Cascadia Code",Consolas,monospace;font-size:11px;color:var(--wf-muted);}'
			+ '[data-dwf-card] .dwf-scok{color:var(--wf-success);font-size:11px;}'
			+ '[data-dwf-card] .dwf-agcol{display:flex;flex-direction:column;gap:8px;flex:1;min-width:170px;max-width:240px;}'
			+ '[data-dwf-card] .dwf-ag{display:flex;align-items:center;gap:8px;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:5px 10px;min-width:0;}'
			+ '[data-dwf-card] .dwf-av2{width:18px;height:18px;border-radius:6px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;}'
			+ '[data-dwf-card] .dwf-lb{flex:1;min-width:0;font-weight:550;font-size:12px;color:var(--wf-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
			+ '[data-dwf-card] .dwf-agst{font-size:10.5px;color:var(--wf-muted);flex:none;}'
			+ '[data-dwf-card] .dwf-agst.failed{color:var(--wf-failure);}[data-dwf-card] .dwf-agst.rejected{color:#c78a7a;}[data-dwf-card] .dwf-agst.done{color:var(--wf-success);}[data-dwf-card] .dwf-agst.replayed{color:#5ac8fa;}'
			+ '[data-dwf-card] .dwf-spin{width:11px;height:11px;border:2px solid rgba(255,159,10,.25);border-top-color:var(--wf-accent);border-radius:50%;animation:dwf-rot .8s linear infinite;flex:none;}'
			+ '[data-dwf-card] .dwf-result{margin-top:12px;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:10px;padding:10px 13px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--wf-text);font-size:11.5px;}'
			+ '#' + MODAL_ID + '{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);}'
			+ '#' + MODAL_ID + ' .dwf-mbox{width:min(880px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--wf-surface);border:1px solid var(--wf-border);border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.5);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--wf-text);}'
			+ '#' + MODAL_ID + ' .dwf-mhead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--wf-border);font-weight:650;font-size:13.5px;color:var(--wf-strong);}'
			+ '#' + MODAL_ID + ' .dwf-mclose{margin-left:auto;cursor:pointer;color:var(--wf-muted);border:none;background:none;font-size:18px;width:28px;height:28px;border-radius:8px;transition:all .15s ease;}'
			+ '#' + MODAL_ID + ' .dwf-mclose:hover{color:var(--wf-strong);background:var(--wf-border);}'
			+ '#' + MODAL_ID + ' .dwf-mbody{padding:14px 18px;overflow:auto;overscroll-behavior:contain;}'
			+ '#' + MODAL_ID + ' pre.dwf-code{margin:0;white-space:pre-wrap;word-break:break-word;font:11.5px/1.6 "Cascadia Code",Consolas,monospace;color:var(--wf-text);background:var(--wf-inset);border-radius:10px;padding:12px 14px;}'
			+ '#' + MODAL_ID + ' .dwf-sev{margin:14px 0 6px;font-weight:700;font-size:12px;display:flex;align-items:center;gap:8px;}'
			+ '#' + MODAL_ID + ' .dwf-sev::after{content:"";flex:1;height:1px;background:var(--wf-border);}'
			+ '#' + MODAL_ID + ' .dwf-sev.P0{color:var(--wf-failure);}#' + MODAL_ID + ' .dwf-sev.P1{color:var(--wf-accent);}#' + MODAL_ID + ' .dwf-sev.P2{color:#ffd60a;}#' + MODAL_ID + ' .dwf-sev.P3{color:#9a9ea8;}'
			+ '#' + MODAL_ID + ' .dwf-fitem{background:var(--wf-subtle);border:1px solid var(--wf-border);border-left:3px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 13px;margin:8px 0;}'
			+ '#' + MODAL_ID + ' .dwf-ftitle{font-weight:600;color:var(--wf-strong);}'
			+ '#' + MODAL_ID + ' .dwf-fdetail{color:var(--wf-muted);margin-top:3px;font-size:12px;}'
			+ '@keyframes dwf-rot{to{transform:rotate(360deg);}}'
			+ '@keyframes dwf-fadein{from{opacity:0;transform:translateY(-3px);}to{opacity:1;transform:none;}}'
			+ '@keyframes dwf-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px);}75%{transform:translateX(4px);}}'
			+ '@keyframes dwf-pulse{0%{box-shadow:0 0 0 0 rgba(255,159,10,.4);}70%{box-shadow:0 0 0 8px rgba(255,159,10,0);}100%{box-shadow:0 0 0 0 rgba(255,159,10,0);}}'
			+ '[data-' + LINE_ATTR + ']{flex-basis:100%;display:flex;align-items:center;gap:7px;padding:1px 2px 3px 21px;margin-top:1px;font-size:11px;color:var(--wf-muted);min-width:0;}'
			+ '[data-' + LINE_ATTR + '] .dwf-fork{color:#5c606a;font-size:10px;flex:none;}'
			+ '[data-' + LINE_ATTR + '] .dwf-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#3a3d44;}'
			+ '[data-' + LINE_ATTR + '] .dwf-dot.done{background:var(--wf-success);}'
			+ '[data-' + LINE_ATTR + '] .dwf-dot.now{background:var(--wf-accent);animation:dwf-pulse 1.6s infinite;}'
			+ '[data-' + LINE_ATTR + '] .dwf-dot.failed{background:var(--wf-failure);}'
			+ '[data-' + LINE_ATTR + '] .dwf-dot.rejected,[data-' + LINE_ATTR + '] .dwf-dot.partial{background:var(--wf-accent);}'
			+ '[data-' + LINE_ATTR + '] .dwf-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}'
			+ '[data-dwf-card] .dwf-qzone{margin:12px 0 0;}'
			+ '[data-dwf-card] .dwf-q.waiting{display:flex;gap:10px;align-items:center;background:rgba(255,159,10,.06);border:1px solid rgba(255,159,10,.28);border-left:3px solid var(--wf-accent);border-radius:10px;padding:9px 12px;flex-wrap:wrap;}'
			+ '[data-dwf-card] .dwf-q.waiting .dwf-qtext{font-size:12.5px;color:var(--wf-ask);flex:1 1 200px;min-width:0;}'
			+ '[data-dwf-card] .dwf-qin{flex:1 1 220px;min-width:0;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:8px;color:var(--wf-strong);font:12px/1.4 inherit;padding:6px 10px;outline:none;}'
			+ '[data-dwf-card] .dwf-qin:focus{border-color:rgba(255,159,10,.5);}'
			+ '[data-dwf-card] .dwf-qsend{border:none;border-radius:8px;background:var(--wf-accent);color:#241703;font-weight:650;font-size:12px;padding:7px 14px;cursor:pointer;}'
			+ '[data-dwf-card] .dwf-qsend:hover{background:#ffb03a;}'
			+ '[data-dwf-card] .dwf-q.answered{font-size:11.5px;color:var(--wf-muted);margin:6px 0 0;padding-left:12px;}'
			+ '[data-dwf-card] .dwf-arts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0;}'
			+ '[data-dwf-card] .dwf-art{display:inline-flex;gap:7px;align-items:center;background:var(--wf-subtle);border:1px solid var(--wf-border);border-radius:9px;padding:6px 11px;font-size:11.5px;color:var(--wf-text);max-width:260px;}'
			+ '[data-dwf-card] .dwf-art.primary{border-color:rgba(255,159,10,.45);background:rgba(255,159,10,.05);}'
			+ '[data-dwf-card] .dwf-art .dwf-atitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
			+ '[data-dwf-card] .dwf-art .dwf-star{color:var(--wf-accent);flex:none;}'
			+ '[data-dwf-card] .dwf-art a{color:#7ab8ff;text-decoration:none;}'
			+ '[data-dwf-card] .dwf-artopen{display:inline-flex;gap:7px;align-items:center;background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:0;max-width:220px;}'
			+ '[data-dwf-card] .dwf-artopen:hover .dwf-atitle{color:var(--wf-strong);text-decoration:underline;}'
			+ '[data-dwf-card] .dwf-artwarn{color:var(--wf-failure);font-size:10.5px;}'
			+ '[data-dwf-card] .dwf-logs{margin:12px 0 0;background:var(--wf-inset);border:1px solid var(--wf-border);border-radius:9px;padding:8px 12px;font:11px/1.6 "Cascadia Code",Consolas,monospace;color:var(--wf-muted);}'
			+ '[data-dwf-card] .dwf-logs .dwf-logline{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
			+ '[data-dwf-card] .dwf-logs .dwf-logline.fresh{animation:dwf-fadein .6s ease;}'
			+ '[data-dwf-card] .dwf-more{display:block;background:none;border:none;color:var(--wf-muted);font-size:11px;cursor:pointer;padding:2px 0;margin-top:4px;text-align:left;font-family:inherit;}'
			+ '[data-dwf-card] .dwf-more:hover{color:var(--wf-strong);text-decoration:underline;}'
			+ '[data-dwf-card] .dwf-result{cursor:pointer;}'
			+ '[data-dwf-card] .dwf-result:hover{border-color:rgba(255,255,255,.16);}'
			+ '[data-dwf-card] .dwf-ico.dwf-resume:hover{color:#7ab8ff;}'
			+ '[data-dwf-card] .dwf-shake{animation:dwf-shake .3s ease;}'
			+ '#' + MODAL_ID + ' .dwf-hrow{display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--wf-border);border-radius:10px;margin:6px 0;cursor:pointer;flex-wrap:wrap;}'
			+ '#' + MODAL_ID + ' .dwf-hrow:hover{border-color:rgba(255,255,255,.16);background:var(--wf-subtle);}'
			+ '#' + MODAL_ID + ' .dwf-hname{font-weight:600;color:var(--wf-strong);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;}'
			+ '#' + MODAL_ID + ' .dwf-hid{color:var(--wf-muted);font-size:11px;}'
			+ '#' + MODAL_ID + ' .dwf-hmeta{margin-left:auto;color:var(--wf-muted);font-size:11px;white-space:nowrap;}'
			+ '#' + MODAL_ID + ' .dwf-hcalls{padding:4px 12px 10px;font-size:11.5px;color:var(--wf-muted);}'
			+ '#' + MODAL_ID + ' .dwf-hbtn{font-size:11px;border:1px solid var(--wf-border);background:var(--wf-subtle);color:var(--wf-text);border-radius:8px;padding:3px 9px;cursor:pointer;flex:none;}'
			+ '#' + MODAL_ID + ' .dwf-hbtn:hover{color:var(--wf-strong);border-color:rgba(255,255,255,.22);}'
			+ '#' + MODAL_ID + ' .dwf-hbtn:disabled{opacity:.5;cursor:default;}'
			+ '[data-dwf-card] .dwf-offline{display:flex;gap:8px;align-items:center;background:rgba(255,113,105,.08);border:1px solid rgba(255,113,105,.35);border-radius:10px;padding:8px 12px;margin:2px 2px 12px;font-size:12px;color:var(--wf-failure);flex-wrap:wrap;}'
			+ '[data-dwf-card] .dwf-unbound{display:inline-flex;align-items:center;margin-left:8px;font-size:10.5px;color:var(--wf-muted);border:1px dashed var(--wf-border);border-radius:999px;padding:1px 8px;white-space:nowrap;}'
			+ '[data-dwf-card] .dwf-notice{color:var(--wf-accent);font-size:12px;margin-top:8px;}'
			+ '[data-dwf-card] .dwf-foot{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;}';

		CSS += '[data-dwf-card],#' + MODAL_ID + ',[data-dwf-line]{--wf-text:#d7d9de;--wf-strong:#eceef2;--wf-muted:#a0a4af;--wf-surface:#1a1b20;--wf-subtle:rgba(255,255,255,.035);--wf-border:rgba(255,255,255,.10);--wf-inset:rgba(0,0,0,.22);--wf-ask:#ffce8a;--wf-success:#3fca68;--wf-failure:#ff7169;--wf-accent:#ffb13d;}'
			+ '[data-dwf-theme="light"] [data-dwf-card],[data-dwf-theme="light"] #' + MODAL_ID + ',[data-dwf-theme="light"] [data-dwf-line]{--wf-text:#343944;--wf-strong:#20242d;--wf-muted:#596273;--wf-surface:#ffffff;--wf-subtle:#f6f7f9;--wf-border:#dce1e8;--wf-inset:#f0f2f5;--wf-ask:#855100;--wf-success:#21783e;--wf-failure:#ba3029;--wf-accent:#956000;}'
			+ '[data-dwf-theme="light"] [data-dwf-card]{box-shadow:0 2px 8px rgba(25,35,50,.07);}'
			+ '[data-dwf-card] .dwf-qsend{background:#ffb13d;color:#241703;}'
			+ '[data-dwf-card] .dwf-qsend:disabled,[data-dwf-card] .dwf-ico:disabled{opacity:.65;cursor:default;}'
			+ '[data-dwf-card] .dwf-error{color:var(--wf-failure);font-size:12px;overflow-wrap:anywhere;margin-top:8px;}'
			+ '[data-dwf-card] .dwf-stats{white-space:normal;}'
			+ '[data-dwf-card] .dwf-ico:focus-visible,[data-dwf-card] .dwf-pill:focus-visible{outline:2px solid var(--wf-accent);outline-offset:2px;}';

		function syncTheme() {
			var color = getComputedStyle(document.body).backgroundColor;
			var nums = color && color.match(/[\d.]+/g);
			if (!nums || nums.length > 3 && Number(nums[3]) === 0) nums = (getComputedStyle(document.documentElement).backgroundColor || '').match(/[\d.]+/g);
			var light = nums && nums.length >= 3 && !(nums.length > 3 && Number(nums[3]) === 0)
				? Number(nums[0]) * .2126 + Number(nums[1]) * .7152 + Number(nums[2]) * .0722 > 145
				: !window.matchMedia('(prefers-color-scheme: dark)').matches;
			document.documentElement.setAttribute('data-dwf-theme', light ? 'light' : 'dark');
		}

		function ensureStyle() {
			if (document.body) syncTheme();
			if (document.getElementById(STYLE_ID)) return;
			var style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function esc(s) {
			return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
				return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
			});
		}
		function cssEscape(s) {
			return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, function (c) { return '\\' + c; });
		}
		function hue(s) {
			var h = 0; s = String(s || '');
			for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
			return h;
		}
		function isLive(run) {
			return run.status === 'running' || run.status === 'cancelling';
		}
		function runById(id) {
			for (var i = 0; i < runs.length; i++) if (identity(runs[i]) === id) return runs[i];
			return null;
		}
		function uniqueRunId(runId) {
			var n = 0;
			for (var i = 0; i < runs.length; i++) if (runs[i].runId === runId) n++;
			return n === 1;
		}
		// Legacy close sets were keyed by bare runId; migrate them only when that runId is
		// unique across roots — an ambiguous id must not dismiss anything.
		function isDismissed(run) {
			var id = identity(run);
			if (dismissed.has(id)) return true;
			if (run.runKey && dismissed.has(run.runId) && uniqueRunId(run.runId)) return true;
			return false;
		}
		function hasVisible(run) {
			var id = identity(run);
			if (visibleRuns.has(id)) return true;
			if (run.runKey && visibleRuns.has(run.runId) && uniqueRunId(run.runId)) return true;
			return false;
		}
		function runQuery(run, extra) {
			return 'run=' + encodeURIComponent(identity(run))
				+ '&startedAt=' + encodeURIComponent(run.startedAt == null ? '' : run.startedAt)
				+ (extra ? '&' + extra : '');
		}
		function fmtClock(ms) {
			try { return new Date(ms).toTimeString().slice(0, 8); } catch (e) { return ''; }
		}
		// URL allow-list: only http/https may become an anchor. This is a protocol check,
		// not an HTML-escape substitute.
		function isSafeUrl(u) {
			var s = String(u || '').trim();
			return /^https?:\/\//i.test(s) && !/[\s"'<>\\]/.test(s);
		}

		// ---------- phase semantics (REPAIR-024 §phase) ----------
		// settled counts finished agents; failed is a subset of settled; rejected is separate.
		// A phase is SUCCESS only when every dispatched agent ended clean; "all settled" is
		// not "success". Zero-agent phases derive completion from later phases or the run's
		// terminal state — except the current phase of a terminated run, which must not
		// masquerade as success.
		function phaseMeta(run, phases, i) {
			var p = phases[i];
			var d = p.dispatched || 0;
			var finished = (p.settled || 0) + (p.rejected || 0);
			var failed = p.failed || 0;
			var rejected = p.rejected || 0;
			var laterActive = false;
			for (var j = i + 1; j < phases.length; j++) if ((phases[j].dispatched || 0) > 0) { laterActive = true; break; }
			var state = '';
			if (d > 0 && finished >= d) {
				if (failed + rejected >= d) state = failed >= rejected ? 'failed' : 'rejected';
				else if (failed + rejected > 0) state = 'partial';
				else state = 'done';
			} else if (d === 0) {
				if (laterActive || run.status === 'completed') state = 'done';
			} else if (p.name === run.currentPhase && (isLive(run) || run.status === 'stale')) {
				state = 'now';
			}
			return { state: state, finished: finished, total: d, failed: failed, rejected: rejected };
		}
		function phaseCountText(m) {
			var base = m.finished + '/' + m.total;
			var extra = [];
			if (m.failed > 0) extra.push('失败' + m.failed);
			if (m.rejected > 0) extra.push('拒绝' + m.rejected);
			return base + (extra.length ? ' · ' + extra.join(' · ') : '');
		}

		// ---------- sidebar progress lines: native origin or explicit legacy bindings ----------
		function phaseDots(run) {
			var phases = run.phases || [];
			var html = '';
			for (var i = 0; i < phases.length && i < 5; i++) {
				var m = phaseMeta(run, phases, i);
				html += '<span class="dwf-dot ' + m.state + '" title="' + esc(phases[i].name) + '"></span>';
			}
			return html;
		}
		function lineHtml(run) {
			return '<div data-' + LINE_ATTR + '="1"><span class="dwf-fork">⑂</span>' + phaseDots(run)
				+ '<span class="dwf-txt" title="' + esc(run.name || run.runId) + '">' + esc(run.currentPhase || run.name || run.runId) + '</span></div>';
		}
		function setRowStyle(row) {
			if (!row._dwfStyleSaved) row._dwfStyleSaved = { flexWrap: row.style.flexWrap || '', height: row.style.height || '', minHeight: row.style.minHeight || '' };
			row.style.flexWrap = 'wrap';
			row.style.height = 'auto';
			row.style.minHeight = '32px';
		}
		function restoreRowStyle(row) {
			var b = row && row._dwfStyleSaved;
			if (!b) return;
			row.style.flexWrap = b.flexWrap;
			row.style.height = b.height;
			row.style.minHeight = b.minHeight;
			delete row._dwfStyleSaved;
		}
		function sweepSidebar() {
			var rows = document.querySelectorAll(SESSION_ROW_SEL);
			rows.forEach(function (row) {
				var sid = (row.getAttribute && row.getAttribute(SESSION_ID_ATTR)) || '';
				var hit = null;
				if (sid) {
					// Only an explicitly bound run may claim a row; when several are bound to
					// the same session the newest started run wins.
					for (var i = 0; i < runs.length; i++) {
						var b = bindingOf(runs[i]);
						if (b && b.host === 'dsh' && b.sessionId === sid) {
							if (!hit || String(runs[i].startedAt || '') > String(hit.startedAt || '')) hit = runs[i];
						}
					}
				}
				var old = row.querySelector('[data-' + LINE_ATTR + ']');
				if (!hit) {
					if (old) { restoreRowStyle(row); old.remove(); }
					row.removeAttribute('data-dwf-run');
					return;
				}
				var key = identity(hit) + ':' + hit.startedAt + ':' + hit.updatedAt + ':' + hit.status;
				if (old && row.getAttribute('data-dwf-run') === key) return;
				if (old) old.remove();
				setRowStyle(row);
				row.setAttribute('data-dwf-run', key);
				row.insertAdjacentHTML('beforeend', lineHtml(hit));
			});
		}

		// ---------- conversation run cards ----------
		var STATUS_CN = { running: '工作流运行中', cancelling: '工作流取消中', completed: '工作流已完成', failed: '工作流失败', cancelled: '工作流已取消', stale: '工作流已中断' };
		// Horizontal phase columns (reference layout): small dot on top, then phase name and
		// finished/total count, columns joined by a short connector line.
		function phaseColsHtml(run) {
			var phases = run.phases || [];
			if (!phases.length) return '';
			var html = '<div class="dwf-phasecols">';
			for (var i = 0; i < phases.length; i++) {
				var p = phases[i];
				var m = phaseMeta(run, phases, i);
				html += '<div class="dwf-pcol ' + m.state + '"><span class="dwf-pdot"></span><span class="dwf-pname" title="' + esc(p.name) + '">' + esc(p.name) + '</span><span class="dwf-pc">' + esc(phaseCountText(m)) + '</span></div>';
			}
			return html + '</div>';
		}
		var CALL_STATE = { running: '运行中', done: '已完成', failed: '失败', replayed: '重放命中', rejected: '已拒绝', stale: '已中断' };
		function fmtTokens(n) {
			if (!n) return '';
			if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
			if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
			return String(n);
		}
		function fmtMs(ms) {
			if (ms == null) return '';
			if (ms < 1000) return ms + 'ms';
			if (ms < 60000) return (ms / 1000).toFixed(1) + '秒';
			var seconds = Math.round(ms / 1000);
			var m = Math.floor(seconds / 60);
			var s = seconds % 60;
			return m + '分' + String(s).padStart(2, '0') + '秒';
		}
		// Compact single-line agent capsules stacked in narrow columns next to the script
		// cell (reference layout) — not a full-width card grid.
		function agentCapsule(c) {
			var live = c.state === 'running';
			var st = live ? '<span class="dwf-spin"></span>' : '<span class="dwf-agst ' + esc(c.state) + '">' + esc(CALL_STATE[c.state] || c.state) + '</span>';
			var av = '<span class="dwf-av2" style="background:hsl(' + hue(c.callId) + ',55%,48%)">' + esc((String(c.label || c.callId || '?').trim().charAt(0)) || '?') + '</span>';
			var tip = (c.label || c.callId) + (c.reason ? ' · ' + c.reason : '') + (c.preview ? ' · ' + c.preview : '');
			return '<div class="dwf-ag" title="' + esc(tip) + '">' + av + '<span class="dwf-lb">' + esc(c.label || c.callId) + '</span>' + st + '</div>';
		}
		function workRowHtml(run) {
			var calls = run.calls || [];
			var show = calls.slice(-24);
			var cols = show.length ? Math.min(3, Math.max(1, Math.ceil(show.length / 8))) : 0;
			var html = '<div class="dwf-workrow">';
			html += '<button class="dwf-scriptcell" data-act="script" title="查看脚本"><span>&gt;_ 脚本</span>' + (isLive(run) ? '<span class="dwf-spin"></span>' : '<span class="dwf-scok">✓</span>') + '</button>';
			for (var c = 0; c < cols; c++) {
				html += '<div class="dwf-agcol">';
				for (var i = c; i < show.length; i += cols) html += agentCapsule(show[i]);
				html += '</div>';
			}
			html += '</div>';
			if (calls.length > show.length) html += '<button class="dwf-more" data-act="agentsfull">…共 ' + calls.length + ' 个子代理，显示最近 ' + show.length + ' 个 · 查看全部</button>';
			return html;
		}
		// ---- card sections: questions / artifacts / logs ----
		function questionsHtml(run) {
			var qs = run.questions || [];
			var waiting = qs.filter(function (q) { return q && q.state === 'waiting' && isLive(run); });
			var answered = qs.filter(function (q) { return q && q.state === 'answered'; }).slice(-2);
			var failed = qs.filter(function (q) { return q && (q.state === 'failed' || q.state === 'waiting' && !isLive(run)); });
			if (!waiting.length && !answered.length && !failed.length) return '';
			var html = '<div class="dwf-qzone">';
			for (var i = 0; i < waiting.length; i++) {
				var q = waiting[i];
				var answer = controlsFor(run).answers.get(q.qId);
				var busy = answer && (answer.status === 'pending' || answer.status === 'submitted');
				var submitted = answer && answer.status === 'submitted';
				html += '<div class="dwf-q waiting" data-question="' + esc(q.qId) + '"><span class="dwf-qtext">❓ ' + esc(q.question) + '</span>'
					+ '<input class="dwf-qin" data-act="qinput" data-q="' + esc(q.qId) + '" aria-label="' + esc(q.question) + '" value="' + esc(answer && !submitted ? answer.value : '') + '" placeholder="' + (submitted ? '已提交，等待工作流接收…' : '输入回答…') + '"' + (busy ? ' disabled=""' : '') + ' />'
					+ '<button class="dwf-qsend" data-act="answer" data-q="' + esc(q.qId) + '"' + (busy ? ' disabled=""' : '') + '>' + (submitted ? '已提交' : busy ? '提交中…' : '回答') + '</button>'
					+ (answer && answer.error ? '<span class="dwf-error" role="alert">' + esc(answer.error) + '</span>' : '') + '</div>';
			}
			failed.forEach(function (q) {
				html += '<div class="dwf-q dwf-error" data-question="' + esc(q.qId) + '">! ' + esc(q.question) + ' · ' + esc(q.error || q.reason || '回答未完成；详细原因见运行结果') + '</div>';
			});
			for (var j = 0; j < answered.length; j++) {
				var a = answered[j];
				html += '<div class="dwf-q answered" data-question="' + esc(a.qId) + '">✔ ' + esc(a.question) + ' → ' + esc(a.answerPreview || '') + '</div>';
			}
			return html + '</div>';
		}
		var KIND_ICON = { file: '📎', document: '📄', dashboard: '📊', text: '📝' };
		function artifactsHtml(run) {
			var arts = run.artifacts || [];
			if (!arts.length) return '';
			var html = '<div class="dwf-arts">';
			for (var i = 0; i < arts.length; i++) {
				var a = arts[i];
				var inner = '<span class="dwf-atitle" title="' + esc(a.path || a.url || a.title) + '">' + esc(a.title) + '</span>';
				if (a.url) {
					if (isSafeUrl(a.url)) inner = '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
					else inner += '<span class="dwf-artwarn">（已阻止不安全链接协议）</span>';
				} else if (a.path) {
					// File artifacts are fetched through the authenticated API and served as a
					// Blob URL; the raw path never becomes a link.
					inner = '<button class="dwf-artopen" data-act="artifact" data-index="' + i + '" title="通过 API 安全下载或预览">' + inner + '<span class="dwf-star">⤓</span></button>';
				}
				html += '<span class="dwf-art' + (a.primary ? ' primary' : '') + '" title="' + esc(a.kind + (a.path ? ' · ' + a.path : '')) + '">'
					+ (a.primary ? '<span class="dwf-star">★</span>' : '') + (KIND_ICON[a.kind] || '📝') + inner + '</span>';
			}
			return html + '</div>';
		}
		var lastLogCount = new Map();
		function logsHtml(run) {
			var logs = run.logs || [];
			if (!logs.length) return '';
			var show = logs.slice(-4);
			var html = '<div class="dwf-logs">';
			for (var i = 0; i < show.length; i++) {
				var fresh = run.status === 'running' && logs.length !== lastLogCount.get(identity(run)) && i === show.length - 1;
				html += '<div class="dwf-logline' + (fresh ? ' fresh' : '') + '">' + esc(show[i].text) + '</div>';
			}
			html += '</div>';
			if (logs.length > show.length) html += '<button class="dwf-more" data-act="logsfull">…共 ' + logs.length + ' 条，显示最近 ' + show.length + ' 条 · 查看全部</button>';
			lastLogCount.set(identity(run), logs.length);
			return html;
		}
		function cardHtml(run) {
			var control = controlsFor(run);
			var running = isLive(run);
			var cur = currentSessionId();
			var bound = bindingOf(run);
			var liveAgents = (run.calls || []).filter(function (c) { return c.state === 'running'; }).length;
			var endedAgents = Number.isFinite(run.settled) ? run.settled : (run.calls || []).filter(function (c) { return c.state === 'done' || c.state === 'failed' || c.state === 'replayed'; }).length;
			var stats = (run.phases || []).length + ' 个阶段 · ' + (running ? liveAgents : endedAgents) + ' 个子代理' + (running ? '工作中' : '已结束');
			var started = Date.parse(run.startedAt);
			var elapsed = running && Number.isFinite(started) ? Math.max(run.elapsedMs || 0, Date.now() - started) : run.elapsedMs;
			if (elapsed != null) stats += ' · ' + fmtMs(elapsed);
			if (run.tokens && ((run.tokens.input || 0) + (run.tokens.output || 0)) > 0) stats += ' · ' + fmtTokens((run.tokens.input || 0) + (run.tokens.output || 0)) + ' tokens';
			var result = '';
			if (!running && run.resultPreview) {
				result = '<div class="dwf-result" data-act="resultopen" title="点击查看完整结果">' + esc(run.resultPreview) + '</div>';
			}
			var resumable = run.status === 'failed' || run.status === 'cancelled' || run.status === 'stale';
			return '<div data-dwf-card="1" data-run="' + esc(identity(run)) + '">'
				+ '<div class="dwf-head"><span class="dwf-title"><span class="dwf-gear">' + (running ? '⚙' : run.status === 'completed' ? '✓' : '!') + '</span>' + esc(STATUS_CN[run.status] || run.status) + '</span>'
				+ '<span class="dwf-runname">' + esc(run.name || run.runId) + '</span>'
				+ (bound ? '' : '<span class="dwf-unbound" title="未绑定到任何会话；可在绑定后归入会话视图">未绑定</span>')
				+ '<span class="dwf-stats">' + (running ? '<span class="dwf-live-dot"></span>' : '') + esc(stats) + '</span>'
				+ '<span class="dwf-icos">'
				+ (running ? '<button class="dwf-ico" data-act="stop" title="' + (control.stop ? '停止请求已发送' : '停止工作流') + '"' + (control.stop ? ' disabled=""' : '') + '>' + (control.stop ? '…' : '⏹') + '</button>' : '<button class="dwf-ico dwf-close" data-act="close" title="关闭卡片（保留运行数据）">×</button>')
				+ (resumable ? '<button class="dwf-ico dwf-resume" data-act="resume" title="恢复运行"' + (control.resume ? ' disabled=""' : '') + '>' + (control.resume ? '…' : '↻') + '</button>' : '')
				+ '<button class="dwf-ico" data-act="expand" title="展开/收起">⤢</button>'
				+ '</span></div>'
				+ (control.error ? '<div class="dwf-error" role="alert">' + esc(control.error) + '</div>' : '')
				+ (control.stop === 'requested' ? '<div class="dwf-notice" role="status">已发送停止请求，等待工作流确认…</div>' : '')
				+ questionsHtml(run) + phaseColsHtml(run) + workRowHtml(run) + artifactsHtml(run) + logsHtml(run) + result
				+ '<div class="dwf-foot">'
				+ '<button class="dwf-pill" data-act="board">📋 发现看板（按严重度）</button>'
				+ '<button class="dwf-pill" data-act="result">📄 结果</button>'
				+ '<button class="dwf-pill" data-act="history">🗂 历史</button>'
				+ (cur && !bound ? '<button class="dwf-pill" data-act="bind" title="把该运行绑定到当前会话">🔗 绑定当前会话</button>' : '')
				+ '</div>'
				+ '</div>';
		}
		// Session view: cards bound to the current session plus unbound live/already-watched
		// runs (so they can be bound and stay until closed); unbound finished runs that were
		// never watched live in the global history only. Without a verifiable current session
		// the fallback is attribution-safe: only unbound runs the user is already watching —
		// never other sessions' runs and never an auto-introduced "newest finished" card
		// (024-R4: the old global fallback was the same behaviour the new-conversation
		// card complaint rejected on MMX; the history modal remains the global surface).
		function sessionPool() {
			var cur = currentSessionId();
			return runs.filter(function (r) {
				var b = bindingOf(r);
				if (b) return !!cur && b.host === 'dsh' && b.sessionId === cur;
				return isLive(r) || hasVisible(r);
			});
		}
		function sortPicked(list) {
			return list.slice().sort(function (a, b) {
				var la = isLive(a) ? 0 : 1, lb = isLive(b) ? 0 : 1;
				if (la !== lb) return la - lb;
				return String(b.startedAt || b.updatedAt || '').localeCompare(String(a.startedAt || a.updatedAt || ''));
			});
		}
		function pickCardRuns() {
			var pool = sessionPool();
			var before = visibleRuns.size;
			var picked = [];
			for (var i = 0; i < pool.length; i++) {
				var r = pool[i];
				if (isDismissed(r)) { visibleRuns.delete(identity(r)); continue; }
				visibleRuns.add(identity(r));
				picked.push(r);
			}
			if (visibleRuns.size !== before) saveVisible();
			return sortPicked(picked);
		}
		function syncSections(parent, fresh) {
			var keep = [];
			Array.from(fresh.children).forEach(function (next) {
				var key = next.getAttribute('data-question') || next.className;
				var old = Array.from(parent.children).find(function (el) { return (el.getAttribute('data-question') || el.className) === key; });
				if (old && old.innerHTML === next.innerHTML) { keep.push(old); return; }
				if (old && old.classList.contains('dwf-qzone')) {
					syncSections(old, next); keep.push(old); return;
				}
				if (old) { parent.insertBefore(next, old); old.remove(); }
				else parent.appendChild(next);
				keep.push(next);
			});
			Array.from(parent.children).forEach(function (el) { if (keep.indexOf(el) < 0) el.remove(); });
			keep.forEach(function (el, i) { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
		}
		function findAnchor() {
			var anchor = null;
			var areas = document.querySelectorAll('[class*="viewArea"]');
			for (var j = 0; j < areas.length; j++) {
				if (!anchor || areas[j].clientHeight > anchor.clientHeight) anchor = areas[j];
			}
			return anchor;
		}
		function claimAnchor(anchor) {
			if (cardAnchor === anchor) return;
			if (getComputedStyle(anchor).position === 'static') {
				if (anchor._dwfPosSaved === undefined) anchor._dwfPosSaved = anchor.style.position || '';
				anchor.style.position = 'relative';
			}
			cardAnchor = anchor;
		}
		function restoreAnchor() {
			if (cardAnchor && cardAnchor._dwfPosSaved !== undefined) {
				cardAnchor.style.position = cardAnchor._dwfPosSaved;
				delete cardAnchor._dwfPosSaved;
			}
			cardAnchor = null;
		}
		function bannersHtml(pickCount) {
			var html = '';
			if (offline) {
				html += '<div class="dwf-offline" role="alert">⚠ 连接中断'
					+ (lastHttpError ? ' · ' + esc(lastHttpError) : '')
					+ (lastSyncAt ? ' · 最后同步 ' + esc(fmtClock(lastSyncAt)) : '')
					+ ' · 以下信息可能已过期，恢复连接后自动刷新</div>';
			}
			if (persistWarning) html += '<div class="dwf-error" role="alert">' + esc(persistWarning) + '</div>';
			var cur = currentSessionId();
				if (cur && runs.length && pickCount === 0) html += '<div class="dwf-notice" role="status">当前会话暂无绑定的运行 · <button class="dwf-more" data-act="history">打开全局历史绑定…</button></div>';
				return html;
		}
		function sweepCard() {
			var host = document.getElementById(CARD_ID);
			if (cardAnchor && !cardAnchor.isConnected) restoreAnchor();
			var pick = pickCardRuns();
			if (!pick.length && !offline && !persistWarning && !(currentSessionId() && runs.length)) {
				if (host) host.remove();
				restoreAnchor();
				return;
			}
			var anchor = findAnchor();
			if (!anchor) return;
			claimAnchor(anchor);
			if (!host) {
				host = document.createElement('div');
				host.id = CARD_ID;
				host.addEventListener('click', onCardClick);
			}
			if (host.parentNode !== anchor) anchor.insertBefore(host, anchor.firstChild);
			var oldBanner = host.querySelector('[data-dwf-banner]');
			if (oldBanner) oldBanner.remove();
			var banners = bannersHtml(pick.length);
			if (banners) host.insertAdjacentHTML('beforeend', '<div data-dwf-banner="1">' + banners + '</div>');
			var current = new Map();
			Array.from(host.children).forEach(function (card) { if (card.getAttribute && card.getAttribute('data-run')) current.set(card.getAttribute('data-run'), card); });
			pick.forEach(function (run) {
				var id = identity(run);
				var html = cardHtml(run);
				var card = current.get(id);
				if (!card || card._workflowMarkup !== html) {
					var temp = document.createElement('div'); temp.innerHTML = html;
					var fresh = temp.firstChild;
					if (!card) { card = fresh; host.appendChild(card); }
					else syncSections(card, fresh);
					card._workflowMarkup = html;
				}
				current.delete(id);
			});
			current.forEach(function (card) { card.remove(); });
			// Deterministic order: banner first, then pick order (live first, newest started).
			var ref = null;
			var banner = host.querySelector('[data-dwf-banner]');
			if (banner && host.firstChild !== banner) host.insertBefore(banner, host.firstChild);
			ref = banner;
			pick.forEach(function (run) {
				var el = host.querySelector('[data-run="' + cssEscape(identity(run)) + '"]');
				if (!el) return;
				if (ref ? ref.nextSibling !== el : host.firstChild !== el) host.insertBefore(el, ref ? ref.nextSibling : host.firstChild);
				ref = el;
			});
		}
		function verdictOf(r, b) {
			return !!r.ok && !(b && b.ok === false);
		}
		function apiJson(r) {
			return r.json().then(function (body) {
				if (!verdictOf(r, body)) throw new Error((body && body.error) || ('HTTP ' + r.status));
				return body;
			});
		}
		function apiVerdict(r) {
			return r.json().catch(function () { return {}; }).then(function (b) {
				return { ok: verdictOf(r, b), b: b, status: r.status };
			});
		}
		function onCardClick(ev) {
			var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
			if (!t) return;
			var card = t.closest('[data-dwf-card]');
			var run = card ? runById(card.getAttribute('data-run')) : null;
			var act = t.getAttribute('data-act');
			if (act === 'expand') { card.classList.toggle('dwf-full'); return; }
			if (act === 'close') {
				var id = card.getAttribute('data-run');
				dismissed.add(id);
				saveDismissed(dismissed);
				visibleRuns.delete(id); saveVisible();
				card.remove();
				return;
			}
			if (act === 'bind') {
				if (!run) return;
				var cur = currentSessionId();
				if (!cur) return;
				bindRunToSession(run, cur);
				return;
			}
			if (act === 'answer') {
				if (!run) return;
				var state = controlsFor(run), qId = t.getAttribute('data-q');
				var previous = state.answers.get(qId);
				if (previous && (previous.status === 'pending' || previous.status === 'submitted')) return;
				var input = card.querySelector('.dwf-qin[data-q="' + cssEscape(qId) + '"]');
				var val = input ? input.value.trim() : '';
				if (!val) { if (input) input.focus(); return; }
				var answer = { status: 'pending', value: input.value, error: '' };
				state.answers.set(qId, answer);
				sweepCard();
				var aid = identity(run);
				apiFetch(API + '/answer?' + runQuery(run, 'q=' + encodeURIComponent(qId)), {
					method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: val }),
				})
					.then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: verdictOf(r, b), b: b, status: r.status }; }); })
					.then(function (x) {
						if (stopped) return;
						var latest = runById(aid);
						if (!latest || controlsFor(latest) !== state) return; // lifecycle changed meanwhile
						answer.status = x.ok ? 'submitted' : 'error';
						answer.error = x.ok ? '' : String((x.b && x.b.error) || ('提交失败（HTTP ' + x.status + '）'));
						sweepCard();
					})
					.catch(function (e) {
						if (stopped) return;
						var latest = runById(aid);
						if (!latest || controlsFor(latest) !== state) return;
						answer.status = 'error';
						answer.error = '提交失败：' + String(e && e.message || e);
						sweepCard();
					});
				return;
			}
			if (act === 'resume') {
				if (!run) return;
				var control = controlsFor(run);
				if (control.resume) return;
				control.resume = 'pending'; control.error = ''; sweepCard();
				var rid = identity(run);
				apiFetch(API + '/resume?' + runQuery(run), { method: 'POST' })
					.then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: verdictOf(r, b), b: b, status: r.status }; }); })
					.then(function (x) {
						if (stopped) return;
						var latest = runById(rid);
						if (!latest || controlsFor(latest) !== control) return;
						control.error = x.ok ? '' : String((x.b && x.b.error) || ('恢复失败（HTTP ' + x.status + '），请重试'));
						control.resume = x.ok ? 'cooldown' : '';
						sweepCard();
						if (control.resume) setTimeout(function () { control.resume = ''; if (!stopped) sweepCard(); }, 3000);
					})
					.catch(function (e) {
						if (stopped) return;
						var latest = runById(rid);
						if (!latest || controlsFor(latest) !== control) return;
						control.resume = ''; control.error = '恢复失败：' + String(e && e.message || e); sweepCard();
					});
				return;
			}
			if (act === 'history') { openHistory(); return; }
			if (!run) return;
			if (act === 'stop') {
				if (!isLive(run)) return;
				var st = controlsFor(run);
				if (st.stop) return; // single submit
				st.stop = 'pending'; st.error = ''; sweepCard();
				var sid = identity(run);
				apiFetch(API + '/stop?' + runQuery(run), { method: 'POST' })
					.then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: verdictOf(r, b), b: b, status: r.status }; }); })
					.then(function (x) {
						if (stopped) return;
						var latest = runById(sid);
						if (!latest || controlsFor(latest) !== st) return;
						if (x.ok) { st.stop = 'requested'; st.error = ''; }
						else { st.stop = ''; st.error = String((x.b && x.b.error) || ('停止失败（HTTP ' + x.status + '）')); }
						sweepCard();
					})
					.catch(function (e) {
						if (stopped) return;
						var latest = runById(sid);
						if (!latest || controlsFor(latest) !== st) return;
						st.stop = ''; st.error = '停止请求失败：' + String(e && e.message || e); sweepCard();
					});
				return;
			}
			if (act === 'script') { openScript(run); return; }
			if (act === 'board') { openBoard(run); return; }
			if (act === 'result' || act === 'resultopen') { openResult(run); return; }
						if (act === 'agentsfull') { openAgentsFull(run); return; }
			if (act === 'logsfull') { openLogsFull(run); return; }
			if (act === 'artifact') { openArtifact(run, t.getAttribute('data-index')); return; }
		}

		// ---------- modals: script + findings board + result + history + full lists ----------
		var mEl = null, mTitle = null, mBody = null;
		var modalGen = 0;
		var modalView = null;
		function ensureModal() {
			if (mEl && document.getElementById(MODAL_ID) === mEl) { mEl.style.display = 'flex'; return; }
			mEl = document.createElement('div');
			mEl.id = MODAL_ID;
			mEl.style.display = 'flex';
			mEl.setAttribute('role', 'dialog');
			mEl.setAttribute('aria-label', '工作流详情');
			mEl.innerHTML = '<div class="dwf-mbox"><div class="dwf-mhead"><span id="dwf-mtitle"></span><button class="dwf-mclose" data-act="mclose">×</button></div><div class="dwf-mbody"></div></div>';
			document.body.appendChild(mEl);
			mTitle = mEl.querySelector('#dwf-mtitle');
			mBody = mEl.querySelector('.dwf-mbody');
			mEl.addEventListener('click', function (ev) {
				var t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
				if (t && (t.getAttribute('data-act') === 'bindcurrent' || t.getAttribute('data-act') === 'unbindcurrent')) {
					var id = t.getAttribute('data-hrun');
					var r = runById(id);
					if (!r) { for (var i = 0; i < historyRuns.length; i++) if (identity(historyRuns[i]) === id) { r = historyRuns[i]; break; } }
					if (t.getAttribute('data-act') === 'bindcurrent') {
						var cur = currentSessionId();
						if (cur && r) bindRunToSession(r, cur);
					} else if (r) unbindRun(r);
					if (mEl && mEl.style.display === 'flex') renderHistory();
					return;
				}
				if (ev.target === mEl || (t && t.getAttribute('data-act') === 'mclose')) {
					mEl.style.display = 'none';
					revokeModalBlobs();
				}
			});
		}
		// Every modal open records (generation, view type, run identity); a late response is
		// applied only when the modal still shows the same view of the same run.
		function beginView(type, id) {
			ensureModal();
			revokeModalBlobs();
			modalGen++;
			var run = id == null ? null : runById(String(id));
			modalView = { gen: modalGen, type: type, id: id == null ? null : String(id), startedAt: run ? String(run.startedAt || '') : null };
			return modalView;
		}
		function invalidateModalLifecycle() {
			if (!modalView || modalView.id === null) return;
			var run = runById(modalView.id);
			if (run && String(run.startedAt || '') === modalView.startedAt) return;
			modalView = null;
			revokeModalBlobs();
			if (mBody) mBody.textContent = '运行生命周期已变化或记录已移除，请重新打开详情。';
		}
		function viewCurrent(view, type, id) {
			invalidateModalLifecycle();
			return !stopped && view && modalView === view && view.type === type && view.id === (id == null ? null : String(id))
				&& mEl && mEl.style.display === 'flex' && document.getElementById(MODAL_ID) === mEl;
		}
		function trackBlobUrl(url) { activeBlobUrls.push(url); return url; }
		function revokeModalBlobs() {
			activeBlobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
			activeBlobUrls.length = 0;
		}
		function showTextPreview(pre, text, limit, name) {
			text = String(text == null ? '(无结果)' : text);
			pre.textContent = text.length > limit ? text.slice(0, limit) + '\n…（已截断：显示前 ' + limit + ' 个 UTF-16 字符，共 ' + text.length + ' 个）' : text;
			if (text.length <= limit) return;
			var link = document.createElement('a');
			link.href = trackBlobUrl(URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })));
			link.download = name;
			link.className = 'dwf-hbtn';
			link.textContent = '下载完整文本';
			mBody.appendChild(link);
		}
		function openScript(run) {
			var rid = identity(run);
			var view = beginView('script', rid);
			mTitle.textContent = '脚本 · ' + (run.name || rid);
			mBody.innerHTML = '';
			var pre = document.createElement('pre');
			pre.className = 'dwf-code';
			pre.textContent = '加载中…';
			mBody.appendChild(pre);
			var cacheKey = rid + ':' + String(run.startedAt || '');
			if (scriptCache[cacheKey]) { pre.textContent = scriptCache[cacheKey]; return; }
			apiFetch(API + '/script?' + runQuery(run))
				.then(apiJson)
				.then(function (b) {
					if (!viewCurrent(view, 'script', rid)) return;
					if (b && b.ok) {
						if (b.scriptPath) {
							var p = document.createElement('div');
							p.className = 'dwf-stats';
							p.style.marginBottom = '6px';
							p.textContent = b.scriptPath;
							mBody.insertBefore(p, pre);
						}
						scriptCache[cacheKey] = b.script || '(空脚本)';
						pre.textContent = scriptCache[cacheKey];
					} else {
						pre.textContent = '读取失败: ' + ((b && b.error) || 'unknown');
					}
				})
				.catch(function (e) { if (!viewCurrent(view, 'script', rid)) return; pre.textContent = '读取失败: ' + e; });
		}
		function extractFindings(out) {
			var r = out && out.result;
			var arr = null;
			if (Array.isArray(r)) arr = r;
			else if (r && Array.isArray(r.findings)) arr = r.findings;
			else if (typeof r === 'string') {
				try {
					var j = JSON.parse(r);
					if (Array.isArray(j)) arr = j;
					else if (j && Array.isArray(j.findings)) arr = j.findings;
				} catch (e) {}
			}
			if (!arr) return null;
			arr = arr.filter(function (x) { return x && typeof x === 'object' && (x.title || x.summary); });
			return arr.length ? arr : null;
		}
		var SEV_ORDER = ['P0', 'P1', 'P2', 'P3', 'HIGH', 'MEDIUM', 'LOW'];
		function openBoard(run) {
			var rid = identity(run);
			var view = beginView('board', rid);
			mTitle.textContent = '发现看板（按严重度） · ' + (run.name || rid);
			mBody.innerHTML = '<div class="dwf-stats">加载中…</div>';
			apiFetch(API + '/result?' + runQuery(run))
				.then(apiJson)
				.then(function (b) {
					if (!viewCurrent(view, 'board', rid)) return;
					mBody.innerHTML = '';
					if (!b || !b.ok) {
						mBody.innerHTML = '<div class="dwf-stats">暂无结果：' + esc((b && b.error) || 'run 未结束') + '</div>';
						return;
					}
					var fs = extractFindings(b.out);
					if (!fs) {
						mBody.innerHTML = '<div class="dwf-stats">结果不是结构化发现（无 findings 数组），原文：</div>';
						var pre = document.createElement('pre');
						pre.className = 'dwf-code';
						showTextPreview(pre, JSON.stringify(b.out && b.out.result, null, 2), 8000, 'workflow-findings.txt');
						mBody.appendChild(pre);
						return;
					}
					var groups = {};
					fs.forEach(function (f) {
						var s = String(f.severity || f.level || '其它').toUpperCase();
						(groups[s] = groups[s] || []).push(f);
					});
					var appendSev = function (s, items) {
						var h = document.createElement('div');
						h.className = 'dwf-sev ' + s;
						h.textContent = s + ' · ' + items.length + ' 项';
						mBody.appendChild(h);
						items.forEach(function (f) {
							var d = document.createElement('div');
							d.className = 'dwf-fitem';
							var t = document.createElement('div');
							t.className = 'dwf-ftitle';
							t.textContent = f.title || f.summary || '';
							var x = document.createElement('div');
							x.className = 'dwf-fdetail';
							x.textContent = f.detail || f.description || f.evidence || '';
							d.appendChild(t);
							d.appendChild(x);
							mBody.appendChild(d);
						});
					};
					SEV_ORDER.forEach(function (s) { if (groups[s]) { appendSev(s, groups[s]); delete groups[s]; } });
					Object.keys(groups).forEach(function (s) { appendSev(s, groups[s]); });
				})
				.catch(function (e) { if (!viewCurrent(view, 'board', rid)) return; mBody.innerHTML = '<div class="dwf-stats">读取失败: ' + esc(String(e)) + '</div>'; });
		}

		// ---- full-result modal ----
		function openResult(run) {
			var rid = identity(run);
			var view = beginView('result', rid);
			mTitle.textContent = '结果 · ' + (run.name || rid);
			mBody.innerHTML = '<div class="dwf-stats">加载中…</div>';
			apiFetch(API + '/result?' + runQuery(run))
				.then(apiJson)
				.then(function (b) {
					if (!viewCurrent(view, 'result', rid)) return;
					mBody.innerHTML = '';
					var pre = document.createElement('pre');
					pre.className = 'dwf-code';
					if (!b || !b.ok) {
						pre.textContent = '暂无结果：' + ((b && b.error) || 'run 未结束');
					} else {
						var out = b.out;
						var text = out && out.error !== undefined ? 'error: ' + String(out.error)
							: out && out.result !== undefined ? JSON.stringify(out.result, null, 2) : '(无 result 字段)';
						showTextPreview(pre, text, 65536, 'workflow-result.txt');
					}
					mBody.appendChild(pre);
				})
				.catch(function (e) { if (!viewCurrent(view, 'result', rid)) return; mBody.innerHTML = '<div class="dwf-stats">读取失败: ' + esc(String(e)) + '</div>'; });
		}

		// ---- artifact modal: authenticated fetch -> text preview or Blob download ----
		function openArtifact(run, index) {
			var rid = identity(run);
			var view = beginView('artifact', rid);
			var arts = (run.artifacts || []);
			var art = arts[Number(index)] || {};
			var safeName = String(art.title || art.path || 'artifact').split(/[\\/]/).pop().replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_') || 'artifact';
			mTitle.textContent = '产物 · ' + (run.name || rid);
			mBody.innerHTML = '';
			var pre = document.createElement('pre');
			pre.className = 'dwf-code';
			pre.textContent = '加载产物中…';
			mBody.appendChild(pre);
			apiFetch(API + '/artifact?' + runQuery(run, 'index=' + encodeURIComponent(index)))
				.then(function (res) {
					if (!res.ok) {
						return res.json().catch(function () { return {}; }).then(function (b) {
							throw new Error((b && b.error) || ('读取失败（HTTP ' + res.status + '）'));
						});
					}
					var ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
					if (/^text\//i.test(ct) || /\bjson\b/i.test(ct)) return res.text().then(function (t) { return { text: t }; });
					return res.blob().then(function (blob) { return { blob: blob, ct: ct }; });
				})
				.then(function (out) {
					if (!viewCurrent(view, 'artifact', rid)) return;
					if (out.text !== undefined) { pre.textContent = out.text; return; }
					var url = trackBlobUrl(URL.createObjectURL(out.blob));
					mBody.innerHTML = '';
					var info = document.createElement('div');
					info.className = 'dwf-stats';
					info.textContent = '已通过认证 API 获取文件（Blob 链接不含任何凭据），已触发下载：';
					var a = document.createElement('a');
					a.href = url;
					a.download = safeName;
					a.textContent = '下载 ' + safeName;
					a.className = 'dwf-hbtn';
					mBody.appendChild(info);
					mBody.appendChild(a);
					try { a.click(); } catch (e) {}
				})
				.catch(function (e) {
					if (!viewCurrent(view, 'artifact', rid)) return;
					pre.textContent = '产物读取失败：' + String(e && e.message || e);
				});
		}

		// ---- full agent/log lists (truncation must always have a full view) ----
		function openAgentsFull(run) {
			var rid = identity(run);
			var view = beginView('agents', rid);
			mTitle.textContent = '子代理 · ' + (run.name || rid);
			mBody.innerHTML = '';
			var latest = runById(rid) || run;
			var calls = latest.calls || [];
			if (!calls.length) { mBody.innerHTML = '<div class="dwf-stats">（无调用记录）</div>'; return; }
			var box = document.createElement('div');
			box.className = 'dwf-hcalls';
			calls.forEach(function (c) {
				var line = document.createElement('div');
				line.textContent = (CALL_STATE[c.state] || c.state) + ' · ' + (c.label || c.callId)
					+ (c.usage ? ' · ' + fmtTokens((c.usage.input || 0) + (c.usage.output || 0)) + ' tokens' : '')
					+ (c.durationMs != null ? ' · ' + fmtMs(c.durationMs) : '');
				box.appendChild(line);
			});
			mBody.appendChild(box);
		}
		function openLogsFull(run) {
			var rid = identity(run);
			var view = beginView('logs', rid);
			mTitle.textContent = '日志 · ' + (run.name || rid);
			mBody.innerHTML = '';
			var latest = runById(rid) || run;
			var logs = latest.logs || [];
			if (!logs.length) { mBody.innerHTML = '<div class="dwf-stats">（无日志）</div>'; return; }
			var pre = document.createElement('pre');
			pre.className = 'dwf-code';
			pre.textContent = logs.map(function (l) { return l.text; }).join('\n');
			mBody.appendChild(pre);
		}

		// ---- history modal: GLOBAL list, unbound runs are clearly labelled; explicit bind ----
		function relTime(iso) {
			if (!iso) return '';
			var d = Date.now() - new Date(iso).getTime();
			if (d < 60000) return '刚刚';
			if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
			if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
			return Math.floor(d / 86400000) + '天前';
		}
		var historyRuns = [];
		function renderHistory() {
			if (!mBody) return;
			mBody.innerHTML = '';
			var cur = currentSessionId();
			var head = document.createElement('div');
			head.className = 'dwf-stats';
			head.textContent = cur ? '全局历史（含未绑定会话的运行）· 当前会话 ' + cur : '全局历史（含未绑定会话的运行）· 当前宿主未提供可核实的会话标识';
			mBody.appendChild(head);
			var list = historyRuns;
			if (!list.length) { mBody.innerHTML = '<div class="dwf-stats">还没有任何运行</div>'; return; }
			var statusColor = { running: '#ff9f0a', cancelling: '#ff9f0a', completed: '#34c759', failed: '#ff5f56', cancelled: '#8b8f99', stale: '#8b8f99' };
			list.forEach(function (r) {
				var rid = identity(r);
				var row = document.createElement('div');
				row.className = 'dwf-hrow';
				var phases = r.phases || [];
				var settled = phases.reduce(function (a, p) { return a + (p.settled || 0) + (p.rejected || 0); }, 0);
				var total = phases.reduce(function (a, p) { return a + (p.dispatched || 0); }, 0);
				var tok = r.tokens && ((r.tokens.input || 0) + (r.tokens.output || 0)) > 0 ? ' · ' + fmtTokens((r.tokens.input || 0) + (r.tokens.output || 0)) + ' tokens' : '';
				var el = r.elapsedMs != null ? ' · ' + fmtMs(r.elapsedMs) : '';
				row.innerHTML = '<span style="border:1px solid;color:' + (statusColor[r.status] || '#9a9ea8') + ';border-color:currentColor;border-radius:10px;padding:1px 9px;font-size:11px;white-space:nowrap;">' + esc(STATUS_CN[r.status] || r.status) + '</span>'
					+ '<span class="dwf-hname">' + esc(r.name || r.runId) + '</span><span class="dwf-hid">' + esc(r.runId) + '</span>'
					+ '<span class="dwf-hmeta">' + settled + '/' + total + tok + el + ' · ' + esc(relTime(r.updatedAt)) + '</span>';
				var binding = bindingOf(r);
				var tag = document.createElement('span');
				tag.className = 'dwf-hid';
				tag.textContent = binding ? binding.invalid ? '归属数据无效（未认领会话）' : binding.native ? '原生会话 ' + binding.host + ' / ' + binding.sessionId : '已绑定会话 ' + binding.sessionId : '未绑定会话';
				row.appendChild(tag);
				var btns = document.createElement('span');
				btns.style.display = 'inline-flex';
				btns.style.gap = '6px';
				var bindBtn = document.createElement('button');
				bindBtn.className = 'dwf-hbtn';
				bindBtn.setAttribute('data-act', 'bindcurrent');
				bindBtn.setAttribute('data-hrun', rid);
				bindBtn.textContent = '绑定当前会话';
				if (!cur) {
					bindBtn.disabled = true;
					bindBtn.title = '当前宿主未提供可核实的会话标识，无法绑定';
				}
				if (!binding || !binding.native) btns.appendChild(bindBtn);
				if (binding && !binding.native) {
					var unbindBtn = document.createElement('button');
					unbindBtn.className = 'dwf-hbtn';
					unbindBtn.setAttribute('data-act', 'unbindcurrent');
					unbindBtn.setAttribute('data-hrun', rid);
					unbindBtn.textContent = '解除绑定';
					btns.appendChild(unbindBtn);
				}
				row.appendChild(btns);
				mBody.appendChild(row);
				var calls = document.createElement('div');
				calls.className = 'dwf-hcalls';
				calls.style.display = 'none';
				row.addEventListener('click', function (ev) {
					if (ev.target && ev.target.closest && ev.target.closest('[data-act="bindcurrent"],[data-act="unbindcurrent"]')) return;
					calls.style.display = calls.style.display === 'none' ? 'block' : 'none';
					if (calls.style.display === 'block' && !calls.childElementCount) {
						var items = (r.calls || []).map(function (c) {
							return '<div>' + esc(CALL_STATE[c.state] || c.state) + ' · ' + esc(c.label || c.callId) + (c.usage ? ' · ' + fmtTokens((c.usage.input || 0) + (c.usage.output || 0)) + ' tokens' : '') + (c.durationMs != null ? ' · ' + fmtMs(c.durationMs) : '') + '</div>';
						}).join('') || '<div>（无调用记录）</div>';
						calls.innerHTML = items;
					}
				});
				mBody.appendChild(calls);
			});
		}
		function openHistory() {
			var view = beginView('history', null);
			mTitle.textContent = '工作流历史（全局）';
			mBody.innerHTML = '<div class="dwf-stats">加载中…</div>';
			apiFetch(API + '/runs', { cache: 'no-store' })
				.then(apiJson)
				.then(function (b) {
					if (!viewCurrent(view, 'history', null)) return;
					historyRuns = (b && b.runs) || [];
					renderHistory();
				})
				.catch(function (e) {
					if (!viewCurrent(view, 'history', null)) return;
					mBody.innerHTML = '<div class="dwf-stats">读取失败: ' + esc(String(e)) + '</div>';
				});
		}

		// Augment each finished run in the current card pool with a result preview for the
		// card (from the engine's out.json via the host API; progress.json itself does not
		// carry it). Off-pool runs are never hydrated: their previews would never be shown.
		function hydrateResults() {
			sessionPool().forEach(function (run) {
				if (isLive(run)) { resultCache.delete(identity(run)); return; }
				var id = identity(run);
				var key = id + ':' + String(run.startedAt || '') + ':' + run.updatedAt + ':' + run.status;
				var cached = resultCache.get(id);
				if (cached && cached.key === key) { run.resultPreview = cached.text; return; }
				if (resultPending.has(key)) return;
				resultPending.add(key);
			apiFetch(API + '/result?' + runQuery(run))
				.then(function (res) { return res.ok ? res.json().catch(function () { return null; }) : null; })
				.then(function (b) {
					if (stopped) return;
					var latest0 = runById(id);
					if (!latest0 || identity(latest0) + ':' + String(latest0.startedAt || '') + ':' + latest0.updatedAt + ':' + latest0.status !== key) return;
					if (!b || !b.ok) {
						// Negative cache: a terminal run without a readable out.json never gains one
						// (a resume opens a NEW lifecycle = a new cache key). Without this the client
						// refetched the same 404 every poll — measured as 5000+ console errors a day.
						resultCache.set(id, { key: key, text: '' });
						latest0.resultPreview = '';
						sweepCard();
						return;
					}
					var out = b.out;
					var raw = out && out.result !== undefined ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result))
						: out && out.error ? String(out.error) : '';
					var truncated = raw.length > 1200;
					var text = truncated ? raw.slice(0, 1200) + '…（已截断，点击查看全文）' : raw;
					var latest = runById(id);
					if (!latest || identity(latest) + ':' + String(latest.startedAt || '') + ':' + latest.updatedAt + ':' + latest.status !== key) return;
					resultCache.set(id, { key: key, text: text });
					latest.resultPreview = text;
					sweepCard();
				}).catch(function () {}).finally(function () { resultPending.delete(key); });
			});
		}

		// Single-flight polling with a response generation guard: an overlapping tick is
		// skipped, and a late response whose generation was superseded is dropped.
		// Fail-visible sweeps: a swallowed sweep error must reach the console (rate-limited to
		// distinct messages) — a silent catch once hid a wedged instance for an entire session.
		var lastSweepError = '';
		function reportSweepError(where, e) {
			var msg = where + ': ' + (e && e.message ? e.message : String(e));
			if (msg === lastSweepError) return;
			lastSweepError = msg;
			try { console.error('[dwf] ' + msg); } catch (e2) {}
		}
		// Per-run UI state is pruned to the surviving run list so long sessions do not
		// accumulate controls, log markers, result caches and visible ids forever (024-R4).
		function prunePerRunState() {
			var liveIds = new Set(runs.map(function (r) { return identity(r); }));
			controls.forEach(function (_, id) { if (!liveIds.has(id)) controls.delete(id); });
			lastLogCount.forEach(function (_, id) { if (!liveIds.has(id)) lastLogCount.delete(id); });
			resultCache.forEach(function (_, id) { if (!liveIds.has(id)) resultCache.delete(id); });
			var before = visibleRuns.size;
			visibleRuns.forEach(function (id) { if (!liveIds.has(id)) visibleRuns.delete(id); });
			if (visibleRuns.size !== before) saveVisible();
		}
		function tick() {
			if (stopped || pollInFlight) return;
			pollInFlight = true;
			var gen = ++pollGen;
			apiFetch(API + '/runs', { cache: 'no-store' })
				.then(function (res) {
					if (!res.ok) throw new Error('HTTP ' + res.status);
					return res.json();
				})
				.then(function (body) {
					if (stopped || gen !== pollGen) { pollInFlight = false; return; }
					pollInFlight = false;
					if (!body || !body.ok) throw new Error((body && body.error) || '响应缺少 runs 数据');
					offline = false; lastHttpError = ''; lastSyncAt = Date.now();
					runs = body.runs || [];
					prunePerRunState();
					invalidateModalLifecycle();
					hydrateResults();
					ensureStyle();
					try { sweepSidebar(); } catch (e) { reportSweepError('sweepSidebar', e); }
					try { sweepCard(); } catch (e) { reportSweepError('sweepCard', e); }
				})
				.catch(function (e) {
					if (stopped || gen !== pollGen) { pollInFlight = false; return; }
					pollInFlight = false;
					offline = true;
					lastHttpError = e && e.message ? String(e.message) : '网络错误';
					try { sweepCard(); } catch (err) { reportSweepError('sweepCard(offline)', err); }
				});
		}

		function sweepAll() {
			ensureStyle();
			try { sweepSidebar(); } catch (e) { reportSweepError('sweepSidebar', e); }
			try { sweepCard(); } catch (e) { reportSweepError('sweepCard', e); }
		}

		function start(ctx) {
			// Native Cordis session service (REPAIR-024 follow-up): current session comes
			// from ctx.sessions.list.getSnapshot().current; subscribe() only signals
			// invalidation, so the handler re-reads the snapshot. Absent service -> global
			// unbound view.
			sessionsService = null;
			// Chromium intensively throttles timers while the window is hidden (measured on
			// the MMX host: a 1500ms timeout did not fire for 8s), so a window brought back to
			// front could wait a minute for the next frozen tick. A catch-up poll fires
			// immediately on becoming visible; the trailing one covers a single-flight skip.
			var visibilityHandler = function () {
				if (stopped || document.visibilityState !== 'visible') return;
				tick();
				window.setTimeout(function () { if (!stopped) tick(); }, 1600);
			};
			document.addEventListener('visibilitychange', visibilityHandler);
			try {
				if (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === 'function') {
					sessionsService = ctx.sessions.list;
					if (typeof sessionsService.subscribe === 'function') {
						try { unsubscribeSessions = sessionsService.subscribe(function () { if (!stopped) sweepAll(); }); } catch (e) { unsubscribeSessions = null; }
					}
				}
			} catch (e) { sessionsService = null; }
			ensureStyle();
			var timer = window.setInterval(tick, POLL_MS);
			window.setTimeout(tick, 400);
			return function () {
				stopped = true;
				pollGen++; // invalidate every in-flight callback
				window.clearInterval(timer);
				document.removeEventListener('visibilitychange', visibilityHandler);
				if (unsubscribeSessions) { try { unsubscribeSessions(); } catch (e) {} unsubscribeSessions = null; }
				sessionsService = null;
				var card = document.getElementById(CARD_ID);
				if (card) card.remove();
				document.querySelectorAll('[data-' + LINE_ATTR + ']').forEach(function (n) {
					var row = n.parentElement;
					if (row) { restoreRowStyle(row); row.removeAttribute('data-dwf-run'); }
					n.remove();
				});
				restoreAnchor();
				revokeModalBlobs();
				var modal = document.getElementById(MODAL_ID);
				if (modal) modal.remove();
				var style = document.getElementById(STYLE_ID);
				if (style) style.remove();
				mEl = null; mTitle = null; mBody = null; modalView = null;
			};
		}

		// Cordis guards service access: a client module must declare the services it
		// touches on its exports, or ctx.sessions throws "without inject" at apply time.
		exports.inject = ['sessions'];
		exports.apply = function (ctx) {
			ctx.effect(() => start(ctx), 'dsh-workflow-pipeline: live-ui');
		};

		// Extension point for the pending session-binding integration (main session):
		// identity/currentSessionId/bindingOf/bindRunToSession/unbindRun are the seams a
		// row-slot adapter can plug into.
		exports.__clientInternals = {
			identity: identity,
			currentSessionId: currentSessionId,
			bindingOf: bindingOf,
			bindRunToSession: bindRunToSession,
			unbindRun: unbindRun,
		};

		return module.exports;
	},
});
