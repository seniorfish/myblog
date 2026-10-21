import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CompileIssue } from './contract.ts';
import {
  hasFrontmatterDelimiter,
  isMarkdownPath,
  isMetaPath,
  metaRelPathFor,
  parseMetadataSource,
  toPosixPath,
} from './metadata.ts';
import {
  FrontmatterError,
  normalizeTags,
  type Frontmatter,
  type NormalizedTags,
} from './schema.ts';

export interface ParsedContent {
  /** Stable node id: content-relative path without the .md suffix. */
  id: string;
  /** Repository-relative path, e.g. content/hello.md. */
  relPath: string;
  absPath: string;
  /** Raw bytes of the article body file. */
  raw: Buffer;
  body: string;
  /** Repository-relative path, e.g. content/hello.meta.yml. */
  metaRelPath: string;
  metaAbsPath: string;
  /** Raw bytes of the metadata sidecar. */
  metaRaw: Buffer;
  frontmatter: Frontmatter;
  tags: NormalizedTags;
  mtimeMs: number;
  metaMtimeMs: number;
}

export interface DiscoverResult {
  entries: ParsedContent[];
  issues: CompileIssue[];
}

export async function discoverContent(root: string): Promise<DiscoverResult> {
  const contentDir = path.join(root, 'content');
  const issues: CompileIssue[] = [];

  let names: string[];
  try {
    names = (await readdir(contentDir, { recursive: true })).map(toPosixPath);
  } catch {
    return {
      entries: [],
      issues: [
        {
          level: 'error',
          file: 'content/',
          message: 'Content directory was not found or could not be read.',
        },
      ],
    };
  }

  const markdownFiles = names
    .filter(isMarkdownPath)
    .sort((a, b) => a.localeCompare(b));
  const metaFiles = names.filter(isMetaPath);

  const markdownSet = new Set(markdownFiles.map((name) => `content/${name}`));
  const metaSet = new Set(metaFiles.map((name) => `content/${name}`));

  const entries: ParsedContent[] = [];

  for (const relative of markdownFiles) {
    const relPath = `content/${relative}`;
    const absPath = path.join(root, relPath);
    const id = relative.replace(/\.md$/iu, '');
    const metaRelPath = metaRelPathFor(relPath);
    const metaAbsPath = path.join(root, metaRelPath);

    let raw: Buffer;
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      [raw, fileStat] = await Promise.all([readFile(absPath), stat(absPath)]);
    } catch (error) {
      issues.push({
        level: 'error',
        file: relPath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (hasFrontmatterDelimiter(raw.toString('utf8'))) {
      issues.push({
        level: 'error',
        file: relPath,
        message: `Frontmatter is not allowed in .md files. Move these fields to ${metaRelPath}; run "npm run migrate:meta -- --write" to migrate in bulk.`,
      });
      continue;
    }

    if (!metaSet.has(metaRelPath)) {
      issues.push({
        level: 'error',
        file: relPath,
        message: `Missing metadata file ${metaRelPath}. Every article needs a sidecar with at least "tags".`,
      });
      continue;
    }

    let metaRaw: Buffer;
    let metaStat: Awaited<ReturnType<typeof stat>>;
    try {
      [metaRaw, metaStat] = await Promise.all([readFile(metaAbsPath), stat(metaAbsPath)]);
    } catch (error) {
      issues.push({
        level: 'error',
        file: metaRelPath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    try {
      const frontmatter = parseMetadataSource(metaRaw.toString('utf8'));
      const tags = normalizeTags(frontmatter.tags);

      entries.push({
        id,
        relPath,
        absPath,
        raw,
        body: raw.toString('utf8'),
        metaRelPath,
        metaAbsPath,
        metaRaw,
        frontmatter,
        tags,
        mtimeMs: fileStat.mtimeMs,
        metaMtimeMs: metaStat.mtimeMs,
      });
    } catch (error) {
      if (error instanceof FrontmatterError) {
        issues.push({
          level: 'error',
          file: metaRelPath,
          field: error.field,
          message: error.message,
        });
      } else {
        issues.push({
          level: 'error',
          file: metaRelPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (const relative of metaFiles.sort((a, b) => a.localeCompare(b))) {
    const metaRelPath = `content/${relative}`;
    const mdRelPath = metaRelPath.replace(/\.meta\.yml$/iu, '.md');
    if (markdownSet.has(mdRelPath)) continue;

    issues.push({
      level: 'error',
      file: metaRelPath,
      message: `Metadata file has no matching ${mdRelPath}.`,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, issues };
}
