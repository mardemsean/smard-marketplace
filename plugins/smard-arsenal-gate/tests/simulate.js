#!/usr/bin/env node
'use strict';
// Simulated session against gate.js: feeds hook JSON on stdin, asserts the decisions.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const GATE = path.join(__dirname, '..', 'hooks', 'gate.js');
const SID = 'sim-' + Date.now();
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
let failures = 0;

function hook(event, payload) {
  const input = Object.assign({ session_id: SID, cwd: STATE_DIR, transcript_path: path.join(STATE_DIR, 't.jsonl') }, payload);
  const r = spawnSync('node', [GATE, event], { input: JSON.stringify(input), encoding: 'utf8', env: Object.assign({}, process.env, { ARSENAL_GATE_STATE_DIR: STATE_DIR, ARSENAL_GATE_DEBUG: '1', CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') }) });
  if (r.stderr) process.stderr.write(r.stderr);
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { json = { raw: r.stdout }; }
  return { code: r.status, json };
}
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + JSON.stringify(detail)}`);
}
const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

// 1. Session start resets and injects the banner
let r = hook('SessionStart', { source: 'startup' });
check('SessionStart injects banner with routes', ctx(r) && /Routes \(trigger -> required\)/.test(ctx(r)), r);

// 2. A prompt about a pgTAP migration fires the postgres + debug routes
r = hook('UserPromptSubmit', { prompt: 'Corrige o erro na migration 0012 (pgTAP falha na policy RLS).' });
check('UserPromptSubmit fires postgres and debug routes', ctx(r) && /\[postgres\]/.test(ctx(r)) && /\[debug\]/.test(ctx(r)), r);

// 3. Edit is denied while postgres/debug requirements are unmet
r = hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'migrations/0012_integration.sql', old_string: 'a', new_string: 'b' } });
check('PreToolUse denies Edit before consultation', decision(r) === 'deny', r);

// 4. Consulting pg-aiguide satisfies postgres; debug still due
hook('PostToolUse', { tool_name: 'mcp__pg-aiguide__search_docs', tool_input: { query: 'RLS policy COPY' }, tool_response: {} });
r = hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'migrations/0012_integration.sql' } });
check('Edit still denied by debug route', decision(r) === 'deny' && /\[debug\]/.test(r.json.hookSpecificOutput.permissionDecisionReason), r);

// 5. Invoking systematic-debugging satisfies debug; Edit allowed (silent)
hook('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'superpowers:systematic-debugging' }, tool_response: 'ok' });
r = hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'migrations/0012_integration.sql' } });
check('Edit allowed after both requirements met', !decision(r), r);
hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'migrations/0012_integration.sql' }, tool_response: 'ok' });

// 6. Path-triggered route: editing a .rs file without the Rust skills is denied
r = hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/skeleton.rs', content: 'fn main(){}' } });
check('Write to .rs denied until a Rust skill is invoked', decision(r) === 'deny' && /\[rust\]/.test(r.json.hookSpecificOutput.permissionDecisionReason), r);
hook('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'rust-cli-skills:rust-implement' } });
r = hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/skeleton.rs', content: 'fn main(){}' } });
check('Write to .rs allowed after rust-implement', !decision(r), r);

// 7. Stop is blocked: edits happened, no verification ran
r = hook('Stop', { stop_hook_active: false });
check('Stop blocked without verification', r.json && r.json.decision === 'block', r);
r = hook('Stop', { stop_hook_active: true });
check('Stop not re-blocked when stop_hook_active', !r.json, r);
hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwsh -NoProfile -File .\\run-s8.ps1' }, tool_response: 'RESULT exit=0' });
r = hook('Stop', { stop_hook_active: false });
check('Stop allowed after verification command', !r.json, r);

// 8. Error loop: same Bash error 3x -> warn at 2, deny at 3
const err = { tool_name: 'Bash', tool_input: { command: 'psql -c "COPY sdi.stage FROM STDIN"' }, error: 'ERROR: COPY FROM not supported with row-level security (line 42, pid 9912)' };
hook('PostToolUseFailure', err);
r = hook('PostToolUseFailure', Object.assign({}, err, { error: 'ERROR: COPY FROM not supported with row-level security (line 42, pid 10311)' }));
check('2nd identical error -> warning injected', ctx(r) && /repeated 2x/.test(ctx(r)), r);
r = hook('PostToolUseFailure', err);
check('3rd identical error -> block announced', ctx(r) && /DENIED/.test(ctx(r)), r);
r = hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'psql -c "COPY sdi.stage FROM STDIN"' } });
check('Block holds although debugging was invoked BEFORE the loop', decision(r) === 'deny', r);
const SID2 = SID + '-b';
const hook2 = (e, p) => hook(e, Object.assign({ session_id: SID2 }, p));
hook2('SessionStart', { source: 'startup' });
hook2('PostToolUseFailure', err); hook2('PostToolUseFailure', err); hook2('PostToolUseFailure', err);
r = hook2('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'psql -c "COPY sdi.stage FROM STDIN"' } });
check('Bash denied after 3 identical failures', decision(r) === 'deny' && /loop|failed 3x/.test(r.json.hookSpecificOutput.permissionDecisionReason), r);
hook2('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'superpowers:systematic-debugging' } });
r = hook2('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'psql -c "select 1"' } });
check('Bash allowed again after systematic-debugging', !decision(r), r);

// 8b. Bash redirection cannot bypass a path-gated route
const SID3 = SID + '-c';
const hook3 = (e, p) => hook(e, Object.assign({ session_id: SID3 }, p));
hook3('SessionStart', { source: 'startup' });
r = hook3('PreToolUse', { tool_name: 'Bash', tool_input: { command: "mkdir -p src && printf 'fn main(){}' > src/hello.rs" } });
check('Bash write to .rs denied like an Edit', decision(r) === 'deny' && /\[rust\]/.test(r.json.hookSpecificOutput.permissionDecisionReason), r);
r = hook3('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la src' } });
check('Read-only Bash not gated', !decision(r), r);
hook3('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'rust-cli-skills:rust-implement' } });
hook3('PostToolUse', { tool_name: 'Bash', tool_input: { command: "printf 'fn main(){}' > src/hello.rs" } });
r = hook3('Stop', { stop_hook_active: false });
check('Stop blocked after a Bash write without verification', r.json && r.json.decision === 'block', r);

// 9. Kill switch
fs.writeFileSync(path.join(STATE_DIR, '.arsenal-gate.off'), '');
r = hook2('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/x.rs' } });
check('.arsenal-gate.off disables the gate', !r.json, r);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
