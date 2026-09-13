// Polyth module-view shell — the ONE presentational frame every feature
// module renders inside, whether it is a main-area workspace surface
// (components/workspace/WorkspaceHost.ts) or a right-rail panel
// (components/ContextRail.tsx). Packages supply a title, an optional
// description / icon / actions and a body; the frame owns the shared header,
// navigation affordances, and the scroll body. On phone a rail package is a
// child of Workspace: Back returns to Workspace while Close dismisses it and
// preserves it as the next Workspace resume target. Presentation and stacking
// are realized in styles.css from `.module-view` + `--module-depth`.
//
// createElement-based (a .ts file, not .tsx) so the DOM-free node:test suite
// and the createElement-only WorkspaceHost can import it without the tsx
// loader — the same rule ViewErrorBoundary.ts follows.
import { createElement, useEffect, type ReactNode } from "react";
import { surfaceContentMode, type SurfaceContentMode } from "@polyth/web-sdk/surface-content";
import { listSurfaces } from "../../surfaces.ts";
import { tr } from "../../i18n/index.ts";
import { useShellMode } from "../../responsiveShell.ts";
import {
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
  /** Package-declared pinned edges. When present, these replace the generic
   *  pin toggle with one header action per supported edge. */
  dockActions?: readonly ModuleDockAction[];
  onToggleFullscreen?: () => void;
  pinned?: boolean;
  fullscreen?: boolean;
  /** Close/dismiss the module. Phone rail packages also get a separate Back. */
  onClose: () => void;
  closeLabel?: string;
  /** "main" = WorkspaceHost surface, "rail" = ContextRail panel. */
  variant?: ModuleViewVariant;
  /** Legacy/core fallback. Registered content metadata wins in every placement. */
  contentMode?: ModuleContentMode;
  /** Phone stacking depth: a higher value sits on top of lower ones. */
  depth?: number;
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
    variant = "main", contentMode = "page", depth = 0, className, children,
  } = props;
  const shellMode = useShellMode();
  const phone = shellMode === "phone";
  const workspaceChild = phone && variant === "rail";

  // Any phone package reached outside Workspace still becomes the natural
  // resume target. Back deliberately clears this through showMobileWorkspaceHome().
  useEffect(() => {
    if (workspaceChild) rememberMobileWorkspacePackage(id);
  }, [id, workspaceChild]);

  // Both rail and workbench hosts already subscribe to the surface registry.
  // Resolve here, once per frame, so moving a page cannot turn it into an
  // edge-to-edge canvas. Unknown/legacy surfaces retain the caller's fallback.
  const surface = listSurfaces().find((item) => item.id === (surfaceId ?? id));
  const resolvedContentMode = surfaceContentMode(surface?.presentation, contentMode);
  const phoneBack = () => {
    onClose();
    if (workspaceChild) showMobileWorkspaceHome();
  };

  return createElement(
    "section",
    {
      className: `module-view module-view--${variant}${phone ? " module-view--phone" : ""}${className ? ` ${className}` : ""}`,
      "data-module-id": id,
      "data-module-depth": depth,
      "data-content-mode": resolvedContentMode,
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
          dockIcon(action.edge), action.label, action.onClick, action.selected,
          "module-view-system-action module-view-dock-action", `dock-${action.edge}`,
        ))
        : !phone && onTogglePin
          ? systemAction(PinIcon, pinned ? "Unpin window" : "Pin window", onTogglePin, pinned, "module-view-system-action")
          : null,
      !phone && onToggleFullscreen ? systemAction(fullscreen ? CollapseIcon : ExpandIcon, fullscreen ? "Exit fullscreen" : "Enter fullscreen", onToggleFullscreen, fullscreen, "module-view-system-action") : null,
      phone
        ? [
          systemAction(BackIcon, tr("common.back"), phoneBack, undefined, "module-view-back", "phone-back"),
          workspaceChild
            ? systemAction(CloseIcon, closeLabel ?? tr("contextrail.closePanel"), onClose, undefined, "module-view-close module-view-dismiss", "phone-close")
            : null,
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
