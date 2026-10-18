import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadSiteConfig } from '../../core/config.ts';
import type { CompileIssue, SiteConfig } from '../../core/contract.ts';
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

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

function candidateId(relPath: string): string {
  return relPath.replace(/^content\//u, '').replace(/\.md$/iu, '');
}

function isContentMarkdown(relPath: string): boolean {
  const normalized = toPosix(relPath);
  return normalized.startsWith('content/') && normalized.toLowerCase().endsWith('.md');
}

function candidateKind(entry: GitStatusEntry): CandidateKind {
  if (entry.untracked) return 'untracked';
  if (entry.renamed) return 'renamed';
  if (entry.deleted) return 'deleted';
  return 'modified';
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

  const contentStatus = git.status.filter((entry) => isContentMarkdown(entry.path));
  const candidatesByPath = new Map<string, Candidate>();

  for (const entry of contentStatus) {
    const relPath = toPosix(entry.path);
    if (candidatesByPath.has(relPath)) continue;

    const kind = candidateKind(entry);
    const absPath = path.join(root, relPath);
    const exists = kind !== 'deleted' && existsSync(absPath);
    const candidate: Candidate = {
      path: relPath,
      id: candidateId(relPath),
      kind,
      exists,
      staged: entry.staged,
      isTemplate: isTemplateId(candidateId(relPath)),
      errors: [],
      warnings: [],
    };

    if (exists) {
      try {
        const normalized = await normalizeContentFile(root, relPath);
        fixes.push(...normalized.map((fix) => `${relPath}: ${fix}`));
      } catch {
        // A malformed file is reported below by the shared validator.
      }

      try {
        const raw = await readRawContentFile(root, relPath);
        candidate.data = raw.data;
        candidate.body = raw.body;
        if (hasTemplateMarker(raw.body)) candidate.isTemplate = true;
      } catch (error) {
        candidate.readError = error instanceof Error ? error.message : String(error);
      }
    }

    candidatesByPath.set(relPath, candidate);
  }

  const validation = await validateContent(root, config, { allowReservedId: true });
  const candidatePaths = new Set(candidatesByPath.keys());

  for (const candidate of candidatesByPath.values()) {
    candidate.errors = validation.issues.filter(
      (issue) => issue.level === 'error' && issue.file === candidate.path,
    );
    candidate.warnings = validation.issues.filter(
      (issue) => issue.level === 'warning' && issue.file === candidate.path,
    );

    if (candidate.readError) {
      candidate.errors.push({
        level: 'error',
        file: candidate.path,
        message: candidate.readError,
      });
    }
  }

  const globalErrors = validation.issues.filter(
    (issue) =>
      issue.level === 'error' &&
      (!issue.file || !candidatePaths.has(issue.file)),
  );

  const blockers: string[] = [];
  if (!repo) blockers.push(`Not a Git repository: ${root}`);
  if (repo && git.detached) blockers.push('HEAD is detached; switch back to main.');
  if (repo && !git.detached && git.branch !== 'main') {
    blockers.push(`Current branch is "${git.branch}"; content is committed on main only.`);
  }
  if (git.operation) blockers.push(`A Git ${git.operation} is in progress.`);
  if (git.status.some((entry) => entry.unmerged)) {
    blockers.push('There are unresolved merge conflicts.');
  }
  if (git.mergeCommits.length > 0) {
    blockers.push('Main contains merge commits; squash/rebase to keep history linear.');
  }

  for (const issue of globalErrors) {
    blockers.push(issue.message);
  }

  for (const candidate of candidatesByPath.values()) {
    if (candidate.kind === 'renamed') {
      blockers.push(`${candidate.path}: renaming content changes its id. Use a new file with aliases instead.`);
    }
    if (candidate.kind === 'deleted') {
      blockers.push(`${candidate.path}: deleting content is destructive and needs a manual review.`);
    }
    if (candidate.id === 'new-blog' && (candidate.staged || candidate.kind !== 'untracked')) {
      blockers.push(`${candidate.path}: new-blog.md is a template id and cannot be committed.`);
    }
  }

  const notes: string[] = [];
  const nonContentChanges = git.status.filter((entry) => !isContentMarkdown(entry.path));
  if (nonContentChanges.length > 0) {
    notes.push(`${nonContentChanges.length} non-content change(s) will be left untouched.`);
  }
  if (git.remotes.length === 0) notes.push('No Git remote configured; push is unavailable.');
  if (git.behind > 0) notes.push(`Branch is behind the upstream by ${git.behind} commit(s).`);
  if (git.ahead > 0) notes.push(`Branch is ahead of the upstream by ${git.ahead} commit(s).`);

  const candidates = [...candidatesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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
