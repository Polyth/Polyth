import type { InstalledPluginDto, UiSlotItem } from "@polyth/contracts";
import { createElement, useEffect, useState, type ComponentType } from "react";
import { api } from "@polyth/session/web-api";
import {
  loadPluginModule,
  resolveModule,
  unloadPluginModule,
} from "./pluginModules.ts";
import { registerSlot } from "./slots.ts";
import type { SyncClient } from "./sync.ts";
import { tr } from "./i18n/index.ts";
import { buttonClassName } from "./components/ui/buttonClassName.ts";
import { setRailPlugin } from "./store.ts";
import { disposePackageRuntimes } from "./packages/sandbox/runtime.ts";
import { requestComposerAction } from "./packages/sandbox/composerAction.ts";

function SandboxHostSlot(props: { plugin: InstalledPluginDto; surfaceId: string }) {
  const [Frame, setFrame] = useState<ComponentType<{ plugin: InstalledPluginDto; surfaceId: string }> | null>(null);
  useEffect(() => {
    let active = true;
    void import("./packages/sandbox/SandboxFrame.tsx").then((mod) => {
      if (active) setFrame(() => mod.SandboxFrame);
    });
    return () => { active = false; };
  }, []);
  if (!Frame) return createElement("div", { className: "polyth-sandbox-pending", "aria-busy": true });
  return createElement(Frame, props);
}

function SandboxContributionHostSlot(props: {
  plugin: InstalledPluginDto;
  item: UiSlotItem;
  hostProps: Record<string, unknown>;
}) {
  const [Contribution, setContribution] = useState<ComponentType<typeof props> | null>(null);
  useEffect(() => {
    let active = true;
    void import("./packages/sandbox/Contribution.tsx").then((mod) => {
      if (active) setContribution(() => mod.SandboxContributionSlot as ComponentType<typeof props>);
    });
    return () => { active = false; };
  }, []);
  if (!Contribution) return null;
  return createElement(Contribution, props);
}

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
 * Mirrors server-owned plugin descriptors into the web slot registry. Trusted
 * UI bundles turn module keys into React components. Sandboxed packages never
 * import into the host React realm — they contribute bounded data and RemoteUI
 * through host-owned adapters.
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
  const generations = new Map<string, number>();
  const known = new Set<string>();
  let disposed = false;
  let refreshing = false;
  let refreshQueued = false;

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
    disposePackageRuntimes(pluginId);
  };

  const registerItems = (
    plugin: InstalledPluginDto,
    signature: string,
    generation: number,
  ): void => {
    if (disposed || generations.get(plugin.id) !== generation) return;
    const disposers: Array<() => void> = [];
    const sandboxed = plugin.runtimeKind === "sandboxed";
    for (const item of plugin.contributions) {
      const meta: Record<string, unknown> = {
        ...(item.props ?? {}),
        pluginId: plugin.id,
        pluginName: plugin.name,
        ...(item.order !== undefined ? { order: item.order } : {}),
        module: item.module,
      };
      if (sandboxed && meta.contributionKind === "tool-renderer") {
        meta.eventTypes = ["tool/call", "tool/result", "tool/error"];
      }
      const title = typeof meta.title === "string"
        ? meta.title
        : item.id.replace(/[._-]+/g, " ");
      const render = sandboxed
        ? sandboxRender(plugin, item, meta)
        : (() => {
          const component = resolve(plugin.id, item.module);
          if (!component && item.slot !== "widget.catalog") return null;
          return component
            ? (props: Record<string, unknown>) => createElement(component, { ...(item.props ?? {}), ...props })
            : () => tr("pluginbridge.pluginWidgetValue", { title });
        })();
      if (!render) continue;
      disposers.push(register(
        item.slot,
        item.id,
        render,
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
      version: plugin.version,
      enabled: plugin.enabled,
      status: plugin.status,
      contributions: plugin.contributions,
      runtimeKind: plugin.runtimeKind ?? null,
      permissions: plugin.permissions.effective,
      ui: plugin.ui ? { url: plugin.ui.url, integrity: plugin.ui.integrity } : null,
      sandbox: plugin.sandbox ? { url: plugin.sandbox.url, integrity: plugin.sandbox.integrity } : null,
    });
    if (active.get(plugin.id)?.signature === signature) return;
    const generation = nextGeneration(plugin.id);
    unregister(plugin.id);
    if (!plugin.enabled || plugin.status !== "ready") {
      unload(plugin.id);
      return;
    }

    if (plugin.runtimeKind !== "sandboxed" && plugin.ui) {
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

  const refreshFromServer = async (): Promise<void> => {
    if (disposed) return;
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshQueued = false;
        const plugins = await pluginsList();
        if (disposed) return;
        const listed = new Set(plugins.map((plugin) => plugin.id));
        for (const pluginId of [...active.keys()]) {
          if (!listed.has(pluginId)) {
            unregister(pluginId);
            unload(pluginId);
          }
        }
        await Promise.all(plugins.map(reconcile));
      } while (refreshQueued && !disposed);
    } finally {
      refreshing = false;
    }
  };

  const offSync = sync?.onEvent((message) => {
    if (message.type !== "plugin/changed") return;
    void refreshFromServer();
  }) ?? (() => {});

  try {
    await refreshFromServer();
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

function firstSandboxSurfaceId(plugin: InstalledPluginDto): string {
  for (const item of plugin.contributions) {
    if (item.module.startsWith("sandbox-surface:")) {
      return item.module.slice("sandbox-surface:".length);
    }
  }
  return "main";
}

function sandboxRender(
  plugin: InstalledPluginDto,
  item: UiSlotItem,
  meta: Record<string, unknown>,
) {
  const moduleKey = item.module;
  if (moduleKey.startsWith("sandbox-contribution:")) {
    return (hostProps: Record<string, unknown>) => createElement(SandboxContributionHostSlot, {
      plugin,
      item,
      hostProps,
    });
  }
  if (moduleKey.startsWith("sandbox-action:")) {
    const actionId = moduleKey.slice("sandbox-action:".length);
    const surface = firstSandboxSurfaceId(plugin);
    const label = typeof meta.label === "string" ? meta.label : plugin.name;
    return () => createElement("button", {
      type: "button",
      className: buttonClassName({ size: "sm", variant: "ghost" }),
      onClick: () => {
        requestComposerAction(plugin.id, actionId, surface);
        setRailPlugin(`slot:${plugin.id}.surface.${surface}`);
      },
    }, label);
  }
  const surfaceId = moduleKey.startsWith("sandbox-surface:")
    ? moduleKey.slice("sandbox-surface:".length)
    : typeof meta.surfaceId === "string"
      ? meta.surfaceId
      : moduleKey;
  return () => createElement(SandboxHostSlot, { plugin, surfaceId });
}
