import { createElement, type ReactNode } from "react";
import { setOverlay } from "../../store.ts";
import { refreshProjects } from "../../init.ts";
import type { ProjectRegistryState } from "../../projectRegistry.ts";
import { buttonClassName } from "../ui/buttonClassName.ts";
import { tr } from "../../i18n/index.ts";

/** Project-registry-aware empty state. Loading and failure never masquerade as
 *  a successful empty project list. Keep-alive Git/Browser/Files surfaces use
 *  this same host copy instead of inventing "No project selected" while the
 *  registry is still loading or has failed. */
export default function ProjectEmptyState({ registry }: { registry: ProjectRegistryState }): ReactNode {
  if (registry.status === "loading") {
    return createElement(
      "div",
      { className: "stage" },
      createElement(
        "div",
        { className: "hero hero-project-loading" },
        createElement("div", { className: "hero-mark" }, "p"),
        createElement("h2", null, tr("workspace.workspacehost.loadingProjects")),
        createElement("p", { className: "hero-sub" }, tr("workspace.workspacehost.checkingSavedProjects")),
        createElement("button", {
          type: "button",
          className: buttonClassName({ variant: "primary", className: "hero-open-project" }),
          disabled: true,
        }, createElement("span", { className: "ui-btn-label" }, tr("workspace.workspacehost.chooseFolder"))),
      ),
    );
  }
  if (registry.status === "failed") {
    return createElement(
      "div",
      { className: "stage" },
      createElement(
        "div",
        { className: "hero hero-project-failed" },
        createElement("div", { className: "hero-mark" }, "p"),
        createElement("h2", null, tr("workspace.workspacehost.couldNotLoadProjects")),
        createElement("p", { className: "hero-sub" }, tr("workspace.workspacehost.projectListUnavailable")),
        createElement("button", {
          type: "button",
          className: buttonClassName({ variant: "primary", className: "hero-retry-projects" }),
          onClick: () => { void refreshProjects("manual"); },
        }, createElement("span", { className: "ui-btn-label" }, tr("common.retry"))),
        createElement("p", { className: "hero-status mono", role: "status" }, registry.error),
      ),
    );
  }
  return createElement(
    "div",
    { className: "stage" },
    createElement(
      "div",
      { className: "hero" },
      createElement("div", { className: "hero-mark" }, "p"),
      createElement("h2", null, tr("workspace.workspacehost.bringWorkIntoFocus")),
      createElement(
        "p",
        { className: "hero-sub" },
        tr("workspace.workspacehost.openLocalProject"),
      ),
      createElement("button", {
        type: "button",
        className: buttonClassName({ variant: "primary", className: "hero-open-project" }),
        onClick: () => setOverlay("project-picker"),
      }, createElement("span", { className: "ui-btn-label" }, tr("workspace.workspacehost.chooseFolder"))),
    ),
  );
}
