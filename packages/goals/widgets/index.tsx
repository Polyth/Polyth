import "./styles.css";
import { createElement, useState } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { GoalAttachForm } from "./GoalStrip.tsx";
import GoalsView from "./GoalsView.tsx";
import { IconButton, TargetIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
      label={sessionId ? tr("goals.action.attachSessionGoal") : on ? tr("goals.action.disableGoalMode") : tr("goals.action.useFirstMessageAsGoal")}
      pressed={!sessionId ? on : undefined}
      onClick={() => suppliedToggle ? suppliedToggle() : setOpen(true)}
    />
    {open && <GoalAttachForm onDone={() => setOpen(false)} />}
  </>;
}

export default defineWebPackage((host) => () => {
  const renderGoal = (context: WidgetRenderContext) => createElement(GoalAction, { context });
  const off = [
    host.surfaces.register({ id: "goals", title: tr("goalsview.sessionGoals"), description: tr("goalsview.attachAnObjectiveAndLetTheAuditor"), capabilityId: "goals", order: 20, component: () => createElement(GoalsView), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "goals", label: tr("goals.capability.label"), plainDescription: tr("goals.capability.description"), keywords: ["goals", "progress", "status"], standardTier: "primary", standardRank: 3, defaultRails: { wellbeing: "top", finance: "right" }, open: () => host.navigation.openWorkspacePane("goals"), available: () => true }),
    host.widgets.registerPlugin({
      id: "goals",
      name: tr("goals.plugin.name"),
      widgets: [{
        id: "session.goal-action",
        title: tr("goalstrip.goal"),
        description: tr("goals.widget.description"),
        kind: "mini-widget",
        defaultSlot: "session.header.actions",
        supportedSlots: ["session.header.actions"],
        defaultVisible: true,
        order: 30,
        render: renderGoal,
      }, {
        id: "session.goal-composer-action",
        title: tr("goalstrip.goal"),
        description: tr("goals.widget.description"),
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        // Acts on the agent's turn: hidden where the composer writes only to people.
        agentOnly: true,
        supportedSlots: ["composer.leading", "composer.trailing"],
        defaultVisible: true,
        order: 30,
        render: renderGoal,
      }],
    }),
    ...(host.composer
      ? [
          // Composer Add-menu item: open the package-owned attach form.
          host.composer.registerAddMenuItem({
            id: "goals.attach",
            label: () => host.ui.locale.translate("goalsattach.menuLabel"),
            icon: () => host.ui.icons.target?.() ?? null,
            order: 20,
            isAvailable: (context) => context.sessionId !== null,
            activate: (context) => {
              context.openDialog((close) => <GoalAttachForm onDone={close} />);
            },
          }),
        ]
      : []),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
