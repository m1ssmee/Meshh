#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDemoProject } from '../mock/demo-project.js';
import { startServer } from '../server/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`
  Meshh — run a team of Claude Code agents from a local web UI

  Usage
    meshh [project-folder] [options]

  Options
    --port <n>     Port for the UI (default 4317)
    --demo         Use a simulated Claude so you can try the UI without logging in.
                   Without a folder, creates a sample project to play with.
    --no-open      Don't open the browser
    -h, --help     Show this help

  Requires Claude Code (npm i -g @anthropic-ai/claude-code), logged in with \`claude\`,
  and git. Works with a Claude Pro/Max subscription; no API key needed.
`);
  process.exit(0);
}

const demo = flag('--demo');
const port = Number(opt('--port', process.env.PORT || 4317));
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
let root = positional[0] ? path.resolve(positional[0]) : process.cwd();

if (demo && !positional[0]) {
  root = await createDemoProject(path.join(os.tmpdir(), 'meshh-demo'));
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Not a folder: ${root}`);
  process.exit(1);
}

try {
  const { url } = await startServer({ root, port, demo });
  console.log(`\n  ◆ Meshh${demo ? ' (demo mode — simulated agents)' : ''}`);
  console.log(`    Project  ${root}`);
  console.log(`    Open     ${url}\n`);
  if (!flag('--no-open')) {
    const { default: open } = await import('open');
    open(url).catch(() => {});
  }
} catch (err) {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Try: meshh --port ${port + 1}`);
  else console.error(err);
  process.exit(1);
}
