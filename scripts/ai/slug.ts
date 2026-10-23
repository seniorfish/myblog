import { nodeIdFromPath } from '../../core/metadata.ts';
import { sha256Hex } from '../../core/hash.ts';
import { inspectFrontmatter, readRawContentFile, type RawContentFile } from '../shared/content-file.ts';
import { renameContentNode, slugify, uniqueSlug } from '../shared/slug.ts';
import { chatJson, type AiUsage } from './client.ts';
import { buildAiContext, type AiContext } from './context.ts';
import { buildSlugMessages } from './prompts.ts';
import { slugProposalSchema, type SlugProposal } from './schemas.ts';

export const RESERVED_IDS = new Set(['new-blog']);

export interface SlugNormalization {
  /** Sanitized candidates; the first one is the primary suggestion. */
  candidates: string[];
  /** Candidate resolved against existing ids, or null when none survived. */
  resolved: string | null;
  /** True when the resolved id equals the node's current id. */
  unchanged: boolean;
  warnings: string[];
}

export interface SlugGeneration extends SlugNormalization {
  proposal: SlugProposal;
  currentId: string;
  cached: boolean;
  model: string;
  usage?: AiUsage;
  fileHash: string;
}

function contentPairHash(target: RawContentFile): string {
  return sha256Hex(`${target.raw}\u0000${target.metaRaw}`);
}

/** Resolve `id` against `taken`, mirroring uniqueSlug() without touching disk. */
function resolveAgainst(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${id}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${id}-${sha256Hex(id).slice(0, 4)}`;
}

export function normalizeSlugProposal(
  proposal: SlugProposal,
  ids: Set<string>,
  currentId: string,
): SlugNormalization {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const raw of [proposal.id ?? '', ...proposal.alternatives]) {
    const slug = slugify(raw);
    if (!slug) {
      if (raw.trim()) warnings.push(`Ignored non-ASCII id "${raw.trim()}"; ids must use ASCII letters or digits.`);
      continue;
    }
    if (RESERVED_IDS.has(slug)) {
      warnings.push(`Ignored reserved id "${slug}".`);
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    candidates.push(slug);
  }

  const taken = new Set(ids);
  taken.delete(currentId);

  if (candidates.length === 0) {
    return {
      candidates,
      resolved: null,
      unchanged: false,
      warnings: [
        ...warnings,
        'AI did not return a usable ASCII id. Pass --id to set one manually.',
      ],
    };
  }

  const primary = candidates[0] ?? '';
  const resolved = resolveAgainst(primary, taken);
  if (resolved !== primary) {
    warnings.push(`Id "${primary}" is already taken; resolved to "${resolved}".`);
  }

  return {
    candidates,
    resolved,
    unchanged: resolved === currentId,
    warnings,
  };
}

export async function generateSlug(
  root: string,
  relPath: string,
  options: { noCache?: boolean } = {},
): Promise<SlugGeneration> {
  const target = await readRawContentFile(root, relPath);
  const inspected = inspectFrontmatter(target.data);
  if (inspected.issues.length > 0) {
    throw new Error(`Cannot suggest an id for malformed metadata: ${inspected.issues.join(' ')}`);
  }

  const context: AiContext = await buildAiContext(root);
  const currentId = nodeIdFromPath(target.relPath);
  const result = await chatJson({
    root,
    messages: buildSlugMessages(context, target),
    maxTokens: 700,
    cacheKey: `slug:v1:${contentPairHash(target)}`,
    noCache: options.noCache,
    parse: (value) => slugProposalSchema.parse(value),
  });

  const normalized = normalizeSlugProposal(result.data, context.ids, currentId);

  return {
    ...normalized,
    proposal: result.data,
    currentId,
    cached: result.cached,
    model: result.model,
    usage: result.usage,
    fileHash: contentPairHash(target),
  };
}

export interface SlugApplyResult {
  from: string;
  to: string;
  renamed: boolean;
}

export async function applySlugRename(
  root: string,
  relPath: string,
  nextId: string,
  options: { expectedHash?: string } = {},
): Promise<SlugApplyResult> {
  const current = await readRawContentFile(root, relPath);
  if (options.expectedHash && options.expectedHash !== contentPairHash(current)) {
    throw new Error('The file changed while the AI was thinking. Regenerate the proposal.');
  }

  const currentId = nodeIdFromPath(current.relPath);
  if (slugify(nextId) === currentId) {
    return { from: current.relPath, to: current.relPath, renamed: false };
  }

  const id = await uniqueSlug(root, nextId, currentId);
  const to = await renameContentNode(root, current.relPath, id, currentId);
  return { from: current.relPath, to, renamed: to !== current.relPath };
}

export function formatSlugProposal(
  generation: Pick<SlugGeneration, 'proposal' | 'candidates' | 'resolved' | 'unchanged' | 'currentId'>,
): string {
  const lines = [
    `当前：${generation.currentId}`,
    `建议：${generation.resolved ?? '（无合法 id）'}`,
  ];

  if (generation.resolved && generation.unchanged) {
    lines.push('  与当前 id 相同，无需改名。');
  }

  const alternatives = generation.candidates.filter((item) => item !== generation.candidates[0]);
  if (alternatives.length > 0) lines.push(`备选：${alternatives.join(', ')}`);
  if (generation.proposal.reason) lines.push(`理由：${generation.proposal.reason}`);

  return lines.join('\n');
}
