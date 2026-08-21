// EXTENSION-SEAMS slice 2: the workspace surface host. Selects exactly one
// registered surface for the store's active view, applies plugin availability
// with a deterministic fallback, applies the surface's project/session
// requirement (rendering the standard empty state when it is absent), and
// isolates the surface behind its own ViewErrorBoundary so one failing
// contribution cannot collapse the header, sidebar, composer, rail, or
// status bar.
//
// Deliberately createElement-based (a .ts file, not .tsx): Node's type
// stripping cannot load JSX, and the DOM-free node:test suite must be able to
// import this file to test gating, fallback, empty states, and failure
// isolation through a real React root.
import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { setOverlay, useStore } from "../../store.ts";
import { refreshProjects } from "../../init.ts";
import type { ProjectRegistryState } from "../../projectRegistry.ts";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import {
  listWorkspaceSurfaces,
  resolveWorkspaceSurface,
  subscribeWorkspaceSurfaces,
  workspaceSurfaceGate,
  workspaceSurfaceVersion,
  type WorkspaceSurface,
} from "../../workspace/surfaceRegistry.ts";

/** Re-render whenever any surface registers, replaces, or disposes. */
export function useWorkspaceSurfaceVersion(): number {
  return useSyncExternalStore(subscribeWorkspaceSurfaces, workspaceSurfaceVersion);
}

// A same-id replacement is a new descriptor object; giving each registration
// its own instance id lets the boundary's resetKey change so a fixed
// contribution visibly recovers instead of inheriting the old failure
// (the EXT-SEAMS-V1 lesson, applied to surfaces).
let nextInstanceId = 0;
const instanceIds = new WeakMap<WorkspaceSurface, number>();
function instanceIdOf(surface: WorkspaceSurface): number {
  let id = instanceIds.get(surface);
  if (id === undefined) {
    id = ++nextInstanceId;
    instanceIds.set(surface, id);
  }
  return id;
}

/** Boundary reset identity: surface registration + canonical ids. Exported for
 *  DOM-free tests. */
export function surfaceResetKey(
  surface: WorkspaceSurface,
  projectId: string | null,
  sessionId: string | null,
): string {
  return `${surface.id}#${instanceIdOf(surface)}:${projectId ?? ""}:${sessionId ?? ""}`;
}

/** Project-registry-aware empty state. Loading and failure never masquerade as
 *  a successful empty project list. */
function ProjectEmptyState({ registry }: { registry: ProjectRegistryState }): ReactNode {
  if (registry.status === "loading") {
    return createElement(
      "div",
      { className: "stage" },
      createElement(
        "div",
        { className: "hero hero-project-loading" },
        createElement("div", { className: "hero-mark" }, "p"),
        createElement("h2", null, "Loading your projects…"),
        createElement("p", { className: "hero-sub" }, "Polyth is checking this server for saved projects."),
        createElement(
          "button",
          { className: "primary-btn hero-open-project", disabled: true },
          "Choose a folder…",
        ),
      ),
    );
  }
  if (registry.status === "failed") {
    return createElement(
      "div",
      { className: "stage" },
      createElement(
        "div",
        { className: "hero hero-project-failed" },
        createElement("div", { className: "hero-mark" }, "p"),
        createElement("h2", null, "Couldn’t load projects"),
        createElement("p", { className: "hero-sub" }, "Polyth couldn’t read the project list from this server."),
        createElement(
          "button",
          {
            className: "primary-btn hero-retry-projects",
            onClick: () => { void refreshProjects("manual"); },
          },
          "Retry",
        ),
        createElement("p", { className: "hero-status mono", role: "status" }, registry.error),
      ),
    );
  }
  return createElement(
    "div",
    { className: "stage" },
    createElement(
      "div",
      { className: "hero" },
      createElement("div", { className: "hero-mark" }, "p"),
      createElement("h2", null, "Bring your work into focus."),
      createElement(
        "p",
        { className: "hero-sub" },
        "Open a local project to start a session with its files, history, and tools.",
      ),
      createElement(
        "button",
        { className: "primary-btn hero-open-project", onClick: () => setOverlay("project-picker") },
        "Choose a folder…",
      ),
    ),
  );
}

/** Standard session empty state for surfaces that require an open session. */
function SessionEmptyState({ title }: { title: string }): ReactNode {
  return createElement(
    "div",
    { className: "empty-state" },
    createElement("span", { className: "empty-state-mark", "aria-hidden": true }, "○"),
    createElement("h2", { className: "empty-state-title" }, "No session selected"),
    createElement("p", { className: "empty-state-desc" }, `Open or start a session to use ${title}.`),
  );
}

/** Nothing registered (or everything gated off) — an honest empty workspace. */
function NoSurfaceEmptyState(): ReactNode {
  return createElement(
    "div",
    { className: "empty-state" },
    createElement("span", { className: "empty-state-mark", "aria-hidden": true }, "○"),
    createElement("h2", { className: "empty-state-title" }, "Nothing to show here yet"),
    createElement("p", { className: "empty-state-desc" }, "No workspace surface is registered or enabled."),
  );
}

export default function WorkspaceHost(): ReactNode {
  useWorkspaceSurfaceVersion();
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const view = useStore((s) => s.activeView);
  const registry = useStore((s) => s.projectRegistry);

  const surface = resolveWorkspaceSurface(view, listWorkspaceSurfaces(), []);
  if (!surface) return createElement(NoSurfaceEmptyState);

  const gate = workspaceSurfaceGate(surface, { projectId, sessionId });
  if (gate === "needs-project") return createElement(ProjectEmptyState, { registry });
  if (gate === "needs-session") return createElement(SessionEmptyState, { title: surface.title });

  // EXT-SEAMS-S2-V1: every surface receives the canonical ids as props — the
  // specified identity contract, so contributions never reach into internal
  // stores or invent their own workspace authority just to learn "where am I".
  return createElement(
    ViewErrorBoundary,
    { inline: true, resetKey: surfaceResetKey(surface, projectId, sessionId) },
    createElement(surface.component, { projectId, sessionId }),
  );
}
