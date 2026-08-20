# UX-PANE-MODEL — SOL verification

- Case: `UX-PANE-MODEL`
- Model / role: `SOL` / verifier
- Target: `e6cadf8` (Fable repair)
- Status: `verified`
- Verified: `2026-08-20`

## Verdict

Integrate `e6cadf8`. The Fable repair closes both P0 findings from the initial
SOL review. The live Chromium gate restores an open Files pane on canonical
session reload without React `#185`, preserves the fresh-session hero draft,
and keeps the dock decision stable. At `1440/1200/1024/1000/900`, the settled
full composer either remains safely docked with every visible action winning
its center hit test or promotes to the inert full-screen safety layer.

## Verification method

The target commit was checked in an isolated worktree. The self-contained live
gate built the current web bundle, launched the real server and OpenCode
runtime with throwaway project/data directories, and drove Google Chrome
stable through `playwright-core`.

Automated evidence:

- `node --test apps/web/test/dockGuard.test.ts apps/web/test/workspacePane.test.ts apps/web/test/pane.test.ts apps/web/test/surfaces.test.ts`: `40/40` passed.
- `node --test apps/web/test/paneModelGuard.live.ts`: `7/7` passed.
- `(cd apps/web && npx tsc --noEmit)`: passed.
- `npm run build:web`: passed.
- `npm test`: `715` passed, `1` skipped, `0` failed.

## Repair closure

- `PANE-VERIFY-01`: closed. The guard observes settled Chat, composer, and
  action geometry; overlap and clipping force a stable full-screen promotion.
- `PANE-VERIFY-02`: closed. Guard promotion remains latched across its own
  dock-to-layer geometry transition, and the canonical reload retains exactly
  one app, hero composer, open pane, and byte-exact draft.
- The repaired live harness waits for the actual `.composer-hero` and
  `.rail-workspace`, and verifies the durable event type as `user/message`, so
  every passing assertion reaches the intended session state.

No blocker. Next stage: `SOL-PANE-MODEL-INTEGRATOR`.
