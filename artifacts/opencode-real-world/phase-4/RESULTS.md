# Phase 4 — owned-runtime crash recovery (OC-REAL-048 … OC-REAL-061)

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol forced,
matching phases 1–3), Node v22.22.2, workspace git branch
`feat/opencode-real-world-validation-17e1`. Current counts after the targeted
OC-REAL-060/061 reruns: **14 pass.**

Every scenario ran the REAL composition root (`packages/server/src/index.ts boot()`)
on a unique port (initial run 15140–15154; reruns 15260/15261; never 14500) with a unique
`POLYTH_DATA_DIR`, `OPENCODE_CONFIG_DIR` (`opencode.json` harness-owned) and
`XDG_DATA_HOME`. Every forced process stop signalled one recorded exact PID after
verifying its `/proc` identity (start-identity + executable + cmdline); `pkill`
was never used. Kill points were made deterministic with two harness shims that
Polyth spawns as its owned child:

- a delay shim (records its own PID, sleeps before `exec`ing the real binary) for
  the pre-listen window, and
- a fault proxy shim (spawns the real `opencode serve` on an ephemeral port,
  serves Polyth's chosen port itself, and applies per-request rules:
  `kill-on-request`, `swallow-kill` — capture the committed upstream response,
  SIGKILL the exact real child, deliver nothing — and `sse-cut` with optional
  kill) for probe/create/prompt/abort/terminal-SSE windows.

Models: `google/gemini-3.6-flash` for all fault turns (its live streaming and
tool use were verified in preflight). Mid-text/mid-reasoning windows were held
open deterministically by staging the prompt (durable text/reasoning checkpoint,
then a long pre-allowed `sleep` bash tool).

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-048 | **PASS** | Exact child SIGKILLed after spawn but before its listen line (12 s delay shim window). The triggering create failed bounded (< 30 s, 5xx, honest error), the exact child was cleaned with no orphan and no stale PID record, no ready generation was installed, and a later request built one fresh generation with a verified identity-complete PID record. |
| OC-REAL-049 | **PASS** | Exact child SIGKILLed on the first readiness probe after its listen line (`kill-on-request ^/global/health`). The failed generation was never exposed (503 inside the 10 s startup deadline), no SSE stream ever attached to it, and later requests built one fresh generation (fresh child PID; no dead-URL reuse) that served the catalog and session create. |
| OC-REAL-050 | **PASS** | Upstream committed the session create (200 with `ses_…` captured on the wire), then the exact child died and the response was swallowed. The canonical shell survived unbound with a durably `unknown` session-create operation; no automatic second `POST /session`, no shell deletion, no similarity adoption of the orphan; sqlite ok. |
| OC-REAL-051 | **PASS** | Upstream accepted `prompt_async`, then the exact child died and the response was swallowed. One durably `unknown` turn-submit operation, user intent exactly once, no turn/started fabrication, a second identical send was blocked, and the wire shows exactly one prompt POST across recovery (no replay). Projection honest (`unknown`). |
| OC-REAL-052 | **PASS** | Exact child SIGKILLed mid-turn after a durable text checkpoint (staged prompt: paragraph → `sleep 30` tool → paragraph). The durable prefix survived unchanged at its original sequence numbers, no part finalized twice, no invented suffix/completion, steady state settled honest `unknown` (working → reconciling → unknown), sqlite ok. |
| OC-REAL-053 | **PASS** | Exact child SIGKILLed mid-reasoning before any answer text. Durable reasoning chunks survived unchanged as reasoning (`assistant/reasoning-chunk`), reasoning was never rendered as answer text, no invented completion, no false idle; steady state `unknown`. |
| OC-REAL-054 | **PASS** | Exact child SIGKILLed while a bash tool call was durably pending behind a permission gate (`bash=ask`), before execution. No fabricated `tool/result`, the gated side effect never happened, the pending tool + permission request stayed explicit in durable history, steady state honest (`waiting` → reconciling → unknown). |
| OC-REAL-055 | **PASS** | Exact child SIGKILLed after an observable side effect (`echo ran >> effect-055.txt`) while the tool was still running (no terminal tool event). Exactly one side-effect line before and after recovery (tool never repeated), prompt never repeated, no fabricated result, uncertainty not hidden (`unknown`). |
| OC-REAL-056 | **PASS** | Exact child SIGKILLed while a permission was durably open. The request never vanished from durable history, the post-kill `once` answer settled bounded (38.5 s) with an explicit `outcome-unknown` error — never silently routed to the replacement child (the gated tool never ran) — and steady state was honest `unknown`. |
| OC-REAL-057 | **PASS** | Exact child SIGKILLed while a model question (`question.asked`) was durably open. The question survived unduplicated, the post-kill answer settled bounded (175 ms, explicit `outcome-unknown`), no invented completion, steady state honest `unknown`. |
| OC-REAL-058 | **PASS** | Abort request accepted upstream, then the exact child died and the abort response was swallowed. Polyth surfaced the ambiguity honestly (`200` = request durably recorded, projection flipped to reconciling/unknown immediately), the turn-abort operation stayed durably `unknown`, no abort retry on the wire, queue admission stayed blocked (409, zero extra prompt dispatch), no false interrupted. |
| OC-REAL-059 | **PASS** (+ bug found & fixed) | Terminal committed upstream; the `session.idle` SSE frame was withheld and the exact child SIGKILLed. Output + one ordered terminal survived exactly once, no replay; final projection honest `unknown` (owned continuity is generation-only — the spec's unversioned-evidence arm). Found and fixed a wedge: after an exit-notification race, `lease.endpoint()` handed out the known-dead endpoint forever (no respawn ever; negotiation failed against a closed port on every 5 s retry until full restart). Fix in `packages/backend-opencode/src/endpoint.ts` (`endpoint()` aliveness check) + regression test in `runtimeLifecycle.test.ts`; re-run shows the fresh generation respawning. |
| OC-REAL-060 | **PASS (RERUN)** | Current-code rerun after durable authority + server rebind fix: Polyth was SIGKILLed mid-turn while the exact owned wrapper/child stayed alive. Restart reaped that identity and spawned generation 2 under the same durable authority; first-wire abort returned 200 in 30 ms, status settled honestly to `unknown`, and the wire/event log showed one prompt, one intent, and one side effect. SQLite integrity was `ok`; no stale `sending`/`working`. Evidence: `OC-REAL-060-RERUN/`. |
| OC-REAL-061 | **PASS (RERUN)** | Exact real child was SIGKILLed mid-turn, then Polyth 150 ms later; Polyth restarted first and OpenCode respawned second. Authority stayed stable, generation advanced 1→2, first-wire abort returned 200 in 29 ms, status settled `unknown`, and WAL/PID identity checks passed with one prompt, intent, and side effect. Evidence: `OC-REAL-061-RERUN/`. |

## Findings

1. **FIXED — owned lease could wedge permanently on a dead endpoint
   (surfaced by OC-REAL-059).** When the one-shot post-disconnect refresh raced
   Node's child exit notification (`alive()` still true), the failed build left
   `lease.endpoint()` returning the dead generation forever; the SSE loop retried
   negotiation against a closed port every 5 s and no respawn was ever attempted.
   Localized fix with known semantics (the lifecycle comment already requires
   failed generations to "ask the lease to recover"): `endpoint()` now treats a
   known-dead instance like a missing one and respawns.
   `packages/backend-opencode/src/endpoint.ts`; regression test
   `endpoint() never hands out a dead owned child; it respawns`.

2. **FIXED — durable owned authority and generation reattachment
   (OC-REAL-060/061 reruns).** The owned local lease now persists its logical
   authority and advances its generation fence before every child spawn. The
   server rebinds an exact persisted backend session ID only when authority,
   protocol, and location still match an owned endpoint, then reconciles on the
   current generation. Runtime lifecycle calls and callbacks from an old
   generation remain rejected. Both real reruns returned 200 on first wire,
   transitioned stale active projections to honest `unknown`, and retained
   exactly one prompt, user intent, and tool side effect. The backend regression
   `packages/backend-opencode/test/regressionOwnedAuthorityRestart.test.ts`
   remains green.

3. **Observation — projection honesty after owned-child death is `unknown` by
   design.** All mid-turn kills settled `working/waiting → reconciling → unknown`
   (bounded, ~20 s): owned local endpoints are `generation-only` continuity, so a
   respawned generation can never prove binding continuity and reconciliation
   blocks conservatively instead of guessing idle/completed. No scenario showed
   a stuck `sending/running/waiting` state while the server itself stayed alive.

## Stop-the-line invariants

No duplicate mutation, no queue/intent loss, no invented completion/suffix, no
similarity adoption, no PID-reuse signalling, and no sqlite corruption was
observed in any scenario. BLOCKERs 4, 5 and 9 (V2 service discovery, event-family
omission matrix, multi-browser under backend death) were not in scope and were
not triggered.

## Evidence layout

Per scenario: `artifacts/opencode-real-world/phase-4/<ID>/{manifest.json,verdict.json,details.json}`
and bounded raw logs under `logs/opencode-real-world/phase-4/<ID>/`
(`polyth.log`, `fault-timeline.ndjson`, `db-*.json` sqlite extracts, and for
proxy scenarios `proxy-wire.ndjson`, `proxy-timeline.ndjson`,
`proxy-opencode.log`, `proxy-captured-*.json`).
