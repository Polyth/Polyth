# UX-PERSONAS — polyth onboarding and persona-language audit

- Case: `UX-PERSONAS`
- Model / role: `SOL` / polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime baseline: `docs/ux-audit/RUNTIME-BASELINE.md`
- polyth: `1.19.0`, source `7a2e0ee138fe8a13f4dd65090fcf915a2692356f`

## Decision

polyth does not ask who the user is. Its first-launch language asks the
single operational question it can act on immediately: **Local Install** or
**Connect Remote**. After connection, the empty chat asks what the user wants
to do and offers task verbs. Polyth should preserve that clarity, then add an
optional preset step that asks what to optimize—not a mandatory identity test.

The proposed `Engineer`, `Manager`, `Creator`, and `Blank` choices are useful
as an internal mapping, but the current nouns are not a safe user-facing
taxonomy. `Manager` and `Creator` are broad, overlapping identities, while
`Blank` is a state rather than a peer identity and sounds incomplete. Present
the choices as **Build & debug**, **Plan & coordinate**, **Design & explore**,
and **No preset**. If the familiar nouns must remain as card titles, call the
selection a preset and never say “Continue as …”.

## Runtime procedure

Google Chrome stable loaded the live polyth bundle from the isolated
baseline. The authoritative Electron first-launch outcome
`{ target: null, status: "not-configured" }` was injected before application
startup, and the health response was held not-ready so automatic OpenCode
detection could not dismiss the chooser before inspection. The run exercised
the Local/Remote tabs, opened the remote form, inspected visible and accessible
text, and recorded no console errors, page errors, or request failures.

This verifies the shipped first-launch UI path and copy in the served `1.19.0`
bundle. It does not claim a native Electron installation test.

## What polyth says

| Moment | Shipped language | What it establishes |
|---|---|---|
| Entry | “Welcome to polyth” | Product, not user identity |
| Decision | “Choose how you want to connect to get started.” | One concrete setup choice |
| Options | “Local Install” / “Connect Remote” | Mutually legible operating modes |
| Local rationale | “OpenCode is the heart of polyth — install it to get started.” | Why the prerequisite exists |
| Detection | “Waiting for OpenCode” / “We’ll continue automatically once it’s detected.” | Current state and next transition |
| Remote path | “Connect to Remote Server” | Action and destination |
| Ready workspace | “What are we working on in {project}?” | User intent is deferred until the system works |
| Starter verbs | Explore, catch up, weigh options, plan, craft a Goal, schedule, debug, review | Broad tasks without assigning a role |

No polyth first-launch screen, ready-workspace empty state, or Defaults
setting exposes a persona. Defaults are explicit model and agent controls.
The source contains no `Engineer`, `Manager`, `Creator`, `Blank`, `persona`,
or `working style` product taxonomy.

## Findings

### PERSONAS-OC-01 — Connection and intent are separate questions

Severity: **positive reference**

polyth does not place preference collection ahead of a missing runtime.
Its headings, buttons, status copy, and recovery copy all describe observable
system state. Polyth should keep connection/runtime setup as its own step.
Persona selection belongs only after prerequisites are ready, and skipping it
must lead to a fully usable workspace.

### PERSONAS-OC-02 — Task verbs are more inclusive than job nouns

Severity: **P1**

The same user may debug in the morning, coordinate a release later, and design
a flow next. polyth’s verbs support that movement. The proposed nouns
turn temporary intent into identity and create avoidable questions: whether a
technical manager chooses Engineer or Manager, whether writing counts as
Creator, and whether Blank is a lesser mode.

Use work outcomes as the primary labels. Store one starting preset, not a user
classification, and let the user switch or clear it without re-onboarding.

### PERSONAS-OC-03 — “Blank” and adaptive claims undermine trust

Severity: **P1**

“Blank” can read as empty, unconfigured, or reduced-capability. “Learn from
your choices” implies behavioral observation and automatic changes that the
mockup does not define. Rename the option **No preset** and describe its exact
effect: Polyth keeps the standard layout and existing model/agent defaults.
Do not claim learning or adaptation unless collection, scope, controls, and
reset behavior are implemented and disclosed.

### PERSONAS-OC-04 — A preset must not become a hidden model instruction

Severity: **P0 contract**

Reordering starter actions or panels is presentation state. Changing an agent,
response style, system instruction, or model-visible context is not. A persona
choice must never silently alter model behavior. Any model-visible effect must
be explicit in the confirmation summary and appended to the canonical session
event log before the first affected response is displayed.

## Required Polyth language

### Step framing

- Kicker: `Optional setup`
- Heading: `What should Polyth put within easy reach?`
- Description: `Choose a starting preset for shortcuts, starter actions, and panel order. It won’t hide tools or limit what you can do. Change or clear it anytime.`
- Secondary action: `Skip for now`
- Persistence note: `Saved on this device. Change it in Settings → Workspace preset.`

Use `preset` or `starting setup` throughout. Do not use `persona`, `role`,
`profile`, `learn`, or `adapt` in user-facing copy.

### Choice copy and behavior

| Display label | Supporting copy | Initial emphasis | Confirmation CTA |
|---|---|---|---|
| **Build & debug** | `Keep code, files, Git, and technical starters close.` | Explore codebase, debug, review changes; Files and Git | `Use Build & debug preset` |
| **Plan & coordinate** | `Lead with goals, plans, progress, and next actions.` | Catch up, weigh options, plan, Goal, schedule | `Use Plan & coordinate preset` |
| **Design & explore** | `Make room for ideas, previews, voice, and iterative drafts.` | Explore, preview, draft, explain visually | `Use Design & explore preset` |
| **No preset** | `Keep the standard workspace and your existing defaults.` | Balanced standard order; no agent override | `Continue without a preset` |

If product requirements retain the original card titles, use:

- `Engineer — Build & debug`
- `Manager — Plan & coordinate`
- `Creator — Design & explore`
- `No preset`, never `Blank`

The CTA remains `Use {preset} preset`; it must not say `Continue as Engineer`,
`Continue as Manager`, or `Continue as Creator`.

## Behavior contract

1. The step is optional, keyboard-operable, and skippable without selecting a
   disguised default. Initial state has no card selected.
2. A preset changes only the disclosed starter ordering, panel emphasis, and
   optional agent default. It does not remove tools, permissions, or commands.
3. The confirmation summarizes every changed default before persistence.
   Unavailable panels, agents, or capabilities are omitted without promising
   them; existing explicit user defaults win.
4. The user can switch, clear, and reset the preset from Settings. Clearing it
   restores standard ordering without deleting unrelated preferences.
5. Preset state is device/workspace presentation state unless the user
   explicitly enables a model-behavior effect. Presentation-only changes do
   not append session events.
6. If a preset changes model-visible instructions, the UI names that effect,
   offers an off switch, and logs the effective instruction before model use.
7. Localization uses outcome phrases rather than translated job titles as the
   canonical keys. Copy does not infer seniority, profession, or authority.

## Acceptance

- First launch completes Local/Remote setup before showing the optional preset
  step; runtime and recovery errors cannot be hidden behind preference cards.
- With no selection, `Skip for now` and keyboard focus are available. Continue
  does not silently choose Build & debug.
- Each card and its CTA state the same preset name; screen-reader output names
  the effect and selected state once, without duplicate controls.
- Selecting each preset produces the exact disclosed starter and panel order.
  All tools remain discoverable and available.
- No preset uses the standard workspace and retains explicit model/agent
  defaults. Clearing a prior preset returns to that state.
- Changing presets during an existing session preserves the timeline, draft,
  project, permissions, and model-visible event history.
- A byte-for-byte event-log comparison stays unchanged for presentation-only
  preset changes. Any enabled model-behavior change appears as a prior event.
- The language is tested in every supported locale at 320 px, 390 px, and 200%
  zoom; labels and the skip path remain fully visible.

## Evidence

- `/opt/cursor/artifacts/polyth_personas_onboarding_sol_5f96.png`
- `/opt/cursor/artifacts/polyth_personas_audit_sol_5f96.json`
- polyth `ChooserScreen.tsx`, `OnboardingScreen.tsx`, `desktopBoot.ts`,
  English i18n messages, chat draft presets, and Defaults settings at the
  audited source revision.

Next stage: `SOL-PERSONAS-POLYTH-AUDITOR`.
