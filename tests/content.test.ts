import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverContent } from '../core/content.ts';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-discover-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('discoverContent', () => {
  it('pairs body files with metadata sidecars', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'hello.md'), '正文\n');
    await writeFile(path.join(root, 'content', 'hello.meta.yml'), 'tags: 文章 建站\n');

    const result = await discoverContent(root);

    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe('hello');
    expect(result.entries[0]?.frontmatter.tags).toBe('文章 建站');
    expect(result.entries[0]?.body).toBe('正文\n');
    expect(result.entries[0]?.metaRelPath).toBe('content/hello.meta.yml');
  });

  it('reports a missing sidecar', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'hello.md'), '正文\n');

    const result = await discoverContent(root);

    expect(result.entries).toEqual([]);
    expect(
      result.issues.some((issue) => issue.message.includes('Missing metadata file')),
    ).toBe(true);
  });

  it('reports an orphan sidecar', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'gone.meta.yml'), 'tags: 文章\n');

    const result = await discoverContent(root);

    expect(
      result.issues.some((issue) => issue.message.includes('no matching')),
    ).toBe(true);
  });

  it('rejects frontmatter left in the body file', async () => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, 'content', 'hello.md'),
      '---\ntags: 文章\n---\n\n正文\n',
    );
    await writeFile(path.join(root, 'content', 'hello.meta.yml'), 'tags: 文章\n');

    const result = await discoverContent(root);

    expect(
      result.issues.some((issue) => issue.message.includes('not allowed in .md')),
    ).toBe(true);
  });

  it('supports nested ids', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'content', 'notes'), { recursive: true });
    await writeFile(path.join(root, 'content', 'notes', 'a.md'), '正文\n');
    await writeFile(path.join(root, 'content', 'notes', 'a.meta.yml'), 'tags: 想法\n');

    const result = await discoverContent(root);

    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.id).toBe('notes/a');
  });
});
