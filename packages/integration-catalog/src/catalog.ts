// The pure catalog rules: order, sections, search and the summary counts the
// page header shows. No filesystem, no React, so both the server route and the
// browser page use the same behavior and the tests cover it once.
import {
  CATEGORY_ORDER,
  type IntegrationCategory,
  type IntegrationManifest,
} from "./manifest.ts";
import type { InstalledIntegration } from "./install.ts";

/** Category section with its entries, in display order. */
export interface CatalogSection {
  id: string;
  entries: readonly IntegrationManifest[];
}

/** The route's answer, and what the page renders from. */
export interface CatalogPayload {
  entries: IntegrationManifest[];
  /** Manifests that failed validation; shown, not swallowed. */
  problems: string[];
  stats: CatalogStats;
  /** Live MCP servers that match an entry, in this Space and this person. */
  installed: InstalledIntegration[];
}

export interface CatalogFilter {
  query?: string;
  category?: IntegrationCategory | "all";
}

export type CatalogAuthLabel = "oauth" | "token" | "none";

export interface CatalogStats {
  total: number;
  featured: number;
  oauth: number;
  token: number;
  none: number;
  local: number;
  byCategory: Readonly<Record<IntegrationCategory, number>>;
}

const byName = (left: IntegrationManifest, right: IntegrationManifest): number =>
  left.name.localeCompare(right.name, "en", { sensitivity: "base" });

const normalize = (value: string): string => value.trim().toLowerCase();

/** Every entry once: featured first, then the rest, each group by name. */
export function sortForDisplay(entries: readonly IntegrationManifest[]): IntegrationManifest[] {
  const featured = entries.filter((entry) => entry.featured === true).sort(byName);
  const rest = entries.filter((entry) => entry.featured !== true).sort(byName);
  return [...featured, ...rest];
}

/**
 * Sections in `CATEGORY_ORDER`; an entry shows under each of its categories.
 * A category with no entries is dropped rather than shown empty.
 */
export function catalogSections(entries: readonly IntegrationManifest[]): CatalogSection[] {
  const sections: CatalogSection[] = [];
  for (const category of CATEGORY_ORDER) {
    const matching = entries.filter((entry) => entry.categories.includes(category)).sort(byName);
    if (matching.length > 0) sections.push({ id: category, entries: matching });
  }
  return sections;
}

/** Featured entries, or none when the filter would hide them. */
export function featuredSection(entries: readonly IntegrationManifest[]): CatalogSection | null {
  const featured = sortForDisplay(entries).filter((entry) => entry.featured === true);
  return featured.length > 0 ? { id: "featured", entries: featured } : null;
}

/**
 * Case-insensitive match over the fields a person would type: name,
 * publisher, summary, categories and the endpoint host. A name that starts
 * with the query sorts first, so "git" finds GitHub before "Playwright".
 */
export function filterEntries(
  entries: readonly IntegrationManifest[],
  filter: CatalogFilter,
): IntegrationManifest[] {
  const query = normalize(filter.query ?? "");
  const category = filter.category ?? "all";
  const inCategory = entries.filter((entry) =>
    category === "all" || entry.categories.includes(category));
  if (!query) return sortForDisplay(inCategory);

  const terms = query.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: IntegrationManifest; score: number }> = [];
  for (const entry of inCategory) {
    const name = normalize(entry.name);
    const haystack = [
      name,
      normalize(entry.publisher),
      normalize(entry.summary),
      normalize(entry.description),
      ...entry.categories,
      endpoint(entry) ?? "",
    ].join(" ");
    if (!terms.every((term) => haystack.includes(term))) continue;
    const score = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3;
    scored.push({ entry, score });
  }
  return scored
    .sort((left, right) => left.score - right.score || byName(left.entry, right.entry))
    .map((item) => item.entry);
}

/** The endpoint a person would recognize: a URL, or the local command. */
export function endpoint(entry: IntegrationManifest): string | undefined {
  if (entry.mcp.remote) return entry.mcp.remote.url;
  if (entry.mcp.local) return entry.mcp.local.command.join(" ");
  return undefined;
}

/** True when the endpoint reaches the network (a local server still may). */
export function isLocal(entry: IntegrationManifest): boolean {
  return entry.mcp.local !== undefined;
}

export function catalogStats(entries: readonly IntegrationManifest[]): CatalogStats {
  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [category, entries.filter((entry) => entry.categories.includes(category)).length]),
  ) as Record<IntegrationCategory, number>;
  return {
    total: entries.length,
    featured: entries.filter((entry) => entry.featured === true).length,
    oauth: entries.filter((entry) => entry.mcp.auth === "oauth").length,
    token: entries.filter((entry) => entry.mcp.auth === "token").length,
    none: entries.filter((entry) => entry.mcp.auth === "none").length,
    local: entries.filter(isLocal).length,
    byCategory,
  };
}

/** What a person needs to know before connecting: how they prove who they are. */
export function authSummary(entry: IntegrationManifest): string {
  if (entry.mcp.auth === "oauth") return "Sign in with the service (OAuth)";
  if (entry.mcp.auth === "token") {
    return entry.mcp.remote?.tokenOptional === true ? "Works without a token; a key raises limits" : "Needs an API token";
  }
  return isLocal(entry) ? "Runs locally, no sign-in" : "No sign-in";
}

/** The parts this entry would install, as plain words. */
export function componentSummary(entry: IntegrationManifest): string[] {
  const parts = [isLocal(entry) ? "Local MCP server" : "Remote MCP server"];
  if (entry.skills && entry.skills.length > 0) {
    parts.push(entry.skills.length === 1 ? "1 skill" : `${entry.skills.length} skills`);
  }
  return parts;
}
