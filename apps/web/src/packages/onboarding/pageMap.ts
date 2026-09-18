// Maps a settings page id to its optional, explicitly opened help tour.
// Kept free of React/DOM so it is unit-testable.

/** Built-in SettingsView pages (no settings.pages slot entry). Each acts as
 * its own tour package id — e.g. a tour registered under "packages" shows on
 * the built-in Packages page. */
const BUILTIN_SETTINGS_PAGE_IDS: ReadonlySet<string> = new Set([
  "general", "appearance", "chat", "notifications", "sessions", "shortcuts",
  "projects", "behavior", "packages", "users", "access", "about",
]);

/** Backend package names that alias to a different UI package. Mirrors the
 * alias table in packages/registry.ts (kept private there). */
const PACKAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["dictation", "voice"],
]);

export function canonicalTourPackageId(packageId: string): string {
  return PACKAGE_ALIASES.get(packageId) ?? packageId;
}

/** Minimal shape of a settings.pages slot item as SettingsView sees it. */
export interface SettingsSlotItemLike {
  id: string;
  meta?: Record<string, unknown> | undefined;
}

/** Resolve the package id owning a settings page: slot pages carry
 * meta.packageId (from installSettingsPage), built-in pages map to
 * themselves, anything else has no owner. Aliases are canonicalized. */
export function settingsPageToPackageId(
  pageId: string,
  slotItems: readonly SettingsSlotItemLike[],
): string | null {
  for (const item of slotItems) {
    const meta = item.meta as { pageId?: unknown; packageId?: unknown } | undefined;
    const itemPageId = typeof meta?.pageId === "string" ? meta.pageId : `slot:${item.id}`;
    if (itemPageId !== pageId) continue;
    return typeof meta?.packageId === "string" ? canonicalTourPackageId(meta.packageId) : null;
  }
  return BUILTIN_SETTINGS_PAGE_IDS.has(pageId) ? canonicalTourPackageId(pageId) : null;
}
