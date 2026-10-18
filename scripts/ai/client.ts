import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../../core/hash.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing-key'
      | 'http'
      | 'timeout'
      | 'parse'
      | 'empty'
      | 'invalid-response',
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function getAiConfig(): AiConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || undefined;
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(
    /\/+$/u,
    '',
  );
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
  const timeoutMs = Number(process.env.BLOG_AI_TIMEOUT_MS ?? 60_000);

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
  };
}

function chatEndpoint(baseUrl: string): string {
  return `${baseUrl}/chat/completions`;
}

function extractJson(text: string): unknown {
  let value = text.trim();
  value = value.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();

  try {
    return JSON.parse(value) as unknown;
  } catch {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(value.slice(start, end + 1)) as unknown;
    }
    throw new AiError('Model response was not valid JSON.', 'parse');
  }
}

interface ChatPayload {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: AiUsage;
}

async function postChat(
  config: AiConfig,
  messages: ChatMessage[],
  maxTokens: number,
  simplified: boolean,
): Promise<ChatPayload> {
  if (!config.apiKey) {
    throw new AiError(
      'DEEPSEEK_API_KEY is not set. Add it to the environment before using `npm run ai`.',
      'missing-key',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
    };
    if (!simplified) {
      body.thinking = { type: 'disabled' };
      body.response_format = { type: 'json_object' };
      body.temperature = 0.2;
    }

    const response = await fetch(chatEndpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new AiError(
        `DeepSeek request failed (${response.status}): ${text.slice(0, 500)}`,
        'http',
      );
    }

    return JSON.parse(text) as ChatPayload;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiError(`DeepSeek request timed out after ${config.timeoutMs}ms.`, 'timeout');
    }
    throw new AiError(
      `DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`,
      'http',
    );
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(root: string, key: string): string {
  return path.join(root, '.cache', 'ai', `${key}.json`);
}

export interface ChatJsonOptions<T> {
  root: string;
  messages: ChatMessage[];
  maxTokens?: number;
  cacheKey?: string;
  noCache?: boolean;
  parse: (value: unknown) => T;
}

export interface ChatJsonResult<T> {
  data: T;
  usage?: AiUsage;
  cached: boolean;
  model: string;
}

export async function chatJson<T>(
  options: ChatJsonOptions<T>,
): Promise<ChatJsonResult<T>> {
  const config = getAiConfig();
  const maxTokens = options.maxTokens ?? 2_000;
  const key = sha256Hex(
    JSON.stringify({
      model: config.model,
      messages: options.messages,
      maxTokens,
      extra: options.cacheKey ?? '',
    }),
  );
  const file = cachePath(options.root, key);

  if (!options.noCache) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as {
        raw: unknown;
        usage?: AiUsage;
      };
      return {
        data: options.parse(cached.raw),
        usage: cached.usage,
        cached: true,
        model: config.model,
      };
    } catch {
      // Cache miss or stale cache; request fresh data.
    }
  }

  let payload = await postChat(config, options.messages, maxTokens, false).catch((error) => {
    if (error instanceof AiError && error.code === 'http' && /400|response_format|thinking/iu.test(error.message)) {
      return postChat(config, options.messages, maxTokens, true);
    }
    throw error;
  });

  let content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new AiError('DeepSeek returned an empty response.', 'empty');
  }

  let raw: unknown;
  try {
    raw = extractJson(content);
  } catch {
    const repairMessages: ChatMessage[] = [
      ...options.messages,
      { role: 'assistant', content },
      {
        role: 'user',
        content:
          'Your previous response was not valid JSON. Return only one valid JSON object matching the requested schema.',
      },
    ];
    payload = await postChat(config, repairMessages, maxTokens, false);
    content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AiError('DeepSeek returned an empty repair response.', 'empty');
    raw = extractJson(content);
  }

  const data = options.parse(raw);

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ raw, usage: payload.usage }, null, 2), 'utf8');
  } catch {
    // Cache failures must not break the command.
  }

  return {
    data,
    usage: payload.usage,
    cached: false,
    model: config.model,
  };
}

export function aiConfigSummary(): Array<{ name: string; ok: boolean; detail: string }> {
  const config = getAiConfig();
  return [
    {
      name: 'deepseek-key',
      ok: Boolean(config.apiKey),
      detail: config.apiKey ? 'configured' : 'DEEPSEEK_API_KEY is not set',
    },
    { name: 'model', ok: true, detail: config.model },
    { name: 'base-url', ok: true, detail: config.baseUrl },
    { name: 'timeout', ok: true, detail: `${config.timeoutMs}ms` },
  ];
}
