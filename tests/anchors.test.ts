import { describe, expect, it } from 'vitest';
import { computeAnchorCoverage, resolveAnchorTimes, toAnchorInfo } from '../core/anchors.ts';
import type { AnchorInfo, RevisionProof } from '../core/contract.ts';

function makeAnchor(blockTimestamp: number, txHash = `0x${'1'.repeat(64)}`): AnchorInfo {
  return {
    chain: 'base-sepolia',
    chainId: 84532,
    txHash,
    blockNumber: blockTimestamp,
    blockTimestamp,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
  };
}

function makeRevision(commit: string, gitTimestamp: number): RevisionProof {
  return {
    commit,
    shortCommit: commit.slice(0, 7),
    message: `commit ${commit}`,
    author: 'tester',
    gitTimestamp,
    diff: '',
    fileSha256: '',
    anchor: null,
    verifiedAt: null,
  };
}

describe('computeAnchorCoverage', () => {
  it('assigns the nearest anchored descendant on a linear history', () => {
    const coverage = computeAnchorCoverage(
      ['c1', 'c2', 'c3', 'c4'],
      new Map([['c2', makeAnchor(100)]]),
    );

    expect(coverage.get('c1')?.blockTimestamp).toBe(100);
    expect(coverage.get('c2')?.blockTimestamp).toBe(100);
    expect(coverage.get('c3')).toBeNull();
    expect(coverage.get('c4')).toBeNull();
  });

  it('lets an older anchor cover itself even when newer anchors exist', () => {
    const coverage = computeAnchorCoverage(
      ['c1', 'c2', 'c3', 'c4'],
      new Map([
        ['c1', makeAnchor(100)],
        ['c4', makeAnchor(400)],
      ]),
    );

    expect(coverage.get('c1')?.blockTimestamp).toBe(100);
    expect(coverage.get('c2')?.blockTimestamp).toBe(400);
    expect(coverage.get('c3')?.blockTimestamp).toBe(400);
    expect(coverage.get('c4')?.blockTimestamp).toBe(400);
  });

  it('returns null for every commit when there are no anchors', () => {
    const coverage = computeAnchorCoverage(['c1', 'c2'], new Map());
    expect(coverage.get('c1')).toBeNull();
    expect(coverage.get('c2')).toBeNull();
  });
});

describe('resolveAnchorTimes', () => {
  it('marks the node pending while keeping the last verified time', () => {
    const revisions = [
      makeRevision('c3', 300),
      makeRevision('c2', 200),
      makeRevision('c1', 100),
    ];
    const coverage = new Map<string, AnchorInfo | null>([
      ['c1', makeAnchor(150)],
      ['c2', makeAnchor(150)],
      ['c3', null],
    ]);

    const result = resolveAnchorTimes(revisions, coverage, 999_000);

    expect(result.isVerified).toBe(false);
    expect(result.updatedAt).toBe(150);
    expect(result.createdAt).toBe(150);
    expect(result.displayTime).toBe(150);
    expect(result.revisions[0]?.verifiedAt).toBeNull();
    expect(result.revisions[1]?.verifiedAt).toBe(150);
  });

  it('uses the latest anchor when the latest revision is verified', () => {
    const revisions = [makeRevision('c3', 300), makeRevision('c2', 200)];
    const coverage = new Map<string, AnchorInfo | null>([
      ['c1', makeAnchor(150)],
      ['c2', makeAnchor(150)],
      ['c3', makeAnchor(350)],
    ]);

    const result = resolveAnchorTimes(revisions, coverage, 0);

    expect(result.isVerified).toBe(true);
    expect(result.updatedAt).toBe(350);
    expect(result.displayTime).toBe(350);
  });

  it('falls back to Git time when nothing is anchored', () => {
    const revisions = [makeRevision('c2', 200), makeRevision('c1', 100)];
    const result = resolveAnchorTimes(revisions, new Map(), 0);

    expect(result.isVerified).toBe(false);
    expect(result.createdAt).toBeNull();
    expect(result.updatedAt).toBeNull();
    expect(result.displayTime).toBe(200);
  });

  it('falls back to file mtime when there are no revisions', () => {
    const result = resolveAnchorTimes([], new Map(), 42_000);
    expect(result.displayTime).toBe(42);
    expect(result.isVerified).toBe(false);
  });
});

describe('toAnchorInfo', () => {
  it('builds an explorer URL', () => {
    const tx = `0x${'a'.repeat(64)}`;
    const info = toAnchorInfo(
      {
        schema: 1,
        chain: 'base-sepolia',
        chainId: 84532,
        tx,
        block: 10,
        blockTimestamp: 20,
        commit: 'f'.repeat(40),
        repo: 'owner/repo',
      },
      'https://sepolia.basescan.org/',
    );

    expect(info.explorerUrl).toBe(`https://sepolia.basescan.org/tx/${tx}`);
  });
});
