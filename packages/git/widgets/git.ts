import { createElement } from "react";
import { GitPage } from "../../../apps/web/src/components/settings/pages.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";
import { defineWidgetPlugin, registerWidgetPlugin } from "../../../apps/web/src/widgets/catalog.ts";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { GIT_TOUR } from "../../../apps/web/src/packages/onboarding/tours/git.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const GIT_SESSION_WIDGETS = defineWidgetPlugin({
  id: "git",
  name: "Git",
  widgets: [{
    id: "git.pending-changes",
    title: tr("packages.git.workspaceFilesChanged"),
    description: tr("packages.git.showTheActiveWorktreeSChangedFile"),
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
      label: tr("packages.git.git"),
      group: "Engineering",
      icon: "⎇",
      order: 10,
      component: GitPage,
    }),
    registerWidgetPlugin(GIT_SESSION_WIDGETS),
    registerPackageOnboarding(GIT_TOUR),
  );
}
