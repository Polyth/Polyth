import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import SshSettings from "./ssh/SshSettings.tsx";
import SshProjectSource from "./ssh/SshProjectSource.tsx";
import { sshTour } from "./onboardingTour.ts";
export default defineWebPackage((host) => () => { const off = [host.onboarding ? host.onboarding.registerTour(sshTour(host.ui.locale.translate)) : () => {}, host.settings.registerPage({ id: "ssh", packageId: "ssh", label: host.ui.locale.translate("ssh.sshsettings.settingsPageLabel"), group: "Engineering", icon: "server", order: 55, component: SshSettings }), host.slots.register({ slot: "project.create.options", id: "ssh-remote-project", order: 10, render: (props) => createElement(SshProjectSource, props) })]; return () => off.toReversed().forEach((dispose) => dispose()); });
