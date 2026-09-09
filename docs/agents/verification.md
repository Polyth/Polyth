# Verification by risk and evidence

Reduce redundant work, not relevant evidence. Choose the highest applicable risk. A focused test loop comes first; broader checks follow the actual blast radius. No number of documentation checks proves application correctness.

| Change | Minimum useful evidence | Expand when |
| --- | --- | --- |
| Rules/docs/navigation only | Kit check, kit tests, changed links/routes, review wording against cited source | Claims/API references changed: inspect those sources; tools changed: fault/security tests |
| Local pure behavior | Causal unit test and adjacent owner tests | Exports or callers change: consumer typechecks |
| UI/CSS/widget | Relevant unit/interaction/containment checks, affected build and actual visual inspection | Shared primitives/tokens: representative desktop/mobile/theme/preferences states |
| Package entry/export/lifecycle | Discovery, containment, enable-disable and browser build | Public seam changed: all affected consumers, desktop inventory |
| Session/runtime/queue | Reconciliation, uncertain outcomes, replay/restart/race tests | Broad shared behavior: relevant complete suites and root suite as feasible |
| Space/auth/remote policy | Known-valid cross-Space negative cases, ingress/HTTP/WS and revocation tests | Shared security boundary: full relevant security suites and review |
| Storage/migration | Old fixture upgrade, interruption/reopen, idempotence, isolation and recovery | Large/live data: measured performance and explicit operational approval |
| Mobile/native | Shared web tests, relevant native compile plus platform behavior tests | Native plugin/background/permissions: actual affected OS/device scenario |
| CI/release | Syntax/selector/trigger/permissions checks and appropriate build validation | Publication/signing: explicit approval and actual hosted/release evidence |

## Evidence levels

**Source-inspected**: a definition or code path was read. **Declared**: a flag/interface/config says it exists. **Unit-tested**: deterministic isolated test executed. **Integration-tested**: relevant real boundaries exercised. **Live-verified**: actual runtime/provider executed with known environment. **Device-verified**: affected native behavior exercised on a named device/OS/build. These are not interchangeable or strictly cumulative; state exactly what was checked.

A “pass” belongs to a command, commit/dirty state, environment and behavior—not to a whole product. A fake provider can prove translation and races, not current native authentication. A browser can prove responsive layout, not push delivery. A Rust ticket parser can prove parsing, not iOS pairing. A typecheck can prove static compatibility, not authorization correctness.

## Reuse without overclaiming

Within a task, reuse a check result while its relevant code, inputs, toolchain and environment remain unchanged. Re-run after edits that affect it or integration with another workstream. A source hash or unchanged test filename is not enough for transitive dependency changes. Do not run the full suite after every one-line iteration, and do not stop at a tiny passing test for a broad refactor.

Historical baseline failures require a comparable current base run to classify as pre-existing. Keep unresolved failures visible. Do not alter expected results, allowlists, retry counts or selector exclusions merely to get green. If a required command cannot run, say blocked/not-run and why; a source review does not replace it silently.

## Completion record

Use the evidence template for substantive changes: scope, base/head, changed files, requested behavior, exact commands/cwd, exit/counts, environment, visual/native/provider coverage, remaining limits. Keep logs outside committed docs unless a small redacted fixture is necessary. Do not include secrets, full transcripts or invented test counts.
