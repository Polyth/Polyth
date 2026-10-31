import type { ComponentType } from "react";
import { tr } from "./i18n/index.ts";

/** Props the host passes to a package mark: a monochrome `currentColor` glyph. */
export interface PluginIconProps {
  size?: number;
  strokeWidth?: number;
  "aria-hidden"?: boolean;
}

/** Display metadata for a `workspace.right.tabs` contribution, keyed by its
 *  module key. The manifest still declares the contribution; this only says
 *  how the host presents it. `presentation` is read as untrusted data. */
export interface PluginSurfaceMeta {
  title: string;
  description?: string;
  shortLabel?: string;
  keywords?: string[];
  presentation?: unknown;
}

/**
 * Contract implemented by every managed plugin UI entry:
 *
 *   export const modules: Record<string, ComponentType<Record<string, unknown>>>;
 *   export const icon?: ComponentType<PluginIconProps>;       // package mark
 *   export const surfaces?: Record<string, PluginSurfaceMeta>; // rail panels
 */
export interface PluginModuleExports {
  modules: Record<string, ComponentType<Record<string, unknown>>>;
  icon?: ComponentType<PluginIconProps>;
  surfaces?: Record<string, PluginSurfaceMeta>;
}

const loadedModules = new Map<string, PluginModuleExports>();
const generations = new Map<string, number>();

const nextGeneration = (pluginId: string): number => {
  const generation = (generations.get(pluginId) ?? 0) + 1;
  generations.set(pluginId, generation);
  return generation;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Keep only well-formed surface entries; a bad entry is dropped, never fatal. */
function surfaceMetaOf(value: unknown): Record<string, PluginSurfaceMeta> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, PluginSurfaceMeta> = {};
  for (const [moduleKey, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.title !== "string" || !raw.title.trim()) continue;
    out[moduleKey] = {
      title: raw.title.trim().slice(0, 80),
      ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 200) } : {}),
      ...(typeof raw.shortLabel === "string" ? { shortLabel: raw.shortLabel.slice(0, 24) } : {}),
      ...(Array.isArray(raw.keywords)
        ? { keywords: raw.keywords.filter((k): k is string => typeof k === "string").slice(0, 12) }
        : {}),
      ...(raw.presentation !== undefined ? { presentation: raw.presentation } : {}),
    };
  }
  return out;
}

export async function loadPluginModule(
  pluginId: string,
  url: string,
  integrity: string,
  retry = 0,
): Promise<PluginModuleExports> {
  const generation = nextGeneration(pluginId);
  // The browser memoises a failed module URL, so a retry needs a fresh one.
  const bust = retry > 0 ? `&retry=${retry}` : "";
  const loaded = await import(`${url}?v=${encodeURIComponent(integrity)}${bust}`) as {
    modules?: unknown;
    icon?: unknown;
    surfaces?: unknown;
  };
  if (
    !loaded.modules
    || typeof loaded.modules !== "object"
    || Array.isArray(loaded.modules)
    || Object.values(loaded.modules).some((component) => typeof component !== "function")
  ) {
    throw new Error(tr("pluginmodules.pluginValueUiEntryMustExportA", { pluginId: pluginId }));
  }

  const surfaces = surfaceMetaOf(loaded.surfaces);
  const exports: PluginModuleExports = {
    modules: loaded.modules as PluginModuleExports["modules"],
    ...(typeof loaded.icon === "function" ? { icon: loaded.icon as PluginModuleExports["icon"] } : {}),
    ...(surfaces ? { surfaces } : {}),
  };
  if (generations.get(pluginId) === generation) loadedModules.set(pluginId, exports);
  return exports;
}

export function resolveModule(
  pluginId: string,
  moduleKey: string,
): ComponentType<Record<string, unknown>> | null {
  return loadedModules.get(pluginId)?.modules[moduleKey] ?? null;
}

export function resolvePluginIcon(pluginId: string): ComponentType<PluginIconProps> | null {
  return loadedModules.get(pluginId)?.icon ?? null;
}

export function resolveSurfaceMeta(pluginId: string, moduleKey: string): PluginSurfaceMeta | null {
  return loadedModules.get(pluginId)?.surfaces?.[moduleKey] ?? null;
}

export function unloadPluginModule(pluginId: string): void {
  nextGeneration(pluginId);
  loadedModules.delete(pluginId);
}
