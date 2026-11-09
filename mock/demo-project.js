// Creates a small sample project (git repo + starter team) for `meshh --demo`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { initRepo } from '../server/git.js';
import { Project } from '../server/project.js';

const FILES = {
  'README.md': '# Demo shop\n\nA tiny Express + React app used to try Meshh.\n',
  'package.json': JSON.stringify({ name: 'demo-shop', private: true, type: 'module', scripts: { test: 'node --test tests/' } }, null, 2) + '\n',
  'server/index.js':
    "import express from 'express';\n\nconst app = express();\napp.use(express.json());\napp.get('/api/health', (req, res) => res.json({ ok: true }));\n\napp.listen(3000);\n",
  'client/src/App.jsx': 'export default function App() {\n  return <main><h1>Demo shop</h1></main>;\n}\n',
  'CLAUDE.md':
    '# Project guidelines\n\n- Express server lives in `server/`, React client in `client/`.\n- Use ES modules everywhere.\n- Keep functions small and name things clearly.\n- Every new endpoint needs a test in `tests/`.\n',
};

const SKILLS = {
  'api-design': {
    description: 'Conventions for designing REST endpoints in this project. Use when adding or changing API routes.',
    body: '# API design\n\n- Plural nouns: `/api/products`, not `/api/getProducts`.\n- Return JSON objects, never bare arrays.\n- Errors: `{ error: { code, message } }` with the right HTTP status.\n- Validate every request body.\n',
  },
  'write-tests': {
    description: 'How to write tests in this project with node:test. Use when adding tests.',
    body: '# Writing tests\n\n- Use `node:test` and `node:assert`.\n- One file per feature in `tests/`.\n- Cover the happy path, bad input, and empty states.\n',
  },
  'ui-polish': {
    description: 'Checklist for polished, accessible UI components. Use when building frontend components.',
    body: '# UI polish\n\n- Every interactive element is reachable by keyboard.\n- Handle loading, empty and error states.\n- Use the spacing scale: 4, 8, 12, 16, 24, 32.\n',
  },
};

export async function createDemoProject(dir) {
  if (fs.existsSync(path.join(dir, '.meshh', 'config.json'))) return dir;
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), content);
  }
  const project = new Project(dir);
  for (const [name, s] of Object.entries(SKILLS)) await project.saveSkill({ name, ...s });
  for (const t of ['lead', 'backend', 'frontend', 'tester', 'reviewer']) await project.addTemplate(t);
  const set = async (name, patch) => {
    const a = await project.getAgent(name);
    await project.saveAgent({ ...a, ...patch }, name);
  };
  await set('backend', { scope: ['server', 'docs'], skills: ['api-design'] });
  await set('frontend', { scope: ['client'], skills: ['ui-polish'] });
  await set('tester', { scope: ['tests'], skills: ['write-tests'] });
  await set('reviewer', { skills: ['api-design', 'ui-polish'] });
  await initRepo(dir);
  return dir;
}
