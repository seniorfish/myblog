import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitPath,
  readGitContext,
  readGitStatus,
  stagePath,
} from '../scripts/shared/git-cli.ts';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'myblog-git-cli-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
  git(['commit', '-m', 'init']);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('readGitStatus', () => {
  it('detects untracked, modified, and renamed paths', async () => {
    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    let status = readGitStatus(repo);
    expect(status.some((entry) => entry.path === 'b.txt' && entry.untracked)).toBe(true);

    git(['add', 'b.txt']);
    git(['commit', '-m', 'add b']);
    await writeFile(path.join(repo, 'b.txt'), 'b2\n');
    status = readGitStatus(repo);
    expect(status.find((entry) => entry.path === 'b.txt')?.unstaged).toBe(true);

    git(['mv', 'b.txt', 'c.txt']);
    status = readGitStatus(repo);
    const renamed = status.find((entry) => entry.path === 'c.txt');
    expect(renamed?.renamed).toBe(true);
    expect(renamed?.originalPath).toBe('b.txt');
  });
});

describe('readGitContext', () => {
  it('reads branch and linear history state', () => {
    const context = readGitContext(repo);
    expect(context.branch).toBe('main');
    expect(context.detached).toBe(false);
    expect(context.operation).toBeNull();
    expect(context.mergeCommits).toEqual([]);
    expect(context.hasUpstream).toBe(false);
  });
});

describe('commitPath', () => {
  it('commits only the target path and leaves other staged files alone', async () => {
    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    await writeFile(path.join(repo, 'c.txt'), 'c\n');
    stagePath(repo, 'c.txt');

    const commit = commitPath(repo, 'b.txt', 'content: add b');
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);

    const status = readGitStatus(repo);
    expect(status.find((entry) => entry.path === 'c.txt')?.staged).toBe(true);
    expect(status.some((entry) => entry.path === 'b.txt')).toBe(false);
  });
});
