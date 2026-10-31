import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import DockerView from "./DockerView.tsx";
import "./styles.css";
import { dockerText } from "../src/i18n/index.ts";

export default defineWebPackage((host) => () => {
  const tr = (key: Parameters<typeof dockerText>[1]) => dockerText(host, key);
  const off = [
    host.surfaces.register({ id: "docker", title: "Docker", description: tr("docker.surface.description"), icon: host.ui.icons.widgets, capabilityId: "docker", order: 42, component: (props) => createElement(DockerView, { ...props, host }), presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.55, minWidth: 320, minHeight: 240, preferredMaxWidth: 1000, keepAlive: false, escape: "close" }) }),
    host.capabilities.register({ id: "docker", label: "Docker", plainDescription: tr("docker.capability.plainDescription"), keywords: ["docker", "containers", "compose", "services", "ports", "images"], standardTier: "more", standardRank: 42, defaultRails: { operations: "right" }, open: () => { host.navigation.openWorkspacePane("docker"); }, available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
