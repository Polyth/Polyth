# Phase 2 — Wave 3A handoff: composer, model picker, agent picker

Wave 3A owned the interaction design and first quality implementation of the
composer and its two pickers. Wave 1 navigation, Wave 2 chat internals, and
all Phase 1 primitives/tokens were treated as fixed. This document records the
decisions, the touched surfaces, the technical edges, and — most importantly —
the explicit hardening list for Sol (Wave 3B).

## UX decisions

### Composer: typing first, configuration second

The previous composer was a toolbar: model header row on top of the editor,
selector grid, a thinking slider, a context-window picker, and technical
toggles all at equal visual weight. That was replaced with one quiet rail
under the editor:

```
[ editor card                                     ]
[ + · (model chip) (agent chip) (effort chip) · extensions · Send/Stop ]
```

- **Primary controls**: Add (`+`), the text editor, Send/Stop. Send/Stop is
  the only filled control in the composer; everything else is a quiet
  `config-chip`/icon at muted weight.
- **Secondary controls**: model, agent, effort (only when the selected model
  has thinking variants), dictation, slot-contributed extensions
  (auto-approve, goals, workflow). They live in `.composer-config` and
  `.composer-actions` and never compete with Send.
- The old `composer-model-header`, selector grid, `ThinkingSlider`,
  `ContextWindowPicker`, and the `techOpen`/"technical" disclosure were
  deleted, not hidden. Effort became `EffortMenu` — a small radio `Menu` on a
  chip that reads `Thinking`/`High`/… — because effort is a discrete choice,
  not a continuum worth a slider.
- `ComposerAddMenu` is the single entry point for attach/context/tools; its
  dead `trigger="tools"` variant was removed. File upload lives inside it
  (`onUpload` opens the shared hidden `<input type=file>`).

### Desktop composer

Editor card with the rail below. Chips show provider logo + model name,
agent name (capitalized via `agentBadgeLabel`), and effort label. During a
stream with an empty draft the primary becomes a red-tinted circular Stop;
with a draft it becomes the queue split (`Queue` + a menu with `Send now` /
`Stop`), so drafting during a stream never loses the stop affordance.

### Mobile composer

- **Collapsed**: one 56px row — Add · placeholder · mic (or send when
  dictation is off). Config chips stand down entirely.
- **Expanded**: editor on top (grows to `42dvh`, then scrolls internally),
  one rail below. The config group scrolls horizontally
  (`overflow-x: auto`, chips `flex: none` with `max-width` caps) so the row
  can never overflow the viewport or paint chips over each other. Send/Stop
  is a 44px filled circle pinned at the end; it never leaves the row.
- Every chip and the primary sit in `--tap` (44px) touch boxes; labels
  truncate rather than widen the row. Verified at 390px and 320px with zero
  horizontal document overflow.
- Empty draft + dictation on → mic replaces send (`§16/§18` rules kept).
- Pending-approval banner + open keyboard at 390px re-checked per the Wave 2
  note: banner and composer both stay visible and tappable.

### Model picker

Trigger is a quiet chip (logo + name + caret). Desktop opens a `Popover`
anchored to the chip; phones open the shared bottom `Sheet` (per-package
`ResponsiveOverlay` adoption is Wave 3B work; the picker uses the same
Popover/Sheet pair directly).

- **Catalog**: search across provider/model/id; provider grouping with
  collapse state persisted per project; favorites (star) with the existing
  drag-reorder preserved; the current model gets a check; disconnected
  providers render rows in an offline state. The selected model's provider
  auto-expands when no explicit expansion prefs exist, so the picker never
  opens onto a wall of collapsed groups.
- **Row anatomy**: model name primary; one secondary line of concise meta
  (`Text · Image · PDF · 1M`). No pricing, no reasoning flags, no dashboards
  in rows.
- **Details**: every row has an info affordance (`ⓘ`). Desktop shows a
  details panel inside the popover; phone pushes a details view inside the
  sheet (no hover anywhere). Details list provider, context window,
  modalities, reasoning, tool-call support, and pricing per MTok when the
  catalog carries it, plus a `Use this model` CTA (suppressed for the
  current model).
- Scale-checked against a 40-model provider fixture plus four smaller
  providers.

### Agent picker

Kept as its own `Picker`-based chip — agent and model never share a surface.
Rows show the agent name primary and its purpose/description secondary
(two-line layout, `.composer-agent-chip .picker-item`); technical keys are
hidden. Selected state ticks the active agent; the default option is labeled
with the capitalized badge formatter so `build` reads `Build` everywhere.

### Attachments

Existing pill strip kept and verified rather than rebuilt: multiple files,
image + generic file, long names truncate with ellipsis inside a bounded
pill, remove targets are 44×44 on phones, and the strip wraps on desktop /
stays inside the card on phones with no document overflow.

## Touched surfaces / files

- `apps/web/src/components/Composer.tsx` — rail restructure; `EffortMenu`
  (local component); removal of `ThinkingSlider`, `ContextWindowPicker`,
  model header, selector grid, `techOpen`; agent chip labels through
  `agentBadgeLabel`; queue-split / stop-primary logic kept.
- `apps/web/src/components/ComposerAddMenu.tsx` — dead `trigger` prop
  variant removed; single Add entry point.
- `apps/web/src/styles.css` — new `.composer-rail`/`.composer-config`/
  `.config-chip` block; legacy composer CSS deleted (~590 net lines down);
  mobile collapsed/expanded rules rebuilt for the new DOM; touch ghost-hover
  flatten rule (`@media (hover: none)`) now excludes `.send`/`.stop`.
- `packages/models/widgets/ModelPicker.tsx` — rewritten on `Popover`/`Sheet`
  with search, grouping, favorites, details views; exports shared formatters
  (`modelMetaLine`, `modelSupportsThinking`, `thinkingVariantLabel`, …).
- `packages/models/widgets/styles.css` — package-scoped picker CSS rebuilt;
  legacy trigger/header styles deleted.
- `packages/models/src/i18n/*.ts` — 17 new `modelpicker.*` keys in all 12
  locales.
- Tests updated to the new DOM: `responsiveShell`, `mobilePolish`,
  `sidebarHeaderPolish`, `mobileChatRedesign`, `mobileFoundation`,
  `widgetWorkspaceUx`, `packageContainment` (allowlists `ui/Popover`,
  `ui/Icon`, `ui/icons` for feature packages).
- QA tooling: `apps/web/test/wave3aComposerFixtureSetup.mjs` (rich synthetic
  catalog — 5 providers / 47 models / 5 agents, streaming + pending-approval
  sessions) and `apps/web/test/wave3aComposerQa.mjs` (Playwright driver:
  desktop 1280, phone 390, 320px; pickers, attachments, streaming stop,
  permission + keyboard). `msgActionsFakeBackend.mjs` gained an optional
  `MSGACT_OC_CATALOG` env override to serve that catalog.

## Validation run

- `npm test`: 1547 pass / 0 fail (2 skipped, pre-existing).
- `npx tsc --noEmit`: clean in `apps/web` and `packages/models`.
- `npm run build`: clean.
- Playwright QA pass over the fixture server (port 4473): no horizontal
  overflow at 1280/390/320; model/agent/effort chips ≥44px on phones;
  details sheets work touch-only; attachment remove targets 44×44; stop and
  queue-split verified during real (synthetic) streaming on both form
  factors.

## Known technical edges

- **Touch ghost-hover** (fixed here, fragile in general): the global
  `@media (hover: none)` rule that flattens sticky `:hover` backgrounds was
  washing the filled Stop circle to transparent — the stop materializes
  exactly under the finger that tapped Send, so the stuck `:hover` matched.
  It now excludes `.send`/`.stop`, but the rule still nukes *any other*
  filled button a finger rests on (e.g. `.btn-accent`, permission Allow).
- `EffortMenu` lives inside `Composer.tsx`; picker formatters live in
  `packages/models/widgets/ModelPicker.tsx` and are imported by the app.
  Boundary is intentional but the import direction (app ← package widget
  file, relative `../../../` paths inside the package) deserves a cleanup.
- The model picker manages three overlapping expansion inputs (search
  auto-expand, session-local overrides, persisted prefs, selected-provider
  default). It is correct but state-heavy; see hardening list.
- The phone model chip truncates aggressively (`max-width: 38vw`); with a
  long provider logo fallback + long name it can read as `FA Fab…`.
  Functional, not pretty.
- The fake-backend stream settles in ~1.5s, so stop-state QA is timing
  sensitive; the driver waits on the DOM, not on delays, but manual QA
  against it needs quick eyes or a longer fixture stream.

## Hardening work for Sol (Wave 3B) — explicit

1. **Ghost-hover rule audit**: the `(hover: none)` flatten rule still strips
   backgrounds from every filled button except `.send`/`.stop`. Either
   invert it (opt-in `data-quiet-hover`) or extend exclusions to all filled
   primaries (`.btn-accent`, permission decision buttons, `Use this model`
   CTA). Grep: `not(.ui-icon-btn):hover` in `apps/web/src/styles.css`.
2. **Component boundaries**: extract `EffortMenu` out of `Composer.tsx`;
   move `thinkingVariantLabel`/`modelMetaLine` and friends somewhere neutral
   (they are UI formatters used by both the app and `packages/models`);
   remove the `../../../apps/web/...` relative imports in
   `packages/models/widgets/ModelPicker.tsx` in favor of whatever shared-ui
   contract 3B establishes.
3. **Duplicated logic**: `agentBadgeLabel` capitalization is applied in two
   places in `Composer.tsx` (default item + trigger). Centralize label
   derivation for agent items.
4. **Model picker state**: collapse the four expansion inputs (search,
   session overrides, persisted prefs, selected-provider default) into one
   reducer with an explicit precedence order; add a unit test for each
   precedence rule.
5. **Huge lists / performance**: the 40-model provider renders fine, but
   rows are not virtualized and every keystroke re-filters the full catalog
   with `toLowerCase` per row. Memoize a prebuilt search index; consider
   virtualization only if a real catalog (400+ models) stutters.
6. **Search performance/UX**: search currently expands all matched groups;
   typing then clearing loses prior manual collapse state (session overrides
   win). Decide the intended restore behavior and test it.
7. **Responsive breakpoints**: composer mobile rules key off the shell-level
   viewport MQ (`max-width: 820px`). Fine for the shell-owned composer, but
   the config-chip block should be re-checked when 3B moves embedded panels
   to container queries — widget-hosted composers inherit viewport rules
   today.
8. **Container vs viewport in `packages/models`**: the package stylesheet
   still carries viewport MQs from before this wave; repatriate to container
   queries per the matrix row.
9. **Mobile keyboard / visual viewport**: the sheet + `--keyboard-inset`
   path works, but the details view inside the model sheet does not scroll
   its CTA above the keyboard if a hardware keyboard opens search first.
   Re-test with `data-keyboard="open"` + details view.
10. **Safe areas**: collapsed composer bottom padding relies on the dock;
    verify on-device (Capacitor) that `--safe-bottom` is honored when the
    bottom nav hides during keyboard-open streaming.
11. **Overlay stacking**: the model popover, effort menu, and add menu each
    manage their own dismiss/focus (`useModalSurface`, `useDismissibleMenu`,
    `Dialog`). Opening the effort menu while the model popover is closing
    has no guard; add a shared overlay-stack owner or at least a test that
    Escape order is deterministic.
12. **Focus / Escape**: after `Use this model` on desktop the focus returns
    to the chip; on phones it drops to body. Restore focus to the trigger on
    sheet close.
13. **Attachment overflow**: pills wrap on desktop but a pathological count
    (20+) pushes the editor up without a scroll bound; cap the strip height
    with internal scroll.
14. **Composer growth**: `max-height: 42dvh` for the editor is untested with
    `data-band="short"` + attachments + permission banner simultaneously;
    add that combination to the QA driver.
15. **Stale state on switches**: switching agent does not reset effort; if
    the new model lacks thinking variants the chip hides but the persisted
    thinking pref survives and re-appears on switch-back. Decide whether
    that is a feature; test either way. Same question for model switches
    mid-stream (currently applies to the next turn silently).
16. **Interrupted streaming / stop-send transitions**: covered by QA driver
    happy paths; add the edge where the stream ends between tapping Stop and
    the abort round-trip (button flashes back to Send) — debounce or ignore
    late aborts.
17. **Obsolete composer CSS to grep-and-delete**: `composer-selectors`,
    `composer-model-header`, `thinking-slider`, `context-window-chip`,
    `model-trigger-mobile`, `composer-model-meta` are gone from core; grep
    all package stylesheets and tests for stragglers referencing them.
18. **Type safety**: `ModelPicker` details view narrows `ModelDescriptor`
    optionals with inline fallbacks; pull the fallback text into one
    formatter so missing-catalog-fields render consistently.

## Speculative product notes (recorded, not implemented)

- Model chip could show a tiny context-usage meter when near the limit,
  replacing the old always-on context-window picker.
- Favorites could sync per-user rather than per-project.
- The Add menu could learn "recent attachments" from the session event log.
- Effort chip could preview cost multipliers when pricing data exists.

## Where QA artifacts live

- Fixture: `node apps/web/test/wave3aComposerFixtureSetup.mjs`, then start
  the server per its printed instructions (port 4473; tmux session
  `w3a-qa-server` may already be running).
- Driver: `OUT=/tmp/w3a-final node apps/web/test/wave3aComposerQa.mjs` —
  30 screenshots across desktop/phone/320px plus console assertions.
