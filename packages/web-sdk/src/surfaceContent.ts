import type { SurfacePresentation } from "./index.ts";

/** Content layout is independent of a window's floating/docked/fullscreen mode. */
export type SurfaceContentMode = "page" | "panel" | "workspace";

export interface SurfaceContentPresentation extends SurfacePresentation {
  /** The host owns the corresponding padding, scrolling and responsive rules. */
  contentMode: SurfaceContentMode;
}

/** Forms and document/list pages use the host's page rhythm by default.
 *  Edge-to-edge split panes, canvases and terminals explicitly use workspace.
 *  This decorates capabilities only: it never wraps or remounts a component. */
export function withSurfaceContent(
  presentation: SurfacePresentation,
  contentMode: SurfaceContentMode = "page",
): SurfaceContentPresentation {
  return { ...presentation, contentMode };
}

/** Read untrusted/plugin metadata without changing the legacy host fallback. */
export function surfaceContentMode(
  presentation: unknown,
  fallback: SurfaceContentMode,
): SurfaceContentMode {
  if (presentation === null || typeof presentation !== "object") return fallback;
  if (!Object.hasOwn(presentation, "contentMode")) return fallback;
  const mode = (presentation as { contentMode?: unknown }).contentMode;
  return mode === "page" || mode === "panel" || mode === "workspace" ? mode : fallback;
}

/** Package windows inherit the design system without repeating layout classes.
 *  Preserve the component identity, owner, window capabilities and any explicit
 *  content mode. Legacy core surfaces bypass this package registration adapter. */
export function withDefaultSurfaceContent<T extends { presentation: SurfacePresentation }>(
  definition: T,
): T & { presentation: SurfaceContentPresentation } {
  return {
    ...definition,
    presentation: withSurfaceContent(
      definition.presentation,
      surfaceContentMode(definition.presentation, "page"),
    ),
  };
}
