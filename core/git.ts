import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { ANCHORS_BRANCH, ANCHORS_FILE, parseAnchorIndex } from './anchor-index.ts';
import type { AnchorRecord } from './schema.ts';

export interface FileCommit {
  commit: string;
  gitTimestamp: number;
  author: string;
  message: string;
}

export interface WorkingStatus {
  dirty: boolean;
  untracked: boolean;
}

function runGitText(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
}

function tryRunGitText(args: string[], cwd: string): string | null {
  try {
    return runGitText(args, cwd);
  } catch {
    return null;
  }
}

function runGitBuffer(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
}

export function isGitRepository(root: string): boolean {
  return tryRunGitText(['rev-parse', '--is-inside-work-tree'], root)?.trim() === 'true';
}

export function getHeadCommit(root: string): string | null {
  return tryRunGitText(['rev-parse', 'HEAD'], root)?.trim() ?? null;
}

/** Oldest to newest along the first-parent chain. v1 requires a linear main. */
export function getFirstParentCommitList(root: string): string[] {
  const output = tryRunGitText(['rev-list', '--first-parent', '--reverse', 'HEAD'], root);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getMergeCommits(root: string): string[] {
  const output = tryRunGitText(['rev-list', '--merges', 'HEAD'], root);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Newest first, using --follow for rename detection. */
export function getFileHistory(root: string, relPath: string): FileCommit[] {
  const output = tryRunGitText(
    ['log', '--follow', '--format=%H%x1f%ct%x1f%an%x1f%s', '--', relPath],
    root,
  );
  if (!output) return [];

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, timestamp, author, message] = line.split('\x1f');
      if (!commit || !timestamp) return null;
      return {
        commit,
        gitTimestamp: Number(timestamp),
        author: author ?? '',
        message: message ?? '',
      } satisfies FileCommit;
    })
    .filter((entry): entry is FileCommit => entry !== null);
}

export function getFileAtCommit(
  root: string,
  commit: string,
  relPath: string,
): Buffer | null {
  try {
    return runGitBuffer(['show', `${commit}:${relPath}`], root);
  } catch {
    return null;
  }
}

export function getFileDiff(
  root: string,
  commit: string,
  relPath: string,
  maxBytes = 200_000,
): string {
  const output =
    tryRunGitText(['show', '--format=', '--patch', '--no-color', commit, '--', relPath], root) ??
    '';
  if (output.length <= maxBytes) return output;
  return `${output.slice(0, maxBytes)}\n… (diff truncated)`;
}

export function getWorkingStatus(root: string, relPath: string): WorkingStatus {
  const output = tryRunGitText(['status', '--porcelain', '--', relPath], root) ?? '';
  const line = output.split('\n').find(Boolean) ?? '';
  const untracked = line.startsWith('??');
  return {
    dirty: !untracked && line.length > 0,
    untracked,
  };
}

export function getFileMtimeMs(absPath: string): number {
  return statSync(absPath).mtimeMs;
}

export interface ReadAnchorRecordsResult {
  records: AnchorRecord[];
  warnings: string[];
  sources: string[];
  branchFound: boolean;
}

/**
 * Read anchors.ndjson from the local `anchors` branch, falling back to
 * `origin/anchors`. Malformed lines and missing files are warnings.
 */
export function readAnchorRecords(root: string): ReadAnchorRecordsResult {
  const records: AnchorRecord[] = [];
  const warnings: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  let branchFound = false;

  for (const ref of [
    `refs/heads/${ANCHORS_BRANCH}`,
    `refs/remotes/origin/${ANCHORS_BRANCH}`,
  ]) {
    const oid = tryRunGitText(['rev-parse', '--verify', '--quiet', ref], root)?.trim();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    branchFound = true;

    const body = tryRunGitText(['show', `${ref}:${ANCHORS_FILE}`], root);
    if (body === null) {
      warnings.push(`Anchor branch ${ref} exists but ${ANCHORS_FILE} is missing.`);
      continue;
    }

    sources.push(ref);
    const parsed = parseAnchorIndex(body);
    records.push(...parsed.records);
    warnings.push(...parsed.warnings.map((warning) => `${ref}: ${warning}`));
  }

  return { records, warnings, sources, branchFound };
}

export function isWorkingTreeClean(root: string): boolean {
  return (tryRunGitText(['status', '--porcelain'], root) ?? '') === '';
}
