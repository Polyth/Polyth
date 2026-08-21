import type { WidgetDef } from "./catalog.ts";
import {
  WIDGET_ZONES,
  widgetDefinitionId,
  type WidgetAudience,
  type WidgetLayout,
  type WidgetPlacement,
  type WidgetZone,
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
}

export const RECOMMENDED_WIDGET_IDS = [
  "core.composer",
  "core.quick-actions",
  "knowledge.notes",
  "git.recent",
] as const;

export function widgetSizeLabel(widget: Pick<WidgetDef, "defaultSize">): Exclude<WidgetSizeFilter, "all"> {
  const width = widget.defaultSize?.w ?? 6;
  return width >= 9 ? "large" : width >= 5 ? "medium" : "small";
}

export function pluginDisplayName(widget: Pick<WidgetDef, "pluginId" | "pluginName">): string {
  if (widget.pluginName) return widget.pluginName;
  const special: Record<string, string> = {
    session: "Core workspace",
    commands: "Core workspace",
    files: "Core workspace",
    goals: "Core workspace",
    terminal: "Core workspace",
    preview: "Core workspace",
    git: "Git tools",
    walkthrough: "Git tools",
    knowledge: "Knowledge",
    browser: "Browser",
    github: "GitHub",
    mcp: "MCP / Tools",
  };
  return special[widget.pluginId]
    ?? widget.pluginId.replace(/[-_]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function supportedWidgetZones(widget: Pick<WidgetDef, "supportedZones" | "zone" | "floating">): readonly WidgetZone[] {
  if (widget.supportedZones && widget.supportedZones.length > 0) return widget.supportedZones;
  return widget.floating ? [widget.zone ?? "main", "floating"] : [widget.zone ?? "main"];
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
  const groups = new Map<string, WidgetDef[]>();
  for (const widget of widgets) {
    const name = pluginDisplayName(widget);
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
  for (const zone of WIDGET_ZONES) {
    for (const instanceId of layout.zones[zone]) {
      const placement = layout.widgets[instanceId];
      if (!placement) continue;
      const definitionId = widgetDefinitionId(layout, instanceId);
      if (available.has(definitionId) || !placement.pluginId || !placement.title) continue;
      missing.push({
        instanceId,
        definitionId,
        pluginId: placement.pluginId,
        title: placement.title,
        description: placement.description ?? "This widget’s plugin is disabled or missing.",
        placement,
        zone,
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
