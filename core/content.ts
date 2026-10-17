import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { CompileIssue } from './contract.ts';
import {
  FrontmatterError,
  normalizeTags,
  parseFrontmatter,
  type Frontmatter,
  type NormalizedTags,
} from './schema.ts';

export interface ParsedContent {
  /** Stable node id: content-relative path without the .md suffix. */
  id: string;
  /** Repository-relative path, e.g. content/hello.md. */
  relPath: string;
  absPath: string;
  raw: Buffer;
  body: string;
  frontmatter: Frontmatter;
  tags: NormalizedTags;
  mtimeMs: number;
}

export interface DiscoverResult {
  entries: ParsedContent[];
  issues: CompileIssue[];
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

export async function discoverContent(root: string): Promise<DiscoverResult> {
  const contentDir = path.join(root, 'content');
  const issues: CompileIssue[] = [];

  let names: string[];
  try {
    names = await readdir(contentDir, { recursive: true });
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
    .map((name) => toPosix(name))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));

  const entries: ParsedContent[] = [];

  for (const relative of markdownFiles) {
    const absPath = path.join(contentDir, relative);
    const relPath = toPosix(path.relative(root, absPath));
    const id = relative.replace(/\.md$/iu, '');

    try {
      const [raw, fileStat] = await Promise.all([readFile(absPath), stat(absPath)]);
      const parsed = matter(raw.toString('utf8'));
      const frontmatter = parseFrontmatter(parsed.data);
      const tags = normalizeTags(frontmatter.tags);

      entries.push({
        id,
        relPath,
        absPath,
        raw,
        body: parsed.content,
        frontmatter,
        tags,
        mtimeMs: fileStat.mtimeMs,
      });
    } catch (error) {
      if (error instanceof FrontmatterError) {
        issues.push({
          level: 'error',
          file: relPath,
          field: error.field,
          message: error.message,
        });
      } else {
        issues.push({
          level: 'error',
          file: relPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, issues };
}
