# EXTENSION-SEAMS slice 2 verification

- Case: `UX-EXT-SEAMS-S2`
- Model / role: `SOL` / verifier
- Verified commit: `6f4fe999d0ced2cd6bc7e9d25496931edc370edf`
- Date: `2026-08-20`
- Decision: **CHANGES REQUIRED**

## Verdict

The registry, fallback, gating, late-registration, disposal, and local failure
isolation behavior works, but one required host contract is absent. Slice 2 is
not approved until `EXT-SEAMS-S2-V1` is repaired.

## Changes-required finding

### `EXT-SEAMS-S2-V1` — workspace surfaces do not receive canonical context

The specification requires each surface to receive canonical `projectId` and
`sessionId` values from the host. `WorkspaceSurfaceContext` is declared in
`apps/web/src/workspace/surfaceRegistry.ts`, but the descriptor still types
`component` as `() => ReactNode`. `WorkspaceHost` consequently calls
`createElement(surface.component)` without context props.

A real-Chrome probe registered an active replacement for the `files` surface,
captured its component argument, and observed:

```json
{"received":{},"expected":{"projectId":null,"sessionId":null},"textMounted":true}
```

This leaves contributed surfaces without the specified canonical identity
contract and encourages coupling to internal stores or ad-hoc workspace
authority. The mounted test comment says canonical ids are available, but no
test asserts their delivery.

Required repair:

1. Make the surface component contract accept
   `WorkspaceSurfaceContext`.
2. Pass `{ projectId, sessionId }` from `WorkspaceHost`.
3. Add mounted and real-browser regressions for null and non-null canonical
   ids, including late replacement.

## Passing evidence

- Targeted workspace tests: 11 passed, 0 failed. React emitted cleanup
  `act(...)` warnings from test disposal.
- Full suite: 686 passed, 0 failed, 1 skipped (`687` total).
- `npx tsc --noEmit` passed in `apps/web`.
- `npm run build` passed.
- `git diff --check` passed.
- OpenCode boundary scan found no newly introduced process, SDK, or transport
  access outside the existing server-to-`@polyth/backend-opencode` seam.
- Real Chrome at 1280×900 verified keyboard activation, late registration,
  same-id failure recovery, disposal fallback, and preservation of the header,
  rail, and status bar during a surface failure. At 390×844, the project empty
  state remained visible with zero document overflow.

## Exact next task

`Fable-ux-workspace-surface-host-repairer`: repair `EXT-SEAMS-S2-V1`, add the
canonical-context regressions, and hand the new commit to
`SOL-ux-workspace-surface-host-reverifier`.
