import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AgentTag, Empty, Markdown } from './ui.jsx';

function DiffView({ file }) {
  if (!file) return <div className="diff-empty">Select a file to see its changes.</div>;
  if (file.binary) return <div className="diff-empty">Binary file, no preview.</div>;
  const lines = file.patch.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  return (
    <pre className="diff" aria-label={`Changes in ${file.path}`}>
      {lines.slice(start < 0 ? 0 : start).map((l, i) => {
        const cls = l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('\\') ? 'd-meta' : '';
        return (
          <span key={i} className={`d-line ${cls}`}>
            {l || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

export default function ReviewPanel({ run, agents, onError }) {
  const [files, setFiles] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [current, setCurrent] = useState(null);
  const [mode, setMode] = useState('working');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canApply = run.worktree && ['review', 'stopped', 'failed', 'interrupted'].includes(run.status);

  const load = () =>
    api
      .diff(run.id)
      .then((f) => {
        setFiles(f);
        setPicked(new Set(f.map((x) => x.path)));
        setCurrent((c) => f.find((x) => x.path === c?.path) || f[0] || null);
      })
      .catch((e) => onError(e.message));

  useEffect(() => {
    if (run.worktree) load();
    else setFiles([]);
    setMessage(`Meshh: ${run.task.split('\n')[0].slice(0, 60)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.worktree, run.status]);

  const totals = useMemo(() => {
    const sel = (files || []).filter((f) => picked.has(f.path));
    return { n: sel.length, add: sel.reduce((s, f) => s + f.additions, 0), del: sel.reduce((s, f) => s + f.deletions, 0) };
  }, [files, picked]);

  const toggle = (p) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const apply = async () => {
    setBusy(true);
    try {
      await api.apply(run.id, { files: [...picked], mode, message });
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!confirm('Discard every change from this run? This deletes its worktree.')) return;
    setBusy(true);
    try {
      await api.discard(run.id);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review">
      {run.summary && (
        <div className="review-summary">
          <h3>Lead’s summary</h3>
          <Markdown text={run.summary} />
        </div>
      )}

      {run.status === 'applied' && (
        <p className="review-done">
          {run.applied.mode === 'commit'
            ? `Committed and merged ${run.applied.files.length} file(s) into your current branch.`
            : `Applied ${run.applied.files.length} file(s) to your project as uncommitted (staged) changes. Review them in your editor or with git diff --cached.`}
        </p>
      )}
      {run.status === 'discarded' && <p className="review-done">This run was discarded. Nothing was changed in your project.</p>}

      {run.worktree && files && files.length === 0 && <Empty title="No file changes">The agents didn’t change any files in this run.</Empty>}

      {files && files.length > 0 && (
        <div className="changes">
          <div className="changes-list" role="list">
            <div className="changes-bar">
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.size === files.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(files.map((f) => f.path)) : new Set())}
                />
                <span>
                  {totals.n} of {files.length} files
                </span>
              </label>
              <span className="changes-stat">
                <b className="plus">+{totals.add}</b> <b className="minus">−{totals.del}</b>
              </span>
            </div>
            {files.map((f) => (
              <div key={f.path} role="listitem" className={`change ${current?.path === f.path ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} aria-label={`Include ${f.path}`} />
                <button className="change-main" onClick={() => setCurrent(f)}>
                  <span className={`change-kind k-${f.status}`} title={f.status}>
                    {f.status[0].toUpperCase()}
                  </span>
                  <span className="change-path">{f.path}</span>
                  <span className="change-agents">
                    {f.agents.map((a) => (
                      <AgentTag key={a} name={a} agent={agents.find((x) => x.name === a)} />
                    ))}
                  </span>
                  <span className="changes-stat">
                    <b className="plus">+{f.additions}</b> <b className="minus">−{f.deletions}</b>
                  </span>
                </button>
              </div>
            ))}
          </div>
          <div className="changes-diff">
            <div className="diff-title">{current?.path}</div>
            <DiffView file={current} />
          </div>
        </div>
      )}

      {canApply && files && files.length > 0 && (
        <div className="apply-bar">
          <fieldset className="apply-mode">
            <legend className="sr-only">How to apply</legend>
            <label className={mode === 'working' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'working'} onChange={() => setMode('working')} />
              <span>
                <b>Add to my files</b>
                <small>As uncommitted changes you can review and commit yourself</small>
              </span>
            </label>
            <label className={mode === 'commit' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'commit'} onChange={() => setMode('commit')} />
              <span>
                <b>Commit and merge</b>
                <small>Into your current branch{run.baseBranch ? ` (${run.baseBranch})` : ''}</small>
              </span>
            </label>
          </fieldset>
          {mode === 'commit' && <input className="commit-msg" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" />}
          <div className="apply-actions">
            <button className="btn-quiet danger" onClick={discard} disabled={busy}>
              Discard run
            </button>
            <button className="btn" onClick={apply} disabled={busy || picked.size === 0}>
              {mode === 'commit' ? `Commit ${totals.n} file${totals.n === 1 ? '' : 's'}` : `Add ${totals.n} file${totals.n === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
