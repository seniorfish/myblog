import { describe, expect, it } from 'vitest';
import { computeAnchorCoverage, resolveAnchorTimes, toAnchorInfo } from '../core/anchors.ts';
import type { AnchorInfo, ChainConfig, RevisionProof } from '../core/contract.ts';
import type { AnchorRecord } from '../core/schema.ts';

function makeAnchor(blockTimestamp: number, txHash = `0x${'1'.repeat(64)}`): AnchorInfo {
  const contract = `0x${'2'.repeat(40)}`;
  const sender = `0x${'3'.repeat(40)}`;
  return {
    chain: 'base-mainnet',
    chainId: 8453,
    txHash,
    blockNumber: blockTimestamp,
    blockTimestamp,
    explorerUrl: `https://basescan.org/tx/${txHash}`,
    contract,
    sender,
    contractExplorerUrl: `https://basescan.org/address/${contract}`,
    senderExplorerUrl: `https://basescan.org/address/${sender}`,
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
    gitBlobSha1: '',
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
  it('builds tx, contract, and sender explorer URLs', () => {
    const tx = `0x${'a'.repeat(64)}`;
    const contract = `0x${'b'.repeat(40)}`;
    const sender = `0x${'c'.repeat(40)}`;
    const record: AnchorRecord = {
      schema: 1,
      chain: 'base-mainnet',
      chainId: 8453,
      commit: 'f'.repeat(40),
      contract,
      sender,
      tx,
      block: 10,
      blockTimestamp: 20,
      repo: 'owner/repo',
    };
    const config: ChainConfig = {
      enabled: true,
      name: 'base-mainnet',
      chainId: 8453,
      address: sender,
      contract,
      deployBlock: 1,
      rpcUrl: 'https://mainnet.base.org',
      explorerUrl: 'https://basescan.org/',
      confirmations: 2,
    };

    const info = toAnchorInfo(record, config);

    expect(info.chain).toBe('base-mainnet');
    expect(info.explorerUrl).toBe(`https://basescan.org/tx/${tx}`);
    expect(info.contractExplorerUrl).toBe(`https://basescan.org/address/${contract}`);
    expect(info.senderExplorerUrl).toBe(`https://basescan.org/address/${sender}`);
  });
});
