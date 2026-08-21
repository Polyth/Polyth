# UX-ONBOARDING — polyth first-run and project-context audit

- Case: `UX-ONBOARDING`
- Model / role: `SOL` / polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime baseline: `docs/ux-audit/RUNTIME-BASELINE.md`
- polyth: `1.19.0`, source `7a2e0ee138fe8a13f4dd65090fcf915a2692356f`

## Decision

polyth has a strong project-aware destination but an unreliable first-run
gate. Adding a directory by keyboard opens a new-session draft whose hero,
project selector, branch, context card, and starter actions all reflect the
selected repository. That continuity is the behavior Polyth should preserve.

The chooser itself is not safe to copy unchanged. Its open condition runs
before persisted project settings finish hydrating, so a fresh browser profile
can receive an “Add project directory” modal even though the server restores
multiple projects and an active project moments later. The modal stays open
over the valid project-aware chat and presents the home directory as “Already
added.” On a genuinely new isolated runtime, the same ordering auto-adds the
runtime home and still leaves the add-project prompt open.

A post-add Git credential prompt produced the more serious failure. Adding a
repository whose HTTPS remote could not authenticate switched the UI to the
correct project, then stopped the foreground polyth server at an inherited
terminal prompt. `/health` and navigation hung until the hidden username and
password prompts were answered. First-run enrichment may not inherit an
interactive terminal or hold the application server hostage.

## Runtime procedure

Google Chrome stable exercised the packaged live polyth web runtime, not a
static fixture. The baseline instance at `127.0.0.1:8889` supplied the
existing-project case. A second `1.19.0` instance at `127.0.0.1:8892` used an
isolated home and data directory for first-run state.

Fresh browser contexts had empty origin storage. Persisted-profile checks
preloaded the exact project registry saved by the live flow. The audit used
pointer inspection and keyboard-only Tab, Escape, path entry, and
`Ctrl+Enter`. No model turn was submitted. The available run did not expose a
computer-use executor, so the live Chrome session was driven through the
baseline's isolated `playwright-core` installation.

## Observed journey

| Condition | Observation | Result |
|---|---|---|
| New isolated runtime | The shell painted a home-project draft, then opened “Add project directory.” The default `~/` target was already added and the empty home showed “No matching directories.” | **P1 fail** |
| Fresh browser, persisted server projects | Settings restored home plus `polyth-runtime-bootstrap-58a2`, and that repository was already active. The first-run modal still opened and remained above its valid chat. | **P1 fail** |
| Keyboard add | The path input received initial focus. Entering `/tmp/polyth-runtime-bootstrap-58a2` and pressing `Ctrl+Enter` added and activated it without pointer input. | Pass |
| Project-aware destination | The hero became “What are we working on in polyth-runtime-bootstrap-58a2?”, the selector showed the same project, and the work-status card showed branch `feat/runtime-bootstrap-58a2`. | Pass |
| Contextual launch state | Mode/model controls, composer syntax help, eight starter actions, project, branch, usage, and context-source count were visible before a turn. | Pass |
| Persisted-profile reload | With the saved project registry available synchronously, the same active project and hero restored with no dialog. | Pass |
| Add repository with unavailable HTTPS credentials | The project opened, then the server job stopped at `Username for 'https://github.com':`; `/health` timed out until the terminal prompts were answered. | **P0 fail** |
| Focus after successful add | The dialog closed and the correct draft rendered, but focus landed on `BODY`, not the composer or project heading. | **P1 fail** |

The desktop “Welcome to polyth” local/remote connection chooser is a
separate desktop-shell boot route. The packaged web runtime used for parity
starts with a ready server and therefore begins at project selection.

## Findings

### ONBOARD-OC-01 — Project selection carries context into the draft

Severity: **positive reference**

The useful onboarding boundary is the selected directory, not a generic
welcome screen. Successful selection calls one project-draft path: the new
project becomes active, the session draft targets its directory, Git branch
context appears, and starter actions become immediately available. The user
does not have to reselect the repository in the composer or create an empty
session first.

polyth also keeps the chooser reusable through the sidebar's Add project
action. First-run and later project addition use the same component and the
same resulting draft state.

### ONBOARD-OC-02 — A background Git prompt can stop the application server

Severity: **P0**

The UI transition completed before post-add repository work settled. The
foreground server subsequently entered shell job-control state `Stopped` at a
GitHub username prompt. While stopped, even `/health` produced no response.
The UI gave no credential request, progress state, failure state, or recovery
action because the prompt existed only in the server terminal.

Project onboarding must not launch credential-capable Git work with inherited
stdin. Every automatic branch, status, icon, and metadata probe must be
non-interactive, bounded by timeout, and failure-isolated from project
activation. Authentication belongs to an explicit, visible action.

### ONBOARD-OC-03 — Project hydration races the first-run decision

Severity: **P1**

`SessionDialogs` opens the chooser when home is ready and the current client
store momentarily has zero projects. Server settings then hydrate the project
store, but the dialog has no corresponding close/reconciliation path. In the
measured fresh profile, the modal remained open while local storage already
contained two valid projects and an active project id.

The result is a false first-run experience. It interrupts returning users on a
new browser/device and contradicts itself by asking for a project while the
default target is disabled as “Already added.” The decision needs an explicit
`projectsHydrated` state; an empty array is data, not a loading signal.

### ONBOARD-OC-04 — The keyboard path works but loses semantics and focus

Severity: **P1**

Initial focus correctly lands in the path input and `Ctrl+Enter` works. The
remaining accessibility contract is incomplete:

- the path textbox has no label, id, `aria-label`, or `aria-labelledby`; its
  placeholder is its only accessible name;
- Show hidden is a button with no `aria-pressed` or checked state;
- the visible desktop Add action has `tabIndex=-1`, making the undisclosed
  modifier shortcut the only keyboard submission route;
- after successful selection, focus becomes `BODY` instead of entering the
  newly opened project draft; and
- forward focus passes through the dialog's external sentinel and briefly
  reports `BODY` before wrapping, while the popup itself has no
  `aria-modal` attribute.

### ONBOARD-OC-05 — First run configures infrastructure, not working style

Severity: **P2**

After directory selection, polyth immediately exposes mode names, branch
state, compact composer syntax, and eight generic starters. This is efficient
for an experienced user, but there is no explicit choice of role, desired
workflow, autonomy level, or preferred starting task. The local/remote desktop
chooser similarly configures connectivity only.

Polyth can retain the fast project-aware path while offering optional persona
defaults. Persona selection must tune defaults and starter emphasis; it must
not hide capabilities or delay opening a known project.

## Required Polyth onboarding contract

1. Resolve runtime readiness and persisted project hydration before deciding
   whether onboarding is required. Loading, empty, restored, and failed are
   distinct states.
2. If projects exist, restore the active project directly. A fresh browser on
   an existing server must not flash or retain a first-run chooser.
3. If no projects exist, show one intentional project-selection surface. Do
   not paint a contradictory home-project chat behind it or silently add home
   while still claiming the registry is empty.
4. Successful selection is atomic from the user's perspective: validate,
   persist, activate, open one project-scoped draft, and focus its composer.
   Project name, canonical directory, branch/worktree, model, mode, starters,
   and context summary agree on that same project.
5. Optional icon, Git, skills, and metadata enrichment runs after activation,
   never blocks the transition, and exposes a bounded retryable failure only
   where useful.
6. Automatic Git processes use ignored stdin, `GIT_TERMINAL_PROMPT=0`, explicit
   credential-helper policy, cancellation, and timeouts. No prompt may stop the
   server, OpenCode process, or health endpoint.
7. Label every input independently of placeholder text. Toggle controls expose
   state, the primary Add action is in normal Tab order, the documented
   shortcut is additive, and focus stays contained while the chooser is open.
8. Escape/Close has deterministic behavior. If skipping is supported, it lands
   on an operable no-project screen with a named Add project action. Successful
   completion lands in the composer.
9. Persona setup is optional and reversible. Engineer, Manager, Creator, and
   Blank may adjust starter ordering, default panes, and guidance without
   reducing command, model, agent, or project access.
10. Onboarding presentation state appends no session event. The first
    model-visible prompt still follows the canonical append-before-display and
    append-before-submission path.

## Acceptance for the Polyth comparison

- Start with no client cache and no server projects. Verify exactly one chooser
  appears after hydration and that no phantom home project is created.
- Start with no client cache but two persisted server projects. Verify the
  active project opens directly with no chooser flash at 0, 50, 250, and
  1000 ms.
- Add a plain directory, a clean Git repository, a dirty repository, and a
  repository whose HTTPS remote rejects credentials. Health remains responsive
  and no process reads terminal input.
- Complete each add by pointer, Enter/navigation, and `Ctrl+Enter`. Verify exact
  project, branch/worktree, starters, context count, and composer focus.
- Close and Escape before completion, then reopen Add project. Verify a clear,
  recoverable no-project state and exact focus return.
- Reload and open a second browser profile. Verify project registry, active
  project, and draft target converge without a false first-run modal.
- Inspect the accessibility tree before and after Show hidden. The input has a
  persistent label, toggle state is announced, focus never escapes the open
  surface, and completion announces the selected project.
- Compare the ordered session event log before and after chooser-only journeys;
  it remains unchanged.

## Evidence

- `/opt/cursor/artifacts/polyth_onboarding_empty_project_first_run_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_existing_project_race_sol.png`
- `/opt/cursor/artifacts/polyth_onboarding_project_aware_chat_sol.png`

Next stage: `SOL-ONBOARDING-POLYTH-AUDITOR`.
