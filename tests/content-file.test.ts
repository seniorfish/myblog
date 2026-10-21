import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeMetadata } from '../core/metadata.ts';
import {
  inspectFrontmatter,
  normalizeContentFile,
  readRawContentFile,
  writeMetadataFile,
} from '../scripts/shared/content-file.ts';

const roots: string[] = [];

async function tempFile(
  body: string,
  meta: string,
): Promise<{ root: string; rel: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-content-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  await writeFile(path.join(root, 'content', 'note.md'), body, 'utf8');
  await writeFile(path.join(root, 'content', 'note.meta.yml'), meta, 'utf8');
  return { root, rel: 'content/note.md' };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('readRawContentFile', () => {
  it('removes empty optional fields and normalizes comma tags', async () => {
    const { root, rel } = await tempFile(
      '正文\n',
      'tags: 想法,硬件\ntitle:\ndescription:\n',
    );
    const raw = await readRawContentFile(root, rel);
    expect(raw.data.tags).toBe('想法 硬件');
    expect(raw.data).not.toHaveProperty('title');
    expect(raw.fixes).toContain('normalized comma-separated `tags`');
  });

  it('rejects frontmatter left in the body file', async () => {
    const { root, rel } = await tempFile('---\ntags: 文章\n---\n\n正文\n', 'tags: 文章\n');
    await expect(readRawContentFile(root, rel)).rejects.toThrow(/no longer supported/i);
  });

  it('normalizeContentFile writes the cleaned metadata', async () => {
    const { root, rel } = await tempFile(
      '正文\n',
      'tags: 想法\ndescription:\n',
    );
    const fixes = await normalizeContentFile(root, rel);
    expect(fixes.length).toBeGreaterThan(0);
    const written = await readFile(path.join(root, 'content', 'note.meta.yml'), 'utf8');
    expect(written).not.toContain('description:');
    expect(written).toContain('tags: 想法');
  });

  it('does not rewrite the body when only metadata needs cleaning', async () => {
    const { root, rel } = await tempFile('正文', 'tags: 想法\ndescription:\n');
    const bodyPath = path.join(root, 'content', 'note.md');
    const before = await readFile(bodyPath, 'utf8');

    await normalizeContentFile(root, rel);

    expect(await readFile(bodyPath, 'utf8')).toBe(before);
  });
});

describe('inspectFrontmatter', () => {
  it('allows missing tags while the AI is filling them', () => {
    expect(inspectFrontmatter({ description: '摘要' }).issues).toEqual([]);
  });

  it('reports forbidden dates and unknown keys', () => {
    expect(inspectFrontmatter({ tags: '文章', date: '2024-01-01' }).issues).toHaveLength(1);
    expect(inspectFrontmatter({ tags: '文章', titel: 'x' }).issues).toHaveLength(1);
  });
});

describe('serializeMetadata', () => {
  it('orders keys and keeps a trailing newline', () => {
    const text = serializeMetadata({ title: '标题', tags: '闪念' });
    expect(text).toBe('tags: 闪念\ntitle: 标题\n');
  });
});

describe('writeMetadataFile', () => {
  it('does not touch the body file', async () => {
    const { root, rel } = await tempFile('正文\n', 'tags: 闪念\n');
    const bodyPath = path.join(root, 'content', 'note.md');
    const before = await readFile(bodyPath, 'utf8');

    await writeMetadataFile(root, rel, { tags: '闪念', title: '标题' });

    expect(await readFile(bodyPath, 'utf8')).toBe(before);
    expect(await readFile(path.join(root, 'content', 'note.meta.yml'), 'utf8')).toContain(
      'title: 标题',
    );
  });
});
