# UX-ONBOARDING — deterministic first-run and project activation specification

- Case: `UX-ONBOARDING`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `7466c50c3e94a65de31877cd254d8242e1b22734`
- Inputs: polyth audit at `0038e37`, Polyth audit at `ea25b84`,
  and the coordinated `UX-PERSONAS` specification at `0b570e7`
- Scope: project hydration, first-run arbitration, project activation,
  folder-picker semantics, focus, failure recovery, Git isolation, and event
  safety
- This artifact changes no product code.

## Decision and user outcome

Polyth first resolves whether the project registry is loading, ready, or
failed. It never infers readiness from `projects.length`, never waits for
model or agent discovery before publishing projects, and never opens a picker
from an unhydrated empty array.

The resulting first-run sequence is:

1. mount the operational shell;
2. load the project registry independently;
3. restore a valid persisted or URL-selected project when one exists;
4. otherwise, after a successful empty result, open the folder picker once
   for this document;
5. persist, upsert, and activate a chosen project as one client transaction;
6. hand off to optional workspace-preset setup when it is unseen, or directly
   to the project composer when it is complete.

A returning browser with persisted server projects never receives the folder
picker merely because its local preferences are new. A genuinely empty
runtime receives one intentional picker, can cancel into a usable no-project
shell, and can reopen it from either named `Choose a folder…` action.

Project selection does not create a session or submit a prompt. The selected
project's name, canonical path, local branch, hero, composer, and starters
agree before the first turn. The first Send remains the point that creates a
session and admits model-visible input through the canonical event path.

## Boundary with `UX-PERSONAS`

`UX-PERSONAS-SPEC.md` at `0b570e7` is normative for workspace-preset names,
copy, cards, schema, migration, capability placement, starter ordering,
progressive disclosure, Settings, and preset persistence. This specification
does not redefine any of those decisions.

The two features meet at one boundary:

- project onboarding owns runtime/project readiness through successful project
  activation;
- optional preset setup may render only after
  `activeProjectId` identifies a project in a ready registry;
- picker visibility never reads preset state;
- preset setup never covers project loading, project failure, or the picker;
- if preset setup is unseen after project activation, focus moves to that
  panel; after Apply, Skip, Close, or Escape, its existing contract moves focus
  to the composer;
- if preset setup is already complete, project activation focuses the composer
  directly.

In particular, a completed preset must not suppress an empty-runtime picker,
and an unseen preset must not cause a picker when projects already exist.
`preset.setup` is not an input to the project-onboarding decision.

## Non-negotiable product rules

1. `loading`, `ready-empty`, `ready-with-projects`, and `failed` are distinct
   project-registry states.
2. An empty array is project data only after a successful list response. It is
   never a hydration or failure signal.
3. Project, model, and agent requests publish independently. A slow or failed
   catalog request cannot delay, erase, or roll back project state.
4. A project-list response captured before a successful mutation cannot
   overwrite that mutation.
5. A ready nonempty registry restores one valid active project without a
   picker flash. Selection order is valid session deep link, valid project
   deep link, valid saved project id, then the first server project.
6. A ready empty registry offers the picker once per document regardless of
   preset state. Cancel does not persist a fake completion value.
7. Successful Add is visible atomically: the returned project is in the
   registry and active before the dialog closes.
8. Project activation does not create a session, append an event, contact a
   remote Git endpoint, or wait for optional enrichment.
9. Automatic Git inspection is local, non-interactive, bounded, and isolated
   from `/api/health`.
10. Every dialog exit has a deterministic focus target. `BODY` is not a valid
    success or cancellation destination.
11. Loading and failure states never claim there are no projects.
12. Browser presentation state and server project authority stay separate.
    The server-returned id and canonical path win over client guesses.

## Project-registry state

Replace `projectsLoaded: boolean` plus an independently mutable array with one
canonical discriminated state:

```ts
export type ProjectRegistryState =
  | {
      status: "loading";
      requestId: number;
      projects: [];
    }
  | {
      status: "failed";
      requestId: number;
      projects: [];
      error: string;
    }
  | {
      status: "ready";
      requestId: number;
      projects: Project[];
      mutationVersion: number;
      refreshing: boolean;
      refreshError: string | null;
    };
```

`projects` has one owner. Components select it from this state; they do not
keep a second array. Initial failure has no data and uses `failed`. A refresh
failure after a ready snapshot retains that snapshot, sets `refreshError`, and
remains usable. It does not turn known data back into unknown data.

Every list request receives a monotonically increasing `requestId` and captures
the current `mutationVersion`. Only the latest request may publish. If a
mutation completed after the request began, the response is stale even when
its `requestId` is current; discard it and reconcile with a new list request.

All project mutations use registry actions:

- Add/Create upserts the server-returned project and activates it;
- Rename upserts the server-returned project in place;
- Delete removes the confirmed id and resolves a replacement active id;
- every successful mutation increments `mutationVersion`; and
- direct component calls equivalent to `setProjects(await listProjects())`
  are removed.

Unknown, duplicate, and reordered list entries are normalized by stable
project id. The server's order remains the display order. A duplicate Add of
the same canonical path reuses the server-returned existing project and does
not create a second card.

## Boot and reconciliation algorithm

Project loading starts at boot without being grouped behind model or agent
discovery:

```ts
void refreshProjects("initial");
void refreshModels();
void refreshAgents();
```

Awaiting one `Promise.all` or awaiting `Promise.allSettled` before publishing
any result is forbidden. Each request owns its own loading/error state and
publishes as soon as it settles.

Project refresh follows this ordering:

1. increment the list request id;
2. capture `mutationVersion`;
3. enter `loading` only when no ready snapshot exists; otherwise mark the
   ready snapshot `refreshing`;
4. call `GET /api/projects`;
5. ignore a response from any non-current request;
6. if `mutationVersion` changed, ignore the captured response and start one
   reconciliation request;
7. otherwise publish `ready` with the returned projects;
8. on initial failure publish `failed`; on refresh failure keep the ready
   snapshot and expose a retryable refresh error.

Add/Create follows this ordering:

1. keep the picker open and mark its primary action busy;
2. call the server with the entered path;
3. on success increment `mutationVersion`;
4. upsert the exact returned project into the ready registry;
5. activate its returned id and persist that active id;
6. close the picker only after the store transition is observable;
7. begin a non-blocking reconciliation list request; and
8. begin local branch/status enrichment without delaying the handoff.

If a list request started before step 2 and returns after step 4, it is ignored.
If it returns before the Add response, it may publish its then-correct
snapshot; the Add response still upserts the project, and no later stale
publication can remove it.

URL/session restoration begins once projects are ready and is not delayed by
model/agent catalogs. A valid session deep link may resolve its owning project.
An invalid link reports a recoverable navigation error and falls through to
the valid saved-project/first-project order; it does not manufacture an empty
first run.

## Onboarding coordinator

Use one pure decision function, with a component hook only for executing its
result:

```ts
export type FirstRunSurface =
  | "project-loading"
  | "project-failed"
  | "project-picker"
  | "preset-setup"
  | "workspace";
```

The decision table is exact:

| Registry | Valid active project | Picker offered this document | Preset setup | Surface |
|---|---:|---:|---|---|
| `loading` | no | no | any | shell with project-loading state |
| `failed` | no | no | any | shell with project error and Retry |
| `ready`, empty | no | no | any | project picker |
| `ready`, empty | no | yes/closed | any | recoverable no-project shell |
| `ready`, nonempty | no | any | any | restore an active project, then decide again |
| `ready`, nonempty | yes | any | unseen | optional preset setup |
| `ready`, nonempty | yes | any | completed | workspace |

`picker offered this document` is in-memory episode state. It becomes true
when the automatic picker opens and remains true after cancellation so an
effect cannot immediately reopen it. It is not written to local storage.
Reloading a still-empty runtime offers the picker again; the two named shell
actions remain available before and after cancellation.

An explicitly invoked Add/Open action always opens the same picker, including
after the automatic episode was dismissed. It records the connected invoker
for focus return. The automatic first-run open has no invoker and therefore
uses the no-project hero action as its cancellation fallback.

Only one shell overlay can own focus. The project picker closes before preset
setup opens. Settings, command search, session search, worktree setup, and
preset setup cannot overlap it.

## Shell states and exact primary copy

While the initial registry is loading:

- heading: `Loading your projects…`
- supporting copy: `Polyth is checking this server for saved projects.`
- no `No projects yet` copy;
- no automatic picker; and
- explicit Add actions are disabled until the result is known.

On initial registry failure:

- heading: `Couldn’t load projects`
- supporting copy: `Polyth couldn’t read the project list from this server.`
- primary action: `Retry`
- secondary status may expose a short redacted reason; and
- no empty-state or preset setup is shown.

On ready empty after picker cancellation:

- heading: `Bring your work into focus.`
- supporting copy:
  `Open a local project to start a session with its files, history, and tools.`
- primary action: `Choose a folder…`
- Sidebar action:
  `No projects yet. Choose a folder to start →`

These states are project-registry truth, not generic network-health truth.
Server health may remain responsive while model discovery is unavailable.

## Folder-picker interaction contract

First run and later Add/Open use one `ProjectFolderDialog` and one activation
command. They cannot drift into separate path forms or result paths.

The picker keeps the current useful Polyth behavior:

- title `Open a project`;
- subtitle `Choose a local folder. Polyth never uploads your workspace.`;
- labelled current-path input;
- Home and Parent actions;
- directory rows, modified times, Hidden toggle, and New folder;
- selected/current canonical target displayed next to the primary action;
- modal semantics, focus trap, and normal Tab-order primary action; and
- inline errors that leave entered path and selection recoverable.

Initial focus goes to the current-path input with its text selected. The user
can type an absolute path immediately. Pointer users can select a row; double
click enters it.

The folder list is one complete ARIA listbox:

- each row has a stable DOM id and `role="option"`;
- the listbox retains DOM focus and exposes the selected row through
  `aria-activedescendant`;
- Up/Down changes selection and scrolls the active option into view;
- Home/End selects the first/last visible directory;
- Enter enters the selected directory;
- the Parent row is a named navigation action, not a false listbox option; and
- directory changes announce the canonical current path in a polite live
  region.

The path input's Enter browses to the entered path. The primary `Open project`
button stays in normal Tab order and Enter/Space activates it.
`Mod+Enter` is an additive direct-confirmation shortcut:
`Ctrl+Enter` on Windows/Linux and `⌘Enter` on macOS. The visible legend names
it. It never replaces the primary button.

The Hidden control exposes `aria-pressed`, retains focus while content updates,
and announces `Hidden folders shown` or `Hidden folders hidden`. A browse or
create error uses `role="alert"` without closing the dialog.

Escape while naming a new folder cancels only that sub-operation. Otherwise
Escape, the Close button, and backdrop dismissal all close the picker. They
return focus to the connected invoker or, for automatic first run, the
no-project `Choose a folder…` action.

During Add, the target and controls cannot be changed, the primary label is
`Opening…`, duplicate activation is impossible, and Escape does not abandon an
in-flight request. A failure restores interaction and focuses the alert or
primary recovery target. A success never returns focus to the removed picker.

## Successful activation and focus handoff

The POST response is authoritative for project id, name, and canonical path.
Before closing the picker, the client verifies that:

- the returned id is present exactly once in the ready registry;
- `activeProjectId` equals that id;
- the URL project segment is scheduled from that id;
- stale session, branch, editor, and diff state from another project is
  cleared; and
- the project hero can derive its name from that same registry entry.

Do not create an empty session during this transition. The destination is the
project-scoped new-session hero with the existing single composer. On first
Send, session creation and `user/message` admission follow the normal path.

Local branch/status may settle after the hero appears. Until then, branch
chrome uses a neutral loading/unknown state rather than another project's
branch. A status failure leaves the project usable and offers Retry where Git
context is shown; it never rolls back activation.

After the picker closes:

- if optional preset setup is unseen, focus its labelled panel/heading;
- otherwise focus the composer textbox;
- after preset Apply/Skip/Close/Escape, its `0b570e7` focus contract owns the
  final composer handoff; and
- cancellation focuses the opener or named no-project recovery action.

Focus is applied after the destination commits, using a layout-safe queued
handoff rather than trying to focus a component that has not mounted.

## Git and process safety

Adding a project performs no fetch, pull, push, `ls-remote`, hosting lookup,
icon download, credential discovery, or other remote enrichment. The only
automatic Git work allowed in the onboarding path is local repository
detection and local status/branch inspection.

Automatic Git processes:

- use argv arrays, never interpolated shell commands;
- do not inherit a terminal as stdin;
- set `GIT_TERMINAL_PROMPT=0`;
- have an explicit timeout no greater than `30_000 ms`;
- are cancellable/ignorable when another project becomes active;
- discard results whose project id is no longer active; and
- cannot share a blocking execution lane with `/api/health`.

An unreachable or credential-rejecting HTTPS `origin` must not be contacted
during activation. Explicit remote Git commands remain separate user actions
outside this first-run contract and own their own visible progress/failure UX.

## Failure and concurrency behavior

- Project-list failure: show Retry; do not show empty state or preset setup.
- Browse failure: keep the picker open at the last valid directory.
- Add validation failure: keep path, selection, and focus context; announce the
  server's short safe error.
- Add transport failure: keep the picker open; Retry submits the same target
  exactly once.
- Add success plus reconciliation failure: keep the returned project active
  and visible, surface a non-blocking refresh warning, and retry reconciliation.
- Model/agent failure: project onboarding continues; the respective composer
  catalog shows its own unavailable/retry state.
- Branch/status failure: project onboarding continues with branch unknown.
- Project switch during enrichment: late branch, session, model, or agent data
  cannot attach to the newly active project without matching its owner id.
- Two Add attempts resolving out of order: each success upserts by id, while
  the most recent still-current user activation intent owns focus and active
  selection. Neither success can disappear.

## Persistence, API, event, and security invariants

Project records remain server-owned through the existing `/api/projects`
routes. Local storage holds only active project selection and the separate
workspace-preset records defined by `0b570e7`. No new project-onboarding
completion key is introduced.

The picker sends a user-chosen path to the localhost server. The server
resolves and validates it; the response supplies the canonical path. The
browser receives no broader filesystem authority, credentials, process
handles, or arbitrary backend session ids.

Browse, picker open/close, project-list hydration, project activation, local
branch display, and optional preset transitions append no `SessionEvent`.
They also do not create a session merely to host presentation state.

Everything later made model-visible still enters the session event log before
UI display or model submission. This work adds no OpenCode process/SDK access
outside `packages/backend-opencode` and no remote JavaScript loader.

## Minimal implementation seams

| File | Exact responsibility |
|---|---|
| `apps/web/src/projectRegistry.ts` (new) | Pure project-registry state, request/mutation generations, stale-response rejection, upsert/remove/rename transitions, and active-project resolution. |
| `apps/web/src/projectOnboarding.ts` (new) | Pure first-run surface decision and per-document automatic-picker episode; no preset schema or component rendering. |
| `apps/web/src/store.ts` | Replace `projectsLoaded` and the free array with canonical registry state; expose atomic selectors/actions and project-scoped stale-result guards. |
| `apps/web/src/init.ts` | Launch project/model/agent hydration independently; restore project/session after project readiness; route all project mutations through generation-safe actions. |
| `apps/web/src/App.tsx` | Render loading/failure/empty truth and execute the coordinator; remove `preset.setup` from picker admission; serialize picker-to-preset handoff. |
| `apps/web/src/components/Main.tsx` | Project loading, failure, and ready-empty hero copy/actions; no false empty state while unknown. |
| `apps/web/src/components/Sidebar.tsx` | Read canonical registry state; hide empty copy while loading/failed; stop direct list-to-`setProjects` writes. |
| `apps/web/src/components/ProjectFolderDialog.tsx` | One reusable picker, busy/error contract, direct-confirm shortcut, active-descendant listbox, announcements, and explicit success/cancel focus intent. |
| `apps/web/src/components/a11y/Dialog.tsx` | Support an explicit fallback focus target when the opener unmounts; preserve existing modal trap for all dialogs. |
| `apps/web/src/workspacePresets.ts`, `PresetSetup.tsx` | No schema/copy redesign; consume only the ready-active handoff already specified at `0b570e7`. |
| `packages/git/src/index.ts` | Preserve local/non-interactive/bounded Git execution and prove onboarding performs no remote command. |
| `apps/web/src/styles.css` | Loading/error/empty states, visible busy/focus/selection states, responsive picker, and reduced motion only. |

No contracts or server route changes are required unless an acceptance test
proves that the existing canonical Add response is insufficient. Do not add a
second project registry, picker, preset coordinator, composer, or session
creation path.

## Acceptance gates

### Pure and component tests

1. Table-test every coordinator row, including unseen/completed preset state.
   Changing preset state never changes loading, failed, or ready-empty picker
   admission.
2. Permute project/model/agent completion and failure order. Project state
   publishes immediately and identically in every permutation.
3. Start a list request, then resolve Add/Create/Rename/Delete before and after
   that list response. No stale response removes or reverts a confirmed
   mutation.
4. Resolve two list requests and two Add requests out of order. Only current
   list data publishes, all confirmed ids remain unique, and current activation
   intent wins.
5. Test active resolution for valid/invalid session URL, project URL, saved id,
   empty registry, and server order.
6. Mount loading, initial failure, ready empty, and ready nonempty. Assert the
   exact truth copy, picker count, Retry path, and absence of empty-state flash.
7. Mount with preset completed plus ready empty and assert automatic picker.
   Mount with preset unseen plus two projects and assert no picker followed by
   optional preset setup.
8. Exercise path Enter, list arrows/Home/End/Enter, Tab to primary, Space,
   `Ctrl+Enter`, `⌘Enter`, Hidden, create-folder Escape, dialog Escape, and
   retry. Assert active descendant and announcements.
9. Assert success focuses preset setup or composer according to setup state;
   cancellation restores the invoker/fallback; no path lands on `BODY`.
10. Instrument session APIs and event storage. Hydrate, cancel, add, activate,
    apply/skip preset, and verify no session creation or event append.
11. Instrument Git execution. Activation permits only local detection/status
    argv, ignores stdin, sets `GIT_TERMINAL_PROMPT=0`, and never invokes the
    credential helper or remote transport.

### Live interaction

Run at `1280×900`, `768×900`, `390×844`, `320×844`, short height, and 200%
zoom, with both pointer and keyboard journeys.

1. Start with empty browser storage and empty server registry. Delay the
   project response and verify loading copy with no picker/empty flash; resolve
   it and verify exactly one picker.
2. Start with empty browser storage and two persisted server projects. Delay
   projects by `0`, `50`, `250`, and `1000 ms`. Restore one active project with
   no picker frame; if preset setup is unseen, show only that optional panel.
3. Complete preset setup, remove all server projects, and reload. The project
   picker still opens once. Cancel, wait, and verify it does not reopen in the
   same document; both recovery actions reopen it explicitly.
4. Delay models and agents independently by `6000 ms`. Add a project before
   each settles. After every late response, sidebar, active id, URL, hero, and
   composer still name the added project without reload.
5. Add plain, clean, dirty, no-commit, detached-HEAD, and
   credential-rejecting-remote directories. Verify canonical path, project id,
   local branch/unknown state, and usable composer.
6. During credential-rejecting activation, verify no credential helper call,
   no terminal read, no stopped server process, and repeated `/api/health`
   responses within `500 ms`.
7. Complete Add by pointer, Tab/Enter, and the platform direct-confirm
   shortcut. Fail browse and Add once, recover in place, then succeed without
   duplicate records.
8. Inspect the accessibility tree while arrowing every row and toggling Hidden.
   Verify labelled dialog/input/listbox, active option, toggle state, alert,
   busy state, and completion announcement.
9. Verify focus after successful project selection with setup unseen and
   completed, after preset dismissal, and after every picker cancellation path.
10. Reload the canonical project URL and a second fresh browser profile.
    Registry and active project converge without a picker contradiction.
11. Compare ordered session registries and event-log digests before and after
    the entire presentation-only journey. Both are unchanged until the first
    prompt is sent.
12. At every viewport, required picker controls remain reachable in one
    positive block scroll, targets are at least `44×44px`, labels wrap, and
    there is no horizontal page scroll.

Run:

```sh
node --test apps/web/test/projectRegistry.test.ts
node --test apps/web/test/onboardingFirstRun.test.ts
node --test apps/web/test/projectFolderDialog.test.ts
node --test apps/web/test/onboarding.live.ts
node --test packages/git/test/git.test.ts
(cd apps/web && npx tsc --noEmit)
(cd packages/git && npx tsc --noEmit)
npm test
```

Passing artifacts must show delayed loading with no picker, genuine-empty
picker, restored-existing-project with no picker, stale-response resistance,
keyboard listbox state, credential-rejecting Git health, and both
picker-to-preset and picker-to-composer focus handoffs.

## Explicit non-goals

- No duplicate or replacement of the workspace-preset decisions at `0b570e7`.
- No mandatory identity survey, persona gate, or preset-owned project logic.
- No silent home-directory project, phantom draft, or onboarding completion
  key.
- No session creation, prompt submission, model call, or event append merely
  for project selection.
- No remote Git enrichment, clone flow, credential prompt, or GitHub account
  setup during local-folder activation.
- No second folder picker, project registry, composer, navigation registry, or
  capability host.
- No broad redesign of session restoration, settings, project management,
  worktrees, Git views, model discovery, or runtime connectivity.
- No filesystem authority in the browser and no weakening of localhost/path
  validation.

## Exact next task

`Fable-ONBOARDING-implementer`: implement the generation-safe project registry
and first-run coordinator, integrate the project-to-preset handoff from
`0b570e7` without duplicating its schema or UI, preserve local-only Git and
event-log invariants, and hand the live runtime plus passing artifacts to the
SOL verifier.
