# UX modernization extension seams

> **Status: historical specification (2026-08-20).** The architecture below
> was implemented and has since evolved: the package-facing UI seam is now
> `@polyth/web-sdk` (`defineWebPackage`/`WebPackageHost` — see
> `docs/dev/ui.md`); the `registerSlot()`-era text in this file describes the
> host-internal registry, which package features reach only through the
> web-sdk host. Mounting-matrix details remain accurate for host rendering.

- Case: `UX-EXT-SEAMS`
- Model / role: `SOL` / architecture specification
- Specified: `2026-08-20`
- Inputs: `docs/ux-audit/ARCHITECTURE-MAP.md` at
  `6b496ef367b48d7263bf1e25e993b1afe9b0cb37` and
  `docs/ux-audit/RUNTIME-BASELINE.md`
- Product source baseline: `9c658ad3c0cd042333e38b38264679c8db5c7a96`
- Scope: shell, workspace panes, UI slots, composer, and session timeline
- This is an implementation specification. It changes no product code.

## Decision

UX modernization must extend the existing registries and event-derived render
model. It must not turn `App.tsx`, `components/Main.tsx`,
`components/Composer.tsx`, `components/Timeline.tsx`, or
`components/EditorView.tsx` into feature registries.

The stable architecture is:

```text
contracts and durable SessionEvent vocabulary
  -> server append and broadcast
  -> web store and pure reducer
  -> small host components
  -> reactive registries / named slot hosts
  -> focused feature components
```

There are two different extension classes and they must remain distinct:

1. **Surfaces and panes** own navigation, activation, persistence, keep-alive,
   dirty state, and unavailable restoration.
2. **Slots** add bounded content or actions at a named point. A slot does not
   become a second router, transcript store, pane lifecycle, or network layer.

## Existing seams to preserve

| Concern | Existing authoritative seam | Required use |
|---|---|---|
| Root layout | `apps/web/src/App.tsx` | Keep as shell composition and overlay mounting only. |
| Commands and keys | `apps/web/src/commands.ts`, `apps/web/src/shell.ts`, `apps/web/src/hotkeys.ts` | Register an action once; menus, palette, and keybindings call the same command. |
| Right rail | `apps/web/src/surfaces.ts`, `components/ContextRail.tsx`, `components/railSurfaces.tsx` | Add panels with `registerSurface()` or the `workspace.right.tabs` bridge. |
| Pane state | `apps/web/src/workspace/paneStore.ts` | Reuse tab identity, activation, ordering, dirty guard, persistence, and unavailable restoration. |
| UI slots | `packages/contracts/src/index.ts`, `apps/web/src/slots.ts` | Use a declared `UiSlot`; mount a host before relying on an unconsumed slot. |
| Composer input | `components/Composer.tsx`, `components/input/AdaptiveTextInput.tsx` | Keep one IME-safe input and one send path for hero and docked variants. |
| Conversation | `apps/web/src/reduce.ts`, `components/Timeline.tsx`, `timelineWindow.ts` | Render only the replay-derived `RenderModel`; preserve suffix windowing and scroll anchoring. |
| Session I/O | `apps/web/src/init.ts`, `sync.ts`, `store.ts`, `api.ts` | Keep REST catch-up, WS sequence dedupe, and event application as the only transcript ingress. |

## 1. Shell and workspace surfaces

### Boundary

`App.tsx` owns only the durable shell regions: sidebar, workspace, right rail,
status bar, overlays, error boundary, and live region. It must not enumerate
feature pages or plugin components.

`components/Main.tsx` currently contains the `AppView` switch. Modernization
must move that enumeration into a workspace surface registry rather than add
more branches. Add these focused files:

- `apps/web/src/workspace/surfaceRegistry.ts`: a reactive registry for
  `WorkspaceSurface` descriptors; deterministic `order` then `id` sorting,
  replacement by id, disposal, capability/plugin gates, and lookup.
- `apps/web/src/components/workspace/WorkspaceHost.tsx`: selects one registered
  surface, applies project/session availability, and gives each surface a
  `ViewErrorBoundary`.
- `apps/web/src/components/workspace/builtinSurfaces.tsx`: registers the
  existing session, files, goals, multirun, fusion, walkthrough, preview, git,
  terminal, schedule, and GitHub surfaces.

`Main.tsx` then composes `Header` plus `WorkspaceHost`; it does not import every
feature view. `store.ts` may continue to persist the selected built-in
`AppView` during the first migration slice. A later widening to string surface
ids is allowed only after router, command, preference, and unavailable-surface
fallback tests exist.

The existing right rail remains separate. `surfaces.ts` and
`ContextRail.tsx` already provide the correct registry, shared
`RailSurfaceContext`, content visibility, keep-alive, and width persistence.
Do not merge right-rail panels into the main workspace registry.

### Shell rules

- Navigation contributions call registered commands; they do not duplicate
  `setActiveView`, modal state, or keyboard handlers.
- A surface declares whether it needs a project, a session, or neither. The
  host renders the standard empty state when the requirement is absent.
- A surface receives canonical `projectId` / `sessionId` and reads shared
  stores. It never accepts an arbitrary `cwd`; worktree resolution remains
  server-owned.
- Registration after initial React mount must trigger a render. Disposal must
  remove the surface and select a deterministic available fallback.
- One failing contributed surface is isolated by a local error boundary and
  cannot collapse the sidebar, composer, right rail, or status bar.

## 2. Pane lifecycle

`workspace/paneStore.ts` is the state machine and remains DOM-free. Its
serialized form stores only stable ids, kind, resource, title, order, and
active id. Buffers, React nodes, callbacks, credentials, and server responses
must never be serialized.

The missing seam is provider resolution. Add:

- `apps/web/src/workspace/paneProviders.ts`: reactive registration and lookup
  of a provider by stable provider id. A provider can resolve a resource,
  render it, report dirty state, and opt into keep-alive.
- `apps/web/src/components/workspace/PaneHost.tsx`: owns tab strip semantics,
  activation, keyboard cycling, close confirmation, provider disappearance,
  persistence, and keep-alive mounting.
- `apps/web/src/components/editor/FilePane.tsx`: owns one file document's
  loading, revision, edit, preview, conflict, and save lifecycle.
- `apps/web/src/workspace/mainSlotPanes.ts`: bridges
  `workspace.main.tabs` items to provider-backed plugin tabs.

`EditorView.tsx` becomes the file tree and open-file coordinator. It requests a
`file:<projectId>:<path>` tab from `PaneHost`; it does not own the generic tab
strip or plugin provider switch.

Pane invariants:

- Reopening a resource activates the existing tab; it does not duplicate it.
- Dirty state follows the tab through reorder, hide, and activation. Close is
  blocked until the provider confirms or the user explicitly discards.
- A removed or disabled provider restores as an honest unavailable tab. The
  host does not silently delete persisted user layout.
- A hidden keep-alive pane may retain local view state but must not create a
  second poller. Git, events, usage, and similar data come from shared stores.
- File reads and writes continue through `api.ts` with project identity and
  revision guards. A UI provider is not filesystem authority.
- `workspace.main.tabs` is a pane contribution, not raw JSX injected beside
  the tab strip. The bridge assigns a stable provider/resource id and delegates
  lifecycle to `PaneHost`.

## 3. Slot host contract

`apps/web/src/slots.ts` currently orders and disposes contributions but is not
reactive. Raw `renderSlot()` calls also force each consumer to invent keys and
failure handling. Before mounting more slots, add:

- `useSlotVersion()` backed by `useSyncExternalStore`;
- `components/slots/SlotHost.tsx`, which lists by stable item id, supplies the
  host-owned context, keys by contribution id, and isolates each renderer with
  an error boundary;
- runtime validation for slot names at the server-managed manifest boundary.

The public descriptor bridge is not a general JavaScript loader. Enabled
server-managed `UiSlotItem.module` values remain inert metadata until a
separate allowlisted module-resolution design is approved. Bundled/trusted
client registration through `registerSlot()` is the only executable path in
this modernization.

### Mounting matrix

| Slot | Host / disposition | Bounded context |
|---|---|---|
| `app.nav` | Mount in `components/Sidebar.tsx` through `SlotHost`. | Active project/session ids and compact/expanded state. |
| `session.header.actions` | Mount in `components/Header.tsx`. | Session id, status, working flag. |
| `session.list.badges` | Mount per row in `components/sidebar/SessionList.tsx`. | Session id and already-derived attention counts. |
| `composer.leading` | Replace the current raw render in `Composer.tsx` with `SlotHost`; retain location. | Session/project ids, variant, working flag. |
| `composer.trailing` | Same as leading; retain location before send controls. | Session/project ids, variant, working flag. |
| `workspace.main.tabs` | Consume only through `mainSlotPanes.ts` and `PaneHost`. | Stable descriptor metadata; no arbitrary pane state. |
| `workspace.right.tabs` | Keep the existing bridge in `surfaces.ts`. | Shared `RailSurfaceContext`, not independent fetchers. |
| `session.timeline.before` | Mount inside the timeline viewport before the windowed rows. | Session id and immutable reduced model summary. |
| `session.timeline.after` | Mount after rows and turn footer, before selection overlays. | Session id and immutable reduced model summary. |
| `session.message.actions` | Mount in the extracted `MessageActions`. | Session id, message kind/id/event seq; no mutable message object. |
| `workStatus.sections` | Mount in `WorkStatus.tsx`. | Event-derived task/subagent/turn summaries. |
| `sidebar.project.actions` | Mount in the existing project action menu. | Project id only. |
| `sidebar.session.actions` | Mount in the existing session action menu. | Session id and projection status only. |
| `settings.pages` | Keep the existing settings registry bridge. | Settings-page descriptor metadata. |
| `contextRail.tabs` | Legacy compatibility only; new panels use `workspace.right.tabs`. | Existing selected-tab callback. |
| `commandPalette.commands` | Do not mount as JSX. Adapt descriptors into `commands.ts`. | A `CommandDescriptor` registered once. |

Slot renderers may present local chrome and invoke host-provided commands. They
must not own durable domain state, fetch model output, subscribe directly to
OpenCode, or show a consequential external result that is absent from the
session log.

## 4. Composer seam

There remains exactly one `Composer` entry point and one
`AdaptiveTextInput`. The hero and docked variants are presentation modes of
the same controller; a modernization must not fork their drafts, attachments,
autocomplete, IME behavior, history, or delivery policy.

Extract responsibilities without changing the public component:

- `apps/web/src/composer/useComposerController.ts`: target-session capture,
  draft persistence, send admission, queue/steer/interrupt choice, model/agent
  selection, and attachment handoff.
- `apps/web/src/components/composer/ComposerInput.tsx`: adaptive input,
  composition-safe key handling, token autocomplete, paste, and drop.
- `apps/web/src/components/composer/ComposerToolbar.tsx`: leading/trailing
  `SlotHost`s, pickers, attachment/focus actions, and send/stop controls.
- `apps/web/src/components/composer/ComposerOverlays.tsx`: autocomplete,
  focused editor, and profile form.

The controller continues to call `sendMessage()` or the permission-checked
shell endpoint. It captures the target session at click time, removes pending
attachments only on admission, and never optimistically appends a user or
assistant message in browser state. Server acceptance and the resulting event
stream remain the display trigger.

New composer affordances use `composer.leading`, `composer.trailing`, or a
registered command. Do not add a generic “middle” slot until a concrete
layout-independent contract exists.

## 5. Timeline seam

`Timeline.tsx` becomes viewport orchestration, not the registry of every row
and action. Extract:

- `apps/web/src/components/timeline/TimelineViewport.tsx`: scrolling,
  bottom-following, suffix windowing, reveal anchoring, prompt jump, and slot
  placement.
- `apps/web/src/components/timeline/TimelineRow.tsx`: dispatches only on the
  closed, reducer-produced `RenderMessage` union.
- `apps/web/src/components/timeline/MessageActions.tsx`: built-in copy,
  rewind, and fork commands plus `session.message.actions`.
- `apps/web/src/components/timeline/ToolCard.tsx`,
  `ThinkingBlock.tsx`, and `WorkedGroup.tsx`: focused row renderers.
- `apps/web/src/timeline/rowRegistry.ts`: optional first-party renderer
  registry for already-reduced row kinds; deterministic replacement/disposal
  and no direct runtime-event input.

`session.timeline.before` and `session.timeline.after` are outside the suffix
window so contribution mounting does not change row counts or jump indexes.
Per-message actions are inside the keyed row and receive stable ids/event seq,
not array indexes.

A new durable timeline concept follows this order:

1. Add a JSON-only event payload and `RuntimeEvent`/DTO contract.
2. Append it in the session service before broadcast or HTTP success.
3. Extend the pure, replay-safe reducer with unknown-event tolerance.
4. Add a focused row type/renderer and pure reducer/windowing tests.
5. Mount only event-derived output.

A decorative action on an existing row may use a slot. New model text, tool
output, task progress, questions, permissions, or workflow results may not use
a slot to bypass the event sequence above.

## Event-log invariants

These are release blockers for every seam:

1. `SessionEvent` is the canonical conversation/work history. React state and
   projections are caches or presentation state, never a competing transcript.
2. Model-visible input/output and consequential external workflow results are
   appended before they are broadcast, returned as displayable success, or
   rendered. Streaming chunks may render only after their append.
3. User sends are persisted before `AgentRuntime.startTurn()`. The browser does
   not optimistically insert transcript rows.
4. UI state is rebuilt from ordered events through `reduce.ts`. Replay, fork,
   rewind, reconnect, and REST catch-up must yield the same model.
5. Per-session sequence numbers remain monotonic. `sync.ts` retains
   `(sessionId, seq)` dedupe and catch-up-before-live behavior.
6. Unknown event types remain safely ignorable. Extension reducers must not
   make old logs invalid or make a new event crash an older client.
7. Browser-local drafts, pane selection, widths, themes, and focus may stay
   local only because they are not model history.

## `backend-opencode` invariants

- Only `packages/backend-opencode` may spawn or attach to OpenCode, import its
  SDK/transport, consume its SSE, map backend ids, or apply backend-specific
  behavior/configuration.
- UX code in `apps/web` talks only to typed Polyth REST/WS contracts. It never
  imports an OpenCode type, calls an OpenCode URL, or treats a backend session
  id as canonical.
- New runtime behavior starts as an additive interface/event change in
  `packages/contracts`, is implemented by `packages/backend-opencode`, and is
  orchestrated by `packages/server`.
- `packages/server` owns canonical session ids, worktree/cwd resolution,
  append-before-broadcast, permissions, and projections. Adapter history is an
  import source, not UI truth.
- The existing grep gate forbidding OpenCode process/SDK access outside
  `packages/backend-opencode` remains mandatory.

## Non-goals

- No product code, schema, event vocabulary, API, styling, or runtime change in
  this specification.
- No rewrite of the shell, store, reducer, editor, composer, or timeline.
- No second composer, transcript cache, pane store, router, command system, or
  right-rail registry.
- No remote plugin JavaScript loading, dynamic npm import in the browser, or
  claim that server-managed contribution descriptors currently execute.
- No arbitrary component callbacks or React nodes in persisted pane/slot
  metadata.
- No direct filesystem access, arbitrary cwd, credential access, or OpenCode
  transport from UI contributions.
- No activation of every declared slot merely because it exists. A host,
  bounded context, reactivity, error isolation, and tests are prerequisites.
- No hardcoded theme fork; new chrome continues to consume production CSS
  variables and shared primitives.

## Implementation slices and acceptance

Each slice is independently reviewable and keeps the product runnable:

1. **Reactive slot hosts:** add registry subscription and `SlotHost`; migrate
   existing composer/context-rail consumers; mount the listed shell and
   timeline hosts. Test ordering, replacement, disposal, late registration,
   stable ids, and one-contribution failure isolation.
2. **Workspace surface host:** register built-ins and replace `Main.tsx`
   branching. Test availability gates, deterministic fallback, late
   registration/disposal, and project/session empty states.
3. **Pane providers:** add provider registry/host, migrate file tabs, then
   enable `workspace.main.tabs`. Preserve every existing `pane.test.ts` case
   and add provider disappearance, dirty close, and keep-alive tests.
4. **Composer extraction:** move controller/input/toolbar/overlay concerns
   without behavior changes. Re-run input, attachment, history, queue, and
   first-session send coverage.
5. **Timeline extraction:** move viewport/rows/actions without changing
   reduction or markup semantics. Re-run reducer and windowing coverage; add
   slot placement tests against hidden/revealed rows.

For every slice:

- use erasable TypeScript and explicit local `.ts` / `.tsx` imports;
- add DOM-free `node:test` coverage for registry/state logic;
- typecheck every changed package;
- run the OpenCode boundary grep gate;
- perform a live browser walkthrough for shell layout, focus, keyboard,
  responsive behavior, keep-alive, and replay after refresh;
- verify that a late contribution can register and dispose without editing the
  host component or losing unrelated shell state.

## Exact next task

`Fable-ux-extension-seam-implementer`: implement slice 1, “Reactive slot
hosts,” including tests and browser verification, without beginning the
workspace, pane, composer, or timeline extraction slices.
