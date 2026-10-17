import { describe, expect, it } from 'vitest';
import type { ParsedContent } from '../core/content.ts';
import { buildTree } from '../core/tree.ts';

interface EntryOptions {
  extends?: string;
  aliases?: string[];
  draft?: boolean;
  primaryTag?: string;
}

function makeEntry(id: string, options: EntryOptions = {}): ParsedContent {
  const primaryTag = options.primaryTag ?? '文章';
  return {
    id,
    relPath: `content/${id}.md`,
    absPath: '',
    raw: Buffer.from(''),
    body: '',
    frontmatter: {
      tags: primaryTag,
      ...(options.extends ? { extends: options.extends } : {}),
      ...(options.aliases ? { aliases: options.aliases } : {}),
      ...(options.draft !== undefined ? { draft: options.draft } : {}),
    },
    tags: {
      rawTags: primaryTag,
      primaryTag,
      secondaryTags: [],
    },
    mtimeMs: 0,
  };
}

describe('buildTree', () => {
  it('links parents, ancestors, children, and roots', () => {
    const result = buildTree([
      makeEntry('root'),
      makeEntry('child', { extends: 'root' }),
      makeEntry('grandchild', { extends: 'child' }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.nodes.get('child')?.parentId).toBe('root');
    expect(result.nodes.get('grandchild')?.ancestorIds).toEqual(['root', 'child']);
    expect(result.nodes.get('grandchild')?.rootId).toBe('root');
    expect(result.nodes.get('root')?.childIds).toEqual(['child']);
    expect(result.nodes.get('child')?.childIds).toEqual(['grandchild']);
  });

  it('resolves aliases', () => {
    const result = buildTree([
      makeEntry('root', { aliases: ['old-root'] }),
      makeEntry('child', { extends: 'old-root' }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.nodes.get('child')?.parentId).toBe('root');
  });

  it('reports dangling parents with suggestions', () => {
    const result = buildTree([
      makeEntry('pi-intro'),
      makeEntry('child', { extends: 'pi-intr' }),
    ]);

    const issue = result.issues.find((entry) => entry.message.includes('Cannot find parent'));
    expect(issue).toBeDefined();
    expect(issue?.suggestion).toContain('pi-intro');
  });

  it('detects cycles', () => {
    const result = buildTree([
      makeEntry('a', { extends: 'b' }),
      makeEntry('b', { extends: 'a' }),
    ]);

    expect(result.issues.some((entry) => entry.message.includes('Cycle detected'))).toBe(true);
  });

  it('rejects self references', () => {
    const result = buildTree([makeEntry('a', { extends: 'a' })]);
    expect(result.issues.some((entry) => entry.message.includes('cannot extend itself'))).toBe(
      true,
    );
  });

  it('rejects duplicate aliases', () => {
    const result = buildTree([
      makeEntry('a', { aliases: ['shared'] }),
      makeEntry('b', { aliases: ['shared'] }),
    ]);

    expect(result.issues.some((entry) => entry.message.includes('already used'))).toBe(true);
  });

  it('rejects published nodes extending drafts', () => {
    const result = buildTree([
      makeEntry('draft', { draft: true }),
      makeEntry('published', { extends: 'draft' }),
    ]);

    expect(result.issues.some((entry) => entry.message.includes('draft'))).toBe(true);
  });
});
