import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { metaRelPathFor, nodeIdFromPath, parseMetadataSource } from '../../core/metadata.ts';

export function slugify(input: string): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase();

  return ascii
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-+/gu, '-')
    .slice(0, 64)
    .replace(/-+$/u, '');
}

export function randomId(): string {
  return `post-${randomBytes(4).toString('hex')}`;
}

export function makeSlug(input: string): string {
  return slugify(input) || randomId();
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const contentDir = path.join(root, 'content');
  const names = await readdir(contentDir, { recursive: true });
  return names
    .map((name) => name.replace(/\\/gu, '/'))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort();
}

export async function collectExistingIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const relative of await listMarkdownFiles(root)) {
    ids.add(relative.replace(/\.md$/iu, ''));

    try {
      const metaRel = metaRelPathFor(`content/${relative}`);
      const source = await readFile(path.join(root, metaRel), 'utf8');
      const data = parseMetadataSource(source);
      const aliases = data.aliases;
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          if (typeof alias === 'string' && alias.trim()) ids.add(alias.trim());
        }
      }
    } catch {
      // A malformed file will be reported by content validation.
    }
  }

  return ids;
}

export async function uniqueSlug(
  root: string,
  desired: string,
  currentId?: string,
): Promise<string> {
  const ids = await collectExistingIds(root);
  if (currentId) ids.delete(currentId);

  const base = makeSlug(desired);
  if (!ids.has(base)) return base;

  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }

  return `${base}-${randomBytes(2).toString('hex')}`;
}

/**
 * Rename a content node's body and sidecar to a new id.
 * Returns the new relative body path; existing ids are resolved with a numeric suffix.
 */
export async function renameContentNode(
  root: string,
  fromRel: string,
  desiredId: string,
  currentId?: string,
): Promise<string> {
  const current = currentId ?? nodeIdFromPath(fromRel);
  const id = await uniqueSlug(root, desiredId, current);
  const nextRel = `content/${id}.md`;
  if (nextRel === fromRel) return fromRel;

  const nextMeta = metaRelPathFor(nextRel);
  await rename(path.join(root, fromRel), path.join(root, nextRel));

  const currentMeta = metaRelPathFor(fromRel);
  try {
    await rename(path.join(root, currentMeta), path.join(root, nextMeta));
  } catch {
    // Sidecar is optional; validation reports it when the content needs one.
  }

  return nextRel;
}
