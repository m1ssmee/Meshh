import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AgentMark, Empty } from '../components/ui.jsx';

function Socket({ on, color, label, onClick, disabled }) {
  return (
    <button
      className={`socket ${on ? 'on' : ''}`}
      style={{ '--c': color }}
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      <span className="socket-ring">
        <span className="socket-core">{on ? '✓' : '✗'}</span>
      </span>
    </button>
  );
}

function PatchBay({ agents, skills, meta, reloadAgents, onError }) {
  const [pending, setPending] = useState(null);
  const allSkillNames = skills.map((s) => s.name);
  const allTools = meta.toolGroups.flatMap((g) => g.tools);

  const skillsOf = (a) => (a.skills === null || a.skills === undefined ? allSkillNames : a.skills);
  const toolsOf = (a) => a.tools || allTools;

  const save = async (agent, patch) => {
    setPending(agent.name);
    try {
      await api.saveAgent({ ...agent, ...patch }, agent.name);
      await reloadAgents();
    } catch (e) {
      onError(e.message);
    } finally {
      setPending(null);
    }
  };

  const toggleSkill = (a, s) => {
    const cur = skillsOf(a);
    save(a, { skills: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  const toggleGroup = (a, g) => {
    const cur = toolsOf(a).filter((t) => t !== 'Skill');
    const on = g.tools.some((t) => cur.includes(t));
    save(a, { tools: on ? cur.filter((t) => !g.tools.includes(t)) : [...new Set([...cur, ...g.tools])] });
  };
  const skillRowAll = async (s) => {
    const everyone = agents.every((a) => skillsOf(a).includes(s));
    for (const a of agents) {
      const cur = skillsOf(a);
      const has = cur.includes(s);
      if (everyone && has) await save(a, { skills: cur.filter((x) => x !== s) });
      if (!everyone && !has) await save(a, { skills: [...cur, s] });
    }
  };
  const agentAllSkills = (a) => {
    const cur = skillsOf(a);
    save(a, { skills: cur.length === allSkillNames.length ? [] : [...allSkillNames] });
  };

  if (!agents.length) return <Empty title="No agents yet">Add agents first, then connect them to skills here.</Empty>;

  return (
    <div className="bay-wrap">
      <table className="bay">
        <caption className="sr-only">Which agent may use which skill and tool</caption>
        <thead>
          <tr>
            <th scope="col" className="bay-corner">
              <span>Click a dot to switch it. Click a name to switch the whole row or column.</span>
            </th>
            {agents.map((a) => (
              <th key={a.name} scope="col" className="bay-agent" style={{ '--c': a.color }}>
                <button className="bay-agent-btn" onClick={() => agentAllSkills(a)} title={`Give ${a.name} all skills, or none`} disabled={pending === a.name}>
                  <AgentMark agent={a} size={30} />
                  <span>{a.name}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="bay-section">
            <th scope="rowgroup" colSpan={agents.length + 1}>
              Skills
            </th>
          </tr>
          {skills.length === 0 && (
            <tr>
              <td colSpan={agents.length + 1} className="bay-none">
                No skills yet. Create one below.
              </td>
            </tr>
          )}
          {skills.map((s) => (
            <tr key={s.name}>
              <th scope="row" className="bay-row">
                <button className="bay-row-btn" onClick={() => skillRowAll(s.name)} title={s.description}>
                  <span className="bay-row-name">{s.name}</span>
                  <span className="bay-row-sub">{s.scope === 'personal' ? 'Personal skill' : s.description}</span>
                </button>
              </th>
              {agents.map((a) => {
                const on = skillsOf(a).includes(s.name);
                return (
                  <td key={a.name}>
                    <Socket
                      on={on}
                      color={a.color}
                      label={`${a.name} ${on ? 'can' : 'cannot'} use ${s.name}`}
                      onClick={() => toggleSkill(a, s.name)}
                      disabled={pending === a.name}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="bay-section">
            <th scope="rowgroup" colSpan={agents.length + 1}>
              Tools
            </th>
          </tr>
          {meta.toolGroups.map((g) => (
            <tr key={g.id}>
              <th scope="row" className="bay-row">
                <span className="bay-row-btn static">
                  <span className="bay-row-name">{g.label}</span>
                  <span className="bay-row-sub">{g.hint}</span>
                </span>
              </th>
              {agents.map((a) => {
                const on = g.tools.some((t) => toolsOf(a).includes(t));
                return (
                  <td key={a.name}>
                    <Socket
                      on={on}
                      color={a.color}
                      label={`${a.name}: ${g.label} ${on ? 'allowed' : 'blocked'}${a.isLead ? ' (the lead is always read-only while planning)' : ''}`}
                      onClick={() => toggleGroup(a, g)}
                      disabled={pending === a.name}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkillEditor({ skill, isNew, onSaved, onDeleted, onError }) {
  const [s, setS] = useState(skill);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(skill), [skill]);
  const readOnly = !isNew && !skill.editable;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await api.saveSkill(s, isNew ? undefined : skill.name);
      onSaved(saved.name);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const del = async () => {
    if (!confirm(`Delete the ${skill.name} skill?`)) return;
    try {
      await api.deleteSkill(skill.name);
      onDeleted();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <form className="editor" onSubmit={save}>
      <div className="editor-head">
        <div className="editor-title">
          <h2>{isNew ? 'New skill' : s.name}</h2>
          <p>
            {readOnly
              ? `Personal skill in ~/.claude/skills/${skill.dir}/. Edit it there; it’s shared by all your projects.`
              : `.claude/skills/${isNew ? s.name || 'name' : skill.dir}/SKILL.md`}
          </p>
        </div>
        {!readOnly && (
          <div className="editor-actions">
            {!isNew && (
              <button type="button" className="btn-quiet danger" onClick={del}>
                Delete
              </button>
            )}
            <button className="btn" disabled={saving}>
              {saving ? 'Saving…' : isNew ? 'Create skill' : 'Save changes'}
            </button>
          </div>
        )}
      </div>
      <div className="form-grid">
        <label className="field field-wide">
          <span>Name</span>
          <input
            value={s.name}
            disabled={readOnly}
            onChange={(e) => setS({ ...s, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            placeholder="api-design"
            required
          />
        </label>
        <label className="field field-wide">
          <span>When to use it</span>
          <input
            value={s.description}
            disabled={readOnly}
            onChange={(e) => setS({ ...s, description: e.target.value })}
            placeholder="Conventions for REST endpoints. Use when adding or changing API routes."
            required
          />
          <small>Claude reads this to decide when the skill applies, so say what it covers and when to use it.</small>
        </label>
        <label className="field field-wide">
          <span>Instructions</span>
          <textarea className="mono" rows={14} value={s.body} disabled={readOnly} onChange={(e) => setS({ ...s, body: e.target.value })} />
        </label>
      </div>
    </form>
  );
}

export default function SkillsView({ agents, skills, meta, reloadAgents, reloadSkills, onError }) {
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const current = skills.find((s) => s.name === selected);

  return (
    <div className="skills-page">
      <section className="bay-section-wrap" aria-labelledby="bay-title">
        <div className="section-head">
          <h2 id="bay-title">Who can use what</h2>
          <p>
            A filled dot means the agent may use that skill or tool. Skill access is enforced with Claude Code permission rules; tools are saved in each agent’s file.
          </p>
        </div>
        <PatchBay agents={agents} skills={skills} meta={meta} reloadAgents={reloadAgents} onError={onError} />
      </section>

      <section className="split split-flat" aria-labelledby="lib-title">
        <aside className="list">
          <h2 id="lib-title" className="list-title">
            Skill library
          </h2>
          <button
            className={`list-add ${creating ? 'on' : ''}`}
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
          >
            New skill
          </button>
          <ul>
            {skills.map((s) => (
              <li key={s.name}>
                <button
                  className={`list-item ${!creating && selected === s.name ? 'on' : ''}`}
                  onClick={() => {
                    setCreating(false);
                    setSelected(s.name);
                  }}
                >
                  <span className="list-text">
                    <span className="list-name">
                      {s.name}
                      {s.scope === 'personal' && <span className="lead-badge">personal</span>}
                    </span>
                    <span className="list-sub">{s.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="pane">
          {creating ? (
            <SkillEditor
              skill={{ name: '', description: '', body: '# Skill name\n\nWrite the steps, rules and examples Claude should follow.\n', editable: true }}
              isNew
              onError={onError}
              onSaved={async (name) => {
                await reloadSkills();
                setCreating(false);
                setSelected(name);
              }}
            />
          ) : current ? (
            <SkillEditor
              skill={current}
              onError={onError}
              onSaved={async (name) => {
                await reloadSkills();
                await reloadAgents();
                setSelected(name);
              }}
              onDeleted={async () => {
                await reloadSkills();
                await reloadAgents();
                setSelected(null);
              }}
            />
          ) : (
            <Empty title="Skills are reusable know-how" action={<button className="btn" onClick={() => setCreating(true)}>New skill</button>}>
              A skill is a folder with a SKILL.md file: conventions, checklists or steps Claude loads when they’re relevant. Pick one on the left to edit it.
            </Empty>
          )}
        </div>
      </section>
    </div>
  );
}
