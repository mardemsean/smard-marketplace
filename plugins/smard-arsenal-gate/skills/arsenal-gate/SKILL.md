---
name: arsenal-gate
description: Use when the operator asks what the arsenal gate is doing, why an edit was denied, which routes are due or satisfied in this session, or wants to turn the gate off or on.
disable-model-invocation: true
---

# Arsenal Gate — status and controls

The gate is a set of deterministic hooks (no LLM). Everything it does is derived from `hooks/routes.json` and a per-session state file.

## Show the current state

Run, from any directory:

```bash
echo "{\"session_id\":\"$CLAUDE_SESSION_ID\"}" | node "${CLAUDE_PLUGIN_ROOT}/hooks/gate.js" status
```

If `CLAUDE_SESSION_ID` is not set, pass the `session_id` seen in the hook input (it is the same for the whole session). The output lists each route as `OK` (requirement satisfied), `DUE` (fired, not yet satisfied: gated tools are denied) or `--` (not fired), plus error signatures counted so far and how many edits happened since the last verification command.

Report it to the operator as a table: route, status, what satisfies it.

## Why an edit was denied

The denial reason is the instruction. It names the route and the exact skill or tool to invoke. Invoke it with the Skill tool (or call the named tool), then repeat the edit. Nothing else lifts the denial.

## Turn the gate off or on

- Off for this project: create an empty file `.arsenal-gate.off` in the project root (`$CLAUDE_PROJECT_DIR`). Remove it to turn the gate back on. Takes effect on the next hook call; no restart needed.
- Off for one process: environment variable `ARSENAL_GATE=off`.
- Debug: `ARSENAL_GATE_DEBUG=1` prints internal errors to stderr (the gate otherwise fails open and stays silent).

## Edit the routes

`hooks/routes.json` is reloaded on every hook call. A route has `prompt`, `paths` and `bash` regex lists (triggers), `requires.any_of` (skills or `mcp__*` tool names, any one satisfies) and `gate` (tools denied while unsatisfied; `[]` makes the route advisory). `error_loop`, `stop_gate` and `reply_prefix` hold the thresholds. Changes to `hooks/hooks.json` itself need a session restart.
