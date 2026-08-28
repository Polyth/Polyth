# Real-world OpenCode torture validation

Status: execution plan for OpenCode CLI `1.18.18` and later explicitly pinned versions.
The torture/soak campaign was paused for BLOCKER 0 and was not continued during this
fix. BLOCKER 0 now has separate live V2 discovery/session evidence; that result does not
claim that any other scenario in this plan passes.

## Rules and evidence contract

Run each scenario in a fresh copied repository, fresh `POLYTH_DATA_DIR`, and unique
OpenCode config/data directory. Record exact Git SHA, OpenCode binary SHA/version, Node
version, OS, protocol selection, provider/model, project path, worktree path, process IDs,
endpoint URL, authority ID, generation, and fault-proxy seed. Never record credentials.

Engine codes:

- **R** — real OpenCode is required. A fake result is not acceptance evidence.
- **H** — the existing socket fault harness can execute the fault deterministically.
- **R+H** — first make the boundary deterministic with the harness, then repeat against real
  OpenCode through a TCP/HTTP fault proxy.

Required evidence codes:

- **O** — timestamped OpenCode stdout/stderr plus redacted HTTP request/response and SSE
  frames. Preserve status, headers, body byte count, event ID, and connection ID.
- **P** — Polyth stdout/stderr plus lifecycle records: protocol, authority, generation,
  endpoint replacement, stream connect/disconnect, reconciliation ordinal and reason.
- **D** — before/after SQLite extracts for `events`, `projections`, `runtime_operations`,
  `session_queue`, `response_intents`, `observations`, `observation_checkpoints`,
  `observation_cursors`, `session_reconciliations`, and `deletion_tombstones`, restricted to
  the test session. Include integrity check and WAL checkpoint state.
- **U** — timestamped WebSocket trace for every client and UI screenshot/video at each
  asserted state.
- **X** — fault timeline from the proxy/process controller: request byte boundary, signal,
  socket close, partition rule, and restoration time.
- **F** — filesystem/process evidence: PID record, `/proc` identity, config hashes,
  worktree paths, attachment paths, and remote-forward identity.

For every row, capture the named **Inspect** state immediately before the fault, immediately
after it, after Polyth recovery, and after one extra reconnect/reload. “Once” means one
logical canonical fact and, where observable, one upstream effect.

### Fault attribution

1. Build an independent upstream timeline from **O/X** before reading Polyth state.
2. It is a **Polyth bug** when the wire proves a fact that Polyth loses, duplicates,
   regresses, misattributes, or displays before durable append; when Polyth sends an
   unpermitted duplicate; or when it kills/configures a borrowed process.
3. It is an **OpenCode bug** when the wire proves one valid request and OpenCode violates a
   pinned contract (wrong location, duplicate client ID effect, missing committed entity,
   invalid event order/revision) while Polyth remains blocked or explicitly uncertain.
4. It is a **contract gap**, not a pass, when the proxy cannot prove whether OpenCode
   accepted the mutation or when an unversioned snapshot cannot order two facts. Polyth must
   remain `unknown` and preserve intent/queue/attention.
5. A behavior seen only in `fakeOpenCode.ts` is a **harness assumption** until the real
   server reproduces it. In particular, do not use the fake's reflected
   `x-polyth-operation-id` as real-world proof.

## Stop-the-line invariants

Stop a run on duplicate model-visible output, duplicate unkeyed mutation, queue loss,
premature attention closure, false terminal status, stale-generation state regression,
cross-worktree/remote leakage, borrowed-process termination, unowned config change, secret
leakage, SQLite corruption, or UI content preceding its durable event.

## Scenario catalog

### Phase 1 — capability matrix

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-001 | R | Start an owned local runtime from a clean data/config directory; repeat with occupied first port and stale invalid PID record. | No child/no binding -> live exact child, endpoint generation 1. | One child becomes ready inside deadline; stale record is removed; collision child is reaped. | Hang, leaked child, wrong cwd, or unrelated PID signalled. | O,P,X,F |
| OC-REAL-002 | R+H | Make each readiness path (`/global/health`, `/api/health`, `/agent`, `/provider`) succeed, fail, stall, and recover. | Starting generation -> ready or bounded startup failure. | Any valid 2xx proves readiness; every stall is bounded and leaves no half-live generation. | False ready, unbounded wait, or dead generation reused. | O,P,X |
| OC-REAL-003 | R | List models with connected and disconnected providers and one model with text/image/reasoning variants. | Raw `/provider` -> API/UI catalog. | IDs, names, connection state, modalities and variants survive normalization exactly. | Invented connectivity, missing usable model, or unsupported model offered as usable. | O,P,U |
| OC-REAL-004 | R | Compare raw provider response, configured credentials, and provider/model UI without exposing secrets. | Provider config hash -> catalog and redacted logs. | Connected providers match upstream; no secret literal appears in API, logs, or UI. | Wrong provider state or any credential disclosure. | O,P,U,F |
| OC-REAL-005 | R+H | Create a session with and without title; inspect response and upstream listing. | Prepared create operation/shell -> bound backend ID and reconciled idle. | One backend session, one confirmed operation, exact binding, no placeholder title forced upstream. | Duplicate create, false idle, missing binding, or shell removed on ambiguity. | O,P,D |
| OC-REAL-006 | R | Create sessions outside Polyth, then list/sync from Polyth in two directories. | Upstream lists -> Polyth unadopted catalog. | Counts and IDs match location scope; no session is silently adopted. | Missing, duplicated, or cross-directory item. | O,P,D,U |
| OC-REAL-007 | R+H | Adopt an existing session containing user, text, reasoning, tool, and terminal records; reload twice. | No canonical session -> import baseline and hydrated projection. | Existing history appears once, baseline is durable, second hydrate is idempotent. | Duplicate history, omitted model-visible fact, or admission before reconcile. | O,P,D,U |
| OC-REAL-008 | R | Submit one forced-legacy prompt and compare request body, returned status, upstream user message and operation row. | Idle/confirmed binding -> working -> terminal. | One prompt, selected model/agent/variant intact, intent durable before POST. | Duplicate POST, body drift, started state on unknown, or missing intent. | O,P,D,U |
| OC-REAL-009 | R+H | Stream a response with many text deltas, UTF-8 split across packets, and final full-value update. | Working/no assistant text -> ordered finalized assistant message. | Text is monotonic and exact once; finalization follows durable ingestion. | Garbling, lost suffix, duplicate text, or UI-before-log. | O,P,D,U,X |
| OC-REAL-010 | R | Force a read-only tool and a mutating tool with observable side effect. | Tool absent -> pending -> running -> one terminal result. | Lifecycle ranks are ordered; side effect and canonical result occur once. | Result without call, duplicate effect/result, wrong args, or terminal rank regression. | O,P,D,U,F |
| OC-REAL-011 | R+H | Use a reasoning-capable model with visible thinking; split typed and initially untyped deltas. | No reasoning -> streaming reasoning -> finalized reasoning/text. | Reasoning is not exposed as answer text and resolves once when type becomes known. | Hidden reasoning leaked, reasoning lost, or duplicated on pull. | O,P,D,U |
| OC-REAL-012 | R | Send in-root file, line range, image, and HTTPS URL; also attempt traversal/out-of-root path. | Attachment refs and root hash -> upstream prompt parts/tool access. | Valid attachments are exact and scoped; URL is explicit text; traversal is rejected pre-I/O. | Wrong file/range/MIME, path escape, duplicate upload, or secret content in logs. | O,P,D,U,F |
| OC-REAL-013 | R+H | Trigger a permission while connected and while UI is detached. | Working -> durable open permission/waiting. | Identified request is appended once before any client card/notification. | Lost request, duplicate card, wrong session, or card before event. | O,P,D,U |
| OC-REAL-014 | R+H | Answer separate permissions `once`, `always`, and `reject`; race two clients on one request. | One open request/no response intent -> one chosen intent -> closed or honest unknown. | Exactly one upstream answer and one durable winner; loser observes winner. | Two answers, premature closure, reopened confirmed request, or scope bleed. | O,P,D,U |
| OC-REAL-015 | R+H | Trigger single-choice, multi-choice, free-text and multi-question requests while connected/detached. | Working -> durable open question/waiting. | Prompt/options/multiplicity survive normalization exactly once. | Lost option, wrong serializer shape, duplicate, or pre-log UI. | O,P,D,U |
| OC-REAL-016 | R+H | Reply and reject questions; race web and push/mobile answers. | Open question -> one response intent -> closed or honest unknown. | One upstream action, one durable winner, exact answer arrays. | Duplicate response, malformed answer, premature closure, or stale action accepted. | O,P,D,U |
| OC-REAL-017 | R+H | Abort during text, reasoning, tool pending, tool running, permission and question. | Active turn/open artifacts -> interrupted/aborted evidence. | One abort attempt; no invented completion; unresolved side effects stay explicit. | Second abort POST, completed badge, lost pending request/queue, or hidden running tool. | O,P,D,U,X |
| OC-REAL-018 | R+H | Fork before first prompt, mid-history, and at full history; include repeated equal text. | Source immutable -> one verified child with exact positional prefix. | Child history and cwd are exact; source mapping never changes on failed verification. | Text-based wrong boundary, duplicate child, source corruption, or cross-location fork. | O,P,D,U |
| OC-REAL-019 | R+H | Drop SSE during each active phase, retain backend, reconnect after 0.5/5/30 seconds. | Current cursor/checkpoints -> reconnect/reconcile -> converged state. | No prompt replay; facts recover once or remain explicit uncertainty. | Silent loss, duplicate output, admission before barrier, or stale cursor skip. | O,P,D,U,X |
| OC-REAL-020 | R | Complete normally, reload UI and restart Polyth. | Working -> upstream idle with ordered evidence -> completed/idle projection. | Final answer and terminal fact survive once; queue may dispatch only afterward. | Missed completion, false working, duplicate tail, or early queue dispatch. | O,P,D,U |
| OC-REAL-021 | R+H | Produce provider error, tool error, malformed model response, and OpenCode session error. | Working -> failed with captured reason. | Failure is durable, bounded/redacted and not presented as completion. | Idle/completed lie, raw secret/error flood, or stuck active turn. | O,P,D,U |
| OC-REAL-022 | R+H | Kill/abort upstream so it reports interrupted; repeat with no comparable revision. | Working -> ordered interrupted, or unknown if unversioned. | Comparable interruption terminalizes; unversioned evidence blocks as unknown. | Unversioned terminal accepted, queue released early, or interruption shown completed. | O,P,D,U,X |
| OC-REAL-023 | R+H | Sample raw status during idle, busy, permission, question, failed and interrupted states. | Upstream status/revision -> normalized state/checkpoint. | Busy is positive; terminal values require comparable ordered evidence. | State guessed from text/arrival order, or newer checkpoint regressed. | O,P,D |
| OC-REAL-024 | R | Change `AGENTS.md` behavior while idle and active; verify next-turn revision and no unnecessary restart. | Behavior/config bytes -> next admitted turn. | Atomic write preserves unrelated bytes; behavior applies at documented boundary. | Mid-turn semantic change, lost comments, or destructive restart. | O,P,D,F |
| OC-REAL-025 | R+H | Apply MCP, plugin, provider visibility and agent changes to JSONC with unknown fields; inject write/restart failure. | Full byte/semantic hashes and pending batch -> applied/restarted or retained pending. | Only owned fields change; one safe-idle owned restart; rollback/defer is honest. | Unowned loss, active interruption, borrowed restart, cleared failed batch, or secret leak. | P,D,U,F,X |
| OC-REAL-026 | R | Against `1.18.18`, run `protocol:auto`, forced `legacy`, and forced `v2` on the same dual-surface `/doc`. | Raw paths/health -> selected adapter -> first create. | Auto must select an operational adapter or fail startup; it must not select V2 and then reject core work. | Regression: auto-selected V2 has an empty/fake catalog, gated SSE, or rejected create. BLOCKER 0 evidence now proves models/create, but does not close the full scenario evidence set. | O,P,D |
| OC-REAL-027 | R | Exercise the exact installed service-discovery API/CLI; if absent, record unsupported without substituting mDNS assumptions. | No descriptor -> discovered descriptor or explicit unavailable. | URL, headers, authority and continuity source are explicit. | Fabricated discovery, use of unpinned private API, or “supported” from declarations alone. | O,P,F |
| OC-REAL-028 | R+H | Discover a service with non-default auth, rotate credentials, and compare every HTTP/SSE connection. | Descriptor headers fingerprint -> generation-bound redacted headers. | Authoritative headers apply atomically to REST and SSE; values never persist/log. | Mixed credentials/generation, ambient credential leak, or unauthorized loop without bounded recovery. | O,P,D,X |
| OC-REAL-029 | R+H | Rotate discovered URL while two sessions are active and delay old HTTP/SSE callbacks. | Authority/generation N bindings -> N+1 barrier and reconciliation. | Old callbacks are fenced; verified continuity alone carries bindings. | State from old endpoint accepted, blind binding reuse, or duplicate prompt. | O,P,D,X |
| OC-REAL-030 | R | Start OpenCode independently, then attach Polyth without spawning another process. | Existing process/PID/session -> borrowed Polyth connection. | One process remains; Polyth reads and, if protocol enabled, operates within declared scope. | Extra child, ownership escalation, wrong directory, or service stop registration. | O,P,F |
| OC-REAL-031 | R | Shut down Polyth while attached to a running shared service and an external client remains connected. | Shared PID/connections -> Polyth detached. | Shared process and other client survive; only Polyth sockets/resources close. | Signal, `Service.stop`, config mutation, or other-client disconnect caused by Polyth. | O,P,X,F |
| OC-REAL-032 | R+H | Restart Polyth and reconnect to the surviving service/session; repeat after discovery descriptor refresh. | Durable binding older than live service -> reconciliation. | Continuity is proved or binding stays blocked; no duplicate create/prompt. | Assumed continuity from URL, duplicate entity, or lost durable history. | O,P,D,X |
| OC-REAL-033 | R | Invoke every V2 adapter capability: models, agents, list/history, create/reset/fork/prompt/steer/abort/delete/replies/SSE/reconcile. | V2 negotiated -> operation result. | Native core routes operate; absent branch/delete routes return stable typed unsupported; zero legacy fallback traffic. | Fabricated success, V1 traffic, false empty data, unsupported core work, or hang. | O,P,D,U |

### Phase 2 — mutation ambiguity

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-034 | R+H | Let prompt commit upstream, then close before response headers. | Durable executing operation/user intent -> upstream user message but unknown local outcome. | One POST; operation/turn remains unknown until exact evidence, never text similarity. | Retry, false started/completed, lost intent, or fake-only receipt treated as proof. | O,P,D,X |
| OC-REAL-035 | R+H | Return 2xx headers and partial JSON body, then TCP RST after upstream commit. | Same as 034 plus captured body boundary. | One attempt and unknown; malformed partial success is not rejection/confirmation. | Retry, parse-derived confirmation, or scheduler lock leak. | O,P,D,X |
| OC-REAL-036 | R+H | Accept prompt but delay response beyond deadline while model starts. | Deadline budget, upstream active state, executing operation. | One attempt; timeout becomes unknown; later response cannot bypass generation/operation fence. | Second POST, request exceeds bound, or late response falsely settles after replacement. | O,P,D,X |
| OC-REAL-037 | R+H | Reserve FIFO head, accept it upstream, lose response, crash Polyth, then reopen DB with later items queued. | Reservation/executing -> startup unknown with upstream message. | Same head remains blocking; exact proof confirms/removes it once; later items stay ordered. | Queue row loss, fresh operation ID, duplicate dispatch, or later-item overtaking. | O,P,D,X |
| OC-REAL-038 | R+H | Apply permission answer, lose response, and independently vary pending-list lag. | Chosen response intent/open card -> upstream applied but local unknown. | No retry; card stays until exact receipt or causally newer complete absence. | Closure from mere absence/presence, second answer, or intent reset on restart. | O,P,D,U,X |
| OC-REAL-039 | R+H | Apply question reply/reject, lose response, and return stale/partial pending snapshots. | Chosen intent -> upstream applied/local unknown. | Same safety as 038 with answer payload retained. | Duplicate, wrong action, premature closure, or stale client can answer again. | O,P,D,U,X |
| OC-REAL-040 | R+H | Create fork child upstream, lose response before ID, then restart both sides. | Source fork operation -> orphan possible upstream child/no local child. | Never issue a second unkeyed fork; recover only by exact child receipt/ID or remain unknown. | Duplicate child, title/history similarity adoption, or source mutation. | O,P,D,X |

### Phase 3 — SSE and reconciliation

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-041 | R+H | Drop each event family independently: session status/error, message, text/reasoning part, tool rank, permission, question, compaction, usage, title. | Per-family checkpoint/cursor before drop -> pull/reconnect result. | Pull restores identifiable durable facts once; unverifiable/unsupported facts become explicit uncertainty. | Silent omission, synthesized fact, duplicate, or cursor advances past missing fact. | O,P,D,X |
| OC-REAL-042 | R+H | Drop only permission request while all surrounding events arrive; answer after pull recovery. | Working with no card -> pending list contains request -> one durable card. | Recovery is session-bound and exactly once. | No card, duplicate card, or answer routed to another session. | O,P,D,U,X |
| OC-REAL-043 | R+H | Drop only question request and vary list consistency delay. | Working with no card -> pending list eventually contains request. | Do not infer list completeness; add identified request once when visible. | Missing/duplicate question or premature turn terminalization. | O,P,D,U,X |
| OC-REAL-044 | R+H | Drop final text/status/completion SSE after all output commits upstream. | Local working/checkpoint behind upstream terminal history. | Reconciliation appends only proven suffix and terminalizes only with ordered evidence. | Stuck forever despite valid proof, duplicate answer, or false terminal on unversioned status. | O,P,D,U,X |
| OC-REAL-045 | R+H | Replay every SSE frame twice, once with same event ID and once with new transport ID for same entity/revision. | Empty observation tables -> repeated deliveries. | Semantic fact and side effects occur once across SSE and pull. | Dedup only by transport ID, duplicate tool result/text/attention, or divergent payload hidden. | O,P,D,X |
| OC-REAL-046 | R+H | Commit newer pull snapshot/checkpoint, then deliver delayed older SSE from same and old generations. | Newer durable checkpoint -> old event arrival. | Old event is ignored or uncertainty is appended; projection/cursor never regresses. | Old output/status/card reopens or overwrites newer state. | O,P,D,X |
| OC-REAL-047 | R+H | Cause 100 SSE disconnects with jitter, silent connections, 401, endpoint refresh failures and eventual recovery. | Connection/generation counters and open turn -> converged stream/reconcile. | Bounded backoff, no process storm, no mutation replay, eventual single convergence. | Tight loop/resource leak, endpoint churn without descriptor change, duplicate state, or dead recovery. | O,P,D,X,F |

### Phase 4 — process lifecycle

Use one deterministic barrier per row; “kill” means exact PID identity, never process-name
matching.

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-048 | R+H | Kill owned OpenCode after spawn but before listen line. | PID record/startup promise -> bounded failure/replacement. | Exact child is cleaned; no ready generation installed. | Hang, orphan, false ready, or unrelated signal. | P,X,F |
| OC-REAL-049 | R+H | Kill after listen but during health/protocol probe. | Endpoint candidate -> probe failure/recovery. | Failed generation is never exposed; later recovery builds fresh generation. | Dead URL reuse or leaked stream. | O,P,X,F |
| OC-REAL-050 | R+H | Kill after session-create commit but before response. | Create executing -> possible upstream session. | Canonical shell and unknown operation survive; no automatic second create. | Duplicate backend session or shell deletion. | O,P,D,X |
| OC-REAL-051 | R+H | Kill after prompt acceptance but before first event/response. | User intent/executing -> upstream message possible. | No replay; reconcile or remain unknown. | Duplicate prompt or false not-applied. | O,P,D,X |
| OC-REAL-052 | R | Kill mid-text after several durable deltas. | Text checkpoint/prefix -> dead backend. | Prefix remains; no invented suffix/completion; recovery uses proven suffix only. | Lost prefix, duplicated prefix, or completed state. | O,P,D,U,X |
| OC-REAL-053 | R | Kill mid-reasoning before answer. | Reasoning checkpoint -> dead backend. | Reasoning/tool state remains truthful; session is interrupted/unknown by evidence. | Reasoning rendered as final answer or false idle. | O,P,D,U,X |
| OC-REAL-054 | R | Kill after tool call is pending but before execution. | Durable pending tool -> backend dead. | No fabricated result; status remains explicit. | Tool silently disappears or reruns without proof. | O,P,D,U,X |
| OC-REAL-055 | R | Kill after observable tool side effect but before terminal tool event. | Filesystem side effect exists/tool running -> backend dead. | Polyth does not repeat tool/prompt and does not claim result it never observed. | Duplicate side effect, fake success, or hidden uncertainty. | O,P,D,U,X,F |
| OC-REAL-056 | R | Kill while permission is pending. | Open durable permission -> backend dead/restarted. | Card persists unless newer authoritative evidence resolves it. | Card lost/auto-closed or answer sent to replacement without binding proof. | O,P,D,U,X |
| OC-REAL-057 | R | Kill while question is pending. | Open durable question -> backend dead/restarted. | Same rule as 056. | Lost/duplicated question or answer misroute. | O,P,D,U,X |
| OC-REAL-058 | R+H | Kill while abort request is in flight after original work stops or continues. | Abort executing -> ambiguous upstream state. | Abort stays unknown until evidence; queue remains blocked. | Retry, false interrupted, or queue dispatch into active work. | O,P,D,X |
| OC-REAL-059 | R+H | Kill after upstream terminal commit but before terminal SSE reaches Polyth. | Local working/upstream terminal -> replacement reconcile. | Recover output and ordered terminal once, or remain unknown if evidence is unversioned. | Duplicate answer, stuck false active with valid proof, or guessed idle. | O,P,D,U,X |
| OC-REAL-060 | R | Restart Polyth while owned OpenCode and active turn live; do not kill OpenCode. | Durable state older than live upstream -> new server first-wire reconcile. | Existing process/session is handled according to ownership contract; no duplicate prompt; active state survives. | Startup reaps a healthy still-owned child without an explicit transfer contract, duplicates work, or admits early. | O,P,D,X,F |
| OC-REAL-061 | R+H | Kill Polyth and OpenCode at each asynchronous phase above, then restart Polyth first and OpenCode second. | WAL/runtime op/PID identity -> unknown/reconcile/recovery. | DB is valid; executing becomes unknown; exact stale child handling; no replay. | Corruption, queue/intent loss, PID reuse signal, duplicate mutation, or false terminal. | O,P,D,X,F |

### Phase 5 — shared V2 ownership

These are V2 acceptance gates. Core V2 discovery/session operations are enabled, but
current Polyth composition still does not wire borrowed service or external leases into
normal server boot. BLOCKER 0 is not acceptance evidence for these ownership scenarios.

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-062 | R | Join a pre-existing V2 service with an active session and external client. | Service descriptor/PID -> borrowed endpoint/binding. | No spawn/stop/config; active session is listed/hydrated if capability enabled. | Ownership escalation, hidden active state, or fabricated empty catalog. | O,P,D,F |
| OC-REAL-063 | R | Shut down Polyth during V2 work while another client observes service. | Shared PID/turn -> Polyth detached. | Service and work continue. | Shared stop/signal, cancelled other client, or config mutation. | O,P,X,F |
| OC-REAL-064 | R+H | Restart/replace shared service, then rediscover it. | Descriptor/generation N -> N+1. | URL/auth refresh is atomic; continuity must be explicit before binding reuse. | URL equality used as proof or old callback accepted. | O,P,D,X |
| OC-REAL-065 | R+H | Rotate URL and auth independently and together while HTTP and SSE requests are in flight. | Connection/header fingerprints -> replacement barrier. | No mixed-generation request; unauthorized causes bounded rediscovery. | Secret leak, stale auth loop, or old endpoint state accepted. | O,P,D,X |
| OC-REAL-066 | R | Attach two projects/directories/workspaces to one shared service, including colliding session IDs. | Location keys -> catalogs/events/replies. | `directory` plus real V2 workspace identity isolates all traffic. | Cross-project event, prompt, attention, config, or binding. | O,P,D,U,F |
| OC-REAL-067 | R | Operate one session concurrently from Polyth and two official clients: prompt, queue, permission and abort. | Three client timelines -> shared durable V2 history/events. | Conflicts are explicit; Polyth never assumes sole writer or overwrites newer facts. | Lost external action, duplicate response, stale terminalization, or divergent clients left unexplained. | O,P,D,U,X |

### Phase 6 — worktree isolation

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-068 | R | Run root plus two worktrees concurrently with distinct marker files and same prompt text. | Three resolved cwd/runtime keys -> tool/files/session state. | Every request/event/config lookup remains in its cwd. | Marker or session crosses location. | O,P,D,F |
| OC-REAL-069 | H | Force equal backend session/message/request IDs across root and worktree endpoints. | Observation identity keys -> canonical logs. | Authority/location/binding prevent collisions. | Dedup or routing crosses sessions. | P,D,X,F |
| OC-REAL-070 | R+H | Race two clients creating a worktree and session for the same branch; remove one candidate during validation. | Git worktree list and create promises -> one valid location or bounded rejection. | No runtime starts for an unverified path; no duplicate/reaped sibling runtime. | TOCTOU path use, orphan worktree/process, or wrong branch. | P,D,U,X,F |
| OC-REAL-071 | R | Delete an active session's worktree during text, tool, permission and idle phases. | Ready projection/live cwd -> missing projection and runtime lifecycle. | Existing durable history remains; new filesystem work is blocked or fails truthfully; no fallback to project root. | Silent root fallback, data loss, false success, or cross-tree edit. | O,P,D,U,F |
| OC-REAL-072 | R+H | Fork and send attachments from a worktree while root has same relative names; rotate endpoint mid-read. | Child binding and resolved attachment URLs -> upstream history/files. | Child stays in source worktree and receives only source bytes. | Root byte leak, target cwd drift, or old-generation attachment mutation. | O,P,D,X,F |

### Phase 7 — multi-client observation

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-073 | R+H | Two browsers send different messages from idle within one scheduler tick. | Per-client WS order and operation ordinals -> one admitted/one queued. | Both converge to identical durable order. | Two admissions, missing loser, or client-specific canonical order. | P,D,U,X |
| OC-REAL-074 | R+H | Two clients answer one pending permission/question with different choices. | Open request/no intent -> one CAS winner. | Both clients converge; exactly one upstream answer. | Last-writer overwrite, duplicate reply, or loser shown as success. | O,P,D,U |
| OC-REAL-075 | R+H | One client edits/reorders/removes queued items while another watches and active turn completes. | Queue rows/reservation and two WS traces -> dispatch order. | Reservation blocks edits that would corrupt dispatch; both clients converge. | Lost item, stale dispatch text, reorder mismatch, or duplicate. | P,D,U,X |
| OC-REAL-076 | H | Switch client A rapidly among sessions while gap-fill is in flight; client B stays subscribed and live events arrive. | Per-socket subscription/cursor -> final active session views. | Gap-fill/live events are seq-deduped and session-bound. | Cross-session event, dropped live event, duplicate, or old subscription wins. | P,D,U,X |
| OC-REAL-077 | R | Disconnect every UI while a turn/tool/pending request continues; reconnect a new UI after completion or waiting. | No WS clients/active backend -> rehydrated UI. | Backend remains active; durable state catches up; no work depends on UI presence. | Abort on UI loss, missing completion/request, duplicate prompt, or stale sending indicator. | O,P,D,U,X |

### Phase 8 — SSH remote and network faults

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-078 | R | Probe remote CLI, validate remote path, start serve and forward; repeat missing binary/path and port collisions. | No remote artifacts -> exact remote PID/forward or bounded error. | PATH extension works, collision attempts clean up, local config stays read-only. | Leaked remote child/forward, wrong cwd, or local config authority. | O,P,X,F |
| OC-REAL-079 | R+H | Drop SSH tunnel before any mutation bytes and restore with a new local port. | Generation N/operation prepared -> refreshed forward. | No mutation is claimed applied; binding crosses only proved continuity. | False unknown-as-confirmed, dead port reuse, or leaked forward. | O,P,D,X,F |
| OC-REAL-080 | R+H | Drop tunnel after remote prompt acceptance but before response. | Remote upstream message/local executing -> unknown. | One prompt; no retry; remote state reconciles after forward recovery. | Duplicate prompt, intent loss, or assumed not-applied. | O,P,D,X,F |
| OC-REAL-081 | R | Partition SSE/SSH control after prompt, let remote complete, then restore. | Local working/remote progressing -> completed remote history. | Remote completion recovers once; no local process is substituted. | Duplicate text, local fallback runtime, or false failure. | O,P,D,U,X,F |
| OC-REAL-082 | R | Kill exact remote OpenCode child while tunnel remains; test PID reuse before restart. | Remote identity record -> replacement generation. | Only matching child is signalled; stale/reused PID survives; fresh child/forward reconcile. | Unrelated kill, old callback acceptance, or orphan. | O,P,D,X,F |
| OC-REAL-083 | R | Restart Polyth during remote work, then separately restart SSH daemon/network. | Durable remote binding/remote PID/forward -> recovery. | No duplicate remote child or prompt; inability to prove continuity remains blocked. | Blind adoption, remote kill from stale token, or queue dispatch before reconcile. | O,P,D,X,F |

### Phase 9 — soak

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-084 | R | Run 24 hours or 10,000 turns across 20 sessions with text/reasoning/tools and periodic reloads. | Baseline RSS/fds/listeners/DB size -> periodic samples/final convergence. | Bounded growth explained by durable data; zero duplicates/loss/corruption. | Unbounded non-data growth, listener leak, stuck session, or invariant breach. | O,P,D,U,F |
| OC-REAL-085 | R+H | During soak, inject randomized response loss, SSE drop/duplicate/stall, endpoint rotation and process death with saved seed. | Seeded fault timeline -> recovered state. | Reproducible convergence or explicit unknown; no mutation replay. | Non-reproducible silent loss, deadlock, storm, or duplicate effect. | O,P,D,X,F |
| OC-REAL-086 | R+H | Maintain long FIFO queues and recurring permission/questions while clients connect/disconnect. | Queue/attention counters and rows -> final drain. | FIFO and CAS remain exact; indexed counters equal event-derived counts. | Starvation, row/counter drift, duplicate answer, or queue loss. | O,P,D,U,X |
| OC-REAL-087 | R | Churn projects, worktrees, local/SSH runtimes and config batches during soak. | Runtime pool/PIDs/config/worktree hashes -> final cleanup. | One runtime per resolved cwd, exact ownership, no unowned config change. | Runtime reaps sibling, leaked child/forward, root fallback, or restart while busy. | P,D,X,F |

### Phase 10 — UI truthfulness

For every row compare the rendered state to **D** and the independent upstream timeline.
Capture a video; a screenshot alone is insufficient for transition order.

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-088 | R | Open a freshly reconciled idle session. | Ordered idle evidence/no blockers -> composer. | Composer enabled; no spinner/active tool. | Idle without authority, or hidden blocker. | O,D,U |
| OC-REAL-089 | R+H | Hold send between durable prepare, claim, request write and response. | Operation state per barrier -> sending affordance. | Intent appears only after append; UI distinguishes unresolved send from running. | Running before confirmed admission or lost send on reload. | D,U,X |
| OC-REAL-090 | R | Queue multiple messages during active work and reload. | Queue rows -> queue cards/order. | Exact text/order/actionability; ambiguous reserved head is visibly blocked. | Missing/phantom item or editable in-flight reservation. | D,U |
| OC-REAL-091 | R | Confirm prompt and stream text. | Confirmed operation/turn start -> running UI. | Running begins only after confirmation/evidence and survives reload. | Running on unknown or idle during active upstream. | O,D,U |
| OC-REAL-092 | R | Stream reasoning before text. | Reasoning events -> thinking UI. | Thinking is distinct from final text and remains session-bound. | Reasoning shown as answer or no active state. | O,D,U |
| OC-REAL-093 | R | Hold tool at pending and running, then terminalize. | Tool checkpoints -> tool row ranks. | Rank/order/args/result are truthful and one-time. | Fake result, hidden running call, or rank regression. | O,D,U |
| OC-REAL-094 | R | Hold permission open, disconnect/reconnect and answer. | Durable open counter/intent -> approval card. | Card persists and closes only on valid evidence. | Early closure, duplicate card, or wrong scope. | O,D,U |
| OC-REAL-095 | R | Hold question open with multiple prompts, reconnect and answer. | Durable open counter/intent -> question card. | Exact controls/answers; close only on valid evidence. | Lost option, duplicate, or early closure. | O,D,U |
| OC-REAL-096 | R+H | Interrupt at text and tool phases. | Abort/ordered status evidence -> interrupted presentation. | Never labeled completed; partial output/tool uncertainty remains visible. | Completion lie or vanished partial work. | O,D,U,X |
| OC-REAL-097 | R | Trigger provider and tool failure. | Durable failure reason -> failed badge/timeline. | Concise redacted failure; retry affordance does not imply automatic replay. | Idle/completed badge, secret leak, or missing reason. | O,D,U |
| OC-REAL-098 | R | Complete, reload and reconnect another client. | Final answer/terminal event -> completed/idle presentation. | Both clients show one final answer and no active controls. | Duplicate/missing answer or lingering stop button. | O,D,U |
| OC-REAL-099 | R+H | Disconnect SSE and endpoint while turn is active. | Stream disconnected/reconciliation row -> reconnecting presentation. | UI shows degraded/reconciling or unknown, blocks unsafe send, preserves content. | False idle/completed, enabled unsafe send, or blank transcript. | P,D,U,X |
| OC-REAL-100 | R+H | Return incomplete/unversioned reconciliation after reconnect, then later valid evidence. | `session_reconciliations` unknown -> ready. | Unknown is explicit, not collapsed to idle; UI recovers when proof arrives. | Permanent spinner with no diagnosis, unsafe admission, or guessed terminal state. | O,P,D,U,X |

### Phase 13 — additional adversarial crash sequences

No separate Phase 13 scenario list exists in this repository. These rows make the
orchestrator's stated example (“crash after upstream success before durable write”) and the
adjacent durable boundaries explicit.

| ID | Engine | Procedure and fault | Inspect | Expected state | Failure criteria | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| OC-REAL-101 | R+H | Crash Polyth after upstream mutation success is on the wire but before `settleOperation` commits. | Executing row/upstream effect -> startup unknown. | Unknown survives; no replay; exact evidence may settle once. | Operation stays executing, retries, or effect is forgotten. | O,P,D,X |
| OC-REAL-102 | R+H | Crash after session create success but before projection stores backend binding. | Shell/create operation/upstream ID -> first-wire recovery. | Recover only exact receipt; real legacy without reflected operation ID remains unknown. | Similar-title adoption, second create, or lost shell. | O,P,D,X |
| OC-REAL-103 | H | Crash after canonical intent+operation prepare but before first network byte. | Prepared or executing row/no upstream request -> restart. | Prepared may be claimed once; executing is unknown even if proxy saw no bytes. | Unsafe inference from proxy-local absence or regenerated operation ID. | P,D,X |
| OC-REAL-104 | R+H | Crash after SSE callback receives an event but before SQLite observation transaction commits. | Raw SSE event/no observation row -> reconnect/pull. | Event is recovered once; cursor did not advance. | Silent loss or duplicate canonical output. | O,P,D,X |
| OC-REAL-105 | H | Crash after SQLite observation transaction commits but before projection update/WS broadcast. | Event/checkpoint committed/projection old -> restart repair. | Sequence-idempotent projection catches up; clients receive one fact. | Event re-ingested, projection remains old, or duplicate WS fact. | P,D,U,X |
| OC-REAL-106 | R+H | Crash after response-intent CAS chooses permission/question answer but before network call. | Chosen intent/prepared operation/open request -> restart. | No competing answer can win; action is retried only under a pinned idempotent contract, otherwise explicit unknown/prepared policy. | Second winner, silent abandonment, or untracked send. | O,P,D,U,X |
| OC-REAL-107 | R+H | Crash after queue head reservation/claim, with upstream acceptance uncertain, before queue confirmation. | Reserved row/executing op -> startup unknown. | Reserved head blocks FIFO and retains operation identity. | Row removal, new ID, duplicate send, or overtaking. | O,P,D,X |
| OC-REAL-108 | R+H | Fork commits upstream; crash before child canonical snapshot/publication. | Source fork operation/upstream child/no canonical child. | No untracked child is adopted by similarity and no second fork occurs. | Duplicate/orphan silently imported, partial child publication, or source corruption. | O,P,D,X |
| OC-REAL-109 | R+H | Commit deletion tombstone, let upstream delete outcome become ambiguous, then crash before local hard delete completes. | Tombstone/session rows/upstream entity -> restart listing/import. | Tombstone prevents resurrection until explicit confirmation/purge. | Re-adoption, stale events accepted, or tombstone loss. | O,P,D,X |
| OC-REAL-110 | R+H | Commit config file writes, crash OpenCode and/or Polyth before lock-owned restart loads them. | Old generation/config hashes/pending batch -> restart. | Batch is not cleared without proved replacement/reconcile; no active work is interrupted. | Cleared pending state, unknown loaded config assumed, or repeated destructive restart. | P,D,X,F |
| OC-REAL-111 | R+H | Replace endpoint after pull requests start but before the snapshot transaction settles; return mixed old/new responses. | Reconciliation ordinal/generation N -> N+1. | Whole old/mixed snapshot is rejected; no partial artifact/cursor commits. | Cross-generation snapshot accepted or partial commit. | O,P,D,X |
| OC-REAL-112 | H | During client A gap-fill, commit/broadcast newer events to client B, disconnect A, restart backend, then replay an older event. | Two socket cursors/durable seqs/new checkpoint -> reattach. | Both clients converge to durable order; stale upstream event cannot regress it. | Client divergence, duplicate, missed event, or newer state overwritten. | P,D,U,X |

## Existing test coverage vs blind spots

Deterministic tests are necessary regression evidence, but they use controlled protocol
semantics and mostly one process/client. The table lists the most relevant scenario IDs they
**do not cover**; passing the named suite does not close those IDs.

| Existing tests | What they establish | Real-world IDs still not covered |
| --- | --- | --- |
| `packages/backend-opencode/test/transportFaults.test.ts` | Query retry budget, one-shot mutation ambiguity, body faults, scripted SSE, fake endpoint/auth rotation. | OC-REAL-001–004, 008–018, 026–033, 037–044, 047–112 |
| `packages/backend-opencode/test/protocolContract.test.ts` | Prompt-path selection, response classification, generation-scoped probe cache, V2 rejection without I/O. | OC-REAL-003–025, 027–032, 034–112; critically it does not test dual-surface real `/doc` in OC-REAL-026. |
| `packages/backend-opencode/test/adapter.test.ts` and `snapshots.test.ts` | Fake legacy shape translation, attachment mapping, reasoning/tool ranks, SSE ID dedup, fork verification. | OC-REAL-001–004, 012 real bytes, 013–017 real requests, 019–033, 034–112 |
| `packages/backend-opencode/test/reconciliation.test.ts` | Pending pull recovery, semantic claim, stale generation rejection, partial absence, uncertainty. | OC-REAL-006–018 live semantics, 026–040, 041 real event-family matrix, 042–044 list consistency, 047–112 |
| `packages/backend-opencode/test/runtimeLifecycle.test.ts` | Lease no-stop unit behavior, fake shared rotation, generation fencing, PID reuse and bind collision. | OC-REAL-001 live process behavior, 026–032 real discovery/service, 047, 048–061, 062–067, 078–087, 101–112 |
| `packages/backend-opencode/test/remote*.test.ts` | Mock remote startup, collision, path/binary checks and finite deadlines. | OC-REAL-078–083 against SSH/real OpenCode, remote operation ambiguity, remote completion, daemon restart and PID reuse. |
| `packages/backend-opencode/test/config*.test.ts` | Atomic local writes and preservation of unowned JSON/JSONC fields under fakes. | OC-REAL-024–025 live reload semantics, active-turn interlock, process crash at config boundary (OC-REAL-110), remote/shared authority. |
| `packages/server/test/opencodeReliabilityE2E.test.ts` | Fake response loss, fake reflected receipts, missed attention, silent SSE, queue restart, hard death, config barrier, worktree isolation, forced legacy/V2 gates. | OC-REAL-001–033 against real CLI, 035–036, 038–040 ambiguity realism, 041 event matrix, 044–047, 048–087, 088–100 actual UI, 101–112 crash boundaries. |
| `packages/server/test/mutationOutcome.test.ts` | Unknown prompt/queue retention and conservative permission non-application logic. | OC-REAL-034–040 on real wire and all process/client/UI crash timing in OC-REAL-048–112. |
| `packages/server/test/runtimeReconciliation.test.ts` | First-wire barrier, status revision ordering, fork causal fence, snapshot rollback, tombstone listing. | OC-REAL-019 real reconnect, 041–047 real SSE, 048–087 ownership/network, 088–100 UI, 101–112 process crash timing. |
| `packages/session/test/runtimeOperations.test.ts` | SQLite state transitions, observation atomicity, snapshot rollback and ordinals. | Every upstream/process claim: OC-REAL-026, 034–061, 062–087, 101–112. It cannot prove OpenCode semantics. |
| `packages/session/test/queueLease.test.ts` and `packages/server/test/delivery.test.ts` | Reservation persistence, FIFO, send races, queue edits, interrupt ordering. | OC-REAL-037 accepted-upstream ambiguity, OC-REAL-073–075 multi-browser timing, OC-REAL-086 soak, OC-REAL-107 crash boundary. |
| `packages/server/test/wsGapFill.test.ts` and `wsNotifications.test.ts` | In-process gap-fill buffering and notification fanout. | OC-REAL-073–077 real clients/restarts and OC-REAL-112 backend death plus stale upstream replay. |
| `apps/web/test/*status*`, reducer and sidebar tests | Pure rendering/reducer state mappings. | OC-REAL-088–100 transition order against real durable and upstream truth. |

## Highest-risk blind spots

1. Real `1.18.18` dual-surface discovery now chooses an operational V2 core, but broader
   event/reconciliation/ownership behavior is not yet real-world validated.
2. Real legacy OpenCode does not reflect `x-polyth-operation-id`; fake receipt recovery is
   not live evidence for ambiguous create or prompt.
3. Borrowed shared/external leases exist at a library seam but normal server boot cannot
   select them.
4. Installed `1.18.18` has V2 HTTP endpoints and SDK declarations but no CLI
   `serve --service`; service discovery/continuity is unpinned.
5. No real event-family omission matrix proves that pull and SSE identify the same facts.
6. No real process kill covers tool side-effect-without-result, pending attention, or the
   twelve lifecycle boundaries.
7. No live SSH run covers accepted mutation plus tunnel loss or remote completion offline.
8. Worktree deletion can occur after validation; fallback-to-root and in-flight behavior are
   not torture-tested.
9. Multi-browser CAS/queue/gap-fill behavior is tested only in-process or with synthetic
   sockets, not under backend death.
10. No UI transition test proves every displayed state follows durable append and upstream
    evidence.
11. No long soak measures listener/fd/RSS growth, observation-table growth or endpoint
    disconnect storms.
12. Crash-after-upstream-success and crash-after-SQLite-before-broadcast are not exercised
    with actual process termination and WAL recovery.

## Execution order and acceptance

1. Run OC-REAL-001, 002 and the full OC-REAL-026 evidence set as preflight. The BLOCKER 0
   model/create proof does not waive the remaining OC-REAL-026 evidence requirements.
2. Establish Phase 1 forced-legacy capability facts, then ambiguity/reconciliation, then
   lifecycle/worktree/multi-client/SSH.
3. Run V2/shared scenarios only against a version and service API pinned in the evidence
   manifest. Unsupported is an honest current result, not V2 acceptance.
4. Run UI rows only after the corresponding backend row has a stable oracle.
5. Start soak only after every stop-the-line invariant passes in deterministic runs.

A scenario passes only when all required evidence is archived, all expected states are
observable, no failure criterion occurs, the independent upstream timeline agrees with the
classification, and the run is repeatable from its manifest/seed. Store one directory per
scenario under `artifacts/opencode-real-world/` and its bounded raw logs under
`logs/opencode-real-world/`.
