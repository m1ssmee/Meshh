import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function GuidelinesView({ project, reloadProject, onError }) {
  const [text, setText] = useState(null);
  const [saved, setSaved] = useState('');
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api
      .guidelines()
      .then((g) => {
        setText(g.text);
        setSaved(g.text);
      })
      .catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    if (project?.config) setCfg(project.config);
  }, [project]);

  const saveText = async () => {
    try {
      await api.saveGuidelines(text);
      setSaved(text);
      setStatus('Guidelines saved');
    } catch (e) {
      onError(e.message);
    }
  };
  const saveCfg = async (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    try {
      await api.config(patch);
      await reloadProject();
      setStatus('Settings saved');
    } catch (e) {
      onError(e.message);
    }
  };

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 2000);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className="guidelines">
      <section className="gl-editor">
        <div className="section-head">
          <h2>Project guidelines</h2>
          <p>
            Saved as <code>CLAUDE.md</code>. Every agent reads it on every task, so put the rules that apply to everyone here: stack, conventions, what never to touch,
            how to run tests.
          </p>
        </div>
        {text === null ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            <textarea
              className="mono gl-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'# Project guidelines\n\n- We use TypeScript and React.\n- Run `npm test` before finishing.\n- Never edit files in /legacy.'}
              aria-label="Project guidelines (CLAUDE.md)"
            />
            <div className="gl-actions">
              <span className="saved-note" aria-live="polite">
                {status}
              </span>
              <button className="btn" onClick={saveText} disabled={text === saved}>
                Save guidelines
              </button>
            </div>
          </>
        )}
      </section>

      <aside className="gl-settings">
        <h2>Run settings</h2>
        {cfg && (
          <div className="form-grid single">
            <label className="field">
              <span>Agents working at the same time</span>
              <input type="number" min={1} max={8} value={cfg.maxParallel} onChange={(e) => saveCfg({ maxParallel: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
              <small>More agents finish sooner but use your Claude usage limit faster. 2–3 is a good start on Pro.</small>
            </label>
            <label className="field">
              <span>Setup command</span>
              <input
                value={cfg.setupCommand}
                onChange={(e) => setCfg({ ...cfg, setupCommand: e.target.value })}
                onBlur={(e) => saveCfg({ setupCommand: e.target.value })}
                placeholder="npm install"
              />
              <small>Runs once in each run’s fresh worktree before agents start, so tests and builds work.</small>
            </label>
            <label className="check">
              <input type="checkbox" checked={cfg.finalSummary} onChange={(e) => saveCfg({ finalSummary: e.target.checked })} />
              <span>Lead writes a summary when the team finishes</span>
            </label>
          </div>
        )}
        <div className="gl-paths">
          <h3>Where things are saved</h3>
          <dl>
            <dt>Agents</dt>
            <dd>
              <code>.claude/agents/</code>
            </dd>
            <dt>Skills</dt>
            <dd>
              <code>.claude/skills/</code>
            </dd>
            <dt>Guidelines</dt>
            <dd>
              <code>CLAUDE.md</code>
            </dd>
            <dt>Meshh settings</dt>
            <dd>
              <code>.meshh/config.json</code>
            </dd>
          </dl>
          <p>Commit these to share your team setup. They also work in plain Claude Code.</p>
        </div>
      </aside>
    </div>
  );
}
