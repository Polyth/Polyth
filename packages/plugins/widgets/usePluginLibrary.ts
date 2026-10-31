// State and lifecycle operations of the managed package library. Views stay
// declarative: every mutation goes through here, marks its package busy while
// in flight, re-reads the registry once it settles and reports the outcome in
// place (row/detail state plus a polite announcement) — never as a toast.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@polyth/session/web-api";
import type { InstalledPluginDto, PackageCapabilityRequestDto } from "@polyth/contracts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useWidgetCatalog } from "../../../apps/web/src/widgets/catalog.ts";
import { useWidgetLayout } from "../../../apps/web/src/widgets/widgetLayout.ts";
import type { SourceInstallOptions } from "./PluginInstallDialog.tsx";
import { capabilityRequired } from "./PluginPermissions.tsx";

export interface ApproveOptions {
  enableAfter?: boolean;
  includeOptional?: boolean;
}

export interface PluginUpdateSettings {
  autoUpdate?: boolean;
  forkStrategy?: "rebase" | "merge";
}

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** A sandboxed package that cannot start until required access is granted. */
export function needsReviewToEnable(plugin: InstalledPluginDto): boolean {
  const review = plugin.permissions.review;
  return plugin.runtimeKind === "sandboxed" && !plugin.enabled && Boolean(review && (
    review.connections.length > 0 || review.capabilities.some(capabilityRequired)
  ));
}

export function usePluginLibrary() {
  const [plugins, setPlugins] = useState<InstalledPluginDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  /** Library-level outcome shown under the section title (update checks). */
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const list = await api.pluginsList();
    if (!mounted.current) return;
    setPlugins(list);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => {
      if (!mounted.current) return;
      setError(message(cause));
      setLoaded(true);
    });
  }, [refresh]);

  const settle = useCallback(() => refresh().catch((cause) => setError(message(cause))), [refresh]);

  const markBusy = (id: string, on: boolean) => setBusy((current) => {
    if (current.has(id) === on) return current;
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  /** Runs one package operation: busy while in flight, error kept, list re-read. */
  const run = async (id: string, work: () => Promise<string | void>): Promise<boolean> => {
    setError("");
    setStatus("");
    markBusy(id, true);
    let ok = true;
    try {
      const done = await work();
      if (done) setAnnouncement(done);
    } catch (cause) {
      ok = false;
      setError(message(cause));
    } finally {
      markBusy(id, false);
    }
    await settle();
    return ok;
  };

  const installed = async (plugin: InstalledPluginDto) => {
    setAnnouncement(tr("settings.pages.pluginInstalledContributionsAvailable", { name: plugin.name }));
    await settle();
    return plugin;
  };

  const installSource = async (source: string, options: SourceInstallOptions) => {
    setError("");
    return installed(await api.pluginsInstall(source, options));
  };

  const installArchive = async (archive: string, filename: string) => {
    setError("");
    return installed(await api.pluginsInstallArchive(archive, filename));
  };

  const setEnabled = (plugin: InstalledPluginDto, enabled: boolean) => run(plugin.id, async () => {
    const next = await api.pluginsOp(plugin.id, enabled ? "enable" : "disable");
    return enabled
      ? tr("settings.pages.pluginEnabledSeeContributions", { name: next.name })
      : tr("settings.pages.pluginDisabledPlacementsKept", { name: next.name });
  });

  const reload = (plugin: InstalledPluginDto) => run(plugin.id, async () => {
    const next = await api.pluginsOp(plugin.id, "reload");
    return tr("settings.pages.pluginReloaded", { name: next.name });
  });

  const approve = (plugin: InstalledPluginDto, options: ApproveOptions = {}) => run(plugin.id, async () => {
    const review = plugin.permissions.review;
    if (!review) return;
    const capabilities = review.capabilities
      .filter((item: PackageCapabilityRequestDto) => options.includeOptional || capabilityRequired(item))
      .map((item) => item.name);
    await api.pluginsGrant(plugin.id, capabilities, review.connections.map((item) => item.id));
    if (options.enableAfter) {
      const next = await api.pluginsOp(plugin.id, "enable");
      return tr("settings.pages.pluginEnabledSeeContributions", { name: next.name });
    }
    return tr("settings.pages.pluginReloaded", { name: plugin.name });
  });

  /** Stages (and, without new access, activates) the newer version. */
  const stageUpdate = (plugin: InstalledPluginDto) => run(plugin.id, async () => {
    try {
      const next = await api.pluginsUpdate(plugin.id);
      return next.permissions.review || next.update
        ? tr("packages.plugins.additionalAccessRequested")
        : tr("settings.pages.pluginReloaded", { name: next.name });
    } catch (cause) {
      throw new Error(plugin.previousVersion
        ? tr("packages.plugins.updateFailedRestored", { version: plugin.previousVersion })
        : message(cause));
    }
  });

  const checkUpdate = async (plugin: InstalledPluginDto) => {
    setError("");
    setChecking(plugin.id);
    try {
      const next = await api.pluginsCheckUpdate(plugin.id);
      setAnnouncement(next.updateCheck?.available
        ? tr("packages.plugins.updateAvailableNamed", { name: next.name })
        : tr("packages.plugins.upToDateNamed", { name: next.name }));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setChecking(null);
    }
    await settle();
  };

  const checkAllUpdates = async () => {
    setError("");
    setChecking("*");
    try {
      const list = await api.pluginsCheckUpdates();
      if (!mounted.current) return;
      setPlugins(list);
      const count = list.filter((plugin) => plugin.updateCheck?.available).length;
      const outcome = count > 0
        ? tr("packages.plugins.updatesAvailableCount", { count })
        : tr("packages.plugins.allUpToDate");
      setStatus(outcome);
      setAnnouncement(outcome);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setChecking(null);
    }
  };

  const updateSettings = (plugin: InstalledPluginDto, settings: PluginUpdateSettings) => run(plugin.id, async () => {
    await api.pluginsUpdateSettings(plugin.id, settings);
  });

  const rollback = (plugin: InstalledPluginDto) => run(plugin.id, async () => {
    const next = await api.pluginsRollback(plugin.id);
    return tr("packages.plugins.rolledBackToVersion", { name: next.name, version: next.version });
  });

  /** Asks first; warns when the package's widgets sit in the layout. */
  const remove = async (plugin: InstalledPluginDto): Promise<boolean> => {
    const active = Object.values(layout.widgets).filter((placement) =>
      placement.visible
      && (placement.pluginId === plugin.id
        || widgets.some((widget) => widget.id === placement.definitionId && widget.pluginId === plugin.id)));
    const warning = active.length > 0
      ? tr("settings.pages.pluginWidgetsInLayoutUninstallWarning", { count: active.length, name: plugin.name })
      : tr("settings.pages.removePluginValue", { name: plugin.name });
    if (!await confirmAlert(warning, { title: tr("settings.pages.removePlugin"), confirmLabel: tr("settings.pages.uninstall") })) return false;
    return run(plugin.id, async () => {
      await api.pluginsRemove(plugin.id);
      return tr("settings.pages.pluginRemoved", { name: plugin.name });
    });
  };

  return {
    plugins,
    loaded,
    error,
    clearError: () => setError(""),
    announcement,
    status,
    checking,
    busy,
    refresh: settle,
    installSource,
    installArchive,
    setEnabled,
    reload,
    approve,
    stageUpdate,
    checkUpdate,
    checkAllUpdates,
    updateSettings,
    rollback,
    remove,
  };
}

export type PluginLibrary = ReturnType<typeof usePluginLibrary>;
