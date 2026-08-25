import type { ComponentType } from "react";
import { tr } from "./i18n/index.ts";

/**
 * Contract implemented by every managed plugin UI entry:
 *
 *   export const modules: Record<string, ComponentType<Record<string, unknown>>>;
 */
export interface PluginModuleExports {
  modules: Record<string, ComponentType<Record<string, unknown>>>;
}

const loadedModules = new Map<string, PluginModuleExports>();
const generations = new Map<string, number>();

const nextGeneration = (pluginId: string): number => {
  const generation = (generations.get(pluginId) ?? 0) + 1;
  generations.set(pluginId, generation);
  return generation;
};

export async function loadPluginModule(
  pluginId: string,
  url: string,
  integrity: string,
): Promise<PluginModuleExports> {
  const generation = nextGeneration(pluginId);
  const loaded = await import(`${url}?v=${encodeURIComponent(integrity)}`) as {
    modules?: unknown;
  };
  if (
    !loaded.modules
    || typeof loaded.modules !== "object"
    || Array.isArray(loaded.modules)
    || Object.values(loaded.modules).some((component) => typeof component !== "function")
  ) {
    throw new Error(tr("pluginmodules.pluginValueUiEntryMustExportA", { pluginId: pluginId }));
  }

  const exports = {
    modules: loaded.modules as PluginModuleExports["modules"],
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

export function unloadPluginModule(pluginId: string): void {
  nextGeneration(pluginId);
  loadedModules.delete(pluginId);
}
