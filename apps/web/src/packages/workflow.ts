import { BUILTIN_CAPABILITY_META, registerCapability } from "../capabilities.ts";
import { getState, setActiveView } from "../store.ts";
import { WORKFLOW_WIDGET_PLUGIN } from "../widgets/builtinMiniWidgets.tsx";
import { registerWidgetPlugin } from "../widgets/catalog.ts";
import { combineUnregister } from "./settingsPage.ts";

const workflowCapability = BUILTIN_CAPABILITY_META.find((meta) => meta.id === "workflow");

export function installWorkflowPackage(): () => void {
  if (!workflowCapability) throw new Error("Workflow capability metadata is missing");
  const unregister = combineUnregister(
    registerCapability({
      ...workflowCapability,
      open: () => setActiveView("workflow"),
      available: () => true,
    }),
    registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN),
  );
  return () => {
    unregister();
    if (getState().activeView === "workflow") setActiveView("session");
  };
}
