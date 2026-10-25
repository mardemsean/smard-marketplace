#!/usr/bin/env node
'use strict';
/*
 * SMard Arsenal Gate — one script, six hook events, zero LLM calls.
 *
 *   node gate.js SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | PostToolUseFailure | Stop | SubagentStop
 *
 * Reads the hook JSON on stdin, keeps a small per-session state file in the OS temp
 * directory, and answers with the JSON shape Claude Code expects for that event.
 * It never throws to the caller: any internal error exits 0 with no output, so a bug
 * in the gate can slow a session down but can never wedge it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const EVENT = process.argv[2] || '';
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const ROUTES_FILE = path.join(PLUGIN_ROOT, 'hooks', 'routes.json');
const STATE_DIR = process.env.ARSENAL_GATE_STATE_DIR || path.join(os.tmpdir(), 'smard-arsenal-gate');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// A shell command that writes files counts as an edit: the gate cannot be bypassed by `printf > file`.
const BASH_WRITE = /(^|[^>])>>?\s*["']?[^\s&|;"']+|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\binstall\s+-[^\s]*m|Set-Content|Out-File|Add-Content|New-Item|\bcat\s*<<|\bperl\s+-[^\s]*i|\bpython3?\s+-c\s+.*open\(.*['"]w/;
function isBashWrite(cmd) { return !!cmd && BASH_WRITE.test(cmd); }

// ---------- helpers ----------
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function parseJSON(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
function loadRoutes() {
  const r = parseJSON(fs.readFileSync(ROUTES_FILE, 'utf8'), null);
  if (!r || !Array.isArray(r.routes)) throw new Error('routes.json unreadable');
  return r;
}
function compile(list) {
  return (list || []).map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
}
function anyMatch(regexes, text) {
  if (!text) return false;
  return regexes.some((re) => re.test(text));
}
function disabled(input) {
  if ((process.env.ARSENAL_GATE || '').toLowerCase() === 'off') return true;
  const dir = process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
  return fs.existsSync(path.join(dir, '.arsenal-gate.off'));
}
function statePath(sessionId) {
  const id = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(STATE_DIR, id + '.json');
}
function emptyState() {
  return { fired: {}, satisfied: {}, errsigs: {}, blocked: {}, edits_since_verify: 0, stop_blocks: 0, prefix_blocks: 0, tools: 0 };
}
function loadState(sessionId) {
  const p = statePath(sessionId);
  if (!fs.existsSync(p)) return emptyState();
  return Object.assign(emptyState(), parseJSON(fs.readFileSync(p, 'utf8'), {}));
}
function saveState(sessionId, st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(st));
}
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function hookOut(eventName, fields) { out({ hookSpecificOutput: Object.assign({ hookEventName: eventName }, fields) }); }

function requiresMet(req, st, after) {
  const names = (req && req.any_of) || [];
  // satisfied[name] holds the time of the invocation; `after` demands an invocation newer than a block
  return names.some((n) => st.satisfied[n] && (!after || st.satisfied[n] > after));
}
function requiresText(req) {
  const names = (req && req.any_of) || [];
  const skills = names.filter((n) => !n.startsWith('mcp__'));
  const tools = names.filter((n) => n.startsWith('mcp__'));
  const parts = [];
  if (skills.length) parts.push('Skill tool with skill = ' + skills.slice(0, 4).map((s) => '"' + s + '"').join(' or '));
  if (tools.length) parts.push('tool ' + tools.slice(0, 3).join(' or '));
  return parts.join('; or ');
}
function fireRoute(st, route, by) {
  if (requiresMet(route.requires, st)) return false;
  if (!st.fired[route.id]) st.fired[route.id] = { by, at: Date.now() };
  return true;
}
function routeStatusLines(routes, st) {
  return routes.routes.map((r) => {
    const met = requiresMet(r.requires, st);
    const fired = !!st.fired[r.id];
    const mark = met ? 'OK ' : fired ? 'DUE' : '-- ';
    return `${mark} ${r.id}: ${r.title}` + (r.gate && r.gate.length ? '' : ' (advisory)');
  });
}
function normalizeError(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[a-z]:\\[^\s"']+|\/[^\s"']+/g, '<path>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
function lastAssistantText(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = parseJSON(lines[i], null);
      if (!e || e.type !== 'assistant' || !e.message) continue;
      const c = e.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const t = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
        if (t.trim()) return t;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------- event handlers ----------
function onSessionStart(input, routes, st) {
  const source = input.source || 'startup';
  if (source === 'startup' || source === 'clear') st = emptyState();
  saveState(input.session_id, st);
  const banner = (routes.session_banner && routes.session_banner.lines) || [];
  const lines = [...banner, '', 'Routes (trigger -> required):', ...routes.routes.map((r) => `- ${r.id}: ${r.title} -> ${requiresText(r.requires)}`)];
  hookOut('SessionStart', { additionalContext: lines.join('\n') });
}

function onUserPromptSubmit(input, routes, st) {
  const prompt = input.prompt || input.user_prompt || '';
  const due = [];
  for (const r of routes.routes) {
    if (anyMatch(compile(r.prompt), prompt) && fireRoute(st, r, 'prompt')) due.push(r);
  }
  saveState(input.session_id, st);
  if (!due.length) return;
  const lines = ['ARSENAL GATE — this prompt matched routes that require consultation BEFORE any edit:'];
  for (const r of due) {
    const enforced = r.gate && r.gate.length;
    lines.push(`- [${r.id}] ${r.title}. Invoke ${requiresText(r.requires)}.` + (enforced ? ` Until then ${r.gate.join('/')} are denied.` : ' (advisory)'));
  }
  hookOut('UserPromptSubmit', { additionalContext: lines.join('\n') });
}

function onPreToolUse(input, routes, st) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const filePath = ti.file_path || ti.notebook_path || ti.path || '';
  const cmd = tool === 'Bash' ? (ti.command || '') : '';
  const bashWrite = tool === 'Bash' && isBashWrite(cmd);
  // Path- and command-triggered routes fire here. A writing shell command is matched against `paths` too.
  for (const r of routes.routes) {
    if ((filePath && anyMatch(compile(r.paths), filePath)) || (cmd && anyMatch(compile(r.bash), cmd)) || (bashWrite && anyMatch(compile(r.paths), cmd))) fireRoute(st, r, filePath ? 'path' : 'bash');
  }
  // For route gates a writing shell command is treated as an Edit.
  const gateTool = bashWrite ? 'Edit' : tool;
  // 1. Error-loop block.
  const loop = routes.error_loop || {};
  if (st.blocked[tool] && !requiresMet(loop.requires, st, st.blocked[tool].at)) {
    saveState(input.session_id, st);
    return hookOut('PreToolUse', {
      permissionDecision: 'deny',
      permissionDecisionReason: `ARSENAL GATE: ${tool} failed ${st.blocked[tool].count}x with the same error signature ${st.blocked[tool].sig} ("${st.blocked[tool].sample}"). Retrying is denied. Invoke ${requiresText(loop.requires)} now, diagnose, then retry.`,
    });
  }
  // 2. Route gates.
  for (const r of routes.routes) {
    if (!st.fired[r.id] || !(r.gate || []).includes(gateTool) || requiresMet(r.requires, st)) continue;
    saveState(input.session_id, st);
    const what = bashWrite ? 'This shell command writes files and' : tool;
    return hookOut('PreToolUse', {
      permissionDecision: 'deny',
      permissionDecisionReason: `ARSENAL GATE [${r.id}]: ${r.title}. ${what} is denied until you invoke ${requiresText(r.requires)}. Do that first, then repeat the edit (prefer the Write/Edit tools over shell redirection).`,
    });
  }
  saveState(input.session_id, st);
}

function onPostToolUse(input, routes, st) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  st.tools++;
  const now = Date.now();
  st.satisfied[tool] = now;
  if (tool === 'Skill') {
    const name = ti.skill || ti.name || ti.command || '';
    if (name) {
      st.satisfied[name] = now;
      const short = name.includes(':') ? name.split(':').pop() : name;
      st.satisfied[short] = now; // allow routes to name unprefixed skills
    }
  }
  if (EDIT_TOOLS.has(tool)) st.edits_since_verify++;
  if (tool === 'Bash') {
    const cmd = ti.command || '';
    const sg = routes.stop_gate || {};
    if (anyMatch(compile(sg.verify_bash), cmd)) st.edits_since_verify = 0;
    else if (isBashWrite(cmd)) st.edits_since_verify++;
  }
  // A debugging skill invoked AFTER a block lifts that block (an earlier invocation does not count).
  const loop = routes.error_loop || {};
  for (const t of Object.keys(st.blocked)) {
    if (requiresMet(loop.requires, st, st.blocked[t].at)) delete st.blocked[t];
  }
  saveState(input.session_id, st);
}

function onPostToolUseFailure(input, routes, st) {
  const tool = input.tool_name || '';
  const raw = input.error || input.tool_response || input.tool_result || '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const norm = normalizeError(text);
  const sig = crypto.createHash('sha1').update(tool + '|' + norm).digest('hex').slice(0, 8);
  const e = st.errsigs[sig] || { count: 0, tool, sample: norm.slice(0, 120) };
  e.count++;
  st.errsigs[sig] = e;
  const loop = routes.error_loop || { warn: 2, block: 3 };
  let msg = null;
  if (e.count >= (loop.block || 3)) {
    st.blocked[tool] = { sig, count: e.count, sample: e.sample, at: Date.now() };
    msg = `ARSENAL GATE: error ${sig} from ${tool} has now repeated ${e.count}x ("${e.sample}"). ${tool} is DENIED until you invoke ${requiresText(loop.requires)} and change the approach. This is a loop; stop pushing on it.`;
  } else if (e.count >= (loop.warn || 2)) {
    msg = `ARSENAL GATE: error ${sig} from ${tool} repeated ${e.count}x ("${e.sample}"). Do not retry the same call. Invoke ${requiresText(loop.requires)} before the next attempt; a third identical failure denies ${tool}.`;
  }
  saveState(input.session_id, st);
  if (msg) hookOut('PostToolUseFailure', { additionalContext: msg });
}

function onStop(input, routes, st) {
  if (input.stop_hook_active) return; // a previous block already ran this turn; never loop
  const sg = routes.stop_gate || {};
  if (sg.enabled && st.edits_since_verify > 0 && st.stop_blocks < (sg.max_blocks || 2)) {
    st.stop_blocks++;
    saveState(input.session_id, st);
    return out({ decision: 'block', reason: `ARSENAL GATE: ${st.edits_since_verify} file edit(s) happened since the last verification command and none ran afterwards. Run the project's verification (tests/harness) and report its real output before finishing. (Recognized commands: ${(sg.verify_bash || []).slice(0, 5).join(' | ')} …)` });
  }
  const rp = routes.reply_prefix || {};
  if (rp.enabled && st.prefix_blocks < (rp.max_blocks || 1)) {
    const text = lastAssistantText(input.transcript_path);
    if (text !== null && !text.trimStart().startsWith(rp.prefix)) {
      st.prefix_blocks++;
      saveState(input.session_id, st);
      return out({ decision: 'block', reason: `ARSENAL GATE: the first line of the final reply must start with "${rp.prefix}" (project gate line). Rewrite the reply with that line first.` });
    }
  }
  saveState(input.session_id, st);
}

// ---------- main ----------
(function main() {
  let input = {};
  try {
    input = parseJSON(readStdin(), {}) || {};
    if (disabled(input)) return;
    const routes = loadRoutes();
    const st = loadState(input.session_id);
    switch (EVENT) {
      case 'SessionStart': return onSessionStart(input, routes, st);
      case 'UserPromptSubmit': return onUserPromptSubmit(input, routes, st);
      case 'PreToolUse': return onPreToolUse(input, routes, st);
      case 'PostToolUse': return onPostToolUse(input, routes, st);
      case 'PostToolUseFailure': return onPostToolUseFailure(input, routes, st);
      case 'Stop': return onStop(input, routes, st);
      case 'SubagentStop': return; // v0.1: subagents are not gated on stop
      case 'status': return out({ state: st, routes: routeStatusLines(routes, st) });
      default: return;
    }
  } catch (err) {
    if (process.env.ARSENAL_GATE_DEBUG) process.stderr.write('arsenal-gate: ' + (err && err.stack || err) + '\n');
    // fail open
  }
})();
