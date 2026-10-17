import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import rehypeShiki from '@shikijs/rehype';
import { remarkAlert } from 'remark-github-blockquote-alert';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { toString } from 'hast-util-to-string';
import { visit } from 'unist-util-visit';
import type { Element, Root as HastRoot } from 'hast';
import type { Root as MdastRoot } from 'mdast';
import { contentReadingTime, plainTextLength, truncateText } from './format.ts';

const KNOWN_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'docker',
  'go',
  'html',
  'ini',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'markdown',
  'md',
  'plaintext',
  'python',
  'py',
  'rs',
  'rust',
  'sh',
  'shell',
  'sql',
  'text',
  'toml',
  'ts',
  'tsx',
  'txt',
  'typescript',
  'xml',
  'yaml',
  'yml',
]);

/** Unknown code fences fall back to plain text instead of failing the build. */
function normalizeCodeLanguages() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'code') return;
      const className = node.properties?.className;
      if (!Array.isArray(className)) return;

      const languageClass = className.find(
        (item): item is string => typeof item === 'string' && item.startsWith('language-'),
      );
      if (!languageClass) return;

      const language = languageClass.slice('language-'.length).toLowerCase();
      if (KNOWN_LANGUAGES.has(language)) return;

      node.properties.className = className.map((item) =>
        item === languageClass ? 'language-text' : item,
      );
    });
  };
}

export interface Heading {
  depth: number;
  text: string;
  slug: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
  plainText: string;
  excerpt: string;
  plainTextLength: number;
  readingTime: number;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkAlert)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(normalizeCodeLanguages)
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, { behavior: 'wrap' })
  .use(rehypeShiki, {
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
    defaultColor: 'light-dark()',
  })
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<RenderedMarkdown> {
  const mdast = processor.parse(body) as MdastRoot;
  const hast = (await processor.run(mdast)) as HastRoot;
  const html = processor.stringify(hast);

  const headings: Heading[] = [];
  visit(hast, 'element', (node: Element) => {
    if (node.tagName !== 'h2' && node.tagName !== 'h3' && node.tagName !== 'h4') return;
    const text = toString(node).trim();
    if (!text) return;
    const id = node.properties?.id;
    headings.push({
      depth: Number(node.tagName.slice(1)),
      text,
      slug: typeof id === 'string' ? id : '',
    });
  });

  const plainText = toString(hast).replace(/\s+/gu, ' ').trim();

  let firstParagraph = '';
  visit(hast, 'element', (node: Element) => {
    if (firstParagraph || node.tagName !== 'p') return;
    firstParagraph = toString(node).replace(/\s+/gu, ' ').trim();
  });

  const excerpt = firstParagraph
    ? truncateText(firstParagraph, 120)
    : truncateText(plainText, 120);

  return {
    html,
    headings,
    plainText,
    excerpt,
    plainTextLength: plainTextLength(plainText),
    readingTime: contentReadingTime(plainText),
  };
}
