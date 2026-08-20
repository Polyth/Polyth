# Command palette, hotkeys, search, and accessibility

## Current Polyth baseline

`CommandPalette.tsx` already searches registered commands and debounced workspace files through `/api/files/search`, with grouped results and keyboard navigation. Commands come from a central registry and typed `commandPalette.commands` contributions. `@polyth/hotkeys` and a Shortcuts settings page already exist. Keep these seams.

## 1. Projects, sessions, and workspaces in the palette

**Sources:** polyth #2063; Paseo #2096, #2995.

**Acceptance criteria**

- Unscoped palette search includes commands, projects, sessions/workspaces, and files.
- Project rows show name/path; session rows show title, project, branch/worktree, labels, agent/profile, status, and archive state.
- Selecting a project switches atomically. Selecting a session switches its owning project then opens the session.
- Archived results are hidden by default and available behind an `is:archived` filter.

Use current project/session projections for loaded data. Add:

```http
GET /api/search/workspaces?q=&limit=30&pageToken=&archived=false
→ {"items":[{"kind":"project|session","id":"...","projectId":"...","title":"...","subtitle":"...","keywords":[],"updatedAt":1}],"nextPageToken":null}
```

The server matcher normalizes case/diacritics and searches only metadata plus first-user-message snippet where permitted. It never returns entire transcripts. Capture result ownership before activation to avoid project-switch races.

Palette result union gains `project` and `session`. Classes: `.palette-project`, `.palette-session`, `.palette-status`.

**Tests:** same title across projects, archived filter, branch/label match, deleted result, project switch in progress, 1,000 sessions, Unicode.

## 2. Workspace file search and file mentions

**Sources:** polyth #43; Paseo #3059.

Basic palette file search already ships. Extend it:

- `Mod+P` opens file-focused mode; general palette includes file results after commands/workspaces.
- Search scores basename, path segments, exact prefix, then fuzzy subsequence.
- Results indicate file type and relative directory; selecting opens in the configured pane.
- Composer `@` autocomplete uses the same endpoint/scoring and supports folders.

Extend `/api/files/search` response from strings compatibly:

```http
GET /api/files/search?projectId=&q=&limit=50&includeDirs=true
→ [{"path":"src/App.tsx","kind":"file","score":0.91,"matches":[[4,7]]}]
```

During migration, the client accepts either string or object. Server ignores configured heavy directories, caps traversal/time/results, and cancels stale queries. No full-file content indexing is required.

**Tests:** ignored directories, symlink loop, path spaces, empty query, stale response, exact basename ordering, folder result, keyboard open.

## 3. Sidebar Group by command

**Source:** Paseo #3063.

Register `sidebar.group-by` with subcommands for Flat, Worktree, Folder, and Status. Current mode is checked; selection updates the sidebar preference and closes the palette. Command is unavailable if the sidebar capability is disabled.

Store in `polyth.sidebar.groupingMode` (or the consolidated sidebar preference object). A plugin may contribute another grouping descriptor only if it supplies a pure grouping key/label, not arbitrary row rendering.

Test command availability, current checkmark, mode persistence, disposed contribution, and screen-reader announcement.

## 4. Searchable/customizable shortcuts

**Sources:** polyth #457; Paseo #2160.

Shortcut editor details are in `14-settings-plugins-mcp.md`. Palette integration adds:

- Search by command label, category, default key, or custom key.
- “Change shortcut…” action from each command row.
- Visible conflicts and platform-normalized key labels.
- Command hints always reflect current binding.

The hotkey resolver evaluates context (`when`) and suppresses global actions in text fields except explicitly safe Escape/submit behavior. `KeyboardEvent.isComposing` and key code 229 always bypass shortcuts.

**Tests:** composition, input focus, prefix chords, conflict precedence, reset, unknown command after plugin removal.

## 5. Accessibility contract for all new surfaces

**Sources:** polyth #1146 (focusable queue removal), #1238 (labeled rename controls), #1379 (keyboard activation), plus accessibility fixes across both inventories.

Every implementation-now UI must meet:

- All pointer actions have keyboard equivalents; drag reorder additionally has Move up/down.
- Icon-only buttons have stable accessible names and 44 px logical hit targets where layout permits.
- Dialogs use focus trap, initial focus, Escape, outside-click policy, and focus return.
- Menus use roving focus; lists/trees/tabs use the corresponding ARIA pattern.
- Status/count/color has text equivalent. Progress rings and Git states do not rely on color.
- Streaming announcements are throttled; only turn completion, request arrival, and explicit reorder/save results enter polite live regions.
- Reduced motion disables sliding/pulse/animated scrolling while preserving state changes.
- Focus remains visible under all theme tokens and is not removed on mouse interaction.
- IME composition bypasses global shortcuts and send handlers.

Add reusable primitives in `apps/web/src/components/a11y/`: `Dialog`, `Menu`, `RovingList`, `LiveRegion`, `VisuallyHidden`. Do not introduce a second component framework.

Automated DOM tests cover roles/names/focus order where available; browser walkthrough covers keyboard-only navigation at 200% zoom and reduced motion.

## Command contribution contract

```ts
interface CommandDescriptor {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  defaultShortcut?: string[];
  when?: string;
  run: { kind: "client"; handlerKey: string } | { kind: "route"; method: "POST"; path: string };
  requiresCapabilities?: string[];
}
```

Server/plugin manifests never inject arbitrary JavaScript handlers or unrestricted URLs. Client handler keys resolve through a registry. Route commands are allowlisted and go through normal permission/ownership checks.

## Suggested implementation order

1. Unified result/command descriptors and matcher tests.
2. Project/session search endpoint and palette rows.
3. Enriched file search shared with mentions.
4. Group-by and shortcut integration.
5. Shared accessibility primitives and full keyboard audit.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Use workspace package imports.
- Only `packages/backend-opencode` accesses OpenCode.
- Any search result content sent to a model is logged first; ordinary palette metadata is not model-visible.
- Extend `/api` and `/ws`.
- Commands/settings use typed contribution slots.
- Tests use `node --test` and plain `node:assert`.
