import { nodeIdFromPath } from '../../core/metadata.ts';
import type { RawContentFile } from '../shared/content-file.ts';
import type { ChatMessage } from './client.ts';
import type { FrontmatterField, LanguageMode, LanguageOutput } from './schemas.ts';
import { tagStatsText, type AiContext } from './context.ts';

function currentMetadata(target: RawContentFile): string {
  return JSON.stringify(target.data, null, 2);
}

function targetBlock(target: RawContentFile): string {
  return [
    `<target file="${target.relPath}">`,
    '<current_metadata>',
    currentMetadata(target),
    '</current_metadata>',
    '<body>',
    target.body,
    '</body>',
    '</target>',
  ].join('\n');
}

export function buildFrontmatterMessages(
  context: AiContext,
  target: RawContentFile,
  fields: FrontmatterField[],
): ChatMessage[] {
  const system = [
    'You are a careful metadata assistant for a Chinese personal blog.',
    'Return exactly one JSON object. Do not wrap it in Markdown fences. Do not explain.',
    '',
    'Allowed output keys: tags, title, description, extends, url, reasons.',
    'Return null for any field that is not requested or that you cannot infer from the body.',
    '',
    'Rules:',
    '- Never invent dates or date-like fields. Dates come from Git and blockchain anchors.',
    `- tags is an array of 1-4 strings. The first string is the primary tag. Prefer existing tags from the tag index. Known primary tags: ${context.knownPrimaryTags.join(', ')}.`,
    '- If the current primary tag is the homepage tag, tags must be exactly that one tag.',
    '- title should be a concise Chinese title (<= 40 characters) for article-like notes. For short thoughts or flashes, return null unless a title already exists.',
    '- description should be one Chinese sentence (40-80 characters) based only on the body. If the body is too short to summarize, return null.',
    '- extends must be an object {"id": "...", "confidence": 0.0-1.0, "reason": "..."} only when the body clearly continues an existing node. The id must come from the node index. Otherwise return null.',
    '- url must be an external URL that actually appears in the body, and only for bookmark-like notes. Otherwise return null.',
    '- reasons is optional: a short Chinese explanation per field, keyed by field name.',
    '',
    'Output shape:',
    '{"tags": ["主Tag", "次Tag"] | null, "title": "..." | null, "description": "..." | null, "extends": {"id":"...","confidence":0.8,"reason":"..."} | null, "url": "https://..." | null, "reasons": {"tags":"...","description":"..."}}',
  ].join('\n');

  const nodeIndex = context.nodes
    .map((node) =>
      [
        `- ${node.id}`,
        `primary=${node.primaryTag}`,
        `title=${node.title ?? '(none)'}`,
        `description=${node.description ?? '(none)'}`,
        `excerpt=${node.excerpt || '(empty)'}`,
        `extends=${node.extends ?? '(none)'}`,
        `draft=${node.draft ? 'yes' : 'no'}`,
      ].join(' | '),
    )
    .join('\n');

  const user = [
    '<content_guide>',
    context.contentGuide.slice(0, 20_000),
    '</content_guide>',
    '<tag_index>',
    tagStatsText(context),
    '</tag_index>',
    '<node_index>',
    nodeIndex,
    '</node_index>',
    targetBlock(target),
    `<requested_fields>${fields.join(', ')}</requested_fields>`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const MODE_RULES: Record<LanguageMode, string> = {
  proofread: 'Fix typos, punctuation, and obvious grammar mistakes. Make the smallest possible edits.',
  concise: 'Remove redundancy and tighten sentences without losing meaning or facts.',
  formal: 'Make the prose more formal and written, without becoming bureaucratic.',
  casual: 'Make the prose more natural and conversational, without adding slang or new facts.',
};

export function buildLanguageMessages(
  context: AiContext,
  target: RawContentFile,
  mode: LanguageMode,
  output: LanguageOutput,
): ChatMessage[] {
  const outputRule =
    output === 'advice'
      ? 'Return suggestions only. Set rewritten to null.'
      : 'Return the full rewritten body in rewritten. Keep suggestions as a short list of what changed.';

  const system = [
    'You are a careful Chinese prose editor for a personal blog.',
    'Return exactly one JSON object. Do not wrap it in Markdown fences. Do not explain outside the JSON.',
    '',
    `Task: ${MODE_RULES[mode]}`,
    outputRule,
    '',
    'Safety rules:',
    '- Do not add facts, opinions, names, numbers, links, or claims that are not in the original body.',
    '- Do not modify YAML metadata or add a frontmatter block.',
    '- Do not modify fenced code blocks, inline code, HTML, or link URLs.',
    '- Preserve Markdown structure, headings, lists, tables, and blockquotes.',
    '- Keep the author’s voice; do not over-edit.',
    '- If the prose is already fine, return no suggestions and, for rewrite mode, return the original body unchanged.',
    '',
    'Output shape:',
    '{"suggestions": [{"quote": "exact original text", "replacement": "suggested text", "reason": "short Chinese reason"}], "rewritten": "full body" | null}',
  ].join('\n');

  const user = [
    '<content_guide>',
    context.contentGuide.slice(0, 15_000),
    '</content_guide>',
    `<mode>${mode}</mode>`,
    `<output>${output}</output>`,
    targetBlock(target),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Node ids the AI must not reuse; the current node is listed separately. */
function existingIdsText(context: AiContext, currentId: string): string {
  return [...context.ids]
    .filter((id) => id !== currentId)
    .sort()
    .join('\n');
}

export function buildSlugMessages(
  context: AiContext,
  target: RawContentFile,
): ChatMessage[] {
  const currentId = nodeIdFromPath(target.relPath);

  const system = [
    'You propose URL-safe node ids (slugs) for a Chinese personal blog whose content is written in Markdown.',
    'Return exactly one JSON object. Do not wrap it in Markdown fences. Do not explain outside the JSON.',
    '',
    'Rules for the id:',
    '- ASCII only, lowercase, kebab-case words separated by single hyphens.',
    '- 2-5 words, 6-48 characters total.',
    '- Romanized Mandarin pinyin or concise English, whichever reads better for the topic.',
    '- Describe the subject of the text, not its genre, date, or version. No dates, no numbers unless they are part of the topic.',
    '- Never return an id listed in <existing_ids>, and never return "new-blog".',
    '- Prefer nouns that a reader could guess from the article.',
    '',
    'Also return 2-4 alternative ids that follow the same rules.',
    'reason must be one short Chinese sentence explaining the choice.',
    '',
    'Output shape:',
    '{"id": "example-slug", "alternatives": ["other-slug", "third-slug"], "reason": "中文理由"}',
  ].join('\n');

  const user = [
    '<content_guide>',
    context.contentGuide.slice(0, 10_000),
    '</content_guide>',
    `<current_id>${currentId}</current_id>`,
    '<existing_ids>',
    existingIdsText(context, currentId),
    '</existing_ids>',
    targetBlock(target),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
