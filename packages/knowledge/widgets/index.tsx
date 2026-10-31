// Knowledge package web entry: the Knowledge and Tracks surfaces, plus the
// message quick action that saves an answer as a plan. The action is an
// ordinary `session.message.actions` contribution, so the host owns its
// placement and a disabled package registers none.
import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type MessageActionSlotMeta } from "@polyth/web-sdk";
import KnowledgePanel from "./KnowledgePanel.tsx";
import TracksPanel from "./TracksPanel.tsx";
import SaveAsPlanAction from "./SaveAsPlanAction.tsx";
import { TasksIcon } from "../../../apps/web/src/components/ui/index.ts";
import { knowledgeTour } from "./onboardingTour.ts";

export default defineWebPackage((host) => () => {
  const translate = (key: string) => host.ui.locale.translate(key);
  const presentation = { kind: "workspace" as const, defaultRatio: 0.6, minWidth: 320, preferredMaxWidth: 760, keepAlive: true as const, escape: "close" as const };
  const messageTime = (sessionId: unknown, eventSeq: unknown): number | undefined => {
    if (typeof sessionId !== "string" || typeof eventSeq !== "number") return undefined;
    return host.sessions.events(sessionId).find((event) => event.seq === eventSeq)?.time;
  };
  const off = [
    host.onboarding
      ? host.onboarding.registerTour(knowledgeTour(translate))
      : () => {},
    host.surfaces.register({ id: "knowledge", title: translate("knowledge.surface.title"), description: translate("knowledge.surface.description"), capabilityId: "knowledge", order: 40, component: KnowledgePanel, presentation }),
    host.surfaces.register({ id: "tracks", title: translate("packages.knowledge.tracks"), description: translate("tracks.surface.description"), capabilityId: "tracks", order: 41, component: () => createElement(TracksPanel), presentation }),
    host.capabilities.register({ id: "knowledge", label: translate("knowledge.surface.title"), plainDescription: translate("knowledge.capability.description"), keywords: ["knowledge", "notes", "docs"], standardTier: "more", standardRank: 17, defaultRails: { research: "right", wellbeing: "right" }, open: () => host.navigation.openWorkspacePane("knowledge"), available: () => true }),
    host.capabilities.register({ id: "tracks", label: translate("packages.knowledge.tracks"), technicalLabel: translate("tracks.capability.technicalLabel"), plainDescription: translate("tracks.surface.description"), keywords: ["track", "spec", "plan", "workflow"], standardTier: "more", standardRank: 18, defaultRails: {}, open: () => host.navigation.openWorkspacePane("tracks"), available: () => true }),
    host.slots.register({
      slot: "session.message.actions",
      id: "knowledge.save-as-plan",
      order: 47,
      render: (context) => createElement(SaveAsPlanAction, {
        text: typeof context.messageText === "string" ? context.messageText : "",
        projectId: typeof context.projectId === "string" ? context.projectId : null,
        sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
        time: messageTime(context.sessionId, context.eventSeq),
        locale: host.ui.locale.get(),
        label: translate("knowledge.action.saveAsPlan"),
        messageActionPlacement: context.messageActionPlacement,
        messageActionRequest: context.messageActionRequest,
      }),
      meta: {
        messageAction: {
          label: () => translate("knowledge.action.menuLabel"),
          description: () => translate("knowledge.action.desc"),
          icon: TasksIcon,
          roles: ["assistant"],
          menu: true,
          // Was the built-in "plan" action, off unless placed.
          defaultPlacement: "off",
          replaces: ["plan"],
          available: (context) => typeof context.projectId === "string",
        } satisfies MessageActionSlotMeta,
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
