import "./styles.css";
import { createElement, useState } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { GoalAttachForm } from "./GoalStrip.tsx";
import GoalsView from "./GoalsView.tsx";
import { IconButton, TargetIcon } from "../../../apps/web/src/components/ui/index.ts";

function GoalAction({ context }: { context: WidgetRenderContext }) {
  const [open, setOpen] = useState(false);
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const suppliedToggle = typeof context.toggleGoal === "function"
    ? context.toggleGoal as () => void
    : null;
  const on = context.goalOn === true;
  return <>
    <IconButton
      className={`header-action composer-goals${on ? " on" : ""}`}
      icon={TargetIcon}
      size="md"
      variant="ghost"
      label={sessionId ? "Attach session goal" : on ? "Disable goal mode" : "Use first message as goal"}
      pressed={!sessionId ? on : undefined}
      onClick={() => suppliedToggle ? suppliedToggle() : setOpen(true)}
    />
    {open && <GoalAttachForm onDone={() => setOpen(false)} />}
  </>;
}

export default defineWebPackage((host) => () => {
  const renderGoal = (context: WidgetRenderContext) => createElement(GoalAction, { context });
  const off = [
    host.surfaces.register({ id: "goals", title: "Session goals", description: "Attach an objective and let the auditor drive continuations to completion.", capabilityId: "goals", order: 20, component: () => createElement(GoalsView), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "goals", label: "Goals & progress", plainDescription: "Track goals and work progress.", keywords: ["goals", "progress", "status"], standardTier: "primary", standardRank: 3, open: () => host.navigation.openWorkspacePane("goals"), available: () => true }),
    host.widgets.registerPlugin({
      id: "goals",
      name: "Goals",
      widgets: [{
        id: "session.goal-action",
        title: "Goal",
        description: "Attach a goal or use the first message as the goal.",
        kind: "mini-widget",
        defaultSlot: "session.header.actions",
        supportedSlots: ["session.header.actions"],
        defaultVisible: true,
        order: 30,
        render: renderGoal,
      }, {
        id: "session.goal-composer-action",
        title: "Goal",
        description: "Attach a goal or use the first message as the goal.",
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        supportedSlots: ["composer.leading", "composer.trailing"],
        defaultVisible: true,
        order: 30,
        render: renderGoal,
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
