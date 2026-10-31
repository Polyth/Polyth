// Multi-run package web entry: its workspace surface and capability, plus the
// message quick actions that seed it from a prompt or an answer. The quick
// actions are ordinary `session.message.actions` contributions, so the host
// owns their placement and a disabled package registers none.
import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type MessageActionSlotMeta } from "@polyth/web-sdk";
import MultiRunView from "./MultiRunView.tsx";
import MultiRunMessageAction from "./MultiRunMessageAction.tsx";
import { CombineIcon } from "../../../apps/web/src/components/ui/index.ts";

export default defineWebPackage((host) => () => {
  const translate = (key: string) => host.ui.locale.translate(key);
  const messageActionLabel = (role: "user" | "assistant") =>
    role === "user" ? "multirun.action.user" : "multirun.action.assistant";
  const messageAction = (role: "user" | "assistant") => ({
    slot: "session.message.actions" as const,
    id: `multirun.message-${role}`,
    order: role === "user" ? 45 : 46,
    render: (context: Record<string, unknown>) => createElement(MultiRunMessageAction, {
      text: typeof context.messageText === "string" ? context.messageText : "",
      label: translate(messageActionLabel(role)),
      openPane: () => { host.navigation.openWorkspacePane("multirun"); },
      messageActionPlacement: context.messageActionPlacement,
      messageActionRequest: context.messageActionRequest,
    }),
    meta: {
      messageAction: {
        label: () => translate("multirun.action.menuLabel"),
        description: () => translate(role === "user" ? "multirun.action.descUser" : "multirun.action.descAssistant"),
        icon: CombineIcon,
        roles: [role],
        menu: true,
        // Was the built-in "multirun" action, off unless placed.
        defaultPlacement: "off",
        replaces: ["multirun"],
      } satisfies MessageActionSlotMeta,
    },
  });
  const off = [
    host.surfaces.register({ id: "multirun", title: translate("multirunview.surfaceTitle"), description: translate("multirunview.surfaceDescription"), capabilityId: "multirun", order: 21, component: () => createElement(MultiRunView), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" } }),
    host.capabilities.register({ id: "multirun", label: translate("multirunview.capabilityLabel"), plainDescription: translate("multirunview.capabilityDescription"), keywords: ["multirun"], standardTier: "more", standardRank: 10, defaultRails: { research: "right" }, open: () => host.navigation.openWorkspacePane("multirun"), available: () => true }),
    host.widgets.registerPlugin({ id: "multirun", name: translate("multirunview.surfaceTitle"), widgets: [{ id: "multirun.main", title: translate("multirunview.surfaceTitle"), description: translate("multirunview.capabilityDescription"), defaultSlot: "workspace.main", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 6 }, render: () => createElement(MultiRunView) }] }),
    host.slots.register(messageAction("user")),
    host.slots.register(messageAction("assistant")),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
