import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  ALLOWED_FRONTMATTER_KEYS,
  FrontmatterError,
  parseFrontmatter,
  type Frontmatter,
} from './schema.ts';

/** Sidecar suffix for article metadata. */
export const META_SUFFIX = '.meta.yml';

export function toPosixPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

export function isMarkdownPath(relPath: string): boolean {
  const normalized = toPosixPath(relPath).toLowerCase();
  return normalized.endsWith('.md') && !normalized.endsWith('.meta.md');
}

export function isMetaPath(relPath: string): boolean {
  return toPosixPath(relPath).toLowerCase().endsWith(META_SUFFIX);
}

/** content/foo.md -> content/foo.meta.yml */
export function metaRelPathFor(relPath: string): string {
  const normalized = toPosixPath(relPath);
  if (!isMarkdownPath(normalized)) {
    throw new Error(`Not a Markdown content path: ${relPath}`);
  }
  return normalized.replace(/\.md$/iu, META_SUFFIX);
}

/** Accepts both content/foo.md and content/foo.meta.yml. */
export function nodeIdFromPath(relPath: string): string {
  return toPosixPath(relPath)
    .replace(/^content\//u, '')
    .replace(/\.meta\.yml$/iu, '')
    .replace(/\.md$/iu, '');
}

/** True when the file starts with a YAML frontmatter delimiter. */
export function hasFrontmatterDelimiter(text: string): boolean {
  return /^---\r?\n/u.test(text.replace(/^﻿/u, ''));
}

/** Parse a sidecar as YAML without schema validation. */
export function parseMetadataYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new FrontmatterError(
      `Metadata YAML is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Parse a sidecar file as YAML and validate it with the shared schema. */
export function parseMetadataSource(text: string): Frontmatter {
  return parseFrontmatter(parseMetadataYaml(text));
}

export function orderMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of ALLOWED_FRONTMATTER_KEYS) {
    if (key in data) ordered[key] = data[key];
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

/** Serialize metadata with a stable key order and readable multiline strings. */
export function serializeMetadata(data: Record<string, unknown>): string {
  const text = stringifyYaml(orderMetadata(data), {
    lineWidth: 0,
    minContentWidth: 0,
    blockQuote: 'literal',
  });
  return text.endsWith('\n') ? text : `${text}\n`;
}
