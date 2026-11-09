import React, { useEffect, useState } from 'react';
import { AgentMark } from './ui.jsx';

export default function PlanEditor({ plan, agents, onApprove, onCancel, busy }) {
  const workers = agents.filter((a) => !a.isLead);
  const [draft, setDraft] = useState(plan);
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => setDraft(plan), [plan]);

  const update = (i, patch) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const remove = (i) =>
    setDraft((d) => {
      const id = d.tasks[i].id;
      return { ...d, tasks: d.tasks.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((x) => x !== id) })) };
    });
  const add = () =>
    setDraft((d) => {
      let n = d.tasks.length + 1;
      while (d.tasks.some((t) => t.id === `t${n}`)) n++;
      const id = `t${n}`;
      setOpen((o) => new Set(o).add(id));
      return { ...d, tasks: [...d.tasks, { id, title: '', agent: workers[0]?.name || '', brief: '', dependsOn: [] }] };
    });
  const toggleDep = (i, id) =>
    update(i, { dependsOn: draft.tasks[i].dependsOn.includes(id) ? draft.tasks[i].dependsOn.filter((x) => x !== id) : [...draft.tasks[i].dependsOn, id] });
  const toggleOpen = (id) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const valid = draft.tasks.length > 0 && draft.tasks.every((t) => t.title.trim() && t.agent);

  return (
    <div className="plan">
      <div className="plan-head">
        <div>
          <h2>Review the plan</h2>
          {draft.summary && <p className="plan-summary">{draft.summary}</p>}
        </div>
        <div className="plan-actions">
          <button className="btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel run
          </button>
          <button className="btn" onClick={() => onApprove(draft)} disabled={busy || !valid}>
            Approve and start
          </button>
        </div>
      </div>
      <ol className="plan-list">
        {draft.tasks.map((t, i) => {
          const agent = agents.find((a) => a.name === t.agent);
          const isOpen = open.has(t.id);
          return (
            <li key={t.id} className="plan-task" style={{ '--c': agent?.color || '#8a94a3' }}>
              <div className="plan-row">
                <span className="plan-id">{t.id}</span>
                <AgentMark agent={agent} name={t.agent} size={24} />
                <select value={t.agent} onChange={(e) => update(i, { agent: e.target.value })} aria-label="Agent">
                  {workers.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <input className="plan-title" value={t.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Task title" aria-label="Task title" />
                <button className="btn-quiet" onClick={() => toggleOpen(t.id)} aria-expanded={isOpen}>
                  {isOpen ? 'Hide brief' : 'Edit brief'}
                </button>
                <button className="btn-quiet danger" onClick={() => remove(i)} aria-label={`Remove ${t.id}`}>
                  Remove
                </button>
              </div>
              {draft.tasks.length > 1 && (
                <div className="plan-deps">
                  <span>Waits for</span>
                  {draft.tasks
                    .filter((x) => x.id !== t.id)
                    .map((x) => (
                      <button
                        key={x.id}
                        className={`dep ${t.dependsOn.includes(x.id) ? 'on' : ''}`}
                        onClick={() => toggleDep(i, x.id)}
                        aria-pressed={t.dependsOn.includes(x.id)}
                        title={x.title}
                      >
                        {x.id}
                      </button>
                    ))}
                  {t.dependsOn.length === 0 && <em>nothing, starts right away</em>}
                </div>
              )}
              {isOpen && (
                <textarea
                  className="plan-brief"
                  value={t.brief}
                  onChange={(e) => update(i, { brief: e.target.value })}
                  rows={5}
                  placeholder="Everything the agent needs to know for this task"
                  aria-label="Brief"
                />
              )}
              {!isOpen && t.brief && <p className="plan-brief-preview">{t.brief}</p>}
            </li>
          );
        })}
      </ol>
      <button className="btn-quiet add-task" onClick={add}>
        Add a task
      </button>
    </div>
  );
}
