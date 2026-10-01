---
name: dynamic-workflow
description: "Write a one-off orchestration script and run it across many isolated subagents. Use when a task needs the same work done over several targets or angles (audit every module, research N competitors, review one PR from 3 perspectives, best-of-N attempts), when doing that work inline would flood intermediate results into the main context, or when the user asks for a workflow, a fan-out, parallel agents, or a saved reusable procedure."
---

# Dynamic Workflows

One JavaScript file decides what runs, in what order, and with what prompts. Each `agent()` call is a
fresh subagent with its own context: the intermediate output never enters this session, only the
values the script returns.

The engine lives next to this file: `runtime/wf.mjs` (invoke with the absolute path of this skill
directory). It needs Node 20+ and nothing else.

## Choose the backend first

- `--backend file` — always works. The engine parks each call on disk; you fan them out with the
  Agent tool and write the answers back. Use this unless the CLI backend is proven.
- `--backend cli` — the engine spawns `qodercli -p` per `agent()` call itself, so the run is fully
  detached. Requires `qodercli login` in the same user account: the desktop app's credentials are
  not shared with the CLI. Check with `wf.mjs paths` (`cliEntry` non-null) and one probe call.
- `--backend echo` — stub answers, for testing a script's control flow without a model.

`wf.mjs paths` prints every directory in play plus the resolved CLI entry.

## Script shape

```js
export const meta = {
  name: 'pr-review',
  description: 'Review a PR from three angles, then merge the verdicts',
  whenToUse: 'When the user asks for a deep review of a specific PR',
  args: {
    pr: { type: 'string', required: true },
    strict: { type: 'boolean', default: false },
  },
};

phase('Review');
const found = await parallel([
  () => agent(`Security review of PR ${args.pr}. Report findings as a list.`),
  () => agent(`Performance review of PR ${args.pr}. Report findings as a list.`),
  () => agent(`Test coverage of PR ${args.pr}. Report gaps as a list.`),
]);

phase('Merge');
const ranked = await agent(
  `Rank these findings by real risk, drop duplicates:\n${found.filter(Boolean).join('\n---\n')}`,
  { json: true }
);
return { ranked, reviewed: found.length };
```

Facade — those seven names are the whole API:

| Call | Behaviour |
| --- | --- |
| `agent(prompt, opts?)` | One subagent. Resolves to its text. `opts`: `label`, `phase`, `json` (parse the reply), `model`, `agent` (named agent), `systemPrompt`, `cwd`, `timeoutMs`, `throwOnError`, and the cli-backend pass-throughs `maxOutputTokens`, `tools`, `permissionMode`. |
| `parallel(thunks)` | Runs thunks at once, bounded by `--concurrency`. `thunks` is an array, or pass one thunk per argument (`parallel(a, b, c)`). Never rejects: a throwing thunk becomes `{ ok: false, error }`. |
| `pipeline(items, ...stages)` | Each item flows through every stage; items run concurrently. A stage returning `{ok:false}` stops that item only. |
| `ask(question, opts?)` | 向宿主提一个阻塞问题（仅 file 后端）。问题以 `kind:"question"` 条目出现在 pending.json——把它呈现给用户，答案写 `inbox/<qId>.json = {"ok":true,"text":"答案"}`。默认 3600s 超时，`opts.timeoutMs` 可调；答案按 (问题,第几次) 入 journal，resume 重放不再重问。 |
| `publish(artifact)` | 登记一个产出物 `{title, kind: file|document|dashboard|text, path?, url?, text?, primary?}`——UI 卡片的 artifacts 区与历史会显示它们；`primary` 标主交付物（后到优先，一 run 一个）。 |
| `phase(name)` | Labels the calls after it. Shows up in `status` and in `pending.json`. Call it between fan-outs, not inside a concurrent body: the label a call gets is whatever `phase()` last set when that call dispatched, so a `phase()` inside `parallel()` can label its siblings. `status.phases` lists each name once, in the order the script first set it. |
| `log(msg)` | Progress line plus a journal entry. |
| `notes()` | Strings queued by `wf.mjs steer <runId> "<note>"` since the last read. Never blocks; empty when nothing arrived. |
| `args` | Validated against `meta.args` before anything dispatches. |

Two size ceilings keep a run from growing the engine: a prompt over 524 288 characters and a
`cli` child's answer over 8 388 608 bytes both fail that one call, and the error names the number.

A failed `agent()` settles as `{ ok: false, error }` rather than killing the run, so check with
`typeof x === 'string'` or `x.ok === false` when you want to branch. `out.json`, `state.json` and
`status` all carry the same run totals — `agentDispatched` / `agentSettled` / `agentFailed` /
`agentRejected`, counted from the journal, so they do not move when you resume — plus
`agentCalls`/`segmentCalls` for what the current lifecycle dispatched. When every dispatched call
failed the run settles `failed` with exit 1; a partial failure still settles `completed` while
carrying the counts. `--max-calls` is a budget for the whole run, not one per resume, and a call
refused before it dispatches — over that budget, or an empty prompt, or a prompt over the size cap —
is journalled as `agent_rejected` and listed in `out.json.warnings` rather than
disappearing into the script's return value.

What may cross between the script and the engine is rebuilt in the script's own realm: strings,
numbers (including `NaN`, `Infinity`, `-0`), booleans, `null`, `undefined`, arrays and plain objects
all arrive with their exact value. A `BigInt`, `function`, `Symbol`, `Map`, `Set`, `Date`, `RegExp`
or `Error` cannot cross — the call that returned it settles
`{ ok: false, error: "… cannot cross the workflow boundary" }` and the run carries on, so return
`Array.from(map.entries())` or `String(big)` rather than the value itself.

Scripts are deterministic by construction: `Date.now()`, argless `new Date()`, `Math.random()`,
`require`, `import`, `process`, `globalThis` and `fetch` are rejected by `check`, and the sandbox
does not expose them. Feed time and randomness in through `args`.
The runtime wall is the script's own realm: string code generation (`eval`, building a function from
a string) is refused inside the sandbox, and `agent`/`parallel`/`args` are rebuilt in that realm, so
no call hands the script a host-realm object it could climb back to `process` from.

## Run it

1. Write the script to `.qoder/workflow-drafts/<label>.js`.
2. `node <skill>/runtime/wf.mjs check .qoder/workflow-drafts/<label>.js` — fix every diagnostic
   before going on. Never skip this: a compile error costs a whole run.
3. Before launching: show the script and get the user's go-ahead (see the confirmation gate below).
   The engine does not stop the run for you — asking first is the host's job.
4. `node <skill>/runtime/wf.mjs run <script> --args '<json>' --backend file --run-id <id>` as a
   background task. Long prompts and JSON go in a file: `--args-file args.json`.
5. Drive the handshake until `.qoder/workflow-runs/<id>/out.json` exists:
   1. Read `.qoder/workflow-runs/<id>/pending.json`.
   2. For each item, launch one Agent-tool subagent with `item.prompt` (put the items of one batch
      in a single message so they really run in parallel). Each item also has its own
      `pending/<callId>.json`, which repeats the prompt plus the `model` / `agent` / `systemPrompt` /
      `cwd` the script asked for. Those four are requests, not guarantees: honour them when you can
      (they are part of the call's identity, so ignoring them is allowed but they are never hidden
      from you), and never invent an answer because the model you wanted is unavailable.
   3. Write `.qoder/workflow-runs/<id>/inbox/<callId>.json` containing
      `{"ok":true,"text":"<the subagent's answer>"}`, or `{"ok":false,"error":"why it failed"}`.
      Plain text also works: `inbox/<callId>.txt`. Those are the only shapes: an object with no
      string `text` fails that call and names the keys it did find, so a mistyped field never
      becomes a silent empty answer that then replays as a success forever.
   **问答条目**：pending.json 里带 `"kind":"question"` 的条目不是子代理任务——那是 `ask()` 在等用户回答。把问题原文呈现给用户，把答案写进 `inbox/<qId>.json`（形状与应答相同）。不要自己编答案。
   4. Answer each `callId` exactly once, then loop. `out.json` is the engine's own completion mark.
      An unanswered park is not free: it expires after 900 s (or the call's `timeoutMs`) and settles
      as a failure saying the host stopped driving the handshake, so a dropped host session shows up
      in the run instead of holding a concurrency slot indefinitely.
6. Read `out.json` and report the `result` to the user. A result over 2000 characters is not echoed
   back: `run`'s stdout carries `resultPreview`, `resultBytes` and the pointer instead, and the whole
   value lives in `out.json` (`wf.mjs result <runId>` prints it). Fetch it there rather than
   summarising the preview as if it were the answer.

## Show the script, then stop asking

The gate is advisory: `run` reports `confirmation` in its output and in `state.json` and keeps going,
because the launch already happened by the time the field can be read. So the host asks *before*
step 4, never after it; `confirmation.required` is the record of what was owed, not the ask itself.

- `{"required": true, "basis": "first-run"}` — the user has not approved this script yet. Show the
  real script (not a paraphrase) plus the phase list and args, then start.
- `{"required": false, "basis": "trust-list"}` — repeat run of a saved workflow the user already
  approved. Do not ask again; just report that it is running.
- `{"required": true, "basis": "script-changed"}` — a trusted workflow whose content was edited.
  Trust binds to the file's hash, so this is a new script and needs a fresh look.
- `--yes` answers "no confirmation this time" (`--trusted` is the same answer for a one-off run);
  `wf.mjs trust <name>` answers it permanently for that saved content, and `wf.mjs untrust <name>`
  takes it back. `wf.mjs list` shows `trusted` per row. Trust is stored per directory, in
  `<cwd>/.qoder/dynamic-workflow-trust.json`, so a `--scope global` workflow has to be trusted once
  in every project you run it from — it is not a one-time thing for the machine.

Ask once per workflow, never on every iteration: a saved run the user kicks off five times a day
should not interrupt them five times.

If this session is interrupted or compacted mid-run, nothing is lost: `status` shows what is
outstanding, and `resume <runId>` replays every settled call from the journal and continues where
it stopped. `stop <runId>` is only for "cancel this, I do not want the result"; a run whose process
died does not need it — resume it directly, because `stop` would settle it as `cancelled` and write
an `out.json` that the next lifecycle has to look past.

`status` reports one row per run folder, always. Read these before retrying anything:

- `status: "stale"` with `staleReason` — the engine process died (Bash timeout, closed terminal).
  Nothing will pick the run up, and that is fine: `wf.mjs resume <id>` takes the journal from where
  it stopped, replaying settled calls and dispatching only the rest. Do not `stop` it first; `stop`
  is for cancelling, and cancelling writes a `cancelled` result over work you meant to finish.
- `resumable: false` plus `resumableReason` — say that reason to the user instead of guessing:
  either a live pid is still working on it (`stop` it first), or the script file moved and
  `resume` needs `--script <path>`.
- `ok: false` with `reason` from `stop` or `resume` — the command refused, and it says why. Do not
  loop the same command; report the reason.

For a long fan-out, give the user the live view instead of narrating `status` output by hand:
`node <skill>/runtime/wf.mjs ui` (as a background task) serves a read-only dashboard at
`http://127.0.0.1:4230` — phase timeline, one card per call with its live state (运行中 / 等待应答 /
已完成 / 失败 / 重放命中), steer backlog, settled result — refreshed about once a second. It reads
the same files `status` reads and writes nothing; the port is fixed, and a busy one is an error, not
a silent move.

## Steer a run that is already going

A parked run is not a locked run. Queue a note the script can read:

```
node <skill>/runtime/wf.mjs steer <runId> "only report findings under 30 lines"
```

`status` shows `steerQueued` (what the file holds), `steerDelivered` (what a `notes()` read picked
up) and `steerUndelivered` — the last one is the backlog, the first two are history. The note lands
in the next `notes()` call, so write scripts that check for direction at a boundary:

```js
phase('Review');
const batch = await parallel(files.map((f) => () => agent(`review ${f}`)));
const steer = notes();
phase('Merge');
return await agent(`merge these findings${steer.length ? ', honouring: ' + steer.join(' / ') : ''}:\n${batch.join('\n')}`);
```

Rules that keep this honest: `notes()` never blocks and never repeats a note; each read is
journalled, so a resumed run replays the same note list and the same cached answers. A note's
identity is its text and the moment it was queued, not its line in `steer.jsonl`, so pruning or
reordering that file cannot swallow a pending note or re-deliver a spent one. A script that never
calls `notes()` cannot be steered — say so rather than queueing a note into the void. Steering a
finished run is refused with a reason; resume it first. `resume` also refuses `--args` that differ
from the ones the run started with (cached answers are keyed by call position), with `--force` as
the override.

## Save what worked

`wf.mjs save <script> --name pr-review --scope project` writes `.qoder/dynamic-workflows/pr-review.js`;
`--scope global` writes `~/.qoder/dynamic-workflows/`. Then run it with `--saved pr-review --args
'{"pr":"123"}'`, list what exists with `wf.mjs list`, and tell the user where the file is.

At run time the project copy wins: `--saved <name>` resolves project scope first, so a project
workflow overrides a global one of the same name. `list` does not fold them — it prints both rows,
each with its own `scope` and `path`, so a name appearing twice there is the shadow showing, not a
bug. If you are about to run a name that is listed twice, say which copy you are running.

Save only after a run completed: a saved workflow is the version the user keeps, and they will
review it. Before writing a new script from scratch, run `list` — an existing saved workflow beats
rebuilding one.

## Editing a running or finished script

Results are cached per script position, so editing a prompt re-runs only that call and the ones
that consume its output. To repair a run: edit the draft file, then
`run <file> --run-id <sameId>`; settled agents replay instantly and the changed branch re-dispatches.
