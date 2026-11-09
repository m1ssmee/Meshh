// Runs `claude -p` as a child process and turns its stream-json output into simple
// log entries for the UI. Works with a Claude Pro/Max login; no API key needed.
import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(here, '..', 'mock', 'claude-mock.js');

export function claudeCommand({ demo }) {
  if (demo) return { cmd: process.execPath, pre: [MOCK] };
  if (process.env.MESHH_CLAUDE_BIN) return { cmd: process.env.MESHH_CLAUDE_BIN, pre: [] };
  return { cmd: 'claude', pre: [] };
}

export function claudeVersion({ demo }) {
  const { cmd, pre } = claudeCommand({ demo });
  return new Promise((resolve) => {
    const child = spawn(cmd, [...pre, '--version'], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => {
      child.kill();
      resolve(null);
    }, 15000);
  });
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function rel(cwd, p) {
  if (!cwd || !path.isAbsolute(p)) return p;
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p;
}

function summarizeInput(name, input = {}, cwd) {
  if (input.file_path) return rel(cwd, input.file_path);
  if (input.notebook_path) return rel(cwd, input.notebook_path);
  if (input.path && !input.pattern) return rel(cwd, input.path);
  if (name === 'Bash') return input.command;
  if (input.pattern) return input.pattern + (input.path ? `  in ${input.path}` : '');
  if (input.query) return input.query;
  if (input.url) return input.url;
  if (input.skill) return input.skill;
  if (input.description) return input.description;
  const s = JSON.stringify(input);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return '';
}

function clip(s, n = 2000) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

/**
 * @param {object} o
 * @param {string} o.cwd
 * @param {string} o.prompt     sent on stdin (avoids command-line length/quoting limits on Windows)
 * @param {string[]} o.args     extra CLI args
 * @param {boolean} o.demo
 * @param {(entry: object) => void} o.onLog
 * @returns {{ done: Promise<object>, stop: () => void, pid: number }}
 */
export function runClaude({ cwd, prompt, args, demo, onLog }) {
  const { cmd, pre } = claudeCommand({ demo });
  const fullArgs = [...pre, '-p', '--output-format', 'stream-json', '--verbose', ...args];
  const child = spawn(cmd, fullArgs, {
    cwd,
    env: { ...process.env, MESHH: '1' },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    sessionId: null,
    result: null,
    filesTouched: new Set(),
    stopped: false,
    stderr: '',
  };
  const toolNames = {};

  const handle = (ev) => {
    if (ev.session_id && !state.sessionId) state.sessionId = ev.session_id;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') onLog({ kind: 'init', model: ev.model, tools: ev.tools, sessionId: ev.session_id });
        else if (ev.subtype === 'api_retry')
          onLog({ kind: 'warn', text: `API ${ev.error || 'error'} — retrying (attempt ${ev.attempt}/${ev.max_retries})` });
        else if (ev.subtype === 'permission_denied')
          onLog({ kind: 'denied', text: `Blocked: ${ev.tool_name || 'tool'} ${summarizeInput(ev.tool_name, ev.tool_input, cwd)}` });
        break;
      case 'assistant': {
        if (ev.parent_tool_use_id) break; // nested subagent chatter: keep the log readable
        for (const block of ev.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) onLog({ kind: 'text', text: block.text });
          if (block.type === 'tool_use') {
            toolNames[block.id] = block.name;
            const target = summarizeInput(block.name, block.input, cwd);
            if (FILE_TOOLS.has(block.name) && (block.input?.file_path || block.input?.notebook_path)) {
              const abs = block.input.file_path || block.input.notebook_path;
              const rel = path.isAbsolute(abs) ? path.relative(cwd, abs) : abs;
              state.filesTouched.add(rel.split(path.sep).join('/'));
            }
            onLog({ kind: 'tool', name: block.name, target, id: block.id });
          }
        }
        break;
      }
      case 'user': {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'tool_result') {
            const txt = textOf(block.content);
            if (block.is_error) onLog({ kind: 'tool_error', name: toolNames[block.tool_use_id], text: clip(txt, 600) });
          }
        }
        break;
      }
      case 'result':
        state.result = ev;
        break;
      default:
        break;
    }
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        onLog({ kind: 'stdout', text: clip(line, 500) });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString();
    if (state.stderr.length > 20000) state.stderr = state.stderr.slice(-20000);
  });

  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      if (buf.trim()) {
        try {
          handle(JSON.parse(buf.trim()));
        } catch {}
      }
      const r = state.result;
      const ok = !spawnError && !state.stopped && r && !r.is_error && code === 0;
      resolve({
        ok,
        stopped: state.stopped,
        code,
        sessionId: state.sessionId || r?.session_id || null,
        text: r?.result || '',
        structured: r?.structured_output,
        costUsd: r?.total_cost_usd || 0,
        usage: r?.usage || null,
        durationMs: r?.duration_ms || 0,
        numTurns: r?.num_turns || 0,
        denials: r?.permission_denials || [],
        filesTouched: [...state.filesTouched],
        error: spawnError
          ? spawnError.code === 'ENOENT'
            ? 'Claude Code CLI not found. Install it with `npm i -g @anthropic-ai/claude-code` and run `claude` once to log in.'
            : spawnError.message
          : r?.is_error
            ? r.result || 'Claude reported an error'
            : !r && !state.stopped
              ? (state.stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with code ${code}`)
              : null,
      });
    };
    child.on('error', (err) => finish(-1, err));
    child.on('close', (code) => finish(code));
  });

  const stop = () => {
    state.stopped = true;
    killTree(child);
  };

  return { done, stop, pid: child.pid };
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGINT');
  } catch {
    child.kill('SIGINT');
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 5000).unref();
}
