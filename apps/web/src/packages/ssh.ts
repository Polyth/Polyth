import { createElement } from "react";
import { registerSlot } from "../slots.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import SshSettings from "../components/ssh/SshSettings.tsx";
import SshProjectSource from "../components/ssh/SshProjectSource.tsx";

export function installSshPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "ssh",
      packageId: "ssh",
      label: "SSH Remotes",
      group: "Engineering",
      icon: "🖧",
      order: 55,
      component: SshSettings,
      settingsItems: [
        {
          id: "ssh-servers",
          pageId: "ssh",
          label: "SSH servers",
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
  );
}
