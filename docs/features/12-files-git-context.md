# Context rail, files, editor, and Git

## Current Polyth baseline

`ContextRail.tsx` already provides a vertical icon strip, typed `contextRail.tabs`, Files, Changes, Context, Usage, Events, count badges, and full-view jumps. `packages/files` exposes safe tree/read/write/search/create/delete/rename/upload routes. `EditorView.tsx` has tree browsing, syntax-highlighted read mode, manual edit/save, dirty protection, rename/delete, selection-to-chat, and drag `@path`. `packages/git` and `GitView.tsx` already provide staged/unstaged groups, stage/unstage/discard, commit, branches, basic history, worktrees, and diffs.

## 1. Declarative surface registry and right-pane tab host

**Sources:** polyth #2418; Paseo #3287.

Replace the fixed panel switch with a registry while preserving the current strip:

```ts
interface WorkspaceSurface {
  id: string;
  title: string;
  icon: string;
  placement: "main" | "right" | "either";
  singleton: boolean;
  keepAlive?: boolean;
  module: string;
  requiresCapabilities?: string[];
}
```

Add slots `workspace.main.tabs` and `workspace.right.tabs`. The shell owns `PaneTabState {instanceId,surfaceId,resource?,title?,dirty?}`; plugins contribute descriptors only. Files opened from assistant references default to the right pane. Hidden `keepAlive` tabs remain mounted but pause polling/effects through an `active` prop.

Persist browser layout under `polyth.workspace.layout.v1`: pane widths, ordered tab descriptors, active IDs, and routing preference. Never persist unsaved file content here.

Classes: `.workspace-panes`, `.pane-tabbar`, `.pane-tab`, `.pane-splitter`, `.surface-rail`. Clamp right pane to 280–900 px and restore focus to the invoking message/file.

**Tests:** unknown plugin after reload, duplicate singleton, hidden effects paused, dirty-tab close, pane resize, narrow viewport collapse, slot disposal.

## 2. Shared file/folder context actions

**Sources:** polyth #932; Paseo #3027.

Provide one `FileActionService` used by Files and Changes menus:

- New file/folder, rename, duplicate, delete.
- Copy relative path and copy absolute path only when the browser is allowed to reveal it.
- Add to chat/open in main/open in right pane.
- Discard Git changes for tracked paths.
- Reveal in OS is `platform-na` in web and must not be rendered.

Extend existing routes:

```http
POST /api/files/copy {"projectId":"...","from":"a.ts","to":"b.ts"}
GET  /api/files/stat?projectId=&path= → {"path":"...","kind":"file|dir","size":1,"mime":"...","revision":"..."}
```

Use `git mv` semantics inside `packages/git` for tracked rename only through a capability call; `packages/files` must not shell out to Git directly. Every path is project-relative and root-contained after symlink resolution. Menus are keyboard navigable and action availability is capability-driven.

**Tests:** tracked/untracked rename, cross-directory duplicate, symlink escape, case-only rename, collision, recursive delete confirmation, clipboard denial.

## 3. Revision-aware autosave and external conflicts

**Sources:** polyth #649, #2534; Paseo #2270.

Autosave text files 1.5 seconds after the last edit. Manual `Mod+S` flushes immediately. Reads return a revision derived from stat metadata/content hash:

```http
GET /api/files/read?... → {"path":"a.ts","content":"...","revision":"sha256:...","truncated":false,"binary":false}
POST /api/files/write
{"projectId":"...","path":"a.ts","content":"...","expectedRevision":"sha256:..."}
→ {"ok":true,"revision":"sha256:..."}
```

On `409 revision-conflict`, retain the draft and offer Compare, Overwrite, or Reload; never silently overwrite external edits. Disable autosave until initial load completes and for binary/truncated/too-large files. Cancel timers on path/project change, but preserve dirty buffers per tab until resolved.

Add `fileAutoSave: boolean` to `polyth.settings`; classes `.save-state.saving|saved|conflict|error`, `.file-conflict-dialog`.

**Tests:** load lag, edit then switch, two tabs same file, binary detection, failed write, external modification, rename while pending, server restart, atomic temp-file replacement.

## 4. Go to line and line-aware opens

**Sources:** polyth #933, #2000; Paseo #2309.

Adopt `EditorLocation {path,startLine?,endLine?,column?}` from the chat spec. `Alt+G` opens `GoToLineDialog`; line inputs accept `42`, `42:7`, or `42-48`. Opening centers and selects the clamped range in both read and edit modes. The location is transient tab state, not persisted file metadata.

Classes: `.go-to-line`, `.editor-line.selected`, `.editor-range`. Announce out-of-range clamping. Test empty/negative/huge lines, CRLF, final empty line, range reversal, and reopen of an existing tab.

## 5. Markdown, HTML, JSON, search count, and optional Vim

**Sources:** polyth #772, #2152, #1369, #1437, #786; Paseo #2712.

File render routing:

```ts
type FileRenderKind = "text" | "markdown" | "html" | "json" | "binary";
```

- Markdown: Source/Preview toolbar toggle using the same rich renderer as chat.
- HTML: Source/Preview with `iframe sandbox=""`; inject a restrictive CSP and `<base>` pointing only to the safe raw-file route. No scripts, forms, top navigation, or network by default.
- JSON: Raw/Tree toggle using shared `JsonTreeViewer`.
- Search: `Mod+F` reports current/total match, next/previous, case toggle, and keeps selection visible.
- Vim: feasible only after adopting CodeMirror. Add latest `@replit/codemirror-vim` then expose `fileEditorKeymap: "default"|"vim"`; do not emulate Vim in a textarea.

Persist per-file view mode under bounded `polyth.fileViewModes` and global keymap/search preferences under `polyth.settings`. Classes: `.file-view-toggle`, `.html-preview`, `.editor-search`, `.vim-status`.

**Tests:** HTML CSP escape attempts, relative assets, Markdown Mermaid/math, malformed JSON, Unicode search, zero-width match, keymap toggling with dirty text.

## 6. Changes-first Git with folder actions

**Sources:** polyth #2418, #1359, #1390.

Polyth already splits status categories and supports bulk stage. Refactor the surface so Changes is first, History/Branches/Worktrees are secondary tabs. Tree mode groups paths by folder; list mode stays available.

Add directory-aware operations:

```http
POST /api/git/stage   {"projectId":"...","paths":["src/"],"recursive":true}
POST /api/git/unstage {"projectId":"...","paths":["src/"],"recursive":true}
POST /api/git/discard {"projectId":"...","paths":["src/"],"recursive":true}
```

Server expands folders against current Git status, not the filesystem alone, and returns affected paths. Folder discard requires confirmation with file count; conflicted/untracked behavior is explicit. Keep separate keys for staged and unstaged copies of the same path.

Classes: `.changes-tree`, `.changes-group`, `.change-row`, `.change-actions`, `.pr-chip`. Use current status count for the rail badge.

**Tests:** partially staged file, nested folder, deleted files, rename pairs, conflict, untracked discard, status changes between confirmation and action.

## 7. Git graph, history, and commit actions

**Sources:** polyth #1431, #1291; Paseo #1534.

Extend log:

```http
GET /api/git/log?projectId=&limit=100&pageToken=&all=true
→ {"commits":[{"sha","parents":[],"subject","author","date","refs":[]}],"nextPageToken":"..."}
POST /api/git/action
{"projectId":"...","action":"checkout|branch|cherry-pick|revert|reset|merge|rebase","sha":"...","mode":"soft|mixed|hard"}
```

The graph lane algorithm is a pure frontend utility over ordered commit parents. Destructive actions (`reset --hard`, rebase, discard) require a typed confirmation and are disabled with working changes unless the operation supports autostash. The server uses fixed argv, never a shell-concatenated command.

Render history as listing plus a main-pane diff tab. Add `.git-graph`, `.graph-lane`, `.ref-badge`, `.commit-menu`. Preserve simple history if graph data is unavailable.

**Tests:** merge commits, octopus parents, detached HEAD, many refs, pagination overlap, failed cherry-pick/rebase state, dirty worktree, malicious ref names.

## 8. Inline review comments in diffs

**Source:** Paseo #530.

Diff line gutters allow starting a local review thread. Persist draft comments in browser storage until submitted. For GitHub-backed PRs, use the review API specified in `16-walkthrough-review-github.md`; for local diffs, “Add to chat” appends a model-visible `review/comment-added` event with `{path,side,line,body,diffDigest}` before showing it as session context.

Components: `DiffReviewThread.tsx`, `ReviewCommentComposer.tsx`; classes `.diff-comment-marker`, `.review-thread`, `.review-draft`. Comments anchor to stable hunk/digest identities and show Outdated when the diff changes.

Test deleted lines, multiline ranges, changed diff digest, unsent draft reload, permission failure, and keyboard focus.

## 9. File-to-chat drag and attachment invariants

**Sources:** polyth #963; Paseo #2275.

This is substantially already present: tree rows are draggable, file actions insert `@path`, and desktop file drops upload. Preserve and harden:

- Folder drops insert `@folder/`, never inline all contents.
- Selection-to-chat includes fenced source and line range; large/binary content inserts only a reference.
- If no active session, create one in the captured project before focusing composer.
- The eventual `user/message` stores expanded content plus `raw`, so model-visible source always reaches the log first.

Test drag from Changes, project switch during session creation, paths with spaces, huge folder, binary file, and canceled upload.

## API ownership and dependencies

- `packages/files`: path safety, revisions, file CRUD/copy/stat/raw.
- `packages/git`: Git-aware rename/actions/status expansion/history; no OpenCode access.
- `packages/server`: route composition and session/project ownership checks.
- `apps/web`: pane host, menus, editor state, diff/graph rendering.
- `@polyth/contracts`: `EditorLocation`, file revisions, surfaces, graph DTOs.

Implement pane host first, then revision-safe files, then previews/search/keymaps, then Git tree/graph/review.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Cross-package imports use workspace names.
- Only `packages/backend-opencode` accesses OpenCode.
- Log model-visible file/review context before display.
- Extend `/api` and `/ws`.
- Files/Git/pane UI is contributed through typed slots and capabilities.
- Tests use `node --test` and plain `node:assert`.
