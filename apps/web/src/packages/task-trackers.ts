import { installTaskTrackerPlugin } from "../widgets/taskTrackersPlugin.tsx";

export function installTaskTrackersPackage(): () => void {
  return installTaskTrackerPlugin();
}
