// EXTENSION-SEAMS slice 3: trusted "workspace.main.tabs" slot contributions
// resolve to provider-backed pane resources — the ONLY bridge from slot items
// to tabs inside the canonical Files surface. Server-managed module metadata
// stays inert: nothing here loads remote JavaScript; only same-bundle
// registrations (registerSlot) can contribute renderers.
import { createElement, type ReactNode } from "react";
import { listSlots } from "../slots.ts";
import { registerPaneProvider, type PaneResourceContext } from "./paneProviders.ts";
import { tr } from "../i18n/index.ts";

const SLOT = "workspace.main.tabs";

function itemOf(resource: string) {
  return listSlots(SLOT).find((item) => item.id === resource);
}

function PluginPaneBody(ctx: PaneResourceContext): ReactNode {
  const item = itemOf(ctx.resource);
  if (!item) {
    return createElement(
      "div",
      { className: "editor-empty" },
      createElement("p", { className: "muted" }, tr("workspace.mainslotpanes.pluginNoLongerActive")),
    );
  }
  // Bounded context only: canonical ids + visibility. No filesystem authority,
  // credentials, or arbitrary cwd ever crosses this seam.
  return item.render({
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    resource: ctx.resource,
    visible: ctx.visible,
  }) as ReactNode;
}

/** Idempotent: importing this module registers the bridge once. */
export function installMainSlotPaneProvider(): () => void {
  return registerPaneProvider({
    kind: "plugin",
    title: (resource) => {
      const item = itemOf(resource);
      const title = item?.meta?.title;
      return typeof title === "string" && title ? title : resource;
    },
    available: (resource) => itemOf(resource) !== undefined,
    component: PluginPaneBody,
  });
}

installMainSlotPaneProvider();
