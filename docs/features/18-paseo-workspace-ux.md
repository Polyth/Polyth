# Paseo-derived workspace UX

This document covers Paseo concepts that map cleanly to Polyth's project/session microkernel without importing Paseo's daemon/native architecture.

## 1. Workspace labels

**Source:** Paseo #3510.

In Polyth, a “workspace” maps to a project plus an optional session/worktree attachment. Labels are lightweight organizational metadata, not filesystem tags.

**Acceptance criteria**

- Users create, rename, recolor, reorder, and delete label definitions.
- Labels can be assigned to projects and optionally sessions; sidebar and search filter by one or more labels.
- Deleting a label removes assignments but never deletes projects/sessions.
- Label chips show consistently in project menus, session rows, command palette, and history.

**Data/API**

```ts
interface WorkspaceLabel {
  id: string; name: string; color: string;
  position: number; revision: number;
}
interface WorkspaceLabelAssignment {
  labelId: string;
  target: { kind: "project"|"session"; id: string };
}
```

```http
GET    /api/workspace-labels
POST   /api/workspace-labels {"name":"Client A","color":"violet"}
PATCH  /api/workspace-labels/:id {"name":"...","color":"...","position":1,"revision":2}
DELETE /api/workspace-labels/:id
PUT    /api/projects/:id/labels {"labelIds":["..."]}
PUT    /api/sessions/:id/labels {"labelIds":["..."]}
```

Persist server-side with unique case-folded names and token colors. Add `labelIds?: string[]` to `Project` and `SessionProjection`; push projection updates over `/ws`. Label metadata is not model-visible unless a workflow explicitly includes it; if included in a prompt, append `workspace/labels-attached {labelIds,names}` first.

UI: `WorkspaceLabelManager`, `WorkspaceLabelPicker`, `WorkspaceLabelFilter`; classes `.workspace-label`, `.label-picker`, `.label-filter`. Use `sidebar.project.actions`, `sidebar.session.actions`, and settings slots.

**Tests:** case/Unicode duplicates, stale reorder, delete assigned label, cross-project session ID, filter with archived sessions, color contrast, keyboard multi-select.

## 2. First-class right-pane tabs

**Source:** Paseo #3287.

The detailed pane contract is in `12-files-git-context.md`. Paseo's important design rules are:

- Main and right panes use the same `WorkspaceSurface`/`PaneTabState` language.
- Assistant-opened files route to the right pane by default without stealing composer focus.
- Hidden tabs that need draft/state continuity remain mounted but receive `active=false` and suspend polling.
- Files, diffs, pull requests, knowledge, and plugin panels all use one host; no nested one-off sidebar routers.
- Closing/moving a dirty tab asks once and preserves the tab if canceled.

Required commands: Open in main, Open in right, Move tab, Close, Close others, Reopen closed. Persist only descriptors/layout under `polyth.workspace.layout.v1`; validate unavailable surfaces on restore.

Add accessibility semantics (`role=tablist/tab/tabpanel`), roving focus, `Ctrl+PageUp/Down`, and a keyboard-accessible splitter. Narrow layouts convert the right pane to a full-screen tab without unmounting its state.

**Tests:** plugin uninstall with open tab, duplicate resources, hidden-effect suspension, focus after assistant file open, dirty move/close, responsive collapse, restored unknown surface.

## 3. Contextual plugin workspace tools

**Source:** Paseo #3465.

Installed plugins may contribute project- or session-scoped panels and command-palette items, subject to declared capabilities and trust grants.

```ts
interface ContextualPanelContribution {
  id: string;
  title: string;
  icon: string;
  scope: "project"|"session";
  placement: "main"|"right"|"either";
  module: string;
  command: { id: string; label: string; keywords?: string[] };
  requiresCapabilities?: string[];
}
```

Server manifests carry descriptors; the web module registry resolves only installed, signed/approved plugin modules. Contribution snapshots update atomically on plugin enable/reload. Disposal closes or replaces affected tabs with an honest unavailable state and removes palette commands.

Context passed to a panel is typed and minimal: IDs, granted capability handles, and route client; never raw server secrets, absolute paths without workspace trust, or direct OpenCode clients. A panel that supplies agent context calls:

```http
POST /api/sessions/:id/context
{"source":{"pluginId":"...","panelId":"..."},"title":"...","content":"...","digest":"..."}
```

The server validates grants and appends `context/plugin-added` before returning success/display. High-frequency panel telemetry stays outside the event log.

Integrate contributions into `workspace.*.tabs`, `commandPalette.commands`, and plugin settings. Add `.plugin-panel-error` and an error boundary per panel so one plugin cannot blank a pane.

**Tests:** enable/disable/reload snapshot, missing capability, untrusted module key, disposed command, panel crash, context size/redaction, session/project scope mismatch, event-before-display.

## Cross-domain Paseo patterns

These are specified elsewhere but should be implemented with the same workspace primitives:

- Composer task/subagent floating pills and live progress: `10-chat-composer.md`.
- Active-turn steering: `10-chat-composer.md`.
- Shared file actions and assistant line opens: `12-files-git-context.md`.
- Agent profiles: `17-usage-models-profiles.md`.
- Command-center project/file/group-by actions: `19-palette-hotkeys-a11y.md`.

## Suggested implementation order

1. Shared pane/tab/surface descriptors.
2. Workspace labels and projection/search integration.
3. Plugin contribution snapshot protocol.
4. Contextual panels, command entries, disposal, and model-context bridge.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Use workspace package imports and capability contracts.
- Only `packages/backend-opencode` accesses OpenCode.
- Append plugin/label-derived model context before display/use.
- Extend `/api` and `/ws`.
- All workspace tools use typed slots, not shell mega-component imports.
- Tests use `node --test` and plain `node:assert`.
