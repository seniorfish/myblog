import type { ChainConfig } from './contract.ts';
import { anchorRecordSchema, type AnchorRecord } from './schema.ts';

export const ANCHORS_BRANCH = 'anchors';
export const ANCHORS_FILE = 'anchors.ndjson';
export const ANCHOR_EVENT_SIGNATURE = 'Anchored(address,bytes32)';
/** keccak256("Anchored(address,bytes32)") */
export const ANCHOR_EVENT_TOPIC0 =
  '0xee1610244dfc4b116b1433dd4459fd7b1d3d2bf737a05fc3f6d8f173005d7147';

/**
 * Git SHA-1 commits are 20 bytes; the contract takes bytes32, so the hex form
 * is right-padded with zeros. The index keeps the original 40-hex commit.
 */
export function encodeCommitBytes32(commit: string): string {
  const normalized = commit.toLowerCase().replace(/^0x/u, '');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) {
    throw new Error(`Invalid Git commit hash: ${commit}`);
  }
  return `0x${normalized}${'0'.repeat(64 - normalized.length)}`;
}

/** Encode an address as a 32-byte indexed-event topic. */
export function encodeAddressTopic(address: string): string {
  const normalized = address.toLowerCase().replace(/^0x/u, '');
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(`Invalid address: ${address}`);
  }
  return `0x${normalized.padStart(64, '0')}`;
}

export interface ParsedAnchorIndex {
  records: AnchorRecord[];
  warnings: string[];
}

/** Parse anchors.ndjson; malformed lines are warnings, not fatal errors. */
export function parseAnchorIndex(text: string): ParsedAnchorIndex {
  const records: AnchorRecord[] = [];
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = anchorRecordSchema.parse(JSON.parse(trimmed));
      records.push({
        ...parsed,
        commit: parsed.commit.toLowerCase(),
        contract: parsed.contract.toLowerCase(),
        sender: parsed.sender.toLowerCase(),
        tx: parsed.tx.toLowerCase(),
      });
    } catch (error) {
      warnings.push(
        `Malformed anchor record on line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  return { records, warnings };
}

export interface SelectedAnchors {
  anchors: Map<string, AnchorRecord>;
  warnings: string[];
}

/**
 * Keep only records that belong to this site/contract/chain and to a commit in
 * the current first-parent history. A later record for the same commit wins.
 */
export function selectAnchorRecords(
  records: AnchorRecord[],
  chain: ChainConfig,
  repo: string,
  commits: string[],
): SelectedAnchors {
  const known = new Set(commits.map((commit) => commit.toLowerCase()));
  const anchors = new Map<string, AnchorRecord>();
  const warnings: string[] = [];

  for (const record of records) {
    if (record.chain !== chain.name || record.chainId !== chain.chainId) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} is for ${record.chain}/${record.chainId}; ignored.`,
      );
      continue;
    }
    if (record.contract.toLowerCase() !== chain.contract.toLowerCase()) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} uses contract ${record.contract}; ignored.`,
      );
      continue;
    }
    if (record.sender.toLowerCase() !== chain.address.toLowerCase()) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} uses sender ${record.sender}; ignored.`,
      );
      continue;
    }
    if (record.repo !== repo) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} belongs to ${record.repo}; ignored.`,
      );
      continue;
    }
    if (record.block < chain.deployBlock) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} is below deployBlock ${chain.deployBlock}; ignored.`,
      );
      continue;
    }
    if (!known.has(record.commit.toLowerCase())) {
      warnings.push(
        `Anchor record ${record.commit.slice(0, 7)} is not in the current history; ignored.`,
      );
      continue;
    }

    const previous = anchors.get(record.commit);
    if (previous && previous.tx !== record.tx) {
      warnings.push(
        `Multiple anchors for ${record.commit.slice(0, 7)}; using the latest record.`,
      );
    }
    anchors.set(record.commit, record);
  }

  return { anchors, warnings };
}

/** Deterministic one-line serialization used by the CLI and tests. */
export function serializeAnchorRecord(record: AnchorRecord): string {
  const canonical: AnchorRecord = {
    schema: 1,
    chain: record.chain,
    chainId: record.chainId,
    commit: record.commit.toLowerCase(),
    contract: record.contract.toLowerCase(),
    sender: record.sender.toLowerCase(),
    tx: record.tx.toLowerCase(),
    block: record.block,
    blockTimestamp: record.blockTimestamp,
    ...(record.logIndex === undefined ? {} : { logIndex: record.logIndex }),
    repo: record.repo,
  };
  return JSON.stringify(canonical);
}
