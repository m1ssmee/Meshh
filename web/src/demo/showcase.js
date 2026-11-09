// In-browser stand-in for the Meshh server, used by the hosted showcase (e.g. Vercel).
// Same API surface as web/src/api.js and the same live events, with simulated agents.
// Nothing leaves the browser; state lives in memory for the visit.
import { TEMPLATES, TOOL_GROUPS } from '../../../server/templates.js';

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (m) => listeners.forEach((fn) => fn(m));
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'feature';
const pascal = (s) =>
  slug(s)
    .split('-')
    .map((w) => (w[0] || '').toUpperCase() + w.slice(1))
    .join('');

// ---------------------------------------------------------------- seed data
const SKILLS = [
  {
    name: 'api-design',
    description: 'Conventions for designing REST endpoints in this project. Use when adding or changing API routes.',
    body: '# API design\n\n- Plural nouns: `/api/products`.\n- Return JSON objects, never bare arrays.\n- Errors: `{ error: { code, message } }`.\n- Validate every request body.',
  },
  {
    name: 'write-tests',
    description: 'How to write tests in this project with node:test. Use when adding tests.',
    body: '# Writing tests\n\n- Use `node:test` and `node:assert`.\n- One file per feature in `tests/`.\n- Cover the happy path, bad input, and empty states.',
  },
  {
    name: 'ui-polish',
    description: 'Checklist for polished, accessible UI components. Use when building frontend components.',
    body: '# UI polish\n\n- Every control works with the keyboard.\n- Handle loading, empty and error states.\n- Use the spacing scale: 4, 8, 12, 16, 24, 32.',
  },
];
const SETUP = {
  backend: { scope: ['server', 'docs'], skills: ['api-design'] },
  frontend: { scope: ['client'], skills: ['ui-polish'] },
  tester: { scope: ['tests'], skills: ['write-tests'] },
  reviewer: { scope: [], skills: ['api-design', 'ui-polish'] },
  lead: { scope: [], skills: [] },
};

function fromTemplate(t, name = t.name) {
  const s = SETUP[t.name] || { scope: [], skills: [] };
  return {
    name,
    file: `.claude/agents/${name}.md`,
    description: t.description,
    tools: [...t.tools],
    disallowedTools: null,
    model: t.model,
    body: t.body,
    extra: {},
    icon: t.icon,
    color: t.color,
    role: t.role,
    scope: [...s.scope],
    skills: [...s.skills],
    isLead: t.name === 'lead',
  };
}

const state = {
  agents: TEMPLATES.filter((t) => ['lead', 'backend', 'frontend', 'tester', 'reviewer'].includes(t.name)).map((t) => fromTemplate(t)),
  skills: SKILLS.map((s) => ({ ...s, dir: s.name, scope: 'project', extra: {}, editable: true })),
  guidelines:
    '# Project guidelines\n\n- Express server lives in `server/`, React client in `client/`.\n- Use ES modules everywhere.\n- Keep functions small and name things clearly.\n- Every new endpoint needs a test in `tests/`.\n',
  config: { lead: 'lead', maxParallel: 3, setupCommand: '', finalSummary: true, agents: {} },
  runs: new Map(),
  timers: new Map(), // `${runId}:${taskId}` -> { cancelled }
};

const sortAgents = () =>
  state.agents.sort((a, b) => (a.isLead === b.isLead ? a.name.localeCompare(b.name) : a.isLead ? -1 : 1));
sortAgents();

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ---------------------------------------------------------------- runs
function summarize(run) {
  const tasks = {};
  for (const [id, t] of Object.entries(run.tasks)) {
    const { logs, ...rest } = t;
    tasks[id] = { ...rest, logCount: logs.length };
  }
  const { logs, ...lead } = run.lead;
  const { files, ...rest } = run;
  return clone({ ...rest, tasks, lead: { ...lead, logCount: logs.length } });
}

function changed(run) {
  let cost = 0,
    input = 0,
    output = 0;
  for (const h of [run.lead, ...Object.values(run.tasks)]) {
    cost += h.costUsd || 0;
    input += h.inputTokens || 0;
    output += h.outputTokens || 0;
  }
  run.totals = { costUsd: cost, inputTokens: input, outputTokens: output };
  emit({ type: 'run', run: summarize(run) });
}

function log(run, taskId, entry) {
  const e = { t: Date.now(), ...entry };
  const holder = taskId === 'lead' ? run.lead : run.tasks[taskId];
  holder.logs.push(e);
  emit({ type: 'log', runId: run.id, taskId, entry: e });
}

function account(holder) {
  holder.inputTokens = (holder.inputTokens || 0) + 6000 + Math.floor(Math.random() * 9000);
  holder.outputTokens = (holder.outputTokens || 0) + 600 + Math.floor(Math.random() * 1600);
  holder.costUsd = (holder.costUsd || 0) + 0.01 + Math.random() * 0.04;
}

function token(run, key) {
  const t = { cancelled: false };
  state.timers.set(`${run.id}:${key}`, t);
  return t;
}

function getRun(id) {
  const run = state.runs.get(id);
  if (!run) throw new Error('Run not found');
  return run;
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(16).slice(2, 6)}`;
}

function shortGoal(task) {
  return (
    task
      .split(/[:.\n]/)[0]
      .replace(/^(add|build|create|implement|make)\s+(an?\s+)?/i, '')
      .split(/\s+/)
      .slice(0, 4)
      .join(' ')
      .toLowerCase() || 'the feature'
  );
}

async function plan(run) {
  const tk = token(run, 'lead');
  const workers = state.agents.filter((a) => !a.isLead).map((a) => a.name);
  const pick = (...want) => want.find((w) => workers.includes(w)) || workers[0];
  const goal = shortGoal(run.task);
  log(run, 'lead', { kind: 'phase', text: 'Planning' });
  await jitter(400, 700);
  log(run, 'lead', { kind: 'init', model: 'simulated' });
  await jitter(500, 900);
  log(run, 'lead', { kind: 'text', text: 'Let me look at the project before planning this.' });
  await jitter(500, 900);
  log(run, 'lead', { kind: 'tool', name: 'Glob', target: '**/*.{js,jsx,md}' });
  await jitter(400, 800);
  log(run, 'lead', { kind: 'tool', name: 'Read', target: 'README.md' });
  await jitter(500, 900);
  log(run, 'lead', {
    kind: 'text',
    text: 'There is an Express server in `server/` and a React client in `client/`. I will start with an API contract so both sides agree.',
  });
  await jitter(700, 1100);
  if (tk.cancelled) return;

  const tasks = [
    { id: 't1', title: 'Write the API contract', agent: pick('backend'), brief: `Write docs/api-contract.md describing the endpoints needed for: ${run.task}`, dependsOn: [] },
    { id: 't2', title: `Implement the API for ${goal}`, agent: pick('backend'), brief: 'Implement the endpoints in docs/api-contract.md inside server/.', dependsOn: ['t1'] },
    { id: 't3', title: `Build the UI for ${goal}`, agent: pick('frontend', 'backend'), brief: 'Build the client UI in client/src using docs/api-contract.md.', dependsOn: ['t1'] },
  ];
  if (workers.includes('tester')) tasks.push({ id: 't4', title: 'Write and run tests', agent: 'tester', brief: 'Test the new endpoints and UI.', dependsOn: ['t2', 't3'] });
  if (workers.includes('reviewer'))
    tasks.push({ id: 't5', title: 'Review the changes', agent: 'reviewer', brief: 'Review all changes in this run.', dependsOn: workers.includes('tester') ? ['t4'] : ['t2', 't3'] });
  account(run.lead);
  run.plan = {
    summary: `Contract first, then backend and frontend in parallel${workers.includes('tester') ? ', then tests' : ''}${workers.includes('reviewer') ? ' and a review' : ''}.`,
    tasks,
  };
  run.lead.status = 'done';
  run.status = 'awaiting_approval';
  log(run, 'lead', { kind: 'phase', text: `Plan ready: ${tasks.length} task(s)` });
  changed(run);
}

function fileFor(agent, title) {
  const s = slug(title.replace(/^(implement the api for|build the ui for)\s*/i, ''));
  if (/contract/i.test(title))
    return [
      'docs/api-contract.md',
      `# API contract\n\n## GET /api/${s}\nReturns \`{ items: [] }\`.\n\n## POST /api/${s}\nBody \`{ name: string }\`. Returns the created item.\n\n## DELETE /api/${s}/:id\nRemoves an item. Returns \`204\`.`,
    ];
  if (agent.name.includes('front'))
    return [
      `client/src/${pascal(s)}.jsx`,
      `import { useEffect, useState } from 'react';\n\nexport default function ${pascal(s)}() {\n  const [items, setItems] = useState([]);\n  useEffect(() => {\n    fetch('/api/${s}').then((r) => r.json()).then((d) => setItems(d.items));\n  }, []);\n  return (\n    <section>\n      <h2>${title}</h2>\n      {items.length === 0 ? <p>Nothing saved yet.</p> : <ul>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>}\n    </section>\n  );\n}`,
    ];
  if (agent.name.includes('test'))
    return [
      `tests/${s}.test.js`,
      `import test from 'node:test';\nimport assert from 'node:assert';\n\ntest('lists items', async () => {\n  assert.ok(true);\n});\n\ntest('rejects an empty name', async () => {\n  assert.ok(true);\n});`,
    ];
  if (agent.name.includes('doc')) return [`docs/${s}.md`, `# ${title}\n\nHow to use the new feature.`];
  return [
    `server/routes/${s}.js`,
    `import { Router } from 'express';\n\nconst router = Router();\nconst items = [];\n\nrouter.get('/', (req, res) => res.json({ items }));\nrouter.post('/', (req, res) => {\n  const name = String(req.body?.name || '').trim();\n  if (!name) return res.status(400).json({ error: { code: 'bad_input', message: 'name is required' } });\n  const item = { id: items.length + 1, name };\n  items.push(item);\n  res.status(201).json(item);\n});\n\nexport default router;`,
  ];
}

async function runTask(run, t) {
  const st = run.tasks[t.id];
  const agent = state.agents.find((a) => a.name === t.agent);
  const tk = token(run, t.id);
  st.status = 'running';
  st.startedAt = new Date().toISOString();
  st.sessionId = `demo-${t.id}`;
  changed(run);
  const step = async (entry, a = 500, b = 1100) => {
    if (tk.cancelled) throw new Error('stopped');
    log(run, t.id, entry);
    await jitter(a, b);
  };
  try {
    await step({ kind: 'init', model: agent?.model === 'inherit' ? 'simulated' : agent?.model || 'simulated' }, 300, 600);
    await step({ kind: 'text', text: `Starting: ${t.title}.` });
    await step({ kind: 'tool', name: 'Read', target: 'CLAUDE.md' }, 300, 700);
    if (run.files['docs/api-contract.md']) await step({ kind: 'tool', name: 'Read', target: 'docs/api-contract.md' }, 300, 700);
    const canWrite = !agent?.tools || agent.tools.includes('Edit') || agent.tools.includes('Write');
    if (!canWrite) {
      await step({ kind: 'tool', name: 'Grep', target: 'router\\.|fetch\\(' });
      await step({ kind: 'text', text: 'Reviewing the changed files for correctness and security.' }, 900, 1400);
      st.result = `**Review**\n\n*Must fix*: none found.\n\n*Should fix*\n- Validate request bodies in the new route.\n- Show an error state in the UI when the request fails.\n\n*Nice to have*\n- Add a loading skeleton.`;
      await step({ kind: 'text', text: st.result }, 200, 300);
    } else {
      const [path, content] = fileFor(agent, t.title);
      const scope = agent.scope || [];
      if (scope.length && !scope.some((s) => path.startsWith(s + '/'))) {
        await step({ kind: 'denied', text: `Blocked: Write ${path}` });
        throw Object.assign(new Error(`Could not write ${path}: it is outside this agent’s folder scope (${scope.join(', ')}).`), { soft: true });
      }
      if (agent.name.includes('test')) await step({ kind: 'tool', name: 'Bash', target: 'npm test' }, 900, 1500);
      await step({ kind: 'tool', name: 'Write', target: path }, 700, 1300);
      run.files[path] = { content, agents: [...new Set([...(run.files[path]?.agents || []), agent.name])] };
      st.filesTouched = [...new Set([...(st.filesTouched || []), path])];
      st.result = `Finished “${t.title}”.\n\nFiles changed: \`${path}\`.`;
      await step({ kind: 'text', text: st.result }, 200, 400);
    }
    account(st);
    st.status = 'done';
  } catch (err) {
    account(st);
    if (tk.cancelled) st.status = 'stopped';
    else {
      st.status = 'failed';
      st.error = err.message;
    }
  }
  st.endedAt = new Date().toISOString();
  changed(run);
}

async function execute(run) {
  const tasks = run.plan.tasks;
  await new Promise((resolveAll) => {
    const tick = () => {
      if (run.status !== 'running') return resolveAll();
      let running = 0;
      for (const t of tasks) {
        const st = run.tasks[t.id];
        if (st.status === 'running') running++;
        if (st.status === 'pending' && t.dependsOn.some((d) => ['failed', 'skipped', 'stopped'].includes(run.tasks[d].status))) {
          st.status = 'skipped';
          st.error = 'A task it depends on did not finish.';
          changed(run);
        }
      }
      for (const t of tasks.filter((x) => run.tasks[x.id].status === 'pending' && x.dependsOn.every((d) => run.tasks[d].status === 'done'))) {
        if (running >= Math.max(1, state.config.maxParallel)) break;
        running++;
        runTask(run, t).finally(tick);
      }
      if (!tasks.some((t) => ['running', 'pending'].includes(run.tasks[t.id].status))) resolveAll();
    };
    tick();
  });
  if (run.status !== 'running') return;

  if (state.config.finalSummary) {
    run.status = 'summarizing';
    run.lead.status = 'running';
    changed(run);
    log(run, 'lead', { kind: 'phase', text: 'Writing the summary' });
    await jitter(600, 1000);
    log(run, 'lead', { kind: 'tool', name: 'Grep', target: 'TODO|FIXME' });
    await jitter(700, 1100);
    if (run.status !== 'summarizing') return;
    const files = Object.keys(run.files);
    run.summary = `**What changed**\n${files.map((f) => `- \`${f}\``).join('\n') || '- No files changed'}\n\n**Before you accept**\n- Run the tests and start the app once.\n- Read the reviewer’s notes in its column.\n\n_This is the hosted demo, so the agents are simulated and nothing was written to a real project._`;
    account(run.lead);
    run.lead.status = 'done';
  }
  run.status = 'review';
  run.finishedAt = new Date().toISOString();
  log(run, 'lead', { kind: 'phase', text: 'All tasks done. Review the changes.' });
  changed(run);
}

function patchFor(path, content) {
  const lines = content.split('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
}

// ---------------------------------------------------------------- public API
export const api = {
  async project() {
    return {
      root: '~/demo-shop',
      name: 'demo-shop',
      demo: true,
      showcase: true,
      git: { isRepo: true, hasCommits: true, branch: 'main', dirty: 0, isTopLevel: true },
      gitVersion: 'simulated',
      claude: { version: 'simulated' },
      config: clone(state.config),
    };
  },
  async gitInit() {
    return (await this.project()).git;
  },
  async meta() {
    return { templates: clone(TEMPLATES), toolGroups: clone(TOOL_GROUPS) };
  },
  async config(patch) {
    Object.assign(state.config, patch || {});
    return clone(state.config);
  },

  async agents() {
    return clone(state.agents);
  },
  async saveAgent(agent, prevName) {
    if (!NAME_RE.test(agent.name || '')) throw new Error('Agent name must be lowercase letters, numbers and dashes.');
    if (agent.name !== prevName && state.agents.some((a) => a.name === agent.name)) throw new Error(`An agent called ${agent.name} already exists.`);
    const next = {
      ...fromTemplate({ name: agent.name, description: '', tools: [], model: 'inherit', body: '', icon: '●', color: '#64748b', role: agent.name }),
      ...clone(agent),
      file: `.claude/agents/${agent.name}.md`,
    };
    if (next.isLead) state.agents.forEach((a) => (a.isLead = false));
    const i = state.agents.findIndex((a) => a.name === (prevName || agent.name));
    if (i >= 0) state.agents[i] = next;
    else state.agents.push(next);
    if (!state.agents.some((a) => a.isLead) && next.name === 'lead') next.isLead = true;
    sortAgents();
    return clone(next);
  },
  async deleteAgent(name) {
    state.agents = state.agents.filter((a) => a.name !== name);
  },
  async addTemplate(templateName) {
    const t = TEMPLATES.find((x) => x.name === templateName);
    if (!t) throw new Error('Unknown template');
    let name = t.name;
    let i = 2;
    while (state.agents.some((a) => a.name === name)) name = `${t.name}-${i++}`;
    const a = fromTemplate(t, name);
    a.isLead = t.name === 'lead' && !state.agents.some((x) => x.isLead);
    a.skills = [];
    state.agents.push(a);
    sortAgents();
    return clone(a);
  },
  async starterTeam() {
    for (const n of ['lead', 'backend', 'frontend', 'tester', 'reviewer']) if (!state.agents.some((a) => a.name === n)) await this.addTemplate(n);
    return clone(state.agents);
  },

  async skills() {
    return clone(state.skills);
  },
  async saveSkill(skill, prevName) {
    if (!NAME_RE.test(skill.name || '')) throw new Error('Skill name must be lowercase letters, numbers and dashes.');
    const next = { dir: skill.name, scope: 'project', extra: {}, editable: true, ...clone(skill) };
    next.dir = skill.name;
    const i = state.skills.findIndex((s) => s.name === (prevName || skill.name));
    if (i >= 0) state.skills[i] = next;
    else state.skills.push(next);
    if (prevName && prevName !== skill.name) for (const a of state.agents) if (Array.isArray(a.skills)) a.skills = a.skills.map((s) => (s === prevName ? skill.name : s));
    state.skills.sort((a, b) => a.name.localeCompare(b.name));
    return clone(next);
  },
  async deleteSkill(name) {
    state.skills = state.skills.filter((s) => s.name !== name);
    for (const a of state.agents) if (Array.isArray(a.skills)) a.skills = a.skills.filter((s) => s !== name);
  },

  async guidelines() {
    return { text: state.guidelines };
  },
  async saveGuidelines(text) {
    state.guidelines = text;
  },

  async runs() {
    return [...state.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarize);
  },
  async run(id) {
    const { files, ...rest } = getRun(id);
    return clone(rest);
  },
  async createRun(task) {
    if (!task?.trim()) throw new Error('Describe what you want the team to do.');
    if (!state.agents.some((a) => !a.isLead)) throw new Error('Add at least one agent besides the lead before starting a run.');
    const run = {
      id: newId(),
      task: task.trim(),
      createdAt: new Date().toISOString(),
      status: 'planning',
      error: null,
      plan: null,
      tasks: {},
      lead: { status: 'running', logs: [], costUsd: 0 },
      summary: '',
      worktree: null,
      baseBranch: 'main',
      dirtyAtStart: 0,
      totals: {},
      applied: null,
      files: {},
    };
    state.runs.set(run.id, run);
    changed(run);
    plan(run);
    return summarize(run);
  },
  async updatePlan(id, plan) {
    const run = getRun(id);
    if (run.status !== 'awaiting_approval') throw new Error('The plan can only be edited before you approve it.');
    const names = new Set(state.agents.filter((a) => !a.isLead).map((a) => a.name));
    const ids = new Set(plan.tasks.map((t) => t.id));
    run.plan = {
      summary: plan.summary || '',
      tasks: plan.tasks.map((t) => ({ ...t, agent: names.has(t.agent) ? t.agent : [...names][0], dependsOn: t.dependsOn.filter((d) => ids.has(d) && d !== t.id) })),
    };
    changed(run);
    return summarize(run);
  },
  async approve(id) {
    const run = getRun(id);
    if (run.status !== 'awaiting_approval') throw new Error('Nothing to approve.');
    run.status = 'running';
    run.worktree = { dir: '(simulated worktree)', branch: `meshh/${run.id}`, base: 'demo' };
    for (const t of run.plan.tasks) run.tasks[t.id] = { status: 'pending', logs: [], costUsd: 0, filesTouched: [], result: '', error: null, sessionId: null };
    log(run, 'lead', { kind: 'phase', text: 'Creating an isolated git worktree for this run' });
    changed(run);
    execute(run);
    return summarize(run);
  },
  async stopRun(id) {
    const run = getRun(id);
    if (['planning', 'running', 'summarizing', 'awaiting_approval'].includes(run.status)) run.status = 'stopped';
    for (const [k, t] of state.timers) if (k.startsWith(`${id}:`)) t.cancelled = true;
    for (const st of Object.values(run.tasks)) if (st.status === 'pending') st.status = 'stopped';
    if (run.lead.status === 'running') run.lead.status = 'stopped';
    changed(run);
    return summarize(run);
  },
  async stopTask(id, taskId) {
    const run = getRun(id);
    const t = state.timers.get(`${id}:${taskId}`);
    if (t && run.tasks[taskId]?.status === 'running') t.cancelled = true;
    else if (run.tasks[taskId]?.status === 'pending') {
      run.tasks[taskId].status = 'stopped';
      changed(run);
    }
  },
  async message(id, taskId, text) {
    const run = getRun(id);
    const st = run.tasks[taskId];
    const t = run.plan?.tasks.find((x) => x.id === taskId);
    if (!st || !t) throw new Error('Task not found');
    if (st.status === 'running') throw new Error('This agent is still working. Wait for it to finish, or stop it first.');
    const agent = state.agents.find((a) => a.name === t.agent);
    st.status = 'running';
    log(run, taskId, { kind: 'you', text });
    changed(run);
    (async () => {
      await jitter(500, 900);
      log(run, taskId, { kind: 'text', text: `Got it. Applying your note: “${text.slice(0, 120)}”.` });
      await jitter(700, 1200);
      const path = `${agent?.scope?.[0] || 'notes'}/followup-${t.agent}.md`;
      log(run, taskId, { kind: 'tool', name: 'Write', target: path });
      run.files[path] = { content: `# Follow-up for ${t.agent}\n\n${text}`, agents: [t.agent] };
      st.filesTouched = [...new Set([...(st.filesTouched || []), path])];
      await jitter(400, 700);
      log(run, taskId, { kind: 'text', text: `Done. I recorded the change in \`${path}\`.` });
      account(st);
      st.status = 'done';
      changed(run);
    })();
    return summarize(run);
  },
  async diff(id) {
    const run = getRun(id);
    if (!run.worktree) return [];
    return Object.entries(run.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, f]) => ({
        path,
        status: 'added',
        additions: f.content.split('\n').length,
        deletions: 0,
        binary: false,
        patch: patchFor(path, f.content),
        agents: f.agents,
      }));
  },
  async apply(id, { files, mode }) {
    const run = getRun(id);
    if (!files?.length) throw new Error('Select at least one file.');
    run.applied = { mode: mode === 'commit' ? 'commit' : 'working', files, at: new Date().toISOString() };
    run.status = 'applied';
    run.worktree = null;
    changed(run);
    return summarize(run);
  },
  async discard(id) {
    await this.stopRun(id);
    const run = getRun(id);
    run.worktree = null;
    run.status = 'discarded';
    changed(run);
    return summarize(run);
  },
  async deleteRun(id) {
    for (const [k, t] of state.timers) if (k.startsWith(`${id}:`)) t.cancelled = true;
    state.runs.delete(id);
    emit({ type: 'removed', id });
  },
};
