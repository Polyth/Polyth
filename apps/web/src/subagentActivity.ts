import type { SessionProjection } from "@polyth/contracts";
import { resolveSessionStatus } from "./sessionStatus.ts";

/** What a delegated subtree is doing for its parent's indicators. A person's
 *  turn (an approval, a question) outranks running work, as in the row's own
 *  state mark. */
export type SubagentActivityState = "waiting" | "working";

export interface SubagentActivity {
  /** Direct children counted: the disclosure's own count. */
  total: number;
  /** Direct children whose subtree is working and waits for nobody. */
  working: number;
  /** Direct children whose subtree waits for a person. */
  waiting: number;
}

/** How a caller's tree reaches ids, children and each node's own state. */
export interface SubagentTree<T> {
  idOf: (item: T) => string;
  childrenOf: (item: T) => readonly T[];
  stateOf: (item: T) => SubagentActivityState | undefined;
}

/** A session's own contribution, from the same resolver as its row mark. */
export function sessionActivityState(session: SessionProjection): SubagentActivityState | undefined {
  const kind = resolveSessionStatus(session).kind;
  if (kind === "needs-approval" || kind === "needs-reply") return "waiting";
  return kind === "working" ? "working" : undefined;
}

/** One subtree's state: the item itself or any descendant, cycle-safe. */
export function subtreeActivityState<T>(
  item: T,
  tree: SubagentTree<T>,
  seen: Set<string> = new Set(),
): SubagentActivityState | undefined {
  const id = tree.idOf(item);
  if (seen.has(id)) return undefined;
  seen.add(id);
  let state = tree.stateOf(item);
  if (state === "waiting") return state;
  for (const child of tree.childrenOf(item)) {
    const nested = subtreeActivityState(child, tree, seen);
    if (nested === "waiting") return nested;
    if (nested === "working") state = nested;
  }
  return state;
}

/** Roll a parent's direct children (and everything below them) up into the
 *  counts its subagent disclosure and chat dock show. A grandchild's work or
 *  question counts for the direct child it hangs under. */
export function subagentActivity<T>(children: readonly T[], tree: SubagentTree<T>): SubagentActivity {
  const seen = new Set<string>();
  let working = 0;
  let waiting = 0;
  for (const child of children) {
    const state = subtreeActivityState(child, tree, seen);
    if (state === "waiting") waiting += 1;
    else if (state === "working") working += 1;
  }
  return { total: children.length, working, waiting };
}

/** Everything below `item` (not the item itself) that is active on its own:
 *  the nested subagents a row folds in, and what "Stop all" stops. */
export function activeDescendants<T>(item: T, tree: SubagentTree<T>, seen: Set<string> = new Set()): T[] {
  seen.add(tree.idOf(item));
  const found: T[] = [];
  for (const child of tree.childrenOf(item)) {
    if (seen.has(tree.idOf(child))) continue;
    if (tree.stateOf(child) !== undefined) found.push(child);
    found.push(...activeDescendants(child, tree, seen));
  }
  return found;
}

/** The disclosure's look: the outranking state, or none while all are idle. */
export function subagentActivityTone(activity: SubagentActivity): SubagentActivityState | undefined {
  if (activity.waiting > 0) return "waiting";
  return activity.working > 0 ? "working" : undefined;
}
