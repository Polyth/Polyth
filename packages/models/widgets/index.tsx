import "./styles.css";
import type { HarnessSnapshot } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { tr } from "@polyth/web/i18n";
import HarnessModels from "./HarnessModels.tsx";
import ModelsPage from "./ModelsPage.tsx";
import {
  invalidateRuntimeCatalogs,
  preloadRuntimeCatalogs,
  resetRuntimeCatalogMemory,
  runtimeCatalogRefreshDelay,
} from "./runtimeCatalog.ts";

const DAILY_CACHE_MS = 24 * 60 * 60_000;

export default defineWebPackage((host) => () => {
  let active = true;
  let warmScope: string | undefined;
  let warmGeneration = 0;
  let bootstrapWarm: Promise<void> | undefined;
  let dailyRefresh: number | undefined;
  let scheduleDailyRefresh = () => {};
  const warmCatalogs = () => {
    if (!active) return;
    // Desktop publishes this before package boot completes. While its async
    // setting is unresolved, wait for the event instead of defeating the
    // explicit low-resource policy with an eager provider probe.
    const resourceMode = document.body.dataset.desktopLowResource;
    if (document.body.classList.contains("desktop-app") && resourceMode === undefined) return;
    if (resourceMode === "true") return;
    const snapshot = host.store.getSnapshot();
    const projectId = snapshot.activeProjectId ?? undefined;
    const scope = projectId ?? "default";
    if (scope === warmScope) return;
    warmScope = scope;
    const generation = ++warmGeneration;
    if (!projectId) {
      const run = preloadRuntimeCatalogs().catch(() => {});
      bootstrapWarm = run;
      void run.finally(() => {
        if (bootstrapWarm === run) bootstrapWarm = undefined;
        scheduleDailyRefresh();
      });
      return;
    }
    // Project restoration commonly races the context-free bootstrap. Let its
    // returned snapshot aliases land first, then fill only a genuinely missing
    // project scope instead of duplicating every native discovery flight.
    const priorBootstrap = bootstrapWarm;
    void (async () => {
      await priorBootstrap;
      if (!active || generation !== warmGeneration) return;
      await preloadRuntimeCatalogs({ projectId });
      scheduleDailyRefresh();
    })().catch(() => {});
  };
  scheduleDailyRefresh = () => {
    if (dailyRefresh !== undefined) window.clearTimeout(dailyRefresh);
    if (!active) return;
    const projectId = host.store.getSnapshot().activeProjectId ?? undefined;
    const remaining = projectId ? runtimeCatalogRefreshDelay(projectId) : undefined;
    // No completed warm stamp yet: the in-flight warm will reschedule us.
    // Otherwise fire at the persisted stamp's real expiry, not 24h after F5.
    const delay = remaining === undefined ? DAILY_CACHE_MS : Math.max(1_000, remaining + 50);
    dailyRefresh = window.setTimeout(() => {
      dailyRefresh = undefined;
      invalidateRuntimeCatalogs();
      warmScope = undefined;
      warmCatalogs();
    }, delay);
  };
  const onResourceMode = () => {
    warmScope = undefined;
    warmCatalogs();
  };
  window.addEventListener("polyth:desktop-performance-changed", onResourceMode);
  warmCatalogs();
  scheduleDailyRefresh();
  const off = [
    () => { if (dailyRefresh !== undefined) window.clearTimeout(dailyRefresh); },
    () => window.removeEventListener("polyth:desktop-performance-changed", onResourceMode),
    host.store.subscribe(warmCatalogs),
    // OpenCode curates providers natively (its own config), so its section
    // stands in for the shared picker-visibility one.
    host.slots.register({
      id: "opencode.providers-models",
      slot: "settings.harness.detail",
      order: 2,
      meta: { harnessId: "opencode", sectionId: "providers-models", label: tr("packages.models.providersModels"), replaces: ["models"] },
      render: (context) => context.harnessId === "opencode" && context.sectionId === "providers-models" ? <ModelsPage /> : null,
    }),
    host.slots.register({
      id: "models.harness-models",
      slot: "settings.harness.detail",
      order: 2,
      meta: { harnessId: "*", sectionId: "models", label: tr("harnessmodels.tab") },
      render: (context) => context.sectionId === "models" && typeof context.harnessId === "string"
        ? <HarnessModels key={context.harnessId} harnessId={context.harnessId} snapshot={context.snapshot as HarnessSnapshot | undefined} />
        : null,
    }),
    host.capabilities.register({
      id: "models-agents",
      label: tr("models.capability.label"),
      plainDescription: tr("models.capability.description"),
      keywords: ["model", "profile", "provider", "OpenCode"],
      standardTier: "technical",
      standardRank: 32,
      open: () => host.navigation.openSettingsPage("harnesses", { itemId: "opencode", sectionId: "providers-models" }),
      available: () => true,
    }),
  ];
  return () => {
    active = false;
    warmGeneration++;
    off.toReversed().forEach((dispose) => dispose());
    resetRuntimeCatalogMemory();
  };
});
