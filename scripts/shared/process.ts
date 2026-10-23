import { spawnSync } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Strings to scrub from thrown error messages. */
  redact?: string[];
  allowFailure?: boolean;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly result?: ProcessResult,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export function redactText(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): ProcessResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
    shell: false,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const status = typeof result.status === 'number' ? result.status : 1;

  if (status !== 0 && !options.allowFailure) {
    const raw = (stderr || stdout || `${command} exited with ${status}`).trim();
    throw new ProcessError(
      redactText(raw, options.redact ?? []),
      command,
      args,
      { stdout, stderr, status },
    );
  }

  return { stdout, stderr, status };
}

export function isTransientError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /429|rate limit|timeout|timed out|ECONNRESET|ETIMEDOUT|502|503|504|temporarily unavailable/iu.test(
    text,
  );
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/** Retry an async operation with exponential backoff and jitter. */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry ? options.shouldRetry(error) : true;
      if (attempt === attempts || !retryable) break;
      const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
