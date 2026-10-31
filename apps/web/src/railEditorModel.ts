// Pure model behind the shared rail/zone editor (RailEditor.tsx). Every icon
// rail and shell zone builds the same entry list: what is shown here (in the
// order it renders), plus what could be added — each item exactly once.
import type { ReactNode } from "react";
import type { UiSlot } from "@polyth/contracts";

export type RailEditorKind = "tool" | "widget";

export interface RailEditorEntry {
  /** Stable identity across tools and widgets (`tool:<id>` / `widget:<id>`). */
  key: string;
  kind: RailEditorKind;
  label: string;
  description?: string;
  /** Owning package, used to drop a widget that duplicates a tool. */
  ownerPackageId?: string;
  keywords?: readonly string[];
  icon: ReactNode;
  /** Visible in this rail/zone. */
  shown: boolean;
  /** Another rail/zone currently holds it; adding it here moves it. */
  elsewhere?: UiSlot;
  /** Shown here and may not be removed (moving it elsewhere is still fine). */
  locked?: boolean;
  add: () => void;
  remove: () => void;
}

export interface RailEditorSections {
  shown: RailEditorEntry[];
  tools: RailEditorEntry[];
  widgets: RailEditorEntry[];
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase();

/** One entry per identity. A widget that is the same thing as a tool (same
 * owning package and label — e.g. a package's own launcher widget) folds into
 * the tool; the tool keeps its place and inherits "shown" from either. */
export function dedupeRailEntries(entries: readonly RailEditorEntry[]): RailEditorEntry[] {
  const byKey = new Map<string, RailEditorEntry>();
  for (const entry of entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  const unique = [...byKey.values()];
  const toolIdentity = new Map<string, RailEditorEntry>();
  for (const entry of unique) {
    if (entry.kind === "tool") toolIdentity.set(`${entry.ownerPackageId ?? ""}\u0000${normalize(entry.label)}`, entry);
  }
  const result: RailEditorEntry[] = [];
  const merged = new Map<RailEditorEntry, RailEditorEntry>();
  for (const entry of unique) {
    if (entry.kind === "widget" && entry.ownerPackageId) {
      const tool = toolIdentity.get(`${entry.ownerPackageId}\u0000${normalize(entry.label)}`);
      if (tool) {
        const base = merged.get(tool) ?? tool;
        if (entry.shown && !base.shown) {
          merged.set(tool, { ...base, shown: true, elsewhere: undefined, remove: entry.remove });
        }
        continue;
      }
    }
    result.push(entry);
  }
  return result.map((entry) => merged.get(entry) ?? entry);
}

export function matchesRailQuery(entry: RailEditorEntry, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  return [entry.label, entry.description ?? "", ...(entry.keywords ?? [])]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

const byLabel = (a: RailEditorEntry, b: RailEditorEntry): number =>
  a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

/** Shown items keep their rail order; candidates are grouped (tools, then
 * widgets) and alphabetized, with items that are nowhere yet listed before
 * items that would move from another rail. */
export function railEditorSections(entries: readonly RailEditorEntry[], query = ""): RailEditorSections {
  const unique = dedupeRailEntries(entries);
  const shown = unique.filter((entry) => entry.shown && matchesRailQuery(entry, query));
  const candidates = unique.filter((entry) => !entry.shown && matchesRailQuery(entry, query));
  const ordered = (kind: RailEditorKind) => {
    const items = candidates.filter((entry) => entry.kind === kind);
    return [
      ...items.filter((entry) => entry.elsewhere === undefined).sort(byLabel),
      ...items.filter((entry) => entry.elsewhere !== undefined).sort(byLabel),
    ];
  };
  return { shown, tools: ordered("tool"), widgets: ordered("widget") };
}

/** Split a reordered shown list back into its tool and widget orders. The
 * rails render tools first and placed widgets after them, so each kind keeps
 * its own relative order. */
export function splitRailOrder(
  keys: readonly string[],
  entries: readonly RailEditorEntry[],
): { tools: string[]; widgets: string[] } {
  const kindOf = new Map(entries.map((entry) => [entry.key, entry.kind]));
  const strip = (key: string) => key.slice(key.indexOf(":") + 1);
  return {
    tools: keys.filter((key) => kindOf.get(key) === "tool").map(strip),
    widgets: keys.filter((key) => kindOf.get(key) === "widget").map(strip),
  };
}

/** Search only earns its space once a list stops fitting at a glance. */
export const RAIL_EDITOR_SEARCH_THRESHOLD = 8;
