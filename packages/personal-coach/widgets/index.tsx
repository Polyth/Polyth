import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, friendlyError } from "@polyth/web-sdk";
import { openSession } from "../../../apps/web/src/init.ts";
import { createCoachApi } from "./api.ts";
import CoachView, {
  CheckInWidget,
  CommitmentsWidget,
  GoalWidget,
  NextActionWidget,
  TodayWidget,
} from "./CoachView.tsx";
import { createCoachClient } from "./store.ts";

export default defineWebPackage((host) => () => {
  const client = createCoachClient({
    api: createCoachApi(),
    openSession,
    friendlyError,
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
  ];

  return () => {
    window.removeEventListener("focus", onFocus);
    off.toReversed().forEach((dispose) => dispose());
  };
});
