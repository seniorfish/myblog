import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnchorInfo,
  BuildMeta,
  CompileIssue,
  ContentNode,
  NodeProof,
  NodeRef,
  RevisionProof,
  SearchIndex,
  SiteConfig,
  SiteData,
  SiteMeta,
} from './contract.ts';
import { computeAnchorCoverage, resolveAnchorTimes, toAnchorInfo } from './anchors.ts';
import { loadSiteConfig } from './config.ts';
import { discoverContent, type ParsedContent } from './content.ts';
import { formatDisplayDate, truncateText } from './format.ts';
import {
  getFileAtCommit,
  getFileDiff,
  getFileHistory,
  getFirstParentCommitList,
  getHeadCommit,
  getMergeCommits,
  getWorkingStatus,
  isGitRepository,
  isWorkingTreeClean,
  readAnchorNotes,
} from './git.ts';
import { sha256Hex, shortHash } from './hash.ts';
import { renderMarkdown } from './markdown.ts';
import { buildTree } from './tree.ts';

export interface CompileOptions {
  root: string;
  /** Defaults to <root>/build/generated. */
  outDir?: string;
  /** CI should set this to true to reject uncommitted content. */
  requireCleanWorktree?: boolean;
  /** Test/embedding override; defaults to loading <root>/site.config.ts. */
  config?: SiteConfig;
}

export interface CompileResult {
  ok: boolean;
  issues: CompileIssue[];
  outDir: string;
  siteData?: SiteData;
  buildMeta?: BuildMeta;
}

function nodeUrl(id: string): string {
  return `/n/${id.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function toNodeRef(node: ContentNode): NodeRef {
  return {
    id: node.id,
    url: node.url,
    title: node.title,
    displayTitle: node.displayTitle,
    primaryTag: node.primaryTag,
    timestamp: node.updatedAt,
    unverified: !node.isVerified,
  };
}

function bookmarkHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function cdata(value: string): string {
  return `<![CDATA[${value.replace(/\]\]>/gu, ']]]]><![CDATA[>')}]]>`;
}

function itemTitle(node: ContentNode): string {
  return node.title ?? `[${node.primaryTag}] ${node.displayTitle}`;
}

function renderRss(site: SiteMeta, nodes: ContentNode[]): string {
  const items = nodes
    .map((node) => {
      const link = `${site.url}${node.url}`;
      const pubDate = new Date(node.displayTime * 1000).toUTCString();
      const parent = node.parent
        ? `<blockquote>前情提要：<a href="${site.url}${node.parent.url}">《${escapeXml(
            node.parent.displayTitle,
          )}》</a></blockquote>`
        : '';
      const external = node.externalUrl
        ? `<p><a href="${escapeXml(node.externalUrl)}">${escapeXml(node.externalUrl)}</a></p>`
        : '';
      const content = `${parent}${node.html}${external}`;

      return [
        '    <item>',
        `      <title>${escapeXml(itemTitle(node))}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <description>${escapeXml(node.excerpt || node.externalUrl || '')}</description>`,
        `      <content:encoded>${cdata(content)}</content:encoded>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${escapeXml(site.title)}</title>`,
    `    <link>${escapeXml(site.url)}/</link>`,
    `    <description>${escapeXml(site.description)}</description>`,
    `    <language>${escapeXml(site.lang)}</language>`,
    `    <atom:link href="${escapeXml(site.url)}/rss.xml" rel="self" type="application/rss+xml"/>`,
    `    <lastBuildDate>${new Date(site.builtAt).toUTCString()}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function renderSitemap(site: SiteMeta, nodes: ContentNode[]): string {
  const newest = nodes[0]?.displayDate.iso ?? site.builtAt.slice(0, 10);
  const urls = [
    `  <url><loc>${escapeXml(`${site.url}/`)}</loc><lastmod>${newest}</lastmod></url>`,
    ...nodes.map(
      (node) =>
        `  <url><loc>${escapeXml(`${site.url}${node.url}`)}</loc><lastmod>${node.displayDate.iso}</lastmod></url>`,
    ),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

function renderRobots(site: SiteMeta): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /raw/',
    'Disallow: /proof/',
    'Disallow: /_themes/',
    `Sitemap: ${site.url}/sitemap.xml`,
    '',
  ].join('\n');
}

async function writeOutputFiles(
  outDir: string,
  entries: Map<string, ParsedContent>,
  siteData: SiteData,
  searchIndex: SearchIndex,
  buildMeta: BuildMeta,
  config: SiteConfig,
): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const write = async (relative: string, content: string | Buffer): Promise<void> => {
    const target = path.join(outDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };

  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  await write('site-data.json', json(siteData));
  await write('search-index.json', json(searchIndex));
  await write('rss.xml', renderRss(siteData.site, siteData.nodes));
  await write('sitemap.xml', renderSitemap(siteData.site, siteData.nodes));
  await write('robots.txt', renderRobots(siteData.site));
  await write('build-meta.json', json(buildMeta));

  for (const node of siteData.nodes) {
    const entry = entries.get(node.id);
    if (!entry) continue;

    await write(`raw/${node.id}.md`, entry.raw);

    const proof: NodeProof = {
      schema: 1,
      nodeId: node.id,
      repo: siteData.site.repo,
      chain: {
        name: config.chain.name,
        chainId: config.chain.chainId,
        rpcUrl: config.chain.rpcUrl,
        explorerUrl: config.chain.explorerUrl,
      },
      revisions: node.revisions,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      isVerified: node.isVerified,
    };
    await write(`proof/${node.id}.json`, json(proof));
  }
}

function makeRevision(
  entry: ParsedContent,
  root: string,
  history: ReturnType<typeof getFileHistory>,
  warnings: string[],
): RevisionProof[] {
  if (history.length === 0) {
    const timestamp = Math.floor(entry.mtimeMs / 1000);
    return [
      {
        commit: '',
        shortCommit: '',
        message: '(untracked)',
        author: '',
        gitTimestamp: timestamp,
        diff: '',
        fileSha256: sha256Hex(entry.raw),
        anchor: null,
        verifiedAt: null,
      },
    ];
  }

  return history.map((commit) => {
    const blob = getFileAtCommit(root, commit.commit, entry.relPath);
    if (!blob) {
      warnings.push(
        `Could not read ${entry.relPath} at ${commit.commit.slice(0, 7)}; file hash is empty.`,
      );
    }

    return {
      commit: commit.commit,
      shortCommit: shortHash(commit.commit),
      message: commit.message,
      author: commit.author,
      gitTimestamp: commit.gitTimestamp,
      diff: getFileDiff(root, commit.commit, entry.relPath),
      fileSha256: blob ? sha256Hex(blob) : '',
      anchor: null,
      verifiedAt: null,
    } satisfies RevisionProof;
  });
}

export async function compileSite(options: CompileOptions): Promise<CompileResult> {
  const root = options.root;
  const outDir = options.outDir ?? path.join(root, 'build', 'generated');
  const issues: CompileIssue[] = [];

  let config: SiteConfig;
  if (options.config) {
    config = options.config;
  } else {
    try {
      config = loadSiteConfig();
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            level: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        outDir,
      };
    }
  }

  if (!isGitRepository(root)) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          message: `Not a Git repository: ${root}. Timestamps are derived from Git history.`,
        },
      ],
      outDir,
    };
  }

  const merges = getMergeCommits(root);
  if (merges.length > 0) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          message:
            'Merge commits are not supported in v1. Keep main linear (squash/rebase) so Git timestamp resolution stays simple.',
        },
      ],
      outDir,
    };
  }

  if (options.requireCleanWorktree && !isWorkingTreeClean(root)) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          message: 'Working tree is not clean. Commit or stash changes before building.',
        },
      ],
      outDir,
    };
  }

  const discovered = await discoverContent(root);
  issues.push(...discovered.issues);
  if (issues.some((issue) => issue.level === 'error')) {
    return { ok: false, issues, outDir };
  }

  const tree = buildTree(discovered.entries);
  issues.push(...tree.issues);
  if (issues.some((issue) => issue.level === 'error')) {
    return { ok: false, issues, outDir };
  }

  const warnings: string[] = [];
  const commits = getFirstParentCommitList(root);
  const notes = readAnchorNotes(root);
  warnings.push(...notes.warnings);

  const anchors = new Map<string, AnchorInfo>();
  if (config.chain.enabled) {
    for (const [commit, note] of notes.anchors) {
      anchors.set(commit, toAnchorInfo(note, config.chain.explorerUrl));
    }
  } else if (notes.anchors.size > 0) {
    warnings.push('Blockchain anchoring is disabled in site.config.ts; notes were ignored.');
  }

  const coverage = computeAnchorCoverage(commits, anchors);
  const byId = new Map<string, ContentNode>();
  const searchTexts = new Map<string, string>();

  for (const entry of discovered.entries) {
    const treeNode = tree.nodes.get(entry.id);
    if (!treeNode) continue;

    const rendered = await renderMarkdown(entry.body);
    searchTexts.set(entry.id, rendered.plainText);
    const status = getWorkingStatus(root, entry.relPath);
    const history = getFileHistory(root, entry.relPath);
    const revisions = makeRevision(entry, root, history, warnings);
    const times = resolveAnchorTimes(revisions, coverage, entry.mtimeMs);

    const autoTitle = truncateText(rendered.plainText || entry.id, 20);
    const displayTitle =
      entry.frontmatter.title ??
      bookmarkHost(entry.frontmatter.url) ??
      autoTitle;

    const node: ContentNode = {
      id: entry.id,
      url: nodeUrl(entry.id),
      rawTags: treeNode.rawTags,
      primaryTag: treeNode.primaryTag,
      secondaryTags: treeNode.secondaryTags,
      title: entry.frontmatter.title,
      displayTitle,
      description: entry.frontmatter.description,
      externalUrl: entry.frontmatter.url,
      html: rendered.html,
      headings: rendered.headings,
      excerpt: entry.frontmatter.description ?? rendered.excerpt,
      plainTextLength: rendered.plainTextLength,
      readingTime: rendered.readingTime,
      createdAt: times.createdAt,
      updatedAt: times.updatedAt,
      displayTime: times.displayTime,
      displayDate: formatDisplayDate(times.displayTime, config.timezone),
      isVerified: times.isVerified,
      isDirty: status.dirty,
      isUntracked: status.untracked,
      revisions: times.revisions,
      ancestors: [],
      children: [],
      treeRootId: treeNode.rootId,
      aliases: treeNode.aliases,
      git: {
        path: entry.relPath,
        latestCommit: history[0]?.commit ?? null,
        latestGitTimestamp: history[0]?.gitTimestamp ?? Math.floor(entry.mtimeMs / 1000),
      },
    };

    if (treeNode.parentId) {
      // Filled after all nodes exist.
      node.parent = undefined;
    }

    byId.set(entry.id, node);
  }

  for (const node of byId.values()) {
    const treeNode = tree.nodes.get(node.id);
    if (!treeNode) continue;

    if (treeNode.parentId) {
      const parent = byId.get(treeNode.parentId);
      if (parent) node.parent = toNodeRef(parent);
    }

    node.ancestors = treeNode.ancestorIds
      .map((id) => byId.get(id))
      .filter((value): value is ContentNode => Boolean(value))
      .map(toNodeRef);

    node.children = treeNode.childIds
      .map((id) => byId.get(id))
      .filter(
        (value): value is ContentNode =>
          Boolean(value) && !(tree.nodes.get(value!.id)?.draft ?? false),
      )
      .sort(
        (a, b) =>
          a.displayTime - b.displayTime ||
          (a.git.latestGitTimestamp ?? 0) - (b.git.latestGitTimestamp ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map(toNodeRef);
  }

  const publishedNodes = [...byId.values()]
    .filter((node) => !(tree.nodes.get(node.id)?.draft ?? false))
    .sort(
      (a, b) =>
        b.displayTime - a.displayTime ||
        (b.git.latestGitTimestamp ?? 0) - (a.git.latestGitTimestamp ?? 0) ||
        a.id.localeCompare(b.id),
    );

  if (publishedNodes.length === 0) {
    warnings.push('No published content nodes were found.');
  }

  const contentHash = sha256Hex(
    JSON.stringify({
      schema: 1,
      config,
      nodes: publishedNodes,
    }),
  );
  const buildId = contentHash.slice(0, 16);
  const builtAt = new Date().toISOString();

  const site: SiteMeta = {
    title: config.title,
    description: config.description,
    author: config.author,
    url: config.url,
    lang: config.lang,
    timezone: config.timezone,
    repo: config.repo,
    buildId,
    builtAt,
    ui: config.ui,
  };

  const siteData: SiteData = {
    schema: 1,
    site,
    nodes: publishedNodes,
  };

  const searchIndex: SearchIndex = {
    schema: 1,
    docs: publishedNodes.map((node) => ({
      id: node.id,
      url: node.url,
      title: itemTitle(node),
      tags: [node.primaryTag, ...node.secondaryTags],
      text: searchTexts.get(node.id) ?? node.excerpt,
      time: node.displayTime,
    })),
  };

  const buildMeta: BuildMeta = {
    schema: 1,
    buildId,
    contentHash,
    contentCommit: getHeadCommit(root),
    generatedAt: builtAt,
    nodeCount: publishedNodes.length,
    warnings,
  };

  const entriesById = new Map(discovered.entries.map((entry) => [entry.id, entry]));
  await writeOutputFiles(outDir, entriesById, siteData, searchIndex, buildMeta, config);

  return { ok: true, issues, outDir, siteData, buildMeta };
}
