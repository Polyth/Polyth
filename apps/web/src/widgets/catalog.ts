import { useSyncExternalStore, type ReactNode } from "react";
import { listSlots, slotVersion, subscribeSlots } from "../slots.ts";
import type { WidgetAudience, WidgetZone } from "./widgetLayout.ts";

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
  title: string;
  description: string;
  zone?: WidgetZone;
  defaultSize?: { w: number; h: number };
  audience?: WidgetAudience;
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

function slotWidgets(): WidgetDef[] {
  const settings = new Map(listSlots("widget.settings").map((item) => [
    typeof item.meta?.widgetId === "string" ? item.meta.widgetId : item.id,
    item,
  ]));
  return listSlots("widget.catalog").map((item): WidgetDef => {
    const meta = item.meta ?? {};
    const zone = meta.zone;
    const audience = meta.audience;
    const setting = settings.get(item.id);
    return {
      id: item.id,
      pluginId: typeof meta.pluginId === "string" ? meta.pluginId : item.id.split(".")[0] ?? "plugin",
      title: typeof meta.title === "string" ? meta.title : item.id.replace(/[._-]+/g, " "),
      description: typeof meta.description === "string" ? meta.description : "Plugin-provided workspace widget.",
      ...(zone === "main" || zone === "left" || zone === "right" || zone === "top" || zone === "bottom"
        ? { zone }
        : {}),
      ...(audience === "simple" || audience === "standard" || audience === "power" ? { audience } : {}),
      ...(meta.defaultSize && typeof meta.defaultSize === "object"
        ? { defaultSize: meta.defaultSize as { w: number; h: number } }
        : {}),
      render: (context) => item.render(context),
      ...(setting ? { settingsRender: (context: WidgetSettingsContext) => setting.render(context) } : {}),
    };
  });
}

export function listWidgets(): WidgetDef[] {
  const all = new Map<string, WidgetDef>(registry);
  for (const widget of slotWidgets()) all.set(widget.id, widget);
  return [...all.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
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
  listWidgets: typeof listWidgets;
}

declare global {
  interface Window {
    __polythWidgets?: PolythWidgetsApi;
  }
}

export function exposeWidgets(): void {
  if (typeof window !== "undefined") window.__polythWidgets = { registerWidget, listWidgets };
}
