#!/usr/bin/env node
// A fake `claude -p` used by `meshh --demo` and the tests. It speaks the same
// stream-json protocol as Claude Code, makes small real file edits, and needs no login.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.319 (Claude Code) — Meshh demo simulator');
  process.exit(0);
}

const KNOWN = new Set([
  '-p', '--print', '--verbose', '--output-format', '--agents', '--agent', '--json-schema', '--resume',
  '--allowedTools', '--disallowedTools', '--permission-prompts', '--model', '--tools',
]);
function values(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !(argv[j].startsWith('-') && KNOWN.has(argv[j])); j++) out.push(argv[j]);
  return out;
}
const one = (flag) => values(flag)[0];

const sessionId = one('--resume') || crypto.randomUUID();
const agentName = one('--agent') || 'agent';
let agentDef = {};
try {
  agentDef = JSON.parse(fs.readFileSync(one('--agents'), 'utf8'))[agentName] || {};
} catch {}
const allowed = values('--allowedTools');
const scope = allowed.map((a) => a.match(/^Edit\(\.\/(.+)\/\*\*\)$/)?.[1]).filter(Boolean);
const schema = one('--json-schema');

let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
  process.exit(130);
});
process.on('SIGTERM', () => process.exit(143));

const emit = (o) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
let toolN = 0;
async function tool(name, input, resultText = 'ok') {
  const id = `toolu_demo_${++toolN}`;
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  await jitter(300, 900);
  emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] } });
}
async function say(text) {
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  await jitter(400, 1000);
}
function finish(result, extra = {}) {
  const out = 900 + Math.floor(Math.random() * 1500);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    num_turns: 3,
    duration_ms: 4000,
    total_cost_usd: Number((0.01 + Math.random() * 0.05).toFixed(4)),
    usage: { input_tokens: 2000 + Math.floor(Math.random() * 4000), output_tokens: out, cache_read_input_tokens: 8000 },
    permission_denials: [],
    ...extra,
  });
}
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'feature';
const pascal = (s) => slug(s).split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join('');

function write(rel, content) {
  const abs = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const prompt = await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => resolve(s));
  setTimeout(() => resolve(s), 2000);
});

emit({ type: 'system', subtype: 'init', model: agentDef.model || 'demo-model', tools: agentDef.tools || ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] });
await jitter(300, 700);

// ---------- planning ----------
if (schema) {
  let names = [];
  try {
    names = JSON.parse(schema).properties.tasks.items.properties.agent.enum;
  } catch {}
  const pick = (...want) => want.find((w) => names.includes(w)) || names[0];
  const fullGoal = (prompt.match(/GOAL\n([\s\S]*?)\n\n/) || [])[1]?.trim() || 'the feature';
  // Short name for titles: text before a colon, else the first few words.
  const goal = (fullGoal.split(/[:.\n]/)[0].replace(/^(add|build|create|implement)\s+(an?\s+)?/i, '').split(/\s+/).slice(0, 4).join(' ') || 'the feature').toLowerCase();
  await say(`Let me look at the project before planning this.`);
  await tool('Glob', { pattern: '**/*.{js,jsx,ts,tsx,md}' }, 'server/index.js\nclient/src/App.jsx\nREADME.md');
  await tool('Read', { file_path: path.join(process.cwd(), 'README.md') }, '# Demo shop');
  await say('The project has an Express server in server/ and a React client in client/. I will start with an API contract so both sides agree.');
  const tasks = [
    { id: 't1', title: 'Write the API contract', agent: pick('backend'), brief: `Write docs/api-contract.md describing the endpoints needed for: ${fullGoal}`, dependsOn: [] },
    { id: 't2', title: `Implement the API for ${goal}`, agent: pick('backend'), brief: `Implement the endpoints in docs/api-contract.md inside server/.`, dependsOn: ['t1'] },
    { id: 't3', title: `Build the UI for ${goal}`, agent: pick('frontend', 'backend'), brief: `Build the client UI in client/src using the contract in docs/api-contract.md.`, dependsOn: ['t1'] },
  ];
  if (names.includes('tester')) tasks.push({ id: 't4', title: 'Write and run tests', agent: 'tester', brief: 'Test the new endpoints and UI.', dependsOn: ['t2', 't3'] });
  if (names.includes('reviewer'))
    tasks.push({ id: 't5', title: 'Review the changes', agent: 'reviewer', brief: 'Review all changes in this run.', dependsOn: names.includes('tester') ? ['t4'] : ['t2', 't3'] });
  const plan = { summary: `Contract first, then backend and frontend in parallel${names.includes('tester') ? ', then tests' : ''}${names.includes('reviewer') ? ' and a review' : ''}.`, tasks };
  finish('```json\n' + JSON.stringify(plan, null, 2) + '\n```', { structured_output: plan });
  process.exit(0);
}

// ---------- final summary ----------
if (prompt.startsWith('Your team has finished')) {
  await say('Checking what the team changed.');
  await tool('Grep', { pattern: 'TODO|FIXME' }, 'No matches');
  finish(
    `**What changed**\n- An API contract in \`docs/api-contract.md\`\n- New endpoints in \`server/\`\n- A new UI component in \`client/src/\`\n- Tests and a review, if those agents were on the team\n\n**Before you accept**\n- Run the tests and start the app once.\n- Read the reviewer's notes in the run log.\n\n_This was a demo run with simulated agents._`,
  );
  process.exit(0);
}

// ---------- follow-up ----------
if (one('--resume')) {
  await say(`Got it. Applying your note: “${prompt.trim().slice(0, 120)}”.`);
  const rel = path.join(scope[0] || 'notes', `followup-${agentName}.md`).split(path.sep).join('/');
  await tool('Write', { file_path: path.join(process.cwd(), rel), content: '...' });
  write(rel, `# Follow-up for ${agentName}\n\n${prompt.trim()}\n`);
  finish(`Done. I recorded the change in \`${rel}\`.`);
  process.exit(0);
}

// ---------- work ----------
const title = (prompt.match(/YOUR TASK \([^)]*\): (.+)/) || [])[1] || 'task';
const tools = agentDef.tools || ['Read', 'Edit', 'Write', 'Bash'];
const canWrite = tools.includes('Write') || tools.includes('Edit');
const s = slug(title.replace(/^(implement the api for|build the ui for)\s*/i, ''));

await say(`Starting: ${title}.`);
await tool('Read', { file_path: path.join(process.cwd(), 'README.md') }, '# Demo shop');
if (fs.existsSync(path.join(process.cwd(), 'docs', 'api-contract.md')))
  await tool('Read', { file_path: path.join(process.cwd(), 'docs', 'api-contract.md') }, '...contract...');

let files = [];
if (!canWrite) {
  await tool('Grep', { pattern: 'router\\.|fetch\\(' }, 'server/routes/...\nclient/src/...');
  await say('Reviewing the changed files for correctness and security.');
  finish(
    `**Review**\n\n*Must fix*: none found.\n\n*Should fix*\n- Validate request bodies in the new route.\n- Show an error state in the UI when the request fails.\n\n*Nice to have*\n- Add a loading skeleton.`,
  );
  process.exit(0);
}

let rel;
if (/contract/i.test(title)) {
  rel = 'docs/api-contract.md';
  write(rel, `# API contract\n\n## GET /api/${s}\nReturns \`{ items: [] }\`.\n\n## POST /api/${s}\nBody \`{ name: string }\`. Returns the created item.\n`);
} else if (agentName.includes('front')) {
  rel = `client/src/${pascal(s)}.jsx`;
  write(rel, `export default function ${pascal(s)}() {\n  return <section className="${s}">\n    <h2>${title}</h2>\n  </section>;\n}\n`);
} else if (agentName.includes('test')) {
  rel = `tests/${s}.test.js`;
  write(rel, `import test from 'node:test';\nimport assert from 'node:assert';\n\ntest('${title}', () => {\n  assert.ok(true);\n});\n`);
  await tool('Bash', { command: 'npm test' }, '✔ 3 tests passed');
} else if (agentName.includes('doc')) {
  rel = `docs/${s}.md`;
  write(rel, `# ${title}\n\nHow to use the new feature.\n`);
} else {
  rel = `server/routes/${s}.js`;
  write(rel, `import { Router } from 'express';\n\nconst router = Router();\nconst items = [];\n\nrouter.get('/', (req, res) => res.json({ items }));\nrouter.post('/', (req, res) => {\n  const item = { id: items.length + 1, name: String(req.body?.name || '') };\n  items.push(item);\n  res.status(201).json(item);\n});\n\nexport default router;\n`);
}
if (scope.length && !scope.some((sc) => rel.startsWith(sc + '/'))) {
  emit({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_input: { file_path: rel } });
  fs.rmSync(path.join(process.cwd(), rel), { force: true });
  finish(`I could not write ${rel} because it is outside my folder scope (${scope.join(', ')}).`, {
    permission_denials: [{ tool_name: 'Write' }],
  });
  process.exit(0);
}
await tool('Write', { file_path: path.join(process.cwd(), rel), content: '...' });
files.push(rel);
await say(`Created ${rel}.`);
if (!stopped) finish(`Finished “${title}”.\n\nFiles changed: \`${files.join('`, `')}\`.`);
