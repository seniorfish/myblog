import { describe, expect, it } from 'vitest';
import {
  ANCHOR_EVENT_TOPIC0,
  encodeAddressTopic,
  encodeCommitBytes32,
  parseAnchorIndex,
  selectAnchorRecords,
  serializeAnchorRecord,
} from '../core/anchor-index.ts';
import type { ChainConfig } from '../core/contract.ts';
import type { AnchorRecord } from '../core/schema.ts';

const commit = 'a'.repeat(40);
const contract = `0x${'b'.repeat(40)}`;
const sender = `0x${'c'.repeat(40)}`;
const tx = `0x${'d'.repeat(64)}`;

function makeRecord(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    schema: 1,
    chain: 'base-mainnet',
    chainId: 8453,
    commit,
    contract,
    sender,
    tx,
    block: 100,
    blockTimestamp: 1700000000,
    logIndex: 1,
    repo: 'tester/blog',
    ...overrides,
  };
}

const chain: ChainConfig = {
  enabled: true,
  name: 'base-mainnet',
  chainId: 8453,
  address: sender,
  contract,
  deployBlock: 50,
  rpcUrl: 'https://mainnet.base.org',
  explorerUrl: 'https://basescan.org',
};

const commits = [commit, 'e'.repeat(40)];

describe('anchor encoding', () => {
  it('right-pads a 20-byte Git commit to bytes32', () => {
    expect(encodeCommitBytes32(commit)).toBe(`0x${commit}${'0'.repeat(24)}`);
  });

  it('keeps a 32-byte commit unchanged', () => {
    const sha256 = 'f'.repeat(64);
    expect(encodeCommitBytes32(sha256)).toBe(`0x${sha256}`);
  });

  it('rejects malformed commits', () => {
    expect(() => encodeCommitBytes32('abc')).toThrow();
  });

  it('left-pads addresses into event topics', () => {
    expect(encodeAddressTopic(sender)).toBe(`0x${'0'.repeat(24)}${'c'.repeat(40)}`);
  });

  it('pins the indexed event topic', () => {
    expect(ANCHOR_EVENT_TOPIC0).toHaveLength(66);
  });
});

describe('parseAnchorIndex', () => {
  it('parses NDJSON with CRLF, blanks, and malformed lines', () => {
    const text = `${JSON.stringify(makeRecord())}\r\n\r\nnot json\n`;
    const parsed = parseAnchorIndex(text);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.tx).toBe(tx);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('line 3');
  });

  it('lowercases commit, contract, sender, and tx', () => {
    const upper = makeRecord({
      commit: 'A'.repeat(40),
      contract: `0x${'B'.repeat(40)}`,
      sender: `0x${'C'.repeat(40)}`,
      tx: `0x${'D'.repeat(64)}`,
    });
    const parsed = parseAnchorIndex(JSON.stringify(upper));

    expect(parsed.records[0]?.commit).toBe('a'.repeat(40));
    expect(parsed.records[0]?.contract).toBe(`0x${'b'.repeat(40)}`);
    expect(parsed.records[0]?.sender).toBe(`0x${'c'.repeat(40)}`);
    expect(parsed.records[0]?.tx).toBe(`0x${'d'.repeat(64)}`);
  });
});

describe('selectAnchorRecords', () => {
  it('selects a matching record', () => {
    const selected = selectAnchorRecords([makeRecord()], chain, 'tester/blog', commits);
    expect(selected.anchors.get(commit)?.tx).toBe(tx);
    expect(selected.warnings).toEqual([]);
  });

  it('ignores wrong contract, sender, chain, repo, block, and commit', () => {
    const records = [
      makeRecord({ contract: `0x${'9'.repeat(40)}` }),
      makeRecord({ sender: `0x${'9'.repeat(40)}` }),
      makeRecord({ chain: 'base-sepolia' }),
      makeRecord({ repo: 'other/repo' }),
      makeRecord({ block: 1 }),
      makeRecord({ commit: 'f'.repeat(40) }),
    ];
    const selected = selectAnchorRecords(records, chain, 'tester/blog', commits);
    expect(selected.anchors.size).toBe(0);
    expect(selected.warnings.length).toBe(records.length);
  });

  it('lets the later record win for the same commit', () => {
    const laterTx = `0x${'e'.repeat(64)}`;
    const selected = selectAnchorRecords(
      [makeRecord(), makeRecord({ tx: laterTx, block: 120 })],
      chain,
      'tester/blog',
      commits,
    );

    expect(selected.anchors.get(commit)?.tx).toBe(laterTx);
    expect(selected.warnings.some((warning) => warning.includes('Multiple anchors'))).toBe(true);
  });
});

describe('serializeAnchorRecord', () => {
  it('emits canonical lowercase JSON with stable key order', () => {
    const text = serializeAnchorRecord(
      makeRecord({
        commit: 'A'.repeat(40),
        contract: `0x${'B'.repeat(40)}`,
        sender: `0x${'C'.repeat(40)}`,
        tx: `0x${'D'.repeat(64)}`,
      }),
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual([
      'schema',
      'chain',
      'chainId',
      'commit',
      'contract',
      'sender',
      'tx',
      'block',
      'blockTimestamp',
      'logIndex',
      'repo',
    ]);
    expect(parsed.commit).toBe('a'.repeat(40));
    expect(parsed.contract).toBe(`0x${'b'.repeat(40)}`);
  });

  it('omits logIndex when absent', () => {
    const { logIndex: _logIndex, ...withoutLogIndex } = makeRecord();
    const parsed = JSON.parse(serializeAnchorRecord(withoutLogIndex)) as Record<string, unknown>;
    expect(parsed.logIndex).toBeUndefined();
  });
});
