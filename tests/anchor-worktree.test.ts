import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnchorRecord } from '../core/schema.ts';
import {
  appendIndexRecord,
  commitIndexRecord,
  ensureAnchorsWorktree,
  pushAnchorsBranch,
  readWorktreeIndex,
  removeAnchorsWorktree,
} from '../scripts/blog/anchor-git.ts';

let base: string;
let root: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRecord(tx: string, block = 100): AnchorRecord {
  return {
    schema: 1,
    chain: 'base-mainnet',
    chainId: 8453,
    commit: 'a'.repeat(40),
    contract: `0x${'b'.repeat(40)}`,
    sender: `0x${'c'.repeat(40)}`,
    tx,
    block,
    blockTimestamp: 1700000000,
    logIndex: 0,
    repo: 'tester/blog',
  };
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'myblog-anchor-wt-'));
  root = path.join(base, 'repo');
  await mkdir(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Tester']);
  git(root, ['config', 'user.email', 'tester@example.com']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('anchors worktree', () => {
  it('creates an orphan branch, appends a record, commits, and cleans up', async () => {
    const worktree = await ensureAnchorsWorktree(root);
    expect(existsSync(path.join(worktree, 'anchors.ndjson'))).toBe(false);

    const record = makeRecord(`0x${'1'.repeat(64)}`);
    const appended = await appendIndexRecord(worktree, record);
    expect(appended.changed).toBe(true);
    expect((await readWorktreeIndex(worktree)).records).toHaveLength(1);

    await commitIndexRecord(worktree, record);
    expect(git(root, ['show', 'anchors:anchors.ndjson'])).toContain(record.tx);

    await removeAnchorsWorktree(root);
    expect(existsSync(worktree)).toBe(false);
    expect(git(root, ['rev-parse', '--verify', 'refs/heads/anchors'])).toHaveLength(40);
  });

  it('pushes the anchors branch to a bare remote', async () => {
    const bare = path.join(base, 'bare.git');
    git(base, ['init', '--bare', bare]);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-u', 'origin', 'main']);

    const worktree = await ensureAnchorsWorktree(root);
    const record = makeRecord(`0x${'2'.repeat(64)}`);
    await appendIndexRecord(worktree, record);
    await commitIndexRecord(worktree, record);

    const pushed = await pushAnchorsBranch(worktree);
    expect(pushed.pushed).toBe(true);
    expect(git(root, ['--git-dir', bare, 'show', 'anchors:anchors.ndjson'])).toContain(
      record.tx,
    );

    await removeAnchorsWorktree(root);
  });
});
