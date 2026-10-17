import type { CompileIssue } from './contract.ts';
import type { ParsedContent } from './content.ts';

export interface TreeNode {
  id: string;
  content: ParsedContent;
  primaryTag: string;
  secondaryTags: string[];
  rawTags: string;
  aliases: string[];
  extendsId?: string;
  parentId?: string;
  ancestorIds: string[];
  childIds: string[];
  rootId: string;
  draft: boolean;
}

export interface TreeResult {
  nodes: Map<string, TreeNode>;
  issues: CompileIssue[];
}

function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length]!;
}

function suggestIds(value: string, ids: string[], limit = 5): string[] {
  return [...ids]
    .map((id) => ({ id, distance: levenshtein(value, id) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((item) => item.id);
}

export function buildTree(entries: ParsedContent[]): TreeResult {
  const issues: CompileIssue[] = [];
  const byId = new Map<string, TreeNode>();
  const aliasToId = new Map<string, string>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      issues.push({
        level: 'error',
        file: entry.relPath,
        field: 'id',
        message: `Duplicate node id "${entry.id}".`,
      });
      continue;
    }

    const node: TreeNode = {
      id: entry.id,
      content: entry,
      primaryTag: entry.tags.primaryTag,
      secondaryTags: entry.tags.secondaryTags,
      rawTags: entry.tags.rawTags,
      aliases: entry.frontmatter.aliases ?? [],
      draft: entry.frontmatter.draft ?? false,
      ancestorIds: [],
      childIds: [],
      rootId: entry.id,
    };

    if (entry.frontmatter.extends) {
      node.extendsId = entry.frontmatter.extends;
    }

    byId.set(entry.id, node);

    for (const alias of node.aliases) {
      const existing = aliasToId.get(alias) ?? byId.get(alias)?.id;
      if (existing && existing !== entry.id) {
        issues.push({
          level: 'error',
          file: entry.relPath,
          field: 'aliases',
          message: `Alias "${alias}" is already used by node "${existing}".`,
        });
        continue;
      }
      aliasToId.set(alias, entry.id);
    }
  }

  const knownIds = [...byId.keys()];

  const resolveId = (value: string): string | undefined => {
    if (byId.has(value)) return value;
    return aliasToId.get(value);
  };

  for (const node of byId.values()) {
    if (!node.extendsId) continue;

    const resolved = resolveId(node.extendsId);
    if (!resolved) {
      issues.push({
        level: 'error',
        file: node.content.relPath,
        field: 'extends',
        message: `Cannot find parent node "${node.extendsId}".`,
        suggestion: `Did you mean: ${suggestIds(node.extendsId, knownIds).join(', ')}?`,
      });
      continue;
    }

    if (resolved === node.id) {
      issues.push({
        level: 'error',
        file: node.content.relPath,
        field: 'extends',
        message: 'A node cannot extend itself.',
      });
      continue;
    }

    node.parentId = resolved;
  }

  // Cycle detection with three colors: 0 = unvisited, 1 = visiting, 2 = done.
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visitForCycle = (id: string): void => {
    const status = state.get(id) ?? 0;
    if (status === 2) return;
    if (status === 1) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(' -> ');
      issues.push({
        level: 'error',
        file: byId.get(id)?.content.relPath,
        field: 'extends',
        message: `Cycle detected in extends chain: ${cycle}`,
      });
      return;
    }

    state.set(id, 1);
    stack.push(id);

    const node = byId.get(id);
    if (node?.parentId) visitForCycle(node.parentId);

    stack.pop();
    state.set(id, 2);
  };

  for (const id of byId.keys()) visitForCycle(id);

  // Stop here if the parent graph is invalid; derived fields would be unreliable.
  if (issues.some((issue) => issue.level === 'error')) {
    return { nodes: byId, issues };
  }

  for (const node of byId.values()) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      parent?.childIds.push(node.id);
    }
  }

  const computeAncestors = (id: string): string[] => {
    const ancestors: string[] = [];
    let current = byId.get(id)?.parentId;
    const seen = new Set<string>();

    while (current && !seen.has(current)) {
      seen.add(current);
      ancestors.push(current);
      current = byId.get(current)?.parentId;
    }

    return ancestors.reverse();
  };

  for (const node of byId.values()) {
    node.ancestorIds = computeAncestors(node.id);
    node.rootId = node.ancestorIds[0] ?? node.id;

    if (!node.draft) {
      const draftAncestor = node.ancestorIds
        .map((id) => byId.get(id))
        .find((ancestor) => ancestor?.draft);
      if (draftAncestor) {
        issues.push({
          level: 'error',
          file: node.content.relPath,
          field: 'extends',
          message: `Published node extends draft node "${draftAncestor.id}". Publish the parent or remove the reference.`,
        });
      }
    }
  }

  return { nodes: byId, issues };
}
