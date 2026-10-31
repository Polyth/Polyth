// Polyth module-view shell — the ONE presentational frame every feature
// module renders inside, whether it is a main-area workspace surface
// (components/workspace/WorkspaceHost.ts) or a right-rail panel
// (components/ContextRail.tsx). Packages supply a title, an optional
// description / icon / actions and a body; the frame owns the shared header,
// navigation affordances, and the scroll body. On phone every package is a
// child of Workspace: Back pops to the Workspace layer that stays mounted
// beneath it, while Close dismisses the whole stack and forgets the package,
// so the next Tools tap opens the Workspace home. Presentation and stacking
// are realized in styles.css / stackNavigation.css from `.module-view` +
// `--module-depth`.
//
// createElement-based (a .ts file, not .tsx) so the DOM-free node:test suite
// and the createElement-only WorkspaceHost can import it without the tsx
// loader — the same rule ViewErrorBoundary.ts follows.
import { createElement, useEffect, useRef, type ReactNode } from "react";
import { surfaceContentMode, type SurfaceContentMode } from "@polyth/web-sdk/surface-content";
import { listSurfaces } from "../../surfaces.ts";
import { tr } from "../../i18n/index.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { useEdgeSwipeBack } from "../../useEdgeSwipeBack.ts";
import { swipeZoneInHost } from "../../shellSwipe.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import {
  forgetMobileWorkspacePackage,
  rememberMobileWorkspacePackage,
  showMobileWorkspaceHome,
} from "../../mobileWorkspaceNavigation.ts";
import { BackIcon, CloseIcon, CollapseIcon, DockBottomIcon, DockSideIcon, ExpandIcon, PinIcon } from "./icons.ts";

export type ModuleViewVariant = "main" | "rail";
export type ModuleContentMode = SurfaceContentMode;
export type ModuleDockEdge = "side" | "bottom";

export interface ModuleDockAction {
  edge: ModuleDockEdge;
  label: string;
  onClick: () => void;
  selected?: boolean;
}

export interface ModuleViewProps {
  /** Stable module id (workspace surface id / rail surface id). */
  id: string;
  /** Active registered surface when this frame represents a workbench region. */
  surfaceId?: string;
  title: string;
  description?: string;
  /** Small leading glyph shown before the title. */
  icon?: ReactNode;
  /** Right-aligned controls rendered just before the navigation button. */
  actions?: ReactNode;
  /** Workbench regions hosting several surfaces replace the single title with
   *  a tab strip; the title then names the group for assistive tech only. */
  tabs?: ReactNode;
  /** Optional drag handle props spread onto the heading (workbench moves). */
  headingProps?: Record<string, unknown>;
  /** Window controls are host-owned. Packages cannot replace their order or
   * geometry; they only declare supported capabilities at registration. */
  onTogglePin?: () => void;
  /** Package-declared pinned edges the window can move to, shown before the
   *  pin toggle (which every pinnable window keeps). */
  dockActions?: readonly ModuleDockAction[];
  onToggleFullscreen?: () => void;
  pinned?: boolean;
  fullscreen?: boolean;
  /** Close/dismiss the module. Phone modules also get a separate Back. */
  onClose: () => void;
  /** False while the frame is closed or still leaving. A keep-alive host keeps
   *  the frame mounted (hidden) after close; such a frame must never claim to
   *  be the Workspace resume target or reopen the Workspace on its own. */
  presented?: boolean;
  closeLabel?: string;
  /** "main" = WorkspaceHost surface, "rail" = ContextRail panel. */
  variant?: ModuleViewVariant;
  /** Legacy/core fallback. Registered content metadata wins in every placement. */
  contentMode?: ModuleContentMode;
  /** Phone stacking depth: a higher value sits on top of lower ones. */
  depth?: number;
  /** Content direction when the host mirrors the shell around this frame
   *  (shellDirection.ts); omitted, the frame inherits. */
  dir?: "ltr" | "rtl";
  className?: string;
  /** Optional in the type so createElement callers may pass children last. */
  children?: ReactNode;
}

function systemAction(icon: typeof CloseIcon, label: string, onClick: () => void, pressed?: boolean, className = "", key?: string): ReactNode {
  return createElement(
    "button",
    {
      ...(key ? { key } : {}),
      type: "button",
      className: `ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm ${className}`,
      title: label,
      "aria-label": label,
      "aria-pressed": pressed,
      onClick,
    },
    createElement(icon, { className: "ui-icon ui-icon--sm", "aria-hidden": true }),
  );
}

function dockIcon(edge: ModuleDockEdge): typeof DockSideIcon {
  return edge === "bottom" ? DockBottomIcon : DockSideIcon;
}

export default function ModuleView(props: ModuleViewProps): ReactNode {
  const {
    id, surfaceId, title, description, icon, actions, tabs, headingProps, onClose, closeLabel,
    onTogglePin, dockActions, onToggleFullscreen, pinned = false, fullscreen = false,
    variant = "main", contentMode = "page", depth = 0, className, children, presented = true, dir,
  } = props;
  const shellMode = useShellMode();
  const phone = shellMode === "phone";
  const rootRef = useRef<HTMLElement>(null);

  // Every phone package is a child of Workspace. Reaching one by any route
  // makes it the resume target; Back deliberately clears that target. Only a
  // presented frame may do so: a closed keep-alive frame is still mounted (and
  // its id falls back to a placeholder), and registering it would close the
  // Workspace that Back has just returned to.
  useEffect(() => {
    if (phone && presented) rememberMobileWorkspacePackage(id);
  }, [id, phone, presented]);

  // A pushed layer takes focus, as the screen it replaces loses it: the control
  // that opened it is now inert beneath, so focus would otherwise fall to the
  // document. The title is the landmark; anything inside that already claimed
  // focus (an autofocused field) wins.
  useEffect(() => {
    if (!phone || !presented) return;
    const claim = () => {
      const root = rootRef.current;
      if (!root || root.contains(document.activeElement)) return;
      root.querySelector<HTMLElement>(".module-view-title")?.focus({ preventScroll: true });
    };
    // One frame later, so a field the package autofocuses on mount keeps focus.
    if (typeof requestAnimationFrame !== "function") {
      claim();
      return;
    }
    const frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [phone, presented, id]);

  // Both rail and workbench hosts already subscribe to the surface registry.
  // Resolve here, once per frame, so moving a page cannot turn it into an
  // edge-to-edge canvas. Unknown/legacy surfaces retain the caller's fallback.
  const surface = listSurfaces().find((item) => item.id === (surfaceId ?? id));
  const resolvedContentMode = surfaceContentMode(surface?.presentation, contentMode);
  // Back is a pop, not a dismissal: name the Workspace as the destination
  // first, so the layer beneath is already the foreground target when this
  // frame starts to leave. The reverse order would let one render see neither
  // layer wanted and begin to close the Workspace.
  const phoneBack = () => {
    showMobileWorkspaceHome();
    onClose();
  };
  // Close is the person being done with the package: it no longer comes back
  // when Tools is tapped next. A session switch, which only takes the window
  // away, keeps it as the resume target.
  const phoneClose = () => {
    forgetMobileWorkspacePackage();
    onClose();
  };
  // The same pop, driven by a finger: the layer follows it toward the inline
  // end (from the edge, or from anywhere on the window under the Swipe
  // navigation setting) and the Workspace beneath settles in behind it;
  // release hands over to the exit. Content that scrolls or drags
  // horizontally keeps its own touches (swipeSurface.ts).
  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  useEdgeSwipeBack({
    enabled: phone && presented && swipeZone !== null,
    ...(swipeZone ? { zone: swipeZone } : {}),
    layer: () => rootRef.current?.closest<HTMLElement>(".rail-fullscreen, .panel-sheet, .module-view--main") ?? rootRef.current,
    under: () => document.querySelector<HTMLElement>('.sheet-backdrop[data-stack="covered"]'),
    onBack: phoneBack,
  });

  return createElement(
    "section",
    {
      ref: rootRef,
      className: `module-view module-view--${variant}${phone ? " module-view--phone" : ""}${className ? ` ${className}` : ""}`,
      "data-module-id": id,
      "data-module-depth": depth,
      "data-content-mode": resolvedContentMode,
      ...(dir ? { dir } : {}),
      style: { ["--module-depth" as string]: depth },
    },
    createElement(
      "header",
      { className: "module-view-head", ...(tabs ? { "aria-label": title } : {}) },
      tabs ?? [
        icon ? createElement("span", { key: "icon", className: "module-view-icon", "aria-hidden": true }, icon) : null,
        createElement(
          "div",
          { key: "heading", className: "module-view-heading", ...(!phone ? headingProps : {}) },
          createElement("h1", { className: "module-view-title", tabIndex: -1, title }, title),
          description
            ? createElement("p", { className: "module-view-desc" }, description)
            : null,
        ),
      ],
      createElement("span", { className: "header-spacer" }),
      actions ? createElement("div", { className: "module-view-actions" }, actions) : null,
      !phone && dockActions && dockActions.length > 0
        ? dockActions.map((action) => systemAction(
          dockIcon(action.edge), action.label, action.onClick, action.selected || undefined,
          "module-view-system-action module-view-dock-action", `dock-${action.edge}`,
        ))
        : null,
      !phone && onTogglePin
        ? systemAction(PinIcon, pinned ? tr("contextrail.unpinWindow") : "Pin window", onTogglePin, pinned, "module-view-system-action")
        : null,
      !phone && onToggleFullscreen ? systemAction(fullscreen ? CollapseIcon : ExpandIcon, fullscreen ? "Exit fullscreen" : "Enter fullscreen", onToggleFullscreen, fullscreen, "module-view-system-action") : null,
      phone
        ? [
          systemAction(BackIcon, tr("common.back"), phoneBack, undefined, "module-view-back", "phone-back"),
          systemAction(CloseIcon, closeLabel ?? tr("contextrail.closePanel"), phoneClose, undefined, "module-view-close module-view-dismiss", "phone-close"),
        ]
        : systemAction(CloseIcon, closeLabel ?? tr("contextrail.closePanel"), onClose, undefined, "module-view-close"),
    ),
    createElement(
      "div",
      { className: "module-view-body" },
      createElement(
        "div",
        { className: `module-view-content module-view-content--${resolvedContentMode}` },
        children,
      ),
    ),
  );
}
