import type { FileSearchHitDto, WorkspaceSearchItemDto } from "@polyth/session/web-api";
import type { PaletteCommand } from "./commands.ts";
import type { ShellMode } from "./responsiveShell.ts";

export type PaletteEntry =
  | { kind: "cmd"; id: string; cmd: PaletteCommand }
  | { kind: "workspace"; id: string; item: WorkspaceSearchItemDto }
  | { kind: "file"; id: string; hit: FileSearchHitDto }
  | { kind: "session-search"; id: "session-search" };

const ENTRY_PRIORITY: Record<ShellMode, Record<PaletteEntry["kind"], number>> = {
  wide: { cmd: 0, workspace: 1, "session-search": 2, file: 3 },
  compact: { cmd: 0, workspace: 1, "session-search": 2, file: 3 },
  phone: { workspace: 0, "session-search": 1, cmd: 2, file: 3 },
};

/** Stable form-factor ordering: desktop is verb-first, phone is resume-first. */
export function orderEntries(
  entries: readonly PaletteEntry[],
  shellMode: ShellMode,
): PaletteEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      ENTRY_PRIORITY[shellMode][a.entry.kind]
      - ENTRY_PRIORITY[shellMode][b.entry.kind]
      || a.index - b.index)
    .map(({ entry }) => entry);
}
