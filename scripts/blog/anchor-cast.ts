import {
  ANCHOR_EVENT_TOPIC0,
  encodeAddressTopic,
  encodeCommitBytes32,
} from '../../core/anchor-index.ts';
import {
  isTransientError,
  retryAsync,
  runProcess,
} from '../shared/process.ts';

export interface CastAuth {
  keystore?: string;
  account?: string;
  passwordFile?: string;
  privateKeyEnv?: string;
}

export interface CastAuthArgs {
  args: string[];
  secrets: string[];
}

/** Build cast's signing flags; exactly one auth mode is allowed. */
export function buildCastAuthArgs(
  auth: CastAuth,
  env: NodeJS.ProcessEnv = process.env,
): CastAuthArgs {
  const keystoreMode = Boolean(auth.keystore || auth.account);
  const privateKeyMode = Boolean(auth.privateKeyEnv);

  if (keystoreMode && privateKeyMode) {
    throw new Error('Use either a keystore/account or --private-key-env, not both.');
  }
  if (auth.keystore && auth.account) {
    throw new Error('Use either --keystore or --account, not both.');
  }
  if (!keystoreMode && !privateKeyMode) {
    throw new Error('No signer configured: pass --keystore/--account with --password-file, or --private-key-env.');
  }

  if (auth.privateKeyEnv) {
    const key = env[auth.privateKeyEnv];
    if (!key) throw new Error(`Environment variable ${auth.privateKeyEnv} is not set.`);
    return { args: ['--private-key', key], secrets: [key] };
  }

  if (!auth.passwordFile) {
    throw new Error('--password-file is required when using a keystore or account.');
  }

  const args = ['--password-file', auth.passwordFile];
  if (auth.keystore) args.push('--keystore', auth.keystore);
  else if (auth.account) args.push('--account', auth.account);
  return { args, secrets: [] };
}

export interface AnchorSendInput {
  contract: string;
  commit: string;
  rpcUrl: string;
  auth: CastAuth;
  confirmations: number;
  env?: NodeJS.ProcessEnv;
}

export function buildAnchorSendArgs(input: AnchorSendInput): CastAuthArgs {
  const auth = buildCastAuthArgs(input.auth, input.env);
  return {
    args: [
      'send',
      input.contract,
      'anchor(bytes32)',
      encodeCommitBytes32(input.commit),
      '--rpc-url',
      input.rpcUrl,
      '--confirmations',
      String(input.confirmations),
      '--json',
      ...auth.args,
    ],
    secrets: auth.secrets,
  };
}

/** Parse the first JSON value in stdout, tolerating log prefixes. */
export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the first object/array in the output.
  }

  const starts = ['{', '[']
    .map((char) => trimmed.indexOf(char))
    .filter((index) => index >= 0);
  if (starts.length === 0) return null;

  try {
    return JSON.parse(trimmed.slice(Math.min(...starts)));
  } catch {
    return null;
  }
}

export function parseQuantity(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/iu.test(trimmed)) return Number(BigInt(trimmed));
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Invalid numeric value: ${String(value)}`);
}

export function extractTransactionHash(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^0x[0-9a-fA-F]{64}$/u.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hash = extractTransactionHash(item);
      if (hash) return hash;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['transactionHash', 'transaction_hash', 'hash']) {
      const hash = extractTransactionHash(record[key]);
      if (hash) return hash;
    }
    for (const item of Object.values(record)) {
      const hash = extractTransactionHash(item);
      if (hash) return hash;
    }
  }
  return null;
}

function findReceipt(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (record.logs !== undefined && record.transactionHash !== undefined) return record;

  for (const key of ['data', 'result', 'receipt']) {
    const nested = findReceipt(record[key]);
    if (nested) return nested;
  }
  return null;
}

function unwrapResult(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.result !== undefined) return record.result;
    if (record.data !== undefined) return record.data;
  }
  return value;
}

export function parseLogArray(stdout: string): Array<Record<string, unknown>> {
  const result = unwrapResult(parseJsonOutput(stdout));
  if (!Array.isArray(result)) return [];
  return result.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  );
}

export interface ParsedAnchorReceipt {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  blockTimestamp: number | null;
}

/** Validate a cast receipt and locate the Anchored event. */
export function parseAnchorReceipt(
  stdout: string,
  expected: { contract: string; sender: string; commit: string },
): ParsedAnchorReceipt {
  const receipt = findReceipt(parseJsonOutput(stdout));
  if (!receipt) throw new Error('cast did not return a transaction receipt.');

  const status = receipt.status === undefined ? 1 : parseQuantity(receipt.status);
  if (status !== 1) {
    throw new Error(`Anchor transaction failed (status ${String(receipt.status)}).`);
  }

  const txHash = extractTransactionHash(receipt);
  if (!txHash) throw new Error('Receipt is missing transactionHash.');

  const blockNumber = parseQuantity(receipt.blockNumber);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const contract = expected.contract.toLowerCase();
  const senderTopic = encodeAddressTopic(expected.sender);
  const commitTopic = encodeCommitBytes32(expected.commit);

  for (const item of logs) {
    if (!item || typeof item !== 'object') continue;
    const log = item as Record<string, unknown>;
    const address = typeof log.address === 'string' ? log.address.toLowerCase() : '';
    const topics = Array.isArray(log.topics)
      ? log.topics.map((topic) => String(topic).toLowerCase())
      : [];

    if (
      address !== contract ||
      topics[0] !== ANCHOR_EVENT_TOPIC0 ||
      topics[1] !== senderTopic ||
      topics[2] !== commitTopic
    ) {
      continue;
    }

    return {
      txHash,
      blockNumber,
      logIndex: parseQuantity(log.logIndex ?? 0),
      blockTimestamp:
        log.blockTimestamp === undefined ? null : parseQuantity(log.blockTimestamp),
    };
  }

  throw new Error('The Anchored event was not found in the receipt.');
}

export interface AnchorEvent {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  blockTimestamp: number | null;
}

/** Resolve the lowest block to scan for a bounded chain check. */
export function resolveLogFromBlock(input: {
  deployBlock: number;
  latestBlock: number;
  lookbackBlocks?: number;
}): number {
  const { deployBlock, latestBlock, lookbackBlocks } = input;
  if (lookbackBlocks === undefined || lookbackBlocks <= 0) return deployBlock;
  return Math.max(deployBlock, latestBlock - lookbackBlocks + 1);
}

/** Read the current head block number. */
export function getBlockNumber(rpcUrl: string): number {
  const result = runProcess('cast', ['block-number', '--rpc-url', rpcUrl], {
    timeoutMs: 30_000,
  });
  return parseQuantity(result.stdout.trim());
}

/** Enumerate matching anchor events from the contract, lowest block first. */
export async function findAnchorEvents(input: {
  contract: string;
  sender: string;
  commit: string;
  rpcUrl: string;
  deployBlock: number;
  lookbackBlocks?: number;
}): Promise<AnchorEvent[]> {
  const lookback = input.lookbackBlocks ?? 0;
  const latestBlock = lookback > 0 ? getBlockNumber(input.rpcUrl) : null;
  const fromBlock =
    latestBlock === null
      ? input.deployBlock
      : resolveLogFromBlock({
          deployBlock: input.deployBlock,
          latestBlock,
          lookbackBlocks: lookback,
        });
  const filter = {
    address: input.contract.toLowerCase(),
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: latestBlock === null ? 'latest' : `0x${latestBlock.toString(16)}`,
    topics: [
      ANCHOR_EVENT_TOPIC0,
      encodeAddressTopic(input.sender),
      encodeCommitBytes32(input.commit),
    ],
  };

  return retryAsync(
    async () => {
      const result = runProcess(
        'cast',
        ['rpc', 'eth_getLogs', JSON.stringify(filter), '--rpc-url', input.rpcUrl],
        { timeoutMs: 60_000 },
      );

      return parseLogArray(result.stdout)
        .map((log) => ({
          txHash: typeof log.transactionHash === 'string' ? log.transactionHash : '',
          blockNumber: parseQuantity(log.blockNumber),
          logIndex: parseQuantity(log.logIndex ?? 0),
          blockTimestamp:
            log.blockTimestamp === undefined ? null : parseQuantity(log.blockTimestamp),
        }))
        .filter((event) => /^0x[0-9a-fA-F]{64}$/u.test(event.txHash))
        .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    },
    { attempts: 3, shouldRetry: isTransientError },
  );
}

export function getChainId(rpcUrl: string): number {
  const result = runProcess('cast', ['chain-id', '--rpc-url', rpcUrl], {
    timeoutMs: 30_000,
  });
  return parseQuantity(result.stdout.trim());
}

export function getContractCode(contract: string, rpcUrl: string): string {
  const result = runProcess('cast', ['code', contract, '--rpc-url', rpcUrl], {
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

export function getBlockTimestamp(blockNumber: number, rpcUrl: string): number {
  const result = runProcess(
    'cast',
    ['block', String(blockNumber), '--field', 'timestamp', '--rpc-url', rpcUrl],
    { timeoutMs: 30_000 },
  );
  return parseQuantity(result.stdout.trim());
}

export interface SendAnchorInput {
  contract: string;
  sender: string;
  commit: string;
  rpcUrl: string;
  auth: CastAuth;
  confirmations: number;
  env?: NodeJS.ProcessEnv;
}

/** Send anchor(bytes32) and return the confirmed event. */
export async function sendAnchor(
  input: SendAnchorInput,
): Promise<ParsedAnchorReceipt & { blockTimestamp: number }> {
  const built = buildAnchorSendArgs(input);
  const result = runProcess('cast', built.args, {
    redact: built.secrets,
    timeoutMs: 180_000,
  });

  const receipt = parseAnchorReceipt(result.stdout, {
    contract: input.contract,
    sender: input.sender,
    commit: input.commit,
  });
  const blockTimestamp =
    receipt.blockTimestamp ?? getBlockTimestamp(receipt.blockNumber, input.rpcUrl);

  return { ...receipt, blockTimestamp };
}
