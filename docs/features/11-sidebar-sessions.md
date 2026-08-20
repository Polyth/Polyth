# Sidebar, projects, and sessions

## Current Polyth baseline

`Sidebar.tsx` lists projects and each active project's sessions, sorts by `updatedAt`, shows status dots, opens/forks/archives/restores, and creates sessions. The store already projects session status, worktree path, token/cost totals, goal summary, and durable events. `SessionSearch.tsx` provides a global search overlay. Archive/restore and worktree session creation already exist; extend them instead of introducing a second session store.

## 1. Project rename, color, icon, and defaults

**Sources:** polyth #326, #439, #2015.

**Acceptance criteria**

- Project menus allow inline rename and selecting an icon/color; changes survive restart and appear in every project picker.
- Rename Enter commits, Escape cancels, blur commits only a changed valid name.
- Project defaults may specify model/profile, agent, grouping mode, and new-session worktree behavior.

**Contract**

The `Project` contract already has optional `color` and `icon`. Add `defaults?: ProjectDefaults` and:

```http
PATCH /api/projects/:id
{"name":"Polyth","color":"indigo","icon":"folder-code","defaults":{"agentProfileId":"..."}}
→ Project
```

Use a constrained icon ID and token color, never arbitrary SVG/CSS. Persist in the existing project database/service. Add `sidebar.project.actions` slot, `ProjectMenu.tsx`, `ProjectInlineRename.tsx`, `.project-avatar`, `.project-menu`, `.project-rename`.

**Tests:** duplicate names, empty names, stale revision, removed active project, unknown icon/color, keyboard and screen-reader labels.

## 2. Grouping modes, sticky project zones, and folders

**Sources:** polyth #2480, #460, #469; Paseo #3063.

**Acceptance criteria**

- Sidebar grouping switches between `by-worktree`, `flat`, `by-status`, and `by-folder`.
- Users create nested folders, rename/reorder them, move sessions by pointer or keyboard, and choose a folder for a new session.
- Collapse state and grouping preference persist. A virtual `Recent` zone never duplicates selection state or ownership.
- Folder deletion asks whether to move members to the parent or leave them unfiled; it never deletes sessions.

**Data/API**

Persist server-side because organization must follow the project:

```ts
interface SessionFolderDto {
  id: string; projectId: string; parentId?: string;
  name: string; position: number; revision: number;
}
```

```http
GET    /api/projects/:projectId/session-folders
POST   /api/projects/:projectId/session-folders {"name":"Review","parentId":null}
PATCH  /api/session-folders/:id {"name":"...","parentId":"...","position":2,"revision":3}
DELETE /api/session-folders/:id?memberPolicy=parent|unfiled
PUT    /api/sessions/:id/folder {"folderId":"...","position":0}
```

Reject cycles, cross-project moves, depth above five, and stale revisions. Local preferences under `polyth.sidebar`: `{groupingMode,stickyZoneHeaders,collapsedIds}`; server owns folder definitions/membership.

Component tree: `SidebarProjectsList` → `ProjectZone` → `SessionGroupSection` → `SessionFolderItem` → `SessionRow`; add `.sidebar-zone`, `.session-group`, `.session-folder`, `.folder-drop-target`, `.bulk-action-bar`.

**Tests:** cycle detection, move parent into child, deleting nested folders, same session in Recent and canonical group, DnD cancellation, keyboard move, 1,000-session rendering.

## 3. Archive, restore, delete, and bulk selection

**Source:** polyth #2616 plus #2480.

Archive/restore already ships. Add an Archive full-page surface and bulk selection:

```http
POST /api/sessions/bulk
{"sessionIds":["..."],"action":"archive|restore|delete"}
→ {"succeeded":["..."],"failed":[{"id":"...","code":"..."}]}
```

Selection is client-only and keyed by session ID. Server validates ownership per item and executes archive/restore idempotently. Permanent delete requires a second confirmation showing descendant/subagent count and must not be the default archive action. Append existing `session/archived` or `session/restored` events for each affected session before projection pushes.

Add `ArchiveView.tsx`, `BulkActionBar.tsx`, `.session-select`, `.archive-view`. Preserve an active archived session until the user chooses another; do not blank the transcript.

Test mixed-project IDs, parent/subagent cascade policy, partial failures, restore to original folder, repeated action, active session projection, and keyboard range selection.

## 4. Inline session rename and search

**Sources:** polyth #1320, #568, #1104; Paseo #2995.

Double-click or Rename enters inline title editing. Add:

```http
PATCH /api/sessions/:id {"title":"Investigate cache invalidation"}
```

The server appends `session/metadata-changed {title}` then updates/pushes the projection. Empty titles are rejected; optimistic UI rolls back on error.

Keep global `SessionSearch`, and add an active-project sidebar filter that matches title, folder, branch/worktree, agent/profile, and first user prompt. A separate in-session timeline search opens with `Mod+T`, searches all rendered roles, and navigates event anchors. Do not send raw transcript content to a new index service; search loaded events first, then use:

```http
GET /api/sessions/:id/search?q=&limit=50&beforeSeq=
→ [{"seq":12,"role":"assistant","snippet":"...","matchRanges":[[4,9]]}]
```

Classes: `.sidebar-search`, `.session-inline-title`, `.timeline-search`, `.search-highlight`.

Test IME in rename/search, stale result cancellation, regex-looking input treated literally, archived inclusion filter, branch/path matching, and inaccessible session IDs.

## 5. Pending question, permission, unread, and goal badges

**Source:** polyth #2682.

Derive counts from canonical unresolved `question/asked` minus `question/answered` and `permission/requested` minus `permission/resolved` events. Never maintain an independent counter. Add projection summary for unloaded sessions:

```ts
interface SessionAttention {
  questions: number;
  permissions: number;
  unread: number;
  goalStatus?: string;
}
```

Include `attention` in session projections and `/ws` projection updates. `session.list.badges` remains the extension slot; built-in badges use `.session-badge.question`, `.permission`, `.unread`, with accessible text such as “2 unanswered questions.”

Test reconnect/replay, answered request in another session, session not currently loaded, counts above 99, archive/restore, and projection/event consistency.

## 6. Session worktree isolation

**Source:** polyth #913.

Polyth already stores `worktreePath` and launches that session runtime in the worktree. Harden the contract:

- Resolve Files, Git, terminal, preview, and agent runtime operations from the session attachment when a session is active.
- Surface branch/worktree in the session row and header.
- Block checkout, remove, reset, rebase, or branch mutation when an attached worktree has an in-progress Git operation or working session unless the user explicitly stops/detaches it.
- Never infer a session branch from the currently selected project root.

Add `worktreeId`, `branch`, and `worktreeState: "ready"|"bootstrapping"|"busy"|"missing"` to `SessionProjection`. Add:

```http
GET /api/sessions/:id/worktree → WorktreeAttachment
POST /api/sessions/:id/worktree/detach {"targetProjectId":"..."}
```

Files/Git routes may accept `sessionId` and resolve the cwd server-side; clients must not submit arbitrary absolute cwd paths. Emit `session/metadata-changed` for attachment changes.

Test deleted worktree, symlinked path, project switch during send, forked session inheritance, Git operation lock, server restart, and Windows-style case normalization where supported.

## 7. Sidebar surfaces and project switching invariants

**Source:** polyth #2480 and related routing fixes.

The redesigned sidebar links Scheduled tasks, Archive, Multi-run, and Worktrees as full-page surfaces. Contribute these through `app.nav` descriptors. Project switching is atomic:

1. Capture current session draft and pane state.
2. Set active project.
3. Load its projections/folders.
4. Restore last active session if it still belongs to the project; otherwise select no session.
5. Subscribe `/ws` from the saved sequence.

Clicking the already-active project must retain the active session (already true). A send captures its target before project switching.

Persist `polyth.sidebar.lastSessionByProject` and layout preferences only; canonical session ownership comes from the server.

**Tests:** switch during in-flight create/send, deleted last session, stale WebSocket projection, same path represented by worktree and project, active session in Recent.

## Suggested implementation order

1. Project/session PATCH contracts and attention projection.
2. Worktree attachment hardening.
3. Folder data model and grouping.
4. Search and rename UI.
5. Archive surface and bulk operations.
6. Atomic project switching and sidebar performance.

## Global implementation contract

- Node 22 erasable TypeScript; no enums, namespaces, or parameter properties; local imports include `.ts`.
- Cross-package types come from workspace packages.
- Only `packages/backend-opencode` accesses OpenCode.
- Metadata visible to the model is logged before display; projections derive from durable events.
- Extend existing `/api` and `/ws`.
- Sidebar actions and surfaces use typed slots.
- Test with `node --test` and plain `node:assert`.
