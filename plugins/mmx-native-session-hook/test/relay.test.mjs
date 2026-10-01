import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHostSessionFlag, shouldAppendFlag, appendFlag, handle } from '../scripts/relay.mjs';

const relay = fileURLToPath(new URL('../scripts/relay.mjs', import.meta.url));
const ENGINE_CMD = 'node "G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs" run task.mjs --run-id demo';
const spawnRelay = (event) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [relay], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, out, err }));
  child.stdin.end(JSON.stringify(event));
});
const preToolUse = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'bash', session_id: 'sess-mm-1',
  cwd: 'G:/qoder-intl-project/else', tool_input: { command }, ...extra,
});

test('matching engine run commands gain the exact native hook session flag', async () => {
  const result = await spawnRelay(preToolUse(ENGINE_CMD));
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  const flagged = parsed.hookSpecificOutput.updatedInput.command;
  assert.ok(flagged.startsWith(ENGINE_CMD + ' '), 'the original command text is preserved');
  const decoded = JSON.parse(Buffer.from(flagged.match(/--host-session (\S+)/)[1], 'base64url'));
  assert.deepEqual(decoded, { host: 'mmx', sessionId: 'sess-mm-1', source: 'native-hook' });
});

test('non-matching events, commands and malformed stdin stay silent (fail-open)', async () => {
  for (const event of [
    preToolUse('node other.mjs run x'),
    preToolUse(ENGINE_CMD.replace(' run ', ' resume ')),
    preToolUse(ENGINE_CMD + ' --host-session AAAA'),
    preToolUse(ENGINE_CMD, { tool_name: 'read' }),
    { ...preToolUse(ENGINE_CMD), hook_event_name: 'PostToolUse' },
    preToolUse(ENGINE_CMD, { session_id: '' }),
    'not json at all',
  ]) {
    const result = await spawnRelay(event);
    assert.equal(result.code, 0);
    assert.equal(result.out.trim(), '', 'no output for ' + JSON.stringify(event).slice(0, 60));
  }
});

test('flag helpers keep the contract local and reversible', () => {
  assert.equal(shouldAppendFlag(ENGINE_CMD), true);
  assert.equal(shouldAppendFlag(ENGINE_CMD.replace('G:/', 'g:\\')), true, 'case and separator insensitive matching');
  assert.equal(shouldAppendFlag('node C:/other/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs run x'), false, 'a foreign engine copy never matches');
  assert.equal(appendFlag('a  ', '--host-session X'), 'a --host-session X');
  assert.equal(buildHostSessionFlag(''), null);
  assert.equal(buildHostSessionFlag('x'.repeat(300)), null);
});
