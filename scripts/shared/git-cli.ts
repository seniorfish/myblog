import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface GitStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
  deleted: boolean;
  renamed: boolean;
  unmerged: boolean;
}

export interface GitContext {
  branch: string;
  detached: boolean;
  operation: string | null;
  status: GitStatusEntry[];
  mergeCommits: string[];
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  remotes: string[];
  head: string | null;
  gitDir: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = 'GitError';
  }
}

function runGit(
  root: string,
  args: string[],
  options: { allowFailure?: boolean; encoding?: 'utf8' | 'buffer' } = {},
): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string;
  } catch (error) {
    if (options.allowFailure) return '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr)
        : error instanceof Error
          ? error.message
          : String(error);
    throw new GitError(stderr.trim() || `git ${args.join(' ')} failed`, args);
  }
}

export function tryGit(root: string, args: string[]): string | null {
  try {
    return runGit(root, args, { allowFailure: true }).trim();
  } catch {
    return null;
  }
}

export function isGitRepository(root: string): boolean {
  return tryGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function getGitDir(root: string): string {
  const value = tryGit(root, ['rev-parse', '--git-dir']) ?? '.git';
  return path.isAbsolute(value) ? value : path.join(root, value);
}

/** Read `git status --porcelain=v1 -z`; rename entries use "new\0old\0". */
export function readGitStatus(root: string): GitStatusEntry[] {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }).toString('utf8');

  const tokens = raw.split('\0');
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const indexStatus = token[0] ?? ' ';
    const worktreeStatus = token[1] ?? ' ';
    const file = token.slice(3);
    let originalPath: string | undefined;

    if (indexStatus === 'R' || indexStatus === 'C') {
      originalPath = tokens[index + 1];
      index += 1;
    }

    const untracked = indexStatus === '?' && worktreeStatus === '?';
    entries.push({
      path: file,
      originalPath,
      indexStatus,
      worktreeStatus,
      untracked,
      staged: ![' ', '?', '!'].includes(indexStatus),
      unstaged: ![' ', '?', '!'].includes(worktreeStatus),
      deleted: indexStatus === 'D' || worktreeStatus === 'D',
      renamed: indexStatus === 'R',
      unmerged:
        indexStatus === 'U' ||
        worktreeStatus === 'U' ||
        (indexStatus === 'A' && worktreeStatus === 'A') ||
        (indexStatus === 'D' && worktreeStatus === 'D'),
    });
  }

  return entries;
}

function detectOperation(gitDir: string): string | null {
  const checks: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];

  for (const [file, label] of checks) {
    if (existsSync(path.join(gitDir, file))) return label;
  }
  return null;
}

function readAheadBehind(root: string): { ahead: number; behind: number; hasUpstream: boolean } {
  const output = runGit(
    root,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
    { allowFailure: true },
  );
  const match = output.match(/^# branch\.ab \+(\d+) -(\d+)$/mu);
  if (!match) return { ahead: 0, behind: 0, hasUpstream: false };
  return {
    ahead: Number(match[1]),
    behind: Number(match[2]),
    hasUpstream: true,
  };
}

export function readGitContext(root: string): GitContext {
  const branch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '';
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  const gitDir = getGitDir(root);
  const status = readGitStatus(root);
  const mergeCommits =
    tryGit(root, ['rev-list', '--merges', 'HEAD'])
      ?.split('\n')
      .filter(Boolean) ?? [];
  const remotes =
    tryGit(root, ['remote'])
      ?.split('\n')
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const { ahead, behind, hasUpstream } = readAheadBehind(root);

  return {
    branch,
    detached: !branch || branch === 'HEAD',
    operation: detectOperation(gitDir),
    status,
    mergeCommits,
    ahead,
    behind,
    hasUpstream,
    remotes,
    head,
    gitDir,
  };
}

export function stagePath(root: string, relPath: string): void {
  runGit(root, ['add', '-A', '--', relPath]);
}

export function commitPath(root: string, relPath: string, message: string): string {
  stagePath(root, relPath);
  runGit(root, ['commit', '--only', '-m', message, '--', relPath]);
  return tryGit(root, ['rev-parse', 'HEAD']) ?? '';
}

export function pullFfOnly(root: string): string {
  runGit(root, ['pull', '--ff-only']);
  return tryGit(root, ['rev-parse', '--short', 'HEAD']) ?? '';
}

export function pushChanges(root: string): string {
  const remotes =
    tryGit(root, ['remote'])
      ?.split('\n')
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new GitError('No Git remote is configured.', ['push']);

  const upstream = tryGit(root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);

  if (upstream) {
    runGit(root, ['push']);
  } else {
    runGit(root, ['push', '-u', remote, 'HEAD']);
  }

  return upstream ?? `${remote}/${tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD'}`;
}

export function getFileAtHead(root: string, relPath: string): string | null {
  const output = runGit(root, ['show', `HEAD:${relPath}`], { allowFailure: true });
  return output.trim() ? output : null;
}

export function isWorkingTreeClean(root: string): boolean {
  return readGitStatus(root).length === 0;
}
