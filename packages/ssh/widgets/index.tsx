import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import SshSettings from "./ssh/SshSettings.tsx";
import SshProjectSource from "./ssh/SshProjectSource.tsx";
export default defineWebPackage((host) => () => { const off = [host.settings.registerPage({ id: "ssh", packageId: "ssh", label: "SSH Remotes", group: "Engineering", icon: "🖧", order: 55, component: SshSettings }), host.slots.register({ slot: "project.create.options", id: "ssh-remote-project", order: 10, render: (props) => createElement(SshProjectSource, props) })]; return () => off.toReversed().forEach((dispose) => dispose()); });
