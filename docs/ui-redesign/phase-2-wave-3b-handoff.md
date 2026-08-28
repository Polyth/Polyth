# Phase 2 — Wave 3B handoff: composer and picker hardening

Wave 3B hardens the Wave 3A composer, model picker, and agent picker without
changing their interaction model. Waves 4 and 5 have not started.

## 3A hardening checklist

1. **Ghost-hover rule audit — complete.** The coarse-pointer hover reset now
   preserves filled accent, primary, danger, permission, Send/Stop, and model
   details actions.
2. **Component boundaries — complete.** `EffortMenu` is now its own app
   component. Model presentation helpers and picker state moved into focused
   models-package modules. `ModelPicker` consumes explicit `@polyth/web`
   subpath exports instead of reaching into the app with relative imports.
3. **Duplicated agent labels — complete.** Default, option, and active agent
   labels share `agentBadgeLabel`-derived item data.
4. **Picker state reducer — complete.** Search, session overrides, persisted
   expansion, and selected-provider defaults have one tested precedence:
   search > session choice > persisted expansion > selected provider.
5. **Huge-list performance — complete without virtualization.** The fixture
   now has 420 models in one provider and 24 additional providers. Search uses
   a memoized normalized index, grouping is memoized, lookups use keyed maps,
   and an overlay mounts at most 200 model rows. The final browser run found a
   420-model match in 37 ms. True windowed virtualization remains unnecessary
   unless production measurements show the bounded list stuttering.
6. **Search restore behavior — complete.** Search temporarily reveals matching
   groups; clearing it restores the picker-session expand/collapse choice.
7. **Responsive breakpoints — complete.** Shell phone behavior remains
   viewport-owned. A widget composer does not become a docked phone composer.
8. **Models package container ownership — complete.** Narrow picker/settings
   adaptations use container queries. The only remaining package media query
   is the accessibility-level reduced-motion query.
9. **Mobile keyboard / visual viewport — complete in browser QA.** The details
   action is sticky and scrolls above a simulated keyboard inset after search.
10. **Safe areas — implementation and simulated QA complete; native-device
    verification deferred.** The keyboard-open streaming composer retains
    `--safe-bottom` when navigation hides. A real Capacitor device is required
    to validate operating-system inset delivery; no native behavior was
    guessed in this wave.
11. **Overlay stacking — complete.** `useEscape` owns a global LIFO stack so
    only the top transient layer handles Escape. The model picker now uses
    `ResponsiveOverlay`.
12. **Focus / Escape — complete.** Closing the phone model sheet restores
    focus to its trigger; desktop selection and Escape behavior remain
    deterministic.
13. **Attachment overflow — complete.** Pathological pill counts scroll inside
    a two-row height cap instead of pushing the editor indefinitely.
14. **Composer growth — complete.** Browser QA covers short visual band +
    keyboard + eight attachments + pending approval with controls remaining
    above the keyboard and no horizontal overflow.
15. **Stale state and switches — complete.** Agent changes intentionally keep
    effort because effort is model-scoped. Model changes clear the explicit
    next-turn effort, allowing the selected model's own saved preference to be
    derived. Mid-stream model changes configure the next turn without
    interrupting the active turn.
16. **Stop/Send race — complete.** One abort may be pending per active turn.
    If streaming settles before the abort response, idle Send remains
    authoritative and the late response cannot resurrect Stop.
17. **Obsolete selectors — complete.** Deleted composer-header, selector-grid,
    thinking-slider, context-window, mobile-trigger, and model-meta selectors
    are absent from `apps`, `packages`, and active `scripts`. Historical design
    documents retain their explanatory references.
18. **Type safety / catalog fallbacks — complete.** One typed model-details
    formatter handles missing provider name, context, modalities, reasoning,
    tools, pricing, and availability consistently.

## Technical changes

- `apps/web/src/components/Composer.tsx` now delegates effort UI, isolates
  model/agent state rules, keeps widget and shell responsive modes distinct,
  and guards abort transitions.
- `apps/web/src/components/EffortMenu.tsx` owns the discrete effort menu.
- `apps/web/src/components/ui/ResponsiveOverlay.tsx` and
  `apps/web/src/components/mobile/Sheet.tsx` carry explicit focus restoration
  and shared sheet/popover options.
- `apps/web/src/useEscape.ts` implements top-layer-only Escape dispatch.
- `apps/web/src/composerConfig.ts` provides `withModelForNextTurn`.
- `packages/models/widgets/ModelPicker.tsx` uses the reducer, indexed search,
  bounded rows, map lookups, shared overlay, and shared details presentation.
- `packages/models/widgets/modelPickerState.ts` and
  `packages/models/widgets/modelPresentation.ts` isolate state and formatting.
- `apps/web/src/styles.css` bounds attachment growth, preserves filled controls
  on touch, establishes the widget composer container, uses the overlay
  z-index token, and keeps the keyboard-open composer above safe area.
- `packages/models/widgets/styles.css` removes obsolete/cross-owned rules and
  moves narrow embedded behavior to container queries.
- `apps/web/test/wave3aComposerFixtureSetup.mjs` and
  `apps/web/test/wave3aComposerQa.mjs` now cover large catalogs, many
  favorites/providers, rapid expansion and search, focus return, effort/model
  switches, attachment pressure, keyboard/safe-area states, and abort races.

## Cleanup evidence

The runtime and QA selector cleanup was checked with:

```sh
rg 'composer-selectors|composer-model-header|thinking-slider|context-window-chip|model-trigger-mobile|composer-model-meta' apps packages scripts
```

It returns no matches. Historical handoffs/specifications were not rewritten.
The stale selectors in `criticRecheck.mjs`, `ui-states.mjs`,
`ui-evidence.mjs`, and `ui-composer-check.mjs` were migrated to the current
composer controls. `packages/models/widgets/styles.css` now contains no
viewport layout media query.

## Validation

- `npm run build` — pass.
- `npm test` — 1552 pass, 0 fail, 2 skipped.
- `npx tsc --noEmit` in `apps/web` — pass.
- `npx tsc --noEmit` in `packages/models` — pass.
- `OUT=/tmp/w3b-final node apps/web/test/wave3aComposerQa.mjs` — pass against
  the isolated port-4473 fixture; 31 screenshots at desktop 1280, phone 390,
  and 320 px. Final assertions include:
  - no horizontal overflow in desktop/phone/320 and short-band combinations;
  - 420-model search in 37 ms with exactly 200 mounted model rows;
  - rapid distant-provider expand/collapse stays under the row cap;
  - model details, model/agent/effort selection, Escape order, and sheet focus
    return work;
  - 16 attachments remain internally bounded and phone remove targets are
    44×44;
  - details action and composer controls remain above simulated keyboards;
  - model switching does not interrupt streaming;
  - delayed abort completion leaves a stable Send state.
- `POLYTH_URL=http://127.0.0.1:4473 node scripts/ui-composer-check.mjs
  /tmp/w3b-composer-check /p/w3a-project` — pass; current model overlay,
  Escape dismissal, Add trigger, and phone model sheet are exercised.

## Deferred to later waves

- Wave 4 may migrate settings and unrelated feature packages; none were
  changed here.
- Wave 5 may perform broader shell/accessibility polish; this wave only added
  the shared Escape ordering needed by the picker stack.
- Validate real Capacitor safe-area inset delivery on physical iOS/Android
  hardware.
- Add true row virtualization only if production profiling shows that the
  tested 200-row mount ceiling is insufficient.
- Product ideas from the Wave 3A handoff remain notes only: context-usage
  preview, per-user favorite sync, recent attachments, and effort cost hints.

## QA artifacts

Selected final screenshots are stored under `/opt/cursor/artifacts`:

- `wave3b_desktop_large_model_search.png`
- `wave3b_phone_model_details.png`
- `wave3b_320_composer_expanded.png`
