import { BUILTIN_CAPABILITY_META, registerCapability } from "../capabilities.ts";
import { setActiveView } from "../store.ts";
import { WORKFLOW_WIDGET_PLUGIN } from "../widgets/builtinMiniWidgets.tsx";
import { registerWidgetPlugin } from "../widgets/catalog.ts";
import { combineUnregister } from "./settingsPage.ts";

const workflowCapability = BUILTIN_CAPABILITY_META.find((meta) => meta.id === "workflow");

export function installWorkflowPackage(): () => void {
  if (!workflowCapability) throw new Error("Workflow capability metadata is missing");
  return combineUnregister(
    registerCapability({
      ...workflowCapability,
      open: () => setActiveView("workflow"),
      available: () => true,
    }),
    registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN),
  );
}
