export interface SessionTreeItem {
  id: string;
  parentId?: string;
}

export interface SessionTreeNode<T extends SessionTreeItem> {
  item: T;
  children: SessionTreeNode<T>[];
}

/**
 * Whether a session takes a navigator row of its own. A delegated child (a
 * subagent, a workflow unit) is reached through its parent: while the parent
 * is listed the child rides inside its disclosure and never takes a root slot
 * — a workflow parent runs no turn of its own, so its units would otherwise
 * outrank it and show as separate chats. A child whose parent has not loaded
 * yet is withheld while that parent may still arrive (`parentPending`). Only
 * a child whose parent is known not to be listed (archived, filtered out,
 * gone) stands on its own.
 */
export function isNavigatorRoot(
  item: SessionTreeItem,
  listedIds: ReadonlySet<string>,
  parentPending: (parentId: string) => boolean,
): boolean {
  if (!item.parentId) return true;
  if (listedIds.has(item.parentId)) return false;
  return !parentPending(item.parentId);
}

/** Listed children per parent id, in the caller's order. */
export function childrenByParent<T extends SessionTreeItem>(
  items: readonly T[],
): Map<string, T[]> {
  const ids = new Set(items.map((item) => item.id));
  const byParent = new Map<string, T[]>();
  for (const item of items) {
    if (!item.parentId || !ids.has(item.parentId) || item.parentId === item.id) continue;
    byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
  }
  return byParent;
}

/** Listed ancestors of `id`, nearest first. */
export function listedAncestors<T extends SessionTreeItem>(
  id: string | null | undefined,
  byId: ReadonlyMap<string, T>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let parentId = id ? byId.get(id)?.parentId : undefined;
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    out.push(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return out;
}

/**
 * Keep a paged/filtered session list structurally useful. A visible child
 * brings its known ancestors along, and a visible parent brings its known
 * descendants along, while the input order remains the navigation order.
 */
export function includeSessionTreeContext<T extends SessionTreeItem>(
  items: readonly T[],
  seed: readonly T[],
  options: { ancestors?: boolean } = {},
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const included = new Set(seed.map((item) => item.id).filter((id) => byId.has(id)));

  let changed = true;
  while (changed) {
    changed = false;
    if (options.ancestors !== false) for (const id of [...included]) {
      const parentId = byId.get(id)?.parentId;
      if (parentId && byId.has(parentId) && !included.has(parentId)) {
        included.add(parentId);
        changed = true;
      }
    }
    for (const item of items) {
      if (item.parentId && included.has(item.parentId) && !included.has(item.id)) {
        included.add(item.id);
        changed = true;
      }
    }
  }

  return items.filter((item) => included.has(item.id));
}

/** Build a stable parentId tree without changing the caller's item order. */
export function buildSessionTree<T extends SessionTreeItem>(
  items: readonly T[],
): SessionTreeNode<T>[] {
  const ids = new Set(items.map((item) => item.id));
  const byParent = new Map<string, T[]>();
  for (const item of items) {
    if (!item.parentId || !ids.has(item.parentId)) continue;
    byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
  }

  const roots = items.filter((item) => !item.parentId || !ids.has(item.parentId));
  const rendered = new Set<string>();
  const build = (item: T, ancestors: ReadonlySet<string>): SessionTreeNode<T> => {
    rendered.add(item.id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(item.id);
    const children = (byParent.get(item.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id) && !rendered.has(child.id))
      .map((child) => build(child, nextAncestors));
    return { item, children };
  };

  const output: SessionTreeNode<T>[] = [];
  for (const item of [...roots, ...items]) {
    if (rendered.has(item.id)) continue;
    output.push(build(item, new Set()));
  }
  return output;
}
