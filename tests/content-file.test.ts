import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectFrontmatter,
  normalizeContentFile,
  readRawContentFile,
  serializeContent,
} from '../scripts/shared/content-file.ts';

const roots: string[] = [];

async function tempFile(source: string): Promise<{ root: string; rel: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-content-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  await writeFile(path.join(root, 'content', 'note.md'), source, 'utf8');
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
      '---\ntags: 想法,硬件\ntitle:\ndescription:\n---\n\n正文\n',
    );
    const raw = await readRawContentFile(root, rel);
    expect(raw.data.tags).toBe('想法 硬件');
    expect(raw.data).not.toHaveProperty('title');
    expect(raw.fixes).toContain('normalized comma-separated `tags`');
  });

  it('normalizeContentFile writes the cleaned frontmatter', async () => {
    const { root, rel } = await tempFile('---\ntags: 想法\ndescription:\n---\n\n正文\n');
    const fixes = await normalizeContentFile(root, rel);
    expect(fixes.length).toBeGreaterThan(0);
    const written = await readFile(path.join(root, rel), 'utf8');
    expect(written).not.toContain('description:');
    expect(written).toContain('tags: 想法');
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

describe('serializeContent', () => {
  it('keeps a trailing newline and preserves the body', () => {
    const text = serializeContent({ tags: '闪念', title: '标题' }, '正文\n');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text.endsWith('正文\n')).toBe(true);
  });
});
