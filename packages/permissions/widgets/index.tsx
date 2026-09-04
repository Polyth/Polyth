import "./styles.css";
import { createElement, useState } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import PermissionBanner from "./PermissionBanner.tsx";
import { IconButton, ShieldIcon } from "../../../apps/web/src/components/ui/index.ts";
import { useActiveModel, useStore } from "../../../apps/web/src/store.ts";

/** Widget-areas (WA4): the pending-approval banner as a placeable widget, so
 * it can sit in the composer area (or anywhere) instead of only inline in the
 * timeline. Renders nothing when no approval is pending. */
function PendingPermissionsWidget({ context }: { context: WidgetRenderContext }) {
  const model = useActiveModel();
  const activeSessionId = useStore((state) => state.activeSessionId);
  const contextSessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  // Prefer the widget slot's session, then the active model session. Each
  // pending row still stamps its own origin from the event for replies.
  const sessionId = contextSessionId ?? activeSessionId ?? undefined;
  const pending = model.permissions.filter((request) => request.status === "pending");
  return createElement(PermissionBanner, { permissions: pending, sessionId });
}

function AutoApproveAction({ context }: { context: WidgetRenderContext }) {
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
  return createElement(IconButton, {
    className: `header-action composer-auto-approve${on ? " on" : ""}`,
    icon: ShieldIcon,
    size: "md",
    variant: "ghost",
    label: on ? "Turn off auto-approve" : "Turn on auto-approve",
    pressed: on,
    disabled: busy || context.autoApproveBusy === true,
    onClick: toggle,
  });
}

export default defineWebPackage((host) => () => {
  const renderAutoApprove = (context: WidgetRenderContext) => createElement(AutoApproveAction, { context });
  const off = [
    host.slots.register({
      slot: "session.timeline.after",
      id: "permissions.requests",
      order: 20,
      render: (context) => createElement(PermissionBanner, {
        permissions: Array.isArray(context.permissions) ? context.permissions : [],
        sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
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
      }, {
        id: "permissions.composer",
        title: "Pending approvals",
        description: "Show approval requests for the current session, wherever you place it.",
        kind: "widget",
        defaultSlot: "session.composer.before",
        supportedSlots: ["session.composer.before", "composer.leading", "session.footer", "workspace.main", "workspace.right", "workspace.bottom"],
        defaultVisible: false,
        recommended: true,
        order: 15,
        render: (context) => createElement(PendingPermissionsWidget, { context }),
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
