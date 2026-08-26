import { BUILTIN_CAPABILITY_META, registerCapability } from "../../../apps/web/src/capabilities.ts";
import { getState, setActiveView, setRailPlugin, setSidebarOpen } from "../../../apps/web/src/store.ts";
import { WORKFLOW_WIDGET_PLUGIN } from "../../../apps/web/src/widgets/builtinMiniWidgets.tsx";
import { registerWidgetPlugin } from "../../../apps/web/src/widgets/catalog.ts";
import { setWorkspaceMode } from "../../../apps/web/src/widgets/workspaceMode.ts";
import { combineUnregister } from "../../../apps/web/src/packages/settingsPage.ts";

const workflowCapability = BUILTIN_CAPABILITY_META.find((meta) => meta.id === "workflow");

export function installWorkflowPackage(): () => void {
  if (!workflowCapability) throw new Error("Workflow capability metadata is missing");
  const unregister = combineUnregister(
    registerCapability({
      ...workflowCapability,
      open: () => {
        setRailPlugin(null);
        setSidebarOpen(false);
        setWorkspaceMode("chat");
        setActiveView("workflow");
      },
      available: () => true,
    }),
    registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN),
  );
  return () => {
    unregister();
    if (getState().activeView === "workflow") setActiveView("session");
  };
}
