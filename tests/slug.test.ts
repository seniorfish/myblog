import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectExistingIds,
  makeSlug,
  renameContentNode,
  slugify,
  uniqueSlug,
} from '../scripts/shared/slug.ts';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'myblog-slug-'));
  roots.push(root);
  await mkdir(path.join(root, 'content'), { recursive: true });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('slugify', () => {
  it('creates lowercase kebab-case ids', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('Raspberry Pi 5 — Cooling')).toBe('raspberry-pi-5-cooling');
  });

  it('returns an empty string for CJK-only text', () => {
    expect(slugify('树莓派散热')).toBe('');
  });
});

describe('makeSlug', () => {
  it('falls back to a random post id', () => {
    expect(makeSlug('树莓派散热')).toMatch(/^post-[0-9a-f]{8}$/u);
  });
});

describe('uniqueSlug', () => {
  it('reads ids and aliases before assigning a slug', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'hello.md'), 'body\n');
    await writeFile(
      path.join(root, 'content', 'hello.meta.yml'),
      'tags: 文章\naliases: [old-hello]\n',
    );
    await writeFile(path.join(root, 'content', 'hello-2.md'), 'body\n');
    await writeFile(path.join(root, 'content', 'hello-2.meta.yml'), 'tags: 文章\n');

    const ids = await collectExistingIds(root);
    expect(ids.has('hello')).toBe(true);
    expect(ids.has('old-hello')).toBe(true);
    expect(await uniqueSlug(root, 'hello')).toBe('hello-3');
    expect(await uniqueSlug(root, 'hello', 'hello')).toBe('hello');
    expect(await uniqueSlug(root, 'hello', 'new-blog')).toBe('hello-3');
  });
});

describe('renameContentNode', () => {
  it('moves the body and sidecar to a free id', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'new-blog.md'), 'body\n');
    await writeFile(path.join(root, 'content', 'new-blog.meta.yml'), 'tags: 文章\n');
    await writeFile(path.join(root, 'content', 'hello.md'), 'body\n');

    const next = await renameContentNode(root, 'content/new-blog.md', 'Hello');

    expect(next).toBe('content/hello-2.md');
    await expect(readFile(path.join(root, 'content/hello-2.meta.yml'), 'utf8')).resolves.toContain(
      'tags',
    );
  });

  it('keeps the path when the id is unchanged', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'content', 'hello.md'), 'body\n');

    expect(await renameContentNode(root, 'content/hello.md', 'hello')).toBe('content/hello.md');
  });
});
