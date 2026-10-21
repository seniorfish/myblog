import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFrontmatter } from '../scripts/ai/frontmatter.ts';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-ai-apply-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  await writeFile(path.join(root, 'content', 'home.md'), '首页。\n');
  await writeFile(
    path.join(root, 'content', 'home.meta.yml'),
    'tags: 首页\ntitle: 关于我\n',
  );
  await writeFile(path.join(root, 'content', 'note.md'), '一条记录。\n');
  await writeFile(path.join(root, 'content', 'note.meta.yml'), 'tags: 闪念\n');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('applyFrontmatter', () => {
  it('rolls back a change that creates a second homepage node', async () => {
    const root = await tempRoot();
    const meta = path.join(root, 'content', 'note.meta.yml');
    const body = path.join(root, 'content', 'note.md');
    const beforeMeta = await readFile(meta, 'utf8');
    const beforeBody = await readFile(body, 'utf8');

    await expect(
      applyFrontmatter(
        root,
        'content/note.md',
        { tags: ['首页'] },
        ['tags'],
        { force: true },
      ),
    ).rejects.toThrow(/validation|homepage/iu);

    expect(await readFile(meta, 'utf8')).toBe(beforeMeta);
    expect(await readFile(body, 'utf8')).toBe(beforeBody);
  });

  it('writes metadata without touching the body', async () => {
    const root = await tempRoot();
    const body = path.join(root, 'content', 'note.md');
    const beforeBody = await readFile(body, 'utf8');

    const result = await applyFrontmatter(
      root,
      'content/note.md',
      { description: '简短摘要。' },
      ['description'],
    );

    expect(result.applied).toEqual(['description']);
    expect(await readFile(body, 'utf8')).toBe(beforeBody);
    expect(await readFile(path.join(root, 'content', 'note.meta.yml'), 'utf8')).toContain(
      'description: 简短摘要。',
    );
  });
});
