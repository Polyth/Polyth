import { listWidgets } from "../widgets/catalog.ts";
import {
  ensureWidgets,
  getWidgetLayout,
  updateWidgetLayout,
  widgetLayoutStorageKey,
} from "../widgets/widgetLayout.ts";
import {
  currentCompositionProjectId,
  subscribeProjectRelevance,
} from "./projectRelevance.ts";
import {
  persistedProjectWidgetIds,
  pruneUnpersistedIrrelevantWidgets,
} from "./projectWidgetIsolation.ts";

const persistedIdsFor = (projectId: string | null): Set<string> => {
  if (!projectId) return new Set();
  try {
    return persistedProjectWidgetIds(localStorage.getItem(widgetLayoutStorageKey(projectId)));
  } catch {
    return new Set();
  }
};

/** Package activation is global, while widget relevance is project-scoped.
 * A package that was irrelevant when it registered does not register again on
 * project switches, so reconcile the canonical registry into the new project's
 * durable layout whenever relevance changes. Existing persisted customization
 * is kept latent; only globally injected, never-persisted irrelevant defaults
 * are pruned before relevant definitions are seeded. */
export function installProjectWidgetReconciler(): () => void {
  let projectId = currentCompositionProjectId();

  const reconcile = () => {
    const nextProjectId = currentCompositionProjectId();
    if (nextProjectId !== projectId) {
      projectId = nextProjectId;
      // The widget-layout store also observes project switches. Run after the
      // current synchronous store notification batch so it has hydrated the
      // new project's key before we prune globally registered defaults.
      queueMicrotask(() => {
        if (currentCompositionProjectId() !== nextProjectId) return;
        const definitions = listWidgets();
        const current = getWidgetLayout();
        const isolated = pruneUnpersistedIrrelevantWidgets(
          current,
          definitions,
          persistedIdsFor(nextProjectId),
        );
        if (isolated !== current) updateWidgetLayout(isolated, { immediate: true });
        ensureWidgets(definitions);
      });
      return;
    }
    ensureWidgets(listWidgets());
  };

  const stop = subscribeProjectRelevance(reconcile);
  reconcile();
  return stop;
}
