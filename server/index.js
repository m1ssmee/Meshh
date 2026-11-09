import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { claudeVersion } from './claude.js';
import * as G from './git.js';
import { Project } from './project.js';
import { Runner } from './runner.js';
import { TEMPLATES, TOOL_GROUPS } from './templates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, '..', 'web', 'dist');

export async function startServer({ root, port = 4317, host = '127.0.0.1', demo = false }) {
  const project = new Project(root);
  const runner = new Runner(project, { demo });
  await runner.load();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Only accept requests from the local UI (blocks other websites from driving your agents).
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    next();
  });

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res))
      .then((data) => res.json(data ?? { ok: true }))
      .catch((err) => res.status(400).json({ error: err.message || String(err) }));

  let claudeInfo = null;
  app.get(
    '/api/project',
    wrap(async () => {
      if (!claudeInfo) claudeInfo = { version: await claudeVersion({ demo }) };
      return {
        root: project.root,
        name: project.name,
        demo,
        git: await G.status(project.root),
        gitVersion: await G.gitAvailable(),
        claude: claudeInfo,
        config: await project.readConfig(),
      };
    }),
  );
  app.post('/api/project/git-init', wrap(() => G.initRepo(project.root)));
  app.put('/api/config', wrap((req) => project.updateConfig(req.body || {})));

  app.get('/api/meta', wrap(() => ({ templates: TEMPLATES, toolGroups: TOOL_GROUPS })));

  // agents
  app.get('/api/agents', wrap(() => project.listAgents()));
  app.post('/api/agents/from-template', wrap((req) => project.addTemplate(req.body.template, req.body.name)));
  app.post(
    '/api/agents/starter-team',
    wrap(async () => {
      const have = new Set((await project.listAgents()).map((a) => a.name));
      for (const t of ['lead', 'backend', 'frontend', 'tester', 'reviewer']) if (!have.has(t)) await project.addTemplate(t);
      return project.listAgents();
    }),
  );
  app.put('/api/agents/:name', wrap((req) => project.saveAgent(req.body, req.params.name === '_new' ? undefined : req.params.name)));
  app.delete('/api/agents/:name', wrap((req) => project.deleteAgent(req.params.name)));

  // skills
  app.get('/api/skills', wrap(() => project.listSkills()));
  app.put('/api/skills/:name', wrap((req) => project.saveSkill(req.body, req.params.name === '_new' ? undefined : req.params.name)));
  app.delete('/api/skills/:name', wrap((req) => project.deleteSkill(req.params.name)));

  // guidelines
  app.get('/api/guidelines', wrap(async () => ({ text: await project.readGuidelines() })));
  app.put('/api/guidelines', wrap((req) => project.writeGuidelines(String(req.body.text ?? ''))));

  // runs
  app.get('/api/runs', wrap(() => runner.list()));
  app.post('/api/runs', wrap((req) => runner.create(req.body.task)));
  app.get(
    '/api/runs/:id',
    wrap((req) => {
      const run = runner.get(req.params.id);
      if (!run) throw new Error('Run not found');
      return run;
    }),
  );
  app.put('/api/runs/:id/plan', wrap((req) => runner.updatePlan(req.params.id, req.body)));
  app.post('/api/runs/:id/approve', wrap((req) => runner.approve(req.params.id)));
  app.post('/api/runs/:id/stop', wrap((req) => runner.stopRun(req.params.id)));
  app.post('/api/runs/:id/tasks/:task/stop', wrap((req) => runner.stopTask(req.params.id, req.params.task)));
  app.post('/api/runs/:id/tasks/:task/message', wrap((req) => runner.message(req.params.id, req.params.task, String(req.body.text || ''))));
  app.get('/api/runs/:id/diff', wrap((req) => runner.diff(req.params.id)));
  app.post('/api/runs/:id/apply', wrap((req) => runner.apply(req.params.id, req.body || {})));
  app.post('/api/runs/:id/discard', wrap((req) => runner.discard(req.params.id)));
  app.delete('/api/runs/:id', wrap((req) => runner.remove(req.params.id)));

  // static UI
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  } else {
    app.get('/', (req, res) =>
      res.type('text').send('Meshh API is running. Build the UI with `npm run build`, or run `npm run dev` and open http://localhost:5173'),
    );
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ws.close();
  });
  runner.on('run', (run) => broadcast({ type: 'run', run }));
  runner.on('log', (m) => broadcast({ type: 'log', ...m }));
  runner.on('removed', (id) => broadcast({ type: 'removed', id }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const shutdown = () => {
    runner.stopAll();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`, project, runner };
}
