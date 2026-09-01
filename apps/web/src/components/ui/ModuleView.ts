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

export type ModuleViewVariant = "main" | "rail";
export type ModuleContentMode = "page" | "panel" | "workspace";

export interface ModuleViewProps {
  /** Stable module id (workspace surface id / rail surface id). */
  id: string;
  title: string;
  description?: string;
  /** Small leading glyph shown before the title. */
  icon?: ReactNode;
  /** Right-aligned controls rendered just before the close button. */
  actions?: ReactNode;
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

function CloseGlyph(): ReactNode {
  return createElement(
    "svg",
    {
      viewBox: "0 0 16 16",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.75,
      strokeLinecap: "round",
      "aria-hidden": true,
    },
    createElement("path", { d: "M4 4l8 8M12 4l-8 8" }),
  );
}

export default function ModuleView(props: ModuleViewProps): ReactNode {
  const {
    id, title, description, icon, actions, onClose, closeLabel,
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
      { className: "module-view-head" },
      icon ? createElement("span", { className: "module-view-icon", "aria-hidden": true }, icon) : null,
      createElement(
        "div",
        { className: "module-view-heading" },
        createElement("h1", { className: "module-view-title", tabIndex: -1 }, title),
        description
          ? createElement("p", { className: "module-view-desc" }, description)
          : null,
      ),
      createElement("span", { className: "header-spacer" }),
      actions ? createElement("div", { className: "module-view-actions" }, actions) : null,
      createElement(
        "button",
        {
          type: "button",
          className: "module-view-close",
          onClick: () => onClose(),
          "aria-label": closeLabel ?? tr("contextrail.closePanel"),
        },
        createElement(CloseGlyph),
      ),
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
