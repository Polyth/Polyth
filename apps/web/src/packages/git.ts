import { createElement } from "react";
import { GitPage } from "../components/settings/pages.tsx";
import PendingChangesBar from "../components/PendingChangesBar.tsx";
import { defineWidgetPlugin, registerWidgetPlugin } from "../widgets/catalog.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

const GIT_SESSION_WIDGETS = defineWidgetPlugin({
  id: "git",
  name: "Git",
  widgets: [{
    id: "git.pending-changes",
    title: "Workspace files changed",
    description: "Show the active worktree’s changed-file and line totals above the composer.",
    kind: "mini-widget",
    defaultSlot: "session.footer",
    supportedSlots: ["session.footer"],
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 10,
    render: () => createElement(PendingChangesBar),
  }],
});

export function installGitPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "git",
      packageId: "git",
      label: "Git",
      group: "Engineering",
      icon: "⎇",
      order: 10,
      component: GitPage,
    }),
    registerWidgetPlugin(GIT_SESSION_WIDGETS),
  );
}
