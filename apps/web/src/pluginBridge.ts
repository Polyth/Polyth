import type { InstalledPluginDto } from "@polyth/contracts";
import { createElement } from "react";
import { api } from "./api.ts";
import {
  loadPluginModule,
  resolveModule,
  unloadPluginModule,
} from "./pluginModules.ts";
import { registerSlot } from "./slots.ts";
import type { SyncClient } from "./sync.ts";

type PluginSync = Pick<SyncClient, "onEvent">;
type SlotRegistrar = typeof registerSlot;
type PluginLoader = typeof loadPluginModule;
type ModuleResolver = typeof resolveModule;
type PluginUnloader = typeof unloadPluginModule;

export interface PluginBridgeDependencies {
  pluginsList(): Promise<InstalledPluginDto[]>;
  register: SlotRegistrar;
  load: PluginLoader;
  resolve: ModuleResolver;
  unload: PluginUnloader;
}

interface PluginRegistration {
  signature: string;
  unregister: Array<() => void>;
}

/**
 * Mirrors server-owned plugin descriptors into the web slot registry. UI
 * bundles turn manifest module keys into React components; catalog items keep
 * their metadata placeholder when a plugin has no matching exported module.
 */
export async function initPluginBridge(
  sync?: PluginSync,
  dependencies: Partial<PluginBridgeDependencies> = {},
): Promise<() => void> {
  const pluginsList = dependencies.pluginsList ?? api.pluginsList;
  const register = dependencies.register ?? registerSlot;
  const load = dependencies.load ?? loadPluginModule;
  const resolve = dependencies.resolve ?? resolveModule;
  const unload = dependencies.unload ?? unloadPluginModule;
  const active = new Map<string, PluginRegistration>();
  const queued = new Map<string, InstalledPluginDto>();
  const generations = new Map<string, number>();
  const known = new Set<string>();
  let loading = true;
  let disposed = false;

  const nextGeneration = (pluginId: string): number => {
    const generation = (generations.get(pluginId) ?? 0) + 1;
    generations.set(pluginId, generation);
    return generation;
  };

  const unregister = (pluginId: string): void => {
    const current = active.get(pluginId);
    if (!current) return;
    for (let index = current.unregister.length - 1; index >= 0; index--) {
      current.unregister[index]!();
    }
    active.delete(pluginId);
  };

  const registerItems = (
    plugin: InstalledPluginDto,
    signature: string,
    generation: number,
  ): void => {
    if (disposed || generations.get(plugin.id) !== generation) return;
    const disposers: Array<() => void> = [];
    for (const item of plugin.contributions) {
      const component = resolve(plugin.id, item.module);
      if (!component && item.slot !== "widget.catalog") continue;
      const meta: Record<string, unknown> = {
        ...(item.props ?? {}),
        pluginId: plugin.id,
        pluginName: plugin.name,
        ...(item.order !== undefined ? { order: item.order } : {}),
        module: item.module,
      };
      const title = typeof meta.title === "string"
        ? meta.title
        : item.id.replace(/[._-]+/g, " ");
      disposers.push(register(
        item.slot,
        item.id,
        component
          ? (props) => createElement(component, { ...(item.props ?? {}), ...props })
          : () => `Plugin widget: ${title}`,
        item.order ?? 0,
        meta,
      ));
    }
    active.set(plugin.id, { signature, unregister: disposers });
  };

  const reconcile = async (plugin: InstalledPluginDto): Promise<void> => {
    known.add(plugin.id);
    const signature = JSON.stringify({
      name: plugin.name,
      enabled: plugin.enabled,
      status: plugin.status,
      contributions: plugin.contributions,
      ui: plugin.ui ? { url: plugin.ui.url, integrity: plugin.ui.integrity } : null,
    });
    if (active.get(plugin.id)?.signature === signature) return;
    const generation = nextGeneration(plugin.id);
    unregister(plugin.id);
    if (!plugin.enabled || plugin.status !== "ready") {
      unload(plugin.id);
      return;
    }

    if (plugin.ui) {
      try {
        await load(plugin.id, plugin.ui.url, plugin.ui.integrity);
      } catch {
        if (generations.get(plugin.id) === generation) unload(plugin.id);
      }
    } else {
      unload(plugin.id);
    }
    registerItems(plugin, signature, generation);
  };

  const offSync = sync?.onEvent((message) => {
    if (message.type !== "plugin/changed") return;
    if (loading) queued.set(message.plugin.id, message.plugin);
    else void reconcile(message.plugin);
  }) ?? (() => {});

  try {
    const plugins = await pluginsList();
    const listed = new Set(plugins.map((plugin) => plugin.id));
    for (const pluginId of [...active.keys()]) {
      if (!listed.has(pluginId)) unregister(pluginId);
    }
    await Promise.all(plugins.map(reconcile));
    loading = false;
    await Promise.all([...queued.values()].map(reconcile));
    queued.clear();
  } catch (error) {
    offSync();
    throw error;
  }

  return () => {
    disposed = true;
    offSync();
    for (const pluginId of known) {
      nextGeneration(pluginId);
      unregister(pluginId);
      unload(pluginId);
    }
  };
}
