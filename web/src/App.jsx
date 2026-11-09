import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, REPO_URL, useLive } from './api.js';
import Landing from './components/Landing.jsx';
import { ErrorNote } from './components/ui.jsx';
import RunsView from './views/RunsView.jsx';
import AgentsView from './views/AgentsView.jsx';
import SkillsView from './views/SkillsView.jsx';
import GuidelinesView from './views/GuidelinesView.jsx';

const TABS = [
  { id: 'runs', label: 'Runs' },
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills & access' },
  { id: 'guidelines', label: 'Guidelines' },
];

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function App() {
  const [tab, setTab] = useState(() => {
    const h = location.hash.slice(1);
    return TABS.some((t) => t.id === h) ? h : 'runs';
  });
  const [project, setProject] = useState(null);
  const [meta, setMeta] = useState({ templates: [], toolGroups: [] });
  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const logListeners = useRef(new Set());
  const workspaceRef = useRef(null);

  const loadProject = useCallback(() => api.project().then(setProject).catch((e) => setError(e.message)), []);
  const loadAgents = useCallback(() => api.agents().then(setAgents).catch((e) => setError(e.message)), []);
  const loadSkills = useCallback(() => api.skills().then(setSkills).catch((e) => setError(e.message)), []);
  const loadRuns = useCallback(() => api.runs().then(setRuns).catch((e) => setError(e.message)), []);

  useEffect(() => {
    loadProject();
    loadAgents();
    loadSkills();
    loadRuns();
    api.meta().then(setMeta).catch(() => {});
  }, [loadProject, loadAgents, loadSkills, loadRuns]);

  const scrollToWorkspace = useCallback(() => {
    workspaceRef.current?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }, []);

  // A hash like #agents opens that section of the workspace.
  useEffect(() => {
    const h = location.hash.slice(1);
    if (TABS.some((t) => t.id === h)) setTimeout(() => workspaceRef.current?.scrollIntoView({ block: 'start' }), 50);
    const onHash = () => {
      const x = location.hash.slice(1);
      if (TABS.some((t) => t.id === x)) {
        setTab(x);
        scrollToWorkspace();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [scrollToWorkspace]);

  const openTab = (id) => {
    setTab(id);
    history.replaceState(null, '', `#${id}`);
    scrollToWorkspace();
  };

  useLive((msg) => {
    if (msg.type === 'run') {
      setRuns((prev) => {
        const i = prev.findIndex((r) => r.id === msg.run.id);
        if (i === -1) return [msg.run, ...prev];
        const next = prev.slice();
        next[i] = msg.run;
        return next;
      });
    } else if (msg.type === 'removed') {
      setRuns((prev) => prev.filter((r) => r.id !== msg.id));
    } else if (msg.type === 'log') {
      for (const fn of logListeners.current) fn(msg);
    }
  });

  const onLog = useCallback((fn) => {
    logListeners.current.add(fn);
    return () => logListeners.current.delete(fn);
  }, []);

  const startFromLanding = async (task) => {
    const run = await api.createRun(task);
    setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [run, ...prev]));
    setSelectedRun(run.id);
    openTab('runs');
  };

  const setupGit = async () => {
    setBusy(true);
    try {
      await api.gitInit();
      await loadProject();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addStarter = async () => {
    setBusy(true);
    try {
      setAgents(await api.starterTeam());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const git = project?.git;
  const needsGit = project && (!git?.isRepo || !git?.hasCommits);
  const noClaude = project && !project.claude?.version;
  const activeCount = runs.filter((r) => ['planning', 'running', 'summarizing'].includes(r.status)).length;

  return (
    <div className="page">
      <Landing project={project} agents={agents} onStart={startFromLanding} onOpen={openTab} />

      <section className="workspace" id="workspace" ref={workspaceRef} aria-label="Workspace">
        <header className="topbar">
          <button className="brand" onClick={() => window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' })} title="Back to the top">
            MESHH
          </button>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t, i) => (
              <React.Fragment key={t.id}>
                {i > 0 && (
                  <span className="tab-sep" aria-hidden="true">
                    /
                  </span>
                )}
                <button className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => openTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
                  {t.label}
                  {t.id === 'runs' && activeCount > 0 && <span className="tab-count">({activeCount})</span>}
                </button>
              </React.Fragment>
            ))}
          </nav>
          <div className="sysinfo">
            {project?.demo && <span>Demo: simulated agents</span>}
            {project?.name && (
              <span title={project.root}>
                {project.name}
                {git?.branch ? ` on ${git.branch}` : ''}
              </span>
            )}
            {project?.claude?.version && !project.demo && <span>Claude Code {project.claude.version.split(' ')[0]}</span>}
          </div>
        </header>

        {(needsGit || noClaude || project?.showcase || (project && agents.length === 0)) && (
          <div className="setup">
            {project?.showcase && (
              <div className="setup-row">
                <strong>You’re trying Meshh with simulated agents.</strong>
                <span>Everything here runs in your browser and nothing touches real code. To run real Claude Code agents on your own projects, install Meshh on your computer.</span>
                <a className="btn" href={`${REPO_URL}#quick-start`} target="_blank" rel="noreferrer">
                  How to install
                </a>
              </div>
            )}
            {noClaude && (
              <div className="setup-row">
                <strong>Claude Code isn’t installed or isn’t on your PATH.</strong>
                <span>
                  Install it with <code>npm i -g @anthropic-ai/claude-code</code>, run <code>claude</code> once to log in, then restart Meshh. Or try it with{' '}
                  <code>meshh --demo</code>.
                </span>
              </div>
            )}
            {needsGit && (
              <div className="setup-row">
                <strong>{git?.isRepo ? 'This repository has no commits yet.' : 'This folder isn’t a git repository.'}</strong>
                <span>Agents work in a separate git worktree, so you can review every change before it touches your files.</span>
                <button className="btn" onClick={setupGit} disabled={busy}>
                  {git?.isRepo ? 'Create first commit' : 'Set up git'}
                </button>
              </div>
            )}
            {project && agents.length === 0 && (
              <div className="setup-row">
                <strong>No agents yet.</strong>
                <span>Start with a lead, backend, frontend, tester and reviewer. You can change everything later.</span>
                <button className="btn" onClick={addStarter} disabled={busy}>
                  Add starter team
                </button>
              </div>
            )}
          </div>
        )}

        <ErrorNote error={error} onClose={() => setError('')} />

        <main className="main">
          {tab === 'runs' && (
            <RunsView
              runs={runs}
              agents={agents}
              project={project}
              onLog={onLog}
              onError={setError}
              selected={selectedRun}
              setSelected={setSelectedRun}
            />
          )}
          {tab === 'agents' && <AgentsView agents={agents} skills={skills} meta={meta} reload={loadAgents} onError={setError} />}
          {tab === 'skills' && (
            <SkillsView agents={agents} skills={skills} meta={meta} reloadAgents={loadAgents} reloadSkills={loadSkills} onError={setError} />
          )}
          {tab === 'guidelines' && <GuidelinesView project={project} reloadProject={loadProject} onError={setError} />}
        </main>
      </section>
    </div>
  );
}
