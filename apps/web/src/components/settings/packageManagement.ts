// Settings → Packages list model: status/category facets, multi-word search
// and stable ordering. Pure and DOM-free so filtering is unit-testable; the
// page only renders what this returns.
import type { PackageDescriptorDto } from "@polyth/contracts";
import type { PackagesPageMatches, PackagesPageStatus } from "@polyth/web-sdk";
import { queryTokens } from "./textMatch.ts";

export { highlightParts, queryTokens } from "./textMatch.ts";

export type PackageStatusFilter = PackagesPageStatus;
export const PACKAGE_STATUS_FILTERS: readonly PackageStatusFilter[] = ["all", "enabled", "disabled"];

/** Catch-all category for descriptors that declare none. */
export const OTHER_PACKAGE_CATEGORY = "other";
/** Facet order; categories absent from the data are never offered. */
const CATEGORY_ORDER: readonly string[] = [
  "workspace", "engineering", "research", "operations", "finance", "wellbeing", "home", "system", OTHER_PACKAGE_CATEGORY,
];

export interface PackageEntry {
  descriptor: PackageDescriptorDto;
  /** Localized display name and description. */
  name: string;
  description: string;
  category: string;
  /** Lowercased text searched by the query: id, name, description, category. */
  haystack: string;
}

export interface PackageFilter {
  query: string;
  status: PackageStatusFilter;
  /** `null` = every category. */
  category: string | null;
}

export interface PackageCategoryFacet {
  id: string;
  /** Matches for the current query and status. */
  count: number;
}

export interface PackageFacets {
  /** Per-status matches for the current query and category. */
  status: PackagesPageMatches;
  categories: PackageCategoryFacet[];
}

export function packageCategory(descriptor: PackageDescriptorDto): string {
  return descriptor.category ?? OTHER_PACKAGE_CATEGORY;
}

export function packageEntry(
  descriptor: PackageDescriptorDto,
  labels: { name: string; description: string; category: string },
): PackageEntry {
  return {
    descriptor,
    name: labels.name,
    description: labels.description,
    category: packageCategory(descriptor),
    haystack: `${descriptor.id} ${labels.name} ${labels.description} ${labels.category}`.toLowerCase(),
  };
}

export function matchesStatus(descriptor: PackageDescriptorDto, status: PackageStatusFilter): boolean {
  switch (status) {
    // Core packages are always on, so "On" lists them and "Off" never does.
    case "enabled": return descriptor.enabled || descriptor.core;
    case "disabled": return !descriptor.enabled && !descriptor.core;
    default: return true;
  }
}

const matchesTokens = (entry: PackageEntry, tokens: readonly string[]): boolean =>
  tokens.every((token) => entry.haystack.includes(token));

const matchesCategory = (entry: PackageEntry, category: string | null): boolean =>
  category === null || entry.category === category;

const byName = (a: PackageEntry, b: PackageEntry): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.descriptor.id.localeCompare(b.descriptor.id);

/** Visible entries for the filter, alphabetical by display name. */
export function filterPackages(entries: readonly PackageEntry[], filter: PackageFilter): PackageEntry[] {
  const tokens = queryTokens(filter.query);
  return entries
    .filter((entry) => matchesTokens(entry, tokens)
      && matchesStatus(entry.descriptor, filter.status)
      && matchesCategory(entry, filter.category))
    .sort(byName);
}

/** Faceted counts: each facet counts what selecting it would show while the
 *  other filters stay as they are. Categories come from the data only. */
export function packageFacets(entries: readonly PackageEntry[], filter: PackageFilter): PackageFacets {
  const tokens = queryTokens(filter.query);
  const searched = entries.filter((entry) => matchesTokens(entry, tokens));
  const inCategory = searched.filter((entry) => matchesCategory(entry, filter.category));
  const status: PackagesPageMatches = {
    all: inCategory.length,
    enabled: inCategory.filter((entry) => matchesStatus(entry.descriptor, "enabled")).length,
    disabled: inCategory.filter((entry) => matchesStatus(entry.descriptor, "disabled")).length,
  };
  const present = new Set(entries.map((entry) => entry.category));
  const rank = (id: string): number => {
    const index = CATEGORY_ORDER.indexOf(id);
    return index < 0 ? CATEGORY_ORDER.length - 1 : index;
  };
  const categories = [...present]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => ({
      id,
      count: searched.filter((entry) => entry.category === id && matchesStatus(entry.descriptor, filter.status)).length,
    }));
  return { status, categories };
}

export function isFiltered(filter: PackageFilter): boolean {
  return queryTokens(filter.query).length > 0 || filter.status !== "all" || filter.category !== null;
}

/** Adds every contribution's reported matches to the page's own counts. */
export function sumMatches(base: PackagesPageMatches, reports: Iterable<PackagesPageMatches>): PackagesPageMatches {
  const total = { ...base };
  for (const report of reports) {
    total.all += report.all;
    total.enabled += report.enabled;
    total.disabled += report.disabled;
  }
  return total;
}
