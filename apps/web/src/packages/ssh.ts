import { createElement } from "react";
import { registerSlot } from "../slots.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { SSH_TOUR } from "./onboarding/tours/installed.ts";
import SshSettings from "../components/ssh/SshSettings.tsx";
import SshProjectSource from "../components/ssh/SshProjectSource.tsx";
import { tr } from "../i18n/index.ts";

export function installSshPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "ssh",
      packageId: "ssh",
      label: tr("packages.ssh.sshRemotes"),
      group: "Engineering",
      icon: "🖧",
      order: 55,
      component: SshSettings,
      settingsItems: [
        {
          id: "ssh-servers",
          pageId: "ssh",
          label: tr("packages.ssh.sshServers"),
          keywords: ["ssh", "remote", "server", "connection", "host"],
          focusTarget: "ssh-servers",
        },
      ],
    }),
    registerSlot(
      "project.create.options",
      "ssh-remote-project",
      (props) => createElement(SshProjectSource, props),
      10,
    ),
    registerPackageOnboarding(SSH_TOUR),
  );
}
