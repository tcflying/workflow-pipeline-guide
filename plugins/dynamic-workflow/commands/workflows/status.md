---
name: "Workflows: Status"
description: "Report running, parked, completed and failed dynamic workflow runs"
category: "Workflow"
tags: ["workflow", "status", "journal", "resume"]
---

Report on dynamic workflow runs. `$ARGUMENTS` may hold a run id.
Throughout, `<skill>` means the `dynamic-workflow` skill directory (its `runtime/wf.mjs` sits next
to its SKILL.md).

- `node <skill>/runtime/wf.mjs status` lists every run in `.qoder/workflow-runs/` with its phase
  labels, how many agent calls were dispatched, settled, failed and refused before dispatch (the
  call budget, an empty prompt, or a prompt over the size cap),
  which calls are still outstanding, whether its process is alive (`processAlive`, `pid`) and whether
  it can be resumed (`resumable`, plus `resumableReason` when it cannot). One row per run folder — a
  folder this engine never recorded shows as `untracked` rather than vanishing.
- `node <skill>/runtime/wf.mjs status <runId>` adds the stored script path, args, confirmation
  record, timestamps and final result.
- `node <skill>/runtime/wf.mjs result <runId>` prints `out.json` verbatim — that is where the whole
  `result` is; `run`'s own stdout only carries a 2000-character `resultPreview`.
- `node <skill>/runtime/wf.mjs steer <runId> "<note>"` queues a correction for a run that is still
  going; it lands in the script's next `notes()` call. `status` shows `steerQueued` (notes on disk),
  `steerDelivered` (picked up) and `steerUndelivered` — only the last one is a backlog.
- `node <skill>/runtime/wf.mjs ui` serves a read-only live dashboard at `http://127.0.0.1:4230`
  (fixed port; `--port` / `QODER_WF_UI_PORT` to retune, loopback only): a phase timeline, one card
  per agent call with its live state (运行中 / 等待应答 / 已完成 / 失败 / 重放命中), the steer
  backlog and the settled result, refreshing about once a second. Run it as a background task for
  long fan-outs and give the user the URL; it writes nothing.

Then act on what you see, and say which you are doing:

- `outstanding` non-empty and `processAlive: true` → keep driving the handshake (answer each
  `callId` in `.qoder/workflow-runs/<runId>/inbox/`).
- `status: stale` → the engine died (session restarted, Bash timeout) and nothing will pick the run
  up, which `resume` is exactly for: `node <skill>/runtime/wf.mjs resume <runId>` replays settled
  calls from `journal.jsonl` and dispatches only the unfinished ones. Do not `stop` it first —
  `stop` is for cancelling, and it settles the run `cancelled` with an `out.json` you did not want.
- `status: failed` → read the error and the last journal lines, fix the script, then resume with the
  same run id so completed work is not paid for twice.
- `status: cancelled` → confirm with the user before starting a fresh run id.
- `resumable: false` → report `resumableReason` to the user; it names the pid still working or the
  missing script. Do not loop a refused `stop`/`resume`.
