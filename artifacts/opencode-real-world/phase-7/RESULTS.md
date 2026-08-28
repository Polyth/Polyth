# Phase 7 — multi-client observation (OC-REAL-073–077)

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol,
model `opencode/big-pickle`) on Polyth HEAD of
`feat/opencode-real-world-validation-17e1`. Runners:
`scripts/opencode-real-world/phase7lib.ts` + `phase7_073.ts`–`phase7_077.ts`
(smoke: `phase7_smoke.ts`).

**Rerun note:** OC-REAL-073 and OC-REAL-075 were re-executed on HEAD
`1b327c54` (which includes `dbadbcd7 fix(opencode): terminalize repeated
legacy turns`) and now **PASS** — the previously deterministic second-turn
terminalization stall (finding 1 below) no longer reproduces in either
scenario. OC-REAL-074/076/077 verdicts are from the original pre-fix run
(all PASS then; not re-executed).

Every scenario boots the production composition (`boot` from `@polyth/server`)
on `127.0.0.1` port 0 (never 14500) with a fresh `POLYTH_DATA_DIR`, isolated
HOME/XDG dirs, and its own tiny git project. Clients are INDEPENDENT
observers: each is its own real TCP WebSocket (`ws` package) plus its own HTTP
fetch context with a per-client NDJSON wire log — there is no shared
in-process shortcut on any observation path. Upstream (O) evidence is read
straight from the owned `opencode serve` HTTP surface discovered by exact
PID/cwd via `/proc`; all process assertions used recorded exact PIDs.

Scenario count: **5 pass, 0 fail** (OC-REAL-073/075 after the terminalize-fix
rerun; OC-REAL-074/076/077 from the original run).

**BLOCKER 7 (duplicate model-visible output / duplicate unkeyed mutation /
cross-session leakage between clients): NOT HIT.** No double admission, no
double permission answer, no duplicate dispatch, no lost queued text, no
duplicate WS event, and no event ever crossed sessions or clients in any
scenario (`multiClientBlocker: false` in every verdict).

| ID | Engine | Verdict | Attribution | Result |
| --- | --- | --- | --- | --- |
| OC-REAL-073 | R+H | **PASS** (rerun on `1b327c54`) | NONE | Two different messages from idle in one scheduler tick (real two-client HTTP race AND deterministic same-tick double `sessions.send`): exactly one admission before the first turn completed, the loser fallback-queued exactly once and re-entered the stream, BOTH turns terminalized (`turn/started`=2, `turn/stopped`=2, session settled `idle`), both texts durable exactly once, both WS clients converged to one canonical seq order frame-for-frame (33 events each, no duplicate seqs), upstream saw each prompt exactly once, queue fully drained. All 19 checks pass in both R and H rounds; the pre-fix second-turn stall (finding 1) did not reproduce. |
| OC-REAL-074 | R+H | **PASS** | NONE | Two clients answered ONE pending bash permission with different choices (`once` vs `reject`) in one macrotask (real HTTP race AND deterministic same-tick double `replyPermission`): exactly one CAS winner per round, the loser got typed 409 `conflict` (never success), exactly one durable `permission/resolved` matching the winner, exactly one durable response intent, the gated side effect executed exactly once iff `once` won (real round: reject won, marker never created; harness round: once won, marker created once), both clients converged, upstream showed the gated bash tool once in the winner-consistent state. |
| OC-REAL-075 | R+H | **PASS** (rerun on `1b327c54`) | NONE | Editor edited/reordered/removed queued items while a watcher observed and a 25 s bash turn ran: watcher saw the full mutation trail (3 enqueued, 1 edited, 1 reordered, 1 removed), the composer edit hold placed on the queue head BEFORE turn completion blocked dispatch after `turn/stopped` (turn/started stayed 1, queue stayed 2 while held — the completed turn could not rip a row open in a composer), cancel resumed FIFO with the new head, ALL queued dispatches terminalized (three `turn/stopped`, session settled `idle`), dispatch order matched the final queue order with the edited text, the removed item and the stale pre-edit text never dispatched or reached upstream (upstream counts: q3=1, q2-edited=1, q2-stale=0, q1-removed=0), editing an already-dispatched row was refused typed 404, the queue fully drained, and both clients converged (55 events each == REST). All 16 checks pass; the pre-fix resumed-head stall (finding 1) did not reproduce. |
| OC-REAL-076 | H | **PASS** | NONE | Client A burst-subscribed s1→s2→s3→s2→s3 in one tick while >500-event gap-fills (multi-frame, 627 events each) were in flight and live events flowed on s1; client B stayed on s1. The newest subscribe won: A's trailing segment was exactly the complete, seq-deduped s3 history; A received zero s1 events after convergence (including a later full probe turn on s1 — the old subscription never revived); B missed nothing and duplicated nothing (fingerprint identical to REST) and received zero cross-session events. Cross-ref: the s1 probe turn (second turn of that session) again never terminalized — recorded in `details.probeStalled`, not a 076 criterion. |
| OC-REAL-077 | R | **PASS** | NONE | Every UI disconnected mid-running-tool (15 s bash) and, in a second session, while a permission request was pending; during each no-UI window the harness touched ONLY the upstream serve process. The backend PID survived both windows and completed the tool run with zero UIs (side-effect file written exactly once, ~18-20 s UI-less); a brand-new UI rehydrated the complete durable order with `turn/stopped` present, one `user/message`, projection `idle` (no stale sending); the pending permission survived the 12 s no-UI window open (`status=waiting`, listed in pending), was never auto-resolved or aborted, and the new UI's answer completed the gated work exactly once. Upstream saw each prompt exactly once. |

## Finding 1 (POLYTH, release-significant): a session's SECOND turn never terminalizes on real legacy 1.18.18 — RESOLVED for OC-REAL-073/075 by `dbadbcd7`

**Status: no longer reproduces.** After `dbadbcd7 fix(opencode): terminalize
repeated legacy turns`, the OC-REAL-073 and OC-REAL-075 reruns on HEAD
`1b327c54` terminalized every second and subsequent turn (0/6 stall rounds:
073 real+harness turn 2, 075 resumed head plus the two turns behind it).
OC-REAL-076's `details.probeStalled` cross-reference is from the pre-fix run
and was not re-executed. The original pre-fix observation follows for the
record.

Deterministic, 6/6 occurrences across three scenarios and both engines
(pre-fix HEAD):

- OC-REAL-073 real + harness rounds, both full runs: turn 2 (queue-dispatched)
  reaches `usage/recorded` then stalls; no `turn/stopped`, projection `working`
  forever.
- OC-REAL-075 both runs: the resumed queue head (turn 2) stalls the same way,
  wedging FIFO dispatch of everything behind it.
- OC-REAL-076: a plain second direct send from idle (no queue involvement)
  stalls the same way (`details.probeStalled`).

First turns always terminalize (later sessions on the same serve process
included — OC-REAL-074/077 sessions each ran one turn and completed). The
dispatch path is irrelevant (direct HTTP send, queue dispatch, in-process
service send all reproduce), so this is per-session state, not scheduling.
Mechanism (code-level, consistent with the traces): `turn/stopped` is only
emitted when a terminal `session.idle` observation is accepted
(`packages/backend-opencode/src/index.ts` `handlePayload` →
`terminalStateEvidenceOf`); real legacy `session.idle` carries no
revision/seq, so once the first idle advances the session's observation
checkpoint for that terminal entity, the next revision-less idle no longer
advances anything and its attached terminal evidence is discarded with the
rejected/deduplicated observation. This is the same F1 family documented in
Phase 1 (`FAILURE-REPORT-LEGACY-TERMINALIZATION.md`), narrowed by the pre-fix
HEAD's fixes: first-turn terminalization worked, cross-turn did not. It also
explains the Phase-2 OC-REAL-037 accepted-head no-op and matches the Phase-6
OC-REAL-072 post-fork parent stall shape.

Consequences observed pre-fix: queued follow-ups behind a second turn never
dispatched (OC-REAL-075), and any session that had completed one turn wedged
at `working` on its next turn (OC-REAL-073/076) — while all durable content,
usage, ordering, and multi-client convergence stayed correct. `dbadbcd7`
removed both consequences in the OC-REAL-073/075 reruns.

## Evidence map

- Per-ID verdicts: `artifacts/opencode-real-world/phase-7/OC-REAL-0{73..77}/verdict.json`
  (+ `manifest.json`, `details.json` per scenario).
- Per-client WS traces, per-client HTTP wire logs, upstream wire logs, and
  full database snapshots: `logs/opencode-real-world/phase-7/OC-REAL-0NN/`
  (`ws-*.ndjson`, `client-*.ndjson` / `editor.ndjson` / `watcher-http.ndjson`,
  `upstream*.ndjson`, `db-final.json`).
- Harness: `scripts/opencode-real-world/phase7lib.ts`, scenario runners
  `phase7_073.ts`–`phase7_077.ts`, preflight `phase7_smoke.ts`.
