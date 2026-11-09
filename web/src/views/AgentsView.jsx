import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AgentMark, Empty } from '../components/ui.jsx';

const MODELS = [
  { v: 'inherit', l: 'Claude Code default' },
  { v: 'opus', l: 'Opus' },
  { v: 'sonnet', l: 'Sonnet' },
  { v: 'haiku', l: 'Haiku (fast, light)' },
  { v: 'fable', l: 'Fable' },
];

function blank() {
  return {
    name: '',
    role: '',
    icon: '●',
    color: '#64748b',
    description: '',
    model: 'inherit',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    scope: [],
    body: 'You are a helpful specialist on this team.\n- Follow the project guidelines.\n- Finish with a short summary of what you changed.',
    skills: [],
    isLead: false,
  };
}

function Editor({ initial, isNew, meta, onSaved, onDeleted, onError }) {
  const [a, setA] = useState(initial);
  const [scopeText, setScopeText] = useState((initial.scope || []).join(', '));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setA(initial);
    setScopeText((initial.scope || []).join(', '));
  }, [initial]);

  const set = (patch) => setA((x) => ({ ...x, ...patch }));
  const tools = a.tools || meta.toolGroups.flatMap((g) => g.tools);
  const groupOn = (g) => g.tools.some((t) => tools.includes(t));
  const toggleGroup = (g) => {
    const on = groupOn(g);
    const next = on ? tools.filter((t) => !g.tools.includes(t)) : [...new Set([...tools, ...g.tools])];
    set({ tools: next.filter((t) => t !== 'Skill') });
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const scope = scopeText
        .split(',')
        .map((s) => s.trim().replace(/^[./\\]+|[/\\]+$/g, ''))
        .filter(Boolean);
      const saved = await api.saveAgent({ ...a, scope }, isNew ? undefined : initial.name);
      onSaved(saved.name);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirm(`Delete the ${initial.name} agent? This removes .claude/agents/${initial.name}.md.`)) return;
    try {
      await api.deleteAgent(initial.name);
      onDeleted();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <form className="editor" onSubmit={save}>
      <div className="editor-head" style={{ '--c': a.color }}>
        <AgentMark agent={a} name={a.name} size={44} />
        <div className="editor-title">
          <h2>{isNew ? 'New agent' : a.name}</h2>
          <p>{isNew ? 'Saved as a normal Claude Code agent file in .claude/agents/.' : `.claude/agents/${initial.name}.md`}</p>
        </div>
        <div className="editor-actions">
          {!isNew && (
            <button type="button" className="btn-quiet danger" onClick={del}>
              Delete
            </button>
          )}
          <button className="btn" disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create agent' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={a.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="api-dev" required />
          <small>Lowercase letters, numbers and dashes. Used in plans and logs.</small>
        </label>
        <div className="field-row">
          <label className="field field-icon">
            <span>Icon</span>
            <input value={a.icon} maxLength={2} onChange={(e) => set({ icon: e.target.value })} aria-label="Icon (one character)" />
          </label>
          <label className="field field-color">
            <span>Color</span>
            <input type="color" value={a.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
          <label className="field">
            <span>Model</span>
            <select value={a.model || 'inherit'} onChange={(e) => set({ model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field field-wide">
          <span>What it does</span>
          <input value={a.description} onChange={(e) => set({ description: e.target.value })} placeholder="Builds REST endpoints and database queries" required />
          <small>The lead reads this to decide which tasks to give this agent.</small>
        </label>

        <div className="field field-wide">
          <span>Allowed to</span>
          <div className="toggles">
            {meta.toolGroups.map((g) => {
              const on = groupOn(g);
              return (
                <button type="button" key={g.id} className={`toggle ${on ? 'on' : ''}`} onClick={() => toggleGroup(g)} aria-pressed={on} title={g.hint}>
                  <span className="toggle-mark" aria-hidden="true">
                    {on ? '✓' : '✗'}
                  </span>
                  {g.label}
                </button>
              );
            })}
          </div>
          <small>Skills are set per agent on the Skills &amp; access tab.</small>
        </div>

        <label className="field field-wide">
          <span>Folder scope</span>
          <input value={scopeText} onChange={(e) => setScopeText(e.target.value)} placeholder="server, docs  (empty = anywhere in the project)" />
          <small>File edits outside these folders are blocked. Commands it runs are not limited by this.</small>
        </label>

        <label className="check field-wide">
          <input type="checkbox" checked={!!a.isLead} onChange={(e) => set({ isLead: e.target.checked })} />
          <span>
            This is the lead. It plans every run and writes the summary, and only reads files.
          </span>
        </label>

        <label className="field field-wide">
          <span>Instructions</span>
          <textarea value={a.body} onChange={(e) => set({ body: e.target.value })} rows={12} className="mono" />
          <small>Becomes the agent’s system prompt. Project-wide rules belong in Guidelines instead.</small>
        </label>
      </div>
    </form>
  );
}

export default function AgentsView({ agents, meta, reload, onError }) {
  const [selected, setSelected] = useState(agents[0]?.name || null);
  const [creating, setCreating] = useState(null); // null | 'gallery' | agent draft
  const current = agents.find((a) => a.name === selected);

  useEffect(() => {
    if (!selected && agents.length && !creating) setSelected(agents[0].name);
  }, [agents, selected, creating]);

  const addTemplate = async (t) => {
    try {
      const a = await api.addTemplate(t.name);
      await reload();
      setCreating(null);
      setSelected(a.name);
    } catch (e) {
      onError(e.message);
    }
  };

  return (
    <div className="split">
      <aside className="list" aria-label="Agents">
        <button className={`list-add ${creating ? 'on' : ''}`} onClick={() => setCreating('gallery')}>
          Add agent
        </button>
        <ul>
          {agents.map((a) => (
            <li key={a.name}>
              <button
                className={`list-item ${!creating && selected === a.name ? 'on' : ''}`}
                onClick={() => {
                  setCreating(null);
                  setSelected(a.name);
                }}
                style={{ '--c': a.color }}
              >
                <AgentMark agent={a} />
                <span className="list-text">
                  <span className="list-name">
                    {a.name}
                    {a.isLead && <span className="lead-badge">lead</span>}
                  </span>
                  <span className="list-sub">{a.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="pane">
        {creating === 'gallery' ? (
          <div className="gallery">
            <h2>Add an agent</h2>
            <p className="pane-intro">Start from a role and adjust it, or write one from scratch.</p>
            <div className="gallery-grid">
              {meta.templates.map((t) => (
                <button key={t.name} className="tpl" style={{ '--c': t.color }} onClick={() => addTemplate(t)}>
                  <AgentMark agent={t} size={34} />
                  <span className="tpl-name">{t.role}</span>
                  <span className="tpl-desc">{t.description}</span>
                  <span className="tpl-tools">{t.tools.includes('Edit') ? 'Can edit files' : 'Read-only'}</span>
                </button>
              ))}
              <button className="tpl tpl-blank" onClick={() => setCreating(blank())}>
                <span className="tpl-name">From scratch</span>
                <span className="tpl-desc">An empty agent you define yourself.</span>
              </button>
            </div>
          </div>
        ) : creating ? (
          <Editor
            initial={creating}
            isNew
            meta={meta}
            onError={onError}
            onSaved={async (name) => {
              await reload();
              setCreating(null);
              setSelected(name);
            }}
          />
        ) : current ? (
          <Editor
            initial={current}
            meta={meta}
            onError={onError}
            onSaved={async (name) => {
              await reload();
              setSelected(name);
            }}
            onDeleted={async () => {
              await reload();
              setSelected(null);
            }}
          />
        ) : (
          <Empty title="No agents yet" action={<button className="btn" onClick={() => setCreating('gallery')}>Add agent</button>}>
            Agents are saved as Claude Code agent files, so they also work in plain Claude Code.
          </Empty>
        )}
      </section>
    </div>
  );
}
