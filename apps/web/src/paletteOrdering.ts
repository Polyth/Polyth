import type { FileSearchHitDto, WorkspaceSearchItemDto } from "@polyth/session/web-api";
import { commandHint, foldText, type PaletteCommand } from "./commands.ts";
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

/** How well a command matches a folded query; 0 = no match. Label hits beat
 * keyword, group and id/hint hits so the best answer surfaces first. */
export function commandMatchScore(cmd: PaletteCommand, folded: string): number {
  if (!folded) return 1;
  const label = foldText(cmd.label);
  if (label === folded) return 100;
  if (label.startsWith(folded)) return 90;
  const at = label.indexOf(folded);
  if (at > 0 && /[^\p{L}\p{N}]/u.test(label[at - 1]!)) return 80;
  if (at >= 0) return 70;
  const keywords = (cmd.keywords ?? []).map(foldText);
  if (keywords.some((keyword) => keyword.startsWith(folded))) return 60;
  if (keywords.some((keyword) => keyword.includes(folded))) return 50;
  if (foldText(cmd.group ?? "").includes(folded)) return 40;
  if (cmd.id.toLowerCase().includes(folded)) return 30;
  const hint = commandHint(cmd);
  return hint && foldText(hint).includes(folded) ? 20 : 0;
}

/**
 * Rank already-filtered commands and keep every group contiguous, so a group
 * header is rendered once. Without a query, groups keep their registration
 * order; with one, the group holding the best hit leads and rows inside a
 * group are ordered by match quality (ties keep registration order).
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const folded = foldText(query.trim());
  const groups = new Map<string, { first: number; best: number; rows: { cmd: PaletteCommand; score: number; index: number }[] }>();
  commands.forEach((cmd, index) => {
    const key = cmd.group ?? "";
    const score = commandMatchScore(cmd, folded);
    const group = groups.get(key) ?? { first: index, best: 0, rows: [] };
    group.best = Math.max(group.best, score);
    group.rows.push({ cmd, score, index });
    groups.set(key, group);
  });
  return [...groups.values()]
    .sort((a, b) => (folded ? b.best - a.best : 0) || a.first - b.first)
    .flatMap((group) => group.rows
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((row) => row.cmd));
}

/**
 * Split `text` into plain and matched runs for `query`. Highlighting is only
 * offered when folding keeps offsets aligned, so a mark never lands on the
 * wrong characters.
 */
export function highlightRuns(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const folded = foldText(query.trim());
  const haystack = foldText(text);
  const at = folded && haystack.length === text.length ? haystack.indexOf(folded) : -1;
  if (at < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + folded.length), match: true },
    { text: text.slice(at + folded.length), match: false },
  ].filter((run) => run.text);
}
