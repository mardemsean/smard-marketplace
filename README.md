# smard-marketplace

Claude Code / Cowork plugin marketplace of SMardLabs (Sean Mardem).

## Plugins

### smard-arsenal-gate (v0.1.1)

A deterministic enforcement layer made only of hooks (no LLM inside):

1. Routes each prompt, edited path and shell command to the skills or connectors the task requires (routing table in `hooks/routes.json`).
2. Denies `Edit`, `Write` and file-writing shell commands until the required skill or tool was actually invoked; the denial text names what to invoke.
3. Breaks repeated-error loops by error signature: a warning at the second identical failure, a denial at the third, lifted only by a debugging skill invoked after the block.
4. Blocks completion ("Stop") when edits were made without a verification command (tests, harness, `cargo test`, `pytest`, `pg_prove`, `run-sN.ps1`).
5. Fails open: if the hook script itself errors, the session continues; state lives in `%TEMP%\smard-arsenal-gate\<session_id>.json`. Node.js is required on the machine that runs the hooks.

## Install

claude.ai -> Personalização -> Plugins -> Add -> Add marketplace -> `mardemsean/smard-marketplace` -> enable `smard-arsenal-gate`.

Claude Code CLI: `claude plugin marketplace add mardemsean/smard-marketplace` (set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` when SSH to github.com is not configured), then `claude plugin install smard-arsenal-gate@smard-marketplace`.

## Kill switch

An empty file named `.arsenal-gate.off` in the project root disables the gate for that project. This switch belongs to the operator: an agent never creates it and never disables the gate.
