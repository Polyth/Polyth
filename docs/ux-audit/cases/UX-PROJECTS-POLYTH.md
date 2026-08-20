# UX-PROJECTS — Polyth project opening and management audit

- Case: `UX-PROJECTS`
- Model / role: `SOL` / Polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime: Polyth `0.1.0`, source `41f2c2a724ad182a79581cde6023df14a47944e5`
- URL: `http://127.0.0.1:4486`
- polyth reference: `UX-PROJECTS-polyth.md` at `73e662d`
- Scope: browse, open, create folder, clone availability, path identity,
  switching, project metadata, removal, accessibility, responsive behavior,
  persistence, deep links, and session-event safety. No product source changed.

The requested nested `computerUse` executor was not exposed to this subagent.
Google Chrome stable was therefore driven through `playwright-core` against an
isolated live runtime. The run used a separate home, data directory, browser
context, and fixtures for nested, empty, hidden, Git, case-distinct, symlinked,
broken-link, inaccessible, missing, and regular-file paths.

## Verdict

Polyth improves several parts of the polyth picker. It has a named modal
with focus containment, a labeled editable path, a Tab-reachable primary
action, a pressed-state hidden toggle, a separate New folder action, correct
case-distinct Linux registration, and a usable `390×900` layout. Creating a
folder does not automatically add it as a project, and project-only operations
leave the ordered session event log unchanged.

The project journey is not yet safe enough to specify as shipped behavior.
The picker has no breadcrumbs or clone path. Opening a project only activates
it: it creates no project-scoped session and leaves focus on `BODY`. Worse, an
unsent no-session draft survives a project switch, so text composed for one
directory is offered for submission in another.

Path state also splits. A failed path load leaves the typed invalid path in the
field while the footer and enabled Open project action still target the prior
directory. New folder accepts `../` and creates outside the displayed folder.
The registry validates only existence, so its public add route accepts regular
files; selecting a symlink and opening it directly also registers a second
identity for the same directory.

Finally, every canonical `/p/:projectId` URL goes blank on direct reload. The
SPA fallback returns `index.html`, but its `./bundle.js` and `./bundle.css`
references resolve under `/p/`. Project removal calls `location.reload()` on
that URL and reproduces the blank screen as part of the built-in flow.

## Operated coverage

| Surface | Live observation | Result |
|---|---|---|
| Picker semantics | `role=dialog`, `aria-modal=true`, name “Open a project”; path is labeled; primary action is in Tab order. | Pass |
| Initial focus | Focus lands on the folder list. | Pass |
| Breadcrumbs | Home, parent, and one editable path are present; no breadcrumb segments exist. | Gap |
| Folder navigation | Arrow selection and Enter work; pointer navigation reached `alpha/nested/deep` and returned home. | Partial |
| Primary shortcut | `Ctrl+Enter` did not open the selected project and is not documented. | Gap |
| Hidden folders | Toggle exposes `aria-pressed`, reveals `.hidden-project`, and stays on across navigation in one journey. | Pass |
| New folder | `created-only` was created, selected, and left the project registry empty. | Pass |
| Folder-name escape | `../escaped-outside-home` created a sibling outside the displayed home. | **P1 fail** |
| File collision | New folder kept input but showed raw HTTP 500 / `EEXIST` / host path. | **P1 fail** |
| Regular-file path | Error correctly says Not a directory, but Open project remains enabled for the prior home target. | **P1 fail** |
| Inaccessible path | Raw HTTP 500 / `EACCES` / host path; no Retry action. | **P1 fail** |
| Open existing | Project activates and the project-aware hero renders. No session is created and focus is `BODY`. | **P1 fail** |
| Clone | No clone control or clone route is exposed. | Gap |
| Exact duplicate | Registry count stays stable, but the chooser closes with no explanation or direct recovery. | Partial |
| Symlink duplicate | `real-project` and one-click `symlink-alias` were both registered. | **P1 fail** |
| Case-distinct paths | `caseproject` and `CaseProject` were both registered on Linux. | Pass |
| Sidebar switch | Project, URL, and hero change; a no-session draft from the old project remains in the composer. | **P0 fail** |
| Palette switch | Unified palette finds and switches projects. | Pass |
| Rename | Menu rename persists, but its input has no accessible name. | Partial |
| Color/icon/defaults | Service persists them and the sidebar renders them; no project identity editor exposes the controls. | Gap |
| Remove | Registry entry disappears and folder remains, then the forced project-URL reload leaves a blank app. | **P0 fail** |
| Direct reload | `/p/:projectId` returns an empty root with module MIME errors. | **P0 fail** |
| Event safety | Project metadata and duplicate-add journeys did not alter the session event sequence. | Pass |
| Mobile | At `390×900`, no page/dialog horizontal overflow; primary action is `52px` high. | Pass |

## Comparison with polyth

| Concern | polyth `73e662d` | Current Polyth | Decision |
|---|---|---|---|
| Opening surface | Browse, typed create-and-add, and clone in one dialog | Browse/open plus separate folder creation; no clone | Keep separate folder creation, add clone and explicit create-and-add |
| Path structure | Editable path and `..`; no breadcrumbs | Editable path, Home, parent; still no breadcrumbs | Add real synchronized breadcrumbs |
| File target | Misclassified as Create & add | Rejected, but stale prior target remains openable | Preserve typed error and disable stale submission |
| Linux case | Incorrectly folds case | Correctly keeps case-distinct paths | Preserve Polyth behavior |
| Symlink identity | Realpath dedupes aliases | Entering canonicalizes, one-click Open bypasses it | Canonicalize at registry boundary |
| Folder creation | Missing | Separate and non-registering | Keep, but validate one child name |
| Clone safety | Available, prompt-safe, no timeout | Unavailable | Add bounded cancellable clone |
| Completion | Opens a project-scoped draft; focus is lost | Opens project hero without a session; focus is lost | Create/activate a draft and focus composer |
| Project switch | Composer selector and draft model | Sidebar and palette; no composer selector; null-session draft leaks | Make drafts project-keyed and add in-context switcher |
| Identity | Name, color, icon settings persist | Rename UI only; other fields are API-only | Expose one labeled identity editor |
| Reload | Identity survives direct reload | Canonical project URL cannot load assets | Fix before relying on project URLs |

## Findings

### PROJECTS-PL-01 — A no-session draft crosses project boundaries

Severity: **P0**

The operated run typed `draft intended only for lowercase project` in
`caseproject`, then switched to `CaseProject` through the sidebar. The heading
and project URL changed, but the composer retained the exact text.

`Composer` keys restoration to `session?.id`. Both project heroes have a null
session, so a project-only switch is null-to-null and does not clear or reload
the draft. Sending then creates a session under the new active project. Store
every fresh draft under a project-scoped key and capture the visible project
with the draft. Switching must restore the destination draft or an empty one,
never carry text silently.

### PROJECTS-PL-02 — Canonical project URLs and built-in removal reload blank

Severity: **P0**

Opening a project updates the URL to `/p/:projectId`. Reloading that URL left
`#root` empty and Chrome reported that a module expected JavaScript but
received `text/html`. The SPA shell uses relative `./bundle.js` and
`./bundle.css`; under `/p/:id` those request nested paths and receive the HTML
fallback.

Settings → Projects → Remove calls `location.reload()`, so removing a project
from a canonical project URL triggers the same blank state. Asset URLs must be
origin-rooted, and removal should update the project store and select a valid
destination without a full reload.

### PROJECTS-PL-03 — Failed path validation leaves two conflicting targets

Severity: **P1**

Typing the regular-file fixture produced a correct Not a directory response
and preserved that file path in the input. The footer still showed the prior
home and Open project remained enabled. Clicking it would open the stale home,
not the path the user sees.

`load()` updates `path` only on success and does not clear `selected` or
invalidate submission on failure. Use one explicit target-state machine:
`loading`, `directory`, `non-directory`, `missing`, `denied`, or `failed`.
Only `directory` may enable Open; the path field, footer, list, and action must
derive from the same resolved target.

### PROJECTS-PL-04 — New folder accepts traversal and leaks host errors

Severity: **P1**

The New folder field accepted `../escaped-outside-home`. The server resolved
the concatenated path and created a sibling outside the displayed home while
the footer showed the unresolved `home/../…` form. A collision with an
existing file returned HTTP 500, `EEXIST`, `mkdir`, and the absolute host path.

The client must submit one child name, not a path. Reject separators, `.`, `..`,
NUL, platform-reserved names, trailing ambiguous characters, and collisions
before mutation. The server must independently enforce that the resolved
parent of the target is the requested current directory and return typed,
human-readable conflict or permission states.

### PROJECTS-PL-05 — Project identity validation stops at existence

Severity: **P1**

`ProjectService.add()` resolves the string, checks only `existsSync`, and
deduplicates by exact string. Its public route accepted the regular-file
fixture as a project. The UI registered both a real directory and its symlink
alias when the alias row was selected once and opened without first entering
it. Linux case-distinct paths worked correctly and must remain distinct.

The registry boundary must stat and realpath every candidate regardless of
client path. Require a readable directory, canonicalize symlink identity, and
apply case folding only when the host filesystem is case-insensitive. Existing
records need a migration-safe canonical identity field.

### PROJECTS-PL-06 — Open activates a project but does not complete the journey

Severity: **P1**

After Open project, the hero and composer rendered for the selected project,
but the server had zero sessions and focus was on `BODY`. This differs from
polyth's project-scoped draft destination and makes draft ownership the
client's implicit null-session state—the condition behind PROJECTS-PL-01.

Successful open must atomically validate, register, activate, create or
restore one project-scoped draft, update the URL, and focus its composer. A
failure at any step must keep the chooser and input recoverable.

### PROJECTS-PL-07 — Picker structure is better, but key semantics are incomplete

Severity: **P1**

The modal, path label, hidden pressed state, focus trap, Tab-reachable primary
action, and responsive target size are concrete improvements over the audited
polyth picker. The listbox does not expose `aria-activedescendant`, row
selection has no focused option, the parent row is excluded from arrow
selection, and the visible keyboard legend omits a project-open shortcut.
There are no breadcrumbs despite the component comment calling the path bar a
breadcrumb.

Use a real active-descendant listbox or roving option focus, include parent in
the same navigation model, announce the selected row, and document one
shortcut that submits without changing Enter-to-descend. Add segmented,
keyboard-operable breadcrumbs synchronized with direct path entry.

### PROJECTS-PL-08 — Management controls are fragmented and partly API-only

Severity: **P1**

The sidebar menu exposes session creation, worktree sessions, import, rename,
and source control. Rename persists, but its text input has no accessible
name. Color, icon, and defaults persist through the service and render in the
sidebar, yet Projects settings exposes only Remove and Open project folder.
There is no visible save state, validation state, retry, clear color/icon, or
default-model editor.

Provide one project settings surface with labeled name, color, icon, default
model/profile, worktree behavior, save status, and retry. Keep filesystem
rename separate and explicit. Update local project state in place after
rename/remove instead of reloading the application.

### PROJECTS-PL-09 — Browse errors are technical, absolute, and not recoverable

Severity: **P1**

An inaccessible directory returned raw HTTP 500 / `EACCES` / `scandir` text
with the host path and no Retry action. The regular-file response was typed as
400 but still displayed the transport wrapper and JSON. These messages expose
implementation details while leaving stale actionable state.

Map host errors to `not-found`, `not-directory`, `denied`, `conflict`,
`invalid-name`, and `transient`. Render concise copy next to the affected
control, preserve correctable input, disable invalid submission, and offer a
bounded Retry only where the state can change.

### PROJECTS-PL-10 — Project-only state remains outside model history

Severity: **positive reference / P0 guardrail**

The run created a session, recorded its ordered events, changed project
metadata, and repeated an exact add. The event arrays remained byte-for-byte
equal. Project rename, color, icon, selection, picker state, and removal are
workspace presentation state and correctly do not append model history.

Preserve this separation. Project files or metadata made model-visible later
must be appended before display or submission, but picker and identity chrome
must remain outside the session event log.

## Required specifier contract

1. Fix root asset resolution and verify direct loads of `/`, `/p/:projectId`,
   and `/p/:projectId/s/:sessionId` before building more project navigation.
2. Key every no-session composer draft by canonical project id. Switching
   restores the destination draft or empty state and can never reroute text.
3. Use one target-state machine for path input, breadcrumbs, rows, footer, and
   primary action. Submission is enabled only for a validated directory.
4. Add synchronized, keyboard-operable breadcrumbs while retaining editable
   absolute/`~` path entry and Home/parent actions.
5. Keep New folder separate. Accept exactly one child name and validate it on
   client and server; the resolved parent cannot escape the displayed folder.
6. Validate project identity at the service boundary with stat + realpath.
   Reject non-directories, dedupe symlink aliases, and preserve case-distinct
   paths on case-sensitive filesystems.
7. Add clone to the same opening surface with ignored stdin, disabled terminal
   prompts, progress, cancellation, timeout, partial-directory cleanup, and
   preserved input on failure.
8. Successful open atomically registers, activates, creates/restores one
   project-scoped draft, updates all project context, and focuses composer.
9. Exact duplicates name the existing project and offer Switch to project.
   They do not close silently or create a second identity.
10. Project switching is available in the composer, sidebar, and palette from
    one canonical registry. Project, worktree, branch, defaults, starters,
    context, session/draft, and URL settle to one destination.
11. Expose a labeled project editor for name, color, icon, model/profile
    defaults, and worktree behavior, with selected, saving, saved, invalid,
    and failed states. Filesystem rename is a separate confirmed operation.
12. Remove updates state without full reload, preserves the folder, chooses a
    valid remaining project, and offers Undo where feasible.
13. Normalize errors to user-facing typed states, keep correctable input,
    disable stale targets, and never display raw syscalls or absolute paths.
14. Use active-descendant or roving focus for the folder list, include parent
    in keyboard navigation, expose one open shortcut, and restore/focus the
    correct post-completion control.
15. Keep project-only state out of session events. Any project content made
    model-visible follows append-before-display ordering.

## Acceptance

- Load `/`, `/p/:projectId`, and `/p/:projectId/s/:sessionId` directly and
  after reload. Assets load with correct MIME types and the intended context
  rehydrates.
- Type distinct drafts in three projects with no session, switch by composer,
  sidebar, palette, Back, and direct URL, then reload. No text crosses projects.
- Navigate three levels with arrows/Enter, breadcrumbs, path entry, Home, and
  parent. Verify one announced active row and one canonical target everywhere.
- Create one folder without adding it. Reject separators, `..`, reserved
  names, file collisions, denied parents, and deleted-during-create races
  without filesystem escape or raw errors.
- Exercise exact duplicate, symlink alias, case-distinct Linux directories,
  regular file, broken symlink, inaccessible path, missing path, and
  transient stat failure at both UI and API boundaries.
- Clone valid, invalid, credential-rejecting, stalled, and cancelled remotes.
  Runtime health stays responsive and partial destinations are cleaned.
- Open a plain folder and a Git repository. Each ends at one project-scoped
  draft with composer focus and coherent project/worktree/branch/default state.
- Rename, color, icon, and change defaults by pointer and keyboard. Reload and
  verify persistence, selected-state announcements, save state, and retry.
- Remove active and inactive projects. The folder remains, no full reload or
  blank screen occurs, context moves to a valid destination, and Undo works.
- Verify picker and project management at `320/390/768/1280` and 200% zoom,
  with no clipping, lost focus, or target below `44px`.
- Compare the ordered session event log before and after all project-only
  journeys; it remains unchanged.

## Evidence

- `/opt/cursor/artifacts/polyth_projects_picker_sol_e19e_v7.png`
- `/opt/cursor/artifacts/polyth_projects_folder_escape_sol_e19e_v7.png`
- `/opt/cursor/artifacts/polyth_projects_file_path_error_sol_e19e_v7.png`
- `/opt/cursor/artifacts/polyth_projects_opened_workspace_sol_e19e_v6.png`
- `/opt/cursor/artifacts/polyth_projects_draft_switch_sol_e19e_v6.png`
- `/opt/cursor/artifacts/polyth_projects_picker_mobile_sol_e19e_v6.png`
- `/opt/cursor/artifacts/polyth_projects_audit_sol_e19e_v6.json`
- Polyth `ProjectFolderDialog.tsx`, `Dialog.tsx`, `projects.ts`, `browse.ts`,
  `Sidebar.tsx`, `Composer.tsx`, `init.ts`, `store.ts`, `router.ts`,
  `api.ts`, `pages.tsx`, `index.html`, and project/browse tests.

Next stage: `SOL-PROJECTS-UX-SPECIFIER`.
