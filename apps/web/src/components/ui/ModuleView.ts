// Polyth module-view shell — the ONE presentational frame every feature
// module renders inside, whether it is a main-area workspace surface
// (components/workspace/WorkspaceHost.ts) or a right-rail panel
// (components/ContextRail.tsx). Packages supply a title, an optional
// description / icon / actions and a body; the frame owns the shared header,
// the single top-right close control, and the scroll body. Phone presentation
// (opaque full cover of the session, right-to-left slide-in, z-stacked so
// several open modules overlap and dismiss together) is realized in
// styles.css from `.module-view` + `--module-depth`.
//
// createElement-based (a .ts file, not .tsx) so the DOM-free node:test suite
// and the createElement-only WorkspaceHost can import it without the tsx
// loader — the same rule ViewErrorBoundary.ts follows.
import { createElement, type ReactNode } from "react";
import { tr } from "../../i18n/index.ts";
import { CloseIcon, CollapseIcon, DockBottomIcon, DockSideIcon, ExpandIcon, PinIcon } from "./icons.ts";

export type ModuleViewVariant = "main" | "rail";
export type ModuleContentMode = "page" | "panel" | "workspace";
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
  title: string;
  description?: string;
  /** Small leading glyph shown before the title. */
  icon?: ReactNode;
  /** Right-aligned controls rendered just before the close button. */
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
  /** The single close affordance. Callers pass closeAllModules() so one tap
   *  dismisses every open module and returns to the session (UX spec §4). */
  onClose: () => void;
  closeLabel?: string;
  /** "main" = WorkspaceHost surface, "rail" = ContextRail panel. */
  variant?: ModuleViewVariant;
  /** Core-owned content behavior. Packages only render their feature root. */
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
    id, title, description, icon, actions, tabs, headingProps, onClose, closeLabel,
    onTogglePin, dockActions, onToggleFullscreen, pinned = false, fullscreen = false,
    variant = "main", contentMode = "page", depth = 0, className, children,
  } = props;
  return createElement(
    "section",
    {
      className: `module-view module-view--${variant}${className ? ` ${className}` : ""}`,
      "data-module-id": id,
      "data-module-depth": depth,
      style: { ["--module-depth" as string]: depth },
    },
    createElement(
      "header",
      { className: "module-view-head", ...(tabs ? { "aria-label": title } : {}) },
      tabs ?? [
        icon ? createElement("span", { key: "icon", className: "module-view-icon", "aria-hidden": true }, icon) : null,
        createElement(
          "div",
          { key: "heading", className: "module-view-heading", ...headingProps },
          createElement("h1", { className: "module-view-title", tabIndex: -1, title }, title),
          description
            ? createElement("p", { className: "module-view-desc" }, description)
            : null,
        ),
      ],
      createElement("span", { className: "header-spacer" }),
      actions ? createElement("div", { className: "module-view-actions" }, actions) : null,
      dockActions && dockActions.length > 0
        ? dockActions.map((action) => systemAction(
          dockIcon(action.edge), action.label, action.onClick, action.selected,
          "module-view-system-action module-view-dock-action", `dock-${action.edge}`,
        ))
        : onTogglePin
          ? systemAction(PinIcon, pinned ? "Unpin window" : "Pin window", onTogglePin, pinned, "module-view-system-action")
          : null,
      onToggleFullscreen ? systemAction(fullscreen ? CollapseIcon : ExpandIcon, fullscreen ? "Exit fullscreen" : "Enter fullscreen", onToggleFullscreen, fullscreen, "module-view-system-action") : null,
      systemAction(CloseIcon, closeLabel ?? tr("contextrail.closePanel"), onClose, undefined, "module-view-close"),
    ),
    createElement(
      "div",
      { className: "module-view-body" },
      createElement(
        "div",
        { className: `module-view-content module-view-content--${contentMode}` },
        children,
      ),
    ),
  );
}
