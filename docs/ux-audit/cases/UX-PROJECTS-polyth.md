# UX-PROJECTS — polyth project opening and management audit

- Case: `UX-PROJECTS`
- Model / role: `SOL` / polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime baseline: `docs/ux-audit/RUNTIME-BASELINE.md`
- polyth: `1.19.0`, source `7a2e0ee138fe8a13f4dd65090fcf915a2692356f`

## Decision

polyth has a useful single project-opening surface: the same dialog can
browse and open an existing directory, create and add a typed path, or clone
and add a repository. The successful destination is strong. It activates a
project-scoped new-session draft, supports switching through the composer, and
persists the project name, color, and icon across reload.

Polyth should preserve that continuity but not copy the picker contract
unchanged. polyth has no breadcrumbs or create-folder-only action, treats
a real file as a missing directory until submission, incorrectly deduplicates
case-distinct Linux paths, leaves focus on `BODY` after completion, and exposes
several controls without durable keyboard or accessibility semantics. Clone is
non-interactive and failure-isolated, but its server process has no timeout.

## Runtime procedure

Google Chrome stable exercised a live isolated `@polyth/web@1.19.0`
runtime at `1440×900`, with reduced motion enabled. The runtime used an isolated
home, data directory, browser profile, and OpenCode process. Fixtures included:

- existing, empty, hidden, case-distinct, inaccessible, and symlinked folders;
- an existing regular file entered as a project path;
- a missing clone remote and a valid local bare Git remote; and
- multiple projects for switching and identity persistence.

The run used pointer and keyboard paths, including path entry, `ArrowUp`,
`ArrowDown`, `Enter`, `Ctrl+Enter`, Tab inspection, Escape, project switching,
settings auto-save, and direct reload. No model turn was submitted. The
requested computer-use executor was unavailable, so the live Chrome runtime was
driven through the baseline's isolated `playwright-core` installation.

## Coverage matrix

| Surface | Live observation | Result |
|---|---|---|
| Initial picker | Path starts at `~/` and receives focus. Directories are alphabetized. | Pass |
| Folder navigation | Typing `~/al` and pressing Enter enters `~/alpha/`; `..` is the only parent affordance. | Pass, no breadcrumbs |
| Hidden folders | Show hidden immediately reveals `.hidden-project`. Reopening resets the toggle. | Pass visually |
| Open existing | `Ctrl+Enter` adds an existing directory and opens its project-scoped draft. | Pass |
| Create | A missing terminal path changes the action to Create & add, recursively creates it, adds it, and opens its draft. | Pass |
| Create folder only | No action creates a folder while remaining in the picker; creation is inseparable from adding a project. | Gap |
| Exact duplicate | The action changes to Already added and disables submission. | Pass |
| Symlink duplicate | Adding `symlink-alias` stores its real path; the real target is then Already added. | Pass |
| Case-distinct paths | Both `caseproject` and `CaseProject` exist on Linux, but adding the former disables the latter as Already added. | **P1 fail** |
| Regular-file path | An existing file is shown as Create & add; submission returns raw `EEXIST: file already exists, mkdir '/…/not-a-directory.txt'`. | **P1 fail** |
| Permission error | The list shows “polyth needs access to this folder,” disables Add, and offers Try again. | Pass |
| No matches | The list shows “No matching directories” while preserving typed-path creation. | Pass |
| Clone failure | Missing remote keeps the dialog open and creates no destination. | Pass |
| Clone success | A valid remote creates the destination, adds it, and opens a draft backed by a real `.git` directory. | Pass |
| Switch project | The composer project selector switches to the clone and back without leaving the draft surface. | Pass |
| Rename/color/icon | Project name, Gold accent, and Rocket icon auto-save and survive direct reload. | Pass |
| Completion focus | After successful create/add, `document.activeElement` is `BODY`. | **P1 fail** |

## Findings

### PROJECTS-OC-01 — One opening flow carries project context end to end

Severity: **positive reference**

Open existing, Create & add, quick Add, and Clone & add all converge on the same
result: register the path, activate the project, open a project-scoped draft,
and reflect the selected project in the hero and composer. Switching projects
uses the same draft target model. Rename, color, and icon then persist as one
project identity and rehydrate correctly.

Clone also improves on the credential failure found in the onboarding audit:
Git runs with ignored stdin and `GIT_TERMINAL_PROMPT=0`. A failed remote leaves
the chooser recoverable and does not create a partial destination.

### PROJECTS-OC-02 — Path deduplication is incorrectly case-insensitive

Severity: **P1**

The picker lowercases normalized paths before duplicate comparison. That is
appropriate on case-insensitive filesystems but wrong on the audited Linux
runtime. After `/home/caseproject` is added, the distinct existing directory
`/home/CaseProject` is disabled as Already added.

Deduplication must follow the host filesystem and canonical path identity, not
one universal lowercase rule. Realpath canonicalization correctly prevents a
symlink alias from registering the same directory twice; case folding must be a
separate, platform-aware decision.

### PROJECTS-OC-03 — A file is misclassified as a creatable directory

Severity: **P1**

The browse list removes files before computing whether the typed leaf exists.
An existing regular file therefore looks indistinguishable from a missing
folder: the primary action says Create & add and remains enabled. Submission
calls recursive mkdir and leaks a raw absolute-path `EEXIST` error in the toast.

Classify the exact target with one bounded stat before choosing Add, Create, or
invalid. A file, socket, inaccessible target, broken symlink, and missing path
need distinct states. User-facing errors should identify the condition without
dumping a host path or syscall string.

### PROJECTS-OC-04 — Keyboard mechanics work, but semantics and focus do not

Severity: **P1**

The useful keyboard path is real: initial focus lands in the path field, arrows
change the highlighted row, Enter navigates, and `Ctrl+Enter` submits. The
remaining contract is incomplete:

- the path field uses placeholder text instead of a label;
- Show hidden exposes no `aria-pressed` or checked state;
- the visible primary action has `tabIndex=-1`, so Tab cannot reach it;
- directory rows contain a nested quick-Add button, creating invalid nested
  interactive controls and extra tab stops;
- the chooser has no `aria-modal` state; and
- completion loses focus to `BODY` instead of the new draft composer.

Project identity settings repeat the pattern. The settings dialog has no
programmatic name, Project Name relies on its placeholder, and color/icon
buttons expose names through `title` but no selected-state semantics.

### PROJECTS-OC-05 — The path field substitutes for breadcrumbs and folder creation

Severity: **P2**

The editable path is compact and fast for experts, but there is no segmented
breadcrumb, current-folder heading, or direct jump to an ancestor. The only
structural control is a `..` row. There is also no New folder action; entering a
missing path always creates and immediately registers it as a project.

Polyth should keep direct path entry while adding clickable, keyboard-operable
breadcrumbs and a separate create-folder flow. Creation should return to the
new folder in the picker, where the user can continue navigating or explicitly
open it.

### PROJECTS-OC-06 — Clone is safe from terminal prompts but unbounded

Severity: **P1**

The server uses `git clone --`, ignored stdin, and
`GIT_TERMINAL_PROMPT=0`, which prevents option injection and hidden credential
prompts. However, the child process has no timeout or cancellation path. A
remote that stalls without exiting can hold the dialog in Cloning indefinitely.

Clone needs cancellation, a bounded timeout, progress, and cleanup of any
partial destination. Failure must preserve the remote URL, destination, and
selected identity for correction.

## Required Polyth project contract

1. Use one project-opening surface for browse, open existing, create, and
   clone. Every successful path atomically validates, registers, activates,
   opens one project-scoped draft, and focuses its composer.
2. Keep an editable path field and add keyboard-operable breadcrumbs. The path
   and breadcrumbs always describe the same canonical location.
3. Arrow keys move one active row, Enter navigates, and the documented primary
   shortcut submits. The visible primary action also remains in normal Tab
   order.
4. Show hidden persists for the current chooser journey and exposes checked or
   pressed state. Hidden directories never appear before opt-in unless the
   typed filter itself starts with `.`.
5. Offer New folder separately from Open/Create & add. Validate names,
   separators, reserved names, permissions, and collisions before mutation.
6. Stat the exact target before deriving action language. Existing directory,
   existing non-directory, missing, denied, invalid, and transient failure are
   distinct states with bounded Retry where useful.
7. Canonicalize symlinks for identity. Apply case folding only when the host
   filesystem is case-insensitive; permit case-distinct Linux projects.
8. Clone uses `--`, ignored stdin, disabled terminal prompts, bounded timeout,
   cancellation, progress, and cleanup. No Git process may block runtime
   health or request hidden credentials.
9. Exact duplicates are disabled with the canonical existing project named.
   Opening that project is offered as a direct recovery action.
10. Project switching updates project, directory/worktree, branch, model
    defaults, starters, context, and composer target as one transaction.
11. Rename, color, icon, and default-model controls expose labels, selected
    state, save state, validation, and retry. Changes persist across reload and
    never mutate the filesystem directory name unless explicitly requested.
12. Empty, no-match, denied, invalid-path, clone-failed, and persistence-failed
    states keep the user's input and provide a precise next action.
13. Picker, switcher, and identity changes are presentation/workspace state and
    append no session event. Any project content made model-visible is appended
    to the canonical session event log before display or submission.

## Acceptance for the Polyth comparison

- Open the picker by pointer and keyboard. Verify labeled path input, labeled
  dialog, breadcrumbs, hidden-toggle state, focus containment, and reachable
  primary action.
- Navigate three levels with arrows/Enter and breadcrumbs, then go back. Verify
  one highlighted row, stable input focus, and exact canonical path.
- Open an existing plain directory and Git repository. Create a nested folder
  without adding it, then explicitly add it. Verify destination and composer
  focus.
- Exercise exact duplicate, symlink alias, Linux case-distinct directories,
  regular file, broken symlink, inaccessible path, deleted-during-validation
  path, and empty/no-match states.
- Clone a valid remote, invalid remote, credential-rejecting remote, stalled
  remote, and cancelled remote. Health remains responsive, stdin is ignored,
  timeout is bounded, and partial destinations are cleaned.
- Switch among at least three projects from the composer and sidebar. Verify
  directory, branch/worktree, model default, starter set, and context agree.
- Rename a project and select/clear color and icon by pointer and keyboard.
  Reload and verify identity, selected-state announcements, and save state.
- Compare the ordered session event log before and after project-only journeys;
  it remains unchanged.

## Evidence

- `/opt/cursor/artifacts/polyth_projects_opening_management_audit_final3_sol_0d7c.json`
- `/opt/cursor/artifacts/polyth_projects_picker_final3_sol_0d7c.png`
- `/opt/cursor/artifacts/polyth_projects_file_path_error_final3_sol_0d7c.png`
- `/opt/cursor/artifacts/polyth_projects_created_final3_sol_0d7c.png`
- `/opt/cursor/artifacts/polyth_projects_case_collision_v6_sol_0d7c.png`
- `/opt/cursor/artifacts/polyth_projects_clone_success_v6_sol_0d7c.png`
- `/opt/cursor/artifacts/polyth_projects_identity_final3_sol_0d7c.png`

Next stage: `SOL-PROJECTS-POLYTH-AUDITOR`.
