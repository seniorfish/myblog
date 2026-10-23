import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getFileAtCommit,
  getFileDiff,
  getFileHistory,
  getFirstParentCommitList,
  getHeadCommit,
  getMergeCommits,
  getWorkingStatus,
  isGitRepository,
  readAnchorRecords,
} from '../core/git.ts';

let repo: string;

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

async function commitAll(message: string, date: string): Promise<string> {
  const env = {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  git(['add', '-A'], env);
  git(['commit', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}

async function writeAnchorsBranch(content: string, date: string): Promise<void> {
  git(['checkout', '--orphan', 'anchors']);
  git(['rm', '-rf', '.']);
  await writeFile(path.join(repo, 'anchors.ndjson'), content);
  git(['add', 'anchors.ndjson']);
  git(['commit', '-m', 'anchor'], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  git(['checkout', 'main']);
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'myblog-git-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(repo, 'content'), { recursive: true });
  await writeFile(path.join(repo, 'content', 'a.md'), '---\ntags: 文章\n---\nfirst\n');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('git integration', () => {
  it('reads a linear history and file timestamps', async () => {
    const commit = await commitAll('first', '2024-01-01T00:00:00Z');

    expect(isGitRepository(repo)).toBe(true);
    expect(getHeadCommit(repo)).toBe(commit);
    expect(getFirstParentCommitList(repo)).toEqual([commit]);
    expect(getMergeCommits(repo)).toEqual([]);

    const history = getFileHistory(repo, 'content/a.md');
    expect(history).toHaveLength(1);
    expect(history[0]?.commit).toBe(commit);
    expect(history[0]?.gitTimestamp).toBe(1704067200);
  });

  it('tracks modifications newest first and reads historical blobs', async () => {
    const first = await commitAll('first', '2024-01-01T00:00:00Z');
    await writeFile(path.join(repo, 'content', 'a.md'), '---\ntags: 文章\n---\nsecond\n');
    const second = await commitAll('second', '2024-01-02T00:00:00Z');

    const history = getFileHistory(repo, 'content/a.md');
    expect(history.map((entry) => entry.commit)).toEqual([second, first]);

    const oldBlob = getFileAtCommit(repo, first, 'content/a.md');
    expect(oldBlob?.toString('utf8')).toContain('first');
    expect(oldBlob?.toString('utf8')).not.toContain('second');

    const diff = getFileDiff(repo, second, 'content/a.md');
    expect(diff).toContain('-first');
    expect(diff).toContain('+second');
  });

  it('follows renames', async () => {
    await commitAll('first', '2024-01-01T00:00:00Z');
    git(['mv', 'content/a.md', 'content/b.md']);
    const renamed = await commitAll('rename', '2024-01-02T00:00:00Z');

    const history = getFileHistory(repo, 'content/b.md');
    expect(history).toHaveLength(2);
    expect(history[0]?.commit).toBe(renamed);
  });

  it('detects dirty and untracked files', async () => {
    await commitAll('first', '2024-01-01T00:00:00Z');

    await writeFile(path.join(repo, 'content', 'a.md'), '---\ntags: 文章\n---\ndirty\n');
    expect(getWorkingStatus(repo, 'content/a.md')).toEqual({
      dirty: true,
      untracked: false,
    });

    await writeFile(path.join(repo, 'content', 'b.md'), '---\ntags: 想法\n---\nnew\n');
    expect(getWorkingStatus(repo, 'content/b.md')).toEqual({
      dirty: false,
      untracked: true,
    });
  });

  it('reads anchors.ndjson from the anchors branch and ignores malformed lines', async () => {
    const commit = await commitAll('first', '2024-01-01T00:00:00Z');
    const tx = `0x${'a'.repeat(64)}`;
    const contract = `0x${'b'.repeat(40)}`;
    const sender = `0x${'c'.repeat(40)}`;
    const record = JSON.stringify({
      schema: 1,
      chain: 'base-mainnet',
      chainId: 8453,
      commit,
      contract,
      sender,
      tx,
      block: 10,
      blockTimestamp: 1700000000,
      repo: 'tester/blog',
    });
    await writeAnchorsBranch(`${record}\nnot json\n`, '2024-01-02T00:00:00Z');

    const result = readAnchorRecords(repo);

    expect(result.branchFound).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.tx).toBe(tx);
    expect(result.records[0]?.blockTimestamp).toBe(1700000000);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reports a missing anchors branch without throwing', () => {
    const result = readAnchorRecords(repo);
    expect(result.branchFound).toBe(false);
    expect(result.records).toEqual([]);
  });

  it('detects merge commits', async () => {
    const base = await commitAll('base', '2024-01-01T00:00:00Z');
    git(['checkout', '-b', 'feature']);
    await writeFile(path.join(repo, 'content', 'feature.md'), 'feature\n');
    const feature = await commitAll('feature', '2024-01-02T00:00:00Z');

    git(['checkout', 'main']);
    await writeFile(path.join(repo, 'content', 'main.md'), 'main\n');
    await commitAll('main', '2024-01-03T00:00:00Z');
    git(
      ['merge', '--no-ff', feature, '-m', 'merge feature'],
      {
        GIT_AUTHOR_DATE: '2024-01-04T00:00:00Z',
        GIT_COMMITTER_DATE: '2024-01-04T00:00:00Z',
      },
    );

    expect(getMergeCommits(repo)).toHaveLength(1);
    expect(getFirstParentCommitList(repo)[0]).toBe(base);
  });
});
