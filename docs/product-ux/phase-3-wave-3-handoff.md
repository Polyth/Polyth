# Phase 3 Wave 3 — agent workflow handoff

Wave 3 status: **complete (code and docs)** on
`feat/phase-3-product-ux-mobile-bb96`.

## Shipped units

### Adaptive Multirun comparison

Commit `58989467` (`feat(multirun): add adaptive compare workflow`) changed:

- `packages/multirun/widgets/MultiRunView.tsx`
- `packages/multirun/widgets/multirunView.ts`
- `packages/multirun/widgets/styles.css`
- `packages/multirun/src/index.ts`
- `packages/multirun/test/multirun.test.ts`
- `packages/multirun/test/multirunView.test.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/reduce.ts`

It establishes a prompt/setup phase, truthful progress summary, one selected
response, per-run reported usage, pick/continue actions, and adaptive
desktop/phone navigation.

### Fusion provenance

Commit `f87baf4a` (`feat(fusion): surface synthesis provenance`) changed:

- `packages/fusion/widgets/FusionView.tsx`
- `packages/fusion/widgets/styles.css`
- `packages/fusion/src/index.ts`
- `packages/fusion/test/fusion.test.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/reduce.ts`

It separates source collection from synthesis, leads with one answer, and
retains source answers, normalized attribution, and disagreements as disclosed
evidence.

### Durable background working state

Commit `f2e36de3` (`feat(ux): keep background agent work visible`) changed:

- `packages/plugins/src/backgroundWork.ts`
- `packages/multirun/src/serverEntry.ts`
- `packages/fusion/src/serverEntry.ts`
- `packages/contracts/src/index.ts`
- `apps/web/src/sessionStatus.ts`
- `apps/web/src/notifications.ts`
- `apps/web/src/notify.ts`
- `apps/web/src/components/Composer.tsx`
- targeted tests in `packages/plugins/test/` and `apps/web/test/`

Multirun and Fusion now update a durable projection-owned work count. The D17
status resolver presents the owning session as `Working` while either workflow
continues, and terminal results use the existing notification pipeline.

### Product documentation

The documentation commit `docs(ux): Phase 3 Wave 3 agent workflow handoff`
adds:

- `docs/product-ux/phase-3-agent-workflows.md`
- `docs/product-ux/phase-3-wave-3-handoff.md`

## Desktop and mobile models

Desktop Multirun uses a progress summary, compact model tabs, and one response
detail panel. Phone Multirun uses overview → selected-run detail → back to
overview. Both operate on the same React component, DTOs, and event-backed
state.

Fusion keeps the same semantic hierarchy at every width: setup, working state,
synthesized answer, then disclosed provenance and disagreements. Styling adapts
inside its package surface; there is no separate mobile implementation.

Agent selection remains the existing backend-backed composer picker. The
selected agent applies to the next message in the same session. Wave 3 did not
add a competing global agent switcher.

Global phone and desktop navigation share the D17 session-status resolver.
Background workflow state is therefore visible after the user leaves its
surface.

## Validation completed before this documentation

The implementation commits were validated with Node 22.22.2. The recorded
targeted results were:

- Multirun tests: **12 passed**
- Fusion tests: **7 passed**
- background-work, session-status, and notification tests: **22 passed**
- TypeScript checks: passed in the touched packages and `apps/web`

The corresponding targeted command groups were:

```sh
node --test packages/multirun/test/*.test.ts
node --test packages/fusion/test/*.test.ts
node --test packages/plugins/test/backgroundWork.test.ts apps/web/test/sessionStatus.test.ts apps/web/test/notifications.test.ts
npx tsc --noEmit # run from each touched package and apps/web
```

A later full-suite validation attempt did not produce a recorded terminal
result before the prior run ended. This handoff therefore does not claim a
green full suite.

## Deliberate skips and remaining gaps

- No separate activity feed: the conversation timeline remains the canonical
  event-ordered history.
- No deeper task hierarchy: the backend exposes flat created/started/completed/
  failed task activity, not nested, blocked, retry, or cancelled semantics.
- No speculative Fusion usage estimate: the runner does not report utility-run
  cost or tokens.
- No dedicated agent-switch surface: the composer and Multirun already consume
  the backend agent catalog.
- Wave 4 owns a Capacitor client shell, native lifecycle and platform bridges,
  safe-area/keyboard integration, runtime connection onboarding, and native
  project scaffolds. It must not run OpenCode on the phone or fork the web UI.
- Wave 5 owns final Phase 3 integration and the top-level Phase 3 handoff. Wave
  3 does not claim that work.

## Wave 4 reading order

Before implementation, Wave 4 must read:

1. `AGENTS.md`
2. `docs/dev/architecture.md`
3. `docs/dev/desktop.md`
4. `docs/dev/styles.md`
5. `docs/product-ux/phase-3-agent-workflows.md`
6. `docs/product-ux/phase-3-wave-3-handoff.md`
7. the Wave 1 D15 navigation/back contract
8. the Wave 2 recovery and D17 status handoff
9. `apps/desktop/`, the `apps/web` bootstrap, `apps/web/src/mobileViewport.ts`,
   `apps/web/src/sync.ts`, auth routes, and attachment upload paths

The architecture boundary is mandatory: the Polyth server and OpenCode remain
on desktop/server Node. A native mobile app connects to an existing Polyth
runtime as a client and consumes the canonical web build.
