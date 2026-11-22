// How the agent activity details are laid out in this browser: the tab that
// was open last and the order of the blocks (the context card, the figure
// tiles, the latest request and the plan). Presentation only: kept in
// localStorage, never in session history, and a damaged or older record
// degrades to the defaults instead of throwing.
import { useSyncExternalStore } from "react";

export type ActivityTab = "stats" | "content";

export type ActivityBlockId =
  | "context"
  | "duration"
  | "messages"
  | "tokens"
  | "cost"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "request"
  | "plan";

export interface ActivityBlockDefinition {
  id: ActivityBlockId;
  /** The tab that shows the block when details open as tabs. */
  tab: ActivityTab;
  /** A tile shares its line with other tiles; a row fills a line. */
  shape: "tile" | "row";
}

/** Default order: the figures that every agent reports come first, so a
 *  provider that reports little still starts with a full line. */
export const ACTIVITY_BLOCKS: readonly ActivityBlockDefinition[] = [
  { id: "context", tab: "stats", shape: "row" },
  { id: "duration", tab: "stats", shape: "tile" },
  { id: "messages", tab: "stats", shape: "tile" },
  { id: "tokens", tab: "stats", shape: "tile" },
  { id: "cost", tab: "stats", shape: "tile" },
  { id: "input", tab: "stats", shape: "tile" },
  { id: "output", tab: "stats", shape: "tile" },
  { id: "cacheRead", tab: "stats", shape: "tile" },
  { id: "cacheWrite", tab: "stats", shape: "tile" },
  { id: "request", tab: "content", shape: "row" },
  { id: "plan", tab: "content", shape: "row" },
];

export const DEFAULT_ACTIVITY_ORDER: readonly ActivityBlockId[] = ACTIVITY_BLOCKS.map((block) => block.id);

const DEFINITIONS = new Map(ACTIVITY_BLOCKS.map((block) => [block.id, block]));

export function activityBlock(id: ActivityBlockId): ActivityBlockDefinition {
  return DEFINITIONS.get(id)!;
}

export interface ActivityLayout {
  tab: ActivityTab;
  order: ActivityBlockId[];
}

export const DEFAULT_ACTIVITY_LAYOUT: ActivityLayout = { tab: "stats", order: [...DEFAULT_ACTIVITY_ORDER] };

/** Every known block exactly once. Unknown and repeated ids are dropped; a
 *  block the record predates joins right after its nearest default
 *  predecessor, so a new figure lands where it would by default. */
export function normalizeActivityOrder(value: unknown): ActivityBlockId[] {
  const order: ActivityBlockId[] = [];
  const seen = new Set<ActivityBlockId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string" || !DEFINITIONS.has(entry as ActivityBlockId)) continue;
      const id = entry as ActivityBlockId;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  DEFAULT_ACTIVITY_ORDER.forEach((id, index) => {
    if (seen.has(id)) return;
    const predecessor = DEFAULT_ACTIVITY_ORDER.slice(0, index).reverse().find((candidate) => seen.has(candidate));
    order.splice(predecessor ? order.indexOf(predecessor) + 1 : 0, 0, id);
    seen.add(id);
  });
  return order;
}

export function parseActivityLayout(raw: string | null): ActivityLayout {
  if (!raw) return { ...DEFAULT_ACTIVITY_LAYOUT, order: [...DEFAULT_ACTIVITY_ORDER] };
  try {
    const value = JSON.parse(raw) as { tab?: unknown; order?: unknown } | null;
    return {
      tab: value?.tab === "content" ? "content" : "stats",
      order: normalizeActivityOrder(value?.order),
    };
  } catch {
    return { ...DEFAULT_ACTIVITY_LAYOUT, order: [...DEFAULT_ACTIVITY_ORDER] };
  }
}

/** The blocks one tab shows, in the saved order; `null` is every block (the
 *  combined view). */
export function activityBlocksOf(order: readonly ActivityBlockId[], tab: ActivityTab | null): ActivityBlockId[] {
  return tab === null ? [...order] : order.filter((id) => activityBlock(id).tab === tab);
}

/** Write a new order of some blocks (those one tab shows) into the full
 *  order: the other blocks keep their places. */
export function permuteActivityOrder(
  order: readonly ActivityBlockId[],
  subset: readonly ActivityBlockId[],
): ActivityBlockId[] {
  const members = new Set(subset);
  if (members.size !== subset.length || ![...members].every((id) => order.includes(id))) return [...order];
  let next = 0;
  return order.map((id) => (members.has(id) ? subset[next++]! : id));
}

export function isDefaultActivityOrder(order: readonly ActivityBlockId[]): boolean {
  return order.length === DEFAULT_ACTIVITY_ORDER.length && order.every((id, index) => id === DEFAULT_ACTIVITY_ORDER[index]);
}

// ------------------------------------------------------------- the record

export const ACTIVITY_LAYOUT_KEY = "polyth.sessionActivityLayout.v1";

function readStored(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVITY_LAYOUT_KEY); } catch { return null; }
}

let layout: ActivityLayout = parseActivityLayout(readStored());
const listeners = new Set<() => void>();

function commit(next: ActivityLayout): void {
  if (next.tab === layout.tab && next.order.length === layout.order.length && next.order.every((id, index) => id === layout.order[index])) return;
  layout = next;
  try { localStorage.setItem(ACTIVITY_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode: this visit only */ }
  for (const listener of listeners) listener();
}

export function getActivityLayout(): ActivityLayout {
  return layout;
}

export function setActivityTab(tab: ActivityTab): void {
  commit({ ...layout, tab });
}

export function setActivityOrder(order: readonly ActivityBlockId[]): void {
  commit({ ...layout, order: normalizeActivityOrder(order) });
}

export function resetActivityOrder(): void {
  commit({ ...layout, order: [...DEFAULT_ACTIVITY_ORDER] });
}

export function subscribeActivityLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActivityLayout(): ActivityLayout {
  return useSyncExternalStore(subscribeActivityLayout, getActivityLayout, () => DEFAULT_ACTIVITY_LAYOUT);
}
