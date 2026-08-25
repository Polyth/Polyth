import type { WidgetDef } from "./catalog.ts";
import { tr } from "../i18n/index.ts";
import type { UiSlot } from "@polyth/contracts";
import {
  WIDGET_ZONES,
  widgetDefinitionId,
  type WidgetAudience,
  type WidgetLayout,
  type WidgetPlacement,
  type WidgetZone,
  widgetZoneFromSlot,
} from "./widgetLayout.ts";

export type WidgetSizeFilter = "all" | "small" | "medium" | "large";
export type WidgetLibraryTab = "recommended" | "plugin" | "recent";

export interface WidgetLibraryFilters {
  query: string;
  pluginId: string;
  size: WidgetSizeFilter;
  zone: WidgetZone | "all";
  category: string;
  tab: WidgetLibraryTab;
  recentlyUsed?: readonly string[];
}

export interface MissingWidgetPlaceholder {
  instanceId: string;
  definitionId: string;
  pluginId: string;
  title: string;
  description: string;
  placement: WidgetPlacement;
  zone: WidgetZone;
  slot: UiSlot;
}

export const RECOMMENDED_WIDGET_IDS = [
  "core.chat",
  "core.quick-actions",
  "knowledge.notes",
  "git.recent",
] as const;

export function widgetSizeLabel(
  widget: Pick<WidgetDef, "recommendedSize" | "defaultSize">,
): Exclude<WidgetSizeFilter, "all"> {
  const width = widget.recommendedSize?.w ?? widget.defaultSize?.w ?? 6;
  return width >= 9 ? "large" : width >= 5 ? "medium" : "small";
}

export function pluginDisplayName(widget: Pick<WidgetDef, "pluginId" | "pluginName">): string {
  if (widget.pluginName) return widget.pluginName;
  const special: Record<string, string> = {
    session: tr("widgets.widgetlibrary.coreWorkspace"),
    commands: tr("widgets.widgetlibrary.coreWorkspace"),
    files: tr("widgets.widgetlibrary.coreWorkspace"),
    goals: tr("widgets.widgetlibrary.coreWorkspace"),
    terminal: tr("widgets.widgetlibrary.coreWorkspace"),
    preview: tr("widgets.widgetlibrary.coreWorkspace"),
    git: tr("widgets.widgetlibrary.gitTools"),
    walkthrough: tr("widgets.widgetlibrary.gitTools"),
    knowledge: tr("capabilities.knowledge"),
    browser: tr("packages.onboarding.tours.builtin.browser"),
    github: "GitHub",
    mcp: tr("widgets.widgetlibrary.mcpTools"),
  };
  return special[widget.pluginId]
    ?? widget.pluginId.replace(/[-_]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export interface WidgetPluginOption {
  id: string;
  label: string;
}

/** Plugin ids remain the filter value; colliding friendly names gain the
 * stable id so no two options are visually indistinguishable. */
export function widgetPluginOptions(
  widgets: readonly Pick<WidgetDef, "pluginId" | "pluginName">[],
): WidgetPluginOption[] {
  const names = new Map<string, string>();
  for (const widget of widgets) names.set(widget.pluginId, pluginDisplayName(widget));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...names].map(([id, name]) => ({
    id,
    label: (counts.get(name) ?? 0) > 1 ? `${name} — ${id}` : name,
  })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function supportedWidgetZones(
  widget: Pick<WidgetDef, "supportedSlots" | "supportedZones" | "zone" | "floating">,
): readonly WidgetZone[] {
  const modern = widget.supportedSlots;
  if (modern && modern.length > 0) {
    return modern.flatMap((slot) => {
      const zone = widgetZoneFromSlot(slot);
      return zone ? [zone] : [];
    });
  }
  if (widget.supportedZones && widget.supportedZones.length > 0) return widget.supportedZones;
  return widget.floating ? [widget.zone ?? "main", "floating"] : [widget.zone ?? "main"];
}

export function supportedWidgetSlots(
  widget: Pick<WidgetDef, "defaultSlot" | "supportedSlots" | "zone" | "supportedZones" | "floating">,
): readonly UiSlot[] {
  if (widget.supportedSlots && widget.supportedSlots.length > 0) return widget.supportedSlots;
  return supportedWidgetZones(widget).map((zone) =>
    `workspace.${zone}` as UiSlot);
}

function queryText(widget: WidgetDef): string {
  return [
    widget.title,
    widget.description,
    widget.pluginId,
    widget.pluginName ?? "",
    widget.category ?? "",
    ...(widget.capabilities ?? []),
  ].join(" ").toLowerCase();
}

export function filterWidgetLibrary(
  widgets: readonly WidgetDef[],
  filters: WidgetLibraryFilters,
  audience: WidgetAudience = "power",
): WidgetDef[] {
  const query = filters.query.trim().toLowerCase();
  const recent = new Set(filters.recentlyUsed ?? []);
  const rank: Record<WidgetAudience, number> = { simple: 0, standard: 1, power: 2 };
  return widgets.filter((widget) => {
    if (rank[widget.audience ?? "standard"] > rank[audience]) return false;
    if (query && !queryText(widget).includes(query)) return false;
    if (filters.pluginId !== "all" && widget.pluginId !== filters.pluginId) return false;
    if (filters.size !== "all" && widgetSizeLabel(widget) !== filters.size) return false;
    if (filters.zone !== "all" && !supportedWidgetZones(widget).includes(filters.zone)) return false;
    if (filters.category !== "all" && (widget.category ?? "workspace") !== filters.category) return false;
    if (filters.tab === "recommended" && !(
      widget.recommended === true
      || RECOMMENDED_WIDGET_IDS.includes(widget.id as (typeof RECOMMENDED_WIDGET_IDS)[number])
    )) return false;
    if (filters.tab === "recent" && !recent.has(widget.id)) return false;
    return true;
  });
}

export function groupWidgetsByPlugin(widgets: readonly WidgetDef[]): Map<string, WidgetDef[]> {
  const explicitNames = new Map<string, Set<string>>();
  for (const widget of widgets) {
    if (!widget.pluginName) continue;
    const ids = explicitNames.get(widget.pluginName) ?? new Set<string>();
    ids.add(widget.pluginId);
    explicitNames.set(widget.pluginName, ids);
  }
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of widgets) {
    const displayName = pluginDisplayName(widget);
    const name = widget.pluginName && (explicitNames.get(widget.pluginName)?.size ?? 0) > 1
      ? `${displayName} — ${widget.pluginId}`
      : displayName;
    groups.set(name, [...(groups.get(name) ?? []), widget]);
  }
  return groups;
}

export function missingWidgetPlaceholders(
  layout: WidgetLayout,
  widgets: readonly Pick<WidgetDef, "id">[],
): MissingWidgetPlaceholder[] {
  const available = new Set(widgets.map((widget) => widget.id));
  const missing: MissingWidgetPlaceholder[] = [];
  const locations: Array<[UiSlot, WidgetZone, string[]]> = WIDGET_ZONES.map((zone) => [
    `workspace.${zone}` as UiSlot,
    zone,
    layout.zones[zone],
  ]);
  for (const [slot, ids] of Object.entries(layout.slotPlacements)) {
    locations.push([slot as UiSlot, widgetZoneFromSlot(slot as UiSlot) ?? "main", ids ?? []]);
  }
  for (const [slot, zone, instanceIds] of locations) {
    for (const instanceId of instanceIds) {
      const placement = layout.widgets[instanceId];
      if (!placement) continue;
      const definitionId = widgetDefinitionId(layout, instanceId);
      if (available.has(definitionId) || !placement.pluginId || !placement.title) continue;
      missing.push({
        instanceId,
        definitionId,
        pluginId: placement.pluginId,
        title: placement.title,
        description: placement.description ?? tr("widgets.widgetlibrary.pluginDisabledOrMissing"),
        placement,
        zone,
        slot,
      });
    }
  }
  return missing;
}

const RECENT_WIDGETS_KEY = "polyth.recentWidgets";

export function readRecentWidgets(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_WIDGETS_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

export function noteWidgetUsed(id: string): string[] {
  const next = [id, ...readRecentWidgets().filter((item) => item !== id)].slice(0, 12);
  try { localStorage.setItem(RECENT_WIDGETS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
