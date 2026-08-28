# Real-world OpenCode validation results

## Phase 1 legacy — capability matrix (OC-REAL-001–025)

Validated 2026-08-28 against real OpenCode CLI `1.18.18`, protocol forced to
legacy, isolated `POLYTH_DATA_DIR`/ports per scenario. Lifecycle/session rows
OC-REAL-001–012 were evidenced earlier (**10 pass, 1 partial, 1 fail** — the
fail is OC-REAL-001 occupied-port collision handling, POLYTH). Capability rows
OC-REAL-013–025 below: **6 pass, 3 partial, 4 fail**.

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-013 | **PARTIAL** | Live bash `permission.asked` produced exactly one `permission/requested`; the identified request appears in SSE, `GET /permission`, and the reconcile snapshot. Durable append-before-display and detached-UI notification are server-stack scope. |
| OC-REAL-014 | **PASS** | `once` re-asked on the second run, `always` persisted silently, `reject` left the bash tool in `error` with the side effect never executed, and the double-answer race got exactly one confirmed winner upstream. |
| OC-REAL-015 | **PASS** | All six live question shapes (single/multi-choice, free-text, multi-question, reject, race) surfaced exactly once each with byte-identical payloads across SSE, `GET /question`, and reconcile. Per-run gaps were provider daily-quota exhaustion, covered by union across runs. |
| OC-REAL-016 | **PASS** | Answers were reflected verbatim in real question tool output, reject produced a non-completed tool state, and the reply-vs-reject race had exactly one confirmed winner with the loser rejected upstream. |
| OC-REAL-017 | **FAIL (OPENCODE)** | All five abort phases issued exactly one abort POST with no duplicates and explicit leftover permission/question artifacts. But a bash tool aborted while running reports upstream state `completed` (payload pinned in OC-REAL-022), and `turn/stopped(aborted)` is never emitted (shared root cause with OC-REAL-020). |
| OC-REAL-018 | **PASS** | Empty fork produced a fresh session, mid-history fork with repeated equal text used the positional message boundary correctly, full fork was exact, and a bogus prefix failed verification with `history-mismatch` without changing the source mapping. |
| OC-REAL-019 | **PASS** | SSE drops of 500 ms / 5 s / 30 s each reconnected, issued exactly one prompt POST (no replay), and recovered the missed marker once via pull. |
| OC-REAL-020 | **FAIL (POLYTH)** | Central finding: real legacy `session.idle`/`session.error`/`session.status` carry no revision/version/seq, so `terminalStateEvidenceOf()` never returns evidence — `turn/stopped` is never emitted and reconcile stays `unknown` before and after restart. Deterministic suites pass only because `fakeOpenCode` invents `properties.revision`. See `docs/opencode-hardening/FAILURE-REPORT-LEGACY-TERMINALIZATION.md` (F1) and the failing regression test `packages/backend-opencode/test/realLegacyTerminalization.test.ts`. |
| OC-REAL-021 | **FAIL (OPENCODE)** | Bad model and bad API key produced durable `session.error` without leaking the injected key; unknown-session prompt returned 404. But the `read` tool on a nonexistent path hangs forever (stuck active turn, reproduced twice) and `ProviderModelNotFoundError` leaks an internal bun stack trace. Polyth also never terminalizes these failures locally (F1). |
| OC-REAL-022 | **FAIL (OPENCODE)** | Abort left a durable `MessageAbortedError` with one POST and SIGKILL reconciled to a snapshot without invented terminals — but real 1.18.18 never emits any comparable revision, so interruption can never terminalize (F1 family), and the bash tool killed mid-run reports `completed`. |
| OC-REAL-023 | **PARTIAL (OPENCODE)** | Busy sessions normalize to `running` and fresh sessions get causal idle from the create receipt, but real `/session/status` only lists busy sessions and carries no revision: idle/failed/interrupted can never be normalized from live status, so after its first turn a real legacy session can never be proven idle again. |
| OC-REAL-024 | **PASS** | Global `AGENTS.md` edits through the config applier applied at the next-turn boundary (ALPHA→BETA→GAMMA behavior switch), a mid-turn write left the active turn intact, and the OpenCode PID stayed stable throughout. |
| OC-REAL-025 | **PARTIAL (POLYTH)** | Unsupported MCP entries, unknown top-level fields, and unowned provider/agent fields survived all managed writes; no-op wrote zero bytes; refusals were typed; a corrupt file was never clobbered; one safe-idle owned restart applied `disabled_providers`. Documented limitation confirmed live: the first genuine write re-serializes strict JSON, losing user JSONC comments. |

Cross-cutting findings from this matrix, in severity order:

1. **F1 (POLYTH, release-significant):** real legacy OpenCode 1.18.18 emits no
   comparable revision on any terminal-evidence event, so no real legacy turn
   ever terminalizes — completion, failure, and interruption all settle
   `unknown`, queue dispatch never advances, and projections never go idle.
2. **F2 (OPENCODE):** the `read` tool on a nonexistent path never terminalizes
   (stuck active turn 120 s+).
3. **F3 (OPENCODE):** a bash tool killed mid-run reports upstream state
   `completed` with the side effect never executed.
4. **F4 (OPENCODE):** `ProviderModelNotFoundError` responses include an
   internal bun stack trace.
5. **F5 (env observation):** `opencode serve` refuses to start on `opencode.json`
   entries outside its strict schema (e.g. unknown MCP transport types).

Free-tier provider quotas (20 requests/day/model on Google) forced model
rotation across `gemini-2.5-flash(-lite)`, `gemini-3.5-flash`,
`gemini-3-flash-preview`, `gemini-3.1-flash-lite`, and HuggingFace
`gpt-oss-120b`; per-run no-op cases attributable to quota `APIError` were
retried on fresh buckets, never counted as Polyth failures.

Full evidence: `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-0NN/verdict.json`
and `logs/opencode-real-world/phase-1-legacy/`.

## Phase 1 V2 / shared service — current revalidation

Revalidated 2026-08-28 against real OpenCode CLI `1.18.18` from Polyth SHA
`bf80e1b5ba2376030cd6f6eef126591953e54018`. Counts for OC-REAL-026–033:
**1 pass, 3 fail, 4 blocked**.

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-026 | **FAIL** | Blocker 0 supersedes the old V2-stub result: stable auto V2 exposes 68 models, 4 agents, and working create/prompt admission. Fresh-service catalog readiness still returned transient `[]`, and normal product auto/V2 sessions persisted as legacy, stayed unknown, and rejected prompt. |
| OC-REAL-027 | **PASS (negative)** | Installed CLI/SDK still has no authoritative service descriptor or `serve --service`; `--mdns`, `attach`, and `createOpencodeServer` do not provide headers, authority, instance, or continuity. |
| OC-REAL-028 | **BLOCKED** | Closest-supported injected descriptors proved real REST/SSE Basic auth and 401 for stale credentials; official discovery-driven credential rotation is absent. |
| OC-REAL-029 | **BLOCKED** | Injected URL/auth replacement advanced generation 1→2, and generation-only continuity fenced the stale binding with `binding-mismatch`. Official continuity and delayed active callbacks remain untestable. |
| OC-REAL-030 | **FAIL** | Normal boot still has no borrowed mode. It spawns an owned child, while startup on the live shared port returns generic 503 `ServeError` rather than attaching. |
| OC-REAL-031 | **BLOCKED** | Library-level borrowed dispose left the shared PID healthy and an independent SSE client connected; normal product cannot enter that state. |
| OC-REAL-032 | **BLOCKED** | Borrowed reconnect now lists surviving sessions, superseding the old empty-session finding. History/reconcile fail because Polyth requests `limit=1000` from the V2 message endpoint capped at 200; official continuity and product attach remain absent. |
| OC-REAL-033 | **FAIL** | Native create/reset/prompt/steer/interrupt/SSE routes work and fork/delete are explicit unsupported. History/hydration/reconcile fail on the limit mismatch; capability flags overclaim unavailable work, and fresh catalog calls can be falsely empty. |

The current run found four release-significant product gaps beyond the superseded stub:

1. `protocolV2.ts` uses `limit=1000` for messages; real `1.18.18` enforces
   `limit <= 200`, breaking history, hydration, and reconciliation.
2. The normal server runtime-pool facade does not forward `protocol()`, so product V2
   bindings are persisted as `legacy` and settle `unknown`.
3. Normal boot still cannot select the working borrowed endpoint seam.
4. Fresh V2 model discovery can return successful transient empty data before stabilizing at
   68 models; Polyth currently accepts it as authoritative.

Additional current observations:

- in-root attachment admission worked, but traversal was silently omitted rather than
  rejected;
- V2 `wait` and `compact` returned explicit 503 `ServiceUnavailableError`;
- V2 has no config operation, and raw `/api/config` falls through to HTTP 200 SPA HTML;
- five real Google prompt admissions over 243 seconds produced no text/reasoning/tool,
  permission/question, completion, or interruption events, so those paths remain unproved;
- borrowed dispose and every normal owned shutdown left the independently started shared
  service alive; owned children stopped and SQLite integrity was `ok`.

Full current evidence:
`artifacts/opencode-real-world/phase-1-v2/RESULTS.md`,
`artifacts/opencode-real-world/phase-1-v2/results.json`, and
`logs/opencode-real-world/phase-1-v2/current-*.{json,log,txt}`.

## Phase 1 V2 / shared service — superseded pre-Blocker-0 result

> Superseded by the current revalidation above. In particular, the old OC-REAL-026 claim
> that V2 model/create methods were permanent stubs is no longer current. Do not cite the
> old empty-catalog result as evidence for this HEAD.

Validated 2026-08-28 against real OpenCode CLI `1.18.18` from Polyth start SHA
`95a0422a`. Full evidence is under
`artifacts/opencode-real-world/phase-1-v2/` and
`logs/opencode-real-world/phase-1-v2/`.

Scenario count for OC-REAL-026–033: **1 pass, 3 fail, 4 blocked**.

- **OC-REAL-026 FAIL / release blocker:** ordinary `opencode serve` publishes dual
  legacy and V2 paths. Polyth `protocol:auto` selects V2, reports no models, and rejects
  first session create as `capability-unsupported`. The product persists the operation as
  rejected and projects the created shell as failed. Forced V2 behaves identically.
  Agent B's separate forced-legacy matrix confirmed session create, which proves the same
  real server has an operational adapter that auto bypasses.
- **OC-REAL-027 PASS (negative capability):** neither the installed CLI nor SDK exposes an
  authoritative discovered-service descriptor. `--mdns`, `attach <url>`, and
  `createOpencodeServer({url,close})` do not provide headers, authority, instance identity,
  continuity, or borrowed ownership.
- **OC-REAL-028/029 BLOCKED:** Basic auth works on real REST and SSE, and Polyth's injected
  borrowed descriptor seam rotates real URLs/auth as one endpoint generation. There is no
  official discovery/continuity contract and no operational Polyth V2 SSE/session adapter,
  so these are closest-supported probes rather than acceptance.
- **OC-REAL-030 FAIL:** the borrowed library seam can attach, but normal Polyth composition
  cannot select it. Normal startup creates a second owned OpenCode process; explicitly
  requesting the occupied shared port fails instead of attaching.
- **OC-REAL-031/032 BLOCKED:** disposing the library-level borrowed lifecycle did not signal
  or stop the real shared process. Reattach found its surviving session directly, while
  Polyth still returned an empty catalog, disabled history, and
  `unknown`/`unverifiable` reconciliation. Product boot cannot enter this borrowed state.
- **OC-REAL-033 FAIL:** disabled V2 mutations and history return stable unsupported outcomes
  with zero fallback traffic, but model/agent/session methods return authoritative-looking
  empty arrays and the facade advertises unsupported capabilities as true.

Real V2 does exist under `/api/*` on the normal server. It provides health/location,
catalogs, paginated sessions/messages, durable history, global and session SSE, client IDs,
prompt admission, attachments, permission/question paths and interrupt. In this isolated
headless run prompts were durably admitted but no agent loop executed them; `wait` and
`compact` returned structured `503 ServiceUnavailableError`.

Wire discrepancies found:

1. session event `after` is declared `string`, but the server requires an integer aggregate
   sequence; `after=2` replays sequence 3 onward;
2. SSE events contain JSON `id` but no wire-level `id:` field;
3. unregistered V2 delete/fork paths fall through to HTTP 200 SPA HTML;
4. file prompts gain a server-derived MIME field;
5. occupied-port startup emits generic `ServeError`, not text Polyth recognizes as
   `EADDRINUSE`.

Process ownership evidence found no unowned termination. Borrowed dispose left the real
shared PID healthy; normal owned dispose stopped only its separate child. This does not
remove the shared-service release gap because product composition still lacks borrowed
runtime wiring.

See `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`,
`artifacts/opencode-real-world/phase-1-v2/OPENCODE-API-SURFACE.md`, and
`artifacts/opencode-real-world/phase-1-v2/results.json`.

## Phase 2 — mutation ambiguity

Validated 2026-08-28 against real OpenCode CLI `1.18.18` through a
transport-only fault shim. Counts for OC-REAL-034–040: **6 pass, 1 fail**.

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-034 | **PASS** | Twelve post-commit response losses across 0, 1, 2, 5, 10, and 25 ms timings each produced one POST, one canonical/upstream user message, one upstream agent turn, and one durable unknown operation; a second send was blocked. |
| OC-REAL-035 | **PASS** | A real 200 response was cut after 31 of 1615 body bytes and reset. Polyth retained one unknown operation and issued one POST. |
| OC-REAL-036 | **PASS** | The real server accepted the prompt and the shim held its response for 12 seconds. Polyth returned unknown at 10004 ms, ignored the late release for settlement, and issued one POST. |
| OC-REAL-037 | **FAIL (ENV)** | The accepted initial prompt produced no observable terminal event in the final run, so the queued head was never reserved and the intended accepted-head ambiguity was not reached. Both FIFO rows survived exact-PID Polyth restart in order; head/later POST counts were 0/0. Earlier and corrected attempts are retained. |
| OC-REAL-038 | **PASS** | One real permission rejection applied upstream with its acknowledgement lost. Stale and empty partial pending snapshots plus full restart retained one unknown intent/open card; one answer POST was issued. |
| OC-REAL-039 | **PASS** | One real question answer applied upstream with the same conservative unknown/card behavior through stale and empty partial snapshots plus restart; one answer POST was issued. |
| OC-REAL-040 | **PASS** | Real `1.18.18` exposed no native fork contract, so legacy used one unkeyed compatibility session create. Its committed orphan child was not published or similarity-adopted, the operation remained unknown, and restart blocked a second create. |

No duplicate mutation was observed. BLOCKER 1/2/9 was not triggered. The Phase 2
runner used isolated ports and data directories, and all forced process stops targeted
recorded exact PIDs. Full evidence is under
`artifacts/opencode-real-world/phase-2/` and `logs/opencode-real-world/phase-2/`;
the concise index is `artifacts/opencode-real-world/phase-2/RESULTS.md`.

## Phase 5 — shared/discovered V2 service ownership

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (V2 protocol forced) from
Polyth SHA `1d833613`. Shared services ran as external harness processes; Polyth
attached only through the borrowed endpoint seam
(`createBorrowedServiceEndpointLease` + facade/lifecycle). Counts for
OC-REAL-062–067: **0 pass, 4 fail (3 POLYTH, 1 OPENCODE), 2 blocked.**

**BLOCKER 5 was NOT hit:** no scenario stopped, signalled, or reconfigured the
shared service; the shared PID survived every borrowed shutdown with health 200
and its external SSE client still connected.

**Cross-cutting limitation on every row:** normal Polyth composition still cannot
select a borrowed/shared endpoint — product boot on the occupied port spawns an
owned child that exits and returns 503 `ServeError` instead of joining — and
OpenCode 1.18.18 exposes no authoritative discovery descriptor. Borrowed-seam
evidence below is not product acceptance; product shared-attach is an
architectural gap (documented, deliberately not implemented in this pass).

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-062 | **FAIL (POLYTH)** | The borrowed seam joined the pre-existing real V2 service with an active session and external SSE client — no spawn/stop/config authority; the active session was listed and hydrated. Normal product boot on the occupied port still attempted an owned child and returned 503 instead of joining. |
| OC-REAL-063 | **BLOCKED** | Borrowed facade/lifecycle shutdown detached while the shared PID kept the same `/proc` identity, health stayed 200, and the external SSE client remained connected. Product acceptance is blocked because normal boot cannot borrow, so the product can never enter this state. |
| OC-REAL-064 | **FAIL (POLYTH)** | After service replacement a live borrowed lease advanced generation 1→2 and rejected its stale binding with typed `binding-mismatch`. But a fresh Polyth-side lease over the replacement reset generation to 1 and accepted the same generation-only stale binding without explicit continuity proof. |
| OC-REAL-065 | **BLOCKED** | Injected descriptor refresh covered auth-only, URL-only, and combined URL+auth rotation: every fingerprint change advanced generation, valid credentials returned 200, stale credentials returned typed 401, and no secret value was recorded. Official in-flight discovery-driven rotation does not exist in 1.18.18. |
| OC-REAL-066 | **FAIL (OPENCODE)** | Ordinary root/worktree catalogs on one shared service stayed directory-isolated, but a client-supplied session ID collision in project B returned project A's session with HTTP 200 — location keys do not fence client-chosen IDs. Real workspace discovery returned no identities. |
| OC-REAL-067 | **FAIL (POLYTH)** | Two official V2 SDK clients and the Polyth borrowed facade durably admitted distinct queue markers into one shared session, and the external abort was accepted. But Polyth history/reconcile exposed only the promoted first message and hid later external/Polyth admissions that official durable history retained. No permission request materialized, so the permission-conflict leg is unproven. |

Also observed: V2 durable-history paging in this run rejected `limit=200`
(`Expected a value less than or equal to 100`), stricter than the `limit <= 200`
cap found in the Phase 1 V2 run.

All ports were dynamically bound (never 14500); all forced process signals used
recorded exact PIDs after `/proc` identity validation. Full evidence is under
`artifacts/opencode-real-world/phase-5/` and `logs/opencode-real-world/phase-5/`;
the concise index is `artifacts/opencode-real-world/phase-5/RESULTS.md`.

## Phase 6 — directory and worktree isolation

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol), model
`opencode/big-pickle`, fixture `/tmp/polyth-tests` (project-a/project-b, each with a
`worktree-feature` git worktree and unique `IDENTITY.txt` markers). Counts for
OC-REAL-068–072: **2 pass, 2 partial, 1 fail.**

**BLOCKER 6 was NOT hit:** no session escaped its authoritative directory/worktree,
and no deleted worktree fell back to the repo root, the last cwd, or another tree.

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-068 | **PASS** | Four concurrent sessions (2 roots + 2 worktrees, identical prompt) each answered with exactly its own IDENTITY marker; upstream cwd, tool paths, directory catalogs, and durable logs never crossed locations. |
| OC-REAL-069 | **PARTIAL (POLYTH)** | Harness-forced EQUAL backend session/message/request/event ids across root and worktree endpoints never crossed (SSE, permission replies, prompts all endpoint-bound). Deleting the colliding root session wiped the worktree session's canonical->backend binding from the shared `sessionIdMap` (`removeMapping` matches by backend id across endpoints); the damage self-healed with no observable loss. Failing regression test: `packages/backend-opencode/test/regressionSharedSessionIdMap.test.ts`. |
| OC-REAL-070 | **PASS** | Same-branch worktree race yielded one valid worktree and a bounded loser; create-vs-remove jitter races bound the verified path or rejected typed with a `failed` projection; deterministic TOCTOU removal before spawn rejected the create with no orphan serve and no root fallback. |
| OC-REAL-071 | **PARTIAL (POLYTH)** | Worktree deleted during idle/text/tool/permission phases: durable history survived, file/git routes 404ed typed (`session worktree is missing`), new model work failed truthfully (`NotFound: FileSystem.access(<worktree>)`) with cwd pinned to the deleted worktree, and the pending permission survived. Honesty gap: a NEW session created on the rm-rf'd (unpruned) worktree settles `idle` with `worktreeState: "ready"` (stale git listing + pool runtime reuse). |
| OC-REAL-072 | **FAIL (POLYTH)** | All isolation criteria held (same-relative-name attachments resolved to source-tree bytes/URLs only across root/worktree/fork-child; the fork child stayed in the source worktree; the generation-1 durable attachment record was immutable across rotation + root-file mutation; the respawned serve kept the worktree cwd). Reliability failures, no leak: (1) deterministic post-fork stall — the parent's next turn completes upstream but never gets `turn/stopped` and the forked child's backend becomes an "unmapped session" SSE target; (2) after endpoint rotation (real SIGKILL+respawn and harness generation swap alike) the session sticks at `unknown` and every send is refused with `conflict` — truthful but no recovery; (3) attachment-bearing histories can never be forked: OpenCode 1.18.18 stores file parts as synthetic user text, so exact-history fork always rejects `history-mismatch` (bounded, no approximate child). |

All Polyth boots used port 0 (never 14500); all forced process stops used recorded
exact PIDs. Full evidence is under `artifacts/opencode-real-world/phase-6/` and
`logs/opencode-real-world/phase-6/`; the concise index is
`artifacts/opencode-real-world/phase-6/RESULTS.md`.

## Phase 7 — multi-client observation

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol,
model `opencode/big-pickle`) through the production composition (`boot`), one
isolated data dir + owned serve child per scenario. Every scenario used at
least two INDEPENDENT clients: separate real TCP WebSockets plus separate HTTP
fetch contexts, each with its own NDJSON wire log; upstream evidence was read
directly from the owned `opencode serve` HTTP surface located by exact
PID/cwd. Counts for OC-REAL-073–077: **5 pass, 0 fail** — OC-REAL-073 and
OC-REAL-075 were re-executed on HEAD `1b327c54` (includes `dbadbcd7
fix(opencode): terminalize repeated legacy turns`) and now PASS;
OC-REAL-074/076/077 PASS from the original run.

**BLOCKER 7 was NOT hit:** no double admission, double permission answer,
duplicate dispatch, lost queued text, duplicate WS event, or cross-session /
cross-client leak occurred in any scenario.

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-073 | **PASS** (rerun on `1b327c54`) | Same-tick double send from idle (real two-client HTTP race and deterministic in-process tick): exactly one admission, loser fallback-queued once and re-entered the stream, both turns terminalized (2× `turn/stopped`, session settled `idle`), both texts durable exactly once, both WS clients converged frame-for-frame to one canonical order, upstream saw each prompt exactly once, queue fully drained. All 19 checks pass in both rounds; the pre-fix second-turn stall did not reproduce. |
| OC-REAL-074 | **PASS** | Two clients answered one pending bash permission with different choices in one macrotask (real race + deterministic same-tick service calls): exactly one CAS winner, loser got typed 409 `conflict` (never success), one durable resolution matching the winner, one durable response intent, gated side effect executed exactly once iff `once` won, both clients converged, upstream showed the gated tool once in the winner-consistent state. |
| OC-REAL-075 | **PASS** (rerun on `1b327c54`) | Queue edit/reorder/remove during a 25 s active turn with a second watching client: the full durable mutation trail was visible to both clients, the composer edit hold on the queue head blocked dispatch after turn completion (reservation semantics held), cancel resumed FIFO with the new head and edited text, all queued dispatches terminalized (three `turn/stopped`, session settled `idle`) in the final queue order, removed/stale texts never dispatched or reached upstream, an already-dispatched row refused edits typed 404, and the queue fully drained. All 16 checks pass; the pre-fix resumed-head stall did not reproduce. |
| OC-REAL-076 | **PASS** | Same-tick subscribe burst across three sessions while >500-event multi-frame gap-fills were in flight and live events flowed: the newest subscribe won; the switching client's trailing segment was exactly the complete seq-deduped history of the final session with zero cross-session events and zero revival of the old subscription (a later probe turn on the abandoned session never leaked); the staying client missed nothing and duplicated nothing. |
| OC-REAL-077 | **PASS** | Every UI disconnected mid-running-tool and (second session) mid-pending-permission; the no-UI windows were observed upstream-only. The backend PID survived and completed the tool with zero UIs (side effect exactly once); a brand-new UI rehydrated the full durable order with completion present, one user message, and `idle` (no stale sending); the pending permission survived open, was never auto-resolved or aborted, and the new UI's answer completed the gated work exactly once. |

**Finding (POLYTH, was release-significant): a session's SECOND turn never
terminalized on real legacy 1.18.18 — RESOLVED for OC-REAL-073/075 by
`dbadbcd7 fix(opencode): terminalize repeated legacy turns`.** Pre-fix this
was deterministic 6/6 across OC-REAL-073 (queue dispatch, R and H),
OC-REAL-075 (queue dispatch), and OC-REAL-076 (plain direct second send):
real legacy `session.idle` carries no revision, so after the first idle
advanced the session's observation checkpoint the next revision-less idle no
longer advanced anything and its terminal evidence was discarded (Phase-1 F1
family; also explains the Phase-2 OC-REAL-037 no-op and the Phase-6
OC-REAL-072 post-fork stall shape). The OC-REAL-073/075 reruns on
`1b327c54` terminalized every second and subsequent turn and drained the
queue (0/6 stall rounds). OC-REAL-076's `probeStalled` cross-reference is
from the pre-fix run and was not re-executed.

All Polyth boots used port 0 (never 14500); all process assertions used
recorded exact PIDs. Full evidence is under
`artifacts/opencode-real-world/phase-7/` and `logs/opencode-real-world/phase-7/`;
the concise index is `artifacts/opencode-real-world/phase-7/RESULTS.md`.

## Phase 4 — owned-runtime crash recovery

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol forced)
through the real composition root, with deterministic kill points (delay shim +
fault proxy spawned by Polyth as its owned child; every stop signalled one
recorded exact PID after `/proc` identity verification). Counts for
OC-REAL-048–061 after the targeted current-code rerun: **14 pass.**

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-048 | **PASS** | Pre-listen kill: bounded startup failure, exact child cleaned, no stale PID record, no ready generation; later request built one fresh identity-verified generation. |
| OC-REAL-049 | **PASS** | Probe-window kill: failed generation never exposed (503 inside the startup deadline), no stream attached to it, fresh generation recovered with a fresh child (no dead-URL reuse). |
| OC-REAL-050 | **PASS** | Create committed upstream, response swallowed, child killed: canonical shell survived unbound with a durable unknown operation; one upstream POST, no second create, no similarity adoption. |
| OC-REAL-051 | **PASS** | Prompt accepted upstream, response swallowed, child killed: one durable unknown turn-submit, user intent exactly once, resend blocked, exactly one prompt POST across recovery. |
| OC-REAL-052 | **PASS** | Mid-text SIGKILL: durable prefix survived once at its original seqs, no part finalized twice, no invented suffix/completion, honest `unknown` steady state. |
| OC-REAL-053 | **PASS** | Mid-reasoning SIGKILL: reasoning stayed reasoning (never rendered as answer), no invented completion, no false idle. |
| OC-REAL-054 | **PASS** | Pending-tool (permission-gated) SIGKILL: no fabricated result, gated side effect never happened, pending state stayed explicit. |
| OC-REAL-055 | **PASS** | Side-effect-then-kill: exactly one side effect before and after recovery, prompt never repeated, no claimed unobserved result. |
| OC-REAL-056 | **PASS** | Permission-pending SIGKILL: card durable, post-kill answer settled bounded (38.5 s) as explicit `outcome-unknown`, never misrouted (gated tool never ran). |
| OC-REAL-057 | **PASS** | Question-pending SIGKILL: question durable and unduplicated, post-kill answer bounded (`outcome-unknown`), no misroute. |
| OC-REAL-058 | **PASS** | Abort accepted upstream then swallowed+kill: abort stayed durably unknown with the projection flipped honestly, no abort retry, queue blocked from ambiguous dispatch, no false interrupted. |
| OC-REAL-059 | **PASS** | Terminal committed upstream, terminal SSE withheld, child killed: output and one ordered terminal exactly once, no replay; settles honest `unknown` (generation-only continuity). **Bug found & fixed:** after an exit-notification race the owned lease handed out the dead endpoint forever (wedged runtime, no respawn); `endpoint()` now respawns known-dead instances (`packages/backend-opencode/src/endpoint.ts` + regression test in `runtimeLifecycle.test.ts`). |
| OC-REAL-060 | **PASS (RERUN)** | Polyth SIGKILL with owned child + turn alive: durable authority remained identical, generation advanced 1→2 before the exact recorded child was replaced, and first-wire abort returned 200 in 30 ms instead of `binding-mismatch`. Projection settled `unknown` (not stale `sending`/`working`); one prompt, intent, and side effect; SQLite `ok`. See `artifacts/opencode-real-world/phase-4/OC-REAL-060-RERUN/`. |
| OC-REAL-061 | **PASS (RERUN)** | Exact child SIGKILL followed by Polyth SIGKILL, then Polyth/OpenCode restart: stable authority, generation 1→2, first-wire abort 200 in 29 ms, honest `unknown`, WAL/PID identity valid, and exactly one prompt, intent, and side effect. See `artifacts/opencode-real-world/phase-4/OC-REAL-061-RERUN/`. |

**Fixed and rerun:** the owned local lease persists a stable logical authority
and advances its durable generation before spawn. On first wire, the server now
rebinds an exact backend session ID across owned generations only after
authority, protocol, and location match, then reconciles on the current
generation. The backend lifecycle still rejects stale bindings and callbacks;
the real reruns no longer fail permanently or retain stale active projections.

BLOCKERs 4, 5 and 9 were not triggered. Initial Polyth boots used ports
15140–15154 and the targeted reruns used 15260/15261 (never 14500), with unique
data dirs; all forced stops used recorded exact PIDs.
Full evidence is under `artifacts/opencode-real-world/phase-4/` and
`logs/opencode-real-world/phase-4/`; the concise index is
`artifacts/opencode-real-world/phase-4/RESULTS.md`.

## Phase 8 — SSH remote and network faults

Validated 2026-08-28 against real OpenCode CLI `1.18.18` through an isolated
real localhost OpenSSH daemon (`127.0.0.1:22282`) because no external remote
host was available. The target shared this Linux VM, but process channels and
all OpenCode HTTP/SSE traffic crossed the production `@polyth/ssh`
ControlMaster and TCP forward. Counts for OC-REAL-078–083: **0 pass, 2 partial,
4 fail.**

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-078 | **FAIL (POLYTH)** | Real SSH probe/PATH, missing binary/path handling, serve/forward, 29 models, 4 agents, create/list join, prompt admission, PID identity and read-only unchanged config worked. An occupied remote port was not classified for retry; the fresh candidate was never tried. The text attachment reached OpenCode but the selected model rejected that media type. |
| OC-REAL-079 | **PARTIAL (POLYTH)** | Pre-mutation ControlMaster loss applied no prompt and recovery allocated a fresh local forward/generation (no dead-port reuse), but the operation threw protocol-negotiation failure and the prior session did not reconcile transparently. |
| OC-REAL-080 | **FAIL (POLYTH)** | After one confirmed remote prompt admission, exact ControlMaster loss stranded the accepted turn/history. Refresh replaced the endpoint at generation 2 and session recovery failed. No duplicate prompt was observed. The narrower response-loss timing remains an evidence gap because this run dropped after the confirmed response. |
| OC-REAL-081 | **FAIL (POLYTH)** | SSH was interrupted during a delayed remote tool turn. The old remote history was not usable, endpoint refresh replaced the whole owned generation, and completion was not recovered after reconnection. No local fallback runtime or duplicate prompt was observed. |
| OC-REAL-082 | **PARTIAL (POLYTH)** | Exact remote PID identity gating and the stale/reused-PID guard worked: an unrelated live PID in a mismatched record survived. Fresh child/forward generation recovered, but the active session could not prove continuity or reconcile. |
| OC-REAL-083 | **FAIL (POLYTH)** | Production Polyth was SIGKILLed after confirmed remote prompt admission and restarted over the same valid SQLite database. Intent/operation survived once, but the session stayed `working`; first-wire materialization and the next send failed `binding-mismatch` because SSH authority/generation is not durable across Polyth restart. Separate exact ControlMaster loss disconnected SSE and left the projection stale. |

No remote turn completed while disconnected and then reconciled into Polyth.
The current SSH runtime couples the remote child shell and local forward to one
ControlMaster; disconnect exits that handle, the launcher traps `HUP`, and
refresh replaces the entire generation. SSH-owned authority/generation also
is not persisted across Polyth restart. No speculative fix was applied because
correct recovery requires explicit same-child continuity, forward-only
replacement, and durable remote authority/generation semantics.

Every forced stop used an exact numeric PID after identity verification; port
14500 was never used. Full evidence is under
`artifacts/opencode-real-world/phase-8/` and
`logs/opencode-real-world/phase-8/`; the concise index is
`artifacts/opencode-real-world/phase-8/RESULTS.md`.

## Phase 9 — scaled soak

This was a **10.1-minute scaled dense soak, not a 24-hour soak claim**, against
real OpenCode CLI `1.18.18` on forced legacy protocol. It accumulated 24
sessions, 253 unique logical messages (24 direct + 229 queued), 1,527 durable
events, 117 model refreshes, 117 WebSocket reconnect/gap-fills, one exact owned
OpenCode child restart, and one exact Polyth restart while its owned child
survived. Port 15290 was used (never 14500).

| ID | Verdict | Current result |
| --- | --- | --- |
| OC-REAL-084 (scaled) | **PASS** | No duplicate logical prompt or side effect, no final `sending`/`working` projection, SQLite integrity `ok`, and no monotonic non-data leak across 120 samples. In the final 20-sample window Polyth RSS grew 3,224 KiB, descriptors 2, and sockets 2; event-log files totaled 5,627,576 bytes. Session-load p50/p95 was 1.7/2.2 ms and WebSocket reconnect/gap-fill p50/p95 was 1.6/2.5 ms. |
| OC-REAL-085 | **NOT RUN** | The Phase 2 response-loss proxy was not composed into this ownership soak. Owned child and Polyth death/replacement were exercised, but no response-loss verdict is claimed. |
| OC-REAL-086 (scaled) | **PARTIAL** | 205 FIFO rows survived both generation changes with unchanged row counts and drained through exact queue-row removal with zero rows left. Twenty-four queued prompts dispatched before the fault boundaries; all upstream markers were unique. Automatic post-fault dispatch and recurring permission/question stress remain unproved because generation-only continuity truthfully settled sessions `unknown` and rejected 80 later queue admissions with expected 409 conflicts. |
| OC-REAL-087 (scaled) | **PARTIAL** | Exact cwd/PID/parent-chain checks showed one current wrapper/child pair, no stale owned processes, and no signal outside the isolated run. This pass covered one project/runtime; worktree, second-project, SSH, and config-batch churn were not included. |

Seven real bash side effects completed with zero duplicates. The final service
and its exact owned child remain running for follow-up inspection; their
identities are recorded in `artifacts/opencode-real-world/phase-9/live-state.json`.
Full evidence and metrics are in `artifacts/opencode-real-world/phase-9/` and
`logs/opencode-real-world/phase-9/scaled-mtcp5xea/`.

## Phase 10 — UI state truthfulness

Executed 2026-08-28 against real OpenCode CLI `1.18.18`. Verdict: **PARTIAL
(coverage gaps; no safety issue confirmed)**. IDLE, WORKING, FAILED, UNKNOWN,
and reload persistence rendered truthfully against the database; the "No
models available" P0 did not reproduce. The run's original "CRITICAL: composer
enabled during working" finding was a **false alarm and is withdrawn**: the
durable queue is an intentional product contract — sends during a running
turn queue durably (validated for real in OC-REAL-075; plan row OC-REAL-090)
— and the actual danger, a stale IDLE projection admitting a second in-flight
turn, was not observed (OC-REAL-073 proved exactly-one admission with the
loser queued). SENDING/QUEUED/THINKING/TOOL/PERMISSION/QUESTION/INTERRUPTED/
COMPLETED/RECONNECTING states and the stale-IDLE probe (OC-REAL-099/100) were
not observed because no functioning agent turn completed. Concise index:
`artifacts/opencode-real-world/phase-10/RESULTS.md`; full report and
screenshots under `/opt/cursor/artifacts/phase10-ui-*`.

## Phase 13 — adversarial crash boundaries (NOT EXECUTED)

Phase 13 (OC-REAL-101–112, defined in
`docs/opencode-hardening/REAL-WORLD-VALIDATION.md`) was never run in this
campaign. No artifacts or logs exist, and no Phase 13 scenario may be cited as
evidence in `docs/opencode-hardening/RELEASE-GATE.md`.
