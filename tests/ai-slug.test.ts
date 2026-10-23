import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applySlugRename, formatSlugProposal, normalizeSlugProposal } from '../scripts/ai/slug.ts';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-ai-slug-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const ids = new Set(['hello', 'hello-2', 'acking']);

describe('normalizeSlugProposal', () => {
  it('sanitizes ids into kebab-case ASCII', () => {
    const result = normalizeSlugProposal(
      { id: 'Bing Shan!', alternatives: ['Iceberg Theory'], reason: '题意' },
      ids,
      'new-blog',
    );

    expect(result.candidates).toEqual(['bing-shan', 'iceberg-theory']);
    expect(result.resolved).toBe('bing-shan');
    expect(result.unchanged).toBe(false);
  });

  it('drops CJK-only ids and keeps usable alternatives', () => {
    const result = normalizeSlugProposal(
      { id: '冰山', alternatives: ['bing-shan'], reason: '' },
      ids,
      'new-blog',
    );

    expect(result.candidates).toEqual(['bing-shan']);
    expect(result.warnings.some((item) => item.includes('non-ASCII'))).toBe(true);
  });

  it('returns null when nothing usable remains', () => {
    const result = normalizeSlugProposal({ id: '冰山', alternatives: [], reason: '' }, ids, 'new-blog');

    expect(result.resolved).toBeNull();
    expect(result.warnings.some((item) => item.includes('--id'))).toBe(true);
  });

  it('never returns the reserved template id', () => {
    const result = normalizeSlugProposal(
      { id: 'new-blog', alternatives: ['new-blog'], reason: '' },
      ids,
      'new-blog',
    );

    expect(result.candidates).toEqual([]);
    expect(result.resolved).toBeNull();
    expect(result.warnings.some((item) => item.includes('reserved'))).toBe(true);
  });

  it('resolves collisions with a numeric suffix', () => {
    const result = normalizeSlugProposal({ id: 'hello', alternatives: [], reason: '' }, ids, 'new-blog');

    expect(result.resolved).toBe('hello-3');
    expect(result.warnings.some((item) => item.includes('already taken'))).toBe(true);
  });

  it('does not treat the current id as taken', () => {
    const result = normalizeSlugProposal(
      { id: 'hello', alternatives: [], reason: '' },
      new Set(['hello']),
      'hello',
    );

    expect(result.resolved).toBe('hello');
    expect(result.unchanged).toBe(true);
  });
});

describe('applySlugRename', () => {
  it('renames the body and the sidecar together', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'new-blog.md'), '正文\n');
    await writeFile(path.join(root, 'content', 'new-blog.meta.yml'), 'tags: 文章\ntitle: 冰山\n');
    await writeFile(path.join(root, 'content', 'bing-shan.md'), '已存在\n');

    const result = await applySlugRename(root, 'content/new-blog.md', 'bing-shan');

    expect(result.renamed).toBe(true);
    expect(result.to).toBe('content/bing-shan-2.md');
    expect(existsSync(path.join(root, 'content', 'new-blog.md'))).toBe(false);
    expect(existsSync(path.join(root, 'content', 'new-blog.meta.yml'))).toBe(false);
    expect(await readFile(path.join(root, 'content', 'bing-shan-2.md'), 'utf8')).toBe('正文\n');
    expect(await readFile(path.join(root, 'content', 'bing-shan-2.meta.yml'), 'utf8')).toContain('冰山');
  });

  it('does nothing when the id is unchanged', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'hello.md'), '正文\n');

    const result = await applySlugRename(root, 'content/hello.md', 'hello');

    expect(result.renamed).toBe(false);
    expect(result.to).toBe('content/hello.md');
    expect(existsSync(path.join(root, 'content', 'hello.md'))).toBe(true);
  });
});

describe('formatSlugProposal', () => {
  it('shows the current id, the suggestion, alternatives, and the reason', () => {
    const text = formatSlugProposal({
      proposal: { id: 'bing-shan', alternatives: ['iceberg'], reason: '取冰山之意' },
      candidates: ['bing-shan', 'iceberg'],
      resolved: 'bing-shan',
      unchanged: false,
      currentId: 'new-blog',
    });

    expect(text).toContain('当前：new-blog');
    expect(text).toContain('建议：bing-shan');
    expect(text).toContain('备选：iceberg');
    expect(text).toContain('理由：取冰山之意');
  });
});
