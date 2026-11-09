// Everything Meshh stores lives in normal Claude Code files, so a project set up
// here also works in plain Claude Code:
//   .claude/agents/<name>.md        agent definitions (name, description, tools, model + prompt)
//   .claude/skills/<name>/SKILL.md  project skills
//   CLAUDE.md                       project guidelines every agent reads
//   .meshh/config.json          Meshh-only settings (lead, folder scopes, skill access, colors)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter, toList } from './frontmatter.js';
import { TEMPLATES } from './templates.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.name = path.basename(this.root);
  }

  p(...parts) {
    return path.join(this.root, ...parts);
  }

  get agentsDir() {
    return this.p('.claude', 'agents');
  }
  get skillsDir() {
    return this.p('.claude', 'skills');
  }
  get personalSkillsDir() {
    return path.join(os.homedir(), '.claude', 'skills');
  }
  get deckDir() {
    return this.p('.meshh');
  }
  get configPath() {
    return this.p('.meshh', 'config.json');
  }
  get guidelinesPath() {
    return this.p('CLAUDE.md');
  }

  // ---------- config ----------
  defaultConfig() {
    return { lead: 'lead', maxParallel: 3, setupCommand: '', finalSummary: true, agents: {} };
  }

  async readConfig() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.configPath, 'utf8'));
      return { ...this.defaultConfig(), ...raw, agents: raw.agents || {} };
    } catch {
      return this.defaultConfig();
    }
  }

  async writeConfig(cfg) {
    await fsp.mkdir(this.deckDir, { recursive: true });
    const gi = path.join(this.deckDir, '.gitignore');
    if (!fs.existsSync(gi)) await fsp.writeFile(gi, 'runs/\n');
    await fsp.writeFile(this.configPath, JSON.stringify(cfg, null, 2) + '\n');
    return cfg;
  }

  async updateConfig(patch) {
    const cfg = await this.readConfig();
    const next = { ...cfg, ...patch, agents: { ...cfg.agents, ...(patch.agents || {}) } };
    return this.writeConfig(next);
  }

  // ---------- agents ----------
  async listAgents() {
    const cfg = await this.readConfig();
    let files = [];
    try {
      files = (await fsp.readdir(this.agentsDir)).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    const agents = [];
    for (const f of files.sort()) {
      const text = await fsp.readFile(path.join(this.agentsDir, f), 'utf8');
      const { data, body } = parseFrontmatter(text);
      const name = String(data.name || f.replace(/\.md$/, ''));
      const meta = cfg.agents[name] || {};
      agents.push({
        name,
        file: path.join('.claude', 'agents', f),
        description: data.description || '',
        tools: toList(data.tools), // null = all tools
        disallowedTools: toList(data.disallowedTools),
        model: data.model || 'inherit',
        body,
        extra: Object.fromEntries(
          Object.entries(data).filter(([k]) => !['name', 'description', 'tools', 'disallowedTools', 'model'].includes(k)),
        ),
        icon: meta.icon || '●',
        color: meta.color || '#94a3b8',
        role: meta.role || name,
        scope: meta.scope || [],
        skills: meta.skills ?? null, // null = all skills allowed
        isLead: cfg.lead === name,
      });
    }
    return agents.sort((a, b) => (a.isLead === b.isLead ? a.name.localeCompare(b.name) : a.isLead ? -1 : 1));
  }

  async getAgent(name) {
    return (await this.listAgents()).find((a) => a.name === name) || null;
  }

  async saveAgent(agent, previousName) {
    if (!validName(agent.name)) throw new Error('Agent name must be lowercase letters, numbers and dashes.');
    await fsp.mkdir(this.agentsDir, { recursive: true });
    const data = {
      ...(agent.extra || {}),
      name: agent.name,
      description: agent.description || `${agent.name} agent`,
      tools: agent.tools && agent.tools.length ? agent.tools.join(', ') : undefined,
      disallowedTools: agent.disallowedTools && agent.disallowedTools.length ? agent.disallowedTools.join(', ') : undefined,
      model: agent.model && agent.model !== 'inherit' ? agent.model : undefined,
    };
    await fsp.writeFile(path.join(this.agentsDir, `${agent.name}.md`), stringifyFrontmatter(data, agent.body));
    if (previousName && previousName !== agent.name) {
      await fsp.rm(path.join(this.agentsDir, `${previousName}.md`), { force: true });
    }
    const cfg = await this.readConfig();
    const meta = { ...(cfg.agents[previousName || agent.name] || {}) };
    if (previousName && previousName !== agent.name) delete cfg.agents[previousName];
    cfg.agents[agent.name] = {
      ...meta,
      icon: agent.icon ?? meta.icon,
      color: agent.color ?? meta.color,
      role: agent.role ?? meta.role,
      scope: agent.scope ?? meta.scope ?? [],
      skills: agent.skills === undefined ? meta.skills ?? null : agent.skills,
    };
    if (agent.isLead) cfg.lead = agent.name;
    else if (previousName && cfg.lead === previousName) cfg.lead = agent.name;
    await this.writeConfig(cfg);
    return this.getAgent(agent.name);
  }

  async deleteAgent(name) {
    if (!validName(name)) throw new Error('Bad agent name');
    await fsp.rm(path.join(this.agentsDir, `${name}.md`), { force: true });
    const cfg = await this.readConfig();
    delete cfg.agents[name];
    await this.writeConfig(cfg);
  }

  async addTemplate(templateName, nameOverride) {
    const t = TEMPLATES.find((x) => x.name === templateName);
    if (!t) throw new Error(`Unknown template: ${templateName}`);
    let name = nameOverride || t.name;
    const existing = new Set((await this.listAgents()).map((a) => a.name));
    let i = 2;
    while (existing.has(name)) name = `${nameOverride || t.name}-${i++}`;
    return this.saveAgent({
      name,
      description: t.description,
      tools: t.tools,
      model: t.model,
      body: t.body,
      icon: t.icon,
      color: t.color,
      role: t.role,
      scope: t.scope,
      skills: [],
      isLead: t.name === 'lead' && !existing.has('lead') ? true : undefined,
    });
  }

  // ---------- skills ----------
  async listSkills() {
    const out = [];
    for (const [dir, scope] of [
      [this.skillsDir, 'project'],
      [this.personalSkillsDir, 'personal'],
    ]) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(dir, e.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        const { data, body } = parseFrontmatter(await fsp.readFile(file, 'utf8'));
        const name = String(data.name || e.name);
        if (out.some((s) => s.name === name)) continue; // personal skills override project ones with the same name in Claude Code; keep the first listing
        out.push({
          name,
          dir: e.name,
          scope,
          description: data.description || '',
          body,
          extra: Object.fromEntries(Object.entries(data).filter(([k]) => !['name', 'description'].includes(k))),
          editable: scope === 'project',
        });
      }
    }
    return out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1));
  }

  async saveSkill(skill, previousName) {
    if (!validName(skill.name)) throw new Error('Skill name must be lowercase letters, numbers and dashes.');
    const dir = path.join(this.skillsDir, skill.name);
    if (previousName && previousName !== skill.name) {
      const prev = path.join(this.skillsDir, previousName);
      if (fs.existsSync(prev)) await fsp.rename(prev, dir);
      // keep agent access lists in sync with the new name
      const cfg = await this.readConfig();
      for (const meta of Object.values(cfg.agents)) {
        if (Array.isArray(meta.skills)) meta.skills = meta.skills.map((s) => (s === previousName ? skill.name : s));
      }
      await this.writeConfig(cfg);
    }
    await fsp.mkdir(dir, { recursive: true });
    const data = { ...(skill.extra || {}), name: skill.name, description: skill.description || skill.name };
    await fsp.writeFile(path.join(dir, 'SKILL.md'), stringifyFrontmatter(data, skill.body));
    return (await this.listSkills()).find((s) => s.name === skill.name);
  }

  async deleteSkill(name) {
    if (!validName(name)) throw new Error('Bad skill name');
    await fsp.rm(path.join(this.skillsDir, name), { recursive: true, force: true });
    const cfg = await this.readConfig();
    for (const meta of Object.values(cfg.agents)) {
      if (Array.isArray(meta.skills)) meta.skills = meta.skills.filter((s) => s !== name);
    }
    await this.writeConfig(cfg);
  }

  // ---------- guidelines ----------
  async readGuidelines() {
    try {
      return await fsp.readFile(this.guidelinesPath, 'utf8');
    } catch {
      return '';
    }
  }

  async writeGuidelines(text) {
    await fsp.writeFile(this.guidelinesPath, text.endsWith('\n') ? text : text + '\n');
  }
}
