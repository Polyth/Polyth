import { useSyncExternalStore, type ReactNode } from "react";
import { listSlots, slotVersion, subscribeSlots } from "../slots.ts";
import { isUiSlot, type UiSlot, type WidgetKind } from "@polyth/contracts";
import {
  ensureWidgets,
  widgetSlotFromZone,
  type WidgetAudience,
  type WidgetScope,
  type WidgetSize,
  type WidgetZone,
} from "./widgetLayout.ts";

export interface WidgetRenderContext extends Record<string, unknown> {
  projectId: string | null;
  sessionId: string | null;
  editing: boolean;
}

export interface WidgetSettingsContext extends WidgetRenderContext {
  widgetId: string;
}

export interface WidgetDef {
  id: string;
  pluginId: string;
  pluginName?: string;
  title: string;
  description: string;
  kind?: WidgetKind;
  defaultSlot?: UiSlot;
  supportedSlots?: readonly UiSlot[];
  defaultVisible?: boolean;
  order?: number;
  category?: string;
  capabilities?: readonly string[];
  zone?: WidgetZone;
  supportedZones?: readonly WidgetZone[];
  defaultSize?: WidgetSize;
  minSize?: WidgetSize;
  maxSize?: WidgetSize;
  audience?: WidgetAudience;
  showIn?: readonly WidgetAudience[];
  scope?: WidgetScope;
  resizable?: boolean;
  duplicatable?: boolean;
  floating?: boolean;
  recommended?: boolean;
  settingsSchema?: Readonly<Record<string, unknown>>;
  render: (context: WidgetRenderContext) => ReactNode;
  settingsRender?: (context: WidgetSettingsContext) => ReactNode;
}

const registry = new Map<string, WidgetDef>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

export function registerWidget(def: WidgetDef): () => void {
  registry.set(def.id, def);
  bump();
  return () => {
    if (registry.get(def.id) === def) {
      registry.delete(def.id);
      bump();
    }
  };
}

export type PluginWidgetDef = Omit<WidgetDef, "pluginId" | "pluginName">;

/** Client-side plugin declaration. `widgets` is optional by design: most
 * plugins can stay capability-only, while one plugin may own many widgets. */
export interface WidgetPlugin {
  id: string;
  name: string;
  widgets?: readonly PluginWidgetDef[];
}

export function defineWidgetPlugin<T extends WidgetPlugin>(plugin: T): T {
  return plugin;
}

export function registerWidgetPlugin(plugin: WidgetPlugin): () => void {
  const ids = new Set<string>();
  const definitions = (plugin.widgets ?? []).map((widget): WidgetDef => {
    if (ids.has(widget.id)) throw new Error(`plugin ${plugin.id} declares duplicate widget: ${widget.id}`);
    ids.add(widget.id);
    const existing = registry.get(widget.id);
    if (existing && existing.pluginId !== plugin.id) {
      throw new Error(`widget ${widget.id} is already owned by plugin ${existing.pluginId}`);
    }
    const defaultSlot = widget.defaultSlot ?? widgetSlotFromZone(widget.zone ?? "main");
    const supportedSlots = widget.supportedSlots
      ?? widget.supportedZones?.map(widgetSlotFromZone)
      ?? [defaultSlot];
    if (!supportedSlots.includes(defaultSlot)) {
      throw new Error(`plugin ${plugin.id} widget ${widget.id} does not support its default slot ${defaultSlot}`);
    }
    return {
      ...widget,
      pluginId: plugin.id,
      pluginName: plugin.name,
      kind: widget.kind ?? "widget",
      defaultSlot,
      supportedSlots,
    };
  });
  const unregister = definitions.map(registerWidget);
  ensureWidgets(definitions);
  return () => {
    for (let index = unregister.length - 1; index >= 0; index--) unregister[index]!();
  };
}

function slotWidgets(): WidgetDef[] {
  const settings = new Map(listSlots("widget.settings").map((item) => [
    typeof item.meta?.widgetId === "string" ? item.meta.widgetId : item.id,
    item,
  ]));
  return listSlots("widget.catalog").map((item): WidgetDef => {
    const meta = item.meta ?? {};
    const zone = meta.zone;
    const audience = meta.audience;
    const defaultSlot = meta.defaultSlot;
    const supportedSlots = Array.isArray(meta.supportedSlots)
      ? meta.supportedSlots.filter((value): value is UiSlot => typeof value === "string" && isUiSlot(value))
      : undefined;
    const setting = settings.get(item.id);
    const zones = Array.isArray(meta.supportedZones)
      ? meta.supportedZones.filter(isWidgetZone)
      : undefined;
    const size = (value: unknown): WidgetSize | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const candidate = value as { w?: unknown; h?: unknown };
      return typeof candidate.w === "number" && typeof candidate.h === "number"
        ? { w: candidate.w, h: candidate.h }
        : undefined;
    };
    return {
      id: item.id,
      pluginId: typeof meta.pluginId === "string" ? meta.pluginId : item.id.split(".")[0] ?? "plugin",
      ...(typeof meta.pluginName === "string" ? { pluginName: meta.pluginName } : {}),
      title: typeof meta.title === "string" ? meta.title : item.id.replace(/[._-]+/g, " "),
      description: typeof meta.description === "string" ? meta.description : "Plugin-provided workspace widget.",
      ...(meta.kind === "widget" || meta.kind === "mini-widget" ? { kind: meta.kind } : {}),
      ...(typeof defaultSlot === "string" && isUiSlot(defaultSlot) ? { defaultSlot } : {}),
      ...(supportedSlots && supportedSlots.length > 0 ? { supportedSlots } : {}),
      ...(typeof meta.defaultVisible === "boolean" ? { defaultVisible: meta.defaultVisible } : {}),
      ...(typeof meta.order === "number" ? { order: meta.order } : {}),
      ...(typeof meta.category === "string" ? { category: meta.category } : {}),
      ...(Array.isArray(meta.capabilities)
        ? { capabilities: meta.capabilities.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(isWidgetZone(zone) ? { zone } : {}),
      ...(zones && zones.length > 0 ? { supportedZones: zones } : {}),
      ...(audience === "simple" || audience === "standard" || audience === "power" ? { audience } : {}),
      ...(size(meta.defaultSize) ? { defaultSize: size(meta.defaultSize)! } : {}),
      ...(size(meta.minSize) ? { minSize: size(meta.minSize)! } : {}),
      ...(size(meta.maxSize) ? { maxSize: size(meta.maxSize)! } : {}),
      ...(Array.isArray(meta.showIn)
        ? { showIn: meta.showIn.filter((value): value is WidgetAudience =>
            value === "simple" || value === "standard" || value === "power") }
        : {}),
      ...(meta.scope === "global" || meta.scope === "workspace" || meta.scope === "plugin"
        ? { scope: meta.scope }
        : {}),
      ...(typeof meta.resizable === "boolean" ? { resizable: meta.resizable } : {}),
      ...(typeof meta.duplicatable === "boolean" ? { duplicatable: meta.duplicatable } : {}),
      ...(typeof meta.floating === "boolean" ? { floating: meta.floating } : {}),
      ...(typeof meta.recommended === "boolean" ? { recommended: meta.recommended } : {}),
      ...(meta.settingsSchema && typeof meta.settingsSchema === "object"
        ? { settingsSchema: meta.settingsSchema as Readonly<Record<string, unknown>> }
        : {}),
      render: (context) => item.render(context),
      ...(setting ? { settingsRender: (context: WidgetSettingsContext) => setting.render(context) } : {}),
    };
  });
}

function isWidgetZone(value: unknown): value is WidgetZone {
  return value === "header" || value === "left" || value === "main"
    || value === "right" || value === "bottom" || value === "floating";
}

// The merged catalog is cached per (registry, slot) version so render-time
// consumers get a stable array reference and stable WidgetDef identities —
// no rebuild, re-sort, or new render closures on unrelated re-renders.
let cachedVersion = "";
let cachedList: WidgetDef[] | null = null;
let cachedById = new Map<string, WidgetDef>();

export function listWidgets(): WidgetDef[] {
  const key = catalogVersion();
  if (cachedList === null || cachedVersion !== key) {
    const all = new Map<string, WidgetDef>(registry);
    for (const widget of slotWidgets()) all.set(widget.id, widget);
    cachedList = [...all.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    cachedById = all;
    cachedVersion = key;
  }
  return cachedList;
}

/** O(1) lookup against the same cache as listWidgets(). */
export function getWidget(id: string): WidgetDef | undefined {
  listWidgets();
  return cachedById.get(id);
}

function catalogVersion(): string {
  return `${version}:${slotVersion()}`;
}

export function useWidgetCatalog(): WidgetDef[] {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const offSlots = subscribeSlots(listener);
      return () => {
        listeners.delete(listener);
        offSlots();
      };
    },
    catalogVersion,
  );
  return listWidgets();
}

export interface PolythWidgetsApi {
  registerWidget: typeof registerWidget;
  registerPlugin: typeof registerWidgetPlugin;
  listWidgets: typeof listWidgets;
}

declare global {
  interface Window {
    __polythWidgets?: PolythWidgetsApi;
  }
}

export function exposeWidgets(): void {
  if (typeof window !== "undefined") {
    window.__polythWidgets = { registerWidget, registerPlugin: registerWidgetPlugin, listWidgets };
  }
}
