import { listWidgets } from "../widgets/catalog.ts";
import { ensureWidgets } from "../widgets/widgetLayout.ts";
import { subscribeProjectRelevance } from "./projectRelevance.ts";

/** Package activation is global, while widget relevance is project-scoped.
 * A package that was irrelevant when it registered does not register again on
 * project switches, so reconcile the canonical registry into the new project's
 * durable layout whenever relevance changes. Existing visibility is preserved:
 * ensureWidgets only seeds definitions missing from that project. */
export function installProjectWidgetReconciler(): () => void {
  const reconcile = () => ensureWidgets(listWidgets());
  const stop = subscribeProjectRelevance(reconcile);
  reconcile();
  return stop;
}
