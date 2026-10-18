import { truncateText } from '../../core/format.ts';
import { normalizeTags } from '../../core/schema.ts';

export type ChangeKind = 'add' | 'update' | 'follow-up' | 'draft' | 'publish' | 'remove';

function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/[*_~>#-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function bookmarkHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export function displayTitle(
  data: Record<string, unknown>,
  body: string,
  fallback: string,
): string {
  if (typeof data.title === 'string' && data.title.trim()) {
    return data.title.trim();
  }

  const host = bookmarkHost(data.url);
  if (host) return host;

  const text = plainText(body);
  return text ? truncateText(text, 40) : fallback;
}

export function primaryTagOf(data: Record<string, unknown>): string | undefined {
  try {
    return normalizeTags(data.tags as string | string[]).primaryTag;
  } catch {
    return undefined;
  }
}

export function buildCommitMessage(
  kind: ChangeKind,
  data: Record<string, unknown>,
  body: string,
  id: string,
  parentTitle?: string,
): string {
  const tag = primaryTagOf(data);
  const title = displayTitle(data, body, id);
  const verb =
    kind === 'add'
      ? 'add'
      : kind === 'update'
        ? 'update'
        : kind === 'follow-up'
          ? 'follow-up to'
          : kind === 'draft'
            ? 'draft'
            : kind === 'publish'
              ? 'publish'
              : 'remove';

  const subject = kind === 'follow-up'
    ? `${verb} ${parentTitle ?? String(data.extends ?? id)}`
    : `${verb} ${title}`;
  const prefix = tag ? `content(${tag}): ` : 'content: ';
  return `${prefix}${subject}`.replace(/\s+/gu, ' ').slice(0, 72).trimEnd();
}
