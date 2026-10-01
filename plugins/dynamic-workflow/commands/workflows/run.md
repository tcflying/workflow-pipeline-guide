---
name: "Workflows: Run"
description: "Write a one-off orchestration script and fan the work out across isolated subagents"
category: "Workflow"
tags: ["workflow", "subagents", "orchestration", "fan-out"]
---

Run a dynamic workflow for the request in `$ARGUMENTS`.

Follow the `dynamic-workflow` skill (its `runtime/wf.mjs` sits next to its SKILL.md). Bound the
work into one JS file, keep intermediate results inside the script, return only what the user needs.
Throughout, `<skill>` below means that skill's directory.

1. Restate the fan-out in one line: what repeats, over how many targets, and what the merged answer
   looks like. If the task is really one agent call, say so and just do that instead.
2. Draft `.qoder/workflow-drafts/<label>.js` with `export const meta`, `args` for anything the user
   supplied, `phase()` labels, and `parallel()` / `pipeline()` for the fan-out.
3. `node <skill>/runtime/wf.mjs check <file>` and fix every diagnostic before running.
4. Show the script and get the user's go-ahead **now, before launching**. The gate is the host's
   job: the engine reports `confirmation.required` in the run's own output, which is after the run
   exists, and it never blocks. A saved workflow the user already approved is covered by
   `wf.mjs trust <name>` (per project directory) or `--yes` for one run.
5. `node <skill>/runtime/wf.mjs run <file> --args '<json>' --backend file --run-id <id>` as a
   background task, then drive the handshake: read `pending.json`, dispatch each item through the
   Agent tool (one message per batch so they overlap), write `inbox/<callId>.json`, repeat until
   `out.json` exists. `pending/<callId>.json` also carries the `model`/`agent`/`systemPrompt`/`cwd`
   the script asked for; honour them when you can. If the user changes direction mid-run, queue it
   with `node <skill>/runtime/wf.mjs steer <id> "<note>"` and let the script read it at `notes()`.
6. Report `out.json`'s `result`, plus the run directory so the user can inspect the journal. A
   result over 2000 characters is not echoed on stdout (only `resultPreview` and `resultBytes`), so
   fetch the whole value with `node <skill>/runtime/wf.mjs result <id>`.
7. If `status` reports `stale`, the engine process is gone: `node <skill>/runtime/wf.mjs resume <id>`
   picks it up from the journal (settled calls replay, the rest dispatch). `stop` is only for
   cancelling a run you do not want any more. When `stop`/`resume` answer `ok: false`, report its
   `reason` — do not retry.

Show the script before the run starts. The user is approving real agent launches, not a black box.
