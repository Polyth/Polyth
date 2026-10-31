// Ordering and row metadata for the Files tree. Folders always stay first;
// the chosen key orders each listing, and the row shows that key's value so
// the order is legible (no metadata column for the default name order).
import type { FileEntry } from "@polyth/session/web-api";
import { ago } from "../../../../apps/web/src/format.ts";

export type TreeSortMode = "name" | "modified" | "size";
export const TREE_SORT_MODES: readonly TreeSortMode[] = ["name", "modified", "size"];

export const isTreeSortMode = (value: unknown): value is TreeSortMode =>
  typeof value === "string" && (TREE_SORT_MODES as readonly string[]).includes(value);

const byName = (left: FileEntry, right: FileEntry): number => left.name.localeCompare(right.name);

/** A sorted copy; `name` keeps the server's folders-first, name order. */
export function sortEntries<T extends FileEntry>(entries: readonly T[], mode: TreeSortMode): T[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1;
    if (mode === "modified") {
      const delta = (right.mtime ?? -Infinity) - (left.mtime ?? -Infinity);
      if (delta !== 0 && Number.isFinite(delta)) return delta;
      if (left.mtime === undefined && right.mtime !== undefined) return 1;
      if (right.mtime === undefined && left.mtime !== undefined) return -1;
    } else if (mode === "size" && !left.dir) {
      const delta = (right.size ?? -1) - (left.size ?? -1);
      if (delta !== 0) return delta;
    }
    return byName(left, right);
  });
  return sorted;
}

/** Flat list order: path order for "name", newest/biggest first otherwise
 *  (ties by path). There are no folders to keep on top. */
export function sortFlat(entries: readonly FileEntry[], mode: TreeSortMode): FileEntry[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    if (mode === "modified") {
      const delta = (right.mtime ?? -1) - (left.mtime ?? -1);
      if (delta !== 0) return delta;
    } else if (mode === "size") {
      const delta = (right.size ?? -1) - (left.size ?? -1);
      if (delta !== 0) return delta;
    }
    return left.path.localeCompare(right.path);
  });
  return sorted;
}

/** Compact byte size: 512 B, 1.2 KB, 14 KB, 3.4 MB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

/** The value the current order is keyed on, or null when the row shows none. */
export function entryMeta(entry: FileEntry, mode: TreeSortMode, now = Date.now()): string | null {
  if (mode === "modified") return entry.mtime === undefined ? null : ago(entry.mtime, now);
  if (mode === "size") return entry.dir || entry.size === undefined ? null : formatSize(entry.size);
  return null;
}
