import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import WorkflowView from "./WorkflowView.tsx";
export default defineWebPackage((host) => () => { const off = [host.workspaceSurfaces.register({ id: "workflow", title: "Workflows", order: 22, plugin: "workflow", requires: "project", component: () => createElement(WorkflowView) }), host.capabilities.register({ id: "workflow", label: "Workflows", technicalLabel: "DAG orchestration", plainDescription: "Coordinate agent roles in dependency-based pipelines.", keywords: ["workflow", "dag", "orchestration"], standardTier: "more", standardRank: 11, open: () => host.navigation.setActiveView("workflow"), available: () => true })]; return () => off.toReversed().forEach((dispose) => dispose()); });
