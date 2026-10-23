import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { metaRelPathFor, nodeIdFromPath, parseMetadataSource } from '../../core/metadata.ts';
import {
  buildCommitMessage,
  displayTitle,
  primaryTagOf,
  type ChangeKind,
} from '../shared/commit-message.ts';
import {
  TEMPLATE_META_SOURCE,
  TEMPLATE_PATH,
  TEMPLATE_SOURCE,
} from '../shared/content-file.ts';
import { commitPaths, getFileAtHead, pushChanges } from '../shared/git-cli.ts';
import { renameContentNode, uniqueSlug } from '../shared/slug.ts';
import type { Candidate, BlogState } from './state.ts';

export async function createTemplateFile(
  root: string,
  targetRel = TEMPLATE_PATH,
): Promise<string[]> {
  const targetMeta = metaRelPathFor(targetRel);
  await copyFile(
    path.join(root, TEMPLATE_SOURCE),
    path.join(root, targetRel),
    constants.COPYFILE_EXCL,
  );
  await copyFile(
    path.join(root, TEMPLATE_META_SOURCE),
    path.join(root, targetMeta),
    constants.COPYFILE_EXCL,
  );
  return [targetRel, targetMeta];
}

/**
 * Rename the template to a permanent id. `preferredId` (usually an AI slug
 * suggestion) wins over the title/first-line derivation; it is still
 * sanitized and de-duplicated.
 */
export async function renameTemplate(
  root: string,
  candidate: Candidate,
  preferredId?: string,
): Promise<string> {
  const desired =
    (preferredId && preferredId.trim()) ||
    (typeof candidate.data?.title === 'string' && candidate.data.title.trim()) ||
    candidate.body?.split('\n').find((line) => line.trim()) ||
    candidate.id;

  let slug = await uniqueSlug(root, desired, candidate.id);
  if (slug === 'new-blog') {
    slug = await uniqueSlug(root, 'new-blog-note', candidate.id);
  }

  return renameContentNode(root, candidate.path, slug, candidate.id);
}

function parseHeadData(root: string, relPath: string): Record<string, unknown> | null {
  const raw = getFileAtHead(root, metaRelPathFor(relPath));
  if (!raw) return null;
  try {
    return parseMetadataSource(raw) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CommitPlan {
  kind: ChangeKind;
  message: string;
  parentTitle?: string;
}

export function planCommit(state: BlogState, candidate: Candidate): CommitPlan {
  const head = parseHeadData(state.root, candidate.path);
  const data = candidate.data ?? {};
  const currentDraft = data.draft === true;
  const headDraft = head?.draft === true;
  const currentExtends = typeof data.extends === 'string' ? data.extends : undefined;
  const headExtends = typeof head?.extends === 'string' ? head.extends : undefined;

  let kind: ChangeKind;
  if (!head) {
    kind = currentExtends ? 'follow-up' : 'add';
  } else if (headDraft !== currentDraft) {
    kind = currentDraft ? 'draft' : 'publish';
  } else if (currentExtends && currentExtends !== headExtends) {
    kind = 'follow-up';
  } else {
    kind = 'update';
  }

  let parentTitle: string | undefined;
  if (currentExtends) {
    const parent = state.validation.entries.find((entry) => entry.id === currentExtends);
    if (parent) {
      parentTitle = displayTitle(
        parent.frontmatter as unknown as Record<string, unknown>,
        parent.body,
        parent.id,
      );
    }
  }

  return {
    kind,
    parentTitle,
    message: buildCommitMessage(
      kind,
      data,
      candidate.body ?? '',
      candidate.id,
      parentTitle,
    ),
  };
}

export interface CommitResult {
  path: string;
  metaPath: string;
  id: string;
  message: string;
  commit: string;
  url: string;
}

export async function commitCandidate(
  state: BlogState,
  candidate: Candidate,
  messageOverride?: string,
): Promise<CommitResult> {
  let relPath = candidate.path;
  if (candidate.id === 'new-blog') {
    relPath = await renameTemplate(state.root, candidate);
  }

  if (relPath.endsWith('new-blog.md')) {
    throw new Error('Refusing to commit the reserved new-blog.md template id.');
  }

  const metaPath = metaRelPathFor(relPath);
  const plan = planCommit(state, { ...candidate, path: relPath });
  const message = messageOverride?.trim() || plan.message;
  const commit = commitPaths(state.root, [relPath, metaPath], message);

  const id = nodeIdFromPath(relPath);
  const primaryTag = primaryTagOf(candidate.data ?? {});
  const url =
    primaryTag === state.config.homeTag
      ? '/'
      : `/n/${id.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;

  return { path: relPath, metaPath, id, message, commit, url };
}

export function push(state: BlogState): string {
  return pushChanges(state.root);
}
