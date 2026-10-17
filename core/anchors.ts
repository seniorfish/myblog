import type { AnchorInfo, RevisionProof } from './contract.ts';
import type { AnchorNote } from './schema.ts';

export interface AnchorResolution {
  revisions: RevisionProof[];
  createdAt: number | null;
  updatedAt: number | null;
  isVerified: boolean;
  displayTime: number;
}

/** Convert a raw note into the public AnchorInfo shape. */
export function toAnchorInfo(note: AnchorNote, explorerUrl: string): AnchorInfo {
  return {
    chain: note.chain,
    chainId: note.chainId,
    txHash: note.tx,
    blockNumber: note.block,
    blockTimestamp: note.blockTimestamp,
    explorerUrl: `${explorerUrl.replace(/\/+$/u, '')}/tx/${note.tx}`,
  };
}

/**
 * Assign each commit the nearest anchored descendant on a linear history.
 * Commits newer than every anchor map to null.
 *
 * Example (oldest -> newest): [C1, C2, C3], anchor at C2
 *   C1 -> C2's anchor, C2 -> C2's anchor, C3 -> null
 */
export function computeAnchorCoverage(
  commitsOldestFirst: string[],
  anchors: Map<string, AnchorInfo>,
): Map<string, AnchorInfo | null> {
  const coverage = new Map<string, AnchorInfo | null>();
  let current: AnchorInfo | null = null;

  for (let index = commitsOldestFirst.length - 1; index >= 0; index -= 1) {
    const commit = commitsOldestFirst[index]!;
    const anchor = anchors.get(commit);
    if (anchor) current = anchor;
    coverage.set(commit, current);
  }

  return coverage;
}

/**
 * Resolve node-level timestamps from revision anchors.
 * The latest revision may be unverified while an older revision is verified.
 */
export function resolveAnchorTimes(
  revisions: RevisionProof[],
  coverage: Map<string, AnchorInfo | null>,
  provisionalTime: number,
): AnchorResolution {
  const resolved = revisions.map((revision) => {
    const anchor = coverage.get(revision.commit) ?? null;
    return {
      ...revision,
      anchor,
      verifiedAt: anchor?.blockTimestamp ?? null,
    } satisfies RevisionProof;
  });

  const latest = resolved[0];
  const oldest = resolved[resolved.length - 1];
  const latestVerified = resolved.find((revision) => revision.verifiedAt !== null);

  const updatedAt = latestVerified?.verifiedAt ?? null;
  const createdAt = oldest?.verifiedAt ?? null;
  const isVerified = Boolean(latest && latest.verifiedAt !== null);
  const displayTime = updatedAt ?? latest?.gitTimestamp ?? Math.floor(provisionalTime / 1000);

  return {
    revisions: resolved,
    createdAt,
    updatedAt,
    isVerified,
    displayTime,
  };
}
