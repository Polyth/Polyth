# UX-PERSONAS — optional workspace preset specification

- Case: `UX-PERSONAS`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `9c658ad3c0cd042333e38b38264679c8db5c7a96`
- Inputs: polyth audit at `3228159` and Polyth audit at `d323c8f`
- Scope: first-run order, Engineer/Manager/Creator/Blank migration, plain
  language, progressive disclosure, preset switching, persistence,
  accessibility, and event safety
- This artifact changes no product code.

## Decision and user outcome

Replace the mandatory persona gate with an optional workspace preset shown
after Polyth can open a project. The four user-facing choices are:

1. `Build & debug`;
2. `Plan & coordinate`;
3. `Design & explore`; and
4. `No preset`.

The stored legacy ids `engineer`, `manager`, `creator`, and `blank` remain only
as migration inputs. Polyth must not call the user an Engineer, Manager,
Creator, or Blank, and must not say `Continue as …`.

A preset is a starting arrangement, not an identity, permission set, plugin
allow-list, or hidden model instruction. It may set the initial order of
starter actions, emphasize a small set of workspace capabilities, and choose
whether technical composer controls begin open. It never removes a capability.
Every registered and available capability remains reachable through a named
`More tools` path, command search, Settings, and its shortcut.

`No preset` uses the standard order and existing defaults. `Skip for now`
produces the same usable workspace without first selecting a card. Neither
path writes a disguised default.

## Non-negotiable product rules

1. Project/runtime setup and recovery render without a preset. Missing or
   invalid preset data can never block the workspace.
2. Initial state has no selected card. `Skip for now` is visible without
   scrolling and has equal keyboard and touch access.
3. Presets change emphasis and initial detail, not capability availability.
   A capability may be unavailable only because its runtime prerequisite or
   extension is unavailable, never because of a preset.
4. Progressive disclosure always has a stable, plain-language way back.
   Closing `More tools` or `Technical options` changes presentation only.
5. The header, rail, command search, shortcuts, Settings, and compact
   navigation resolve the same capability descriptors. They cannot disagree
   about whether a capability exists.
6. Presets do not change model, agent, profile, system instructions,
   permissions, project access, or session behavior.
7. Applying, switching, clearing, or skipping a preset appends no session
   event. The event log is byte-for-byte unchanged.
8. Explicit user ordering and disclosure choices win over preset suggestions.
   Switching presets never silently resets them.

## Exact user-facing language

### Optional setup

- Kicker: `Optional setup`
- Heading: `What should Polyth put within easy reach?`
- Description: `Choose a starting preset for shortcuts, starter actions, and panel order. It won’t hide tools or limit what you can do. Change or clear it anytime.`
- Secondary action: `Skip for now`
- Persistence note: `Saved on this device. Change it in Settings → Workspace preset.`

Use `preset`, `starting setup`, and `workspace` in user-facing copy. Do not use
`persona`, `role`, `profile`, `learn`, or `adapt` for this feature.

The description must name only effects the implementation supplies. Until
shortcut ordering is driven by the preset schema, omit `shortcuts` from the
description rather than promising it. The initial implementation therefore
uses:

`Choose a starting preset for starter actions, workspace order, and initial detail. It won’t hide tools or limit what you can do. Change or clear it anytime.`

### Choice cards

| Label | Supporting copy | Confirmation action |
|---|---|---|
| `Build & debug` | `Keep code, project files, changes, and technical starters close.` | `Use Build & debug preset` |
| `Plan & coordinate` | `Lead with goals, plans, progress, and clear next actions.` | `Use Plan & coordinate preset` |
| `Design & explore` | `Make room for ideas, previews, voice, and iterative drafts.` | `Use Design & explore preset` |
| `No preset` | `Keep the standard workspace and your existing defaults.` | `Continue without a preset` |

The primary copy for `Plan & coordinate` and `Design & explore` must not use
`diff`, `Git`, `terminal`, `model`, `agent`, `profile`, token syntax, or
`plugin`. Those terms may appear later inside `Technical options`, paired with
a plain description of what the option does.

## First-run sequence

The shell, runtime state, and project picker no longer depend on
`prefs.persona`. Replace the `App` early return with this sequence:

1. Start the shell and show runtime health and recovery normally.
2. If there is no active project, show the project picker. Preset setup does
   not cover or replace connection, health, permission, or project errors.
3. After a project becomes usable, and only when preset setup is `unseen`, show
   the optional setup panel.
4. Keep the ready workspace mounted behind the panel. Closing it, pressing
   Escape, or choosing `Skip for now` records setup as completed with no
   preset and returns focus to the element that opened it, or to the composer.
5. A card click selects only a draft choice. It does not persist or rearrange
   the workspace until the confirmation action is activated.
6. Confirmation shows the exact effective changes before saving. It includes
   starter order, primary capability order, and initial composer detail.
7. If the selected preset names an unavailable capability, omit that
   capability from the summary and retain it in `More tools` with an
   unavailable reason when the registry knows one.

The optional setup panel may temporarily use dialog behavior, but it is not a
gate: its close, Escape, and Skip paths all lead to the complete workspace.
On later launches it does not reopen automatically. Settings can open it
again.

## Preset schema

Use erasable TypeScript and one source of truth:

```ts
export type WorkspacePresetId =
  | "build-debug"
  | "plan-coordinate"
  | "design-explore";

export type CapabilityTier = "primary" | "more" | "technical";
export type ComposerDetail = "plain" | "technical";

export interface PresetPlacement {
  capabilityId: string;
  tier: CapabilityTier;
  rank: number;
}

export interface WorkspacePreset {
  id: WorkspacePresetId;
  label: string;
  description: string;
  confirmationLabel: string;
  starterIds: string[];
  placements: PresetPlacement[];
  initialComposerDetail: ComposerDetail;
}
```

`No preset` is represented by `presetId: null`; it is not a fourth identity
value. Its visible card is generated from the standard arrangement, while the
three named cards are generated from `WORKSPACE_PRESETS`.

The same schema supplies card copy, confirmation copy, starter order,
capability placement, Settings labels, and command labels. A test fails if UI
copy names an effect that has no schema field.

### Required arrangements

| Preset | Primary order | Initial detail |
|---|---|---|
| Standard / No preset | Chat; Project files; Preview; Goals & progress | Plain |
| Build & debug | Chat; Project files; Source control; Terminal; Preview | Technical |
| Plan & coordinate | Chat; Goals & progress; Usage & cost; Schedule; Guided walkthrough | Plain |
| Design & explore | Chat; Preview; Project files; Voice input | Plain |

Capabilities not listed as primary are placed in `More tools` or
`Technical options`; they are not filtered out. The technical group starts
with Source control, Terminal, Models and agents, Event log, and extension
diagnostics. It remains reachable from every preset.

Required starter order:

| Preset | First five starter actions |
|---|---|
| Standard / No preset | `Explore this project`; `Explain what’s here`; `Plan a next step`; `Review recent work`; `Help me get started` |
| Build & debug | `Explore the code`; `Debug an issue`; `Review recent changes`; `Add tests`; `Explain this project` |
| Plan & coordinate | `Catch me up`; `Turn this into a plan`; `Summarize progress`; `Identify risks`; `Suggest the next action` |
| Design & explore | `Explore a few directions`; `Draft an interface`; `Open a preview`; `Revise from feedback`; `Explain it visually` |

Starter ids are stable language-independent keys. Labels are localized
resources. Selecting a starter fills the composer exactly as it does today;
the preset does not submit a message.

## One capability model

Add a navigation-metadata registry; do not create another component host.
Existing workspace and right-surface registries continue to own rendering and
lifecycle. Each navigable feature contributes one capability descriptor that
points to its existing open command:

```ts
export interface CapabilityDescriptor {
  id: string;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  standardRank: number;
  open: () => void;
  available: () => boolean;
  unavailableReason?: () => string | null;
}
```

The registry has these rules:

- a duplicate id replaces its descriptor and disposes by identity, matching
  the existing surface registry behavior;
- preset resolution may change only `tier` and `rank`;
- `available()` is independent of preset selection;
- a missing runtime prerequisite produces a disabled item with an explanation
  and recovery action where possible;
- a dynamically registered extension defaults to `More tools`, is searchable
  immediately, and can be promoted by an explicit user preference;
- disabling or uninstalling an extension is an explicit extension-management
  action, not a preset effect;
- built-in capability controls no longer use `prefs.plugins` as an allow-list.

Header, right rail, compact navigation, and command search consume the same
resolved list:

- the header shows the resolved `primary` items that fit plus one visible,
  named `More tools` button;
- `More tools` contains every remaining available item in plain-language
  groups, with `Technical options` as a named expandable group;
- the rail shows compatible primary panels first and keeps all other panels
  in the same `More tools` disclosure;
- command search includes every registered, available capability regardless of
  tier and searches both plain and technical terms;
- shortcuts call the descriptor's `open()` command and do not check a preset;
- Settings lists every capability and its current placement.

If space is insufficient, primary items overflow into `More tools`; they do
not disappear. An active overflowed item remains named in the header and can
be closed or revisited without reopening the disclosure.

## Progressive disclosure

### Workspace tools

Use `More tools`, not an icon-only plus control and not `Add or remove
plugins`, for built-in navigation. The trigger has visible text at first use,
an accessible name, `aria-expanded`, and a minimum `44×44px` target.

Inside the disclosure, group capabilities by user outcome:

- `Work with the project`: Project files, Preview, Goals & progress;
- `Plan and review`: Usage & cost, Schedule, Guided walkthrough;
- `Compare and refine`: Compare responses, Combine drafts;
- `Technical options`: Source control (Git), Terminal, Events, models, agents,
  and diagnostics.

Plain labels come first. A technical alias may follow in parentheses. Search
continues to match current names such as Git, Multi-Run, Fusion, and plugin so
existing users are not stranded.

Opening and closing `More tools` is stored separately from the preset. A later
preset switch does not collapse a group the user opened.

### Composer controls

There is always one composer implementation. `initialComposerDetail` chooses
only the initial disclosure state when the user has never made a choice.

In plain detail:

- keep the message input, attachment action, focused editor, and Send visible;
- add a visible `Technical options` button in the composer;
- place model, agent, profile, shell/command syntax help, snippets, and file
  mention help inside that disclosure;
- keep keyboard syntax functional, and explain it after disclosure rather than
  removing it; and
- preserve draft text, selection, IME state, attachments, and focus when the
  disclosure changes.

In technical detail, those controls begin expanded. The user's explicit
expanded/collapsed choice is stored separately and wins over every later
preset. No preset change may unmount the composer.

## Confirmation, switching, clearing, and reset

Before first application or a later switch, show a generated summary:

```text
Build & debug will:
• put Project files, Source control, Terminal, and Preview first
• show build and review starters first
• start Technical options open

It will not remove tools, change access, or change how Polyth responds.
```

The summary uses only effective differences from the current state. It does
not list unavailable entries as promised changes.

Settings uses `Workspace preset`, not `Workspace persona`, and offers:

- the four choices;
- `Preview changes`;
- `Apply`;
- `Clear preset`; and
- separate controls for `Reset workspace order` and
  `Reset disclosure choices`.

Switching changes the preset baseline but preserves explicit placement,
starter, and disclosure overrides. If an override masks a proposed change,
the preview says so and offers `Keep my layout` as the default. The user may
choose `Use preset order`, which clears only placement and starter overrides
after a second explicit confirmation.

`Clear preset` selects the standard baseline. It does not alter project,
session, draft, permissions, theme, density, shortcuts, model, agent, profile,
managed extensions, or unrelated preferences. With no explicit workspace
overrides, clearing returns exactly to the standard order.

## Persistence and migration

Store preset state separately from capability overrides:

```json
{
  "version": 1,
  "setup": "completed",
  "presetId": "plan-coordinate",
  "composerDetail": null,
  "moreToolsOpen": false
}
```

Use `polyth.workspacePreset.v1`. `composerDetail: null` means the selected
preset or standard baseline may seed the initial value; once the user toggles
it, store `plain` or `technical`. Keep explicit capability placement and
starter overrides in a separate versioned workspace-presentation record so
clearing a preset does not delete them.

Parse defensively: reject unknown preset/setup/detail values, cap override
maps at 128 entries, drop unknown fields, and never throw during app startup.
Invalid data falls back to `setup:"unseen", presetId:null` while the shell
remains usable.

Migrate `polyth.prefs` once:

| Legacy value | New value |
|---|---|
| `engineer` | `build-debug` |
| `manager` | `plan-coordinate` |
| `creator` | `design-explore` |
| `blank` | `null`, setup completed |
| absent/invalid | `null`, setup unseen |

For the legacy `plugins` array:

1. compare it with that legacy persona's generated defaults;
2. discard unchanged membership because it was preset-owned filtering;
3. convert user-added ids to explicit promoted placement overrides;
4. convert user-removed default ids to explicit `More tools` placement
   overrides, never to hidden or unavailable state; and
5. leave managed extension enabled/disabled state untouched.

Write the new records successfully before marking migration complete. After
migration no header, rail, command, shortcut, Sidebar, composer, voice, or
Settings path may read legacy persona/plugin membership for availability.

## Accessibility and responsive behavior

- Cards are native single-selection controls with one computed accessible
  name, `aria-describedby` support text, and programmatic selected state.
- Selection is shown by text/icon as well as color. No card is initially
  selected.
- Card order is Build & debug, Plan & coordinate, Design & explore, No preset,
  followed by the persistent Skip action.
- Card, confirmation, Skip, More tools, Technical options, and close targets
  are at least `44×44px`.
- Keyboard order follows visual order. Arrow-key radio behavior is acceptable
  if implemented completely; ordinary buttons with explicit selected state
  are also acceptable.
- Closing setup restores focus to its invoker or the composer. Applying a
  preset announces the selected preset and the number of visible arrangement
  changes in a polite live region.
- `More tools` returns focus to its trigger on Escape. Opening a capability
  moves focus according to that capability's existing navigation contract.
- At `320px`, `390px`, `768px`, `1280px`, short heights, and 200% zoom, the
  heading, current card, confirmation, and Skip remain reachable in one
  positive block scroll. There is no horizontal page scroll.
- On compact screens, use a visible `Tools` destination rather than shrinking
  all capabilities into unexplained icons. It contains the same resolved list.
- Long localized labels wrap; they are not truncated into ambiguous identity
  nouns. Reduced motion removes card and disclosure movement without delaying
  state changes.

## Event, API, extension, and security invariants

Preset selection, setup completion, capability ordering, disclosure state,
and starter ordering are local presentation state. They do not call session
APIs and append no `SessionEvent`.

This specification forbids a preset from changing model, agent, profile,
system instructions, tool permission, auto-accept, or message content. If a
future feature proposes any such behavior, it requires a separate contract,
explicit opt-in, an off switch, and append-before-display ordering. It cannot
be added as another field to this preset schema without that review.

Capability descriptors contain navigation metadata and open commands only.
They confer no filesystem, process, credential, project, or session authority.
Dynamic extensions continue through the trusted registration/slot boundary;
this feature introduces no remote JavaScript loader.

Everything that becomes model-visible still enters the canonical session event
log before UI display or model submission. Merely opening a panel or filling a
starter into the draft is not model-visible and remains local until Send.

## Minimal implementation seams

| File | Exact responsibility |
|---|---|
| `apps/web/src/workspacePresets.ts` (new) | Preset schema, standard arrangement, migration, defensive persistence, pure resolution, and generated confirmation differences. |
| `apps/web/src/capabilities.ts` (new) | Navigation metadata registry and pure tier/rank resolution; no component lifecycle or authority. |
| `apps/web/src/prefs.ts` | Remove persona/plugin allow-list behavior after one-time migration; retain only compatibility exports while call sites move. |
| `apps/web/src/App.tsx` | Always render operational shell; trigger optional setup only after project/runtime readiness. |
| `apps/web/src/components/Onboarding.tsx` | Rename to preset setup or replace; exact copy, no default selection, draft selection, preview, confirmation, Skip, and focus return. |
| `apps/web/src/components/Header.tsx` | Resolve primary capability actions from the registry; remove hardcoded `VIEW_GROUPS`; provide named overflow. |
| `apps/web/src/components/ContextRail.tsx` | Remove persona filtering and flat plugin picker for built-ins; consume resolved compatible capabilities and named disclosure. |
| `apps/web/src/components/Composer.tsx` | Generate starters from the preset schema; replace persona-simple removal with remembered `Technical options`. |
| `apps/web/src/shell.ts` | Register capability commands from descriptors; remove `pluginOn` and persona commands; preserve old search terms as keywords. |
| `apps/web/src/components/Sidebar.tsx` | Stop preset/plugin membership from hiding built-in actions; use capability availability. |
| `apps/web/src/components/settings/pages.tsx` | Workspace preset preview/apply/clear and separate reset controls; capability placement rather than built-in enable checkboxes. |
| `apps/web/src/settings/registry.ts` | Rename searchable settings item and preserve `persona`/`role` only as migration search keywords. |
| `apps/web/src/surfaces.ts` and workspace registries | Keep rendering ownership; expose descriptors into the capability metadata layer without a second host. |
| `apps/web/src/styles.css` | Responsive cards, persistent Skip, named disclosures, 44px targets, wrapping, focus, and reduced motion. |

Call sites of `pluginOn()` and `prefs.plugins.includes()` must be classified,
not mechanically replaced. Built-in navigation uses capability availability.
Real runtime prerequisites such as voice support use their own availability
checks. Managed extension enablement remains an explicit extension setting.

## Acceptance gates

### Pure and component tests

1. Parse every valid, malformed, future-version, and oversized persistence
   record without blocking shell render.
2. Migrate all four legacy ids, exact default plugin arrays, added/removed ids,
   absent persona, and invalid data. No migrated capability becomes hidden.
3. Table-test standard and three preset resolutions, explicit override
   precedence, unavailable items, dynamic registration/disposal, stable
   ordering, and narrow overflow.
4. Assert every registered available capability appears in command search and
   either primary navigation, More tools, or Technical options for every
   preset and No preset.
5. Assert header, rail, compact Tools, Settings, shortcuts, and command search
   use the same descriptor id and open command. Delete hardcoded persona
   availability checks.
6. Generate cards, confirmation summaries, Settings labels, and starter order
   from the schema. Assert Plan and Design initial copy contains none of the
   prohibited technical terms.
7. Mount the app with no stored preset, no project, a runtime failure, and a
   ready project. The shell/recovery renders in every case; setup appears only
   in the ready case and remains skippable.
8. Select without confirming, confirm each preset, choose No preset, Skip,
   switch, clear, and resolve an override conflict. Verify exact persistence
   and no reset of unrelated preferences.
9. Toggle More tools and composer Technical options through every preset.
   Verify all capabilities remain discoverable and draft, attachments,
   selection, IME state, and component identity remain exact.

### Live interaction

Run at `1280×900`, `768×900`, `390×844`, `320×844`, and a `720×450` CSS
viewport at device scale factor `2`.

1. Start from empty storage. Reach project/runtime setup without selecting a
   preset. Trigger and recover from a runtime or project error.
2. Open a usable project. Verify no card is selected and Skip is visible,
   named, keyboard reachable, and at least `44×44px`.
3. For each card, compare the preview with the post-apply primary order,
   starter order, and composer detail. The values must match exactly.
4. For every preset and No preset, open every built-in capability through
   primary navigation or More tools, then find it through command search.
5. In Plan and Design, complete common work without technical vocabulary,
   then open Technical options and reach source control, terminal, model,
   agent, profile, command syntax, and diagnostics.
6. Add a dynamic surface after render, remove it, and re-add it. It appears in
   More tools and search without changing preset state.
7. Customize order and disclosure, switch presets, clear the preset, and
   reload. Explicit choices survive; project, session, timeline, draft,
   permissions, and selected model/agent/profile remain unchanged.
8. Exercise pointer, Tab/Shift+Tab, arrows if implemented, Enter, Space, and
   Escape. Focus return and live announcements are deterministic.
9. Repeat at every viewport, short height, 200% zoom, reduced motion, and with
   long localized labels. No required action clips or causes horizontal page
   scroll.
10. Capture the ordered session event log before and after the whole journey.
    Its count, sequence, ids, types, and payload digest are identical.

Run:

```sh
node --test apps/web/test/workspacePresets.test.ts
node --test apps/web/test/capabilities.test.ts
node --test apps/web/test/smoke.test.ts
node --test apps/web/test/personas.live.ts
(cd apps/web && npx tsc --noEmit)
npm test
```

Passing artifacts must show the optional unselected setup and Skip at
`1280px` and `390px`, Plan's plain first layer plus its open Technical options,
Design at `320px`, and the all-capabilities/search invariant.

## Explicit non-goals

- No user identity classification, mandatory preference survey, adaptive
  learning claim, or `Continue as …` language.
- No preset-owned plugin allow-list, permission set, capability removal,
  hidden recovery path, or contradictory header/rail availability.
- No second composer, component host, workspace registry, right-surface
  registry, command registry, shortcut system, or extension loader.
- No preset effect on model, agent, profile, instructions, permissions,
  auto-accept, session events, server state, or project authority.
- No promise of shortcut, density, theme, response style, or model behavior
  until a separate implemented schema and contract owns that effect.
- No broad redesign of project setup, runtime recovery, settings navigation,
  extension installation, or canonical session behavior.

## Exact next task

`Fable-PERSONAS-implementer`: implement this specification from the optional
setup sequence through the shared capability registry, migrate the four legacy
persona values without hiding any capability, preserve the append-before-
display event invariant, and hand the live runtime plus passing artifacts to
the SOL verifier.
