# UX-ONBOARDING — Polyth first-run and project-context audit

- Case: `UX-ONBOARDING`
- Model / role: `SOL` / Polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Polyth source: `0038e379def11a5a376e556bca7f6656bcf951ab`
- Comparison: `UX-ONBOARDING-polyth.md` at `0038e37`

## Decision

Polyth improves on polyth in three important areas. It offers an explicit
working-style choice, uses a labelled modal folder browser with a real focus
trap, and does not run credential-capable remote Git work during project
activation. A repository with an unreachable HTTPS remote opened immediately,
showed its local branch, and left `/api/health` responsive in `3 ms`.

The end-to-end first-run contract is nevertheless not ready. Project hydration
and model/agent hydration share one `Promise.all`. If a user adds a project
while model or agent discovery is still pending, the older project snapshot
later overwrites the newly added client state. The live UI changed from the
correct `sol-onboarding-git` project and `audit-main` branch to a contradictory
state with zero sidebar projects, an active branch, and a hero for
“this project.” Reload restored the server-persisted project, so this is a
recoverable **P1 state-consistency failure**, not server-side data loss.

A fresh browser on a server that already has projects also receives two
unconditional gates: persona selection and then the project picker. Persona
selection can be appropriate for a new local profile; forcing the directory
picker after the server has restored a valid active project is not. This
deliberately reproduces the interruption Polyth's polyth contract says to
avoid.

## Runtime procedure

The current web bundle was built and served from `/workspace` at
`127.0.0.1:4483` with isolated home and data directories. Google Chrome stable
exercised fresh and persisted browser contexts against a genuinely empty
project registry, a plain directory, and a Git repository on branch
`audit-main` whose `origin` was an unreachable HTTPS URL.

The available run did not expose a `computerUse` executor, so Chrome was driven
through the repository's `playwright-core` installation. The audit used
pointer and keyboard-only journeys, fresh origin storage, reloads, delayed
model/agent requests, focus inspection, API health checks, and persisted
registry checks. No model turn was submitted.

To make the boot race deterministic, `/api/models` and `/api/agents` were held
for `6000 ms` while `/api/projects` returned the initial empty snapshot. The
project was selected before those requests completed.

## Comparison with polyth

| Journey | polyth at `0038e37` | Polyth observation | Result |
|---|---|---|---|
| Genuine empty first run | Contradictory home project plus add prompt | One persona surface, then one project picker; no phantom project | Pass |
| Fresh browser, persisted server project | False add-project modal from hydration race | Persona is expected, but choosing it always forces the picker over the restored project | **P1 fail** |
| Add during slow boot | No explicit hydrated state | Late boot snapshot removes the just-added project from client state until reload | **P1 fail** |
| Project-aware destination | Project, hero, branch, mode/model, starters agree | Hero, path, branch, composer, controls, and five starters agree before a turn | Pass |
| HTTPS remote without credentials | Hidden terminal prompt stops the server | Activation performs bounded local status only; health remains responsive | Pass |
| Keyboard folder add | Path works; primary action is not in normal Tab order | Labelled path, stateful Hidden toggle, trapped focus, and normal Tab/Enter submission work | Pass |
| `Ctrl+Enter` add | Works but is the only keyboard submission route | Does nothing; normal Tab/Enter remains available | **P2 parity gap** |
| Focus after first-run completion | Lands on `BODY` | Lands on `BODY`; reusable picker correctly restores a surviving sidebar opener | **P1 fail** |
| Presentation-only journey | Must not append an event | No session was created and therefore no session event was appended | Pass |

## Root cause

### 1. Boot publishes a stale project snapshot

`boot()` awaits projects, models, and agents in one `Promise.all`, then publishes
all three results. `api.listProjects()` can finish first and retain an empty or
old array while OpenCode-backed model/agent discovery remains pending.

`addProject()` independently appends the returned project to the current store
and activates it. There is no boot generation, hydration phase, merge, or
mutation barrier. When the original `Promise.all` resolves, `setProjects()` can
replace that newer state with its stale result.

The measured sequence was:

1. `/api/projects` captured `[]`.
2. Persona selection opened the picker while models and agents remained
   pending.
3. `/tmp/sol-onboarding-git` persisted and activated successfully.
4. The hero named the project and branch `audit-main`; health returned in
   `3 ms`.
5. Late boot publication restored `projects=[]` while retaining the active
   project id and branch.
6. Reload converged to the one server-persisted project.

### 2. First-run state is browser persona state, not workspace readiness

`App` renders onboarding whenever `polyth.prefs.persona` is absent. That is a
valid browser-local preference decision, but `Onboarding.pick()` then opens
`project-picker` on every first persona choice, explicitly without considering
hydrated projects. `onboardingFirstRun.test.ts` locks in this behavior.

Project readiness is not represented in the store. An empty array can mean
“not loaded,” “loaded empty,” or “a stale snapshot just replaced a mutation.”
The picker therefore cannot decide whether it is necessary from authoritative
state.

### 3. Persona and project completion are separate, implicit transactions

Choosing a card immediately stores the persona and replaces the entire
onboarding screen with the picker. There is no selected-but-uncommitted state
or final Continue action. Escape from the first-run picker leaves the persona
committed, suppresses onboarding on reload, and opens the recoverable no-project
shell.

The shell recovery is good: both the sidebar and main hero expose named folder
actions. The state transition is still implicit. A user cancelling step two
has permanently completed step one without an explicit explanation.

## Findings

### ONBOARD-POLYTH-01 — Late boot data can erase a successful add from the UI

Severity: **P1**

The server registry remains correct, but the current page loses the new project
card and its name. The retained active id and branch let the workspace continue
rendering as if a project exists, so the screen simultaneously says “No
projects yet” and “What are we working on in this project?” This can occur on a
normal cold start because model and agent discovery is OpenCode-backed.

### ONBOARD-POLYTH-02 — Existing projects do not suppress the folder gate

Severity: **P1**

A fresh browser may need persona defaults, but it does not need to reselect a
directory already persisted on the server. In the measured existing-project
journey, boot had restored and saved the active project before persona
selection. The picker still opened and required Escape before the valid
project-aware destination became usable.

The first-run rule should be “choose a persona, then choose a project only when
the hydrated registry is empty,” not “a new browser always chooses both.”

### ONBOARD-POLYTH-03 — Git activation is isolated from remote credentials

Severity: **positive reference**

Adding the Git fixture performed local branch/status work and did not contact
its unreachable HTTPS remote. The project transition completed, branch
`audit-main` appeared, and health remained responsive. The Git service also
sets `GIT_TERMINAL_PROMPT=0` and a `30000 ms` default timeout for explicit Git
operations. This avoids polyth's server-stopping credential prompt.

### ONBOARD-POLYTH-04 — First-run focus and listbox semantics are incomplete

Severity: **P1**

The picker itself has `role=dialog`, `aria-modal=true`, a persistent path label,
an announced Hidden state, a normal primary button, and a working focus trap.
Keyboard-only path entry followed by Tab and Enter successfully opened the
plain directory.

Three boundaries remain broken:

- the first-run persona card unmounts before the dialog captures an opener, so
  Escape and successful Git-project completion both land on `BODY`;
- folder rows are `role=option`, but focus remains on the listbox and it has no
  `aria-activedescendant`, so arrow-key selection has no programmatic active
  option for assistive technology; and
- the comparison's `Ctrl+Enter` confirmation does nothing, although ordinary
  Tab/Enter submission works.

A reusable picker opened from the sidebar restored focus to that surviving
button. The defect is specifically the first-run handoff and option semantics.

### ONBOARD-POLYTH-05 — The onboarding Escape promise is false

Severity: **P1**

Re-running onboarding exposes “Keep my current setup (Esc).” Pressing Escape
does not close the screen because `Onboarding` has no Escape handler. Clicking
the button works. Visible shortcut copy must not advertise behavior the screen
does not implement.

### ONBOARD-POLYTH-06 — Personas hide tools but do not tailor starters

Severity: **P2**

The Manager persona stored a plugin set without Git, Terminal, Preview,
Schedule, GitHub, Dictation, or Events. These capabilities can be re-enabled in
settings, but they disappear from ordinary navigation and command discovery
immediately after the choice. This is stronger than tuning defaults.

At the same time, the project hero still showed the same five engineering
starters: Explore the codebase, Review my recent changes, Add tests, Debug an
issue, and Explain this project. Persona choice therefore changes capability
visibility more than the guidance it claims to personalize. It should reverse
that emphasis: preserve discoverable capabilities and tailor initial panes,
starter ordering, and response-density defaults.

## Required repair contract

1. Represent project boot as explicit `loading`, `ready`, and `failed` states.
   Do not use `projects.length === 0` as a hydration signal.
2. Prevent stale boot publication from replacing post-boot mutations. Merge by
   project id, refetch after mutation, or reject results from an older
   generation.
3. Keep persona setup browser-local and optional. After persona selection,
   await project readiness; restore an existing active project directly and
   open the picker only for a ready, empty registry.
4. Make persona selection and project selection intentionally separate. State
   what Escape preserves, or commit the onboarding version only after the
   chosen completion boundary.
5. On successful first-run selection, focus the project composer. On
   cancellation, focus a named no-project action or the restored project
   heading.
6. Give the folder listbox an `aria-activedescendant` tied to stable option ids,
   and announce selection/directory entry. Keep the current labels, toggle
   state, modal semantics, focus trap, and Tab-order behavior.
7. Wire every displayed shortcut, including the returning-onboarding Escape
   action. Add a documented direct confirmation shortcut only as an additive
   path.
8. Treat personas as reversible defaults. Preserve command and capability
   discoverability while adapting starters, initial panes, composer density,
   and suggested workflows.
9. Preserve the current Git isolation: no remote enrichment on activation,
   ignored prompt input, bounded execution, and health independent of failures.
10. Keep persona, picker, and other presentation-only transitions out of the
    session event log.

## Acceptance for the next specification

- Delay project, model, and agent requests independently across every ordering.
  Add a project during each delay and verify client/server registries converge
  without reload.
- Start with no client cache and two persisted projects. Complete persona setup
  and verify the active project opens with no directory picker or chooser flash.
- Start genuinely empty. Escape before and after persona choice, reload, and
  verify the documented persistence boundary and a focused recovery action.
- Add plain, clean, dirty, and credential-rejecting Git directories by pointer
  and keyboard. Verify exact path, branch, project id, health, and composer
  focus.
- Traverse every folder row by arrows with an accessibility-tree inspection.
  Verify the active option, Hidden state, errors, and successful selection are
  announced.
- Exercise every visible shortcut, including returning-onboarding Escape and
  any direct Open action.
- Compare every persona's visible commands, panes, composer controls, and
  starter ordering. No capability becomes undiscoverable solely because of a
  persona default.
- Compare project/session registries and ordered event logs before and after
  persona-only, cancelled-picker, and successful-picker journeys.

## Evidence

- `/opt/cursor/artifacts/polyth_onboarding_persona_first_run_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_project_picker_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_recoverable_no_project_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_hydration_race_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_project_aware_destination_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_existing_project_forced_picker_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_audit_sol.json`
- `/opt/cursor/artifacts/polyth_onboarding_keyboard_add_sol.json`

Next stage: `SOL-ONBOARDING-UX-SPECIFIER`.
