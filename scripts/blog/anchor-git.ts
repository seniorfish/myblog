import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANCHORS_FILE,
  parseAnchorIndex,
  serializeAnchorRecord,
} from '../../core/anchor-index.ts';
import type { AnchorRecord } from '../../core/schema.ts';
import { runProcess } from '../shared/process.ts';

export interface WorktreeOptions {
  authorName?: string;
  authorEmail?: string;
}

function git(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  const result = runProcess('git', args, {
    cwd,
    allowFailure: options.allowFailure,
    timeoutMs: 60_000,
  });
  return result.stdout.trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  const result = runProcess('git', args, {
    cwd,
    allowFailure: true,
    timeoutMs: 60_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function anchorsWorktreePath(root: string): string {
  return path.join(root, '.worktrees', 'anchors');
}

/** Create or reuse .worktrees/anchors on the orphan `anchors` branch. */
export async function ensureAnchorsWorktree(root: string): Promise<string> {
  const worktree = anchorsWorktreePath(root);
  const target = path.resolve(worktree);

  await mkdir(path.dirname(worktree), { recursive: true });
  tryGit(root, ['worktree', 'prune']);

  const list = tryGit(root, ['worktree', 'list', '--porcelain']) ?? '';
  const registered = list
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .some((item) => path.resolve(item) === target);

  if (registered) return worktree;

  if (existsSync(worktree)) {
    await rm(worktree, { recursive: true, force: true });
  }

  const local = tryGit(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/anchors']);
  const remote = tryGit(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/remotes/origin/anchors',
  ]);

  if (local) {
    git(root, ['worktree', 'add', worktree, 'anchors']);
  } else if (remote) {
    git(root, ['worktree', 'add', '-B', 'anchors', worktree, 'refs/remotes/origin/anchors']);
  } else {
    git(root, ['worktree', 'add', '--orphan', '-b', 'anchors', worktree]);
  }

  return worktree;
}

export interface IndexSnapshot {
  records: AnchorRecord[];
  warnings: string[];
  text: string;
}

export async function readWorktreeIndex(worktree: string): Promise<IndexSnapshot> {
  const file = path.join(worktree, ANCHORS_FILE);
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  const parsed = parseAnchorIndex(text);
  return { records: parsed.records, warnings: parsed.warnings, text };
}

function sameAnchor(
  left: AnchorRecord,
  right: Pick<AnchorRecord, 'commit' | 'contract' | 'sender'>,
): boolean {
  return (
    left.commit.toLowerCase() === right.commit.toLowerCase() &&
    left.contract.toLowerCase() === right.contract.toLowerCase() &&
    left.sender.toLowerCase() === right.sender.toLowerCase()
  );
}

/** Append a record unless the same commit/contract/sender is already present. */
export async function appendIndexRecord(
  worktree: string,
  record: AnchorRecord,
): Promise<{ changed: boolean; records: AnchorRecord[]; warnings: string[] }> {
  const current = await readWorktreeIndex(worktree);
  if (current.records.some((item) => sameAnchor(item, record))) {
    return { changed: false, records: current.records, warnings: current.warnings };
  }

  const file = path.join(worktree, ANCHORS_FILE);
  const prefix = current.text === '' || current.text.endsWith('\n')
    ? current.text
    : `${current.text}\n`;
  await writeFile(file, `${prefix}${serializeAnchorRecord(record)}\n`, 'utf8');

  return {
    changed: true,
    records: [...current.records, record],
    warnings: current.warnings,
  };
}

export async function commitIndexRecord(
  worktree: string,
  record: AnchorRecord,
  options: WorktreeOptions = {},
): Promise<void> {
  const name = options.authorName ?? 'myblog-anchor';
  const email = options.authorEmail ?? 'anchor@users.noreply.github.com';
  const message = `chore(anchor): record ${record.commit.slice(0, 7)} @ block ${record.block}`;

  git(worktree, ['add', ANCHORS_FILE]);
  git(worktree, [
    '-c',
    'core.hooksPath=',
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '--no-verify',
    '--only',
    '-m',
    message,
    '--',
    ANCHORS_FILE,
  ]);
}

/** Union two NDJSON indexes, keyed by tx + logIndex. */
export function mergeAnchorTexts(remoteText: string, localText: string): string {
  const merged = new Map<string, AnchorRecord>();

  for (const text of [remoteText, localText]) {
    for (const record of parseAnchorIndex(text).records) {
      const key = `${record.tx}:${record.logIndex ?? ''}`;
      merged.set(key, record);
    }
  }

  return [...merged.values()]
    .sort(
      (a, b) =>
        a.block - b.block ||
        (a.logIndex ?? 0) - (b.logIndex ?? 0) ||
        a.tx.localeCompare(b.tx),
    )
    .map((record) => serializeAnchorRecord(record))
    .join('\n')
    .concat('\n');
}

export interface PushResult {
  pushed: boolean;
  warning?: string;
}

/** Push the anchors branch; on rejection, merge remote records and retry. */
export async function pushAnchorsBranch(
  worktree: string,
  options: WorktreeOptions = {},
): Promise<PushResult> {
  const remotes = (tryGit(worktree, ['remote']) ?? '')
    .split(/\r?\n/u)
    .map((item) => item.trim());
  if (!remotes.includes('origin')) {
    return { pushed: false, warning: 'No origin remote is configured; the index commit is local only.' };
  }

  const file = path.join(worktree, ANCHORS_FILE);
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      git(worktree, ['push', '-u', 'origin', 'anchors']);
      return { pushed: true };
    } catch (error) {
      lastError = error;
      tryGit(worktree, ['fetch', 'origin', 'anchors']);
      const remoteRef = tryGit(worktree, ['rev-parse', '--verify', '--quiet', 'origin/anchors']);
      if (!remoteRef) continue;

      const remoteText = tryGit(worktree, ['show', 'origin/anchors:anchors.ndjson']) ?? '';
      const localText = existsSync(file) ? await readFile(file, 'utf8') : '';
      const merged = mergeAnchorTexts(remoteText, localText);

      git(worktree, ['reset', '--hard', 'origin/anchors']);
      await writeFile(file, merged, 'utf8');
      git(worktree, ['add', ANCHORS_FILE]);
      git(worktree, [
        '-c',
        'core.hooksPath=',
        '-c',
        `user.name=${options.authorName ?? 'myblog-anchor'}`,
        '-c',
        `user.email=${options.authorEmail ?? 'anchor@users.noreply.github.com'}`,
        'commit',
        '--no-verify',
        '--only',
        '-m',
        'chore(anchor): merge remote anchor index',
        '--',
        ANCHORS_FILE,
      ]);
    }
  }

  throw lastError;
}

export async function removeAnchorsWorktree(root: string): Promise<void> {
  const worktree = anchorsWorktreePath(root);
  tryGit(root, ['worktree', 'remove', '--force', worktree]);
}
