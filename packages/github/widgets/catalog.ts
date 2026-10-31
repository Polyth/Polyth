import type { WidgetContributionDescriptor } from "@polyth/contracts";

const PR_SUMMARY_SETTINGS = {
  type: "object",
  properties: {
    showFiles: { type: "boolean", title: "Changed files", default: true },
    showAdditions: { type: "boolean", title: "Added lines", default: true },
    showDeletions: { type: "boolean", title: "Removed lines", default: true },
  },
} as const;

export const GITHUB_WIDGETS: readonly WidgetContributionDescriptor[] = [
  {
    id: "github.pr-summary",
    module: "github.pr-summary",
    title: "Current pull request",
    description: "Changed files and added/removed lines for the current branch pull request.",
    kind: "widget",
    defaultSlot: "session.composer.before",
    supportedSlots: [
      "session.composer.before",
      "workspace.header",
      "workspace.left",
      "workspace.main",
      "workspace.right",
    ],
    category: "GitHub",
    capabilities: ["pull requests", "diff stats"],
    defaultSize: { w: 5, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 8, h: 6 },
    audience: "standard",
    scope: "plugin",
    resizable: true,
    recommended: true,
    defaultVisible: false,
    settingsSchema: PR_SUMMARY_SETTINGS,
  },
];
