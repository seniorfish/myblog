import { describe, expect, it } from 'vitest';
import {
  ANCHOR_EVENT_TOPIC0,
  encodeAddressTopic,
  encodeCommitBytes32,
  serializeAnchorRecord,
} from '../core/anchor-index.ts';
import type { AnchorRecord } from '../core/schema.ts';
import {
  buildAnchorSendArgs,
  buildCastAuthArgs,
  extractTransactionHash,
  parseAnchorReceipt,
  parseLogArray,
  parseQuantity,
  resolveLogFromBlock,
} from '../scripts/blog/anchor-cast.ts';
import { mergeAnchorTexts } from '../scripts/blog/anchor-git.ts';
import { redactText } from '../scripts/shared/process.ts';

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
    repo: 'tester/blog',
    ...overrides,
  };
}

describe('buildCastAuthArgs', () => {
  it('builds keystore args', () => {
    const auth = buildCastAuthArgs({
      keystore: 'C:/keys/iceberg-test',
      passwordFile: 'C:/keys/iceberg-test.pass',
    });
    expect(auth.args).toEqual([
      '--password-file',
      'C:/keys/iceberg-test.pass',
      '--keystore',
      'C:/keys/iceberg-test',
    ]);
    expect(auth.secrets).toEqual([]);
  });

  it('builds account args', () => {
    const auth = buildCastAuthArgs({
      account: 'iceberg-test',
      passwordFile: 'C:/keys/iceberg-test.pass',
    });
    expect(auth.args).toEqual([
      '--password-file',
      'C:/keys/iceberg-test.pass',
      '--account',
      'iceberg-test',
    ]);
  });

  it('reads and redacts a private key from the environment', () => {
    const auth = buildCastAuthArgs({ privateKeyEnv: 'ANCHOR_PRIVATE_KEY' }, {
      ANCHOR_PRIVATE_KEY: 'super-secret',
    });
    expect(auth.args).toEqual(['--private-key', 'super-secret']);
    expect(auth.secrets).toEqual(['super-secret']);
    expect(redactText('failed with super-secret', auth.secrets)).toBe('failed with [redacted]');
  });

  it('rejects mixed auth modes', () => {
    expect(() =>
      buildCastAuthArgs({
        keystore: 'C:/keys/k',
        account: 'a',
        passwordFile: 'C:/keys/p',
      }),
    ).toThrow(/either --keystore or --account/);
    expect(() =>
      buildCastAuthArgs({
        keystore: 'C:/keys/k',
        passwordFile: 'C:/keys/p',
        privateKeyEnv: 'PK',
      }),
    ).toThrow(/not both/);
  });

  it('requires a password file or an environment key', () => {
    expect(() => buildCastAuthArgs({ keystore: 'C:/keys/k' })).toThrow(/password-file/);
    expect(() => buildCastAuthArgs({ privateKeyEnv: 'MISSING' }, {})).toThrow(/not set/);
    expect(() => buildCastAuthArgs({})).toThrow(/No signer/);
  });
});

describe('buildAnchorSendArgs', () => {
  it('builds a padded anchor call with confirmations and JSON output', () => {
    const built = buildAnchorSendArgs({
      contract,
      commit,
      rpcUrl: 'https://mainnet.base.org',
      confirmations: 2,
      auth: { privateKeyEnv: 'PK' },
      env: { PK: 'secret' },
    });

    expect(built.args).toEqual([
      'send',
      contract,
      'anchor(bytes32)',
      `0x${commit}${'0'.repeat(24)}`,
      '--rpc-url',
      'https://mainnet.base.org',
      '--confirmations',
      '2',
      '--json',
      '--private-key',
      'secret',
    ]);
    expect(built.secrets).toEqual(['secret']);
  });
});

describe('resolveLogFromBlock', () => {
  it('keeps the full range when no lookback is requested', () => {
    expect(resolveLogFromBlock({ deployBlock: 100, latestBlock: 500 })).toBe(100);
    expect(
      resolveLogFromBlock({ deployBlock: 100, latestBlock: 500, lookbackBlocks: 0 }),
    ).toBe(100);
  });

  it('scans the requested recent window', () => {
    expect(
      resolveLogFromBlock({ deployBlock: 100, latestBlock: 500, lookbackBlocks: 10 }),
    ).toBe(491);
  });

  it('never goes below the deploy block', () => {
    expect(
      resolveLogFromBlock({ deployBlock: 100, latestBlock: 105, lookbackBlocks: 10 }),
    ).toBe(100);
    expect(
      resolveLogFromBlock({ deployBlock: 100, latestBlock: 50, lookbackBlocks: 10 }),
    ).toBe(100);
  });
});

describe('parseQuantity', () => {
  it('parses hex, decimal, and numeric values', () => {
    expect(parseQuantity('0x2')).toBe(2);
    expect(parseQuantity('42')).toBe(42);
    expect(parseQuantity(2)).toBe(2);
  });

  it('rejects invalid values', () => {
    expect(() => parseQuantity('nope')).toThrow();
  });
});

describe('extractTransactionHash', () => {
  it('finds a hash in nested objects and arrays', () => {
    expect(extractTransactionHash([{ nested: { transactionHash: tx } }])).toBe(tx);
  });

  it('returns null when no hash is present', () => {
    expect(extractTransactionHash({ transactionHash: '0x12' })).toBeNull();
  });
});

describe('parseLogArray', () => {
  const log = {
    address: contract,
    topics: [ANCHOR_EVENT_TOPIC0],
    blockNumber: '0x2',
    logIndex: '0x0',
  };

  it('parses arrays and result wrappers', () => {
    expect(parseLogArray(JSON.stringify([log]))).toHaveLength(1);
    expect(parseLogArray(JSON.stringify({ result: [log] }))).toHaveLength(1);
  });

  it('returns an empty array for invalid output', () => {
    expect(parseLogArray('not json')).toEqual([]);
  });
});

describe('parseAnchorReceipt', () => {
  function receipt(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: '0x2',
      status: '0x1',
      transactionHash: tx,
      blockNumber: '0x2',
      logs: [
        {
          address: contract,
          topics: [
            ANCHOR_EVENT_TOPIC0,
            encodeAddressTopic(sender),
            encodeCommitBytes32(commit),
          ],
          data: '0x',
          logIndex: '0x0',
          blockTimestamp: '0x6adbb280',
        },
      ],
      ...overrides,
    });
  }

  it('extracts the Anchored event', () => {
    const parsed = parseAnchorReceipt(receipt(), { contract, sender, commit });
    expect(parsed.txHash).toBe(tx);
    expect(parsed.blockNumber).toBe(2);
    expect(parsed.logIndex).toBe(0);
    expect(parsed.blockTimestamp).toBe(0x6adbb280);
  });

  it('rejects a failed transaction', () => {
    expect(() =>
      parseAnchorReceipt(receipt({ status: '0x0' }), { contract, sender, commit }),
    ).toThrow(/failed/);
  });

  it('rejects a receipt without the expected event', () => {
    expect(() =>
      parseAnchorReceipt(receipt(), {
        contract,
        sender: `0x${'9'.repeat(40)}`,
        commit,
      }),
    ).toThrow(/Anchored event/);
  });
});

describe('mergeAnchorTexts', () => {
  it('unions remote and local records without losing either', () => {
    const remoteTx = `0x${'1'.repeat(64)}`;
    const localTx = `0x${'2'.repeat(64)}`;
    const remote = `${serializeAnchorRecord(makeRecord({ tx: remoteTx, block: 100 }))}\n`;
    const local = `${serializeAnchorRecord(makeRecord({ tx: localTx, block: 200 }))}\n`;

    const merged = mergeAnchorTexts(remote, local);

    expect(merged).toContain(remoteTx);
    expect(merged).toContain(localTx);
    expect(merged.trim().split('\n')).toHaveLength(2);
  });
});
