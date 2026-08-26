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

export default defineWebPackage((host) => createTaskTrackerInstaller(host));
