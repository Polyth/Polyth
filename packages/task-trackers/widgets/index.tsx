import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import { TaskTrackerSettingsPage } from "./management.tsx";
import { TaskTrackersPage } from "./page.tsx";
import { createTaskTrackerInstaller } from "./plugin.tsx";
import { tt } from "./i18n.ts";
import "./styles.css";

export {
  LinkedTaskWidget,
  TASK_TRACKER_WIDGET_PLUGIN,
  TaskTrackerBoard,
  configureTaskTrackerHost,
  defaultViewForBoard,
  enabledWidgetPlugin,
  groupTasksByStatus,
} from "./plugin.tsx";
export { TaskTrackerManagement, TaskTrackerSettingsPage } from "./management.tsx";
export { TaskTrackerOverview, summarizeProgress } from "./overview.tsx";
export { TaskTrackersPage } from "./page.tsx";
export { ConnectWizard } from "./connect.tsx";
export { api } from "./api.ts";

export default defineWebPackage((host) => {
  const installWidgets = createTaskTrackerInstaller(host);
  return () => {
    const off = [
      installWidgets(),
      host.surfaces.register({
        id: "task-trackers",
        title: tt("tasktrackers.surface.tasks"),
        description: tt("tasktrackers.surface.description"),
        shortLabel: tt("tasktrackers.surface.tasks"),
        capabilityId: "task-trackers",
        order: 28,
        component: (props) => createElement(TaskTrackersPage, { ...props, host }),
        presentation: withSurfaceContent({
          kind: "workspace",
          // Opened from Chat (not the Tasks profile) the board is a companion:
          // chat keeps the larger share.
          defaultRatio: 0.45,
          minWidth: 380,
          minHeight: 320,
          preferredMaxWidth: 1400,
          keepAlive: true,
          escape: "close",
        }, "workspace"),
      }),
      // The Tasks tab is the board itself over the whole workspace, as Canvas
      // replaces Chat. It is opt-in per project from the header's workspace
      // tools menu (or project settings), like Canvas.
      host.workbench.profiles.register({
        id: "tasks",
        label: tt("tasktrackers.surface.tasks"),
        description: tt("tasktrackers.surface.workspaceDescription"),
        order: 13,
        defaultLayout: {
          surfaces: [
            { surface: "session", region: "primary", active: true },
            { surface: "task-trackers", region: "end", active: true },
          ],
        },
        presentation: {
          text: "prose",
          navigation: "primary",
          optional: true,
          homeSurface: "task-trackers",
        },
      }),
      host.capabilities.register({
        id: "task-trackers",
        label: tt("tasktrackers.surface.tasks"),
        plainDescription: tt("tasktrackers.surface.description"),
        keywords: ["jira", "trello", "linear", "tasks", "issues", "kanban", "board", "assignee"],
        standardTier: "more",
        standardRank: 18,
        defaultRails: { engineering: "right", operations: "right" },
        // The launcher opens the board as a window beside Chat; the Tasks
        // tab is the full-workspace view.
        open: () => host.navigation.openWorkspacePane("task-trackers"),
        available: () => true,
      }),
      host.settings.registerPage({
        id: "task-trackers",
        label: tt("tasktrackers.surface.settingsLabel"),
        group: "Engineering",
        icon: "tasks",
        order: 40,
        component: TaskTrackerSettingsPage,
      }),
      host.settings.registerItems([
        { id: "task-trackers.connect-jira", pageId: "task-trackers", label: tt("tasktrackers.surface.connectJira"), description: tt("tasktrackers.surface.connectJiraDescription"), keywords: ["jira", "atlassian", "token"], focusTarget: "task-trackers-jira" },
        { id: "task-trackers.connect-trello", pageId: "task-trackers", label: tt("tasktrackers.surface.connectTrello"), description: tt("tasktrackers.surface.connectTrelloDescription"), keywords: ["trello", "authorize"], focusTarget: "task-trackers-trello" },
        { id: "task-trackers.connect-linear", pageId: "task-trackers", label: tt("tasktrackers.surface.connectLinear"), description: tt("tasktrackers.surface.connectLinearDescription"), keywords: ["linear", "api key", "issues"], focusTarget: "task-trackers-linear" },
        { id: "task-trackers.widgets", pageId: "task-trackers", label: tt("tasktrackers.surface.widgets"), description: tt("tasktrackers.surface.widgetsDescription"), keywords: ["widgets", "overview", "linked task"], focusTarget: "task-trackers-widgets" },
      ]),
      host.projectContext.register({
        id: "task-trackers.seed",
        order: 50,
        getSnapshot: () => ({
          title: tt("tasktrackers.surface.projectTitle"),
          recommendedWidgetIds: ["task-trackers.board"],
        }),
      }),
    ];
    return () => off.toReversed().forEach((dispose) => dispose());
  };
});
