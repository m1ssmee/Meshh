import React, { useLayoutEffect, useRef, useState } from 'react';

const NAV = [
  { id: 'runs', label: 'Runs' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'guidelines', label: 'Guidelines' },
];

const LINE = 26; // px, chat box line height (keep in sync with CSS)

export default function Landing({ project, agents, onStart, onOpen }) {
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const taRef = useRef(null);

  const workers = agents.filter((a) => !a.isLead);
  const blocker = !project
    ? ''
    : !project.claude?.version
      ? 'Claude Code isn’t installed or logged in yet.'
      : !project.git?.hasCommits
        ? 'This project needs git with one commit first.'
        : workers.length === 0
          ? 'Add at least one agent besides the lead.'
          : '';

  // One line by default; grows with the text up to three lines.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 3 * LINE + 24)}px`;
  }, [task]);

  const start = async (e) => {
    e?.preventDefault();
    if (!task.trim() || busy || blocker) return;
    setBusy(true);
    setError('');
    try {
      await onStart(task.trim());
      setTask('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="landing" aria-label="Meshh">
      <header className="l-top">
        <span className="l-brand">MESHH</span>
        <nav className="l-nav" aria-label="Workspace sections">
          {NAV.map((n, i) => (
            <React.Fragment key={n.id}>
              {i > 0 && <span aria-hidden="true"> / </span>}
              <button className="l-link" onClick={() => onOpen(n.id)}>
                {n.label}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <span className="l-project" title={project?.root}>
          {project ? `${project.name}${project.git?.branch ? ` on ${project.git.branch}` : ''}` : ''}
          {project?.demo ? ' (demo)' : ''}
        </span>
        <button className="l-link l-cta" onClick={() => onOpen('runs')}>
          Open workspace <span aria-hidden="true">↓</span>
        </button>
      </header>

      <div className="l-mid">
        <form className="l-form" onSubmit={start}>
          <label htmlFor="l-task" className="l-label">
            What should the team build?
          </label>
          <textarea
            id="l-task"
            ref={taRef}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                start();
              }
            }}
            rows={1}
            placeholder="Add a wishlist to the store"
          />
          <div className="l-form-foot">
            <span className="l-hint">
              {error || blocker || 'Enter to send. The lead plans it, you approve, the team builds it. Nothing touches your files until you review.'}
            </span>
            <button className="l-link l-go" disabled={busy || !task.trim() || !!blocker}>
              {busy ? 'Planning…' : 'Plan it'} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </div>

      <div className="l-word" aria-hidden="true">
        <svg viewBox="0 0 1000 200">
          <text x="0" y="200" textLength="1000" lengthAdjust="spacingAndGlyphs">
            MESHH
          </text>
        </svg>
      </div>
    </section>
  );
}
