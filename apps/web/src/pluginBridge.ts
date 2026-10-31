import type { InstalledPluginDto, UiSlotItem } from "@polyth/contracts";
import { createElement, useEffect, useState, type ComponentType } from "react";
import { api } from "@polyth/session/web-api";
import {
  loadPluginModule,
  resolveModule,
  resolvePluginIcon,
  resolveSurfaceMeta,
  unloadPluginModule,
} from "./pluginModules.ts";
import { registerSlot } from "./slots.ts";
import { pluginPanePresentation, registerSurface } from "./surfaces.ts";
import { registerCapability } from "./capabilities.ts";
import { railIconMatch, registerPackageIcon } from "./railIcons.ts";
import type { SyncClient } from "./sync.ts";
import { tr } from "./i18n/index.ts";
import { buttonClassName } from "./components/ui/buttonClassName.ts";
import { openWorkspacePane, setRailPlugin } from "./store.ts";
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

const RECOVERY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000, 60_000];

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
  resolveIcon: typeof resolvePluginIcon;
  resolveSurface: typeof resolveSurfaceMeta;
  /** Test seam: the backoff schedule for failed plugin work. */
  recoveryDelaysMs: readonly number[];
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
  const resolveIcon = dependencies.resolveIcon ?? resolvePluginIcon;
  const resolveSurface = dependencies.resolveSurface ?? resolveSurfaceMeta;
  const active = new Map<string, PluginRegistration>();
  const generations = new Map<string, number>();
  const known = new Set<string>();
  const recoveryDelays = dependencies.recoveryDelaysMs ?? RECOVERY_DELAYS_MS;
  // Plugins whose UI module failed to import (or the whole list fetch failed).
  // Like built-in package entries, they are retried with backoff and on
  // foreground/online; a phone over a flaky link must not lose a plugin's
  // rail panel until the next relaunch.
  const loadFailed = new Set<string>();
  let loadAttempt = 0;
  let recoveryAttempt = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let listFailed = false;
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
    const mark = sandboxed ? null : resolveIcon(plugin.id);
    if (mark) disposers.push(registerPackageIcon(plugin.id, mark as ComponentType<Record<string, unknown>>));
    for (const item of plugin.contributions) {
      const surface = !sandboxed && item.slot === "workspace.right.tabs"
        ? registerManagedSurface(plugin, item, resolve, resolveSurface)
        : null;
      if (surface) {
        disposers.push(...surface);
        continue;
      }
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
      if (item.slot === "session.message.actions") meta.messageAction = messageActionMeta(meta, sandboxed);
      // A package's own settings page (contribution id = package id) is titled with the
      // package's name and addressed by the package id, so the host's curated placement,
      // icon, search synonyms and guarded-account hiding for that id apply to it.
      // SettingsView keeps a managed page from shadowing a built-in or workspace page.
      if (item.slot === "settings.pages" && item.id === plugin.id) {
        if (typeof meta.label !== "string") meta.label = plugin.name;
        if (typeof meta.pageId !== "string") meta.pageId = plugin.id;
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
    if (active.get(plugin.id)?.signature === signature && !loadFailed.has(plugin.id)) return;
    const generation = nextGeneration(plugin.id);
    unregister(plugin.id);
    if (!plugin.enabled || plugin.status !== "ready") {
      loadFailed.delete(plugin.id);
      unload(plugin.id);
      return;
    }

    if (plugin.runtimeKind !== "sandboxed" && plugin.ui) {
      try {
        // A failed module URL is memoised by the browser: retries are busted.
        await load(plugin.id, plugin.ui.url, plugin.ui.integrity, loadFailed.has(plugin.id) ? ++loadAttempt : 0);
        if (generations.get(plugin.id) === generation) loadFailed.delete(plugin.id);
      } catch {
        if (generations.get(plugin.id) === generation) {
          unload(plugin.id);
          loadFailed.add(plugin.id);
          scheduleRecovery();
        }
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
            loadFailed.delete(pluginId);
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

  const refreshOrRecover = async (): Promise<void> => {
    try {
      await refreshFromServer();
      listFailed = false;
    } catch (error) {
      listFailed = true;
      scheduleRecovery();
      throw error;
    }
    if (loadFailed.size === 0) recoveryAttempt = 0;
  };

  const pageHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

  function scheduleRecovery(): void {
    if (disposed || recoveryTimer !== null) return;
    const delay = recoveryDelays[Math.min(recoveryAttempt, recoveryDelays.length - 1)] ?? 60_000;
    recoveryAttempt += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void recover();
    }, delay);
    (recoveryTimer as { unref?: () => void }).unref?.();
  }

  async function recover(): Promise<void> {
    if (disposed) return;
    // A hidden page waits for the foreground instead of spending its retries.
    if (pageHidden()) return;
    await refreshOrRecover().catch(() => undefined);
  }

  const recoverNow = (): void => {
    if (disposed || (!listFailed && loadFailed.size === 0)) return;
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    void recover();
  };
  const onVisible = (): void => { if (!pageHidden()) recoverNow(); };
  const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (canListen) {
    window.addEventListener("online", recoverNow);
    window.addEventListener("pageshow", recoverNow);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisible);
  }

  const offSync = sync?.onEvent((message) => {
    if (message.type !== "plugin/changed") return;
    void refreshOrRecover().catch(() => undefined);
  }) ?? (() => {});

  try {
    await refreshOrRecover();
  } catch (error) {
    // The sync listener stays: a later plugin/changed (or the retry above)
    // still brings the plugins in.
    throw error;
  }

  return () => {
    disposed = true;
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    if (canListen) {
      window.removeEventListener("online", recoverNow);
      window.removeEventListener("pageshow", recoverNow);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisible);
    }
    offSync();
    for (const pluginId of known) {
      nextGeneration(pluginId);
      unregister(pluginId);
      unload(pluginId);
    }
  };
}

/** A trusted plugin's rail panel that ships display metadata (`surfaces`
 *  export) becomes a first-class surface + capability: its own mark, pane
 *  presentation, rail customization and search — the same model as an in-repo
 *  package home. Without metadata it stays a plain bridged slot.
 *
 *  The id must be the plugin id or live under it, so a plugin can never
 *  replace a host surface. Like every other managed contribution it carries
 *  no `ownerPackageId`: managed plugins are not in the package catalog, and an
 *  in-repo descriptor that shares the id (disabled) would hide the panel. */
function registerManagedSurface(
  plugin: InstalledPluginDto,
  item: UiSlotItem,
  resolve: ModuleResolver,
  resolveSurface: typeof resolveSurfaceMeta,
): Array<() => void> | null {
  const meta = resolveSurface(plugin.id, item.module);
  const component = resolve(plugin.id, item.module);
  const id = item.id;
  if (!meta || !component || (id !== plugin.id && !id.startsWith(`${plugin.id}.`))) return null;
  const presentation = pluginPanePresentation(meta.presentation);
  const icon = railIconMatch([id, plugin.id]);
  const offSurface = registerSurface({
    id,
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.shortLabel ? { shortLabel: meta.shortLabel } : {}),
    ...(icon ? { icon } : {}),
    capabilityId: id,
    order: 100 + (item.order ?? 0),
    component: (props) => createElement(component, { ...(item.props ?? {}), ...(props ?? {}) }),
    ...(presentation ? { presentation } : {}),
  });
  const offCapability = registerCapability({
    id,
    label: meta.title,
    plainDescription: meta.description ?? plugin.name,
    keywords: [...new Set([...(meta.keywords ?? []), plugin.name])],
    standardTier: "more",
    standardRank: 40 + (item.order ?? 0),
    open: () => {
      if (!openWorkspacePane(id)) setRailPlugin(id);
    },
    available: () => true,
  });
  return [offSurface, offCapability];
}

/** A managed message action joins the quick-action layout under its manifest
 *  label. Sandboxed launchers open a host dialog, so they can also live in
 *  the "More" menu; trusted components render themselves and stay on the bar. */
function messageActionMeta(meta: Record<string, unknown>, sandboxed: boolean): Record<string, unknown> {
  const roles = Array.isArray(meta.roles)
    ? meta.roles.filter((role) => role === "user" || role === "assistant")
    : [];
  return {
    label: typeof meta.label === "string" && meta.label.trim()
      ? meta.label.trim()
      : typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : String(meta.pluginName ?? ""),
    ...(typeof meta.description === "string" && meta.description.trim() ? { description: meta.description.trim() } : {}),
    ...(Array.isArray(meta.roles) && meta.roles.length > 0 ? { roles } : {}),
    menu: sandboxed && meta.contributionKind === "message-action",
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
