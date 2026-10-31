import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import TerraformView from "./TerraformView.tsx";
import "./styles.css";
import { terraformText } from "../src/i18n/index.ts";

export default defineWebPackage((host) => () => {
  const tr = (key: Parameters<typeof terraformText>[1]) => terraformText(host, key);
  const off = [
    host.surfaces.register({ id: "terraform", title: "Terraform", description: tr("terraform.surface.description"), icon: host.ui.icons.workflow, capabilityId: "terraform", order: 43, component: (props) => createElement(TerraformView, { ...props, host }), presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.55, minWidth: 320, minHeight: 240, preferredMaxWidth: 1000, keepAlive: false, escape: "close" }) }),
    host.capabilities.register({ id: "terraform", label: "Terraform", plainDescription: tr("terraform.capability.plainDescription"), keywords: ["terraform", "infrastructure", "iac", "plan", "cloud", "deploy"], standardTier: "more", standardRank: 43, defaultRails: { operations: "right" }, open: () => { host.navigation.openWorkspacePane("terraform"); }, available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
