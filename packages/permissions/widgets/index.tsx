import "./styles.css";
import { createElement, useState, type ComponentType } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import PermissionBanner from "./PermissionBanner.tsx";

function AutoApproveAction({
  context,
  ShieldIcon,
}: {
  context: WidgetRenderContext;
  ShieldIcon: ComponentType;
}) {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const [busy, setBusy] = useState(false);
  const suppliedToggle = typeof context.toggleAutoApprove === "function"
    ? context.toggleAutoApprove as () => void
    : null;
  const on = context.autoApproveOn === true;
  const toggle = () => {
    if (suppliedToggle) return suppliedToggle();
    if (!sessionId || busy) return;
    setBusy(true);
    void api.autoAcceptSet(sessionId, on ? "off" : "on").finally(() => setBusy(false));
  };
  return <button
    type="button"
    className={`header-action composer-auto-approve${on ? " on" : ""}`}
    aria-label={on ? "Turn off auto-approve" : "Turn on auto-approve"}
    aria-pressed={on}
    disabled={busy || context.autoApproveBusy === true}
    onClick={toggle}
  >
    <ShieldIcon /><span>Auto-approve</span>
  </button>;
}

export default defineWebPackage((host) => () => {
  const renderAutoApprove = (context: WidgetRenderContext) => createElement(AutoApproveAction, {
    context,
    ShieldIcon: host.ui.icons.shield ?? (() => null),
  });
  const off = [
    host.slots.register({
      slot: "session.timeline.after",
      id: "permissions.requests",
      order: 20,
      render: (context) => createElement(PermissionBanner, {
        permissions: Array.isArray(context.permissions) ? context.permissions : [],
      }),
    }),
    host.widgets.registerPlugin({
      id: "permissions",
      name: "Permissions",
      widgets: [{
        id: "permissions.auto-approve-action",
        title: "Auto-approve",
        description: "Toggle automatic approval for the current session.",
        kind: "mini-widget",
        defaultSlot: "session.header.actions",
        supportedSlots: ["session.header.actions"],
        defaultVisible: true,
        order: 40,
        render: renderAutoApprove,
      }, {
        id: "permissions.auto-approve-composer-action",
        title: "Auto-approve",
        description: "Toggle automatic approval for the current session.",
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        supportedSlots: ["composer.leading", "composer.trailing"],
        defaultVisible: true,
        order: 40,
        render: renderAutoApprove,
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
