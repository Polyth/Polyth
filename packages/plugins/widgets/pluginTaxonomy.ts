// Presentation vocabulary for the packages settings page. The *classification*
// itself belongs to the host (`@polyth/package-sdk/classify`); this module owns
// only what must be localized, plus the pure predicates the page applies to
// the DTOs it already has.
import { PACKAGE_CLASSIFIER_ORDER, type PackageClassifierGroup } from "@polyth/package-sdk/classify";
import type { InstalledPluginDto, UiSlotItem } from "@polyth/contracts";
import type { PackagesPageMatches, PackagesPageStatus } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";

type MessageKey = Parameters<typeof tr>[0];

export interface ClassifierDescriptor {
  id: string;
  group: PackageClassifierGroup;
  label: string;
}

export function classifierLabel(id: string): string {
  return tr(`packages.plugins.classifier.${id}` as MessageKey);
}

/** The shared taxonomy, localized, in the published order. */
export const PACKAGE_CLASSIFIERS: readonly ClassifierDescriptor[] = PACKAGE_CLASSIFIER_ORDER.map(({ id, group }) => ({
  id,
  group,
  label: classifierLabel(id),
}));

const CLASSIFIER_BY_ID = new Map(PACKAGE_CLASSIFIERS.map((item) => [item.id, item]));

export function classifierOf(id: string): ClassifierDescriptor | undefined {
  return CLASSIFIER_BY_ID.get(id);
}

export function groupLabel(group: PackageClassifierGroup): string {
  if (group === "adds") return tr("packages.plugins.classifierGroupAdds");
  if (group === "access") return tr("packages.plugins.classifierGroupAccess");
  return tr("packages.plugins.classifierGroupRuntime");
}

/** Localized classifier labels of one package, grouped in the published order. */
export function classifierGroups(plugin: InstalledPluginDto): Array<{ group: PackageClassifierGroup; labels: string[] }> {
  const groups = new Map<PackageClassifierGroup, string[]>();
  for (const id of plugin.classifiers ?? []) {
    const descriptor = classifierOf(id);
    if (!descriptor) continue;
    const labels = groups.get(descriptor.group) ?? [];
    labels.push(descriptor.label);
    groups.set(descriptor.group, labels);
  }
  const order: readonly PackageClassifierGroup[] = ["adds", "access", "runtime"];
  return [...groups]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([group, labels]) => ({ group, labels }));
}

/** A capability's reader-facing name; an id the catalog does not know yet
 *  reads as words instead of leaking a message key. */
export function capabilityLabel(name: string): string {
  const key = `packages.plugins.capability.${name}`;
  const label = tr(key as MessageKey);
  if (label !== key) return label;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every whitespace-separated word must occur in the package's name, id,
 *  description, summary, source, tags or classifier labels. */
export function matchesQuery(plugin: InstalledPluginDto, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    plugin.name,
    plugin.id,
    plugin.description ?? "",
    plugin.summary ?? "",
    plugin.source,
    ...(plugin.tags ?? []),
    ...(plugin.classifiers ?? []).map((id) => `${id} ${classifierOf(id)?.label ?? ""}`),
  ].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function matchesStatus(plugin: InstalledPluginDto, status: PackagesPageStatus): boolean {
  if (status === "enabled") return plugin.enabled;
  if (status === "disabled") return !plugin.enabled;
  return true;
}

/** What the library lists under the page toolbar for each status choice.
 *  Added packages carry no host category, so a chosen category hides them. */
export function libraryMatches(
  plugins: readonly InstalledPluginDto[],
  query: string,
  category: string | null,
): PackagesPageMatches {
  const found = category === null ? plugins.filter((plugin) => matchesQuery(plugin, query)) : [];
  return {
    all: found.length,
    enabled: found.filter((plugin) => matchesStatus(plugin, "enabled")).length,
    disabled: found.filter((plugin) => matchesStatus(plugin, "disabled")).length,
  };
}

/** Readable source label. The wire value stays machine-truthful (an upload is
 *  `upload:<file>`, a repository stays the URL the user gave); only the
 *  presentation is shortened. */
export function describeSourceLabel(source: string): string {
  if (source.startsWith("upload:")) {
    return `${tr("packages.plugins.sourceUploaded")} · ${source.slice(7)}`;
  }
  if (source.startsWith("zip:")) return describeSourceLabel(source.slice(4));
  if (source.startsWith("https://")) return source.slice(8);
  return source;
}

/** True when the host can fetch this source again, i.e. a newer release can be
 *  pulled without the user re-supplying bytes. */
export function sourceCanRefetch(source: string): boolean {
  if (source.startsWith("upload:")) return false;
  return source.startsWith("https://") || source.startsWith("zip:https://")
    || source.startsWith("file:") || source.startsWith("path:") || source.startsWith("dir:");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Zip upload ceiling. Mirrors the server's `MAX_ARCHIVE_BYTES`; the server is
 *  the authority, this only fails fast before spending a base64 round trip. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export type PackageStatusTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** One status vocabulary for the detail header. */
export function pluginStatus(plugin: InstalledPluginDto): { label: string; tone: PackageStatusTone } {
  if (!plugin.enabled) return { label: tr("packages.plugins.disabledInThisSpace"), tone: "neutral" };
  if (plugin.status === "error") return { label: tr("common.error"), tone: "danger" };
  if (plugin.status === "loading") return { label: tr("common.loading"), tone: "warning" };
  if (plugin.status === "ready") return { label: tr("settings.pages.ready"), tone: "success" };
  return { label: tr("settings.pages.installed"), tone: "warning" };
}

export function isSandboxed(plugin: InstalledPluginDto): boolean {
  return plugin.runtimeKind === "sandboxed";
}

/** Version a refetchable source offers, staged or merely found by a check. */
export function availableUpdate(plugin: InstalledPluginDto): string | null {
  if (plugin.update) return plugin.update.version;
  if (plugin.updateCheck?.available && plugin.updateCheck.version) return plugin.updateCheck.version;
  return null;
}

/** The managed registry's sandbox `contributionKind` (managedRegistry.ts),
 *  keyed to the shared classifier that names that kind of contribution. */
export const CONTRIBUTION_KIND_CLASSIFIER: Readonly<Record<string, string>> = {
  "attachment-provider": "attachment",
  "message-action": "message",
  "session-action": "session",
  command: "command",
  "tool-renderer": "tool",
  "status-badge": "status",
  "settings-section": "settings",
  "context-provider": "context",
  widget: "widget",
};

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export interface ContributionView {
  key: string;
  /** Classifier id of the kind, or "other". */
  group: string;
  title: string;
  description?: string;
}

function contributionGroup(item: UiSlotItem): string {
  const props = (item.props ?? {}) as Record<string, unknown>;
  const kind = text(props.contributionKind);
  if (kind) return CONTRIBUTION_KIND_CLASSIFIER[kind] ?? "other";
  if (text(props.surfaceId)) return "surface";
  if (text(props.actionId)) return "composer";
  return "other";
}

/** Reader-facing contributions: a widget by its title, every other slot
 *  contribution by the label its manifest declared (its id as a last resort). */
export function contributionViews(plugin: InstalledPluginDto): ContributionView[] {
  const views: ContributionView[] = (plugin.widgets ?? []).map((widget) => {
    const description = text(widget.description);
    return {
      key: `widget:${widget.id}`,
      group: "widget",
      title: text(widget.title) ?? widget.id,
      ...(description ? { description } : {}),
    };
  });
  const widgetIds = new Set((plugin.widgets ?? []).map((widget) => widget.id));
  for (const item of plugin.contributions) {
    if (widgetIds.has(item.id)) continue;
    const props = (item.props ?? {}) as Record<string, unknown>;
    const description = text(props.description);
    views.push({
      key: `${item.slot}:${item.id}`,
      group: contributionGroup(item),
      title: text(props.title) ?? text(props.label) ?? text(props.name) ?? text(props.contributionId) ?? item.id,
      ...(description ? { description } : {}),
    });
  }
  return views;
}
