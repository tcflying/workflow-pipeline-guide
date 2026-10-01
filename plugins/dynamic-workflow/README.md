# Dynamic Workflows for Qoder

A workflow is a throwaway JavaScript file that says what work to fan out, in what order, with what
prompts. Each `agent()` call runs a separate subagent with its own context, so intermediate results
stay out of the session that launched the run — only the value the script returns comes back.

This is the same shape as Claude Code's dynamic workflows and ZCode's built-in `CreateWorkflow` /
`SaveWorkflow` / `resume_workflow_run` tool family, reimplemented on top of what Qoder already
exposes: skills, slash commands, the Agent tool, and `qodercli -p`.

## Install

```bash
# from this directory
cp -r skills/dynamic-workflow ~/.agents/skills/
cp -r commands/workflows ~/.qoder/commands/
node skills/dynamic-workflow/runtime/wf.mjs paths
```

`runtime/wf.mjs` is dependency-free (Node 20+). `.qoder-plugin/plugin.json` is present so
`qodercli plugins install <this dir>` also works if you prefer the managed path. The manifest lists
no components: skills and commands are discovered from the `skills/` and `commands/` directories by
convention, and its `version` is a copy of `ENGINE_VERSION` in `runtime/wf.mjs` (nothing in the repo
reads the manifest, so keep the two in step when releasing).

## Use

Ask for the fan-out in plain language, or run `/workflows:run <what you want>`. The agent drafts the
script, shows it, checks it, then drives the run.

```bash
wf=skills/dynamic-workflow/runtime/wf.mjs
node $wf check skills/dynamic-workflow/examples/file-audit.js
node $wf run skills/dynamic-workflow/examples/file-audit.js --backend file --run-id audit1 \
  --args '{"files":["a.js","b.js"],"angles":["correctness","security","tests"]}'
node $wf status audit1
node $wf save skills/dynamic-workflow/examples/file-audit.js --name file-audit --scope global
node $wf run --saved file-audit --backend file --args '{"files":["a.js"]}'
```

## Backends

| Backend | What `agent()` does | Needs |
| --- | --- | --- |
| `file` | parks the call in `pending.json` and waits for `inbox/<callId>.json` | nothing — the launching Qoder session answers it with real subagents |
| `cli` | spawns `qodercli -p` per call, fully detached from the launching session | `qodercli login` in the same user account (desktop-app credentials are not shared) |
| `echo` | returns a stub | nothing; use it to exercise a script's control flow |

`file` is the default entry point today because it works without a second login. `cli` is the closer
analogue of ZCode: the run keeps going even if you close the chat.

## Watch a run live

```bash
node $wf ui        # → http://127.0.0.1:4230
```

A read-only dashboard in the ZCode run-pane shape: a phase timeline (done / current / pending with
per-phase counts), one card per `agent()` call with its live state — 运行中, 等待应答 (a parked
file-backend call), 已完成, 失败, 重放命中 — plus the steer backlog and the settled result,
refreshing about once a second. Loopback only, nothing written, safe to leave running as a
background task while you drive the handshake. The port is fixed at 4230 and does not drift between
restarts (`--port` / `QODER_WF_UI_PORT` to retune, `--port 0` for an ephemeral one); a busy port is
an error that says so, never a silent hop to another one.

## On disk

| Path | Contents |
| --- | --- |
| `.qoder/workflow-drafts/` | inline scripts, named so you can edit and resubmit by path |
| `.qoder/dynamic-workflows/` · `~/.qoder/dynamic-workflows/` | saved workflows; at run time the project copy wins over a global one of the same name (`list` shows both) |
| `.qoder/dynamic-workflow-trust.json` | the run-start confirmations granted **in this directory**, each bound to a script's content hash |
| `.qoder/workflow-runs/<runId>/` | `state.json`, `journal.jsonl`, `pending.json`, `pending/`, `inbox/`, `steer.jsonl` (queued notes), `CANCEL` (stop requested), `out.json` |

The journal is what makes a run resumable: an `agent()` call is keyed by its prompt, the call's
`model`/`agent`/`systemPrompt`/`cwd`, and how many times that exact call has been made, so replaying
the script hits the stored answer for every settled call and dispatches only the rest. That is also
why scripts may not read the clock or a random source — `check` rejects `Date.now()`,
argless `new Date()`, `Math.random()`, `require`, `import`, `process`, `globalThis` and `fetch`.

## Limits

- The `file` backend needs the launching session to keep driving the handshake; if the session ends,
  `resume <runId>` picks it up. Each park expires after 900 s (or the call's `timeoutMs`), so a host
  that stopped answering shows up as failed calls and an all-failed run, not a slot held forever.
- Size ceilings, two of them: a prompt over 524 288 characters and a `cli` child's answer over
  8 388 608 bytes fail that one call, with the byte count in the error.
- `run` echoes the result on stdout only while it fits in 2000 characters; a bigger one comes back as
  `resultPreview` + `resultBytes`, and the full value is in `out.json` (`wf.mjs result <runId>`), so a
  500-item fan-out cannot flood the session that launched it.
- The sandbox keeps the host realm away from the script: `check`'s rejections are a convenience, the
  wall is that string code generation is refused inside the script's own realm and every value the
  engine hands over (`agent`, `args`, errors) is rebuilt there, so there is no object left to climb
  back to `process` from. What it does not do is privilege-separate: the run is still your own code
  doing your own user's file writes, and the subagents it launches have their own tool access.
- No token accounting: `--max-calls` (default 500) bounds fan-out for the whole run — a resume does
  not refill it — but cost is what the subagents spend. Calls refused before they dispatch (over that
  budget, an empty prompt, or a prompt over the size cap) are counted as
  `agentRejected` and named in `out.json`'s `warnings`.
