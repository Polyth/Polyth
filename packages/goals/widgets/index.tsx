import "./styles.css";
import { createElement, useState, type ComponentType } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { GoalAttachForm } from "./GoalStrip.tsx";
import GoalsView from "./GoalsView.tsx";

function GoalAction({
  context,
  TargetIcon,
}: {
  context: WidgetRenderContext;
  TargetIcon: ComponentType;
}) {
  const [open, setOpen] = useState(false);
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const suppliedToggle = typeof context.toggleGoal === "function"
    ? context.toggleGoal as () => void
    : null;
  const on = context.goalOn === true;
  return <>
    <button
      type="button"
      className={`header-action composer-goals${on ? " on" : ""}`}
      aria-label={sessionId ? "Attach session goal" : on ? "Disable goal mode" : "Use first message as goal"}
      aria-pressed={!sessionId ? on : undefined}
      onClick={() => suppliedToggle ? suppliedToggle() : setOpen(true)}
    >
      <TargetIcon /><span>Goal</span>
    </button>
    {open && <GoalAttachForm onDone={() => setOpen(false)} />}
  </>;
}

export default defineWebPackage((host) => () => {
  const renderGoal = (context: WidgetRenderContext) => createElement(GoalAction, {
    context,
    TargetIcon: host.ui.icons.target ?? (() => null),
  });
  const off = [
    host.workspaceSurfaces.register({ id: "goals", title: "Goals", order: 20, plugin: "goals", requires: "project", component: () => createElement(GoalsView) }),
    host.capabilities.register({ id: "goals", label: "Goals & progress", plainDescription: "Track goals and work progress.", keywords: ["goals", "progress", "status"], standardTier: "primary", standardRank: 3, open: () => host.navigation.setActiveView("goals"), available: () => true }),
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
