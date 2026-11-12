// What the skill pages decide, apart from how they draw it.
import type {
  CapabilityInstallationScope,
  SkillAccessDto,
  SkillCatalogDto,
  SkillCatalogSkillDto,
  SkillHarnessDto,
  SkillLibraryDto,
  SkillLibraryEntryDto,
  SkillLibraryNativeDto,
} from "@polyth/contracts/capability-installations";
import type { SkillHarnessMode } from "@polyth/contracts/capability-installations";
import { harnessMode, skillReach, type ReachSource } from "../src/skillReach.ts";
import { rankSkillMatches } from "../src/skillSearch.ts";

export interface CatalogFilter {
  query: string;
  sourceId: string | null;
  collection: string | null;
}

export interface CatalogView {
  rows: SkillCatalogSkillDto[];
  /** Skills per source under the query alone, so a tile can say how many it holds. */
  matchesBySource: Map<string, number>;
  /** The chosen source's shelves, in reading order, under the query alone. */
  collections: string[];
  /** "Start here" belongs to a calm, unfiltered catalog only. */
  shelf: SkillCatalogSkillDto[];
}

export function catalogView(catalog: SkillCatalogDto, filter: CatalogFilter): CatalogView {
  const query = filter.query.trim();
  const matches = rankSkillMatches(catalog.skills, query);
  const matchesBySource = new Map<string, number>();
  for (const skill of matches) matchesBySource.set(skill.sourceId, (matchesBySource.get(skill.sourceId) ?? 0) + 1);
  const inSource = filter.sourceId ? matches.filter((skill) => skill.sourceId === filter.sourceId) : matches;
  const collections = filter.sourceId
    ? [...new Set(inSource.flatMap((skill) => (skill.collection ? [skill.collection] : [])))].sort((a, b) => a.localeCompare(b))
    : [];
  const rows = filter.collection ? inSource.filter((skill) => skill.collection === filter.collection) : inSource;
  return {
    // A query keeps its ranking; a browsed list reads alphabetically.
    rows: query ? rows : [...rows].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
    matchesBySource,
    collections,
    shelf: !query && !filter.sourceId ? catalog.skills.filter((skill) => skill.featured) : [],
  };
}

/** Where a one-click install lands: the open project when the person can write
 * there, the whole Space otherwise, and nowhere when they can do neither. */
export function defaultInstallScope(access: SkillAccessDto, projectId: string | null | undefined): CapabilityInstallationScope | undefined {
  if (projectId && access.project) return "project";
  return access.space ? "space" : undefined;
}

export type HarnessState =
  /** Polyth hands it over. */
  | "polyth"
  /** A person switched it off for this harness. */
  | "off"
  /** This harness cannot honor it: no way in, or it cannot block the skill's tools. */
  | "unsupported"
  /** The harness has this skill of its own. */
  | "own"
  /** The harness has it, and Polyth keeps it from the model. */
  | "muted"
  /** Nothing reaches this harness yet. */
  | "absent";

export interface HarnessAvailability {
  harness: SkillHarnessDto;
  state: HarnessState;
  native?: SkillLibraryNativeDto;
  /** A managed skill only: what this harness's reach says, and which rule says it. */
  mode?: SkillHarnessMode;
  source?: ReachSource;
}

export function availabilityOf(entry: SkillLibraryEntryDto, harnesses: readonly SkillHarnessDto[]): HarnessAvailability[] {
  return harnesses.map((harness) => {
    const native = entry.natives.find((row) => row.harnessId === harness.id);
    const withNative = native ? { native } : {};
    if (entry.managed) {
      const blocked = Boolean(entry.managed.disallowedTools?.length) && !harness.enforcesBlockedTools;
      if (harness.delivery === "none" || blocked) {
        return native?.enabled
          ? { harness, state: "own" as const, native }
          : { harness, state: "unsupported" as const, ...withNative };
      }
      const { mode, source } = harnessMode(skillReach(entry.managed), harness);
      return { harness, state: mode === "off" ? "off" as const : "polyth" as const, mode, source, ...withNative };
    }
    if (native) return { harness, state: native.enabled ? "own" as const : "muted" as const, native };
    return { harness, state: "absent" as const };
  });
}

/** One family's rows: a family with several accounts is drawn as one group. */
export interface HarnessGroup {
  family: string;
  name: string;
  rows: HarnessAvailability[];
}

/** Rows in the harnesses' own order, each family gathered at its first account. */
export function harnessGroups(rows: readonly HarnessAvailability[]): HarnessGroup[] {
  const groups: HarnessGroup[] = [];
  const byFamily = new Map<string, HarnessGroup>();
  for (const row of rows) {
    const family = row.harness.family || row.harness.id;
    let group = byFamily.get(family);
    if (!group) {
      group = { family, name: row.harness.familyName || row.harness.name, rows: [] };
      byFamily.set(family, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** Roughly how many tokens a text costs in every session. */
export const tokenEstimate = (text: string): number => Math.max(1, Math.round(text.length / 4));

/** Harnesses that can really use a skill right now. */
export const usableCount = (rows: readonly HarnessAvailability[]): number =>
  rows.filter((row) => row.state === "polyth" || row.state === "own").length;

/** Harnesses a catalog skill would reach once installed. */
export const reachOf = (harnesses: readonly SkillHarnessDto[], blockedTools: boolean): SkillHarnessDto[] =>
  harnesses.filter((harness) => harness.delivery !== "none" && (!blockedTools || harness.enforcesBlockedTools));

export interface LibraryGroups {
  managed: SkillLibraryEntryDto[];
  own: SkillLibraryEntryDto[];
  builtIn: SkillLibraryEntryDto[];
}

/** Polyth's skills first, then what only some harnesses have, then what merely
 * ships inside a harness, which is the least likely reason to open this page. */
export function libraryGroups(library: SkillLibraryDto, query: string, harnessId: string | null): LibraryGroups {
  const filtered = rankSkillMatches(library.skills, query).filter((entry) => {
    if (!harnessId) return true;
    const harness = library.harnesses.find((row) => row.id === harnessId);
    if (!harness) return false;
    const state = availabilityOf(entry, [harness])[0]!.state;
    return state === "polyth" || state === "own" || state === "muted" || state === "off";
  });
  const ordered = query.trim() ? filtered : [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  const groups: LibraryGroups = { managed: [], own: [], builtIn: [] };
  for (const entry of ordered) {
    if (entry.managed) groups.managed.push(entry);
    else if (entry.natives.length && entry.natives.every((native) => native.source === "bundled")) groups.builtIn.push(entry);
    else groups.own.push(entry);
  }
  return groups;
}

/** Skills per harness under the query alone, so a harness chip says what choosing
 * it would show. */
export function harnessCounts(library: SkillLibraryDto, query: string): Map<string, number> {
  const matches = rankSkillMatches(library.skills, query);
  const counts = new Map<string, number>();
  for (const row of matches) {
    for (const item of availabilityOf(row, library.harnesses)) {
      if (item.state === "polyth" || item.state === "own" || item.state === "muted" || item.state === "off") {
        counts.set(item.harness.id, (counts.get(item.harness.id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

export const formatStars = (stars: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(stars);

/** The largest whole unit, for "Updated 3 days ago". */
export function relativeParts(then: number, now = Date.now()): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return { value: seconds, unit: "second" };
  if (abs < 3600) return { value: Math.round(seconds / 60), unit: "minute" };
  if (abs < 86_400) return { value: Math.round(seconds / 3600), unit: "hour" };
  if (abs < 30 * 86_400) return { value: Math.round(seconds / 86_400), unit: "day" };
  if (abs < 365 * 86_400) return { value: Math.round(seconds / (30 * 86_400)), unit: "month" };
  return { value: Math.round(seconds / (365 * 86_400)), unit: "year" };
}
