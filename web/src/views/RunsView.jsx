import React, { useEffect, useMemo, useState } from 'react';
import { api, formatTokens, timeAgo } from '../api.js';
import PlanEditor from '../components/PlanEditor.jsx';
import ReviewPanel from '../components/ReviewPanel.jsx';
import Strip from '../components/Strip.jsx';
import { AgentMark, Led, STATUS_TEXT } from '../components/ui.jsx';

const ACTIVE = ['planning', 'running', 'summarizing'];

function Composer({ agents, project, onStarted, onError }) {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const team = agents.filter((a) => !a.isLead);
  const lead = agents.find((a) => a.isLead);
  const ready = project?.git?.hasCommits && team.length > 0;

  const start = async (e) => {
    e?.preventDefault();
    if (!task.trim()) return;
    setBusy(true);
    try {
      const run = await api.createRun(task);
      setTask('');
      onStarted(run.id);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="composer" onSubmit={start}>
      <label htmlFor="task" className="composer-label">
        What should the team build?
      </label>
      <textarea
        id="task"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
        }}
        placeholder="Add a wishlist: users can save products, see them on a wishlist page, and remove them."
        rows={4}
      />
      <div className="composer-foot">
        <div className="composer-team" aria-label="Team">
          {lead && (
            <span className="composer-lead" title={`${lead.name} plans the work`}>
              <AgentMark agent={lead} size={22} /> {lead.name} plans
            </span>
          )}
          {team.length > 0 && (
            <span className="composer-workers">
              {team.map((a) => (
                <span key={a.name} title={a.description}>
                  <AgentMark agent={a} size={22} />
                </span>
              ))}
              <span className="composer-count">{team.length} agents build</span>
            </span>
          )}
        </div>
        <button className="btn btn-big" disabled={busy || !task.trim() || !ready}>
          {busy ? 'Starting…' : 'Plan it'}
        </button>
      </div>
      <p className="composer-hint">
        The lead reads your project and proposes a plan. Nothing runs until you approve it, and nothing touches your files until you review the changes. Ctrl + Enter
        to start.
      </p>
    </form>
  );
}

function SequenceRail({ run, agents }) {
  const tasks = run.plan?.tasks || [];
  return (
    <ol className="rail-seq" aria-label="Task order">
      {tasks.map((t) => {
        const st = run.tasks[t.id]?.status || 'pending';
        const agent = agents.find((a) => a.name === t.agent);
        return (
          <li key={t.id} style={{ '--c': agent?.color }} title={`${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`}>
            <Led status={st} size={8} />
            <span className="seq-id">{t.id}</span>
            <span className="seq-agent">{t.agent}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RunDetail({ runSummary, agents, onLog, onError, onClose }) {
  const [run, setRun] = useState(null);
  const [view, setView] = useState('live');
  const [busy, setBusy] = useState(false);
  const id = runSummary.id;

  useEffect(() => {
    let alive = true;
    setRun(null);
    api.run(id).then((r) => alive && setRun(r)).catch((e) => onError(e.message));
    const off = onLog((m) => {
      if (m.runId !== id) return;
      setRun((r) => {
        if (!r) return r;
        // Tasks are created when the plan is approved, after this run was first loaded.
        const holder = (m.taskId === 'lead' ? r.lead : r.tasks[m.taskId]) || { logs: [] };
        const next = { ...holder, logs: [...(holder.logs || []), m.entry] };
        return m.taskId === 'lead' ? { ...r, lead: next } : { ...r, tasks: { ...r.tasks, [m.taskId]: next } };
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [id, onLog, onError]);

  // Merge live status from the lightweight summary into the full run (logs live here).
  const merged = useMemo(() => {
    if (!run) return null;
    const tasks = {};
    for (const [tid, t] of Object.entries(runSummary.tasks || {})) tasks[tid] = { ...t, logs: run.tasks[tid]?.logs || [] };
    return { ...runSummary, tasks, lead: { ...runSummary.lead, logs: run.lead.logs } };
  }, [run, runSummary]);

  useEffect(() => {
    if (['review', 'applied', 'discarded'].includes(runSummary.status)) setView('changes');
    else if (ACTIVE.includes(runSummary.status)) setView('live');
  }, [runSummary.status]);

  if (!merged) return <div className="loading">Loading run…</div>;

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const lead = agents.find((a) => a.isLead);
  const active = ACTIVE.includes(merged.status);
  const tasks = merged.plan?.tasks || [];
  const showTabs = tasks.length > 0 && merged.status !== 'awaiting_approval';

  return (
    <div className="run">
      <div className="run-head">
        <div className="run-title">
          <span className={`run-status rs-${merged.status}`}>
            <Led status={active ? 'running' : merged.status === 'review' ? 'done' : merged.status} size={9} />
            {STATUS_TEXT[merged.status] || merged.status}
          </span>
          <h2>{merged.task}</h2>
        </div>
        <div className="run-meta">
          <span title="Total tokens used by all agents in this run">{formatTokens((merged.totals?.inputTokens || 0) + (merged.totals?.outputTokens || 0))} tokens</span>
          {merged.totals?.costUsd > 0 && <span title="Estimated by Claude Code. On a Pro/Max plan this counts against your usage limits, not money.">≈ ${merged.totals.costUsd.toFixed(2)}</span>}
          {(active || merged.status === 'awaiting_approval') && (
            <button className="btn-quiet danger" onClick={() => act(() => api.stopRun(id))} disabled={busy}>
              Stop run
            </button>
          )}
          <button className="btn-quiet" onClick={onClose}>
            New run
          </button>
        </div>
      </div>

      {merged.error && <div className="error-note">{merged.error}</div>}
      {merged.dirtyAtStart > 0 && merged.status !== 'applied' && (
        <p className="run-note">
          You had {merged.dirtyAtStart} uncommitted change{merged.dirtyAtStart === 1 ? '' : 's'} when this run started. Agents work from your last commit, so they don’t see
          those changes.
        </p>
      )}

      {merged.status === 'planning' && (
        <div className="deck deck-single">
          <Strip
            wide
            title="Reading the project and writing a plan"
            agent={lead}
            agentName={lead?.name || 'lead'}
            status="running"
            logs={merged.lead.logs}
            tokens={(merged.lead.inputTokens || 0) + (merged.lead.outputTokens || 0)}
            canStop
            onStop={() => act(() => api.stopRun(id))}
          />
        </div>
      )}

      {merged.status === 'awaiting_approval' && merged.plan && (
        <PlanEditor
          plan={merged.plan}
          agents={agents}
          busy={busy}
          onCancel={() => act(() => api.stopRun(id))}
          onApprove={(plan) =>
            act(async () => {
              await api.updatePlan(id, plan);
              await api.approve(id);
            })
          }
        />
      )}

      {showTabs && (
        <>
          <div className="run-tabs">
            <div role="tablist" aria-label="Run view">
              <button role="tab" aria-selected={view === 'live'} className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>
                Agents
              </button>
              <button role="tab" aria-selected={view === 'changes'} className={view === 'changes' ? 'on' : ''} onClick={() => setView('changes')}>
                Changes
              </button>
            </div>
            <SequenceRail run={merged} agents={agents} />
          </div>

          {view === 'live' && (
            <div className="deck">
              <Strip
                title={merged.status === 'summarizing' ? 'Writing the summary' : 'Plan and summary'}
                agent={lead}
                agentName={lead?.name || 'lead'}
                status={merged.lead.status === 'running' ? 'running' : merged.lead.status || 'done'}
                logs={merged.lead.logs}
                tokens={(merged.lead.inputTokens || 0) + (merged.lead.outputTokens || 0)}
                cost={merged.lead.costUsd}
              />
              {tasks.map((t) => {
                const st = merged.tasks[t.id] || {};
                const agent = agents.find((a) => a.name === t.agent);
                return (
                  <Strip
                    key={t.id}
                    title={t.title}
                    subtitle={t.id}
                    agent={agent}
                    agentName={t.agent}
                    status={st.status || 'pending'}
                    logs={st.logs}
                    tokens={(st.inputTokens || 0) + (st.outputTokens || 0)}
                    cost={st.costUsd}
                    files={st.filesTouched}
                    error={st.error}
                    canStop={st.status === 'running' || st.status === 'pending'}
                    onStop={() => act(() => api.stopTask(id, t.id))}
                    canMessage={!!st.sessionId && st.status !== 'running' && ['review', 'running'].includes(merged.status) && !!merged.worktree}
                    onMessage={(text) => api.message(id, t.id, text).catch((e) => onError(e.message))}
                  />
                );
              })}
            </div>
          )}

          {view === 'changes' && (
            <>
              {active ? (
                <p className="run-note">The team is still working. You can look at the changes so far; applying is possible once the run finishes.</p>
              ) : null}
              <ReviewPanel run={merged} agents={agents} onError={onError} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function RunsView({ runs, agents, project, onLog, onError, selected, setSelected }) {
  const current = runs.find((r) => r.id === selected);

  const remove = async (id, e) => {
    e.stopPropagation();
    if (!confirm('Delete this run from the history? Unapplied changes are discarded.')) return;
    try {
      await api.deleteRun(id);
      if (selected === id) setSelected(null);
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <div className="runs">
      <aside className="history" aria-label="Run history">
        <button className={`history-new ${!current ? 'on' : ''}`} onClick={() => setSelected(null)}>
          New run
        </button>
        {runs.length === 0 && <p className="history-empty">Your runs will appear here.</p>}
        <ul>
          {runs.map((r) => (
            <li key={r.id}>
              <button className={`history-item ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                <Led status={ACTIVE.includes(r.status) ? 'running' : r.status} size={8} />
                <span className="history-task">{r.task}</span>
                <span className="history-meta">
                  {STATUS_TEXT[r.status] || r.status}, {timeAgo(r.createdAt)}
                </span>
              </button>
              {!ACTIVE.includes(r.status) && (
                <button className="history-del" onClick={(e) => remove(r.id, e)} aria-label={`Delete run: ${r.task}`} title="Delete run">
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
      <section className="runs-main">
        {current ? (
          <RunDetail runSummary={current} agents={agents} onLog={onLog} onError={onError} onClose={() => setSelected(null)} />
        ) : (
          <Composer agents={agents} project={project} onStarted={setSelected} onError={onError} />
        )}
      </section>
    </div>
  );
}
