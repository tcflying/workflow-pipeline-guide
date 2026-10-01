#!/usr/bin/env node
// mmx-native-session-hook / PreToolUse relay (candidate, not installed).
//
// Reads exactly one JSON object on stdin (the MiniMax native hook contract). When the model is
// about to run THIS workspace's workflow engine (a bash tool invocation referencing the exact
// engine path below with the `run` subcommand), the relay appends an explicit
// --host-session <base64url> flag so the engine records the exact native session the run
// belongs to. Everything else passes through untouched: no permissionDecision is ever emitted
// (this relay must not grant or deny anything), non-matching tools/commands produce no output,
// and any internal error fails open (empty stdout, exit 0) per the hook contract.
import { createHash } from 'node:crypto';

// Exact engine of this workspace (REPAIR-024 boundary: only our own engine is ever modified).
const ENGINE_RESOLVED = 'g:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

export function buildHostSessionFlag(sessionId) {
  // sessionId comes from the native hook stdin; it is attribution metadata, not a credential,
  // and the engine re-validates the decoded value before a run directory is created.
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return null;
  return '--host-session ' + Buffer.from(JSON.stringify({ host: 'mmx', sessionId, source: 'native-hook' })).toString('base64url');
}

// A command qualifies only when it invokes this exact engine with the `run` subcommand and does
// not already carry a --host-session flag. Path separators and quoting are normalised for the
// comparison only; the original command text is preserved byte-for-byte otherwise.
export function shouldAppendFlag(command) {
  if (typeof command !== 'string' || command.length > 8192) return false;
  const normalized = command.toLowerCase().replace(/\//g, '\\');
  if (!normalized.includes(ENGINE_RESOLVED.replace(/\//g, '\\'))) return false;
  if (/(^|\s)-{1,2}host-session(\s|=)/.test(command)) return false;
  // The engine path is usually quoted, so the subcommand follows the closing quote: wf.mjs" run.
  const tail = command.slice(command.toLowerCase().lastIndexOf('wf.mjs') + 'wf.mjs'.length);
  const next = tail.trimStart().match(/^["']?\s*([A-Za-z_-]+)/);
  return !!next && next[1] === 'run';
}

export function appendFlag(command, flag) {
  return command.trimEnd() + ' ' + flag;
}

export async function handle(stdinText) {
  let event;
  try { event = JSON.parse(stdinText); } catch { return ''; }
  try {
    if (!event || event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'bash') return '';
    const command = event.tool_input && event.tool_input.command;
    if (!shouldAppendFlag(command)) return '';
    const flag = buildHostSessionFlag(event.session_id);
    if (!flag) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...event.tool_input, command: appendFlag(command, flag) },
      },
    });
  } catch { return ''; }
}

if (process.argv[1] && process.argv[1].endsWith('relay.mjs')) {
  const output = await handle(await readStdin());
  if (output) process.stdout.write(output + '\n');
}
