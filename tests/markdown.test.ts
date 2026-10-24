import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../core/markdown.ts';

describe('renderMarkdown', () => {
  it('renders GFM tables and extracts headings', async () => {
    const result = await renderMarkdown(
      '## Hello\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    );

    expect(result.html).toContain('<table>');
    expect(result.headings).toEqual([{ depth: 2, text: 'Hello', slug: 'hello' }]);
  });

  it('renders GitHub alerts', async () => {
    const result = await renderMarkdown('> [!NOTE]\n> Useful information');
    expect(result.html).toContain('markdown-alert-note');
    expect(result.html).toContain('markdown-alert-title');
  });

  it('highlights code with light-dark colors', async () => {
    const result = await renderMarkdown('```ts\nconst answer = 42;\n```');
    expect(result.html).toContain('shiki');
    expect(result.html).toContain('light-dark(');
  });

  it('falls back to text for unknown languages', async () => {
    const result = await renderMarkdown('```foobar\nhello\n```');
    expect(result.html).toContain('hello');
    expect(result.html).toContain('shiki');
  });

  it('renders inline math as MathJax SVG', async () => {
    const formula = String.raw`$T_{\text{old}}$`;
    const result = await renderMarkdown(`Inline ${formula} math.`);

    expect(result.html).toContain('<mjx-container');
    expect(result.html).toContain('<svg');
    expect(result.html).not.toContain(formula);
    expect(result.html).not.toContain(String.raw`\text{old}`);
    expect(result.plainText).not.toContain('mjx-container');
  });

  it('renders display math as a block MathJax SVG', async () => {
    const result = await renderMarkdown(String.raw`$$
S = \frac{T_{\text{old}}}{T_{\text{new}}}
$$`);

    expect(result.html).toContain('<mjx-container');
    expect(result.html).toMatch(/<mjx-container[^>]*display="true"/);
    expect(result.html).toContain('<svg');
    expect(result.html).not.toContain(String.raw`\frac`);
  });

  it('keeps dollar signs inside fenced code blocks literal', async () => {
    const fence = '```';
    const literal = String.raw`const value = "$T_{\text{old}}$";`;
    const result = await renderMarkdown([`${fence}text`, literal, fence].join('\n'));

    expect(result.html).not.toContain('<mjx-container');
    expect(result.html).toContain('$T_');
    expect(result.html).toContain(String.raw`\text{old}`);
  });

  it('computes excerpt, plain text, and reading time', async () => {
    const result = await renderMarkdown('第一段。\n\n第二段。');

    expect(result.excerpt).toBe('第一段。');
    expect(result.plainText).toContain('第一段。');
    expect(result.plainTextLength).toBeGreaterThan(0);
    expect(result.readingTime).toBe(1);
  });
});
