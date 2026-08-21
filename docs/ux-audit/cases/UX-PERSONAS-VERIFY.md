# UX-PERSONAS — SOL verification

- Case: `UX-PERSONAS`
- Model / role: `SOL` / verifier
- Status: `verified`
- Verified: `2026-08-20`
- Product source: `7466c5053d4867f2118e61c0df84cf7dbcfdcd74`
- Specification: `docs/ux-audit/cases/UX-PERSONAS-SPEC.md`

## Verdict

Commit `7466c50` satisfies the UX-PERSONAS acceptance contract for all four
choices and is ready for integration. The optional setup follows project and
runtime readiness, begins with no selected card, and provides a persistent
keyboard-reachable `Skip for now`. Applying a choice changes workspace
placement, starter ordering, and initial composer disclosure exactly as
previewed; it does not remove capabilities or change session history.

The requested nested `computerUse` executor was not exposed to this subagent.
Verification therefore used the repository's real-Chromium Playwright gate in
the isolated implementation worktree at exactly `7466c50`. The gate drove
pointer and keyboard journeys through every card, every preset state, command
search, disclosures, reload, and all required viewports. I also inspected its
fresh screenshots; they show the unselected optional setup at desktop and
phone widths, Design selected at `320px`, Plan's plain and technical layers,
the complete More tools disclosure, and capability search.

## Four-choice result

| Choice | Verified post-apply result |
|---|---|
| Build & debug | Chat, Project files, Source control, Terminal, and Preview lead; technical detail starts open; build/review starters match the schema. |
| Plan & coordinate | Chat, Goals & progress, Usage & cost, Schedule, and Guided walkthrough lead; the first layer is plain; technical tools remain reachable. |
| Design & explore | Chat, Preview, Project files, and Voice input lead; detail starts plain; design starters and the `320px` selected-state presentation match the schema. |
| No preset | Standard Chat, Project files, Preview, and Goals & progress order returns; detail is plain; no identity or disguised preset is stored. |

The legacy `engineer`, `manager`, `creator`, and `blank` values also migrate to
Build & debug, Plan & coordinate, Design & explore, and completed/no preset,
respectively. Exact legacy defaults produce no filtering override. User-added
capabilities become promotions and user-removed defaults move to More tools;
none becomes hidden.

## Acceptance evidence

- Optional sequencing: an empty project registry and runtime failure render
  recovery before setup; a ready project then opens the optional panel.
- Selection and preview: all four cards start unselected, select only a draft,
  and produce primary order, starters, detail, announcement, and persistence
  equal to the generated preview after confirmation.
- Capability invariant: under all four arrangements, every built-in capability
  is reachable from primary navigation or More tools and is found by command
  search. A late registered capability appears, disposes, and reappears without
  mutating preset state.
- Continuity: switching, clearing, and reloading preserve the explicit
  disclosure choice and exact composer draft.
- Accessibility and geometry: Tab, Space, and Escape paths pass; Skip is at
  least `44×44px`; `1280×900`, `768×900`, `390×844`, `320×844`,
  `720×450` at device scale factor 2, and reduced motion have all four cards,
  a visible Skip action, and no horizontal page scroll.
- Event safety: the complete live journey makes no session API write, so it
  cannot append a presentation-only action to the session event log.

## Executed gates

```text
POLYTH_LIVE_ARTIFACTS=/tmp/ux-personas-sol-verify-f4cc-isolated \
  node --test apps/web/test/personas.live.ts
11 passed, 0 failed, 0 skipped

node --test apps/web/test/workspacePresets.test.ts \
  apps/web/test/capabilities.test.ts apps/web/test/smoke.test.ts
91 passed, 0 failed, 0 skipped

(cd apps/web && npx tsc --noEmit)
passed

npm test
688 passed, 0 failed, 1 skipped

npm run build:web
passed
```

Fresh screenshots were written under
`/tmp/ux-personas-sol-verify-f4cc-isolated`; the implementation also commits
the corresponding passing evidence in
`docs/ux-audit/cases/UX-PERSONAS-artifacts/`.

Next stage: integrator.
