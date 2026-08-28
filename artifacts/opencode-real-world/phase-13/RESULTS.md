# Phase 13 — independent reliability verification (adversarial re-checks)

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol forced)
on branch `feat/opencode-real-world-validation-17e1`, Node v22.22.2. Nothing from
prior phases was assumed: every guarantee below was re-derived from current
source and then attacked with a fresh harness run against a real
`opencode serve` where a live attack is expressible. All ports were OS-assigned
(never 14500); every forced process stop signalled one recorded exact PID after
`/proc` identity verification (start tick + cmdline); `pkill` was never used.

New harness: `scripts/opencode-real-world/phase13.ts` (+ `phase13lib.ts`,
`phase13_g1_life1.ts`). Reruns used the existing unmodified harnesses
`s041_047.ts` (phase 3) and `phase6_068.ts` (phase 6). Targeted unit suites
(transportFaults, runtimeLifecycle, regressionOwnedAuthorityRestart,
runtimeOperations, queueLease, runtimeReconciliation, mutationOutcome) were run
first: 54/54 pass (`node --test`).

## Verdicts

| # | Guarantee | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Crash after successful prompt HTTP response, before settle -> no duplicate prompt on restart | **PASS** (P13-G1) | `P13-G1/details.json`, `logs/.../P13-G1/wire.ndjson` |
| 2 | Two clients reply to one permission ms apart -> one winner | **PASS** (P13-G2) | `P13-G2/details.json` |
| 3 | Missed permission SSE recovered by pending-list pull after reconnect | **PASS** (OC-REAL-042 rerun) | `P13-G3-ocreal042/verdict.json` |
| 4 | Stale observation cannot overwrite a newer checkpoint | **PASS (same-generation, real); cross-generation remains deterministic-only** (OC-REAL-046 rerun, harness verdict `partial`) | `P13-G4-ocreal046/verdict.json` |
| 5 | Owned child crash never leaves sending/working forever | **PASS** (P13-G5, strict settle) | `P13-G5/details.json` |
| 6 | Shared/borrowed process is not signalled on Polyth shutdown | **PASS** (P13-G6) | `P13-G6/details.json` |
| 7 | Worktree IDENTITY.txt never executes as another project | **PASS** (OC-REAL-068 rerun) | `P13-G7-ocreal068/verdict.json` |
| 8 | Finite REST calls have deadlines | **PASS** (P13-G8) | `P13-G8/details.json` |

## Detail

### 1. P13-G1 — crash between upstream prompt commit and settle

The stated attack ("kill Polyth before it would persist the operation row")
is impossible by construction in current source, and the run proves it: the
turn-submit operation row and the `user/message` intent are committed in one
SQLite transaction by `prepareOperation` BEFORE `claimOperation` and the wire
POST (`packages/server/src/sessions.ts` `admitTurnCoreUnfenced` ->
`runPreparedOperation`). A read-only snapshot taken by the orchestrator at the
instant the prompt POST hit the proxy already showed the row in state
`executing`, `replay_kind='never'`.

The closest achievable window was then attacked for real: a recording proxy
forwarded `POST /session/<id>/prompt_async` to real OpenCode, captured the
committed 204, delivered NOTHING back, and the exact life-1 Polyth process
(identity-verified) was SIGKILLed mid-await. A second Polyth life opened the
same database: store startup recovery flipped the operation `executing` ->
`unknown` (`mutation/uncertainty-recorded`), a second send was refused with a
typed `conflict` ("cannot send while operation … is unknown"), abort settled
the session honestly to `unknown`, and the wire held **exactly one** marker
prompt POST across both lives. `user/message` appears exactly once.

### 2. P13-G2 — permission reply race

Real bash permission (`bash=ask`, `opencode/big-pickle` via real serve).
Two replies raced 3 ms apart with OPPOSITE answers (`once` vs `reject`):
exactly one fulfilled (`once` won), exactly one upstream
`POST /session/<id>/permissions/<rid>`, exactly one durable
`permission/resolved`, zero pending upstream afterwards, and the loser got the
typed conflict `permission request already resolved`. Mechanism in source: the
`response_intents` table's `PRIMARY KEY (session_id, kind, request_id)`
compare-and-set (`chooseResponseIntent`) plus the per-session lock; unit
coverage "response intent compare-and-set records one winner" also passes.

### 3. OC-REAL-042 rerun — pending-pull recovery

Code check: legacy `reconcile` (`packages/backend-opencode/src/protocolLegacy.ts`)
still pulls `/permission` and `/question` into every snapshot alongside
`/session/status` and the message list. Live rerun: the `permission.asked` SSE
frame was dropped by the proxy, the pull recovered exactly one durable card
after reconnect, one reply POST, nothing pending after. PASS.

### 4. OC-REAL-046 rerun — stale observation fencing

Live rerun: 2 real tool-start frames were held while the turn completed and a
pull/current terminal checkpoint was committed; releasing the stale frames
changed **zero** durable tool events and no rank regressed. The harness grades
the row `partial` solely because cross-generation staleness cannot be forced
against a single real serve (that arm stays covered deterministically by
`packages/session/test/runtimeOperations.test.ts` /
`packages/server/test/runtimeReconciliation.test.ts`, all green). The
guarantee under test — stale frames cannot overwrite the newer checkpoint —
held.

### 5. P13-G5 — owned child SIGKILL mid-turn

Real Polyth-owned `opencode serve` child (production
`createOwnedLocalEndpointLease`), turn active mid-bash-tool (`sleep 45`).
The exact child (PID record + `/proc` start-identity match) was SIGKILLed at
status `working`. Strict settle predicate (`reconciling` explicitly NOT
accepted as settled): `working -> reconciling (0.5 s) -> unknown (15.5 s)`,
stable thereafter; no orphaned child remained. A first, weaker run of this
scenario accepted `reconciling` as a settle — the predicate was tightened and
the rerun still passed; only the strict run is retained as evidence.

### 6. P13-G6 — borrowed process survives shutdown

Production `createBorrowedExternalEndpointLease` against an external real
serve; session created and a real turn completed; then full Polyth shutdown
(runtime facade dispose + lifecycle dispose + store close + lease dispose).
The shared process received **no signal** (exit listener never fired), kept
its `/proc` start identity, and still answered `GET /session` with 200.
Source check: both borrowed lease `dispose()` implementations in
`packages/backend-opencode/src/endpoint.ts` only detach references; the only
code paths that signal a process are owned-lease `stop()` and `reapPidFile`,
both fenced by exact `/proc` identity + instance-token match.

### 7. OC-REAL-068 rerun — worktree identity isolation

Production `boot()` with 2 git roots + 2 worktrees, identical prompt reading
`IDENTITY.txt`: each of the four concurrent sessions answered with exactly its
own marker; upstream cwd, tool paths, directory catalogs, and durable logs
never crossed locations. PASS (fresh evidence copied to `P13-G7-ocreal068/`;
the committed phase-6 evidence directory was left untouched).

### 8. P13-G8 — REST deadlines

Source check: the only wire client is `createOpenCodeTransport`
(`transport.ts`); `query`/`mutate` REQUIRE `deadlineMs` and
`validateDeadline` rejects non-finite/non-positive values; retries share one
deadline budget. Only the SSE `stream` is deliberately deadline-free (it is
abort-signal-bound, not a finite call). Live black-hole probe: single-attempt
query with 1500 ms deadline rejected `OpenCodeDeadlineError` at 1503 ms;
3-attempt query with a 2000 ms budget rejected at 2001 ms (budget shared, not
multiplied); mutate settled `kind:"unknown"` at 1501 ms; `Infinity`, `0`, and
negative deadlines all rejected with `RangeError`. The one non-transport
`fetch` in the backend (`browserTool.ts`) targets Polyth's own bridge and is
bound to the tool-call abort signal.

## What still fails / open qualifications

- No new bug was reproduced in this phase; no fix was required.
- G4 cross-generation fencing remains proven only deterministically (real
  single-serve runs cannot mint an old generation) — unchanged from phase 3.
- G6 is proven at the borrowed endpoint seam; normal product boot still cannot
  SELECT a borrowed/shared endpoint (phase-5 finding, architectural,
  deliberately not patched here), so the product cannot yet reach the state
  this guarantee protects.
- Known open POLYTH findings from phases 5–6 (fresh-lease continuity
  laundering, shared `sessionIdMap` delete coupling
  `regressionSharedSessionIdMap.test.ts`, post-fork parent terminalization
  stall, no session re-verification after endpoint rotation) are outside the
  eight guarantees verified here and remain open.

## Evidence layout

- New scenarios: `artifacts/opencode-real-world/phase-13/P13-G{1,2,5,6,8}/`
  (`verdict.json`, `details.json`, `manifest.json`) with bounded logs under
  `logs/opencode-real-world/phase-13/`.
- Rerun copies: `P13-G3-ocreal042/`, `P13-G4-ocreal046/`, `P13-G7-ocreal068/`
  (verdict/details/manifest of the fresh reruns executed in this phase).
- Harness: `scripts/opencode-real-world/phase13.ts`, `phase13lib.ts`,
  `phase13_g1_life1.ts`.
