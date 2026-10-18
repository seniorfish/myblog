import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSiteConfig } from '../../core/config.ts';
import type { SiteConfig } from '../../core/contract.ts';
import { discoverContent, type ParsedContent } from '../../core/content.ts';

export interface TagStat {
  tag: string;
  count: number;
  primary: number;
  secondary: number;
}

export interface NodeSummary {
  id: string;
  primaryTag: string;
  secondaryTags: string[];
  title?: string;
  description?: string;
  excerpt: string;
  extends?: string;
  draft: boolean;
}

export interface AiContext {
  config: SiteConfig;
  contentGuide: string;
  tags: TagStat[];
  nodes: NodeSummary[];
  entries: ParsedContent[];
  knownPrimaryTags: string[];
  ids: Set<string>;
}

function plainExcerpt(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/[*_~>#-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 220);
}

function buildTagStats(entries: ParsedContent[]): TagStat[] {
  const stats = new Map<string, TagStat>();

  const add = (tag: string, primary: boolean): void => {
    const current = stats.get(tag) ?? { tag, count: 0, primary: 0, secondary: 0 };
    current.count += 1;
    if (primary) current.primary += 1;
    else current.secondary += 1;
    stats.set(tag, current);
  };

  for (const entry of entries) {
    add(entry.tags.primaryTag, true);
    for (const tag of entry.tags.secondaryTags) add(tag, false);
  }

  return [...stats.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  );
}

export async function buildAiContext(root: string): Promise<AiContext> {
  const config = loadSiteConfig();
  const discovered = await discoverContent(root);

  let contentGuide = '';
  try {
    contentGuide = await readFile(path.join(root, 'CONTENT.md'), 'utf8');
  } catch {
    // CONTENT.md is optional for the tool to work, though it is expected here.
  }

  const nodes = discovered.entries.map((entry) => ({
    id: entry.id,
    primaryTag: entry.tags.primaryTag,
    secondaryTags: entry.tags.secondaryTags,
    title: entry.frontmatter.title,
    description: entry.frontmatter.description,
    excerpt: plainExcerpt(entry.body),
    extends: entry.frontmatter.extends,
    draft: entry.frontmatter.draft ?? false,
  }));

  const knownPrimaryTags = [
    ...new Set([
      config.homeTag,
      ...Object.keys(config.ui?.contentDisplay ?? {}),
    ]),
  ];

  return {
    config,
    contentGuide,
    tags: buildTagStats(discovered.entries),
    nodes,
    entries: discovered.entries,
    knownPrimaryTags,
    ids: new Set(discovered.entries.map((entry) => entry.id)),
  };
}

export function tagStatsText(context: AiContext): string {
  return context.tags
    .map(
      (item) =>
        `${item.tag} (${item.count}; primary ${item.primary}, secondary ${item.secondary})`,
    )
    .join('\n');
}
