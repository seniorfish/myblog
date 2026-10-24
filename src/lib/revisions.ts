import type { ContentNode, SiteMeta } from '../generated/contract';

export interface RevisionAnchorData {
  timeLabel: string;
  txShort: string;
  txUrl: string;
  contractShort: string;
  contractUrl: string;
  senderShort: string;
  senderUrl: string;
  blockNumber: number;
}

export interface RevisionItemData {
  label: string;
  commit: string;
  shortCommit: string;
  commitUrl: string | null;
  timeLabel: string;
  dateTime: string;
  message: string;
  blobSha1: string;
  blobUrl: string | null;
  apiUrl: string | null;
  additions: number;
  deletions: number;
  anchor: RevisionAnchorData | null;
}

export interface RevisionPayload {
  schema: 1;
  status: string;
  statusDetail: string;
  isDirty: boolean;
  repo: string;
  path: string;
  revisions: RevisionItemData[];
}

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }

  return { additions, deletions };
}

const shortAddress = (address: string): string =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;

export function buildRevisionPayload(node: ContentNode, site: SiteMeta): RevisionPayload {
  const latest = node.revisions[0];
  const hasAnyAnchor = node.revisions.some((revision) => revision.verifiedAt !== null);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: site.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const formatTime = (timestamp: number | null | undefined): string =>
    timestamp ? formatter.format(new Date(timestamp * 1000)) : '—';

  const status = node.isVerified
    ? '已锚定'
    : hasAnyAnchor
      ? '当前版本待锚定'
      : '尚无链上锚定记录';

  const statusDetail = node.isVerified
    ? `锚定于 ${formatTime(latest?.verifiedAt)}${
        latest?.anchor ? ` · block #${latest.anchor.blockNumber}` : ''
      }`
    : hasAnyAnchor
      ? `当前版本待锚定 · 上次锚定于 ${formatTime(node.updatedAt)}`
      : '尚无锚定记录；时间来自 Git 提交。';

  const githubBase = `https://github.com/${site.repo}`;
  const apiBase = `https://api.github.com/repos/${site.repo}`;
  const path = node.git.path;

  const revisions = node.revisions.map((revision, index): RevisionItemData => {
    const { additions, deletions } = countDiffLines(revision.diff);
    const anchor = revision.anchor;
    const commit = revision.commit;

    return {
      label: index === 0 ? '当前版本' : `第 ${node.revisions.length - index} 次修改`,
      commit,
      shortCommit: revision.shortCommit,
      commitUrl: commit ? `${githubBase}/commit/${commit}` : null,
      timeLabel: formatTime(revision.gitTimestamp),
      dateTime: new Date(revision.gitTimestamp * 1000).toISOString(),
      message: revision.message,
      blobSha1: revision.gitBlobSha1,
      blobUrl:
        commit && revision.gitBlobSha1
          ? `${githubBase}/blob/${commit}/${encodeURI(path)}`
          : null,
      apiUrl: commit ? `${apiBase}/contents/${encodeURI(path)}?ref=${commit}` : null,
      additions,
      deletions,
      anchor: anchor
        ? {
            timeLabel: formatTime(revision.verifiedAt),
            txShort: `${anchor.txHash.slice(0, 10)}…`,
            txUrl: anchor.explorerUrl,
            contractShort: shortAddress(anchor.contract),
            contractUrl: anchor.contractExplorerUrl,
            senderShort: shortAddress(anchor.sender),
            senderUrl: anchor.senderExplorerUrl,
            blockNumber: anchor.blockNumber,
          }
        : null,
    };
  });

  return {
    schema: 1,
    status,
    statusDetail,
    isDirty: node.isDirty,
    repo: site.repo,
    path,
    revisions,
  };
}
