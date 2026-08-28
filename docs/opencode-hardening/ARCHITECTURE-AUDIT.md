# OpenCode compatibility and reliability architecture audit

Status: architecture **APPROVED, P0-COMPLETE FOR THE APPROVED LEGACY SCOPE**. The final
config-restart race is closed by an exclusive lifecycle replacement interlock spanning
safe-idle reconciliation, config writes, the owned restart, and post-restart
reconciliation. V2 behavioral capabilities remain disabled and independently gated until
their pinned live-contract tests pass.

The problem statements and failure classifications before “Verifier findings” preserve
the pre-implementation audit as historical evidence. The verifier disposition and final
implementation table are the authoritative status of the current tree.

## Approval gate

**APPROVED FOR IMPLEMENTATION: YES.**

Approval applies to the bounded architecture and invariants in this document and
`INVARIANTS.md`, not to an assertion that V2 already works. Legacy mutation safety,
persistent ingestion deduplication, lifecycle fencing, and honest uncertainty can be
implemented now. Each V2 capability remains disabled until the pinned live-contract gate
for that capability passes. In particular, the presence of client `id`, `durable`, or
`after` fields in beta declarations does not enable mutation replay or cursor resume.

The approval depends on the exclusive Agent C–H ownership map in
`IMPLEMENTATION-PLAN.md`. An implementation that weakens an invariant, shares an exclusive
file between lanes, stops an ensured/shared service, or appends unidentified recovery output
requires another architecture review.

## Scope and evidence

This audit covers the current OpenCode boundary, session durability, delivery, runtime
ownership, configuration, local/worktree/SSH scoping, and the existing tests. The primary
evidence is the repository source at the paths cited below. The V2 section also uses:

- the installed `opencode` and `@opencode-ai/sdk` version `1.18.18`;
- the installed declarations under
  `/home/ubuntu/.opencode/node_modules/@opencode-ai/sdk/dist/v2/`;
- the current beta client documentation at
  <https://opencode.ai/v2/docs/build/client>; and
- the current server documentation at <https://opencode.ai/docs/server/>.

The V2 API is explicitly documented as beta. Installed generated declarations are evidence
of the draft protocol, not a stable contract. The generated class suffixes such as
`Session2` and `Session3` are name-collision artifacts; they are not evidence of three
session protocol versions.

## Executive finding

Polyth's canonical append-only session log, projection transactions, durable queue storage,
and browser WebSocket gap-fill are strong foundations. They protect browser delivery and
already-observed attention across reloads. They do not make the upstream OpenCode mutation
or event stream exactly once.

The present OpenCode client retries every transiently failing REST call, including every
mutation. Higher layers retry some complete mutation workflows again. A response-lost-after-
commit failure can therefore create sessions or forks more than once, submit a prompt twice,
answer a request more than once, or convert one prompt into both `prompt_async` and
`/message`. There are no finite REST deadlines, no ambiguous-outcome representation, no
authoritative pull reconciliation of status/permissions/questions, and no resumable SSE
cursor. Runtime restart destroys in-memory turn state without reconciling it.

These are confirmed defects in the current control flow, independently of how frequently a
particular OpenCode build exhibits a dropped response.

## Adversarial disposition

The original proposal did not pass the gate unchanged. The review disproved the following
implicit claims and incorporates their corrections:

1. **A stable operation ID is not idempotency.** It is only local correlation unless the
   selected endpoint accepts that exact field, durably indexes it, and specifies duplicate
   response/effect semantics. Unkeyed legacy mutations remain at-most-one-attempt and can
   remain permanently `unknown`.
2. **A stable event ID is not semantic deduplication.** SSE replay and history/pull can
   describe the same message part or tool transition with different transport event IDs.
   Recovery therefore uses persistent upstream entity/revision checkpoints shared by both
   channels, not only an event-ID set.
3. **A cursor is unsafe unless committed atomically.** Claiming an observation, appending
   every canonical event derived from it, updating entity checkpoints, and advancing the
   cursor must be one SQLite transaction. Generation is an ingestion fence, not a component
   of the dedup key.
4. **A snapshot is not automatically authoritative.** Absence closes attention or
   terminalizes a turn only when the protocol proves domain completeness and supplies
   causally comparable evidence. Partial or unversioned pulls may add identified facts but
   may not erase them.
5. **Endpoint URL is not service identity.** Every callback and pull is fenced by current
   endpoint generation, normalized location, backend session binding, and reconciliation
   request ordinal. Binding reuse across a generation requires protocol-proven authority
   continuity; otherwise it is rejected and re-established.
6. **Process ownership and config authority are different.** An owned SSH child is not made
   writable by the local config applier. A discovered or `Service.ensure()` endpoint is
   borrowed by default even if Polyth caused it to start; disposal never calls
   `Service.stop()` without an exclusive instance contract.
7. **Restart safety requires an admission barrier.** Config application waits for
   authoritatively safe-idle affected sessions. Its default timeout leaves configuration
   pending; it does not interrupt active tools or pending permission/question work.
8. **Promise serialization is not durable exclusion.** The current rejected-promise path
   does not poison `withSessionLock`, but an unbounded request can hold it forever and a
   restart erases it. Network deadlines guarantee liveness; durable operation/queue states
   carry exclusion across failures. Unknown operations do not retain in-memory locks.
9. **Multi-client determinism has a scope.** Competing replies use a durable compare-and-set;
   accepted mutations receive a transactional per-session ordinal. Multiple clients through
   one Polyth server are supported. Multiple Polyth server processes sharing one data
   directory remain unsupported and must be refused unless endpoint leadership is also made
   durable.
10. **V2 declarations are evidence, not facts about behavior.** Optional `durable` metadata,
    client-supplied IDs, cursor retention, snapshot consistency, workspace lifetime, and
    service ownership remain separate live-contract gates.

## Current architecture

### Composition and ownership

1. `packages/server/src/index.ts` is the composition root. Its runtime pool is keyed by
   `projectId::cwd`, lazily creates a local or SSH OpenCode runtime, retains one stable
   `AgentRuntime` facade per key, and keeps one global canonical-to-backend session map.
2. Local runtimes are created by `createOpenCodeRuntime` in
   `packages/backend-opencode/src/index.ts`. It selects a free port, reaps a cwd-keyed PID
   file, spawns `opencode serve` with the selected cwd, waits for a health-like endpoint,
   and owns termination.
3. SSH runtimes are created by `createRemoteOpenCodeRuntime` in
   `packages/backend-opencode/src/remote.ts`. It probes the binary, checks the remote path,
   starts `opencode serve` in that path, forwards one port, and owns the remote process and
   forward.
4. `packages/backend-opencode` is the only package that speaks the OpenCode process/API.
   It presents the provider-neutral `AgentRuntime` contract from
   `packages/contracts/src/index.ts`.
5. `createConfigApplier` in `packages/backend-opencode/src/config.ts` writes the local
   OpenCode config directory. `packages/server/src/opencodePending.ts` stages most writes
   and then asks the runtime pool to restart every live runtime.

Production runtime ownership is explicit in each endpoint lease. Owned local and SSH
leases expose exact-instance restart; borrowed shared/external leases expose no stop or
restart operation. Config authority is independent and only matching owned-local targets
are registered for local config restart.

### REST and SSE

- `createOpenCodeRuntime` and `createRemoteOpenCodeRuntime` construct one endpoint lease,
  then one lifecycle generation containing the generation's HTTP transport and negotiated
  protocol adapter.
- `createOpenCodeRuntimeFacade` requires that lifecycle. It owns canonical/backend mappings,
  event translation, and listeners, but all reads, SSE, and mutations delegate through the
  generation's protocol adapter. There is no `{ client }` runtime option or fixed-client
  runtime facade.
- Finite REST requests use the query/mutation split in `transport.ts`; generic mutation
  replay is disabled. SSE remains lifetime-cancelled rather than assigned a finite REST
  deadline.

### Canonical session path

- `createSessionService` in `packages/server/src/sessions.ts` serializes callbacks and
  mutations per canonical session with `withSessionLock`.
- `appendAndBroadcast` appends before broadcasting. `onRuntimeEvent` converts normalized
  runtime events to durable session events and then updates projections.
- `admitTurnCore` appends `user/message` before `AgentRuntime.startTurn`, satisfying the
  model-visible-before-display invariant. It appends `turn/failed` on any thrown runtime
  error.
- `ensureWired` resolves the project/worktree cwd, acquires a runtime, calls
  `ensureSession`, and wires the runtime listener. It does not pull upstream status,
  pending requests, durable events, or message deltas.
- `replyPermission` and `replyQuestion` validate against open requests derived from the
  durable log, append the local resolution, and only then call OpenCode.
- `fork` prepares and verifies the backend branch before publishing the copied canonical
  log, projection, and lineage marker. `rewind` itself is a soft append-only marker; a
  replacement send creates an exact backend branch first.

### Durable storage and browser delivery

- `packages/session/src/index.ts` uses SQLite WAL. `append` allocates per-session sequence
  numbers under `BEGIN IMMEDIATE`. The `attention_open` index is updated in the same
  transaction as attention events.
- `publishChildSession` atomically writes copied events, a child projection, and the fork
  marker. `patchProjection` transactionally reads and updates the latest projection.
- The queue table is durable, but dispatch uses destructive `queueShift` before upstream
  admission is known.
- `effectiveHistory`, `activeRewind`, and `deriveMessages` provide one append-only
  interpretation of rewind and model history.
- `packages/server/src/ws.ts` performs canonical-log gap-fill before live delivery,
  buffers events that arrive during the gap-fill, and deduplicates by canonical sequence.
  This closes the browser WebSocket race only; it cannot recover an OpenCode SSE event that
  Polyth never persisted.

### Permissions and questions

- `packages/permissions/src/index.ts` owns policy only: fail-closed rule evaluation,
  user/project/session-scoped allow rules, and per-session auto-accept settings.
- `packages/server/src/sessions.ts` owns durable request cards, response validation,
  auto-response, notification, and projection status.
- Open requests already observed by Polyth survive browser reload and Polyth restart in the
  event log and `attention_open`. There is no OpenCode pull/reconciliation path for a request
  missed while SSE was disconnected.

## Finding classification

### Confirmed bugs

1. **All mutations are generically retried.**
   `request` in `packages/backend-opencode/src/client.ts` applies the same three attempts to
   `get`, `post`, and `del`. The test
   `REST request retries transient socket failures then succeeds` in
   `packages/backend-opencode/test/client.test.ts` explicitly proves three executions of
   `POST /session`.
2. **Prompt fallback can submit one logical prompt through two endpoints.**
   `startTurn` in `packages/backend-opencode/src/index.ts` catches every failure from
   `prompt_async` and calls `/message`; it does not distinguish unsupported endpoint,
   rejection, timeout, or response lost after acceptance.
3. **Some mutation workflows are retried twice at different layers.**
   `reviving` in `packages/server/src/index.ts` retries `ensureSession`, `resetSession`, and
   `branchSession` after respawning. Each underlying REST mutation already has three client
   attempts, and `branchSession` can be replayed after a later verification read fails.
4. **REST calls have no finite deadline.**
   `requestOnce` in `packages/backend-opencode/src/client.ts` passes no signal to `fetch`.
   This applies to health probes, catalog reads, session create/list/history, prompt,
   steering, fork, deletion, abort, permission reply, and question reply/reject. A hung
   probe also defeats the outer wall clock in `waitReady`.
5. **Mutation outcomes are represented as success or failure only.**
   There is no accepted/rejected/unknown result in `OpenCodeClient`, `AgentRuntime`, or the
   session orchestration contracts. Transport loss is treated as permission to retry or as
   definitive failure.
6. **Attention is closed locally before the upstream response is confirmed.**
   `replyPermission`, `replyQuestion`, and `dismissPendingRequests` in
   `packages/server/src/sessions.ts` append `permission/resolved` or
   `question/answered` before the OpenCode mutation. `dismissPendingRequests` additionally
   suppresses all reply errors. A failed/ambiguous call permanently closes the local card
   even if OpenCode still waits.
7. **Queued input is deleted before admission.**
   `dispatchQueue` calls destructive `queueShift`, appends `queue/dispatched`, and only then
   calls `admitTurn`. A definite pre-accept failure loses the queue row; an ambiguous failure
   can leave both a `turn/failed` locally and a running upstream prompt. The happy-path
   restart test in `packages/server/test/delivery.test.ts` does not cover this boundary.
8. **Create can leave an untracked accepted backend session.**
   `create` in `packages/server/src/sessions.ts` calls `rt.ensureSession` before writing the
   canonical projection or `session/created`. If the backend accepts and its response is
   lost, no durable Polyth identity records the operation or resulting backend session.
9. **SSE reconnect is not missed-event recovery.**
   `connectSse` reconnects to `/event` without a cursor. `seenEventIds` and all translation
   state are memory-only. Events emitted while disconnected are absent from the canonical
   log, and replay after a Polyth restart can duplicate previously persisted output.
10. **No authoritative reconciliation exists.**
    The adapter does not pull OpenCode session status, pending permission state, pending
    question state, or a durable event/history cursor in `ensureWired`, after SSE reconnect,
    or after an ambiguous mutation.
11. **Restart can strand active sessions and pending attention.**
    `respawnOnce` in `packages/server/src/index.ts` disposes one runtime and swaps in a new
    one. Adapter `activeTurn`, translation state, and SSE dedup state disappear. The session
    service's `lastTurnId` can remain set without a future `turn/stopped`, blocking the
    queue. A crash detected only by SSE causes reconnect attempts to the same dead URL and
    does not notify the pool.
12. **A dead runtime can remain on the mutation path.**
    The facade applies respawn recovery to read methods, `ensureSession`, `resetSession`,
    and `branchSession`, but not `startTurn`, abort, or replies. Once a session is wired,
    `ensureWired` returns it without probing. Repeated sends can continue to target a dead
    inner runtime until an unrelated reviving operation replaces it.
13. **History import permanently marks transient failure as complete.**
    `events` in `packages/server/src/sessions.ts` appends `session/history-imported` in a
    `finally` block even when `rt.history` fails. Later opens therefore never retry the
    missing history.
14. **Configured Basic-auth usernames other than `opencode` fail.**
    `authHeaders` in `packages/backend-opencode/src/client.ts` hardcodes
    `opencode:<password>`. OpenCode's server documentation supports
    `OPENCODE_SERVER_USERNAME`; Polyth ignores it.
15. **MCP boot seeding can destroy unsupported/unknown OpenCode configuration.**
    `mcpEntriesFromBackendConfig` in `packages/server/src/mcp.ts` narrows each entry to
    known fields and skips unsupported shapes. During boot, `packages/server/src/index.ts`
    calls `mcp.create` for each parsed entry before staging is enabled. Each create invokes
    `applyAll`, while `applyMcp` in `packages/backend-opencode/src/config.ts` replaces the
    entire `mcp` block. Unknown entry fields, unsupported entries, and disabled entries can
    therefore be removed merely by starting Polyth with an empty Polyth MCP store.
16. **Local config application restarts unrelated SSH runtimes.**
    `createConfigApplier()` in `packages/server/src/index.ts` targets the local user's
    default OpenCode config, while `applyAndRestart` calls `runtimes.restartAll()`. The pool
    includes remote runtimes, so a local config change kills/restarts remote OpenCode
    processes even though their config was not changed.
17. **Hard-deleted canonical sessions can be rediscovered after restart.**
    `delete` in `packages/server/src/sessions.ts` unwires the session, suppresses abort
    failure, and calls `store.deleteSession`; it does not confirm backend deletion or retain
    a durable tombstone for the backend binding. The in-memory `sessionIdMap` can hide the
    orphan only until process restart, after which backend-session sync can offer the stale
    session for adoption again.

### Likely bugs and material risks

1. `reapOrphan` in `packages/backend-opencode/src/index.ts` trusts a stale numeric PID and
   sends `SIGKILL` without validating process identity or start time. PID reuse can kill an
   unrelated process. The remote shell in `packages/backend-opencode/src/remote.ts` has the
   same stale-PID trust.
2. Local free-port selection closes the temporary listener before OpenCode binds and has no
   local collision retry. `remote.ts` does retry recognized remote collisions.
3. The global `sessionIdMap` in `packages/server/src/index.ts` does not bind a backend ID to
   endpoint identity, endpoint generation, protocol, directory, or workspace. Reattachment
   can silently use a stale ID against a replacement/external endpoint; independent
   endpoints that reuse IDs are not representable safely.
4. Persisted `working`/`waiting` is deliberately not considered live by `assertMutable` in
   `packages/server/src/sessions.ts`. Without reconciliation, post-restart queue dispatch,
   fork, or rewind can act while upstream state is unknown.
5. Remote authentication is ambient and unspecified. The remote serve command does not
   establish a per-endpoint credential contract; the local client reads local
   `OPENCODE_SERVER_PASSWORD` and hardcodes the username. A separately configured remote
   server cannot be joined reliably.
6. `replyQuestion` validates that a canonical session has a backend mapping, but the legacy
   endpoint is request-global (`/question/{requestID}/...`). Correctness therefore depends
   on request IDs being globally unique within the directory-scoped process.
7. Config files are semantically merged but rewritten as strict formatted JSON, losing
   JSONC comments and formatting. This is not data-field loss, but it is avoidable churn in
   a user-owned file.
8. An event-ID-only dedup index would still duplicate model output when SSE and history
   expose different event envelopes for the same message part/tool state. Translation
   checkpoints are currently memory-only and completed tool updates are not intrinsically
   one-shot.
9. Keying observations by endpoint generation would replay all known events after URL/auth
   rotation. Omitting generation fencing would instead allow a late callback from the old
   endpoint to append stale status or close newer attention. Dedup identity and ingestion
   fencing must therefore be separate.
10. A pending-list response cannot prove that a request was answered unless the list is
    complete and causally newer than the request/reply. The generated V2 shapes alone do not
    establish either property; legacy list consistency is also unspecified.
11. The current session promise chain recovers after rejection, so ordinary thrown failures
    do not permanently poison it. A fetch with no deadline can nevertheless hold the chain
    forever. Any future reconcile/restart barrier can introduce the same failure if its
    release is not in `finally`.
12. SQLite sequence allocation gives a canonical order after append, but it does not elect
    one OpenCode endpoint owner across multiple Polyth processes. Sharing one data directory
    between server processes can therefore double-submit despite transactional event
    sequencing.

### Already-safe behavior

1. Model-visible runtime output is appended before broadcast in
   `appendAndBroadcast`/`onRuntimeEvent`.
2. Browser reconnect uses the durable canonical sequence and buffers the gap-fill race in
   `packages/server/src/ws.ts`.
3. SQLite event sequence allocation, attention indexing, projection patching, queue
   reordering, deletion, and child fork publication use transactions in
   `packages/session/src/index.ts`.
4. Per-session mutation/callback serialization in `withSessionLock` prevents local
   fork/rewind/admission races. It does not deduplicate network mutations.
5. Backend fork output is read back and compared to the exact normalized canonical prefix
   before mapping publication. Failed canonical publication discards the known branch on a
   best-effort basis.
6. Ordinary config operations in `packages/backend-opencode/src/config.ts` parse JSONC,
   refuse corrupt/non-object input, write by atomic rename, and preserve unrelated top-level
   keys. Provider visibility preserves unrelated provider properties such as API settings,
   model reasoning/modalities/limits/variants, and future sibling fields because it only
   overlays `blacklist`. Agent edits preserve unowned fields in each agent object.
7. HTTP status errors are not retried by the current client. Read-only transient retry is
   reasonable in principle.
8. SSE is correctly treated as a long-lived stream with a lifetime abort, not a finite REST
   request deadline.
9. Current local and SSH runtime construction use the selected project/worktree directory
   as both process cwd and the implicit request `directory`. Attachment paths are resolved
   and constrained to that same runtime cwd.
10. Already-observed permissions/questions survive browser reload, Polyth restart, and a
    second client because they are durable and replies are session-serialized.

## Failure classes A-J

### A. Unsafe mutation retry

The exact retry surface is:

| Logical operation | OpenCode call | Current automatic replay |
| --- | --- | --- |
| Create/adopt-reset session | `POST /session` in `ensureSession`, `resetSession`, and empty-prefix `branchSession` | Up to 3 client attempts; up to 6 when wrapped by facade `reviving` |
| Fork | `POST /session/{id}/fork` in `branchSession` | Up to 3 attempts; the entire read/fork/read-verify workflow can run again after facade respawn |
| Submit prompt | `POST .../prompt_async`, fallback `POST .../message` in `startTurn` | Up to 3 attempts per endpoint, then fallback on any error: up to 6 sends across two semantics |
| Steer | `POST .../prompt_async` in `steer` | Up to 3 attempts; a thrown final result is converted to `false`, so the server may then queue the already-accepted text |
| Abort | `POST .../abort` | Up to 3 attempts |
| Permission reply | `POST .../permissions/{requestId}` | Up to 3 attempts |
| Question reply/reject | `POST /question/{requestId}/reply|reject` | Up to 3 attempts |
| Delete/discard | `DELETE /session/{id}` | Up to 3 attempts, with errors suppressed by callers |
| Config application | Atomic filesystem writes, not REST | No generic transport retry; a failed restart leaves tasks queued, so a later user apply repeats semantically idempotent writes |

The method-agnostic policy is in `request` in
`packages/backend-opencode/src/client.ts`. Whole-operation replay is in `reviving` in
`packages/server/src/index.ts`. Per-session locks do not alter this table.

Required correction: only retry queries automatically. The same logical mutation may be
replayed only when the selected protocol provides a verified idempotency key with specified
duplicate semantics. If authoritative reconciliation proves `not-applied`, the old operation
is terminal; a fresh attempt requires a new user-authorized operation rather than an
automatic retry hidden in transport or lifecycle code. Prompt endpoint selection comes from
read-only negotiation or a pinned contract. A contract-classified unsupported response may
change the choice for a future operation, never fall through and submit the current prompt
elsewhere.

### B. Ambiguous outcome

`fetch failed`, `ECONNRESET`, a terminated response body, and a request deadline can occur
after OpenCode commits. Current code cannot represent that state:

- create loses the backend identity and can create another session;
- fork can create an unknown orphan and create another branch;
- prompt can run twice or run once while Polyth appends `turn/failed`;
- steer can be accepted and then queued as fallback;
- replies can be accepted while the generic retry sends them again, or remain pending while
  Polyth records them resolved;
- queue dispatch deletes the only retryable queue item before admission is confirmed.

The durable user message is valuable evidence of intent, but intent is not an upstream
admission receipt. The corrected durable state machine is:

```text
prepared -> executing -> confirmed | rejected | unknown
unknown -> confirmed | not-applied
```

The transition to `executing` is the transactional single-executor claim and is committed
before network I/O. A crash in `executing` recovers as `unknown`, even if the request may not
have sent a byte. `rejected` requires a complete protocol response whose operation-specific
contract proves no effect; a generic HTTP 5xx is not rejection. `not-applied` requires an
exhaustive operation lookup or complete causally-newer evidence whose contract proves
absence; message/history similarity is insufficient. An unkeyed `unknown` is not replayed.
The only additional transition is `unknown -> executing` for a same-ID replay whose
operation-specific pinned contract proves one effect.

### C. OpenCode V2

#### Known

- The installed SDK `1.18.18` exports `./v2`. Its generated
  `V2SessionCreateData` accepts an optional client `id` and a
  `LocationRef { directory, workspaceID? }`.
- `V2SessionPromptData` accepts an optional client `id` and returns
  `SessionInputAdmitted` containing `admittedSeq`, prompt ID, session ID, and delivery.
- V2 generated endpoints include per-session status/active state, history with numeric
  `after`, per-session events with opaque string `after`, cursor-paginated messages,
  per-session pending permission list/get/reply, and per-session pending question
  list/reply/reject.
- Many generated V2 event shapes include optional durable
  aggregate-identity/sequence/version fields. Optionality matters: an event without that
  metadata is not durably replayable merely because sibling variants have it.
- The beta V2 client documentation describes a discoverable local background service:
  `Service.discover()`, `Service.ensure()`, endpoint-provided
  `Service.headers(endpoint)`, and `Service.stop()` for the exact registered instance.
  It also permits a fully external `baseUrl` and headers.
- The V2 source's location service map is keyed by location and builds location-scoped
  services. This is consistent with one global HTTP service hosting multiple directory/
  workspace graphs rather than one HTTP process per cwd.
- The installed `opencode 1.18.18 serve --help` exposes ordinary host/port/mDNS options but
  not the beta documentation's `serve --service`. The stable server and V2 beta service
  cannot be treated as one capability set.

#### Assumed, not yet safe to depend on

- A service returned by `Service.ensure()` can be shared by other OpenCode clients.
- Starting a service does not imply Polyth has exclusive ownership or may restart it for a
  Polyth config change.
- Endpoint URL and endpoint-provided credentials can rotate when service election changes.
- `directory` plus `workspaceID` is the authoritative V2 isolation key.

These assumptions are deliberately conservative. They prevent data loss if a shared
service is in use, but must be confirmed against the selected beta release.

#### Must be capability-detected or contract-tested

- protocol/version negotiation and legacy/V2 coexistence;
- whether client-supplied session and prompt IDs are idempotency keys, and exact duplicate
  response semantics;
- event/history cursor retention, replay inclusivity, cursor-invalid behavior, and whether
  each returned item has durable identity;
- whether status/history/pending pulls are complete and causally comparable with mutation
  responses and stream events;
- endpoint credential rotation and refresh;
- stable service/authority identity across discovery and endpoint rotation;
- whether Polyth may update config or stop an ensured service (default: neither);
- workspace ID lifecycle and directory canonicalization;
- fork/revert semantics, attachment URI semantics, and status terminal states; and
- whether external/remote endpoints expose all required pull APIs.

### D. Pending requests

The canonical log is durable after Polyth sees a request. `attention_open`, WebSocket
gap-fill, session-bound validation, and `withSessionLock` make browser reload, second-device
reply, and local duplicate-click handling safe.

The upstream boundary is not durable:

- SSE has no replay cursor;
- `ensureWired` does no pending pull;
- replies close local state before upstream confirmation;
- restart loses adapter state;
- auto-accept and dismiss paths can suppress failed replies.

The backend can be authoritative for *whether a request is currently actionable* only when
the selected pending snapshot is contract-tested as complete and causally comparable.
Reconciliation may always union newly discovered, stably identified requests into the
append-only log. It may confirm resolution by a receipt or by absence only from a complete,
causally-newer snapshot. A partial/unversioned absence leaves the local request open but
uncertain. It must never silently synthesize an answer. Competing clients choose one
response intent with a durable compare-and-set before external action. Confirmed rejection
or `not-applied` records the failed intent and makes the request actionable again; unknown
keeps it open but disables a conflicting response.

### E. Restart lifecycle

- Local and remote runtimes are owned and killed on disposal.
- Config apply restarts all live runtimes concurrently without quiescing active turns or
  recording a restart boundary.
- A post-ready child exit is not surfaced to the pool. SSE reconnect continues against the
  old URL.
- A deliberate respawn preserves the stable facade/listeners and global ID map, but resets
  adapter turn, translation, and dedup state.
- No path reconciles a process disappearing during a tool call or pending request.
- Shared/external ownership, endpoint rotation, and stop prohibition are not modeled.

An endpoint lease with explicit generation and lifecycle ownership is required. Owned
restart must fence affected sessions, wait for authoritative safe-idle by default, replace
the endpoint generation, reattach, and reconcile before accepting more work. Timeout leaves
the restart/config change pending rather than killing active or waiting work. Shared,
ensured, and external reconnect must rediscover without kill/restart.

### F. Finite REST request deadlines

Every finite OpenCode REST request made through `get`, `post`, or `del` lacks an explicit
deadline. The affected call sites are `waitReady`, `models`, `agents`, `sessions`,
`history`, `ensureSession`, `resetSession`, every branch create/fork/readback/delete,
`startTurn`, `steer`, `abort`, `replyPermission`, and `replyQuestion` in
`packages/backend-opencode/src/index.ts`.

Deadlines belong in the transport and must include response-body consumption. Deadline
expiry on a query can be retried within a bounded overall budget. Deadline expiry on a
mutation is an ambiguous outcome unless the transport proves no bytes were sent. SSE must
remain deadline-free and use only a lifetime/cancellation signal plus heartbeat/liveness
policy.

SSH command probes already have explicit timeouts and remote listen has a timer, but remote
`host.start`, `host.forward`, and process cleanup do not have an explicit orchestration
deadline at this layer.

### G. State recovery

The projection records `idle`, `working`, `waiting`, `failed`, and other UI states, while
actual turn identity (`lastTurnId`/`admitting`) is memory-only. After restart, code treats a
persisted working projection as stale but does not ask OpenCode whether the session is
running, idle, failed, interrupted, or waiting. Consequences include premature queue
dispatch, indefinite working/waiting status, no terminal event for an incomplete turn, and
unsafe mutation eligibility.

Recovery must fold accepted runtime evidence into new canonical events, never overwrite a
projection from an arbitrary snapshot. Every snapshot is tagged with authority, endpoint
generation, location/session binding, reconciliation request ordinal, domain completeness,
and a comparable watermark when available. Older, mismatched, or superseded evidence is
discarded before translation. If the protocol cannot prove a terminal state, Polyth must
expose `unknown`/`reconciling` rather than claim failed, interrupted, completed, or idle.

Recovered model output needs stronger handling than event-ID deduplication. SSE and history
must normalize to the same persistent message/part/tool entity key. A full text snapshot may
append only a proven suffix of the stored full-value checkpoint; tool transitions use stable
call identity and monotonic state rank, and each terminal rank emits once. Divergent text,
a changed payload at an already-emitted terminal rank, or unidentified artifacts produce
uncertainty, not another message/tool event.

Hard deletion needs durable negative state outside the deleted session log. A tombstone must
retain canonical ID, full endpoint/location/backend binding, and delete-operation outcome.
Session listing/import/reconciliation rejects a tombstoned binding. An unknown upstream
delete keeps the tombstone indefinitely (or until explicit user purge policy), so a Polyth
restart cannot reinterpret stale backend state as a new adoptable session.

### H. Config safety

Most config overlays are already semantically safe:

- corrupt config is not overwritten;
- unknown top-level keys survive;
- provider entries preserve all fields except the owned `blacklist`;
- agent entries preserve all fields except the explicitly owned mode/prompt/model fields;
- plugins preserve tuple options through normal merge/remove operations.

The exception is the complete `mcp` replacement and boot-seeding loop described in confirmed
bug 15. Future-proof config handling must preserve opaque unsupported entries and unowned
fields at every nested level, including reasoning, modalities, limits, variants, provider
extensions, agent extensions, and MCP extensions. Merely retaining top-level keys is not
enough. A read-only import/seed must never write the source config.

### I. Runtime authentication assumptions

Current assumptions are:

- one URL fixed for the lifetime of a client;
- Basic auth only;
- password comes from the Polyth process's `OPENCODE_SERVER_PASSWORD`;
- username is always `opencode`;
- the same ambient credential logic applies to local and forwarded remote URLs; and
- endpoint ownership and authentication are unrelated values.

Stable OpenCode already permits `OPENCODE_SERVER_USERNAME`. V2 beta adds endpoint-provided
headers and external bearer-header examples. Authentication must therefore be resolved with
the endpoint lease and refreshed when endpoint generation changes. Persistent/public config
may contain environment-variable names or credential-provider references only, never secret
values.

### J. Directory/worktree isolation

Already correct for the current owned legacy mode:

- the pool key includes resolved project/worktree cwd;
- local spawn uses that cwd;
- remote spawn `cd`s to `remotePath`;
- both clients append the selected directory to all REST and SSE calls;
- session creation and lookup use the runtime selected for the session projection;
- permissions and questions use the mapped session's runtime;
- file attachment URIs are constrained to the same cwd; and
- server-side session creation validates a requested worktree against the project inventory.

Remaining gaps:

- location is implicit client state rather than an explicit per-call value that can be
  asserted in tests;
- mappings do not include endpoint/location identity;
- V2 `workspaceID` is unrepresented;
- adopted backend sessions are not validated against persisted endpoint/location identity;
- config is process/user-global, not tied to the affected runtime location; and
- local config restart crosses into unrelated remote locations.

Every normalized session binding must carry an immutable authoritative location. A protocol
adapter must encode that location exactly once per call and reject a session/location
mismatch before network I/O.

## Proposed small compatibility boundary

Keep `AgentRuntime` as the provider-neutral server seam. Add a small OpenCode-internal
boundary under `packages/backend-opencode`; do not expose generated SDK types to
`packages/server`.

```ts
export type RuntimeControl =
  | {
      kind: "owned";
      instanceToken: string;
    }
  | {
      kind: "borrowed";
      source: "shared" | "external";
    };

export type RuntimeConfigAuthority =
  | { kind: "read-only" }
  | { kind: "writable"; targetId: string };

export type RuntimeAuthentication =
  | { kind: "none" }
  | {
      kind: "basic-env";
      usernameEnv: "OPENCODE_SERVER_USERNAME";
      passwordEnv: "OPENCODE_SERVER_PASSWORD";
    }
  | { kind: "endpoint-headers"; resolve: () => Promise<Record<string, string>> };

export interface RuntimeLocation {
  directory: string;
  workspace?: string;
}

export interface RuntimeEndpoint {
  authorityId: string;
  continuity: "verified" | "generation-only";
  generation: number;
  url: string;
  location: RuntimeLocation;
  control: RuntimeControl;
  config: RuntimeConfigAuthority;
  authentication: RuntimeAuthentication;
}

export interface BaseRuntimeEndpointLease {
  endpoint(): Promise<RuntimeEndpoint>;
  refresh(reason: "connect" | "disconnect" | "unauthorized"): Promise<RuntimeEndpoint>;
  dispose(): Promise<void>;
}

export interface OwnedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "owned"; instanceToken: string };
  restart(reason: "crash" | "config" | "manual"): Promise<RuntimeEndpoint>;
}

export interface BorrowedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "borrowed"; source: "shared" | "external" };
}

export type RuntimeEndpointLease =
  | OwnedRuntimeEndpointLease
  | BorrowedRuntimeEndpointLease;
```

`RuntimeEndpointLease` is the process-ownership boundary. Only the owned variant exposes
`restart`, and its instance token must identify the exact child/forward being stopped.
Borrowed `dispose` releases Polyth resources and never calls service stop. Config authority
is deliberately separate: an owned SSH process, for example, is not a target of the local
config file. `authorityId` is protocol-proven service identity when continuity is
`verified`; a `generation-only` endpoint cannot reuse a backend binding after generation
change.

```ts
export type MutationOutcome<T> =
  | { kind: "confirmed"; value: T; receipt?: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; operationId: string; message: string };

export type MutationTransportResult<T> =
  | {
      kind: "response";
      status: number;
      headers: Readonly<Record<string, string>>;
      body: T;
    }
  | { kind: "unknown"; operationId: string; message: string };

export type ReplayPolicy =
  | { kind: "never" }
  | { kind: "same-operation-id"; contract: string };

export interface OpenCodeTransport {
  query<T>(request: {
    method: "GET" | "HEAD";
    path: string;
    deadlineMs: number;
  }): Promise<T>;
  mutate<T>(request: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    operationId: string;
    deadlineMs: number;
    replay: ReplayPolicy;
  }): Promise<MutationTransportResult<T>>;
  stream(request: {
    path: string;
    after?: string;
    signal: AbortSignal;
    onEvent(event: unknown): void;
  }): Promise<void>;
}
```

The split between `query`, `mutate`, and `stream` makes an unsafe generic retry difficult to
express. `stream` has no deadline field. The protocol adapter may supply
`same-operation-id` only from a pinned operation-specific contract; the existence of an
`id` field is insufficient. Transport never turns an HTTP status into `rejected`; the
protocol adapter maps a complete response to confirmed/rejected/unknown using its
operation-specific contract. An unclassified 5xx remains unknown.

```ts
export interface RuntimeSnapshot {
  authorityId: string;
  generation: number;
  reconciliationOrdinal: number;
  state: {
    value: "running" | "idle" | "failed" | "interrupted" | "unknown";
    watermark?: string;
  };
  completeness: {
    events: "complete" | "partial" | "unverifiable";
    permissions: "complete" | "partial" | "unverifiable";
    questions: "complete" | "partial" | "unverifiable";
  };
  cursorAfter?: string;
  permissions: Array<{
    requestId: string;
    permission: string;
    patterns: string[];
  }>;
  questions: Array<{
    requestId: string;
    questions: JsonObject[];
  }>;
  events: Array<{
    entityKey: string;
    revision: string;
    event: RuntimeEvent;
  }>;
}

export interface ProtocolAdapter {
  readonly protocol: "legacy" | "v2";
  capabilities(): Promise<{
    eventReplay: "none" | "contract-tested";
    pendingSnapshot: "none" | "partial" | "complete-causal";
    idempotentMutations: ReadonlySet<RuntimeMutationKind>;
  }>;
  ensureSession(input: RuntimeSessionBinding, operationId: string):
    Promise<MutationOutcome<{ backendSessionId: string }>>;
  submit(input: RuntimeTurnBinding, operationId: string):
    Promise<MutationOutcome<{ admissionId?: string }>>;
  reconcile(input: RuntimeSessionBinding, after?: string): Promise<RuntimeSnapshot>;
}
```

The full adapter will also normalize catalog, branch, abort, and reply operations, but they
must follow the same outcome type rather than create one interface per endpoint.
`RuntimeSessionBinding` must include canonical ID, backend ID when known, endpoint identity,
endpoint generation, continuity classification, and `RuntimeLocation`.

`RuntimeSnapshot` is evidence, not a desired-state overwrite. The session service accepts it
only for the current binding/generation and latest reconciliation ordinal. Absence is
destructive evidence only for a `complete-causal` domain with a comparable watermark.
Observation/entity claims, emitted canonical event batches, persistent part/tool
checkpoints, and `cursorAfter` advancement are one storage transaction. SSE and pull paths
must produce the same `entityKey`; transport event ID alone is not enough.

Suggested homes:

- `packages/backend-opencode/src/endpoint.ts`: endpoint, auth, ownership, leases, and
  owned-local/owned-SSH/borrowed-shared/borrowed-external providers plus independent config
  authority;
- `packages/backend-opencode/src/transport.ts`: query/mutation/SSE semantics and deadlines;
- `packages/backend-opencode/src/protocol.ts`: normalized protocol and reconciliation types;
- `packages/backend-opencode/src/protocolLegacy.ts`: current endpoint shapes;
- `packages/backend-opencode/src/protocolV2.ts`: capability-gated beta V2 shapes;
- `packages/backend-opencode/src/runtime.ts`: `AgentRuntime` composition over a lease,
  transport, and protocol adapter; and
- `packages/contracts/src/index.ts`: only provider-neutral additions needed by the session
  service, such as normalized reconciliation and uncertain-operation states.

This is intentionally not a general plugin framework. Three roles—endpoint lease, transport,
and protocol adapter—are sufficient. Lease/control/auth/config and wire-response types stay
package-internal. `packages/server` sees only `AgentRuntime`, durable operation outcomes, and
the normalized evidence envelope; it cannot stop a process, select an endpoint path, inspect
credentials, or branch on `legacy` versus `v2`.

## Required invariants

`INVARIANTS.md` is the normative, testable list. The approval-critical summary is:

1. A mutation is durably identified and claimed before I/O; generic transport never replays
   it, and an unkeyed unknown operation can remain unresolved.
2. Rejection, non-admission, and completion require positive protocol evidence with the
   exact state transitions defined in `INVARIANTS.md`.
3. Attention response winners and queue reservations are transactional, durable, and
   restart-safe; ambiguity does not close or delete them.
4. Endpoint generation/location/session/reconciliation fences reject stale evidence before
   translation. Endpoint generation is never used to make a replay look unique.
5. Cross-channel entity identity, canonical append batches, translator checkpoints, and
   cursor advancement are atomic. Unidentified recovery content is not appended.
6. Snapshot absence is destructive only for a complete, causally-newer domain; otherwise
   state remains unknown/reconciling.
7. Only an exact owned instance can restart. Shared/ensured/external disposal never stops the
   service, and config writability is a separate exact-target capability.
8. Active or waiting work is never killed by default for config application; admission
   reopens only after generation replacement and reconciliation.
9. Every finite request and every scheduler-held network operation has a deadline. Durable
   uncertainty, not an in-memory lock, blocks unsafe follow-up work.
10. Generated V2 DTOs terminate inside `packages/backend-opencode`; each behavioral
    capability is enabled independently only by pinned contract tests.
11. Model-visible facts are appended before display, canonical events remain immutable, and
    stale backend evidence never overwrites newer durable truth.
12. Multiple clients of one Polyth server are ordered durably. Multiple Polyth processes may
    not share one data directory without a separate durable endpoint-leadership design.

## Explicit non-goals

- Do not replace the append-only session log, projections, durable queue, session
  organization, worktrees, SSH transport, package/plugin seams, notification center, or
  current UI.
- Do not move OpenCode calls outside `packages/backend-opencode`.
- Do not expose SDK-generated OpenCode types through public REST responses.
- Do not redesign provider/model UX, permissions policy, question UI, or session history
  rendering.
- Do not claim complete V2 support from generated types alone.
- Do not make shared/external service restart a prerequisite for applying Polyth settings.
- Do not promise exactly-once behavior where the selected protocol offers neither a stable
  operation ID nor authoritative reconciliation; preserve and display uncertainty instead.

## Verifier findings

The final adversarial pass tested the implementation rather than treating the implementation
plan or a green suite as evidence. The following findings describe the tree as verified on
2026-08-27.

### Localized defects fixed during verification

1. **Idle first materialization skipped reconciliation.** `ensureWired` reconciled only when
   the persisted projection was working, waiting, reconciling, unknown, or had an unresolved
   operation. A stale persisted `idle` projection could therefore admit a mutation while the
   backend was running. First materialization now reconciles every runtime that exposes the
   reconciliation seam. The regression test starts with local idle/upstream running and
   proves that working state is restored before admission.
2. **Pending completeness was incorrectly treated as causal non-application proof.** A
   complete pending list containing a request does not by itself prove that an unknown reply
   was not applied. The normalized snapshot now carries explicit
   `nonAppliedOperations` evidence. Only a matching operation ID, mutation kind, session,
   optional backend binding, and response intent may settle `unknown -> not-applied`.
   Completeness without that evidence leaves the response intent and operation unknown.
3. **Snapshot cursor advanced before the complete snapshot event list was durable.** The
   first artifact previously advanced `cursorAfter`, so failure on a later artifact could
   permanently skip it. Cursor advancement now occurs with the last event observation (or a
   zero-event cursor observation). A deterministic injected failure on the second artifact
   proves that the cursor remains unchanged.
4. **Runtime observation uncertainty was dropped at the server ingestion seam.** Divergent
   content and changed terminal payload evidence now survive the `AgentRuntime` boundary as
   a durable `reconciliation/uncertainty-recorded` event.
5. **Ambiguous prompt admission was presented as a started turn.** The legacy facade now
   emits `turn/started` only after a confirmed mutation response; unknown admission remains
   unknown and does not create a false started fact.
6. **Concurrent idle sends could both pass the pre-lock idle check.** Admission now repeats
   active, projection, reconciliation, and durable-operation checks under the per-session
   lock and queues the loser.
7. **Scheduled reconciliations bypassed the session lock.** Unknown-outcome and lifecycle
   reconciliation triggers now enter the same per-session serialization as callbacks and
   mutations.
8. **A failed endpoint replacement could expose the stopped generation again.** Runtime
   lifecycle replacement clears the current generation before rebuilding; a later endpoint
   request performs a fresh recovery.
9. **Generic transport inherited ambient legacy credentials.** Environment-based legacy
   Basic auth is now a compatibility-client concern. Endpoint lifecycle transports receive
   only lease-resolved headers, and `authentication: none` no longer leaks
   `OPENCODE_SERVER_*` credentials.
10. **Opaque terminal revisions were treated as ordered.** Merely having a non-empty
    `revision` previously authorized legacy idle/failed/interrupted snapshots. Legacy status
    authority now requires a numeric revision with an explicit comparison domain and order.
    Equal same-state evidence is idempotent; older, cross-domain, or equal conflicting state
    evidence remains unknown and cannot replace the newer durable checkpoint.
11. **Unversioned SSE terminal events bypassed pull authority checks.** `session.idle` and
    `session.error` previously flushed output and emitted `turn/stopped` from state text
    alone. SSE terminalization now requires the same comparable evidence as pull
    reconciliation, and unversioned terminal observations do not erase an ordered status
    checkpoint.
12. **Fork causal evidence compared unrelated ordinal domains.** A fork operation's ordinal
    belongs to its source session. Comparing it numerically with child-session operation
    ordinals could let the old fork receipt prove the child idle after a child mutation.
    Any child mutation now invalidates that cross-session causal shortcut.
13. **One-shot and multirun issued an untracked compatibility ensure after durable create.**
    The confirmed operation-aware create already binds the backend session. The redundant
    `ensureSession` call was outside prepare/claim/settle and could mutate a generic runtime;
    both background paths now proceed directly to the durable turn operation.
14. **Confirmed create recovery could lose its backend binding.** First wiring recovered a
    missing projection binding only from an unknown create found in a backend listing. It now
    also restores the receipt from an already-confirmed create and records an exact recovered
    unknown operation as confirmed.

### Independent disposition of Agent L's eight closure claims

The following statuses describe the re-verified tree, including the localized corrections
above. A passing suite is not treated as architectural proof:

1. **Unified traffic ownership — resolved in the final cross-cutting pass.** Local, remote,
   and socket-backed test runtimes create the public facade over a lifecycle. Reads,
   mutations, reconciliation, and SSE borrow one atomic transport/protocol generation.
   Refresh aborts old streams before installing the replacement, and late callbacks are
   fenced before translation. Borrowed endpoint rotation rebinds HTTP and SSE without
   exposing a stop path. The fixed-client runtime export and `{ client }` constructor option
   are removed; `index.ts` no longer encodes legacy mutation paths.
2. **Durable generation and binding fences — resolved.** Projections persist the complete
   backend binding. Reconciliation gives live SSE a positive current request ordinal, and
   SQLite rejects mismatched authority, generation, location, backend session, and ordinal.
   A generation-only replacement cannot reuse an old backend session binding without
   verified continuity.
3. **Complete legacy protocol mutation surface — resolved in the final cross-cutting pass.**
   The lifecycle-backed legacy adapter
   owns reset, fork/revert, prompt, steer, abort, delete, permission reply, and question
   reply/reject and returns normalized outcomes. Lifecycle-backed compatibility methods
   delegate to those operations. The facade has no alternate HTTP implementation. V2 still
   returns `capability-unsupported` without fabricating V1 traffic; this closure does not
   claim V2 support.
4. **Durable one-shot and multirun mutations — resolved after Agent K correction.** Both
   entry points use the shared durable prepare/claim/settle helper for session creation and
   prompt admission. Stable task/run identity observes a prior confirmed or unknown
   operation and cannot redispatch it after response loss. No post-create compatibility
   mutation runs outside that state machine.
5. **Atomic config restart admission — resolved.** One
   reader/exclusive admission barrier spans generation capture, `canRestart()`, every config
   write, generation replacement, and post-replacement reconciliation. Only exact owned
   local targets are registered as config-restartable. Before any write, every affected
   persisted binding is reconciled against its captured authority/generation; stale,
   unavailable, changed, busy, waiting, or non-comparable evidence defers the batch.
   `OwnedRuntimeLifecycle.withConfigRestart()` now serializes natural refreshes and all
   other generation installations against that complete critical section. A replacement
   already in flight finishes before capture; a replacement requested after capture queues
   until the lock-owned restart has loaded the applied config and reconciliation completes.
   Runtime creation is fenced and pre-fence pool promises are awaited before lifecycle
   locks are acquired. Unexpected generation drift fails closed and retains the pending
   batch instead of inferring loaded config from generation inequality.
6. **Whole-snapshot transaction — resolved.** Every normalized artifact observation,
   canonical batch, checkpoint, and final cursor update for one snapshot executes in one
   SQLite transaction. Projection repair is sequence-idempotent, so replayed observations
   cannot regress or double-apply side effects.
7. **First-wire reconciliation — resolved.** Managed newly created, forked, imported, and
   lazily materialized sessions enter the same reconciliation barrier. Persisted history
   baselines let copied fork history be claimed without duplicate canonical output and let
   imported history receive its completion marker only after successful reconciliation.
8. **Legacy terminal-state authority — resolved after Agent K correction.** Busy state
   remains positive evidence, while idle, failed, and interrupted require an explicit
   comparable protocol revision. Unversioned terminal snapshots remain `unknown`; the sole
   fresh-session idle watermark is bound to the confirmed create operation rather than
   synthesized from a state string.

The fixed-client and config-restart P0 gaps from Agent K's disposition are closed. The beta
V2 contract gates and the multi-process leadership non-goal remain unchanged.

## Final implementation status

| Concern | Verified status |
| --- | --- |
| Query/mutation transport split, finite REST deadlines, no generic POST/DELETE replay | Landed and fault-tested |
| Durable operation states, response-intent CAS, queue reservation, deletion tombstone | Landed for canonical and background one-shot/multirun paths |
| Legacy create/prompt unknown outcome and exact-receipt reconciliation | Landed |
| Semantic SSE/pull observation identity and atomic ingestion | Landed for each observation and the complete normalized snapshot |
| Reconcile after disconnect and every first materialization | Landed for lazy, create, fork, and import paths |
| Exact owned child/SSH stop and borrowed lease no-stop behavior | Landed at the lease/lifecycle layer |
| Runtime endpoint rotation/rebind and stale stream fencing through the public facade | Landed and tested with two active sessions |
| Safe-idle config restart | Landed: admission, runtime creation, and lifecycle generation installation are fenced through safety, writes, one owned restart, and reconciliation; unexpected drift keeps the batch pending |
| Legacy mutation adapter coverage | Landed: one lifecycle facade delegates all traffic to the generation's protocol adapter; the fixed-client runtime path is removed |
| V2 mutation, replay, cursor, pending completeness, status, workspace, and shared-service continuity | Capability-gated/disabled; no live contract was pinned |
| Response-loss handling | Generic one-attempt mutation ambiguity, canonical create/prompt, one-shot, and multirun are fault-tested; V2 operation-specific replay remains disabled |

The deterministic failure inventory and exact test names are in `FAILURE-MATRIX.md`.
