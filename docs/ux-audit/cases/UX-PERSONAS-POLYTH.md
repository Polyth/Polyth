# UX-PERSONAS — Polyth persona and progressive-disclosure audit

- Case: `UX-PERSONAS`
- Model / role: `SOL` / Polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime: Polyth `0.1.0`, source `9c658ad3c0cd042333e38b38264679c8db5c7a96`
- URL: `http://127.0.0.1:4401`
- polyth reference: `UX-PERSONAS-polyth.md` at `3228159`
- Scope: first-run choice, Engineer/Manager/Creator/Blank effects, switching,
  progressive disclosure, accessibility, responsive behavior, persistence,
  and model-visible event safety. No product source changed.

The requested nested `computerUse` executor was not exposed to this subagent.
The isolated live Chrome fallback from the runtime baseline was driven with
Playwright. It exercised the first-run screen at `1280×900` and `390×900`,
selected Manager through the UI, loaded all four persisted choices, inspected
their live composer and plugin states, and recorded no console errors, page
errors, or request failures.

## Verdict

Polyth has implemented the four proposed choices, persistence, switching, and
a discoverable plugin picker. It does not yet satisfy the persona contract.
First run is a mandatory identity choice: `App` refuses to render the workspace
until one of Engineer, Manager, Creator, or the subordinate “blank workspace”
path is stored. There is no neutral Skip action.

Manager and Creator are still forced through developer vocabulary. Manager's
card says `diffs`, `git`, and `terminal`; Creator's card says `model names` and
`jargon`. After selection, Manager gets the full expert composer grammar.
Creator hides Model, Agent, Profile, and that grammar, but the header still
exposes every technical workspace view as icon tooltips/accessibility names.
The only route back to hidden capabilities is a flat, icon-triggered Plugins
menu. This is inconsistent hiding, not progressive disclosure.

The choices also over-promise adaptation. They replace one plugin allow-list,
and Creator additionally switches the composer to `simple`. They do not alter
density, shortcuts, starter actions, model, agent, or profile. Presentation
state stays local and does not alter model instructions, which is the correct
event-safety baseline to preserve.

## Live choice effects

| Choice | Enabled optional plugins | Composer | Operated result |
|---|---|---|---|
| Engineer | Goals, Files, Git, Preview, Terminal, Context, Usage, Events, Multi-Run, Fusion, Walkthrough, Schedule, GitHub, Dictation, Knowledge | Full Model/Agent controls and `! / # @` grammar | Broad expert surface |
| Manager | Goals, Files, Context, Usage, Multi-Run, Fusion, Walkthrough, Knowledge | Same full expert controls and grammar as Engineer | Developer jargon remains; Git/Terminal are removed only from plugin-gated surfaces |
| Creator | Files, Preview | Model/Agent/Profile hidden; plain-language placeholder | Simplified composer, but unchanged technical header and generic developer starters |
| Blank | Files, Context, Usage | Full expert controls and grammar | Not blank and not equivalent to an unselected neutral state |

All four choices retain the `Add or remove plugins` button. Activating it opens
one flat list of every panel/workflow name. The user can recover hidden tools,
but only after discovering an icon-only plus control and understanding the
plugin taxonomy.

## Comparison with polyth

| Concern | polyth `3228159` | Current Polyth | Decision |
|---|---|---|---|
| First question | Concrete Local/Remote setup | Mandatory job-identity choice before project selection | Follow polyth's operational sequencing; make the preset optional |
| User framing | Task verbs and observable state | Engineer, Manager, Creator, Blank | Use outcome presets, not identity nouns |
| Neutral path | No persona required | “Start from a blank workspace” is required if no role fits | Rename to No preset and make it a real Skip |
| Manager language | Plan, catch up, weigh options | `diffs`, `git`, `terminal`, full token grammar | Fail: plain-language requirement is unmet |
| Creator language | Intent-first task verbs | Says `model names`/`jargon`; technical views remain in header semantics | Fail: jargon is hidden selectively, not progressively |
| Capability model | No persona filters tools | Plugin allow-lists remove most entrances per choice | Keep all capabilities available; vary ordering and initial detail |
| Model defaults | Explicit model and agent settings | Persona does not alter model/agent/profile | Keep Polyth's safe behavior |

## Findings

### PERSONAS-PL-01 — First run is trapped behind a mandatory identity choice

Severity: **P0**

When `polyth.prefs.persona` is absent, `App` returns only `Onboarding`. The
workspace, project picker, runtime status, and recovery surfaces cannot render.
The screen has no Skip action. “Start from a blank workspace” still writes the
`blank` persona and its four-plugin default, so it is neither blank nor
unselected.

The operated Manager click immediately persisted nine plugins and opened the
project folder dialog. There is no review of what changed. Make this an
optional starting preset after operational setup; skipping must store no
identity and open the standard workspace.

### PERSONAS-PL-02 — Manager and Creator copy teaches jargon while disclaiming it

Severity: **P1**

The Manager card requires the user to understand what it means to have
“risk checks instead of diffs — no git, no terminal.” Those implementation
terms are not necessary to explain goals, progress, cost, or decisions.

The Creator card says “No model names, no jargon,” putting the hidden concepts
into the primary choice itself. Its live workspace then exposes Git, Terminal,
Multi-run, Fusion, GitHub, and other view names through header titles and
accessible names. Plain language must describe the outcome first; expert terms
belong behind a named `Show technical options` disclosure.

### PERSONAS-PL-03 — Plugin filtering and header navigation disagree

Severity: **P0**

`applyPersona` replaces `prefs.plugins`, and the rail/palette use that list to
filter surfaces and commands. `Header.VIEW_GROUPS` does not read the list and
always renders Chat, Files, Git, Terminal, Preview, Goals, Multi-run, Fusion,
Walkthrough, Schedule, and GitHub. A Creator therefore appears to have only
Files and Preview in the rail while still having every technical header icon.

This produces neither a reliable restricted layout nor progressive
disclosure. One canonical capability registry must drive every entrance.
Presets may reorder and de-emphasize entries, but they must not make the same
capability present in one navigation system and absent in another.

### PERSONAS-PL-04 — Creator simplification removes decisions instead of staging them

Severity: **P1**

Creator's `simple` composer removes Model, Agent, and Profile controls and the
token grammar without supplying a plain-language path such as `More options`,
`Add context`, or `Choose how Polyth works`. Advanced selection is available
only after changing persona or finding settings/plugin controls elsewhere.

Progressive disclosure keeps a simple first layer and provides a stable,
named second layer in context. It does not silently remove controls according
to an identity label.

### PERSONAS-PL-05 — The promised defaults are not the implemented defaults

Severity: **P1**

Onboarding says “the rail, the shortcuts and how much detail you see are all
different.” Only plugin membership and Creator's composer mode differ.
`STARTERS` is one constant list for every choice; density and shortcuts are
separate preferences; model, agent, and profile defaults are untouched.
Manager and Creator therefore see developer-oriented starters such as
`Explore the codebase`, `Review my recent changes`, `Add tests`, and
`Debug an issue`.

Every claimed preset effect must be listed from one data model and actually
drive the corresponding surface. Do not claim shortcut, detail, or starter
adaptation until those fields exist.

### PERSONAS-PL-06 — Switching is immediate and reset-oriented

Severity: **P1**

Settings exposes `Workspace persona` as an immediate segmented control.
`applyPersona` replaces the plugin list. A confirmation appears only when the
current list differs from persona defaults, and it says only that
customizations will reset; there is no before/after summary. Switching between
untouched presets has no confirmation at all.

A preset change should preview its exact ordering/emphasis changes, preserve
explicit user overrides by default, and offer a separate intentional reset.
Clearing the preset must not delete unrelated preferences.

### PERSONAS-PL-07 — Native cards work, but the neutral path is demoted

Severity: **P1**

The three main cards are native buttons in a logical keyboard order and remain
unclipped with no horizontal overflow. At `390×900`, the page scrolls cleanly,
but Creator begins at `y=775`, the neutral action begins at `y=1017`, and that
action is only `31px` high. Engineer alone receives featured styling and a
primary CTA.

The neutral path must be a peer option or persistent `Skip for now` action with
a `44px` target. Returning onboarding should expose selected state
programmatically rather than relying only on the `Current` text tag.

### PERSONAS-PL-08 — Presentation-only persistence is event-safe

Severity: **positive reference / P0 guardrail**

Persona and plugin state are stored under `polyth.prefs`; `applyPersona` makes
no server or session call. No persona currently changes model, agent, profile,
system instruction, or canonical history. That keeps presentation-only
switches out of the session event log as required.

Preserve this separation. If a future preset changes model-visible behavior,
name the effect, obtain explicit consent, and append the effective instruction
before the first affected model response.

## Required specifier contract

1. Replace the mandatory identity gate with an optional starting preset after
   project/runtime setup. Initial state has no selection and a visible
   `Skip for now`.
2. Use outcome labels: `Build & debug`, `Plan & coordinate`,
   `Design & explore`, and `No preset`. If legacy nouns remain, treat them as
   secondary aliases, never as “Continue as …” identities.
3. Manager and Creator primary copy contains no `diff`, `git`, `terminal`,
   `model`, `agent`, `profile`, token syntax, or plugin terminology.
4. Keep all capabilities registered and searchable. Presets change starter
   ordering, panel emphasis, and initial detail only. One canonical registry
   drives header, rail, palette, shortcuts, and Settings.
5. Add an in-context, named disclosure such as `More tools` or
   `Technical options`; disclose advanced controls in plain-language groups,
   remember expansion separately from the preset, and never hide recovery.
6. Generate onboarding copy, confirmation summaries, and defaults from one
   preset schema. Do not promise density, shortcuts, starters, or model
   behavior unless the schema applies them.
7. Preview exact changes before switching. Preserve explicit customizations
   unless the user chooses Reset. Clearing restores standard ordering without
   touching project, session, draft, permissions, model, or agent defaults.
8. Give the neutral action equal keyboard, visual, and `44px` touch access.
   Cards expose one computed name, selected state, description relation, and
   non-color-only current state.
9. Keep presentation-only preset changes local and out of session history.
   Any optional model-visible effect requires explicit copy, an off switch,
   and append-before-display event ordering.
10. Verify every choice, Skip, switch, clear, customized-state conflict,
    reload, and disclosure at `320/390/768/1280` and 200% zoom.

## Evidence

- `/opt/cursor/artifacts/polyth_personas_onboarding_sol_8ab4_v2.png`
- `/opt/cursor/artifacts/polyth_personas_onboarding_390_sol_8ab4_v2.png`
- `/opt/cursor/artifacts/polyth_personas_creator_workspace_sol_8ab4_v2.png`
- `/opt/cursor/artifacts/polyth_personas_audit_sol_8ab4_v2.json`
- Polyth `App.tsx`, `Onboarding.tsx`, `prefs.ts`, `Composer.tsx`,
  `Header.tsx`, `ContextRail.tsx`, `shell.ts`, settings pages, and smoke tests.

Next stage: `SOL-PERSONAS-UX-SPECIFIER`.
