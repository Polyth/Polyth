import "./styles.css";
import { createElement, Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import { defineWebPackage, type WidgetRenderContext } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import PermissionBanner, { type PermissionNotesSlot } from "./PermissionBanner.tsx";
import PermissionsSettingsPage from "./PermissionsSettingsPage.tsx";
import ProjectApprovals from "./ProjectApprovals.tsx";
import { confirmFullAccess } from "./fullAccess.ts";
import { defaultApprovalLevel, useApprovalDefaults, type ApprovalLevel } from "./approvalDefaults.ts";
import { APPROVAL_LEVEL_OPTIONS, approvalLevelTitle, moveRadioFocus } from "./levels.tsx";
import { IconButton, Popover, UndoIcon } from "../../../apps/web/src/components/ui/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { dismissKeyboard, getViewportMetrics } from "../../../apps/web/src/mobileViewport.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { setUiError, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { guardedAutoApproveAllowed, useGuardrails } from "../../../apps/web/src/guardrails.ts";

/** Widget-areas (WA4): the pending-approval banner as a placeable widget, so
 * it can sit in the composer area (or anywhere) instead of only inline in the
 * timeline. Renders nothing when no approval is pending. */
function PendingPermissionsWidget({ Slot }: { Slot?: PermissionNotesSlot }) {
  const model = useActiveModel();
  const pending = model.permissions.filter((request) => request.status === "pending");
  return createElement(PermissionBanner, { permissions: pending, Slot });
}

type ApprovalSetting = "off" | "on" | "all" | "inherit";

const LEVELS = APPROVAL_LEVEL_OPTIONS;

/** The control shows the current level; a click (or tap) opens a tiny
 * icon-only segmented switch that jumps straight to any level. Names and
 * meanings live in tooltips/aria labels, so the switch never resizes while
 * switching. A chat with a level of its own also gets "Use default", which
 * hands it back to its parent chat or its project's approval default. Full
 * access always asks for confirmation first. */
export function AutoApproveAction({ context, side = "up" }: { context: WidgetRenderContext; side?: "up" | "down" }) {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  // The composer supplies its draft-aware state; other placements (the
  // session header) read the canonical session projection.
  const session = useStore((state) => sessionId ? state.sessions.find((row) => row.id === sessionId) : undefined);
  const [pending, setPending] = useState(false);
  // Protected mode: Auto-Approve is refused server-side, so offer no toggle.
  const autoApproveAllowed = guardedAutoApproveAllowed(useGuardrails());
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const phone = useShellMode() === "phone";
  const openRequestRef = useRef(0);
  useEffect(() => () => { openRequestRef.current += 1; }, []);
  // No session yet: the composer holds the choice and applies it on create.
  const setDraft = typeof context.setDraftAutoApprove === "function"
    ? context.setDraftAutoApprove as (setting: ApprovalSetting) => void
    : null;
  // A chat that does not exist yet follows its project's approval default
  // (else the Space's) until a level is picked for it; so does a root chat
  // without a level of its own.
  const projectId = session?.projectId ?? (typeof context.projectId === "string" ? context.projectId : null);
  const defaults = useApprovalDefaults(!sessionId || (session !== undefined && !session.parentId));
  const defaultLevel = defaultApprovalLevel(defaults, projectId);
  const fallback = sessionId ? session?.autoAccept === true : defaultLevel !== "off";
  const fallbackAll = sessionId ? session?.autoAcceptAll === true : defaultLevel === "all";
  const on = typeof context.autoApproveOn === "boolean" ? context.autoApproveOn : fallback;
  const all = typeof context.autoApproveAll === "boolean" ? context.autoApproveAll : fallbackAll;
  const level: ApprovalLevel = !on ? "off" : all ? "all" : "routine";
  // A draft holds a picked level in the composer; a session in its projection.
  const ownLevel = sessionId ? session?.autoAcceptSetting !== undefined : typeof context.autoApproveOn === "boolean";
  // A subagent hands back to its parent chat, whose level is not known here.
  const followsParent = Boolean(session?.parentId);
  const set = (setting: ApprovalSetting) => {
    if (pending || (!sessionId && !setDraft)) return;
    setPending(true);
    void (async () => {
      // "inherit" can raise a chat to its default, so it asks first exactly
      // when that default is Full access (the server's answer, not a guess).
      const resulting: ApprovalLevel | undefined = setting === "inherit"
        ? sessionId ? (await api.autoAcceptGet(sessionId)).inherited : defaultLevel
        : setting === "all" ? "all" : undefined;
      if (resulting === "all" && !(await confirmFullAccess())) return;
      if (sessionId) await api.autoAcceptSet(sessionId, setting);
      else setDraft?.(setting);
    })()
      .catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)))
      .finally(() => setPending(false));
  };
  if (!autoApproveAllowed) return null;
  const close = () => {
    openRequestRef.current += 1;
    setOpen(false);
  };
  // Same contract as the composer Picker: a phone never anchors the switch
  // under a keyboard that is about to close. Close the keyboard first and open
  // once the viewport has settled — unless the composer holds the keyboard for
  // this tap: then dismissKeyboard() and the initial focus both yield and the
  // switch opens above its button in the keyboard-open band
  // (useAnchoredPosition converts the anchor for Safari's pan).
  const openPicker = () => {
    if (pending) return;
    const request = ++openRequestRef.current;
    const reveal = () => {
      if (request === openRequestRef.current) setOpen(true);
    };
    if (!phone) {
      reveal();
      return;
    }
    const viewport = getViewportMetrics();
    const keyboardWasOpen = viewport.covering || viewport.keyboardInset > 0;
    const dismissal = dismissKeyboard();
    if (keyboardWasOpen) void dismissal.then(reveal);
    else reveal();
  };
  const choose = (index: number) => {
    const entry = LEVELS[index]!;
    close();
    if (entry.level !== level) set(entry.setting);
  };
  const followDefault = () => {
    close();
    set("inherit");
  };
  const current = LEVELS.find((entry) => entry.level === level)!;
  const currentIndex = LEVELS.indexOf(current);
  const label = `${tr("permissionbanner.approvalLevel")}: ${tr(current.title)}`;
  const origin = tr(ownLevel ? "permissionbanner.levelOwn"
    : followsParent ? "permissionbanner.levelFollowsParent" : "permissionbanner.levelFollowsDefault");
  const resetLabel = followsParent
    ? tr("permissionbanner.followParent")
    : tr("permissionbanner.followDefault", { level: approvalLevelTitle(defaultLevel) });
  return createElement(Fragment, null,
    createElement(IconButton, {
      ref: triggerRef,
      className: `header-action composer-auto-approve${on ? " on" : ""}${level === "all" ? " full" : ""}`,
      icon: current.icon,
      size: "md",
      variant: "ghost",
      label,
      title: `${label}\n${tr(current.detail)}\n${origin}`,
      pressed: on,
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      // Busy is announced, not dimmed: a disabled flash between tap and the
      // server's answer read as a glitch, and repeat taps are ignored anyway.
      "aria-busy": pending || undefined,
      onClick: () => { if (open) close(); else openPicker(); },
      onContextMenu: (event: MouseEvent) => { event.preventDefault(); openPicker(); },
    }),
    open && createElement(Popover, {
      open: true,
      onClose: close,
      anchorRef: triggerRef,
      side,
      align: "center",
      compact: phone,
      className: "approval-level-pop",
      ariaLabel: tr("permissionbanner.approvalLevel"),
      initialFocus: `.approval-level-option[data-level="${level}"]`,
      restoreFocusRef: triggerRef,
      children: createElement("div", { className: "approval-level-row" },
        createElement("div", {
          role: "radiogroup",
          "aria-label": tr("permissionbanner.approvalLevel"),
          className: "approval-level-track",
          onKeyDown: (event: Parameters<typeof moveRadioFocus>[0]) => moveRadioFocus(event, optionRefs.current),
        }, LEVELS.map((entry, index) => createElement("button", {
          key: entry.level,
          ref: (node: HTMLButtonElement | null) => { optionRefs.current[index] = node; },
          type: "button",
          role: "radio",
          className: "approval-level-option",
          "data-level": entry.level,
          "aria-checked": entry.level === level,
          "aria-label": tr(entry.title),
          title: `${tr(entry.title)}\n${tr(entry.detail)}`,
          tabIndex: index === currentIndex ? 0 : -1,
          onClick: () => choose(index),
        }, createElement(entry.icon, { "aria-hidden": true })))),
        // Offered only where it changes something: a chat with its own level.
        ownLevel && createElement(Fragment, null,
          createElement("span", { className: "approval-level-divider", "aria-hidden": true }),
          createElement("button", {
            type: "button",
            className: "approval-level-reset",
            "aria-label": resetLabel,
            title: resetLabel,
            onClick: followDefault,
          }, createElement(UndoIcon, { "aria-hidden": true })))),
    }));
}

export default defineWebPackage((host) => () => {
  // The header sits at the top of the window, the composer at the bottom;
  // the anchored picker opens toward the free space and still flips on collision.
  const renderHeaderAutoApprove = (context: WidgetRenderContext) => createElement(AutoApproveAction, { context, side: "down" });
  const renderComposerAutoApprove = (context: WidgetRenderContext) => createElement(AutoApproveAction, { context, side: "up" });
  const off = [
    host.settings.registerPage({
      id: "permissions",
      packageId: "permissions",
      label: tr("permissionbanner.settingsTitle"),
      group: "Engineering",
      icon: "shield",
      component: PermissionsSettingsPage,
      settingsItems: [{
        id: "permissions.defaultLevel",
        pageId: "permissions",
        label: tr("permissionbanner.defaultLevelTitle"),
        description: tr("permissionbanner.defaultLevelHint"),
        keywords: ["auto-approve", "auto approve", "full access", "ask", "default", "always", "yolo", "skip permissions", "approval"],
        focusTarget: "permissions.defaultLevel",
      }, {
        id: "permissions.projects",
        pageId: "permissions",
        label: tr("permissionbanner.projectsTitle"),
        description: tr("permissionbanner.projectsHint"),
        keywords: ["project", "auto-approve", "full access", "trust", "approval"],
        focusTarget: "permissions.projects",
      }],
    }),
    host.projectSettings.register({
      id: "permissions.approvals",
      order: 40,
      label: tr("permissionbanner.projectSettingsLabel"),
      description: tr("permissionbanner.projectSettingsDescription"),
      icon: "shield",
      render: ({ project, onBack }) => createElement(ProjectApprovals, { project, onBack }),
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "permissions.requests",
      order: 20,
      render: () => createElement(PendingPermissionsWidget, { Slot: host.ui.Slot }),
    }),
    host.widgets.registerPlugin({
      id: "permissions",
      name: tr("permissionbanner.settingsTitle"),
      widgets: [{
        id: "permissions.auto-approve-action",
        title: tr("permissionbanner.allSession"),
        description: tr("permissionbanner.allowAllSession"),
        kind: "mini-widget",
        defaultSlot: "session.header.actions",
        supportedSlots: ["session.header.actions"],
        defaultVisible: true,
        order: 40,
        render: renderHeaderAutoApprove,
      }, {
        id: "permissions.auto-approve-composer-action",
        title: tr("permissionbanner.allSession"),
        description: tr("permissionbanner.allowAllSession"),
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        // Acts on the agent's turn: hidden where the composer writes only to people.
        agentOnly: true,
        supportedSlots: ["composer.leading", "composer.trailing"],
        defaultVisible: true,
        order: 40,
        render: renderComposerAutoApprove,
      }, {
        id: "permissions.composer",
        title: tr("permissionbanner.pendingApprovals"),
        description: tr("permissionbanner.pendingApprovalsDescription"),
        kind: "widget",
        defaultSlot: "session.composer.before",
        supportedSlots: ["session.composer.before", "composer.leading", "session.footer", "workspace.main", "workspace.right", "workspace.bottom"],
        defaultVisible: false,
        recommended: true,
        order: 15,
        render: () => createElement(PendingPermissionsWidget, { Slot: host.ui.Slot }),
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
