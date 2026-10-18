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
  await writeFile(
    path.join(root, 'content', 'home.md'),
    '---\ntags: 首页\ntitle: 关于我\n---\n\n首页。\n',
  );
  await writeFile(
    path.join(root, 'content', 'note.md'),
    '---\ntags: 闪念\n---\n\n一条记录。\n',
  );
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
    const file = path.join(root, 'content', 'note.md');
    const before = await readFile(file, 'utf8');

    await expect(
      applyFrontmatter(
        root,
        'content/note.md',
        { tags: ['首页'] },
        ['tags'],
        { force: true },
      ),
    ).rejects.toThrow(/validation|homepage/iu);

    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
