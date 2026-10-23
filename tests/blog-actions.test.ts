import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteConfig } from '../core/contract.ts';
import type { BlogState, Candidate } from '../scripts/blog/state.ts';
import { commitCandidate, renameTemplate } from '../scripts/blog/actions.ts';
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
    contract: '0x0000000000000000000000000000000000000000',
    deployBlock: 0,
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
  },
} as SiteConfig;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function writeNote(body: string, title = '标题'): Promise<void> {
  await writeFile(path.join(repo, 'content', 'a.md'), `${body}\n`);
  await writeFile(
    path.join(repo, 'content', 'a.meta.yml'),
    `tags: 文章 建站\ntitle: ${title}\n`,
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
    await writeNote('second body', '新标题');
    const raw = await readRawContentFile(repo, 'content/a.md');
    const candidate: Candidate = {
      path: 'content/a.md',
      metaPath: 'content/a.meta.yml',
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
    expect(result.message).toBe('content(文章): update 新标题');
    expect(git(['log', '-1', '--format=%s'])).toBe('content(文章): update 新标题');
    expect(
      git(['show', '--name-only', '--format=', 'HEAD']).split('\n').sort(),
    ).toEqual(['content/a.md', 'content/a.meta.yml']);
  });
});

describe('renameTemplate', () => {
  async function templateCandidate(): Promise<Candidate> {
    await writeFile(path.join(repo, 'content', 'new-blog.md'), '冰山\n');
    await writeFile(
      path.join(repo, 'content', 'new-blog.meta.yml'),
      'tags: 文章\ntitle: 冰山\n',
    );
    return {
      path: 'content/new-blog.md',
      metaPath: 'content/new-blog.meta.yml',
      id: 'new-blog',
      kind: 'untracked',
      exists: true,
      staged: false,
      isTemplate: true,
      data: { tags: '文章', title: '冰山' },
      body: '冰山\n',
      errors: [],
      warnings: [],
    };
  }

  it('uses the preferred id and moves the sidecar', async () => {
    const candidate = await templateCandidate();

    const next = await renameTemplate(repo, candidate, 'Bing Shan');

    expect(next).toBe('content/bing-shan.md');
    expect(existsSync(path.join(repo, 'content', 'bing-shan.md'))).toBe(true);
    expect(existsSync(path.join(repo, 'content', 'bing-shan.meta.yml'))).toBe(true);
    expect(existsSync(path.join(repo, 'content', 'new-blog.md'))).toBe(false);
  });

  it('falls back to the title when no id is preferred', async () => {
    const candidate = await templateCandidate();

    const next = await renameTemplate(repo, candidate);

    expect(next).toMatch(/^content\/post-[0-9a-f]{8}\.md$/u);
  });
});
