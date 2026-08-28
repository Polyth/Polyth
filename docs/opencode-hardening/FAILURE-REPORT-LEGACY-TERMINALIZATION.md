# Failure report — real legacy turns can never terminalize (and adjacent live findings)

Campaign: Phase 1 legacy real-world validation, OpenCode CLI `1.18.18`,
protocol forced `legacy`, real Google Gemini / HuggingFace providers.
Scenario contract: `docs/opencode-hardening/REAL-WORLD-VALIDATION.md`.

## F1 — POLYTH (release severity): no real legacy turn can ever terminalize

**Scenario IDs:** OC-REAL-020 (fail), OC-REAL-023 (contract gap); corroborated in
OC-REAL-009, OC-REAL-017, OC-REAL-019, OC-REAL-021, OC-REAL-022 evidence.

**Observed on the wire:** real `1.18.18` legacy payloads carry no ordering
field anywhere:

- `session.idle` → `{"sessionID":"ses_…"}` (nothing else),
- `session.error` → `{"sessionID":…,"error":{name,data}}`,
- `session.status` → `{"sessionID":…,"status":{"type":"busy"|"idle"|"retry"…}}`,
- `GET /session/status` → map containing **only busy sessions** (`{}` once a
  session is idle/failed/aborted), no revision keys.

**Polyth behavior:** `terminalStateEvidenceOf()` in
`packages/backend-opencode/src/events.ts` and `statusFor()` in
`packages/backend-opencode/src/protocolLegacy.ts` accept a terminal state only
with a comparable revision (`revision|version|seq|sequence|updatedAt`). Since
the real server never sends one:

- the facade **never emits `turn/stopped`** (completed, aborted or error) on
  the live event path;
- reconcile snapshots report `state: unknown` forever after the first prompt
  (only a freshly created session gets causal `idle` from its create receipt).

**Product effect:** `packages/server/src/sessions.ts` drives projection status,
queue dispatch (`turn/stopped(aborted)` dispatches interrupts), idle-assist and
completion off `turn/stopped` / authoritative `idle`. Against real OpenCode a
session enters `working` on the first prompt and can never be proven idle
again — missed completion / permanently active turn.

**Harness assumption that hid this:** `packages/backend-opencode/test/fakeOpenCode.ts`
`finishTurn()` emits `session.idle` with an invented `properties.revision`;
every deterministic suite passes because of a field the real server does not
have. (Exactly the class of error the validation plan's fault-attribution rule 5
warns about.)

**Minimal reproduction:** `node scripts/opencode-real-world/s020.ts`
(spawns real `opencode serve`, one prompt, waits for wire `session.idle`,
asserts `turn/stopped` and reconcile idle — both missing).

**Evidence:**

- `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-020/completion.json`
  (`rawSessionIdlePayload`, `rawStatusEndpointAfterCompletion`)
- `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-023/status-matrix.json`
  (six-phase raw→normalized matrix)
- `logs/opencode-real-world/phase-1-legacy/OC-REAL-020/sse.ndjson`

**Failing regression test (added deliberately red):**
`packages/backend-opencode/test/realLegacyTerminalization.test.ts`.

**Escalation, not a patch:** the fix is an architecture decision — either a
pinned "absence from the busy map + bounded quiescence" admission contract for
legacy idle, treating `session.idle` as terminal for the session's currently
tracked turn (transport-order evidence), or an upstream OpenCode contract
change. Per campaign rules no speculative adapter patch was applied.

## F2 — OPENCODE: `read` tool on a nonexistent path hangs forever

**Scenario ID:** OC-REAL-021. The `read` tool on `/nonexistent/…` goes
`pending → running` and never terminalizes (no error part, no `session.idle`;
reproduced twice, 90 s and 120 s+). Session stays busy — upstream
"stuck active turn". Repro: `node scripts/opencode-real-world/probe_readhang.ts`.
Evidence: `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-021/failure-modes.json`.

## F3 — OPENCODE: bash tool killed mid-run reports terminal `completed`

**Scenario IDs:** OC-REAL-022 (also visible in OC-REAL-017). A bash tool
aborted while running returns
`state.status: "completed"` with `metadata.exit: null` and output
`"<shell_metadata>User aborted the command</shell_metadata>"`, although its
side effect never happened. A client trusting the terminal rank shows a
completed tool for an interrupted command. Evidence:
`artifacts/opencode-real-world/phase-1-legacy/OC-REAL-022/interruption.json`
(`killedBashCase`).

## F4 — OPENCODE (minor): provider errors leak internal stack traces

**Scenario ID:** OC-REAL-021. `ProviderModelNotFoundError` arrives in
`session.error` with a full internal bun bundle stack trace
(`/$bunfs/root/chunk-*.js` frames) — unbounded, unredacted error payloads reach
clients. Evidence: `failure-modes.json` (`modelError.rawSessionError`).

## F5 — environment note: strict config validation bricks startup

OC-REAL-025 setup: `opencode serve` `1.18.18` refuses to start when
`opencode.json` contains a schema-invalid `mcp` entry type. Polyth's
preserve-unknown-fields contract is safe for unknown *fields*, but any writer
must never emit an unknown MCP `type` — the whole backend dies at boot.
