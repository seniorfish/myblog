import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileSite } from '../core/build.ts';
import type { SiteConfig } from '../core/contract.ts';

let repo: string;

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

async function commitAll(message: string, date: string): Promise<string> {
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  git(['add', '-A'], env);
  git(['commit', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}

function testConfig(chainEnabled = true): SiteConfig {
  return {
    title: 'Test Blog',
    description: 'Test description',
    author: 'Tester',
    url: 'https://example.com',
    lang: 'zh-CN',
    timezone: 'UTC',
    repo: 'tester/blog',
    defaultTheme: 'default',
    themes: ['default'],
    ui: {
      contentDisplay: {
        文章: { mode: 'excerpt' },
        想法: { mode: 'full-if-short', maxChars: 400 },
      },
    },
    chain: {
      enabled: chainEnabled,
      name: 'base-sepolia',
      chainId: 84532,
      address: `0x${'1'.repeat(40)}`,
      rpcUrl: 'https://sepolia.base.org',
      explorerUrl: 'https://sepolia.basescan.org',
    },
  };
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'myblog-build-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  git(['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(repo, 'content'), { recursive: true });
  await writeFile(
    path.join(repo, 'content', 'hello.md'),
    '---\ntags: 文章 建站\ntitle: Test Node\ndescription: A test node.\n---\n\nHello **world**.\n',
  );
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('compileSite', () => {
  it('produces site data, search, RSS, sitemap, raw, proof, and metadata', async () => {
    const commit = await commitAll('first', '2024-01-01T00:00:00Z');
    const tx = `0x${'b'.repeat(64)}`;
    const note = JSON.stringify({
      schema: 1,
      chain: 'base-sepolia',
      chainId: 84532,
      tx,
      block: 42,
      blockTimestamp: 1700000000,
      commit,
      repo: 'tester/blog',
    });
    git(['notes', '--ref=blockchain', 'add', '-m', note, commit]);

    const outDir = path.join(repo, 'out');
    const result = await compileSite({
      root: repo,
      outDir,
      config: testConfig(true),
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.siteData?.nodes).toHaveLength(1);

    const node = result.siteData?.nodes[0];
    expect(node?.isVerified).toBe(true);
    expect(node?.createdAt).toBe(1700000000);
    expect(node?.updatedAt).toBe(1700000000);
    expect(node?.displayTime).toBe(1700000000);
    expect(node?.displayDate.iso).toBe('2023-11-14');
    expect(node?.html).toContain('<strong>world</strong>');

    const siteData = JSON.parse(await readFile(path.join(outDir, 'site-data.json'), 'utf8'));
    expect(siteData.site.buildId).toBe(result.buildMeta?.buildId);

    const proof = JSON.parse(await readFile(path.join(outDir, 'proof/hello.json'), 'utf8'));
    expect(proof.isVerified).toBe(true);
    expect(proof.revisions[0].anchor.txHash).toBe(tx);

    const rss = await readFile(path.join(outDir, 'rss.xml'), 'utf8');
    expect(rss).toContain('<title>Test Node</title>');
    expect(rss).toContain('<content:encoded>');

    const sitemap = await readFile(path.join(outDir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('https://example.com/n/hello');

    const robots = await readFile(path.join(outDir, 'robots.txt'), 'utf8');
    expect(robots).toContain('Sitemap: https://example.com/sitemap.xml');

    await access(path.join(outDir, 'search-index.json'));
    await access(path.join(outDir, 'raw/hello.md'));
    await access(path.join(outDir, 'build-meta.json'));
  });

  it('keeps buildId stable across repeated builds', async () => {
    await commitAll('first', '2024-01-01T00:00:00Z');
    const outDir = path.join(repo, 'out');

    const first = await compileSite({ root: repo, outDir, config: testConfig(false) });
    const second = await compileSite({ root: repo, outDir, config: testConfig(false) });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.buildMeta?.buildId).toBe(second.buildMeta?.buildId);
    expect(first.buildMeta?.contentHash).toBe(second.buildMeta?.contentHash);
  });

  it('rejects merge commits', async () => {
    await commitAll('base', '2024-01-01T00:00:00Z');
    git(['checkout', '-b', 'feature']);
    await writeFile(path.join(repo, 'content', 'feature.md'), '---\ntags: 文章\n---\nfeature\n');
    const feature = await commitAll('feature', '2024-01-02T00:00:00Z');
    git(['checkout', 'main']);
    await writeFile(path.join(repo, 'content', 'main.md'), '---\ntags: 文章\n---\nmain\n');
    await commitAll('main', '2024-01-03T00:00:00Z');
    git(['merge', '--no-ff', feature, '-m', 'merge'], {
      GIT_AUTHOR_DATE: '2024-01-04T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-04T00:00:00Z',
    });

    const result = await compileSite({
      root: repo,
      outDir: path.join(repo, 'out'),
      config: testConfig(false),
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Merge commits'))).toBe(true);
  });
});
