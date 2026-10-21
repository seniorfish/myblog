import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadSiteConfig } from '../../core/config.ts';
import type { CompileIssue, SiteConfig } from '../../core/contract.ts';
import { isMarkdownPath, isMetaPath, metaRelPathFor, nodeIdFromPath } from '../../core/metadata.ts';
import { validateContent, type ContentValidation } from '../../core/validate.ts';
import {
  hasTemplateMarker,
  isTemplateId,
  normalizeContentFile,
  readRawContentFile,
} from '../shared/content-file.ts';
import {
  isGitRepository,
  readGitContext,
  type GitContext,
  type GitStatusEntry,
} from '../shared/git-cli.ts';

export type CandidateKind = 'untracked' | 'modified' | 'deleted' | 'renamed';

export interface Candidate {
  path: string;
  metaPath: string;
  id: string;
  kind: CandidateKind;
  exists: boolean;
  staged: boolean;
  isTemplate: boolean;
  data?: Record<string, unknown>;
  body?: string;
  errors: CompileIssue[];
  warnings: CompileIssue[];
  readError?: string;
}

export interface BlogState {
  root: string;
  config: SiteConfig;
  git: GitContext;
  validation: ContentValidation;
  candidates: Candidate[];
  globalErrors: CompileIssue[];
  blockers: string[];
  notes: string[];
  fixes: string[];
  canCommit: boolean;
}

const KIND_PRIORITY: Record<CandidateKind, number> = {
  untracked: 1,
  modified: 2,
  renamed: 3,
  deleted: 4,
};

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

function candidateId(relPath: string): string {
  return nodeIdFromPath(toPosix(relPath));
}

function isContentPath(relPath: string): boolean {
  const normalized = toPosix(relPath);
  return (
    normalized.startsWith('content/') &&
    (isMarkdownPath(normalized) || isMetaPath(normalized))
  );
}

function candidateKind(entry: GitStatusEntry): CandidateKind {
  if (entry.untracked) return 'untracked';
  if (entry.renamed) return 'renamed';
  if (entry.deleted) return 'deleted';
  return 'modified';
}

function strongerKind(left: CandidateKind, right: CandidateKind): CandidateKind {
  return KIND_PRIORITY[left] >= KIND_PRIORITY[right] ? left : right;
}

function issueKey(issue: CompileIssue): string {
  return `${issue.level}|${issue.file ?? ''}|${issue.field ?? ''}|${issue.message}`;
}

function isEmptyGitContext(): GitContext {
  return {
    branch: '',
    detached: false,
    operation: null,
    status: [],
    mergeCommits: [],
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    remotes: [],
    head: null,
    gitDir: '',
  };
}

export async function gatherBlogState(root: string): Promise<BlogState> {
  const config = loadSiteConfig();
  const repo = isGitRepository(root);
  const git = repo ? readGitContext(root) : isEmptyGitContext();
  const fixes: string[] = [];

  const contentStatus = git.status.filter((entry) => isContentPath(entry.path));
  const candidatesById = new Map<string, Candidate>();

  for (const entry of contentStatus) {
    const relPath = toPosix(entry.path);
    const id = candidateId(relPath);
    const bodyPath = `content/${id}.md`;
    const metaPath = metaRelPathFor(bodyPath);
    const kind = candidateKind(entry);

    const existing = candidatesById.get(id);
    if (existing) {
      existing.kind = strongerKind(existing.kind, kind);
      existing.staged = existing.staged || entry.staged;
      existing.exists = existing.exists || existsSync(path.join(root, bodyPath));
      continue;
    }

    const bodyExists = existsSync(path.join(root, bodyPath));
    const candidate: Candidate = {
      path: bodyPath,
      metaPath,
      id,
      kind,
      exists: bodyExists,
      staged: entry.staged,
      isTemplate: isTemplateId(id),
      errors: [],
      warnings: [],
    };

    if (bodyExists) {
      try {
        const normalized = await normalizeContentFile(root, bodyPath);
        fixes.push(...normalized.map((fix) => `${bodyPath}: ${fix}`));
      } catch {
        // A malformed file is reported below by the shared validator.
      }

      try {
        const raw = await readRawContentFile(root, bodyPath);
        candidate.data = raw.data;
        candidate.body = raw.body;
        if (hasTemplateMarker(raw.body)) candidate.isTemplate = true;
      } catch (error) {
        candidate.readError = error instanceof Error ? error.message : String(error);
      }
    }

    candidatesById.set(id, candidate);
  }

  const validation = await validateContent(root, config, { allowReservedId: true });
  const globalErrors: CompileIssue[] = [];

  for (const issue of validation.issues) {
    const candidate = issue.file ? candidatesById.get(candidateId(issue.file)) : undefined;
    if (candidate) {
      if (issue.level === 'error') candidate.errors.push(issue);
      else candidate.warnings.push(issue);
      continue;
    }
    if (issue.level === 'error') globalErrors.push(issue);
  }

  for (const candidate of candidatesById.values()) {
    if (candidate.readError) {
      candidate.errors.push({
        level: 'error',
        file: candidate.path,
        message: candidate.readError,
      });
    }
  }

  const blockers: string[] = [];
  if (!repo) blockers.push(`不是 Git 仓库：${root}`);
  if (repo && git.detached) blockers.push('HEAD 处于 detached 状态；请切回 main。');
  if (repo && !git.detached && git.branch !== 'main') {
    blockers.push(`当前分支是 "${git.branch}"；内容只能在 main 上提交。`);
  }
  if (git.operation) blockers.push(`Git ${git.operation} 正在进行中。`);
  if (git.status.some((entry) => entry.unmerged)) {
    blockers.push('还有未解决的合并冲突。');
  }
  if (git.mergeCommits.length > 0) {
    blockers.push('main 历史里有 merge commit；请先 squash/rebase 保持线性历史。');
  }

  for (const issue of globalErrors) {
    blockers.push(issue.message);
  }

  for (const candidate of candidatesById.values()) {
    if (candidate.kind === 'renamed') {
      blockers.push(`${candidate.path}：重命名会改变节点 id，请用新文件 + aliases。`);
    }
    if (candidate.kind === 'deleted') {
      blockers.push(`${candidate.path}：删除内容有破坏性，需要手动确认。`);
    }
    if (candidate.id === 'new-blog' && (candidate.staged || candidate.kind !== 'untracked')) {
      blockers.push(`${candidate.path}：new-blog.md 是模板保留 id，不能提交。`);
    }
  }

  const notes: string[] = [];
  const nonContentChanges = git.status.filter((entry) => !isContentPath(entry.path));
  if (nonContentChanges.length > 0) {
    notes.push(`有 ${nonContentChanges.length} 个非内容改动，本次不会处理。`);
  }
  if (git.remotes.length === 0) notes.push('没有配置 Git 远端；push 不可用。');
  if (git.behind > 0) notes.push(`分支落后远端 ${git.behind} 个提交。`);
  if (git.ahead > 0) notes.push(`分支领先远端 ${git.ahead} 个提交。`);

  const candidates = [...candidatesById.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const candidateErrors = candidates.some((candidate) => candidate.errors.length > 0);
  const canCommit = blockers.length === 0 && !candidateErrors;

  return {
    root,
    config,
    git,
    validation,
    candidates,
    globalErrors,
    blockers,
    notes,
    fixes,
    canCommit,
  };
}

export function describeCandidate(candidate: Candidate): string {
  const kind =
    candidate.kind === 'untracked'
      ? 'untracked'
      : candidate.kind === 'modified'
        ? candidate.staged
          ? 'staged'
          : 'modified'
        : candidate.kind;
  return `${candidate.path} (${kind})`;
}

export function issueLabels(issues: CompileIssue[]): string[] {
  return issues.map((issue) => {
    const field = issue.field ? ` [${issue.field}]` : '';
    return `${issue.level}${field}: ${issue.message}`;
  });
}

export function errorKeys(issues: CompileIssue[]): Set<string> {
  return new Set(
    issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => issueKey(issue)),
  );
}
