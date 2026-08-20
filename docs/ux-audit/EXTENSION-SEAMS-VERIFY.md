# EXTENSION-SEAMS independent verification

- Case: `UX-EXT-SEAMS`
- Model / role: `SOL` / verifier
- Reverified commit: `5116c127522d831a39995dc616a48d0b1b2f9fcf`
- Date: `2026-08-20`
- Decision: **APPROVED**

## Verdict

The repairs for `EXT-SEAMS-V1`, `EXT-SEAMS-V2`, `EXT-SEAMS-V3`, and the
`app.nav` bounded context satisfy the slice-1 acceptance criteria. No
changes-required finding remains.

## Repair evidence

| Check | Result | Evidence |
|---|---|---|
| `EXT-SEAMS-V1` | Pass | Mounted React and real-Chrome probes kept a healthy sibling visible after a contribution throw, then visibly recovered the failed contribution after same-id replacement without remounting the host. |
| `EXT-SEAMS-V2` | Pass | The rail bridge delivered the current shared `RailSurfaceContext` (`changeCount`, `eventCount`, `totalTokens`, `hasSession`) to a `workspace.right.tabs` renderer; the regression also proves later calls receive fresh values. |
| `EXT-SEAMS-V3` | Pass | A real Chrome refresh at `/p/verify-project/s/verify-session` returned the shell and loaded `/bundle.css` plus `/bundle.js`; the server regression proves missing asset-like paths return 404 rather than the HTML fallback. |
| `app.nav` | Pass | At 1280×900 the mounted probe received `{ projectId: null, sessionId: null, expanded: true }` while the sidebar computed to `display: flex`. At 800×900 it updated reactively to `expanded: false` while the sidebar computed to `display: none`. |

## Verification runs

- Targeted regressions: 26 passed, 0 failed.
- Full suite: 675 passed, 0 failed, 1 skipped (`676` total).
- TypeScript: `npx tsc --noEmit` passed in `apps/web`,
  `packages/contracts`, `packages/plugins`, and `packages/server`.
- Production build: `npm run build` passed.
- OpenCode boundary scan found only the allowed server import of
  `@polyth/backend-opencode`; no direct SDK/process access was introduced.
- Real-browser checks used installed Google Chrome through Playwright because
  no interactive computer-use executor was available to this verifier.

The targeted multi-file run emitted React `act(...)` cleanup warnings while
disposing mounted test registrations. The same assertions and full suite
passed; this is test-output hygiene, not a product or acceptance failure.

## Exact next task

`Fable-ux-workspace-surface-host-implementer`: implement EXTENSION-SEAMS slice
2, “Workspace surface host,” without beginning pane-provider work.
