// Thin wrappers around the git CLI. Each run gets its own git worktree outside the
// project folder, so agents never touch your working copy until you approve.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Files Meshh copies into the worktree so agents see your latest guidelines and
// skills even if they are not committed yet. They are never part of the diff.
export const OVERLAY_PATHS = ['CLAUDE.md', '.claude/skills'];
const EXCLUDES = OVERLAY_PATHS.map((p) => `:(exclude)${p}`);

export function git(cwd, args, { input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const e = new Error((stderr || err.message).trim());
          e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: err ? err.code ?? 1 : 0 });
      },
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

export async function gitAvailable() {
  try {
    const { stdout } = await git(process.cwd(), ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function status(root) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false };
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  const hasCommits = head.code === 0;
  const branch = hasCommits ? (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() : null;
  const porcelain = (await git(root, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean);
  const dirty = porcelain.filter((l) => !/\s(CLAUDE\.md|\.claude\/|\.meshh\/)/.test(l)).length;
  return {
    isRepo: true,
    isTopLevel: path.resolve(top) === path.resolve(root),
    top,
    hasCommits,
    head: hasCommits ? head.stdout.trim() : null,
    branch,
    dirty,
  };
}

async function identityArgs(cwd) {
  const email = await git(cwd, ['config', 'user.email'], { allowFail: true });
  if (email.stdout.trim()) return [];
  return ['-c', 'user.name=Meshh', '-c', 'user.email=meshh@localhost'];
}

export async function initRepo(root) {
  const st = await status(root);
  if (!st.isRepo) await git(root, ['init']);
  const st2 = await status(root);
  if (!st2.hasCommits) {
    await git(root, ['add', '-A']);
    await git(root, [...(await identityArgs(root)), 'commit', '--allow-empty', '-m', 'Initial commit']);
  }
  return status(root);
}

export function worktreeBase(root) {
  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  return path.join(os.homedir(), '.meshh', 'worktrees', `${path.basename(root)}-${hash}`);
}

export async function createWorktree(root, runId) {
  const base = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = `meshh/${runId}`;
  const dir = path.join(worktreeBase(root), runId);
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, dir, base]);
  await syncOverlay(root, dir);
  return { dir, branch, base };
}

export async function syncOverlay(root, dir) {
  for (const rel of OVERLAY_PATHS) {
    const src = path.join(root, rel);
    const dst = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.cp(src, dst, { recursive: true });
  }
}

export async function removeWorktree(root, wt) {
  if (!wt) return;
  await git(root, ['worktree', 'remove', '--force', wt.dir], { allowFail: true });
  await fsp.rm(wt.dir, { recursive: true, force: true }).catch(() => {});
  await git(root, ['worktree', 'prune'], { allowFail: true });
  await git(root, ['branch', '-D', wt.branch], { allowFail: true });
}

async function stageAll(dir) {
  await git(dir, ['add', '-A', '--', '.', ...EXCLUDES]);
}

// Returns [{ path, status, additions, deletions, binary, patch }]
export async function diff(wt) {
  if (!wt || !fs.existsSync(wt.dir)) return [];
  await stageAll(wt.dir);
  const common = ['diff', '--cached', '--no-color', '--no-renames', wt.base, '--', '.', ...EXCLUDES];
  const numstat = (await git(wt.dir, [...common.slice(0, 1), '--numstat', ...common.slice(1)])).stdout;
  const nameStatus = (await git(wt.dir, [...common.slice(0, 1), '--name-status', ...common.slice(1)])).stdout;
  const patch = (await git(wt.dir, common)).stdout;

  const statusByPath = {};
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [s, ...rest] = line.split('\t');
    statusByPath[rest.join('\t')] = s;
  }
  const patches = {};
  for (const chunk of patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git'))) {
    const m = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (m) patches[m[2]] = chunk;
  }
  return numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split('\t');
      const p = rest.join('\t');
      return {
        path: p,
        status: { A: 'added', D: 'deleted', M: 'modified' }[statusByPath[p]?.[0]] || 'modified',
        additions: a === '-' ? 0 : Number(a),
        deletions: d === '-' ? 0 : Number(d),
        binary: a === '-',
        patch: patches[p] || '',
      };
    });
}

// Apply the selected files to the user's working copy as uncommitted changes.
export async function applyToWorkingCopy(root, wt, files) {
  await stageAll(wt.dir);
  const patch = (await git(wt.dir, ['diff', '--cached', '--binary', '--no-renames', wt.base, '--', ...files])).stdout;
  if (!patch.trim()) return { applied: 0 };
  await git(root, ['apply', '--3way', '--whitespace=nowarn'], { input: patch });
  return { applied: files.length };
}

// Commit the selected files on the run branch and merge it into the current branch.
export async function commitAndMerge(root, wt, files, message) {
  const busy = (await git(root, ['status', '--porcelain', '--', ...files])).stdout.trim();
  if (busy) {
    throw new Error(
      `You have uncommitted changes in files this run also changed:\n${busy}\nCommit or stash them first, or use “Apply as uncommitted changes”.`,
    );
  }
  await git(wt.dir, ['reset', '-q']);
  await git(wt.dir, ['add', '-A', '--', ...files]);
  const staged = await git(wt.dir, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code !== 0) {
    const id = await identityArgs(wt.dir);
    await git(wt.dir, [...id, 'commit', '-m', message]);
  }
  await git(root, [...(await identityArgs(root)), 'merge', '--no-ff', '-m', `Merge ${wt.branch}`, wt.branch]);
  return { applied: files.length };
}
