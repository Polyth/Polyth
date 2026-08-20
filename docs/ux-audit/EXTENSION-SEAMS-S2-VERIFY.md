# EXTENSION-SEAMS slice 2 verification

- Case: `UX-EXT-SEAMS-S2`
- Model / role: `SOL` / verifier
- Verified repair head: `39ef05b13aa19202d8d5a7f92a620a749ea3cebe`
- Functional repair: `d6c4c752707dc7203b618a66c9488905a1d27fba`
- Date: `2026-08-20`
- Decision: **VERIFIED**

## Verdict

`EXT-SEAMS-S2-V1` is closed. Every mounted workspace surface now receives the
canonical `{ projectId, sessionId }` props from `WorkspaceHost`, including
explicit nulls, reactive non-null identity, session clearing, and the first
render of a late same-id replacement. Slice 2 is approved for integration.

## Closed finding

### `EXT-SEAMS-S2-V1` — canonical workspace context is delivered

The descriptor contract now accepts `WorkspaceSurfaceContext`, and
`WorkspaceHost` passes the canonical store-derived IDs to the selected
surface. Requirement gates still run before the contributed component mounts,
and the boundary reset key remains identity- and registration-sensitive.

The repaired live gate no longer races URL-driven session activation. It waits
for the exact ID-bearing probe text before inspecting captured props, then
checks that a late same-id replacement receives those same IDs on its first
render.

## Verification evidence

- Targeted registry and mounted-host tests: 12 passed, 0 failed. The repaired
  canonical-context case passed; existing cleanup-time React `act(...)`
  warnings remain non-failing.
- Real Chrome live context gate: 2 passed, 0 failed. It covered explicit null
  IDs, real project/session IDs restored from a deep link, and first-render
  context for a late same-id replacement.
- Full suite: 687 passed, 0 failed, 1 skipped (`688` total).
- `npx tsc --noEmit` passed in `apps/web`.
- `npm run build` passed.
- `git diff --check` passed.
- The repaired workspace host files introduce no OpenCode process, SDK,
  transport, or direct-fetch access.

## Exact next task

`SOL-EXT-SEAMS-S2-INTEGRATOR`
