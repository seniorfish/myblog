import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteConfig } from '../core/contract.ts';
import type { BlogState, Candidate } from '../scripts/blog/state.ts';
import { commitCandidate } from '../scripts/blog/actions.ts';
import { readGitContext } from '../scripts/shared/git-cli.ts';
import { readRawContentFile } from '../scripts/shared/content-file.ts';

let repo: string;

const config = {
  title: 'Test',
  description: 'Test',
  author: 'Tester',
  url: 'https://example.com',
  lang: 'zh-CN',
  timezone: 'Asia/Shanghai',
  repo: 'tester/test',
  defaultTheme: 'default',
  themes: ['default'],
  homeTag: '首页',
  chain: {
    enabled: false,
    name: 'base-sepolia',
    chainId: 84532,
    address: '0x0000000000000000000000000000000000000000',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
  },
} as SiteConfig;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function writeNote(body: string, title = '标题'): Promise<void> {
  await writeFile(
    path.join(repo, 'content', 'a.md'),
    `---\ntags: 文章 建站\ntitle: ${title}\n---\n\n${body}\n`,
  );
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'myblog-actions-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(repo, 'content'), { recursive: true });
  await writeNote('first body');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('commitCandidate', () => {
  it('commits one modified note with a deterministic message', async () => {
    await writeNote('second body');
    const raw = await readRawContentFile(repo, 'content/a.md');
    const candidate: Candidate = {
      path: 'content/a.md',
      id: 'a',
      kind: 'modified',
      exists: true,
      staged: false,
      isTemplate: false,
      data: raw.data,
      body: raw.body,
      errors: [],
      warnings: [],
    };

    const state = {
      root: repo,
      config,
      git: readGitContext(repo),
      validation: { entries: [] },
      candidates: [candidate],
      globalErrors: [],
      blockers: [],
      notes: [],
      fixes: [],
      canCommit: true,
    } as unknown as BlogState;

    const result = await commitCandidate(state, candidate);
    expect(result.message).toBe('content(文章): update 标题');
    expect(git(['log', '-1', '--format=%s'])).toBe('content(文章): update 标题');
    expect(git(['show', '--name-only', '--format=', 'HEAD'])).toBe('content/a.md');
  });
});
