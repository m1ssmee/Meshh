// The orchestration engine.
//
//   1. plan      the lead agent reads the repo (read-only) and returns a JSON plan
//   2. approve   you review / edit the plan in the UI
//   3. execute   tasks run as separate `claude -p` processes in one git worktree,
//                in dependency order, up to `maxParallel` at a time
//   4. summary   the lead summarises what the team did (optional)
//   5. review    you inspect the diff and apply it to your project, or discard it
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';
import { runClaude } from './claude.js';
import * as G from './git.js';
import { DEFAULT_LEAD_BODY } from './templates.js';

const MAX_LOGS = 600;
const READ_ONLY = ['Read', 'Grep', 'Glob'];

function newId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(
    d.getHours(),
  ).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function planSchema(agentNames) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences: the approach.' },
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id like t1, t2' },
            title: { type: 'string', description: 'Short imperative title' },
            agent: { type: 'string', enum: agentNames },
            brief: { type: 'string', description: 'Complete instructions for the agent, with all needed context' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title', 'agent', 'brief', 'dependsOn'],
        },
      },
    },
    required: ['summary', 'tasks'],
  };
}

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export class Runner extends EventEmitter {
  constructor(project, { demo = false } = {}) {
    super();
    this.project = project;
    this.demo = demo;
    this.runs = new Map(); // id -> run
    this.procs = new Map(); // `${runId}:${taskId}` -> { stop }
    this.saveTimers = new Map();
    this.overlayLocks = new Map();
  }

  get runsDir() {
    return path.join(this.project.deckDir, 'runs');
  }

  // ---------- persistence ----------
  async load() {
    let files = [];
    try {
      files = (await fsp.readdir(this.runsDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const run = JSON.parse(await fsp.readFile(path.join(this.runsDir, f), 'utf8'));
        if (['planning', 'running', 'summarizing'].includes(run.status)) {
          run.status = 'interrupted';
          run.error = 'Meshh was closed while this run was in progress.';
          for (const t of Object.values(run.tasks || {})) if (t.status === 'running') t.status = 'stopped';
        }
        this.runs.set(run.id, run);
      } catch {}
    }
  }

  save(run, immediate = false) {
    const write = async () => {
      this.saveTimers.delete(run.id);
      await fsp.mkdir(this.runsDir, { recursive: true });
      await fsp.writeFile(path.join(this.runsDir, `${run.id}.json`), JSON.stringify(run));
    };
    clearTimeout(this.saveTimers.get(run.id));
    if (immediate) return write();
    this.saveTimers.set(run.id, setTimeout(write, 400));
  }

  // Lightweight version for lists and broadcasts (no logs).
  summary(run) {
    const tasks = {};
    for (const [id, t] of Object.entries(run.tasks)) {
      const { logs, ...rest } = t;
      tasks[id] = { ...rest, logCount: logs.length };
    }
    const { logs, ...lead } = run.lead;
    return { ...run, tasks, lead: { ...lead, logCount: logs.length } };
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.summary(r));
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  changed(run) {
    this.recomputeTotals(run);
    this.save(run);
    this.emit('run', this.summary(run));
  }

  log(run, taskId, entry) {
    const e = { t: Date.now(), ...entry };
    const holder = taskId === 'lead' ? run.lead : run.tasks[taskId];
    holder.logs.push(e);
    if (holder.logs.length > MAX_LOGS) holder.logs.splice(0, holder.logs.length - MAX_LOGS);
    this.emit('log', { runId: run.id, taskId, entry: e });
    this.save(run);
  }

  recomputeTotals(run) {
    let cost = 0,
      input = 0,
      output = 0;
    for (const h of [run.lead, ...Object.values(run.tasks)]) {
      cost += h.costUsd || 0;
      input += h.inputTokens || 0;
      output += h.outputTokens || 0;
    }
    run.totals = { costUsd: cost, inputTokens: input, outputTokens: output };
  }

  account(holder, res) {
    holder.costUsd = (holder.costUsd || 0) + (res.costUsd || 0);
    const u = res.usage || {};
    holder.inputTokens = (holder.inputTokens || 0) + (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    holder.outputTokens = (holder.outputTokens || 0) + (u.output_tokens || 0);
  }

  // ---------- building claude args for one agent ----------
  async agentArgs(run, agent, { readOnly = false } = {}) {
    const skills = await this.project.listSkills();
    const allSkillNames = skills.map((s) => s.name);
    const allowedSkills = agent.skills === null || agent.skills === undefined ? allSkillNames : agent.skills.filter((s) => allSkillNames.includes(s));
    const blockedSkills = allSkillNames.filter((s) => !allowedSkills.includes(s));

    let tools = readOnly ? [...READ_ONLY] : agent.tools ? [...agent.tools] : null;
    if (tools && allowedSkills.length && !tools.includes('Skill')) tools.push('Skill');

    const def = {
      description: agent.description || agent.name,
      prompt: agent.body || (agent.isLead ? DEFAULT_LEAD_BODY : `You are the ${agent.name} agent.`),
    };
    if (tools) def.tools = tools;
    if (agent.model && agent.model !== 'inherit') def.model = agent.model;
    if (agent.disallowedTools?.length) def.disallowedTools = agent.disallowedTools;

    const dir = path.join(this.runsDir, run.id);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `agent-${agent.name}${readOnly ? '-ro' : ''}.json`);
    await fsp.writeFile(file, JSON.stringify({ [agent.name]: def }, null, 2));

    const has = (t) => !tools || tools.includes(t);
    const allow = [];
    if (!readOnly) {
      if (has('Edit') || has('Write') || has('NotebookEdit')) {
        const scope = (agent.scope || []).map((s) => s.replace(/^[./\\]+|[/\\]+$/g, '')).filter(Boolean);
        if (scope.length) for (const s of scope) allow.push(`Edit(./${s}/**)`);
        else allow.push('Edit(./**)');
      }
      if (has('Bash')) allow.push('Bash');
      if (has('WebFetch')) allow.push('WebFetch');
      if (has('WebSearch')) allow.push('WebSearch');
    }
    for (const s of allowedSkills) allow.push(`Skill(${s})`);
    const deny = blockedSkills.map((s) => `Skill(${s})`);

    const args = ['--agents', file, '--agent', agent.name, '--permission-prompts', 'none'];
    if (allow.length) args.push('--allowedTools', ...allow);
    if (deny.length) args.push('--disallowedTools', ...deny);
    return args;
  }

  async leadAgent() {
    const cfg = await this.project.readConfig();
    const agents = await this.project.listAgents();
    return (
      agents.find((a) => a.name === cfg.lead) || {
        name: 'lead',
        description: 'Team lead',
        body: DEFAULT_LEAD_BODY,
        tools: READ_ONLY,
        model: 'inherit',
        scope: [],
        skills: null,
        isLead: true,
      }
    );
  }

  // ---------- 1. plan ----------
  async create(task) {
    if (!task || !task.trim()) throw new Error('Describe what you want the team to do.');
    const st = await G.status(this.project.root);
    if (!st.isRepo || !st.hasCommits) throw new Error('This project needs git with at least one commit. Use “Set up git” first.');
    const agents = (await this.project.listAgents()).filter((a) => !a.isLead);
    if (!agents.length) throw new Error('Add at least one agent besides the lead before starting a run.');

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
      baseBranch: st.branch,
      dirtyAtStart: st.dirty,
      totals: {},
      applied: null,
    };
    this.runs.set(run.id, run);
    this.changed(run);
    this.plan(run, agents).catch((err) => this.fail(run, err));
    return this.summary(run);
  }

  async plan(run, agents) {
    const lead = await this.leadAgent();
    const cfg = await this.project.readConfig();
    const team = agents
      .map((a) => {
        const scope = a.scope?.length ? `edits only in: ${a.scope.join(', ')}` : 'can edit anywhere';
        const tools = a.tools ? a.tools.join(', ') : 'all tools';
        return `- ${a.name}: ${a.description} (${scope}; tools: ${tools})`;
      })
      .join('\n');
    const prompt = `Plan the work for your team. Do not write or change any files.

GOAL
${run.task}

TEAM
${team}

INSTRUCTIONS
- Look at the repository first so the plan fits the real code.
- Create between 1 and 8 tasks. Assign each task to exactly one agent from the team.
- Up to ${cfg.maxParallel} tasks run at the same time. Tasks that can run in parallel must not edit the same files.
- "dependsOn" lists the ids of tasks that must finish first (their results are passed on).
- Write each "brief" as complete instructions: the agent sees only the brief, the goal and the results of the tasks it depends on.
- Respond with the plan as JSON matching the provided schema.`;

    const args = [...(await this.agentArgs(run, lead, { readOnly: true })), '--json-schema', JSON.stringify(planSchema(agents.map((a) => a.name)))];
    this.log(run, 'lead', { kind: 'phase', text: 'Planning' });
    const proc = runClaude({
      cwd: this.project.root,
      prompt,
      args,
      demo: this.demo,
      onLog: (e) => this.log(run, 'lead', e),
    });
    this.procs.set(`${run.id}:lead`, proc);
    const res = await proc.done;
    this.procs.delete(`${run.id}:lead`);
    this.account(run.lead, res);
    run.lead.sessionId = res.sessionId;

    if (res.stopped) return this.stopRun(run.id);
    let plan = res.structured || extractJson(res.text);
    if (!res.ok && !plan) throw new Error(res.error || 'The lead could not create a plan.');
    plan = this.normalizePlan(plan, agents);
    if (!plan.tasks.length) throw new Error('The lead returned an empty plan. Try describing the goal in more detail.');

    run.plan = plan;
    run.lead.status = 'done';
    run.status = 'awaiting_approval';
    this.log(run, 'lead', { kind: 'phase', text: `Plan ready: ${plan.tasks.length} task(s)` });
    this.changed(run);
  }

  normalizePlan(plan, agents) {
    const names = new Set(agents.map((a) => a.name));
    const tasks = (plan?.tasks || []).filter((t) => t && t.title).slice(0, 12);
    const ids = new Set();
    const out = tasks.map((t, i) => {
      let id = String(t.id || `t${i + 1}`).replace(/[^\w-]/g, '') || `t${i + 1}`;
      while (ids.has(id)) id += 'x';
      ids.add(id);
      return {
        id,
        title: String(t.title).slice(0, 200),
        agent: names.has(t.agent) ? t.agent : agents[0].name,
        brief: String(t.brief || t.title),
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      };
    });
    for (const t of out) t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);
    return { summary: String(plan?.summary || ''), tasks: out };
  }

  // ---------- 2. approve ----------
  async updatePlan(id, plan) {
    const run = this.get(id);
    if (!run || run.status !== 'awaiting_approval') throw new Error('The plan can only be edited before you approve it.');
    const agents = (await this.project.listAgents()).filter((a) => !a.isLead);
    run.plan = this.normalizePlan(plan, agents);
    if (this.hasCycle(run.plan.tasks)) throw new Error('The plan has a dependency loop.');
    this.changed(run);
    return this.summary(run);
  }

  hasCycle(tasks) {
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const state = {};
    const visit = (id) => {
      if (state[id] === 1) return true;
      if (state[id] === 2) return false;
      state[id] = 1;
      for (const d of byId[id]?.dependsOn || []) if (visit(d)) return true;
      state[id] = 2;
      return false;
    };
    return tasks.some((t) => visit(t.id));
  }

  async approve(id) {
    const run = this.get(id);
    if (!run || run.status !== 'awaiting_approval') throw new Error('Nothing to approve.');
    if (this.hasCycle(run.plan.tasks)) throw new Error('The plan has a dependency loop.');
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    for (const t of run.plan.tasks) {
      run.tasks[t.id] = { status: 'pending', logs: [], costUsd: 0, filesTouched: [], result: '', error: null, sessionId: null };
    }
    this.changed(run);
    this.execute(run).catch((err) => this.fail(run, err));
    return this.summary(run);
  }

  // ---------- 3. execute ----------
  async execute(run) {
    this.log(run, 'lead', { kind: 'phase', text: 'Creating an isolated git worktree for this run' });
    run.worktree = await G.createWorktree(this.project.root, run.id);
    this.changed(run);

    const cfg = await this.project.readConfig();
    if (cfg.setupCommand?.trim()) {
      this.log(run, 'lead', { kind: 'phase', text: `Setup: ${cfg.setupCommand}` });
      const ok = await this.shell(cfg.setupCommand, run.worktree.dir, (text) => this.log(run, 'lead', { kind: 'stdout', text }));
      if (!ok) this.log(run, 'lead', { kind: 'warn', text: 'Setup command failed; continuing anyway.' });
    }

    const maxParallel = Math.max(1, Number(cfg.maxParallel) || 3);
    const tasks = run.plan.tasks;

    await new Promise((resolveAll) => {
      const tick = () => {
        if (run.status !== 'running') return resolveAll();
        let running = 0;
        for (const t of tasks) {
          const st = run.tasks[t.id];
          if (st.status !== 'pending') {
            if (st.status === 'running') running++;
            continue;
          }
          const deps = t.dependsOn.map((d) => run.tasks[d]);
          if (deps.some((d) => ['failed', 'skipped', 'stopped'].includes(d.status))) {
            st.status = 'skipped';
            st.error = 'A task it depends on did not finish.';
            this.changed(run);
          }
        }
        const ready = tasks.filter((t) => run.tasks[t.id].status === 'pending' && t.dependsOn.every((d) => run.tasks[d].status === 'done'));
        for (const t of ready) {
          if (running >= maxParallel) break;
          running++;
          this.runTask(run, t)
            .catch((err) => {
              run.tasks[t.id].status = 'failed';
              run.tasks[t.id].error = err.message;
              this.changed(run);
            })
            .finally(tick);
        }
        const active = tasks.some((t) => ['running', 'pending'].includes(run.tasks[t.id].status));
        if (!active) resolveAll();
      };
      tick();
    });

    if (run.status !== 'running') return; // stopped
    const failed = tasks.filter((t) => run.tasks[t.id].status !== 'done').length;

    if (cfg.finalSummary) await this.finalSummary(run, failed);
    if (run.status !== 'running') return; // stopped during the summary
    run.status = 'review';
    run.finishedAt = new Date().toISOString();
    this.log(run, 'lead', { kind: 'phase', text: failed ? `Finished with ${failed} task(s) not done. Review the changes.` : 'All tasks done. Review the changes.' });
    this.changed(run);
  }

  shell(command, cwd, onLine) {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true });
      const out = (d) =>
        String(d)
          .split('\n')
          .filter((l) => l.trim())
          .forEach((l) => onLine(l.slice(0, 400)));
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async runTask(run, t) {
    const st = run.tasks[t.id];
    const agent = await this.project.getAgent(t.agent);
    if (!agent) throw new Error(`Agent “${t.agent}” no longer exists.`);
    st.status = 'running';
    st.startedAt = new Date().toISOString();
    this.changed(run);

    // Refresh guidelines + skills in the worktree (serialized: parallel tasks start together).
    const prev = this.overlayLocks.get(run.id) || Promise.resolve();
    const next = prev.then(() => G.syncOverlay(this.project.root, run.worktree.dir)).catch(() => {});
    this.overlayLocks.set(run.id, next);
    await next;
    const depResults = t.dependsOn
      .map((d) => {
        const dt = run.plan.tasks.find((x) => x.id === d);
        const r = run.tasks[d];
        const files = r.filesTouched?.length ? `\nFiles changed: ${r.filesTouched.join(', ')}` : '';
        return `### ${d} · ${dt.title} (by ${dt.agent})\n${(r.result || '').slice(0, 4000)}${files}`;
      })
      .join('\n\n');
    const others = run.plan.tasks
      .filter((x) => x.id !== t.id)
      .map((x) => `- ${x.id} (${x.agent}): ${x.title}`)
      .join('\n');
    const scope = agent.scope?.length ? `Only create or edit files inside: ${agent.scope.join(', ')}. Edits elsewhere will be blocked.` : '';

    const prompt = `You are the "${agent.name}" agent in a team coordinated by a lead.

OVERALL GOAL
${run.task}

YOUR TASK (${t.id}): ${t.title}
${t.brief}
${depResults ? `\nRESULTS FROM TASKS YOU DEPEND ON\n${depResults}\n` : ''}
OTHER TASKS IN THIS RUN (other agents may be working on them right now)
${others || '- none'}

RULES
- Stay within your task. Do not redo or undo other agents' work.
${scope ? `- ${scope}\n` : ''}- Do not commit, push, or create branches; the user reviews all changes at the end.
- You cannot ask questions. If something is unclear, make a sensible choice and say so.
- Finish with a short summary: what you did, files changed, and anything the next agents or the user must know.`;

    const args = await this.agentArgs(run, agent);
    const proc = runClaude({
      cwd: run.worktree.dir,
      prompt,
      args,
      demo: this.demo,
      onLog: (e) => {
        this.log(run, t.id, e);
        if (e.kind === 'init' && e.sessionId) st.sessionId = e.sessionId;
      },
    });
    this.procs.set(`${run.id}:${t.id}`, proc);
    const res = await proc.done;
    this.procs.delete(`${run.id}:${t.id}`);
    this.applyResult(run, st, res);
  }

  applyResult(run, st, res) {
    this.account(st, res);
    st.sessionId = res.sessionId || st.sessionId;
    st.filesTouched = [...new Set([...(st.filesTouched || []), ...res.filesTouched])];
    st.endedAt = new Date().toISOString();
    if (res.stopped) {
      st.status = 'stopped';
    } else if (res.ok) {
      st.status = 'done';
      st.result = res.text;
      st.error = null;
    } else {
      st.status = 'failed';
      st.result = res.text;
      st.error = res.error;
    }
    if (res.denials?.length) st.denials = (st.denials || 0) + res.denials.length;
    this.changed(run);
  }

  // ---------- 4. summary ----------
  async finalSummary(run, failed) {
    run.status = 'summarizing';
    run.lead.status = 'running';
    this.changed(run);
    const lead = await this.leadAgent();
    const report = run.plan.tasks
      .map((t) => {
        const r = run.tasks[t.id];
        return `### ${t.id} · ${t.title} (${t.agent}) — ${r.status}\n${(r.result || r.error || '').slice(0, 3000)}\nFiles: ${r.filesTouched.join(', ') || 'none'}`;
      })
      .join('\n\n');
    const prompt = `Your team has finished working on this goal:
${run.task}

Here are the task reports:
${report}

Write a short summary for the user (markdown, under 200 words): what was built or changed, anything that did not get done${
      failed ? ` (${failed} task(s) did not finish)` : ''
    }, and what they should check or run before accepting the changes. You may look at the files to verify. Do not change anything.`;
    this.log(run, 'lead', { kind: 'phase', text: 'Writing the summary' });
    const proc = runClaude({
      cwd: run.worktree.dir,
      prompt,
      args: await this.agentArgs(run, lead, { readOnly: true }),
      demo: this.demo,
      onLog: (e) => this.log(run, 'lead', e),
    });
    this.procs.set(`${run.id}:lead`, proc);
    const res = await proc.done;
    this.procs.delete(`${run.id}:lead`);
    this.account(run.lead, res);
    run.lead.status = res.ok ? 'done' : 'failed';
    run.summary = res.ok ? res.text : '';
    if (res.stopped) run.status = 'stopped';
    else run.status = 'running';
  }

  // ---------- follow-up messages ----------
  async message(id, taskId, text) {
    const run = this.get(id);
    if (!run) throw new Error('Run not found');
    const t = run.plan?.tasks.find((x) => x.id === taskId);
    const st = run.tasks[taskId];
    if (!t || !st) throw new Error('Task not found');
    if (st.status === 'running') throw new Error('This agent is still working. Wait for it to finish, or stop it first.');
    if (!st.sessionId) throw new Error('This agent has no session to continue yet.');
    if (!['review', 'running'].includes(run.status)) throw new Error('Follow-ups are possible while the run is active or in review.');
    if (!run.worktree || !fs.existsSync(run.worktree.dir)) throw new Error('The run’s worktree is gone.');
    const agent = await this.project.getAgent(t.agent);
    if (!agent) throw new Error('Agent not found');

    st.status = 'running';
    this.log(run, taskId, { kind: 'you', text });
    this.changed(run);
    const args = [...(await this.agentArgs(run, agent)), '--resume', st.sessionId];
    const proc = runClaude({
      cwd: run.worktree.dir,
      prompt: text,
      args,
      demo: this.demo,
      onLog: (e) => this.log(run, taskId, e),
    });
    this.procs.set(`${run.id}:${taskId}`, proc);
    proc.done.then((res) => {
      this.procs.delete(`${run.id}:${taskId}`);
      this.applyResult(run, st, res);
    });
    return this.summary(run);
  }

  // ---------- stop ----------
  stopTask(id, taskId) {
    const p = this.procs.get(`${id}:${taskId}`);
    if (p) p.stop();
    else {
      const run = this.get(id);
      const st = run?.tasks[taskId];
      if (st && st.status === 'pending') {
        st.status = 'stopped';
        this.changed(run);
      }
    }
  }

  async stopRun(id) {
    const run = this.get(id);
    if (!run) return;
    const wasActive = ['planning', 'running', 'summarizing', 'awaiting_approval'].includes(run.status);
    if (wasActive) run.status = 'stopped';
    for (const [key, p] of this.procs) if (key.startsWith(`${id}:`)) p.stop();
    for (const st of Object.values(run.tasks)) if (st.status === 'pending') st.status = 'stopped';
    if (run.lead.status === 'running') run.lead.status = 'stopped';
    this.changed(run);
    return this.summary(run);
  }

  fail(run, err) {
    run.status = 'failed';
    run.error = err.message || String(err);
    if (/authenticat|log ?in|oauth|api key/i.test(run.error)) {
      run.error += '\n\nClaude Code isn’t logged in. Open a terminal, run `claude`, log in, then start the run again.';
    }
    if (run.lead.status === 'running') run.lead.status = 'failed';
    this.log(run, 'lead', { kind: 'error', text: run.error });
    this.changed(run);
  }

  // ---------- 5. review ----------
  async diff(id) {
    const run = this.get(id);
    if (!run?.worktree) return [];
    const files = await G.diff(run.worktree);
    const by = {};
    for (const t of run.plan?.tasks || []) {
      for (const f of run.tasks[t.id]?.filesTouched || []) (by[f] ||= new Set()).add(t.agent);
    }
    return files.map((f) => ({ ...f, agents: [...(by[f.path] || [])] }));
  }

  async apply(id, { files, mode, message }) {
    const run = this.get(id);
    if (!run?.worktree) throw new Error('Nothing to apply.');
    if (!['review', 'stopped', 'failed', 'interrupted'].includes(run.status)) throw new Error('Wait for the run to finish first.');
    if (!files?.length) throw new Error('Select at least one file.');
    if (mode === 'commit') {
      await G.commitAndMerge(this.project.root, run.worktree, files, message || `Meshh: ${run.task.slice(0, 60)}`);
    } else {
      await G.applyToWorkingCopy(this.project.root, run.worktree, files);
    }
    run.applied = { mode: mode === 'commit' ? 'commit' : 'working', files, at: new Date().toISOString() };
    run.status = 'applied';
    await G.removeWorktree(this.project.root, run.worktree);
    run.worktree = null;
    this.changed(run);
    return this.summary(run);
  }

  async discard(id) {
    const run = this.get(id);
    if (!run) throw new Error('Run not found');
    await this.stopRun(id);
    await G.removeWorktree(this.project.root, run.worktree);
    run.worktree = null;
    run.status = 'discarded';
    this.changed(run);
    return this.summary(run);
  }

  async remove(id) {
    const run = this.get(id);
    if (!run) return;
    if (run.worktree) await this.discard(id);
    this.runs.delete(id);
    clearTimeout(this.saveTimers.get(id));
    await fsp.rm(path.join(this.runsDir, `${id}.json`), { force: true });
    await fsp.rm(path.join(this.runsDir, id), { recursive: true, force: true });
    this.emit('removed', id);
  }

  stopAll() {
    for (const p of this.procs.values()) p.stop();
  }
}
