import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DiffResult {
  changed: boolean;
  patch: string;
}

/**
 * Render a colored unified diff without adding a diff dependency. Git's
 * `--word-diff=color` output is familiar and works on Windows terminals.
 */
export function renderDiff(before: string, after: string): DiffResult {
  if (before === after) return { changed: false, patch: '' };

  const dir = mkdtempSync(path.join(tmpdir(), 'myblog-diff-'));
  const beforePath = path.join(dir, 'before.md');
  const afterPath = path.join(dir, 'after.md');

  try {
    writeFileSync(beforePath, before, 'utf8');
    writeFileSync(afterPath, after, 'utf8');

    const result = spawnSync(
      'git',
      [
        'diff',
        '--no-index',
        '--color=always',
        '--word-diff=color',
        '--',
        beforePath,
        afterPath,
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );

    let patch = result.stdout ?? '';
    patch = patch.replaceAll(beforePath, '当前').replaceAll(afterPath, '建议');
    return { changed: true, patch };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
