import "./styles.css";
import "./proposal.css";
import { createElement } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { openSession } from "../../../apps/web/src/init.ts";
import { createCoachApi } from "./api.ts";
import CoachView, {
  CheckInWidget,
  CommitmentsWidget,
  GoalWidget,
  NextActionWidget,
  TodayWidget,
} from "./CoachView.tsx";
import CoachSettingsPage from "./CoachSettingsPage.tsx";
import InsightCard from "./InsightCard.tsx";
import ProposalCard from "./ProposalCard.tsx";
import { createCoachClient } from "./store.ts";

export default defineWebPackage((host) => () => {
  const api = createCoachApi();
  const errorText = host.errors.friendly;
  const client = createCoachClient({
    api,
    openSession,
    friendlyError: errorText,
  });

  const onFocus = () => { void client.refresh(); };
  window.addEventListener("focus", onFocus);

  const off = [
    host.surfaces.register({
      id: "personal-coach",
      title: "Personal Coach",
      description: "Focus, commitments, and progress that persist across chats.",
      capabilityId: "personal-coach",
      order: 34,
      component: () => createElement(CoachView, { client }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.4,
        minWidth: 320,
        minHeight: 280,
        preferredMaxWidth: 620,
        keepAlive: true,
        escape: "close",
        dock: "side",
      },
    }),
    host.capabilities.register({
      id: "personal-coach",
      label: "Coach",
      plainDescription: "Keep durable goals and commitments, then focus on what matters now.",
      keywords: ["coach", "goals", "commitments", "today", "focus"],
      standardTier: "primary",
      standardRank: 16,
      open: () => host.navigation.openWorkspacePane("personal-coach"),
      available: () => true,
    }),
    host.settings.registerPage({
      id: "personal-coach",
      packageId: "personal-coach",
      label: "Personal Coach",
      group: "Workspace",
      icon: "◎",
      order: 34,
      component: () => createElement(CoachSettingsPage, { api, client, friendlyError: errorText }),
      settingsItems: [
        {
          id: "personal-coach-behavior",
          pageId: "personal-coach",
          label: "Coach behavior",
          description: "Style, initiative, assumption challenges, and time zone.",
          keywords: ["coach", "tone", "initiative", "timezone", "style"],
          focusTarget: "personal-coach-behavior",
        },
        {
          id: "personal-coach-reminders",
          pageId: "personal-coach",
          label: "Scheduled check-ins",
          description: "Daily check-in and weekly review schedule.",
          keywords: ["coach", "reminder", "daily", "weekly", "review", "schedule"],
          focusTarget: "personal-coach-reminders",
        },
        {
          id: "personal-coach-data",
          pageId: "personal-coach",
          label: "Reset Coach state",
          description: "Clear durable goals, plans, check-ins, reflections, and insights.",
          keywords: ["coach", "reset", "data", "forget", "clear", "privacy"],
          focusTarget: "personal-coach-data",
        },
      ],
    }),
    host.widgets.registerPlugin({
      id: "personal-coach",
      name: "Personal Coach",
      widgets: [
        {
          id: "personal-coach.today",
          title: "Today",
          description: "Your main focus and the next useful action.",
          defaultSlot: "workspace.main",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 6, h: 3 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          recommended: true,
          defaultVisible: false,
          render: () => createElement(TodayWidget, { client }),
        },
        {
          id: "personal-coach.next-action",
          title: "Next Action",
          description: "One useful thing to do next.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 3, h: 2 },
          minSize: { w: 2, h: 2 },
          scope: "global",
          recommended: true,
          defaultVisible: false,
          render: () => createElement(NextActionWidget, { client }),
        },
        {
          id: "personal-coach.commitments",
          title: "Commitments",
          description: "Today’s concrete promises, kept deliberately small.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 5, h: 4 },
          minSize: { w: 3, h: 3 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(CommitmentsWidget, { client }),
        },
        {
          id: "personal-coach.goal",
          title: "Goal",
          description: "The highest-priority active goal without synthetic progress scores.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 4, h: 2 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(GoalWidget, { client }),
        },
        {
          id: "personal-coach.check-in",
          title: "Check-in",
          description: "A lightweight energy and focus check-in with no model call.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 4, h: 3 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(CheckInWidget, { client }),
        },
      ],
    }),
    host.slots.register({
      id: "personal-coach.proposal-card",
      slot: "session.timeline.event",
      order: 30,
      meta: { eventTypes: ["coach/proposal-created"] },
      render: (props) => createElement(ProposalCard, {
        event: props.event as SessionEvent,
        api,
        client,
        friendlyError: errorText,
      }),
    }),
    host.slots.register({
      id: "personal-coach.insight-card",
      slot: "session.timeline.event",
      order: 31,
      meta: { eventTypes: ["coach/insight-created"] },
      render: (props) => createElement(InsightCard, {
        event: props.event as SessionEvent,
        api,
        client,
        friendlyError: errorText,
      }),
    }),
  ];

  return () => {
    window.removeEventListener("focus", onFocus);
    off.toReversed().forEach((dispose) => dispose());
  };
});
