import "./styles.css";
import "./mobilePicker.css";
import type { HarnessSnapshot } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import ModelsPage from "./ModelsPage.tsx";
import HarnessModelsPage, { HARNESS_MODEL_SETTINGS_MIN_MODELS } from "./HarnessModelsPage.tsx";
import {
  preloadRuntimeCatalogs,
  resetRuntimeCatalogMemory,
} from "./runtimeCatalog.ts";

const DAILY_CACHE_MS = 24 * 60 * 60_000;

export default defineWebPackage((host) => () => {
  let active = true;
  let warmScope: string | undefined;
  let warmGeneration = 0;
  let bootstrapWarm: Promise<void> | undefined;
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
    })().catch(() => {});
  };
  const dailyRefresh = window.setInterval(() => {
    resetRuntimeCatalogMemory();
    warmScope = undefined;
    warmCatalogs();
  }, DAILY_CACHE_MS);
  const onResourceMode = () => {
    warmScope = undefined;
    warmCatalogs();
  };
  window.addEventListener("polyth:desktop-performance-changed", onResourceMode);
  warmCatalogs();
  const off = [
    () => window.clearInterval(dailyRefresh),
    () => window.removeEventListener("polyth:desktop-performance-changed", onResourceMode),
    host.store.subscribe(warmCatalogs),
    host.slots.register({
      id: "opencode.providers-models",
      slot: "settings.harness.detail",
      order: 10,
      meta: { harnessId: "opencode", sectionId: "providers-models", label: "Providers & Models" },
      render: (context) => context.harnessId === "opencode" && context.sectionId === "providers-models" ? <ModelsPage /> : null,
    }),
    host.slots.register({
      id: "models.large-harness-catalog",
      slot: "settings.harness.detail",
      order: 10,
      meta: {
        harnessId: "*",
        sectionId: "providers-models",
        label: "Providers & Models",
        minModels: HARNESS_MODEL_SETTINGS_MIN_MODELS,
        excludeHarnessIds: ["opencode"],
      },
      render: (context) => {
        const harnessId = typeof context.harnessId === "string" ? context.harnessId : "";
        if (!harnessId || harnessId === "opencode" || context.sectionId !== "providers-models") return null;
        const snapshot = context.snapshot as HarnessSnapshot | undefined;
        if ((snapshot?.catalog?.models?.length ?? 0) < HARNESS_MODEL_SETTINGS_MIN_MODELS) return null;
        return <HarnessModelsPage
          harnessId={harnessId}
          snapshot={snapshot}
          projectId={typeof context.projectId === "string" ? context.projectId : undefined}
        />;
      },
    }),
    host.capabilities.register({
      id: "models-agents",
      label: "Models & providers",
      plainDescription: "Choose models and configure OpenCode providers.",
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
