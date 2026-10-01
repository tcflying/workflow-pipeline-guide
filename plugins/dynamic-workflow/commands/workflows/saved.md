---
name: "Workflows: Saved"
description: "List, save or re-run a saved dynamic workflow by name"
category: "Workflow"
tags: ["workflow", "saved", "reuse"]
---

Manage saved dynamic workflows. `$ARGUMENTS` may name a workflow and pass arguments to it.
Throughout, `<skill>` means the `dynamic-workflow` skill directory (its `runtime/wf.mjs` sits next
to its SKILL.md).

- List: `node <skill>/runtime/wf.mjs list` — shows project and global workflows, their description,
  `whenToUse`, declared arguments and whether the run-start confirmation is already granted
  (`trusted`). The list is flat: a name stored in both archives appears twice, one row per scope.
- Save: `node <skill>/runtime/wf.mjs save <file> --name <name> --scope project|global`. Add
  `--description` and `--when-to-use` when the script's own `meta` should be overwritten.
  Choose `project` when the script names this repository's files, commands or conventions;
  `global` when it depends on nothing here. Save only a script that completed at least one run.
- Run: `node <skill>/runtime/wf.mjs run --saved <name> --args '<json>' --backend file --run-id <id>`,
  then drive the handshake the way `/workflows:run` describes. Name the backend: an omitted
  `--backend` defaults to `cli`, which spawns `qodercli` per `agent()` call and needs that CLI to be
  logged in on this box. Resolution is project scope
  first, so a project workflow overrides a global one of the same name even though `list` shows
  both. Arguments are validated against the saved declaration before anything dispatches, so an
  unknown or missing key fails fast.
- Skip the repeated ask: after the user has approved a saved workflow once,
  `node <skill>/runtime/wf.mjs trust <name>` records it, and `untrust <name>` takes it back. Trust is
  stored against the file's content hash in *this directory's*
  `.qoder/dynamic-workflow-trust.json`, so `save --overwrite` with changed content revokes it and
  the next run asks again — and because the record is per project, a `--scope global` workflow has
  to be trusted once in each project you run it from.

If `$ARGUMENTS` names a workflow to run, run it. Otherwise list what exists and ask which one.
