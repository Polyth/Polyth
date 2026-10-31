import type { JsonObject, PanelItemSize } from "@polyth/contracts";
import type { ProjectKind } from "@polyth/contracts/project-composition";
import type { ResolvedCapability } from "./capabilities.ts";
import { tr } from "./i18n/index.ts";
import { presentationScopeId } from "./projectInterfaceScope.ts";
import type { WidgetAvailabilityContext, WidgetDef } from "./widgets/catalog.ts";

export type PanelItemType = "launcher" | "widget" | "header" | "divider" | "labeled-divider";
export type { PanelItemSize } from "@polyth/contracts";
/** How the Add page files an item: a live widget, an app launcher, or a layout element. */
export type PanelItemKind = "widget" | "app" | "layout";

export interface PanelItemDefinition {
  id: string;
  /** Stable owner package id used for grouping/filtering. */
  sourcePackage: string;
  /** Human-readable owner label; falls back to the package id when absent. */
  packageLabel?: string;
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
/** Resolves to the shared record while every project shares one interface. */
export const workspacePanelStorageKey = (projectId: string): string => `${WORKSPACE_PANEL_KEY}.${presentationScopeId(projectId)}`;

/** Launchers for a project whose rails were never arranged; an arranged
 * project lists its rail launchers instead (see `createWorkspacePanelLayout`). */
const DEFAULT_LAUNCHERS = ["files", "browser", "terminal", "git", "goals", "knowledge", "schedule"];

/**
 * Glanceable summary widgets a fresh phone Workspace shows below its
 * launchers, per project kind, most useful first. Full-surface views
 * (Planner, Terminal, Browser, Multi-run, Fusion…) are reached through their
 * launchers instead of being squeezed into a card. The session-internals
 * widgets — Agent actions (`session.work-status`) and Activity timeline
 * (`session.activity`) — are deep technical diagnostics and are never a
 * default; they stay in the library.
 */
export const DEFAULT_PANEL_WIDGETS: Readonly<Record<ProjectKind, readonly string[]>> = {
  general: ["usage.limits"],
  // The Personal project's Workspace is its few launchers and nothing else.
  personal: [],
  engineering: ["github.pr-summary", "task-trackers.overview", "usage.limits"],
  research: ["usage.limits"],
  wellbeing: ["personal-coach.today", "personal-coach.check-in", "personal-coach.goal"],
  finance: ["markets.watchlist", "markets.portfolio-summary", "markets.news"],
  home: [],
  operations: ["task-trackers.overview", "github.pr-summary"],
};
/** A project with several directions still starts with a short list. */
export const MAX_DEFAULT_PANEL_WIDGETS = 4;

/** Default widget ids for a project's kinds, taken round-robin so every
 * direction of a mixed project is represented, deduplicated and capped at
 * `MAX_DEFAULT_PANEL_WIDGETS`. */
export function defaultPanelWidgetIds(kinds: readonly ProjectKind[]): string[] {
  const lists = kinds.map((kind) => DEFAULT_PANEL_WIDGETS[kind] ?? []);
  const ids: string[] = [];
  const depth = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < depth; rank++) {
    for (const list of lists) {
      const id = list[rank];
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, MAX_DEFAULT_PANEL_WIDGETS);
}

const sizeOf = (value: unknown, fallback: PanelItemSize): PanelItemSize =>
  value === "compact" || value === "standard" || value === "wide" || value === "large" ? value : fallback;

const isPanelItemType = (value: unknown): value is PanelItemType =>
  value === "launcher" || value === "widget" || value === "header" || value === "divider" || value === "labeled-divider";

function instance(definition: PanelItemDefinition, id = definition.id): PanelItemInstance {
  return { id, definitionId: definition.id, type: definition.type, size: definition.defaultSize, config: {} };
}

const PACKAGE_LABELS: Readonly<Record<string, string>> = {
  shell: "Workspace",
  session: "Core workspace",
  files: "Files",
  browser: "Browser",
  terminal: "Terminal",
  git: "Git",
  goals: "Goals",
  knowledge: "Knowledge",
  usage: "Usage",
  multirun: "Multi-run",
  workflow: "Workflows",
  fusion: "Fusion",
  agents: "Agents",
  walkthrough: "Walkthrough",
  github: "GitHub",
  context: "Context",
  events: "Events",
  "workspace-edit": "Workspace",
  voice: "Voice",
  "models-agents": "Models & agents",
  mcp: "MCP / Tools",
};

const humanizePackageId = (id: string): string =>
  id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());

/** Keep package grouping stable without coupling the catalog to the settings page. */
export function panelPackageLabel(packageId: string, preferred?: string): string {
  return PACKAGE_LABELS[packageId] ?? preferred ?? humanizePackageId(packageId);
}

export function panelItemKind(item: Pick<PanelItemDefinition, "type">): PanelItemKind {
  return item.type === "launcher" ? "app" : item.type === "widget" ? "widget" : "layout";
}

/**
 * The Add page's search. Every word of the query has to appear in the item's
 * title, description or package (any order, any case); title hits rank first —
 * a title that starts with the word, then one with a word that does, then any
 * other title hit — and ties keep catalog order.
 */
export function searchPanelItems(items: readonly PanelItemDefinition[], query: string): PanelItemDefinition[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const ranked = items.flatMap((item, order) => {
    const title = item.title.toLocaleLowerCase();
    const rest = `${item.description} ${item.packageLabel ?? ""} ${item.sourcePackage}`.toLocaleLowerCase();
    let score = 0;
    for (const word of words) {
      const at = title.indexOf(word);
      if (at === 0) score += 4;
      else if (at > 0) score += /[\s\-_./]/.test(title[at - 1] ?? "") ? 3 : 2;
      else if (rest.includes(word)) score += 1;
      else return [];
    }
    return [{ item, score, order }];
  });
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map(({ item }) => item);
}

export interface PanelGallerySection {
  /** `apps`, `layout`, or `package:<owner package id>` for a package's widgets. */
  id: string;
  kind: PanelItemKind;
  label: string;
  items: PanelItemDefinition[];
}

/**
 * The Add page's browsing order: every app in one section (catalog order —
 * they are drawn as a tile grid), then each package's widgets under the
 * package's name, A–Z, then the layout elements (headings and dividers).
 */
export function panelGallerySections(items: readonly PanelItemDefinition[]): PanelGallerySection[] {
  const apps = items.filter((item) => panelItemKind(item) === "app");
  const layout = items.filter((item) => panelItemKind(item) === "layout");
  const packages = new Map<string, PanelItemDefinition[]>();
  for (const item of items) {
    if (panelItemKind(item) === "widget") packages.set(item.sourcePackage, [...(packages.get(item.sourcePackage) ?? []), item]);
  }
  const widgetSections = [...packages.entries()]
    .map(([id, entries]): PanelGallerySection => ({
      id: `package:${id}`,
      kind: "widget",
      label: entries[0]?.packageLabel ?? panelPackageLabel(id),
      items: entries,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return [
    ...(apps.length > 0 ? [{ id: "apps", kind: "app" as const, label: tr("workspace.panel.kindApps"), items: apps }] : []),
    ...widgetSections,
    ...(layout.length > 0 ? [{ id: "layout", kind: "layout" as const, label: tr("workspace.panel.kindLayout"), items: layout }] : []),
  ];
}

export function panelItemCatalog(
  capabilities: readonly ResolvedCapability[],
  widgets: readonly WidgetDef[],
): PanelItemDefinition[] {
  const widgetPackageLabels = new Map(widgets.map((widget) => {
    const sourcePackage = widget.ownerPackageId ?? widget.pluginId;
    return [sourcePackage, panelPackageLabel(sourcePackage, widget.pluginName)] as const;
  }));
  const launchers = capabilities
    .filter(({ descriptor }) => descriptor.id !== "session" && descriptor.rail !== false && descriptor.available())
    .map(({ descriptor }): PanelItemDefinition => {
      const sourcePackage = descriptor.ownerPackageId ?? descriptor.id;
      return {
        id: `launcher:${descriptor.id}`,
        sourcePackage,
        packageLabel: panelPackageLabel(sourcePackage, widgetPackageLabels.get(sourcePackage)),
        type: "launcher",
        title: descriptor.label,
        description: descriptor.plainDescription,
        supportedSizes: ["compact"],
        defaultSize: "compact",
        singleton: true,
        capabilityId: descriptor.id,
      };
    });
  const widgetItems = widgets
    .filter((widget) => widget.kind !== "mini-widget" && widget.id !== "core.chat")
    .map((widget): PanelItemDefinition => {
      const sourcePackage = widget.ownerPackageId ?? widget.pluginId;
      return {
        id: `widget:${widget.id}`,
        sourcePackage,
        packageLabel: panelPackageLabel(sourcePackage, widget.pluginName),
        type: "widget",
        title: widget.panelTitle ?? widget.title,
        description: widget.description,
        supportedSizes: widget.panelSizes ?? ["compact", "standard"],
        defaultSize: widget.panelDefaultSize ?? "compact",
        singleton: widget.duplicatable !== true,
        widgetId: widget.id,
        capabilityId: widget.capabilities?.[0] ?? (capabilities.some(({ descriptor }) => descriptor.id === widget.pluginId) ? widget.pluginId : undefined),
      };
    });
  const layoutItems: PanelItemDefinition[] = [
    { id: "layout:header", sourcePackage: "shell", packageLabel: panelPackageLabel("shell"), type: "header", title: tr("workspace.panel.headerTitle"), description: tr("workspace.panel.headerDescription"), supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
    { id: "layout:divider", sourcePackage: "shell", packageLabel: panelPackageLabel("shell"), type: "divider", title: tr("workspace.panel.dividerTitle"), description: tr("workspace.panel.dividerDescription"), supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
    { id: "layout:labeled-divider", sourcePackage: "shell", packageLabel: panelPackageLabel("shell"), type: "labeled-divider", title: tr("workspace.panel.labeledDividerTitle"), description: tr("workspace.panel.labeledDividerDescription"), supportedSizes: ["wide"], defaultSize: "wide", singleton: false },
  ];
  return [...launchers, ...widgetItems, ...layoutItems];
}

const sameDefinition = (a: PanelItemDefinition, b: PanelItemDefinition): boolean =>
  a.id === b.id && a.sourcePackage === b.sourcePackage && a.packageLabel === b.packageLabel && a.type === b.type
  && a.title === b.title && a.description === b.description && a.defaultSize === b.defaultSize
  && a.singleton === b.singleton && a.capabilityId === b.capabilityId && a.widgetId === b.widgetId
  && a.supportedSizes.length === b.supportedSizes.length
  && a.supportedSizes.every((size, index) => size === b.supportedSizes[index]);

/**
 * `next` with every definition that did not change replaced by its previous
 * object (and `previous` itself when nothing changed). The capability and
 * widget registries hand out fresh objects on every read, so without this a
 * memoized consumer would redraw every row on any render of the panel.
 */
export function stablePanelCatalog(
  previous: readonly PanelItemDefinition[],
  next: readonly PanelItemDefinition[],
): readonly PanelItemDefinition[] {
  const before = new Map(previous.map((item) => [item.id, item]));
  const merged = next.map((item) => {
    const old = before.get(item.id);
    return old && sameDefinition(old, item) ? old : item;
  });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}

/**
 * A fresh phone Workspace: launchers first, then the project kind's summary
 * widgets. `railCapabilityIds` is the project's arranged rail order (top rail,
 * then right rail); a project never arranged falls back to the standard
 * launchers. Ids missing from the catalog (package disabled or not loaded) are
 * skipped. Nothing here is persisted until the person edits the panel.
 */
export function createWorkspacePanelLayout(
  catalog: readonly PanelItemDefinition[],
  railCapabilityIds: readonly string[] = [],
  widgetIds: readonly string[] = defaultPanelWidgetIds(["general"]),
): WorkspacePanelLayout {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const requested = [
    ...(railCapabilityIds.length > 0 ? railCapabilityIds : DEFAULT_LAUNCHERS).map((id) => `launcher:${id}`),
    ...widgetIds.map((id) => `widget:${id}`),
  ];
  const items = requested.flatMap((id) => {
    const definition = byId.get(id);
    return definition ? [instance(definition)] : [];
  });
  return { version: 1, items };
}

/**
 * Read a saved layout. An item whose definition this device does not have
 * right now — its package is still loading, disabled here, or unavailable on
 * this device — is kept as it was saved: the panel skips it while rendering,
 * and the next edit saves it back unchanged. Dropping it would make this
 * device's next edit delete it from the layout every device shares.
 */
export function parseWorkspacePanelLayout(
  raw: string | null,
  catalog: readonly PanelItemDefinition[],
  railCapabilityIds: readonly string[] = [],
  widgetIds?: readonly string[],
): WorkspacePanelLayout {
  const definitions = new Map(catalog.map((item) => [item.id, item]));
  try {
    const data = JSON.parse(raw ?? "") as Partial<WorkspacePanelLayout>;
    if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("invalid layout");
    const seen = new Set<string>();
    const items = data.items.flatMap((value): PanelItemInstance[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Partial<PanelItemInstance>;
      if (typeof item.definitionId !== "string" || typeof item.id !== "string" || seen.has(item.id)) return [];
      const config = item.config && typeof item.config === "object" && !Array.isArray(item.config) ? item.config : {};
      const definition = definitions.get(item.definitionId);
      if (!definition) {
        if (!isPanelItemType(item.type)) return [];
        seen.add(item.id);
        return [{ id: item.id, definitionId: item.definitionId, type: item.type, size: sizeOf(item.size, "compact"), config }];
      }
      seen.add(item.id);
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
    return createWorkspacePanelLayout(catalog, railCapabilityIds, widgetIds);
  }
}

export function addPanelItem(layout: WorkspacePanelLayout, definition: PanelItemDefinition): WorkspacePanelLayout {
  if (definition.singleton && layout.items.some((item) => item.definitionId === definition.id)) return layout;
  let id = definition.id;
  for (let n = 2; layout.items.some((item) => item.id === id); n++) id = `${definition.id}#${n}`;
  return { ...layout, items: [...layout.items, instance(definition, id)] };
}

/**
 * Where a newly added item lands: an app joins the other apps (right after the
 * last one, so the tiles stay one block; at the top when there are none);
 * widgets and layout elements go to the end.
 */
export function panelInsertionIndex(layout: WorkspacePanelLayout, definition: Pick<PanelItemDefinition, "type">): number {
  if (definition.type !== "launcher") return layout.items.length;
  let last = -1;
  layout.items.forEach((item, index) => { if (item.type === "launcher") last = index; });
  return last + 1;
}

/** Add one instance at its natural place (`panelInsertionIndex`). `id` is null
 *  when nothing was added (a singleton that is already there). */
export function insertPanelItem(
  layout: WorkspacePanelLayout,
  definition: PanelItemDefinition,
): { layout: WorkspacePanelLayout; id: string | null } {
  const added = addPanelItem(layout, definition);
  const inserted = added.items[added.items.length - 1];
  if (added === layout || !inserted) return { layout, id: null };
  return { layout: movePanelItem(added, inserted.id, panelInsertionIndex(layout, definition)), id: inserted.id };
}

/**
 * Put the items named in `order` into that order, each taking one of the slots
 * those items held. Every other item — one this device cannot draw because its
 * package is missing here — keeps its exact position, so rearranging on one
 * device never shuffles what another device shows.
 */
export function permutePanelItems(layout: WorkspacePanelLayout, order: readonly string[]): WorkspacePanelLayout {
  const byId = new Map(layout.items.map((item) => [item.id, item]));
  const queue = [...new Set(order)].filter((id) => byId.has(id));
  const moving = new Set(queue);
  let next = 0;
  const items = layout.items.map((item) => moving.has(item.id) ? byId.get(queue[next++]!)! : item);
  return items.every((item, position) => item === layout.items[position]) ? layout : { ...layout, items };
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

/** A heading's or labelled divider's own text; "" shows its placeholder. */
export function panelItemLabel(item: Pick<PanelItemInstance, "config">): string {
  return typeof item.config.label === "string" ? item.config.label : "";
}

export function updatePanelItem(
  layout: WorkspacePanelLayout,
  id: string,
  patch: Partial<Pick<PanelItemInstance, "size" | "config">>,
): WorkspacePanelLayout {
  return { ...layout, items: layout.items.map((item) => item.id === id ? { ...item, ...patch } : item) };
}

/** Whether a configured panel item renders right now. A widget that reports
 *  itself unavailable (a session card with no active session) is omitted
 *  entirely instead of being drawn as an empty state. Edit mode always keeps
 *  it, so it can still be reordered or removed. */
export function panelWidgetAvailable(
  definition: PanelItemDefinition,
  widget: Pick<WidgetDef, "isAvailable"> | undefined,
  editing: boolean,
  context: WidgetAvailabilityContext,
): boolean {
  if (editing || definition.type !== "widget" || !widget?.isAvailable) return true;
  return widget.isAvailable(context);
}
