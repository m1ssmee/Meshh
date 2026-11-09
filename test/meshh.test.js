// End-to-end tests using the simulated Claude (no login needed). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFrontmatter, stringifyFrontmatter, toList } from '../server/frontmatter.js';
import * as G from '../server/git.js';
import { Project } from '../server/project.js';
import { Runner } from '../server/runner.js';
import { createDemoProject } from '../mock/demo-project.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshh-test-'));

function waitFor(runner, id, statuses, ms = 60000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const r = runner.get(id);
      if (r && statuses.includes(r.status)) {
        runner.off('run', check);
        clearTimeout(t);
        resolve(r);
      }
    };
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${statuses}, got ${runner.get(id)?.status}`)), ms);
    runner.on('run', check);
    check();
  });
}

test('frontmatter round-trips and tools parse both formats', () => {
  const text = stringifyFrontmatter({ name: 'x', description: 'y', tools: 'Read, Grep' }, 'Body');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'x');
  assert.equal(body, 'Body');
  assert.deepEqual(toList(data.tools), ['Read', 'Grep']);
  assert.deepEqual(toList(['Edit', 'Write']), ['Edit', 'Write']);
});

test('agents and skills are saved as Claude Code files', async () => {
  const dir = tmp();
  const p = new Project(dir);
  await p.addTemplate('backend');
  await p.saveSkill({ name: 'style', description: 'Style rules', body: '# Style' });
  assert.ok(fs.existsSync(path.join(dir, '.claude/agents/backend.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/style/SKILL.md')));
  const a = await p.getAgent('backend');
  assert.deepEqual(a.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  await p.saveSkill({ name: 'style-guide', description: 'Style rules', body: '# Style' }, 'style');
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/style-guide/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude/skills/style')));
});

test('agent args enforce folder scope and skill access', async () => {
  const dir = await createDemoProject(path.join(tmp(), 'proj'));
  const p = new Project(dir);
  const r = new Runner(p, { demo: true });
  const args = await r.agentArgs({ id: 'x' }, await p.getAgent('frontend'));
  assert.ok(args.includes('Edit(./client/**)'));
  assert.ok(args.includes('Skill(ui-polish)'));
  assert.ok(args.includes('Skill(api-design)')); // in the deny list
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Skill(api-design)');
  const ro = await r.agentArgs({ id: 'x' }, await p.getAgent('backend'), { readOnly: true });
  const def = JSON.parse(fs.readFileSync(ro[1], 'utf8')).backend;
  assert.deepEqual(def.tools, ['Read', 'Grep', 'Glob', 'Skill']);
});

test('full run: plan, approve, parallel work, review, apply', async () => {
  const dir = await createDemoProject(path.join(tmp(), 'proj'));
  const p = new Project(dir);
  const runner = new Runner(p, { demo: true });
  const created = await runner.create('Add a wishlist');
  let run = await waitFor(runner, created.id, ['awaiting_approval', 'failed']);
  assert.equal(run.status, 'awaiting_approval', run.error);
  assert.ok(run.plan.tasks.length >= 3);

  await runner.approve(run.id);
  run = await waitFor(runner, run.id, ['review', 'failed']);
  assert.equal(run.status, 'review', run.error);
  for (const t of run.plan.tasks) assert.equal(run.tasks[t.id].status, 'done', `${t.id}: ${run.tasks[t.id].error}`);
  assert.ok(run.summary.length > 0);

  const files = await runner.diff(run.id);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('docs/api-contract.md'));
  assert.ok(paths.some((x) => x.startsWith('client/')));
  assert.ok(!paths.some((x) => x.startsWith('.claude/') || x === 'CLAUDE.md'), 'overlay files must not appear in the diff');
  assert.deepEqual(files.find((f) => f.path === 'docs/api-contract.md').agents, ['backend']);

  // Your working copy is untouched until you apply.
  assert.ok(!fs.existsSync(path.join(dir, 'docs/api-contract.md')));
  await runner.apply(run.id, { files: ['docs/api-contract.md'], mode: 'commit', message: 'Add contract' });
  assert.ok(fs.existsSync(path.join(dir, 'docs/api-contract.md')));
  const log = (await G.git(dir, ['log', '--oneline'])).stdout;
  assert.match(log, /Merge meshh\//);
  const wts = (await G.git(dir, ['worktree', 'list'])).stdout.trim().split('\n');
  assert.equal(wts.length, 1, 'worktree removed after apply');
});

test('stopping a run stops its agents', async () => {
  const dir = await createDemoProject(path.join(tmp(), 'proj'));
  const runner = new Runner(new Project(dir), { demo: true });
  const created = await runner.create('Add search');
  await waitFor(runner, created.id, ['awaiting_approval']);
  await runner.approve(created.id);
  await new Promise((r) => setTimeout(r, 1500));
  await runner.stopRun(created.id);
  const run = runner.get(created.id);
  assert.equal(run.status, 'stopped');
  await runner.discard(created.id);
  assert.equal(runner.get(created.id).status, 'discarded');
});
