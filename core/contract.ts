/**
 * The single data contract shared by the compiler, themes, and runtime.
 * This file is the source of truth for every theme. Keep it stable.
 */

export type DisplayMode = 'excerpt' | 'full' | 'full-if-short' | 'link';

export interface ContentDisplayRule {
  mode: DisplayMode;
  /** Used by full-if-short. */
  maxChars?: number;
}

export interface SiteUiConfig {
  /** Display policy keyed by the primary tag. Unknown tags fall back to excerpt. */
  contentDisplay?: Record<string, ContentDisplayRule>;
}

export interface ChainConfig {
  enabled: boolean;
  name: string;
  chainId: number;
  /** Public anchor address. Never put a private key in this config. */
  address: string;
  rpcUrl: string;
  explorerUrl: string;
  confirmations?: number;
}

export interface SiteConfig {
  title: string;
  description: string;
  author: string;
  url: string;
  lang: string;
  timezone: string;
  /** GitHub repository in owner/name form. */
  repo: string;
  defaultTheme: string;
  themes: string[];
  ui?: SiteUiConfig;
  chain: ChainConfig;
}

export interface SiteMeta {
  title: string;
  description: string;
  author: string;
  url: string;
  lang: string;
  timezone: string;
  repo: string;
  buildId: string;
  builtAt: string;
  ui?: SiteUiConfig;
}

export interface NodeRef {
  id: string;
  url: string;
  title?: string;
  displayTitle: string;
  primaryTag: string;
  /** Verified anchor time in seconds, or null when unverified. */
  timestamp: number | null;
  unverified: boolean;
}

export interface AnchorInfo {
  chain: string;
  chainId: number;
  txHash: string;
  blockNumber: number;
  /** Block timestamp in seconds. */
  blockTimestamp: number;
  explorerUrl: string;
}

export interface RevisionProof {
  commit: string;
  shortCommit: string;
  message: string;
  author: string;
  /** Git committer timestamp in seconds. */
  gitTimestamp: number;
  /** Unified diff of this file for this commit. */
  diff: string;
  /** SHA-256 of the raw .md file at this commit. */
  fileSha256: string;
  anchor: AnchorInfo | null;
  /** Anchor block timestamp in seconds, or null when unverified. */
  verifiedAt: number | null;
}

export interface NodeGitInfo {
  /** Repository-relative path, e.g. content/hello.md. */
  path: string;
  latestCommit: string | null;
  latestGitTimestamp: number | null;
}

export interface NodeDisplayDate {
  /** Four-digit year in the site timezone. */
  year: string;
  /** MM-DD in the site timezone. */
  monthDay: string;
  /** YYYY-MM-DD in the site timezone. */
  iso: string;
}

export interface ContentNode {
  id: string;
  url: string;
  /** Normalized space-separated tags, e.g. "想法 树莓派 硬件". */
  rawTags: string;
  primaryTag: string;
  secondaryTags: string[];
  title?: string;
  displayTitle: string;
  description?: string;
  externalUrl?: string;
  /** Rendered HTML body. */
  html: string;
  headings: { depth: number; text: string; slug: string }[];
  excerpt: string;
  /** Plain-text character count, used by full-if-short display rules. */
  plainTextLength: number;
  /** Reading time in minutes. */
  readingTime: number;
  /** Anchor time of the first verified revision, or null. */
  createdAt: number | null;
  /** Anchor time of the latest verified revision, or null. */
  updatedAt: number | null;
  /** updatedAt when verified, otherwise the latest Git timestamp (provisional). */
  displayTime: number;
  displayDate: NodeDisplayDate;
  isVerified: boolean;
  isDirty: boolean;
  isUntracked: boolean;
  revisions: RevisionProof[];
  parent?: NodeRef;
  ancestors: NodeRef[];
  children: NodeRef[];
  treeRootId: string;
  aliases: string[];
  git: NodeGitInfo;
}

export interface SiteData {
  schema: 1;
  site: SiteMeta;
  nodes: ContentNode[];
}

export interface SearchDoc {
  id: string;
  url: string;
  title: string;
  tags: string[];
  /** Plain text used for local search. */
  text: string;
  /** Display time in seconds. */
  time: number;
}

export interface SearchIndex {
  schema: 1;
  docs: SearchDoc[];
}

export interface NodeProof {
  schema: 1;
  nodeId: string;
  repo: string;
  chain: {
    name: string;
    chainId: number;
    rpcUrl: string;
    explorerUrl: string;
  };
  revisions: RevisionProof[];
  createdAt: number | null;
  updatedAt: number | null;
  isVerified: boolean;
}

export interface BuildMeta {
  schema: 1;
  buildId: string;
  contentHash: string;
  contentCommit: string | null;
  generatedAt: string;
  nodeCount: number;
  warnings: string[];
}

export interface CompileIssue {
  level: 'error' | 'warning';
  file?: string;
  field?: string;
  message: string;
  suggestion?: string;
}
