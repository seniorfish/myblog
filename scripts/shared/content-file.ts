import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
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
export const TEMPLATE_SOURCE = 'templates/new-blog.md';

export interface RawContentFile {
  root: string;
  relPath: string;
  absPath: string;
  raw: string;
  body: string;
  data: Record<string, unknown>;
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

export async function readRawContentFile(
  root: string,
  relPath: string,
): Promise<RawContentFile> {
  const normalized = normalizeRelPath(relPath);
  const absPath = path.join(root, normalized);
  let raw = await readFile(absPath, 'utf8');
  const fixes: string[] = [];

  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
    fixes.push('removed BOM');
  }

  const parsed = matter(raw);
  const cleaned = cleanData(parsed.data as Record<string, unknown>);

  return {
    root,
    relPath: normalized,
    absPath,
    raw,
    body: parsed.content,
    data: cleaned.data,
    fixes: [...fixes, ...cleaned.fixes],
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
 * Validate a frontmatter object without requiring `tags`. This is used while
 * the AI is filling in a fresh note whose tags are still missing.
 */
export function inspectFrontmatter(data: Record<string, unknown>): InspectResult {
  const issues: string[] = [];

  for (const key of FORBIDDEN_DATE_KEYS) {
    if (key in data) {
      issues.push(`Frontmatter field "${key}" is not allowed; dates come from Git and chain anchors.`);
    }
  }

  const unknown = Object.keys(data).filter(
    (key) =>
      !(ALLOWED_FRONTMATTER_KEYS as readonly string[]).includes(key) &&
      !(FORBIDDEN_DATE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    issues.push(
      `Unknown frontmatter field(s): ${unknown.join(', ')}. Allowed: ${ALLOWED_FRONTMATTER_KEYS.join(', ')}.`,
    );
  }

  if (issues.length > 0) return { data, issues };

  const result = frontmatterSchema.partial().safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    issues.push(
      first
        ? `${first.path.join('.') || 'frontmatter'}: ${first.message}`
        : result.error.message,
    );
  }

  return { data, issues };
}

function orderData(data: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of ALLOWED_FRONTMATTER_KEYS) {
    if (key in data) ordered[key] = data[key];
  }
  // Preserve unknown keys so a later validation can report them instead of
  // silently dropping user data.
  for (const [key, value] of Object.entries(data)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

export function serializeContent(data: Record<string, unknown>, body: string): string {
  const normalizedBody =
    body.length > 0 && !body.startsWith('\n') ? `\n${body}` : body;
  const text = matter.stringify(normalizedBody, orderData(data));
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function writeContentFile(
  root: string,
  relPath: string,
  data: Record<string, unknown>,
  body: string,
): Promise<void> {
  const normalized = normalizeRelPath(relPath);
  const absPath = path.join(root, normalized);
  const tempPath = `${absPath}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tempPath, serializeContent(data, body), 'utf8');
  await rename(tempPath, absPath);
}

export async function normalizeContentFile(
  root: string,
  relPath: string,
): Promise<string[]> {
  const raw = await readRawContentFile(root, relPath);
  if (raw.fixes.length === 0) return [];
  await writeContentFile(root, raw.relPath, raw.data, raw.body);
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
