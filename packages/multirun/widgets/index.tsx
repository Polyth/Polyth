import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import MultiRunView from "./MultiRunView.tsx";
import { seedMultiRunPrompt } from "./multirunSeed.ts";

function MultiRunResponseAction({
  host,
  context,
}: {
  host: WebPackageHost;
  context: Record<string, unknown>;
}) {
  const actions = Array.isArray(context.responseActions) ? context.responseActions : [];
  const text = typeof context.messageText === "string" ? context.messageText : "";
  if (!actions.includes("multirun") || !text) return null;

  const IconButton = host.ui.components.IconButton;
  return createElement(IconButton, {
    icon: host.ui.icons.multirun,
    label: host.ui.locale.translate("timeline.startNewMultiRunFromThisAnswer"),
    size: "sm",
    variant: "ghost",
    className: "chat-action-button",
    onClick: () => {
      seedMultiRunPrompt(text);
      host.navigation.openWorkspacePane("multirun");
    },
  });
}

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "multirun",
      title: "Multi-run",
      description: "Ask several models in parallel, compare their responses, then choose what to continue.",
      capabilityId: "multirun",
      order: 21,
      component: () => createElement(MultiRunView),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.6,
        minWidth: 380,
        preferredMaxWidth: 760,
        keepAlive: true,
        escape: "close",
      },
    }),
    host.capabilities.register({
      id: "multirun",
      label: "Compare responses",
      plainDescription: "Ask several models and compare their responses.",
      keywords: ["multirun"],
      standardTier: "more",
      standardRank: 10,
      open: () => host.navigation.openWorkspacePane("multirun"),
      available: () => true,
    }),
    host.widgets.registerPlugin({
      id: "multirun",
      name: "Multi-run",
      widgets: [{
        id: "multirun.main",
        title: "Multi-run",
        description: "Ask several models and compare their responses.",
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main", "workspace.bottom"],
        defaultSize: { w: 12, h: 6 },
        render: () => createElement(MultiRunView),
      }],
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "multirun.response-action",
      order: 30,
      render: (context) => createElement(MultiRunResponseAction, { host, context }),
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
