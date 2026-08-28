# Phase 5 — shared/discovered V2 service ownership (OC-REAL-062–067)

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (V2 protocol, forced) on
Polyth SHA `1d833613ddf861f28dd6a48a9efa3977ae7345e6`, Node `v22.22.2`.
Runner: `artifacts/opencode-real-world/phase-5/tools/run-phase-5.mjs`. Shared
services were started as external harness processes under
`/tmp/ocreal/phase-5/run-mtcnyz9q`; Polyth attached only through the borrowed
endpoint seam (`createBorrowedServiceEndpointLease` + facade/lifecycle). All ports
were dynamically bound (never 14500); every forced process signal targeted a
recorded exact PID after `/proc` identity validation.

Scenario count: **0 pass, 4 fail (3 POLYTH, 1 OPENCODE), 2 blocked.**

**BLOCKER 5 (shared-service ownership escalation): NOT HIT.** No scenario stopped,
signalled, or reconfigured the shared service; the shared PID survived every
borrowed shutdown with health 200 and its external SSE client still connected.

**Cross-cutting limitation (applies to every row):** normal Polyth composition
still cannot select a borrowed/shared endpoint — product boot on the occupied port
spawns an owned child that exits (`ServeError`) and returns 503 instead of joining
— and OpenCode 1.18.18 exposes no authoritative discovery descriptor. These rows
are V2 acceptance gates; the borrowed seam evidence below is NOT product
acceptance. Product shared-attach is an architectural gap, not patched here.

| ID | Engine | Verdict | Attribution | Result |
| --- | --- | --- | --- | --- |
| OC-REAL-062 | R | **FAIL** | POLYTH | The borrowed seam joined the pre-existing real V2 service (PID 86741) with an active session and an external SSE client: no spawn/stop/config authority, and the active session was listed and hydrated (user prompt + assistant reasoning). Fail because normal product boot on the occupied port still attempted an owned child and returned 503 `ServeError` instead of joining. |
| OC-REAL-063 | R | **BLOCKED** | — | Borrowed facade/lifecycle shutdown detached cleanly: the shared PID kept the same `/proc` start identity, `/health` stayed 200, and the external SSE client stayed connected (byteCount/eventCount unchanged, stream not ended). Product-level acceptance is blocked because normal boot cannot borrow, so the product can never enter this state. |
| OC-REAL-064 | R+H | **FAIL** | POLYTH | Service replaced (port 38607 -> 40805): a live borrowed lease advanced generation 1 -> 2, listed/hydrated the surviving session, and rejected its stale binding with typed `binding-mismatch` ("session generation is stale and endpoint continuity is unverified"). Fail: a FRESH Polyth-side lease over the replacement reset generation to 1 and accepted the same generation-only stale binding (state `unknown`, partial completeness) without explicit continuity proof — URL/generation equality stood in for continuity. |
| OC-REAL-065 | R+H | **BLOCKED** | — | Injected descriptor refresh covered auth-only, URL-only, and combined URL+auth rotation: every fingerprint change advanced generation (1 -> 2 -> 3 -> 4), valid credentials returned 200, stale credentials returned typed 401 `UnauthorizedError`, and no secret value was recorded (headers redacted, names only). Blocked for acceptance: official in-flight discovery-driven rotation does not exist in 1.18.18, so this remains a closest-supported probe. |
| OC-REAL-066 | R | **FAIL** | OPENCODE | Ordinary root/worktree catalogs on one shared service stayed directory-isolated for all four locations (each catalog contained only its own sessions; no foreign IDs). Fail: the same client-supplied session ID created in project A and then in project B collided — project B's create and `GET` from project B's directory both returned project A's session (location `project-a`) with HTTP 200 — location keys do not fence client-chosen IDs. Real workspace discovery returned no identities; product shared attach remains unavailable. |
| OC-REAL-067 | R | **FAIL** | POLYTH | One shared session driven by two official V2 SDK clients plus the Polyth borrowed facade: all three durably admitted distinct queue markers (admittedSeq 1, 2, Polyth confirmed admission, then seq 4), and client two's abort was accepted (204). Fail: Polyth history/reconcile exposed only the promoted first message (client one's marker) and hid the later external/Polyth admissions that official durable history retained — external writers' newer facts are invisible to Polyth. No permission request materialized in this run (permission views stayed empty), so the permission-conflict leg is unproven. |

## Findings

1. **[POLYTH, architectural] No product shared-attach.** Normal boot cannot select
   the working borrowed endpoint seam; occupied-port startup returns generic 503.
   This is the acceptance blocker for every row above and needs composition-level
   wiring (documented, deliberately not implemented in this validation pass).
2. **[POLYTH] Fresh-lease continuity laundering (OC-REAL-064).** A restarted
   Polyth side that re-creates its borrowed lease resets generation to 1 and will
   re-accept a binding that a continuously-alive lease correctly fenced.
3. **[OPENCODE] Client-supplied session ID collisions cross project locations
   (OC-REAL-066).** `1.18.18` binds a colliding create to the first project and
   serves it under other directories with 200.
4. **[POLYTH] External admissions hidden (OC-REAL-067).** Polyth's
   history/reconcile view of a shared session shows only its own promoted head,
   not newer external durable messages.
5. **[OPENCODE] V2 message page limit.** Durable history with `limit=200` was
   rejected: `Expected a value less than or equal to 100` — stricter than the
   `limit <= 200` found in Phase 1 V2.

## Evidence map

- Per-ID verdicts: `artifacts/opencode-real-world/phase-5/OC-REAL-0{62..67}/verdict.json`
  (+ `manifest.json`, `details.json` per scenario).
- Runner: `artifacts/opencode-real-world/phase-5/tools/run-phase-5.mjs`.
- Shared service logs, auth rotation logs, process timeline, and full run record:
  `logs/opencode-real-world/phase-5/` (`shared-primary-*.log`, `auth-url-*.log`,
  `process-timeline.ndjson`, `run.json`, `runner.{stdout,stderr}`).
