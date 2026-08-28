# BLOCKER 0 — Polyth HTTP model catalog verdict

Verdict: **PASS**

The empty `/api/models` catalog was fully explained by the stale Polyth process
(PID 19014, started before commit `03478b24`). After killing only that PID,
rebuilding, and starting a NEW Polyth from the fixed code, the HTTP catalog is
populated and matches the OpenCode child exactly.

## Environment

- Polyth URL: `http://127.0.0.1:14500` (left running for UI verification)
- `POLYTH_DATA_DIR=/tmp/polyth-blocker0-after` (fresh)
- Project added via `POST /api/projects {"path":"/workspace"}` (note: the field
  is `path`, not `directory` — `directory` yields `invalid-path`)
- OpenCode child spawned by the new Polyth: `127.0.0.1:33435` (v1.18.18)
- Pre-existing OpenCode processes on 14711/14721 were NOT touched
- Protocol option: auto (default; nothing forced)

## Counts

| Endpoint | Count |
| --- | --- |
| `GET /api/models` (visibility-filtered) | 68 |
| `GET /api/models?all=1` | 68 |
| `GET /api/providers` | 2 providers (google, opencode) |
| OpenCode child `GET /api/model` (raw) | 68 |
| Adapter forced `legacy` (V1) `models()` | 7382 |

- Filtered == all (68 == 68): the visibility filter did not wipe anything;
  `model-visibility.json` in the fresh data dir has empty `disabledProviders`
  and `disabledModels`.
- Auto protocol discovery against the live child selects `v2`
  (see `protocol-evidence.json`; sample V2 model `opencode/x-preview-f-free`).
- Forced-legacy V1 adapter still works against the same live OpenCode and
  returns 7382 models (the legacy wire exposes the full provider catalog, not
  just connected/enabled models — expected shape difference, not a regression).
  Product default remains auto; legacy was exercised only via a standalone
  evidence script (`/tmp/blocker0-protocol-evidence.ts`, copied here as
  `protocol-evidence-script.ts`).

## Tests and typecheck

- Final `node --test packages/backend-opencode/test/protocolV2.test.ts
  packages/backend-opencode/test/protocolContract.test.ts
  packages/backend-opencode/test/adapter.test.ts`: 30 pass, 0 fail, 1 opt-in
  live test skipped.
- Final `node --test packages/backend-opencode/test/*.test.ts`: 98 pass, 0 fail,
  1 opt-in live test skipped.
- `npx tsc --noEmit` in `packages/backend-opencode`: clean (exit 0).

The earlier intermediate test expected `location.workspace`; the live
`LocationRef` schema requires `location.workspaceID`. The implementation and
regression expectation now match the live V2 document. Full current commands
and results are in `final-validation.md`.

## Artifacts

- `polyth-http-models.json`, `polyth-http-models-all.json`,
  `polyth-http-providers.json` — response bodies from PORT 14500
- `protocol-evidence.json` — auto/v2/legacy adapter counts from the live child
- `final-validation.md` — final session/model selection and green regression evidence
- `logs/opencode-real-world/blocker-0-sol/polyth-http-after.log` — new Polyth log
- `logs/opencode-real-world/blocker-0-sol/backend-opencode-tests.log`,
  `backend-opencode-tsc.log` — superseded intermediate test/typecheck output
