import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  hasFrontmatterDelimiter,
  metaRelPathFor,
  parseMetadataYaml,
  serializeMetadata,
} from '../../core/metadata.ts';
import {
  ALLOWED_FRONTMATTER_KEYS,
  FORBIDDEN_DATE_KEYS,
  FrontmatterError,
  frontmatterSchema,
  normalizeTags,
  parseFrontmatter,
  type Frontmatter,
  type NormalizedTags,
} from '../../core/schema.ts';

export const TEMPLATE_MARKER = '<!-- new-blog-template -->';
export const TEMPLATE_PATH = 'content/new-blog.md';
export const TEMPLATE_META_PATH = 'content/new-blog.meta.yml';
export const TEMPLATE_SOURCE = 'templates/new-blog.md';
export const TEMPLATE_META_SOURCE = 'templates/new-blog.meta.yml';

export interface RawContentFile {
  root: string;
  relPath: string;
  absPath: string;
  /** Body text as read from disk, after BOM removal. */
  raw: string;
  /** Body text; kept as a separate name for callers that think in body terms. */
  body: string;
  data: Record<string, unknown>;
  metaRelPath: string;
  metaAbsPath: string;
  metaRaw: string;
  metaExists: boolean;
  fixes: string[];
}

export interface ParsedContentFile extends RawContentFile {
  frontmatter: Frontmatter;
  tags: NormalizedTags;
}

export interface InspectResult {
  data: Record<string, unknown>;
  issues: string[];
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

export function normalizeRelPath(relPath: string): string {
  return toPosix(relPath).replace(/^\.\.?\//u, '');
}

/** Remove fields the editor left empty; this is a safe, reportable fix. */
function cleanData(input: Record<string, unknown>): { data: Record<string, unknown>; fixes: string[] } {
  const data = { ...input };
  const fixes: string[] = [];

  for (const key of ['title', 'description', 'extends', 'url'] as const) {
    if (data[key] === null || data[key] === '') {
      delete data[key];
      fixes.push(`removed empty \`${key}\``);
    }
  }

  if (data.aliases === null) {
    delete data.aliases;
    fixes.push('removed empty `aliases`');
  }
  if (data.draft === null) {
    delete data.draft;
    fixes.push('removed empty `draft`');
  }

  if (typeof data.tags === 'string' && /[,，]/u.test(data.tags)) {
    data.tags = data.tags.replace(/[,，]/gu, ' ');
    fixes.push('normalized comma-separated `tags`');
  }

  if (Array.isArray(data.tags)) {
    const rawTokens = data.tags
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => item.split(/\s+/u))
      .filter(Boolean);
    const unique = [...new Set(rawTokens)];
    if (unique.length !== data.tags.length) {
      data.tags = unique;
      fixes.push('deduplicated `tags`');
    }
  }

  return { data, fixes };
}

async function writeAtomic(absPath: string, text: string): Promise<void> {
  const tempPath = `${absPath}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tempPath, text, 'utf8');
  await rename(tempPath, absPath);
}

function normalizeBody(body: string): string {
  return body.length === 0 || body.endsWith('\n') ? body : `${body}\n`;
}

export async function readRawContentFile(
  root: string,
  relPath: string,
): Promise<RawContentFile> {
  const normalized = normalizeRelPath(relPath);
  if (!normalized.toLowerCase().endsWith('.md')) {
    throw new Error(`Expected a Markdown body path, got: ${relPath}`);
  }

  const absPath = path.join(root, normalized);
  const metaRelPath = metaRelPathFor(normalized);
  const metaAbsPath = path.join(root, metaRelPath);
  const fixes: string[] = [];

  let raw = await readFile(absPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
    fixes.push('removed BOM');
  }

  if (hasFrontmatterDelimiter(raw)) {
    throw new Error(
      `Frontmatter is no longer supported in ${normalized}. Move those fields to ${metaRelPath}.`,
    );
  }

  let metaRaw = '';
  let metaExists = false;
  try {
    metaRaw = await readFile(metaAbsPath, 'utf8');
    metaExists = true;
  } catch {
    // A missing sidecar is reported by content validation; AI may create one.
  }

  let data: Record<string, unknown> = {};
  if (metaExists) {
    const parsed = parseMetadataYaml(metaRaw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new FrontmatterError('Metadata must be a YAML mapping.');
    }
    const cleaned = cleanData(parsed as Record<string, unknown>);
    data = cleaned.data;
    fixes.push(...cleaned.fixes);
  }

  return {
    root,
    relPath: normalized,
    absPath,
    raw,
    body: raw,
    data,
    metaRelPath,
    metaAbsPath,
    metaRaw,
    metaExists,
    fixes,
  };
}

export async function readContentFile(
  root: string,
  relPath: string,
): Promise<ParsedContentFile> {
  const raw = await readRawContentFile(root, relPath);
  const frontmatter = parseFrontmatter(raw.data);
  const tags = normalizeTags(frontmatter.tags);
  return { ...raw, frontmatter, tags };
}

/**
 * Validate a metadata object without requiring `tags`. This is used while
 * the AI is filling in a fresh note whose tags are still missing.
 */
export function inspectFrontmatter(data: Record<string, unknown>): InspectResult {
  const issues: string[] = [];

  for (const key of FORBIDDEN_DATE_KEYS) {
    if (key in data) {
      issues.push(`Metadata field "${key}" is not allowed; dates come from Git and chain anchors.`);
    }
  }

  const unknown = Object.keys(data).filter(
    (key) =>
      !(ALLOWED_FRONTMATTER_KEYS as readonly string[]).includes(key) &&
      !(FORBIDDEN_DATE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    issues.push(
      `Unknown metadata field(s): ${unknown.join(', ')}. Allowed: ${ALLOWED_FRONTMATTER_KEYS.join(', ')}.`,
    );
  }

  if (issues.length > 0) return { data, issues };

  const result = frontmatterSchema.partial().safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    issues.push(
      first
        ? `${first.path.join('.') || 'metadata'}: ${first.message}`
        : result.error.message,
    );
  }

  return { data, issues };
}

export async function writeMetadataFile(
  root: string,
  relPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  const metaRelPath = metaRelPathFor(normalizeRelPath(relPath));
  await writeAtomic(path.join(root, metaRelPath), serializeMetadata(data));
}

export async function writeBodyFile(
  root: string,
  relPath: string,
  body: string,
  options: { ensureTrailingNewline?: boolean } = {},
): Promise<void> {
  const normalized = normalizeRelPath(relPath);
  const text = options.ensureTrailingNewline === false ? body : normalizeBody(body);
  await writeAtomic(path.join(root, normalized), text);
}

export async function writeContentFile(
  root: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): Promise<void> {
  await writeMetadataFile(root, relPath, data);
  await writeBodyFile(root, relPath, body);
}

export async function normalizeContentFile(
  root: string,
  relPath: string,
): Promise<string[]> {
  const raw = await readRawContentFile(root, relPath);
  if (raw.fixes.length === 0) return [];

  const bodyFixes = raw.fixes.filter((fix) => fix === 'removed BOM');
  const metaFixes = raw.fixes.filter((fix) => fix !== 'removed BOM');

  if (metaFixes.length > 0 && raw.metaExists) {
    await writeMetadataFile(root, raw.relPath, raw.data);
  }
  if (bodyFixes.length > 0) {
    await writeBodyFile(root, raw.relPath, raw.body, { ensureTrailingNewline: false });
  }
  return raw.fixes;
}

export function hasTemplateMarker(body: string): boolean {
  return body.includes(TEMPLATE_MARKER);
}

export function isTemplateId(id: string): boolean {
  return id === 'new-blog';
}

export function getPrimaryTag(data: Record<string, unknown>): string | undefined {
  try {
    return normalizeTags(data.tags as string | string[]).primaryTag;
  } catch {
    return undefined;
  }
}

export function getFrontmatterError(error: unknown): string {
  if (error instanceof FrontmatterError) {
    return error.field ? `${error.field}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
