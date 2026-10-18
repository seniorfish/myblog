import { describe, expect, it } from 'vitest';
import { buildCommitMessage, displayTitle } from '../scripts/shared/commit-message.ts';

describe('displayTitle', () => {
  it('prefers frontmatter title', () => {
    expect(displayTitle({ title: '标题' }, '正文', 'id')).toBe('标题');
  });

  it('falls back to a bookmark host', () => {
    expect(displayTitle({ url: 'https://example.com/a' }, '正文', 'id')).toBe(
      'example.com',
    );
  });

  it('falls back to body text and then id', () => {
    expect(displayTitle({}, '一段没有标题的正文。', 'id')).toBe('一段没有标题的正文。');
    expect(displayTitle({}, '   ', 'id')).toBe('id');
  });
});

describe('buildCommitMessage', () => {
  it('builds an add message with the primary tag', () => {
    expect(
      buildCommitMessage('add', { tags: '想法 硬件', title: '散热改造' }, 'body', 'cooling'),
    ).toBe('content(想法): add 散热改造');
  });

  it('builds an update message', () => {
    expect(
      buildCommitMessage('update', { tags: ['文章', '建站'], title: '标题' }, 'body', 'x'),
    ).toBe('content(文章): update 标题');
  });

  it('builds a follow-up message with the parent title', () => {
    expect(
      buildCommitMessage(
        'follow-up',
        { tags: '想法', extends: 'pi-intro' },
        'body',
        'cooling',
        '树莓派使用心得',
      ),
    ).toBe('content(想法): follow-up to 树莓派使用心得');
  });

  it('truncates long subjects', () => {
    const message = buildCommitMessage(
      'add',
      { tags: '文章', title: 'x'.repeat(120) },
      'body',
      'x',
    );
    expect(message.length).toBeLessThanOrEqual(72);
  });
});
