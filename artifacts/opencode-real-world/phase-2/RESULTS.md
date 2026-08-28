# Phase 2 — mutation-ambiguity torture

Executed 2026-08-28 against real OpenCode CLI `1.18.18` with a transport-only
HTTP/SSE fault shim. Result: **6 pass, 1 fail; no duplicate-mutation blocker**.

| ID | Verdict | Exactly-once result | Evidence |
| --- | --- | --- | --- |
| OC-REAL-034 | **PASS** | 12/12 timing variants: one POST, one canonical/upstream user message, one upstream agent turn, durable unknown, second send blocked. | [verdict](OC-REAL-034/verdict.json), [case details](OC-REAL-034/repeats.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-034/wire.ndjson) |
| OC-REAL-035 | **PASS** | Real 200 response reset after 31/1615 bytes; one POST and one unknown operation. | [verdict](OC-REAL-035/verdict.json), [body boundary](OC-REAL-035/partial-body.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-035/wire.ndjson) |
| OC-REAL-036 | **PASS** | Real acceptance plus 12 s response delay returned unknown at 10004 ms; late release did not settle; one POST. | [verdict](OC-REAL-036/verdict.json), [deadline details](OC-REAL-036/timeout.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-036/wire.ndjson) |
| OC-REAL-037 | **FAIL (ENV)** | Final real prompt admission produced no observable terminal event, so the head was never reserved and accepted-head ambiguity was not reached. Both FIFO rows survived exact-PID restart in order; head/later POSTs were 0/0. | [verdict](OC-REAL-037/verdict.json), [queue/restart details](OC-REAL-037/queue-restart.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-037/wire.ndjson), [crash boundary](../../../logs/opencode-real-world/phase-2/OC-REAL-037/crash-boundary.json) |
| OC-REAL-038 | **PASS** | Real permission answer applied with lost acknowledgement; stale/empty partial snapshots and restart retained one unknown intent/open card; one answer POST. | [verdict](OC-REAL-038/verdict.json), [ambiguity details](OC-REAL-038/permission-ambiguity.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-038/wire.ndjson), [upstream SSE](../../../logs/opencode-real-world/phase-2/OC-REAL-038/upstream-sse.ndjson) |
| OC-REAL-039 | **PASS** | Real question answer applied with the same durable conservative state; one answer POST. | [verdict](OC-REAL-039/verdict.json), [ambiguity details](OC-REAL-039/question-ambiguity.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-039/wire.ndjson), [upstream SSE](../../../logs/opencode-real-world/phase-2/OC-REAL-039/upstream-sse.ndjson) |
| OC-REAL-040 | **PASS** | Native fork is unsupported on the active legacy contract. One unkeyed compatibility create committed an orphan child; no canonical child or second create was published. | [verdict](OC-REAL-040/verdict.json), [fork details](OC-REAL-040/fork-ambiguity.json), [wire](../../../logs/opencode-real-world/phase-2/OC-REAL-040/wire.ndjson) |

## Failure and blocker classification

OC-REAL-037 failed before its target mutation boundary. Canonical session
`8d19f7f8-5197-44c4-b83d-07163447e496`, backend session
`ses_fb920b56dffeO9Y1napU4uAdy8`, FIFO head
`b6aa723a-a077-436e-9ad2-6b46e9f5020f`, and later item
`6a057b7e-8b10-44b4-9a44-c6e888d97a74` remained durable. No head operation,
request, or event ID exists because no queue mutation was admitted. The final run is
environment-attributed; earlier abort-timing and model-stall attempts are retained in
the adjacent `OC-REAL-037-attempt-*` evidence directories.

No scenario issued a duplicate prompt, answer, or fork mutation. Therefore no
BLOCKER 1, 2, or 9 request/session/event tuple exists.

## Isolation and raw evidence

Every scenario used its own scratch root, SQLite data directory, OpenCode config/data
directories, proxy port, and private OpenCode port; port 14500 was not used. Faults
were injected only after forwarding mutations to real OpenCode. Process boundaries
used recorded exact PIDs. Per-ID manifests record versions, ports, paths, PIDs, and
the run Git SHA. Database snapshots, OpenCode logs, WebSocket traces where applicable,
and full wire records live under `logs/opencode-real-world/phase-2/`.
