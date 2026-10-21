import { describe, expect, it } from 'vitest';
import {
  hasFrontmatterDelimiter,
  metaRelPathFor,
  nodeIdFromPath,
  parseMetadataSource,
  serializeMetadata,
} from '../core/metadata.ts';

describe('metadata paths', () => {
  it('maps body paths to sidecar paths and ids', () => {
    expect(metaRelPathFor('content/hello.md')).toBe('content/hello.meta.yml');
    expect(metaRelPathFor('content/notes/a.md')).toBe('content/notes/a.meta.yml');
    expect(nodeIdFromPath('content/notes/a.md')).toBe('notes/a');
    expect(nodeIdFromPath('content/notes/a.meta.yml')).toBe('notes/a');
  });

  it('detects frontmatter delimiters, including after a BOM', () => {
    expect(hasFrontmatterDelimiter('---\nkey: value\n---\n')).toBe(true);
    expect(hasFrontmatterDelimiter('﻿---\nkey: value\n---\n')).toBe(true);
    expect(hasFrontmatterDelimiter('\n---\n')).toBe(false);
  });
});

describe('parseMetadataSource', () => {
  it('accepts YAML 1.2 scalars', () => {
    const data = parseMetadataSource('tags: 文章\ntitle: No\n');
    expect(data.title).toBe('No');
  });

  it('rejects forbidden fields', () => {
    expect(() => parseMetadataSource('tags: 文章\ndate: 2024-01-01\n')).toThrowError(
      /not allowed/,
    );
  });

  it('rejects non-mapping YAML', () => {
    expect(() => parseMetadataSource('- one\n- two\n')).toThrowError(/mapping/);
  });
});

describe('serializeMetadata', () => {
  it('keeps a stable key order and literal block scalars', () => {
    const text = serializeMetadata({
      description: '第一行。\n第二行。',
      tags: '想法',
      title: '标题',
    });

    expect(text).toBe('tags: 想法\ntitle: 标题\ndescription: |-\n  第一行。\n  第二行。\n');
  });

  it('round-trips through the parser', () => {
    const data = { tags: '收藏 工具', title: '标题: 带冒号', draft: false };
    expect(parseMetadataSource(serializeMetadata(data))).toMatchObject(data);
  });
});
