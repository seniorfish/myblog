import { loadSiteConfig } from '../../core/config.ts';
import { sha256Hex } from '../../core/hash.ts';
import { validateContent } from '../../core/validate.ts';
import { renderDiff } from '../shared/diff.ts';
import { readRawContentFile, writeContentFile } from '../shared/content-file.ts';
import { chatJson, type AiUsage } from './client.ts';
import { buildAiContext } from './context.ts';
import { buildLanguageMessages } from './prompts.ts';
import {
  languageProposalSchema,
  type LanguageMode,
  type LanguageOutput,
  type LanguageProposal,
} from './schemas.ts';

export interface LanguageGeneration {
  proposal: LanguageProposal;
  cached: boolean;
  model: string;
  usage?: AiUsage;
  fileHash: string;
  diff: ReturnType<typeof renderDiff>;
}

function countFences(text: string): number {
  return (text.match(/```/gu) ?? []).length;
}

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,6}\s+/u.test(line))
    .map((line) => line.trim());
}

function assertSafeRewrite(mode: LanguageMode, before: string, after: string): void {
  if (after.trimStart().startsWith('---')) {
    throw new Error('AI returned a body that looks like frontmatter; refusing to apply.');
  }

  const beforeHeadings = headings(before);
  const afterHeadings = new Set(headings(after));
  const missing = beforeHeadings.filter((heading) => !afterHeadings.has(heading));
  if (missing.length > 0) {
    throw new Error(`AI dropped heading(s): ${missing.join(' | ')}. Refusing to apply.`);
  }

  const ratio = after.trim().length / Math.max(1, before.trim().length);
  const minimum = mode === 'concise' ? 0.5 : 0.8;
  if (ratio < minimum) {
    throw new Error(
      `AI rewrite is much shorter than the original (${Math.round(ratio * 100)}%); refusing to apply.`,
    );
  }
}

export async function generateLanguage(
  root: string,
  relPath: string,
  mode: LanguageMode,
  output: LanguageOutput,
  options: { noCache?: boolean } = {},
): Promise<LanguageGeneration> {
  const target = await readRawContentFile(root, relPath);
  const context = await buildAiContext(root);
  const messages = buildLanguageMessages(context, target, mode, output);
  const result = await chatJson({
    root,
    messages,
    maxTokens: 4_000,
    cacheKey: `language:v1:${mode}:${output}:${sha256Hex(target.raw)}`,
    noCache: options.noCache,
    parse: (value) => languageProposalSchema.parse(value),
  });

  const rewritten = result.data.rewritten?.trim()
    ? result.data.rewritten
    : null;

  if (output === 'rewrite' && rewritten) {
    if (countFences(rewritten) !== countFences(target.body)) {
      throw new Error(
        'AI changed the number of fenced code blocks; refusing to apply. Try a narrower edit.',
      );
    }
    assertSafeRewrite(mode, target.body, rewritten);
  }

  const diff = renderDiff(target.body, rewritten ?? target.body);

  return {
    proposal: result.data,
    cached: result.cached,
    model: result.model,
    usage: result.usage,
    fileHash: sha256Hex(target.raw),
    diff,
  };
}

export async function applyLanguage(
  root: string,
  relPath: string,
  proposal: LanguageProposal,
  options: { expectedHash?: string } = {},
): Promise<string> {
  const current = await readRawContentFile(root, relPath);
  if (options.expectedHash && sha256Hex(current.raw) !== options.expectedHash) {
    throw new Error('The file changed while the AI was thinking. Regenerate the proposal.');
  }

  const rewritten = proposal.rewritten;
  if (!rewritten?.trim()) throw new Error('No rewritten body to apply.');

  const config = loadSiteConfig();
  const before = await validateContent(root, config, { allowReservedId: true });
  const beforeKeys = new Set(
    before.issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => `${issue.file ?? ''}|${issue.field ?? ''}|${issue.message}`),
  );

  await writeContentFile(root, relPath, current.data, rewritten);
  const after = await validateContent(root, config, { allowReservedId: true });
  const newErrors = after.issues.filter(
    (issue) =>
      issue.level === 'error' &&
      !beforeKeys.has(`${issue.file ?? ''}|${issue.field ?? ''}|${issue.message}`),
  );

  if (newErrors.length > 0) {
    await writeContentFile(root, relPath, current.data, current.body);
    throw new Error('Language edit introduced new validation errors; rolled back.');
  }

  return rewritten;
}

export function formatSuggestions(proposal: LanguageProposal): string {
  if (proposal.suggestions.length === 0) return '没有发现需要修改的地方。';

  return proposal.suggestions
    .map(
      (item, index) =>
        `${index + 1}. 「${item.quote}」\n   → 「${item.replacement}」\n   理由：${item.reason}`,
    )
    .join('\n\n');
}
