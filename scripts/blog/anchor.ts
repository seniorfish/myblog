import { loadSiteConfig } from '../../core/config.ts';
import type { SiteConfig } from '../../core/contract.ts';
import { readAnchorRecords } from '../../core/git.ts';
import type { AnchorRecord } from '../../core/schema.ts';
import { runProcess } from '../shared/process.ts';
import {
  buildCastAuthArgs,
  findAnchorEvents,
  getBlockTimestamp,
  getChainId,
  getContractCode,
  sendAnchor,
  type AnchorEvent,
  type CastAuth,
} from './anchor-cast.ts';
import {
  appendIndexRecord,
  commitIndexRecord,
  ensureAnchorsWorktree,
  pushAnchorsBranch,
  readWorktreeIndex,
  removeAnchorsWorktree,
} from './anchor-git.ts';

export interface AnchorOptions {
  root: string;
  commit?: string;
  auth: CastAuth;
  rpcUrl?: string;
  contract?: string;
  confirmations?: number;
  dryRun?: boolean;
  recoverOnly?: boolean;
  noPush?: boolean;
  forceResend?: boolean;
  allowAnyCommit?: boolean;
  keepWorktree?: boolean;
  authorName?: string;
  authorEmail?: string;
  env?: NodeJS.ProcessEnv;
}

export type AnchorAction =
  | 'anchored'
  | 'recovered'
  | 'skipped'
  | 'would-anchor'
  | 'not-found';

export interface AnchorResult {
  ok: boolean;
  action: AnchorAction;
  commit: string;
  commitShort: string;
  contract: string;
  sender: string;
  tx?: string;
  block?: number;
  blockTimestamp?: number;
  logIndex?: number;
  explorerUrl?: string;
  pushed: boolean;
  warnings: string[];
}

function git(
  root: string,
  args: string[],
  allowFailure = false,
): { stdout: string; status: number } {
  const result = runProcess('git', args, {
    cwd: root,
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed.`);
  }
  return { stdout: result.stdout.trim(), status: result.status };
}

function resolveCommit(root: string, rev: string): string {
  const result = git(root, ['rev-parse', '--verify', `${rev}^{commit}`], true);
  const commit = result.stdout;
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error(`Cannot resolve commit: ${rev}`);
  }
  return commit.toLowerCase();
}

function assertAncestor(root: string, commit: string): void {
  const result = git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'], true);
  if (result.status !== 0) {
    throw new Error(`Commit ${commit.slice(0, 7)} is not an ancestor of HEAD.`);
  }
}

function hasRemote(root: string, name: string): boolean {
  const result = git(root, ['remote'], true);
  return result.stdout.split(/\s+/u).includes(name);
}

function fetchAnchors(root: string): void {
  if (!hasRemote(root, 'origin')) return;
  git(root, ['fetch', 'origin', 'anchors'], true);
}

function existingRecord(
  records: AnchorRecord[],
  input: { commit: string; contract: string; sender: string; repo: string },
): AnchorRecord | undefined {
  return records.find(
    (record) =>
      record.commit.toLowerCase() === input.commit.toLowerCase() &&
      record.contract.toLowerCase() === input.contract.toLowerCase() &&
      record.sender.toLowerCase() === input.sender.toLowerCase() &&
      record.repo === input.repo,
  );
}

function explorerUrl(config: SiteConfig, tx: string): string {
  return `${config.chain.explorerUrl.replace(/\/+$/u, '')}/tx/${tx}`;
}

function resultBase(
  config: SiteConfig,
  commit: string,
  contract: string,
  sender: string,
): Pick<AnchorResult, 'commit' | 'commitShort' | 'contract' | 'sender'> {
  return {
    commit,
    commitShort: commit.slice(0, 7),
    contract,
    sender,
  };
}

function makeRecord(
  config: SiteConfig,
  commit: string,
  contract: string,
  sender: string,
  event: AnchorEvent,
  rpcUrl: string,
): AnchorRecord {
  return {
    schema: 1,
    chain: config.chain.name,
    chainId: config.chain.chainId,
    commit,
    contract,
    sender,
    tx: event.txHash,
    block: event.blockNumber,
    blockTimestamp:
      event.blockTimestamp ?? getBlockTimestamp(event.blockNumber, rpcUrl),
    ...(event.logIndex === undefined ? {} : { logIndex: event.logIndex }),
    repo: config.repo,
  };
}

async function publishRecord(
  root: string,
  record: AnchorRecord,
  options: AnchorOptions,
): Promise<{ changed: boolean; pushed: boolean; pushFailed: boolean; warnings: string[] }> {
  const worktree = await ensureAnchorsWorktree(root);
  const before = await readWorktreeIndex(worktree);
  const warnings = [...before.warnings];
  const appended = await appendIndexRecord(worktree, record);
  warnings.push(...appended.warnings);

  if (!appended.changed) {
    if (!options.keepWorktree) await removeAnchorsWorktree(root);
    return { changed: false, pushed: false, pushFailed: false, warnings };
  }

  await commitIndexRecord(worktree, record, {
    authorName: options.authorName,
    authorEmail: options.authorEmail,
  });

  let pushed = false;
  let pushFailed = false;
  if (!options.noPush) {
    try {
      const result = await pushAnchorsBranch(worktree, {
        authorName: options.authorName,
        authorEmail: options.authorEmail,
      });
      pushed = result.pushed;
      if (result.warning) warnings.push(result.warning);
    } catch (error) {
      pushFailed = true;
      warnings.push(
        `Could not push the anchors branch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!options.keepWorktree) await removeAnchorsWorktree(root);
  return { changed: true, pushed, pushFailed, warnings };
}

export async function anchorCommit(options: AnchorOptions): Promise<AnchorResult> {
  const config = loadSiteConfig();
  if (!config.chain.enabled) {
    throw new Error('Blockchain anchoring is disabled in site.config.ts.');
  }

  const contract = (options.contract ?? config.chain.contract).toLowerCase();
  const sender = config.chain.address.toLowerCase();
  const rpcUrl =
    options.rpcUrl ?? options.env?.ANCHOR_RPC_URL ?? config.chain.rpcUrl;
  const commit = resolveCommit(options.root, options.commit ?? 'HEAD');

  if (!options.allowAnyCommit) assertAncestor(options.root, commit);

  const chainId = getChainId(rpcUrl);
  if (chainId !== config.chain.chainId) {
    throw new Error(
      `RPC chainId ${chainId} does not match site.config.ts (${config.chain.chainId}).`,
    );
  }
  const code = getContractCode(contract, rpcUrl);
  if (!code || code === '0x') {
    throw new Error(`No contract code at ${contract} on chain ${chainId}.`);
  }

  fetchAnchors(options.root);
  const index = readAnchorRecords(options.root);
  const existing = existingRecord(index.records, {
    commit,
    contract,
    sender,
    repo: config.repo,
  });
  if (existing) {
    return {
      ok: true,
      action: 'skipped',
      ...resultBase(config, commit, contract, sender),
      tx: existing.tx,
      block: existing.block,
      blockTimestamp: existing.blockTimestamp,
      ...(existing.logIndex === undefined ? {} : { logIndex: existing.logIndex }),
      explorerUrl: explorerUrl(config, existing.tx),
      pushed: false,
      warnings: index.warnings,
    };
  }

  let event: AnchorEvent | undefined;
  if (!options.forceResend) {
    try {
      const events = await findAnchorEvents({
        contract,
        sender,
        commit,
        rpcUrl,
        deployBlock: config.chain.deployBlock,
      });
      event = events[0];
    } catch (error) {
      if (!options.forceResend) {
        throw new Error(
          `Could not check existing anchors on chain; refusing to send a possible duplicate. ` +
            `Set ANCHOR_RPC_URL to another endpoint or pass --force-resend. (${
              error instanceof Error ? error.message : String(error)
            })`,
        );
      }
    }
  }

  if (event) {
    const record = makeRecord(config, commit, contract, sender, event, rpcUrl);
    if (options.dryRun) {
      return {
        ok: true,
        action: 'skipped',
        ...resultBase(config, commit, contract, sender),
        tx: record.tx,
        block: record.block,
        blockTimestamp: record.blockTimestamp,
        ...(record.logIndex === undefined ? {} : { logIndex: record.logIndex }),
        explorerUrl: explorerUrl(config, record.tx),
        pushed: false,
        warnings: [...index.warnings, 'Existing anchor found on chain.'],
      };
    }

    const published = await publishRecord(options.root, record, options);
    return {
      ok: !published.pushFailed,
      action: published.changed ? 'recovered' : 'skipped',
      ...resultBase(config, commit, contract, sender),
      tx: record.tx,
      block: record.block,
      blockTimestamp: record.blockTimestamp,
      ...(record.logIndex === undefined ? {} : { logIndex: record.logIndex }),
      explorerUrl: explorerUrl(config, record.tx),
      pushed: published.pushed,
      warnings: [...index.warnings, ...published.warnings],
    };
  }

  if (options.recoverOnly) {
    return {
      ok: false,
      action: 'not-found',
      ...resultBase(config, commit, contract, sender),
      pushed: false,
      warnings: index.warnings,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      action: 'would-anchor',
      ...resultBase(config, commit, contract, sender),
      pushed: false,
      warnings: index.warnings,
    };
  }

  // Validate auth before sending, but do not print or persist the secret.
  buildCastAuthArgs(options.auth, options.env);

  const receipt = await sendAnchor({
    contract,
    sender,
    commit,
    rpcUrl,
    auth: options.auth,
    confirmations: options.confirmations ?? config.chain.confirmations ?? 2,
    env: options.env,
  });

  const record = makeRecord(
    config,
    commit,
    contract,
    sender,
    {
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      logIndex: receipt.logIndex,
      blockTimestamp: receipt.blockTimestamp,
    },
    rpcUrl,
  );
  const published = await publishRecord(options.root, record, options);

  return {
    ok: !published.pushFailed,
    action: 'anchored',
    ...resultBase(config, commit, contract, sender),
    tx: record.tx,
    block: record.block,
    blockTimestamp: record.blockTimestamp,
    ...(record.logIndex === undefined ? {} : { logIndex: record.logIndex }),
    explorerUrl: explorerUrl(config, record.tx),
    pushed: published.pushed,
    warnings: [...index.warnings, ...published.warnings],
  };
}
