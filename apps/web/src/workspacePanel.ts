import type { JsonObject, PanelItemSize } from "@polyth/contracts";
import type { ResolvedCapability } from "./capabilities.ts";
import type { WidgetDef } from "./widgets/catalog.ts";

export type PanelItemType = "launcher" | "widget" | "header" | "divider" | "labeled-divider";
export type { PanelItemSize } from "@polyth/contracts";

export interface PanelItemDefinition {
  id: string;
  sourcePackage: string;
  type: PanelItemType;
  title: string;
  description: string;
  supportedSizes: readonly PanelItemSize[];
  defaultSize: PanelItemSize;
  singleton: boolean;
  capabilityId?: string;
  widgetId?: string;
}

export interface PanelItemInstance {
  id: string;
  definitionId: string;
  type: PanelItemType;
  size: PanelItemSize;
  config: JsonObject;
}

export interface WorkspacePanelLayout {
  version: 1;
  items: PanelItemInstance[];
}

export const WORKSPACE_PANEL_KEY = "polyth.workspacePanel.v1";
export const workspacePanelStorageKey = (projectId: string): string => `${WORKSPACE_PANEL_KEY}.${projectId}`;

const DEFAULT_LAUNCHERS = ["files", "browser", "terminal", "git", "goals", "knowledge"];
const DEFAULT_WIDGETS = ["usage.project", "session.work-status", "session.activity"];

const sizeOf = (value: unknown, fallback: PanelItemSize): PanelItemSize =>
  value === "compact" || value === "standard" || value === "wide" || value === "large" ? value : fallback;

function instance(definition: PanelItemDefinition, id = definition.id): PanelItemInstance {
  return { id, definitionId: definition.id, type: definition.type, size: definition.defaultSize, config: {} };
}

export function panelItemCatalog(
  capabilities: readonly ResolvedCapability[],
  widgets: readonly WidgetDef[],
): PanelItemDefinition[] {
  const launchers = capabilities
    .filter(({ descriptor }) => descriptor.id !== "session" && descriptor.available())
    .map(({ descriptor }): PanelItemDefinition => ({
      id: `launcher:${descriptor.id}`,
      sourcePackage: descriptor.id,
      type: "launcher",
      title: descriptor.label,
      description: descriptor.plainDescription,
      supportedSizes: ["compact"],
      defaultSize: "compact",
      singleton: true,
      capabilityId: descriptor.id,
    }));
  const widgetItems = widgets
    .filter((widget) => widget.kind !== "mini-widget" && widget.id !== "core.chat")
    .map((widget): PanelItemDefinition => ({
      id: `widget:${widget.id}`,
      sourcePackage: widget.pluginId,
      type: "widget",
      title: widget.panelTitle ?? widget.title,
      description: widget.description,
      supportedSizes: widget.panelSizes ?? (widget.id === "usage.project" ? ["wide", "large"] : ["compact", "standard"]),
      defaultSize: widget.panelDefaultSize ?? (widget.id === "usage.project" ? "large" : "compact"),
      singleton: widget.duplicatable !== true,
      widgetId: widget.id,
      capabilityId: widget.capabilities?.[0] ?? (capabilities.some(({ descriptor }) => descriptor.id === widget.pluginId) ? widget.pluginId : undefined),
    }));
  const layoutItems: PanelItemDefinition[] = [
    { id: "layout:header", sourcePackage: "shell", type: "header", title: "Header", description: "A named workspace heading.", supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
    { id: "layout:divider", sourcePackage: "shell", type: "divider", title: "Divider", description: "A visual separator.", supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
    { id: "layout:labeled-divider", sourcePackage: "shell", type: "labeled-divider", title: "Labeled divider", description: "A separator with editable text.", supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
  ];
  return [...launchers, ...widgetItems, ...layoutItems];
}

export function createWorkspacePanelLayout(
  catalog: readonly PanelItemDefinition[],
  migratedCapabilityIds: readonly string[] = [],
): WorkspacePanelLayout {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const requested = migratedCapabilityIds.length > 0
    ? migratedCapabilityIds.map((id) => `launcher:${id}`)
    : [
        ...DEFAULT_LAUNCHERS.map((id) => `launcher:${id}`),
        ...DEFAULT_WIDGETS.map((id) => `widget:${id}`),
        "layout:labeled-divider",
        "launcher:multirun",
        "launcher:schedule",
      ];
  const items = requested.flatMap((id) => {
    const definition = byId.get(id);
    if (!definition) return [];
    const next = instance(definition);
    if (id === "layout:labeled-divider") next.config = { label: "Project progress" };
    return [next];
  });
  return { version: 1, items };
}

export function parseWorkspacePanelLayout(
  raw: string | null,
  catalog: readonly PanelItemDefinition[],
  migratedCapabilityIds: readonly string[] = [],
): WorkspacePanelLayout {
  const definitions = new Map(catalog.map((item) => [item.id, item]));
  try {
    const data = JSON.parse(raw ?? "") as Partial<WorkspacePanelLayout>;
    if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("invalid layout");
    const seen = new Set<string>();
    const items = data.items.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Partial<PanelItemInstance>;
      const definition = typeof item.definitionId === "string" ? definitions.get(item.definitionId) : undefined;
      if (!definition || typeof item.id !== "string" || seen.has(item.id)) return [];
      seen.add(item.id);
      const config = item.config && typeof item.config === "object" && !Array.isArray(item.config) ? item.config : {};
      return [{
        id: item.id,
        definitionId: definition.id,
        type: definition.type,
        size: definition.supportedSizes.includes(sizeOf(item.size, definition.defaultSize))
          ? sizeOf(item.size, definition.defaultSize) : definition.defaultSize,
        config,
      } satisfies PanelItemInstance];
    });
    return { version: 1, items };
  } catch {
    return createWorkspacePanelLayout(catalog, migratedCapabilityIds);
  }
}

export function addPanelItem(layout: WorkspacePanelLayout, definition: PanelItemDefinition): WorkspacePanelLayout {
  if (definition.singleton && layout.items.some((item) => item.definitionId === definition.id)) return layout;
  let id = definition.id;
  for (let n = 2; layout.items.some((item) => item.id === id); n++) id = `${definition.id}#${n}`;
  return { ...layout, items: [...layout.items, instance(definition, id)] };
}

export function removePanelItem(layout: WorkspacePanelLayout, id: string): WorkspacePanelLayout {
  return { ...layout, items: layout.items.filter((item) => item.id !== id) };
}

export function movePanelItem(layout: WorkspacePanelLayout, id: string, index: number): WorkspacePanelLayout {
  const current = layout.items.find((item) => item.id === id);
  if (!current) return layout;
  const items = layout.items.filter((item) => item.id !== id);
  items.splice(Math.max(0, Math.min(index, items.length)), 0, current);
  return items.every((item, position) => item === layout.items[position]) ? layout : { ...layout, items };
}

export function updatePanelItem(
  layout: WorkspacePanelLayout,
  id: string,
  patch: Partial<Pick<PanelItemInstance, "size" | "config">>,
): WorkspacePanelLayout {
  return { ...layout, items: layout.items.map((item) => item.id === id ? { ...item, ...patch } : item) };
}
