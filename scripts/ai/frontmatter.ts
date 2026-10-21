import { rm } from 'node:fs/promises';
import { loadSiteConfig } from '../../core/config.ts';
import { nodeIdFromPath } from '../../core/metadata.ts';
import { normalizeTags } from '../../core/schema.ts';
import { validateContent } from '../../core/validate.ts';
import { sha256Hex } from '../../core/hash.ts';
import type { CompileIssue } from '../../core/contract.ts';
import {
  getPrimaryTag,
  inspectFrontmatter,
  readRawContentFile,
  writeMetadataFile,
  type RawContentFile,
} from '../shared/content-file.ts';
import { chatJson, type AiUsage } from './client.ts';
import { buildAiContext, type AiContext } from './context.ts';
import { buildFrontmatterMessages } from './prompts.ts';
import {
  FRONTMATTER_FIELDS,
  frontmatterProposalSchema,
  type FrontmatterField,
  type FrontmatterProposal,
} from './schemas.ts';

export interface FrontmatterGeneration {
  proposal: FrontmatterProposal;
  warnings: string[];
  cached: boolean;
  model: string;
  usage?: AiUsage;
  fileHash: string;
}

export interface ApplyResult {
  applied: FrontmatterField[];
  warnings: string[];
}

export function defaultFields(data: Record<string, unknown>): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  if (!data.tags) fields.push('tags');
  if (!data.description) fields.push('description');
  if (!data.title && getPrimaryTag(data) === '文章') fields.push('title');
  return fields;
}

export function currentFieldHint(
  data: Record<string, unknown>,
  field: FrontmatterField,
): string {
  const value = data[field];
  if (value === undefined || value === null || value === '') return '当前：未设置';
  if (field === 'extends' && typeof value === 'string') return `当前：${value}`;
  if (field === 'tags') {
    try {
      return `当前：${normalizeTags(value as string | string[]).rawTags}`;
    } catch {
      return '当前：格式有误';
    }
  }
  return `当前：${String(value)}`;
}

function contentPairHash(target: RawContentFile): string {
  return sha256Hex(`${target.raw}\u0000${target.metaRaw}`);
}

function trimLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || null;
}

function normalizeProposal(
  proposal: FrontmatterProposal,
  context: AiContext,
  target: RawContentFile,
): { proposal: FrontmatterProposal; warnings: string[] } {
  const warnings: string[] = [];
  const next: FrontmatterProposal = { ...proposal };

  if (typeof proposal.tags === 'string' || Array.isArray(proposal.tags)) {
    try {
      const tags = normalizeTags(proposal.tags);
      next.tags = [tags.primaryTag, ...tags.secondaryTags];
      if (next.tags.length > 4) {
        warnings.push(`AI suggested ${next.tags.length} tags; consider keeping 2-4.`);
      }
    } catch {
      next.tags = null;
      warnings.push('AI returned empty tags; ignored.');
    }
  } else {
    next.tags = null;
  }

  next.title = trimLine(proposal.title);
  next.description = trimLine(proposal.description);

  if (proposal.url) {
    try {
      const url = new URL(proposal.url);
      next.url = target.body.includes(url.toString()) ? url.toString() : null;
      if (!next.url) warnings.push('AI suggested a URL that is not in the body; ignored.');
    } catch {
      next.url = null;
      warnings.push('AI suggested an invalid URL; ignored.');
    }
  } else {
    next.url = null;
  }

  if (proposal.extends) {
    const id = proposal.extends.id.trim();
    if (id === nodeIdFromPath(target.relPath)) {
      next.extends = null;
      warnings.push('AI suggested the node itself as parent; ignored.');
    } else if (!context.ids.has(id)) {
      next.extends = null;
      warnings.push(`AI suggested unknown parent "${id}"; ignored.`);
    } else if (proposal.extends.confidence < 0.6) {
      next.extends = { ...proposal.extends, id };
      warnings.push(
        `AI parent suggestion "${id}" has low confidence (${proposal.extends.confidence.toFixed(2)}).`,
      );
    } else {
      next.extends = { ...proposal.extends, id };
    }
  } else {
    next.extends = null;
  }

  return { proposal: next, warnings };
}

export async function generateFrontmatter(
  root: string,
  relPath: string,
  fields: FrontmatterField[],
  options: { noCache?: boolean } = {},
): Promise<FrontmatterGeneration> {
  const target = await readRawContentFile(root, relPath);
  const inspected = inspectFrontmatter(target.data);
  if (inspected.issues.length > 0) {
    throw new Error(`Cannot edit malformed metadata: ${inspected.issues.join(' ')}`);
  }

  const context = await buildAiContext(root);
  const messages = buildFrontmatterMessages(context, target, fields);
  const result = await chatJson({
    root,
    messages,
    maxTokens: 1_800,
    cacheKey: `frontmatter:v1:${fields.join(',')}:${contentPairHash(target)}`,
    noCache: options.noCache,
    parse: (value) => frontmatterProposalSchema.parse(value),
  });

  const normalized = normalizeProposal(result.data, context, target);

  return {
    proposal: normalized.proposal,
    warnings: normalized.warnings,
    cached: result.cached,
    model: result.model,
    usage: result.usage,
    fileHash: contentPairHash(target),
  };
}

export function mergeFrontmatter(
  current: Record<string, unknown>,
  proposal: FrontmatterProposal,
  fields: FrontmatterField[],
  force: boolean,
): { data: Record<string, unknown>; applied: FrontmatterField[] } {
  const data = { ...current };
  const applied: FrontmatterField[] = [];

  for (const field of fields) {
    if (field === 'tags') {
      if (!proposal.tags || proposal.tags.length === 0) continue;
      if (data.tags && !force) continue;
      data.tags = proposal.tags;
      applied.push(field);
      continue;
    }

    if (field === 'extends') {
      if (!proposal.extends?.id) continue;
      if (data.extends && !force) continue;
      data.extends = proposal.extends.id;
      applied.push(field);
      continue;
    }

    const value =
      field === 'title'
        ? proposal.title
        : field === 'description'
          ? proposal.description
          : field === 'url'
            ? proposal.url
            : null;

    if (!value) continue;
    if (data[field] && !force) continue;
    data[field] = value;
    applied.push(field);
  }

  return { data, applied };
}

function issueKeys(issues: CompileIssue[]): Set<string> {
  return new Set(
    issues
      .filter((issue) => issue.level === 'error')
      .map(
        (issue) =>
          `${issue.file ?? ''}|${issue.field ?? ''}|${issue.message}`,
      ),
  );
}

export async function applyFrontmatter(
  root: string,
  relPath: string,
  proposal: FrontmatterProposal,
  fields: FrontmatterField[],
  options: { force?: boolean; expectedHash?: string } = {},
): Promise<ApplyResult> {
  const current = await readRawContentFile(root, relPath);
  const currentHash = contentPairHash(current);
  if (options.expectedHash && options.expectedHash !== currentHash) {
    throw new Error('The file changed while the AI was thinking. Regenerate the proposal.');
  }

  const merged = mergeFrontmatter(current.data, proposal, fields, options.force ?? false);
  if (merged.applied.length === 0) {
    return { applied: [], warnings: ['No missing fields to fill.'] };
  }

  const config = loadSiteConfig();
  const before = await validateContent(root, config, { allowReservedId: true });
  const beforeKeys = issueKeys(before.issues);

  await writeMetadataFile(root, relPath, merged.data);
  const after = await validateContent(root, config, { allowReservedId: true });
  const newErrors = after.issues.filter(
    (issue) =>
      issue.level === 'error' &&
      !beforeKeys.has(`${issue.file ?? ''}|${issue.field ?? ''}|${issue.message}`),
  );

  if (newErrors.length > 0) {
    if (current.metaExists) {
      await writeMetadataFile(root, relPath, current.data);
    } else {
      await rm(current.metaAbsPath, { force: true });
    }
    throw new Error(
      `Metadata was rolled back because validation failed: ${newErrors
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  return { applied: merged.applied, warnings: [] };
}

export function formatProposal(
  proposal: FrontmatterProposal,
  fields: FrontmatterField[],
): string {
  const lines: string[] = [];

  for (const field of fields) {
    if (field === 'extends') {
      if (!proposal.extends) continue;
      lines.push(
        `extends: ${proposal.extends.id} (置信度 ${proposal.extends.confidence.toFixed(2)}) — ${proposal.extends.reason}`,
      );
      continue;
    }

    const value =
      field === 'tags'
        ? Array.isArray(proposal.tags)
          ? proposal.tags.join(' ')
          : proposal.tags
        : field === 'title'
          ? proposal.title
          : field === 'description'
            ? proposal.description
            : field === 'url'
              ? proposal.url
              : null;

    if (!value) {
      lines.push(`${field}: （不生成）`);
      continue;
    }

    lines.push(`${field}: ${value}`);
    const reason = proposal.reasons?.[field];
    if (reason) lines.push(`  理由：${reason}`);
  }

  return lines.join('\n') || '（没有可用的建议）';
}

export function availableFields(): readonly FrontmatterField[] {
  return FRONTMATTER_FIELDS;
}
