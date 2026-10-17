import { describe, expect, it } from 'vitest';
import { FrontmatterError, normalizeTags, parseFrontmatter } from '../core/schema.ts';

describe('parseFrontmatter', () => {
  it('accepts supported fields', () => {
    const fm = parseFrontmatter({
      tags: '想法 树莓派 硬件',
      title: '标题',
      extends: 'pi-intro',
      description: '摘要',
      url: 'https://example.com',
      aliases: ['old-id'],
      draft: false,
    });

    expect(fm.title).toBe('标题');
    expect(fm.aliases).toEqual(['old-id']);
  });

  it('rejects date fields with a helpful error', () => {
    expect(() => parseFrontmatter({ tags: '文章', date: '2024-01-01' })).toThrowError(
      /not allowed/,
    );
  });

  it('rejects unknown fields', () => {
    expect(() => parseFrontmatter({ tags: '文章', titel: 'typo' })).toThrowError(
      /Unknown frontmatter/,
    );
  });

  it('rejects non-object frontmatter', () => {
    expect(() => parseFrontmatter('tags: 文章')).toThrowError(/mapping/);
  });
});

describe('normalizeTags', () => {
  it('splits whitespace, deduplicates, and keeps order', () => {
    expect(normalizeTags(' 想法  树莓派 硬件 树莓派 ')).toEqual({
      rawTags: '想法 树莓派 硬件',
      primaryTag: '想法',
      secondaryTags: ['树莓派', '硬件'],
    });
  });

  it('accepts arrays', () => {
    expect(normalizeTags(['文章', '建站'])).toEqual({
      rawTags: '文章 建站',
      primaryTag: '文章',
      secondaryTags: ['建站'],
    });
  });

  it('rejects empty tags', () => {
    expect(() => normalizeTags('   ')).toThrow(FrontmatterError);
  });
});
