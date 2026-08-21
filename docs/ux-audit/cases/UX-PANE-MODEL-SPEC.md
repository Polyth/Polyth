# UX-PANE-MODEL — flexible workspace pane specification

- Case: `UX-PANE-MODEL`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `0ccb213e22b30759ca2643138eca4d164d3d91bd`
- Inputs: polyth audit at `0ccb213`, Polyth audit at `5012dfe`,
  and `docs/ux-audit/EXTENSION-SEAMS.md` at `241e1f2`
- Scope: Files, Git, Terminal, and Preview beside Chat; adaptive presentation,
  keep-alive, pane-provider reuse, persistence, dirty buffers, and focus
- This artifact changes no product code.

## Decision and user outcome

Files, Git, Terminal, and Preview become four canonical workspace surfaces.
Opening any of them from Chat does not replace or unmount the selected session:
the timeline, composer, pending cards, draft, and scroll anchor remain in the
same React tree.

The same surface instance has three presentations:

1. `docked`: a resizable pane beside an operable Chat column;
2. `expanded`: the pane occupies the workspace by explicit request while Chat
   stays mounted, hidden, and inert; and
3. `full-screen`: the automatic safe fallback when docking would compress or
   cover Chat, with persistent Chat and workspace navigation.

There is no fourth reduced implementation. `FilesPanel` versus `EditorView`,
`ChangesPanel` versus `GitView`, and `ContextRail.JUMPS` versus full views are
the audited contradiction and must be removed. Surface switching changes
presentation, not implementation identity.

On narrow screens the product does not attempt a smaller desktop dock. The
project/session sidebar remains a drawer, while workspace surfaces use the
full-screen presentation and a bounded bottom navigation containing Chat,
Files, Git, Terminal, and Preview. This is a replacement presentation over a
still-mounted Chat tree, not a compressed collision.

## Reconciliation with `EXTENSION-SEAMS`

This work uses, rather than bypasses, the planned slice-3 pane-provider seam.
The responsibilities remain distinct:

- `workspace/surfaceRegistry.ts` and `WorkspaceHost` continue to own primary
  destinations such as Chat and workflow pages. They do not become a dock.
- `surfaces.ts` and `ContextRail` remain the right-side surface registry and
  presentation shell. They host canonical workspace surfaces plus existing
  Context, Knowledge, Usage, and Events surfaces; they are not merged into the
  main workspace registry.
- `workspace/paneStore.ts`, the planned `workspace/paneProviders.ts`, and
  `components/workspace/PaneHost.tsx` own tab/resource lifecycle inside the
  canonical Files surface and `workspace.main.tabs`.
- `EditorView` is migrated as specified by slice 3: it becomes the file-tree
  coordinator, while `FilePane` and `PaneHost` own documents and generic tabs.
  No second tab store or plugin-tab host is introduced for this feature.

The flexible model therefore has two levels with different jobs: a surface
chooses Files/Git/Terminal/Preview, and a provider-backed tab chooses a resource
inside a surface. Surface selection must not be encoded as a fake file/plugin
tab, and a pane provider must not decide dock versus full-screen geometry.

Implementation order is mandatory:

1. land or reuse slice-3 provider resolution and migrate existing file tabs;
2. register the existing full Files/Git/Terminal/Preview components as the four
   canonical right-side surfaces;
3. route every launcher to those registrations and remove reduced duplicates;
4. add adaptive dock/expanded/full-screen presentation and scoped persistence.

## Canonical surface inventory

| Surface id | Canonical component | Internal lifecycle | Removed duplicate |
|---|---|---|---|
| `files` | `EditorView` coordinator + provider-backed `FilePane` resources | File tabs use `PaneHost`; buffers remain mounted; reads/writes retain revision guards. | `FilesPanel` registration and its independent editor/tree state |
| `git` | `GitView`, made pane-size responsive | Selected file/diff, commit draft, layout, and worktree state stay in this instance; Git status remains shared. | `ChangesPanel` registration and `gitDiffPath` split ownership |
| `terminal` | `TerminalView` | Terminal tabs, PTY ids, reconnect state, scrollback, rename, and input remain mounted while hidden. | `ContextRail.JUMPS` full-view routing |
| `preview` | `PreviewView` | URL, browser id/frame revision, inspector state, and project server identity remain mounted while hidden. | `ContextRail.JUMPS` full-view routing |

`Context`, `Knowledge`, `Usage`, and `Events` remain ordinary contextual
surfaces. This specification does not force them into the workspace bottom
navigation or into provider-backed file tabs.

Every workspace-surface descriptor adds presentation metadata without moving
layout policy into the component:

```ts
interface WorkspacePanePresentation {
  kind: "workspace";
  defaultRatio: number;
  minWidth: number;
  preferredMaxWidth: number;
  keepAlive: true;
  escape: "close" | "content";
}
```

Use these starting values:

| Surface | Default ratio of post-sidebar workspace | Content minimum | Preferred maximum | Escape |
|---|---:|---:|---:|---|
| Files | `0.60` | `380px` | `760px` | close |
| Git | `0.40` | `340px` | `640px` | close |
| Terminal | `0.60` | `380px` | `760px` | content |
| Preview | `0.45` | `380px` | `760px` | close |

Ratios initialize only a missing preference. A remembered pixel width wins,
then is capped by current geometry. Contextual surfaces retain their existing
defaults and do not inherit these workspace values.

## State and command model

Add one command path, `openWorkspacePane(surfaceId, resource?)`, plus
`closeWorkspacePane()`, `expandWorkspacePane()`, and
`collapseWorkspacePane()`. Header controls, the rail, bottom navigation,
Sidebar Git/worktree actions, palette/file references, Settings links, and
hotkeys all call these commands. They do not call `setActiveView()` directly
for the four workspace surfaces.

`openWorkspacePane()`:

1. validates that the surface is registered, enabled, and of kind
   `workspace`;
2. keeps or activates the `session` primary surface so Chat is the companion;
3. opens the optional provider resource through the existing pane coordinator;
4. records the invoking element for deterministic focus return; and
5. chooses docked or full-screen from measured geometry.

Reopening the active surface does not create another instance. A rail launcher
may close the surface when activated again; bottom-navigation activation of
the already current item leaves it open. The visible close action is always
available.

Remove Files, Git, Terminal, and Preview from the primary-view navigation only
after all call sites use the command. A stored legacy `activeView` with one of
those ids migrates once to `activeView:"session"` plus the corresponding open
workspace surface. Unknown/disabled ids fall back to Chat without deleting
other scoped preferences.

`openEditorFile(path, location)` becomes a compatibility adapter that opens
the `files` surface and the stable `file:<path>` provider resource. It never
sets the primary view. `openChanges(path)` similarly opens `git` and selects
that exact diff in the canonical Git instance.

## Dock admission and resize

Dock admission is container-geometry based, not a viewport, user-agent, hover,
or pointer test. `ResizeObserver` measures the post-sidebar workspace available
to Chat plus the pane. Let:

```text
chatFloor = 320px
chrome = separator width + safe-area inline insets
maxPane = measuredWorkspaceWidth - chatFloor - chrome
candidate = min(rememberedOrDefaultWidth, preferredMaxWidth, maxPane)
dock = candidate >= surface.minWidth
```

The launcher strip is outside `measuredWorkspaceWidth` if it is a sibling and
inside `chrome` if it is not; it may never be subtracted twice. Sidebar width,
zoom, user font size, and safe-area changes are captured by measurement rather
than copied constants.

Before making a dock interactive, a layout-phase guard verifies:

- Chat's content box is at least `320px`;
- timeline and composer have nonzero visible boxes;
- every visible composer action is wholly inside Chat's clip rectangle; and
- each action center hit-tests to itself or a descendant.

Failure promotes to full-screen before pointer input is accepted. Overflow
clipping is never treated as success. A remembered `640px` Files width is
clamped when possible and falls back when its content minimum plus the Chat
floor cannot both fit.

The separator is a named `role="separator"` with vertical orientation,
`aria-valuemin`, `aria-valuemax`, and `aria-valuenow`. Pointer drag and
Left/Right arrows resize by `16px`; Shift+arrow resizes by `64px`; Home and End
select the current minimum and maximum. Crossing below either invariant
promotes to full-screen rather than squeezing Chat. Collapse after expansion
returns to the exact preferred dock width, re-capped for current geometry.

## Adaptive presentation

### Wide and admissible

At `1440×900` and any measured width that admits the selected surface, Chat and
the dock are siblings. Chat retains one timeline and one composer. The pane
uses the remembered width, the launcher strip remains visible, and Expand is a
named action. Surface switches reuse kept-alive bodies and do not move or clone
Chat.

### Wide but not admissible

When a content minimum and the `320px` Chat floor cannot coexist, the surface
uses the full-screen workspace layer. It has a first focusable
`Back to Chat` action, surface title, Collapse/Dock when geometry later admits
it, and the same surface body that was docked. Chat stays mounted under the
layer with `inert` and `aria-hidden=true`; it consumes no hit area.

Resizing back to admissible width does not change mode behind the user's back
after an explicit Expand. An automatic full-screen fallback may automatically
return to docked only if the user has not interacted inside it since the
fallback; otherwise it exposes `Dock beside Chat`.

### Compact and phone

At `max-width:820px`, all four workspace surfaces are full-screen. No pane,
separator, or desktop rail width is reserved. The session drawer remains a
separate modal and is mutually exclusive with the workspace layer.

A bottom navigation occupies one bounded row above the status/safe area:

- Chat, Files, Git, Terminal, and Preview appear in that order;
- each target is at least `44×44px`, has a visible short label and full
  accessible name, and reports `aria-current="page"` only when visible;
- five targets fit without horizontal page scroll at `320px`; and
- selecting Chat hides the workspace layer and restores the last Chat focus
  target or composer without remounting either tree.

The bottom navigation is navigation, not a modal dialog. Hidden Chat and hidden
workspace surfaces are inert and absent from the accessibility tree. A panel
picker, project drawer, settings dialog, and workspace layer may not overlap
as simultaneously active shell surfaces.

At short heights and 200% zoom, surface content scrolls in one positive block
axis above the bottom navigation. Toolbars may wrap; primary actions and the
bottom navigation may not be clipped or covered.

## Keep-alive, drafts, and dirty buffers

Visited workspace surfaces stay mounted while their plugin remains enabled.
Hiding a surface uses an inert/hidden wrapper, not conditional component
removal. There is one instance per scoped surface, including during dock,
expanded, and full-screen transitions.

Keep-alive does not authorize duplicate polling:

- Git uses the existing shared Git-status source;
- file tree/revision checks have one owner per visible workspace scope and
  pause while the document is hidden;
- Preview's UI-only console polling pauses when its inspector is hidden, while
  the canonical browser session/frame subscription may stay attached; and
- Terminal keeps one WebSocket per terminal id and never reconnects merely
  because presentation mode changed.

File/provider identity is scoped by canonical `projectId` and
`sessionId ?? "project"`; no arbitrary cwd is stored in the browser. Switching
sessions or worktrees does not clear another scope's cache. Returning to a
scope restores its exact tabs, order, active resource, editor mode, selection,
scroll position, preview mode, and dirty buffer. Buffers from one scope never
appear in another.

Dirty file tabs:

- retain their buffer and dirty marker through resource, surface, session, and
  presentation switches in the same page;
- block file-tab close until Save, Discard, or Cancel;
- do not block hiding the workspace surface because hiding does not discard;
- retain revision-guarded autosave, IME pause, conflict, external replacement,
  deletion, Reload, Overwrite, Recreate, and Retry behavior; and
- trigger a `beforeunload` warning while an unsaved non-autosaving buffer
  exists.

The pane-state serialization remains metadata-only as required by
`EXTENSION-SEAMS`: no file buffer, React node, callback, credential, response,
or arbitrary cwd is stored in `paneStore`. Direct reload restores tab metadata
and revision-guarded saved/autosaved content; an uncommitted in-memory buffer
is protected by the unload warning rather than silently serialized into pane
preferences.

Pane transitions never unmount the composer and never rely on its `250ms`
debounce. Add a synchronous draft flush for pagehide/unmount and any legacy
navigation adapter. Text, attachments, explicit shell mode, model/agent/profile
selection, and pending cards remain exact when moving Chat → surface → Chat.

Timeline position is stored per session as a stable message anchor plus offset
and an at-bottom flag, not a raw global scroll position. Full-screen and
expanded presentation changes preserve the live DOM scroll position; direct
reload reapplies the stable anchor after event replay/window growth.

## Persistence

Replace global pane-width/open persistence with a versioned, project-scoped
record:

```json
{
  "version": 1,
  "openSurface": "files",
  "expanded": false,
  "widths": {"files": 612, "git": 420},
  "lastResource": {"files": "file:src/app.ts", "git": "changes"}
}
```

The storage key is `polyth.workspacePane.v1.<projectId>`. Provider-backed tab
metadata remains in the slice-3 PaneHost record scoped by
`<projectId>:<sessionId-or-project>`. Parse at most 64 width/resource entries,
reject non-finite sizes, clamp on use, and ignore unknown fields. One-time
migration may read `polyth.railPrefs`; it must not copy one project's widths
into every project or restore an unavailable surface as visibly open.

Persist preferred width, not a temporary geometry clamp. Persist an explicit
Expand choice, but never persist an automatic narrow full-screen fallback as
user intent. Project A's surface, URL, tab, terminal, diff, and width state must
not leak into project B.

## Accessibility and focus

- Workspace launchers have stable names, visible focus, tooltips, and truthful
  pressed/current state. A pressed launcher always has visible surface content.
- Surface bodies are labelled regions in docked mode. The automatic
  full-screen layer is a navigation destination, not falsely `aria-modal`;
  background content is still inert while covered.
- Close by button, launcher toggle, Back to Chat, or non-terminal Escape
  restores focus to the exact invoker when connected, otherwise the matching
  launcher, otherwise Chat's composer.
- Terminal consumes Escape. Its visible Back/Chat and close actions plus the
  global workspace-pane shortcut remain reachable without sending Escape to
  shell chrome.
- Expand moves focus only when the focused element would become hidden.
  Collapse keeps focus on the same provider control when possible.
- Inactive kept-alive bodies use `inert`, `aria-hidden=true`, and no visible
  geometry. They cannot retain sequential focus.
- Dirty state, active surface, conflict state, additions/deletions, and focus
  never rely on color alone.

## Event, API, extension, and security invariants

Pane open/close, surface/resource selection, resize, reorder, expansion,
preview navigation, terminal focus, draft text, dirty buffers, and scroll
anchors are presentation state. They append no `SessionEvent`.

Any pane action that makes content model-visible still uses the existing
append-before-display/submission path. `Add file/selection to chat` changes the
browser draft or attachment set only; sending it follows normal durable
`user/message` admission. Consequential Git, terminal, or browser results that
are shown as model work must already exist in the canonical session event log.

Providers receive canonical project/session ids and use typed `api.ts` calls.
They do not receive filesystem authority, credentials, arbitrary cwd, or
backend session ids. No OpenCode process, SDK, SSE, endpoint, or type leaves
`packages/backend-opencode`.

`workspace.main.tabs` contributions resolve only through the slice-3 provider
bridge. Server-managed module metadata stays inert; this specification does
not add a remote JavaScript loader.

## Minimal implementation seams

| File | Exact responsibility |
|---|---|
| `apps/web/src/workspace/paneStore.ts` | Preserve the DOM-free tab state machine and compatibility parsing; support stable provider kinds without serializing buffers. |
| `apps/web/src/workspace/paneProviders.ts` | Slice-3 reactive provider registration/lookup and availability; no layout decisions. |
| `apps/web/src/components/workspace/PaneHost.tsx` | Provider-backed tab strip, dirty close, keyboard cycling, unavailable restoration, scoped persistence, and kept-alive resource bodies. |
| `apps/web/src/components/editor/FilePane.tsx` | One file document's read/edit/preview/revision/conflict/save lifecycle. |
| `apps/web/src/components/EditorView.tsx` | File tree and open-resource coordinator around the shared `PaneHost`; no generic tab implementation. |
| `apps/web/src/workspace/mainSlotPanes.ts` | Trusted `workspace.main.tabs` descriptors to provider-backed resources. |
| `apps/web/src/surfaces.ts` | Add workspace presentation metadata and pure workspace/context filtering; retain reactive registration. |
| `apps/web/src/components/railSurfaces.tsx` | Register canonical `EditorView`, `GitView`, `TerminalView`, and `PreviewView`; remove `FilesPanel`/`ChangesPanel` registrations. |
| `apps/web/src/components/ContextRail.tsx` | Shared surface model, keep-alive bodies, dock admission, separator, expand/full-screen shell, focus return, and no `JUMPS`. |
| `apps/web/src/workspace/panePrefs.ts` (new) | Versioned project-scoped open surface, preferred widths, expansion, and last-resource parsing/persistence. |
| `apps/web/src/components/Header.tsx` | Registry-backed workspace launchers; primary navigation no longer marks a hidden full view active. |
| `apps/web/src/components/workspace/WorkspaceBottomNav.tsx` (new) | Compact Chat/workspace navigation using the same registered surface model. |
| `apps/web/src/store.ts`, `shell.ts` | One workspace-pane command path and legacy adapters; no second registry. |
| `apps/web/src/components/Composer.tsx` | Synchronous draft flush safety only; preserve the one composer/input/send path. |
| `apps/web/src/components/Timeline.tsx` | Stable per-session anchor persistence and restoration without changing event reduction. |
| `apps/web/src/styles.css` | Dock/full-screen geometry, `320px` Chat floor, inert hidden bodies, bounded bottom navigation, responsive inner surfaces, and reduced motion. |

Delete `FilesPanel.tsx` and `ChangesPanel.tsx` only after their unique actions
are present in the canonical Files/Git components and all imports are gone.
Do not modify contracts, server, session, or backend packages unless an
acceptance failure proves an independent existing API defect.

## Acceptance gates

### Pure and component tests

1. Preserve every existing `pane.test.ts` case. Add provider late
   registration/replacement/disposal, unavailable restoration, dirty close,
   scoped cache, and keep-alive identity tests.
2. Table-test dock admission at the exact boundary, including persisted
   `240/344/640/9999/NaN` widths, sidebar changes, safe-area insets, zoomed
   container sizes, and every surface minimum.
3. Test project-scoped preference parse, clamp, migration, unavailable surface,
   unknown field, and project-isolation cases.
4. Assert every Files/Git/Terminal/Preview launcher calls the shared command;
   `ContextRail.JUMPS`, reduced surface registrations, and direct
   `setActiveView()` calls for those destinations are absent.
5. Mount Chat and one canonical surface, switch all four surfaces, close,
   reopen, expand, collapse, and verify one composer, one timeline, one
   component instance per visited surface, and no inactive focusable body.
6. Instrument shared Git/file/Preview/Terminal sources and verify surface
   switching does not create a second poller, socket, or duplicate request
   owner.

### Live geometry and interaction

Run at `1440×900`, `1200×900`, `1101×900`, `1024×900`, `1000×900`,
`900×900`, `820×900`, `768×900`, `390×844`, and `320×844`, plus a
`720×450` CSS viewport at device scale factor `2`.

1. Open Files, Git, Terminal, and Preview from an active multi-turn Chat.
   Dock where admissible; otherwise show the full-screen path. At no sample may
   pane content cover or win the center hit test of a Chat control.
2. Whenever docked, measured Chat width is at least `320px`, timeline and
   composer are visible, and all composer controls are inside and hit-testable.
   Root, app, workspace, header, composer, and bottom navigation have no
   horizontal page scroll.
3. Seed Files width `640px`, then exercise `1200`, `1101`, `1000`, and `900`
   without reload. The width clamps or promotes according to measured
   invariants; it never becomes the audited `244/145px` Chat collision.
4. At `820`, `768`, `390`, and `320`, each surface is full-screen with the
   bounded bottom navigation. Chat restores the exact timeline anchor, draft,
   attachments, focus, and pending-card state. No selected control targets a
   zero-size body.
5. Type a fresh composer draft and immediately open/switch/expand/close every
   surface before the debounce. The exact text and pills remain. Reload and
   verify the synchronous flush and stable timeline anchor.
6. Edit two files without saving; switch file tabs, Files → Git → Terminal →
   Preview → Files, switch sessions/worktrees and back, resize through every
   mode, and verify both exact buffers, dirty markers, IME state, and close
   guards. Verify no buffer appears in the other scope.
7. Trigger external file replacement, deletion, conflict, and check failure.
   Reload/Overwrite/Recreate/Retry remain attached to the correct kept-alive
   file resource after surface switching.
8. Start a terminal process and Preview/browser session. Switch surfaces and
   presentations; verify one PTY/socket, unchanged terminal id/scrollback, one
   browser id, unchanged URL/frame progression, and no restart.
9. Resize by pointer and keyboard, Expand, Collapse, Back to Chat, launcher
   toggle, close button, and non-terminal Escape. Width restoration and focus
   return are exact. Terminal Escape reaches the PTY.
10. Reload the canonical session URL with a pane open. Restore project/session,
    active surface, preferred width, explicit expansion, tabs, selected
    file/diff/terminal, Preview URL, Chat anchor, and composer draft without
    cross-project leakage.
11. Compare the ordered session event log byte-for-byte before and after the
    entire pane-only journey. It is unchanged.
12. With reduced motion, dock/full-screen/expanded geometry is final in the
    first frame. With normal motion, any transform/opacity transition is at
    most `160ms` and never delays focus or state truth.

Run:

```sh
node --test apps/web/test/pane.test.ts
node --test apps/web/test/surfaces.test.ts
node --test apps/web/test/workspacePane.test.ts
node --test apps/web/test/workspacePane.live.ts
(cd apps/web && npx tsc --noEmit)
npm test
```

The live gate records geometry, hit-test targets, focus owner, mount ids,
network/socket counts, scoped preference snapshots, and before/after event-log
digests. Passing screenshots are required for docked `1440/1200`, fallback
`1000/900`, and full-screen `390/320`.

## Explicit non-goals

- No polyth DOM/CSS copy, fixed breakpoint-only dock admission, `380px`
  pane painted over Chat, or pressed control targeting hidden content.
- No second Files tree/editor, reduced Git implementation, terminal/preview
  jump, pane registry, tab store, composer, transcript cache, or poller.
- No Files/Git/Terminal/Preview main-surface branch after migration; workflows
  may remain primary workspace surfaces.
- No serialization of dirty file content in pane metadata, silent dirty close,
  cross-project/session buffer reuse, or arbitrary cwd persistence.
- No new session event, endpoint, runtime behavior, permission policy, browser
  authority, filesystem authority, or OpenCode boundary exception.
- No remote plugin JavaScript loader or execution of server-managed module
  metadata.
- No broad theme, composer-controller, timeline-row, slot-host, or workflow
  redesign. The composer draft flush and timeline anchor are bounded continuity
  repairs required by this pane model.

## Exact next task

`Fable-PANE-MODEL-implementer`: implement this specification through the
slice-3 pane-provider seam, preserving the verified slice-2 workspace surface
host and the session event-log invariants, then hand the live runtime and
passing artifacts to the SOL verifier.
