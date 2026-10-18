import type { CompileIssue, SiteConfig } from './contract.ts';
import { discoverContent, type ParsedContent } from './content.ts';
import { buildTree, type TreeResult } from './tree.ts';

export interface ContentValidation {
  ok: boolean;
  issues: CompileIssue[];
  entries: ParsedContent[];
  tree: TreeResult;
  homeEntries: ParsedContent[];
}

export interface ValidateContentOptions {
  /**
   * Allow `content/new-blog.md` while the interactive CLI is still working on
   * the template. Committed builds must not allow it.
   */
  allowReservedId?: boolean;
}

const RESERVED_IDS = new Set(['new-blog']);

/**
 * Validate content without rendering Markdown or reading Git history.
 * This is the shared fast path for editor tooling and pre-commit checks.
 */
export async function validateContent(
  root: string,
  config: SiteConfig,
  options: ValidateContentOptions = {},
): Promise<ContentValidation> {
  const discovered = await discoverContent(root);
  const issues: CompileIssue[] = [...discovered.issues];

  const tree = buildTree(discovered.entries);
  issues.push(...tree.issues);

  if (!options.allowReservedId) {
    for (const entry of discovered.entries) {
      if (RESERVED_IDS.has(entry.id)) {
        issues.push({
          level: 'error',
          file: entry.relPath,
          field: 'id',
          message: `"${entry.id}" is reserved for the new-post template. Rename the file before committing.`,
        });
      }
    }
  }

  const homeEntries = discovered.entries.filter(
    (entry) =>
      entry.tags.primaryTag === config.homeTag &&
      !(entry.frontmatter.draft ?? false),
  );

  if (homeEntries.length > 1) {
    issues.push({
      level: 'error',
      message: `Multiple homepage nodes use the "${config.homeTag}" tag: ${homeEntries
        .map((entry) => entry.relPath)
        .join(', ')}. Keep exactly one.`,
    });
  }

  for (const entry of discovered.entries) {
    if (
      entry.tags.primaryTag === config.homeTag &&
      (entry.frontmatter.draft ?? false)
    ) {
      issues.push({
        level: 'warning',
        file: entry.relPath,
        field: 'draft',
        message: 'The homepage node is a draft; the site will not render a homepage.',
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    issues,
    entries: discovered.entries,
    tree,
    homeEntries,
  };
}
