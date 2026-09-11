import "./styles.css";
import "./proposal.css";
import "./workspace.css";
import { createElement } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { createCoachApi } from "./api.ts";
import { createCoachJourneyApi } from "./journeyApi.ts";
import CoachNavItem from "./CoachNavItem.tsx";
import CoachWorkspace from "./CoachWorkspace.tsx";
import {
  AttentionWidget,
  CheckInWidget,
  GoalWidget,
  NextActionWidget,
  TodayWidget,
} from "./CoachView.tsx";
import CoachSettingsPage from "./CoachSettingsPage.tsx";
import InsightCard from "./InsightCard.tsx";
import ProposalCard from "./ProposalCard.tsx";
import { createCoachClient } from "./store.ts";
import { t } from "./strings.ts";

export default defineWebPackage((host) => () => {
  const api = createCoachJourneyApi(createCoachApi());
  const errorText = host.errors.friendly;
  const ui = host.ui.components;
  const client = createCoachClient({
    api,
    openSession: host.conversation.openSession,
    friendlyError: errorText,
    navigationToken: () => {
      const state = host.store.getSnapshot();
      return JSON.stringify([state.activeProjectId, state.activeSessionId, state.activeView, state.overlay, state.railPlugin]);
    },
  });

  // Refresh follows normal client lifecycle — focus and opening the surface.
  // There is no Coach poller and no visible Refresh button.
  const onFocus = () => { if (document.visibilityState !== "hidden") void client.refresh(); };
  window.addEventListener("focus", onFocus);
  const isOpen = () => {
    const state = host.store.getSnapshot();
    return state.railPlugin === "personal-coach" || state.activeView === "personal-coach";
  };
  let wasOpen = isOpen();
  const stopNavigation = host.store.subscribe(() => {
    const open = isOpen();
    if (open && !wasOpen) void client.refresh();
    wasOpen = open;
  });

  const openCoach = () => {
    void client.refresh();
    host.navigation.openWorkspacePane("personal-coach");
  };

  const coachProps = {
    api, client, ui,
    friendlyError: errorText,
    openSettings: () => host.navigation.openSettingsPage("personal-coach"),
  };

  const off = [
    host.surfaces.register({
      id: "personal-coach",
      title: t("coach.workspace.title"),
      description: "Decide, commit, act and review — durable across chats.",
      capabilityId: "personal-coach",
      order: 34,
      component: () => createElement(CoachWorkspace, coachProps),
      presentation: {
        kind: "workspace",
        // Coach is the surface the user works in, with the conversation as its
        // companion rather than the other way round: it takes the majority of
        // the workspace on a wide screen and the host keeps Chat above its
        // floor. Below `minWidth` the host promotes it to full screen, which is
        // what a phone and a narrow window get.
        defaultRatio: 0.62,
        minWidth: 380,
        minHeight: 320,
        preferredMaxWidth: 1280,
        keepAlive: true,
        escape: "close",
        dock: "side",
      },
    }),
    // Coach lives in the same primary navigation as the user's workspaces, so
    // it is never something to hunt for under Settings → Packages. The existing
    // `app.nav` seam carries it; no navigation rewrite and no fake Git project.
    host.slots.register({
      id: "personal-coach.nav",
      slot: "app.nav",
      order: 0,
      render: (props) => createElement(CoachNavItem, {
        client,
        expanded: props.expanded !== false,
        onOpen: openCoach,
        isActive: () => host.store.getSnapshot().railPlugin === "personal-coach",
        subscribe: host.store.subscribe,
      }),
    }),
    host.capabilities.register({
      id: "personal-coach",
      label: t("coach.workspace.title"),
      plainDescription: "Keep durable goals and commitments, then focus on what matters now.",
      keywords: ["coach", "goals", "commitments", "today", "focus", "routines", "review"],
      standardTier: "primary",
      standardRank: 16,
      open: openCoach,
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
          description: "Clear durable goals, routines, check-ins, reflections, and insights.",
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
          title: t("coach.tab.today"),
          description: "Today's focus and one deterministic action.",
          defaultSlot: "workspace.main",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 6, h: 3 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          recommended: true,
          defaultVisible: false,
          render: () => createElement(TodayWidget, { client, ui }),
        },
        {
          id: "personal-coach.next-action",
          title: t("coach.upcoming.title"),
          description: "What is queued after today.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 3, h: 2 },
          minSize: { w: 2, h: 2 },
          scope: "global",
          recommended: true,
          defaultVisible: false,
          render: () => createElement(NextActionWidget, { client, ui }),
        },
        {
          id: "personal-coach.attention",
          title: t("coach.attention.title"),
          description: "Overdue work and suggestions waiting for review.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 3, h: 2 },
          minSize: { w: 2, h: 2 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(AttentionWidget, { client, ui }),
        },
        {
          id: "personal-coach.goal",
          title: t("coach.goals.title"),
          description: "The primary goal, without synthetic progress scores.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 4, h: 2 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(GoalWidget, { client, ui }),
        },
        {
          id: "personal-coach.check-in",
          title: t("coach.checkin.title"),
          description: "A lightweight energy and focus check-in with no model call.",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          defaultSize: { w: 4, h: 3 },
          minSize: { w: 3, h: 2 },
          scope: "global",
          defaultVisible: false,
          render: () => createElement(CheckInWidget, { client, ui }),
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
        api, client, ui,
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
        api, client, ui,
        friendlyError: errorText,
      }),
    }),
  ];

  return () => {
    client.dispose();
    stopNavigation();
    window.removeEventListener("focus", onFocus);
    off.toReversed().forEach((dispose) => dispose());
  };
});
