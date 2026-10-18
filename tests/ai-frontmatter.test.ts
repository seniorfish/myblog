import { describe, expect, it } from 'vitest';
import {
  defaultFields,
  formatProposal,
  mergeFrontmatter,
} from '../scripts/ai/frontmatter.ts';

describe('defaultFields', () => {
  it('fills missing tags and description', () => {
    expect(defaultFields({})).toEqual(['tags', 'description']);
  });

  it('adds title for an article without a title', () => {
    expect(defaultFields({ tags: '文章 建站', description: '摘要' })).toEqual(['title']);
  });

  it('does not add title for a flash note', () => {
    expect(defaultFields({ tags: '闪念 日常', description: '摘要' })).toEqual([]);
  });
});

describe('mergeFrontmatter', () => {
  it('fills missing fields without overwriting existing ones', () => {
    const result = mergeFrontmatter(
      { tags: '想法', title: '已有标题' },
      {
        tags: ['想法', '硬件'],
        title: '新标题',
        description: '新摘要',
        extends: null,
        url: null,
      },
      ['tags', 'title', 'description'],
      false,
    );

    expect(result.applied).toEqual(['description']);
    expect(result.data.tags).toBe('想法');
    expect(result.data.title).toBe('已有标题');
    expect(result.data.description).toBe('新摘要');
  });

  it('overwrites when force is enabled', () => {
    const result = mergeFrontmatter(
      { tags: '想法', title: '旧标题' },
      { tags: ['想法', '硬件'], title: '新标题' },
      ['tags', 'title'],
      true,
    );

    expect(result.applied).toEqual(['tags', 'title']);
    expect(result.data.tags).toEqual(['想法', '硬件']);
    expect(result.data.title).toBe('新标题');
  });

  it('writes a confirmed extends id', () => {
    const result = mergeFrontmatter(
      {},
      { extends: { id: 'pi-intro', confidence: 0.9, reason: '延续' } },
      ['extends'],
      false,
    );
    expect(result.data.extends).toBe('pi-intro');
  });
});

describe('formatProposal', () => {
  it('shows tags, description, and a parent reason', () => {
    const text = formatProposal(
      {
        tags: ['想法', '硬件'],
        title: null,
        description: '一句话摘要。',
        extends: { id: 'pi-intro', confidence: 0.82, reason: '延续散热话题' },
        url: null,
        reasons: { tags: '主题匹配' },
      },
      ['tags', 'title', 'description', 'extends'],
    );

    expect(text).toContain('tags: 想法 硬件');
    expect(text).toContain('description: 一句话摘要。');
    expect(text).toContain('extends: pi-intro');
    expect(text).toContain('title: （不生成）');
  });
});
