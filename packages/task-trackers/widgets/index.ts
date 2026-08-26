import type { WidgetContributionDescriptor } from "@polyth/contracts";

/**
 * Phase 2 can bind these descriptors to allowlisted React renderers without
 * changing the server package or adding feature code to App.tsx.
 */
export const TASK_TRACKER_WIDGETS: readonly WidgetContributionDescriptor[] = [
  {
    id: "task-trackers.board",
    module: "task-trackers.board",
    title: "Task board",
    description: "Project-scoped Jira and Trello boards with agent handoff controls.",
    kind: "widget",
    defaultSlot: "workspace.main",
    supportedSlots: [
      "workspace.left",
      "workspace.main",
      "workspace.right",
      "workspace.bottom",
    ],
    category: "Task trackers",
    capabilities: ["polyth.taskTrackers", "jira", "trello", "kanban"],
    defaultSize: { w: 8, h: 7 },
    minSize: { w: 4, h: 4 },
    maxSize: { w: 12, h: 12 },
    audience: "standard",
    scope: "workspace",
    resizable: true,
    recommended: true,
    defaultVisible: false,
  },
  {
    id: "task-trackers.linked-task",
    module: "task-trackers.linked-task",
    title: "Linked task",
    description: "The task selected for this coding-agent session and its current status.",
    kind: "mini-widget",
    defaultSlot: "session.composer.before",
    supportedSlots: [
      "session.composer.before",
      "workspace.header",
      "workspace.left",
      "workspace.right",
    ],
    category: "Task trackers",
    capabilities: ["polyth.taskTrackers", "agent handoff"],
    defaultSize: { w: 5, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 8, h: 5 },
    audience: "standard",
    scope: "plugin",
    resizable: true,
    recommended: true,
    defaultVisible: false,
  },
];
