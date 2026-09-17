import { defineWebPackage } from "@polyth/web-sdk";
import { createTaskTrackerInstaller } from "./plugin.tsx";
import "./styles.css";

export {
  LinkedTaskWidget,
  TASK_TRACKER_WIDGET_PLUGIN,
  TaskTrackerBoard,
  configureTaskTrackerHost,
  defaultViewForBoard,
  groupTasksByStatus,
} from "./plugin.tsx";
export { api } from "./api.ts";

export default defineWebPackage((host) => {
  const installWidgets = createTaskTrackerInstaller(host);
  return () => {
    const disposeWidgets = installWidgets();
    const disposeContext = host.projectContext.register({
      id: "task-trackers.seed",
      order: 50,
      getSnapshot: () => ({
        title: "Task trackers",
        recommendedWidgetIds: ["task-trackers.board"],
      }),
    });
    return () => {
      disposeContext();
      disposeWidgets();
    };
  };
});
