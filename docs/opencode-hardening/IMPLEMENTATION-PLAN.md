# OpenCode compatibility and reliability implementation plan

Status: implementation sequencing for the architecture **APPROVED FOR IMPLEMENTATION** in
`ARCHITECTURE-AUDIT.md`. V2 support itself remains capability-gated.

`INVARIANTS.md` is normative. Phase exit gates may strengthen those invariants but may not
weaken or defer them.

## Objectives

1. Stop unsafe mutation replay immediately.
2. Represent ambiguous upstream outcomes without lying or losing durable intent.
3. Keep protocol, endpoint control, config authority, authentication, and location
   orthogonal so legacy/V2 can use owned or borrowed endpoints without leaking SDK details
   upward.
4. Reconcile status, durable events, permissions, and questions after disconnect/restart.
5. Apply finite deadlines to finite requests while keeping SSE long-lived.
6. Preserve unknown OpenCode configuration and never restart a runtime Polyth does not own.

The existing append-only log, projections, queue, session organization, worktrees, SSH
transport, plugins, notification center, and UI remain in place.

## Audit ledger

### Confirmed bugs to fix

- `packages/backend-opencode/src/client.ts`: `request` retries `POST` and `DELETE` exactly
  like `GET`; its test explicitly retries `POST /session` three times.
- `packages/backend-opencode/src/index.ts`: `startTurn` falls back from `prompt_async` to
  `/message` after any error, including an ambiguous response loss.
- `packages/server/src/index.ts`: `reviving` replays `ensureSession`, `resetSession`, and the
  complete `branchSession` workflow after respawn.
- `packages/backend-opencode/src/client.ts`: no finite REST call has an explicit deadline.
- `packages/server/src/sessions.ts`: reply and dismiss paths append a completed local
  resolution before upstream confirmation; dismiss suppresses reply errors.
- `packages/server/src/sessions.ts` and `packages/session/src/index.ts`: dispatch deletes a
  queued row before OpenCode confirms admission.
- `packages/server/src/sessions.ts`: canonical create is persisted only after backend create,
  permitting untracked accepted sessions.
- `packages/backend-opencode/src/index.ts`: SSE reconnect has no resume cursor and all
  dedup/translation state is memory-only.
- `packages/server/src/sessions.ts`: no reconnect/reattach path pulls authoritative status,
  pending permissions, pending questions, or missing durable events.
- `packages/server/src/index.ts`: restart replaces runtime state without reconciling active
  turns or pending attention; post-ready child exit is not propagated to the pool.
- `packages/server/src/sessions.ts`: imported history is marked imported in `finally` after a
  failed fetch.
- `packages/backend-opencode/src/client.ts`: Basic auth ignores
  `OPENCODE_SERVER_USERNAME`.
- `packages/server/src/mcp.ts` plus `packages/backend-opencode/src/config.ts`: boot seeding
  can normalize and rewrite the complete MCP block, deleting unsupported entries and
  unowned fields.
- `packages/server/src/index.ts`: applying a local config file restarts every runtime,
  including unrelated SSH runtimes.
- `packages/server/src/sessions.ts`: hard delete removes canonical state after a suppressed
  abort without confirmed backend deletion or a persistent binding tombstone, so restart can
  offer the stale backend session for adoption again.

### Likely bugs and risks to test

- Stale cwd-keyed PID files can target an unrelated reused PID because process identity is
  not validated in local or remote reaping.
- Local free-port selection has a bind race and no collision retry.
- Backend session mappings do not include endpoint identity, endpoint generation, protocol,
  directory, or workspace.
- Persisted `working`/`waiting` state is treated as stale without proving upstream state;
  queue dispatch and mutation eligibility can be wrong after restart.
- Remote authentication cannot reliably represent credentials configured on the remote
  endpoint.
- Legacy question replies assume request IDs are globally unique within the selected
  directory because their route is not session-scoped.
- Rewriting JSONC loses comments/formatting even where semantic unknown fields survive.

### Already-safe behavior to retain

- `appendAndBroadcast` persists model-visible data before display.
- Canonical WebSocket reconnect gap-fills by session sequence and buffers the live race.
- SQLite event sequencing, attention indexing, projection patches, queue reordering, delete,
  and child publication are transactional.
- `withSessionLock` serializes canonical admission, event handling, fork, and rewind.
- Backend branch history is read back and exactly verified before canonical publication.
- Most config mutations preserve unrelated top-level/provider/agent fields and reject
  corrupt input.
- HTTP status errors are not retried.
- SSE has cancellation and intentionally has no finite request timeout.
- Current local and SSH legacy runtimes consistently select project/worktree cwd and
  constrain file attachments to it.

## Target ownership

### Package ownership

| Concern | Owner | Rule |
| --- | --- | --- |
| Provider-neutral runtime/reconciliation DTOs | `packages/contracts/src/index.ts` | No OpenCode SDK/generated names or endpoint paths |
| Endpoint discovery, process ownership, config authority, auth, process/SSH lifecycle | `packages/backend-opencode` | Only this package can speak to or spawn OpenCode; process ownership never implies config writability |
| Query/mutation/SSE wire semantics | `packages/backend-opencode/src/transport.ts` | Query retry only; mutation ambiguity explicit; SSE separate |
| Legacy and V2 endpoint/body/event translation | `packages/backend-opencode/src/protocol*.ts` | Generated V2 types terminate here |
| `AgentRuntime` implementation | `packages/backend-opencode/src/runtime.ts` | Composes endpoint lease, transport, protocol |
| Runtime selection and stable facade | `packages/server/src/index.ts` | Chooses mode/config; never knows endpoint paths |
| Canonical mutation intent, reconciliation merge, status/projection truth | `packages/server/src/sessions.ts` | Append before broadcast; backend state enters only as normalized data |
| Durable operation IDs, queue leases, observation dedup | `packages/session/src/index.ts` | Transactional and restart-safe |
| Permission policy | `packages/permissions/src/index.ts` | Policy only; no OpenCode calls or authoritative pending state |
| OpenCode config patching | `packages/backend-opencode/src/config.ts` | Preserve opaque/unowned fields; enforce ownership before write |
| Polyth MCP/visibility desired state | `packages/server/src/mcp.ts`, `packages/server/src/modelVisibility.ts` | Import is read-only; secrets remain server-only |
| Browser delivery | `packages/server/src/ws.ts` | Continue delivering canonical durable events; no OpenCode recovery logic |

### Suggested file layout

- `packages/backend-opencode/src/endpoint.ts`
- `packages/backend-opencode/src/transport.ts`
- `packages/backend-opencode/src/protocol.ts`
- `packages/backend-opencode/src/protocolLegacy.ts`
- `packages/backend-opencode/src/protocolV2.ts`
- `packages/backend-opencode/src/runtime.ts`
- existing `packages/backend-opencode/src/index.ts` becomes public construction/re-export and
  legacy wiring rather than the home of every responsibility.

Avoid a class hierarchy. Use tagged unions and composed interfaces so the code remains
erasable TypeScript.

## Interface sketches

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
      usernameEnv: string;
      passwordEnv: string;
    }
  | { kind: "endpoint-headers"; resolve: () => Promise<Record<string, string>> };

export interface RuntimeEndpoint {
  authorityId: string;
  continuity: "verified" | "generation-only";
  generation: number;
  url: string;
  location: { directory: string; workspace?: string };
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

Only the owned variant exposes restart, and its instance token identifies the exact process
or SSH forward. Borrowed disposal never calls service stop. Config authority is independent
of process control. `authorityId` is stable only when protocol evidence verifies continuity;
`generation` changes whenever URL, credentials, or service instance changes. A
`generation-only` endpoint cannot reuse a backend-session binding across that change.

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
    onEvent(value: unknown): void;
  }): Promise<void>;
}
```

Queries may retry transient failures inside one overall budget. Mutations are one-shot unless
the selected operation has a pinned contract proving that replay with the same operation ID
has one effect. A mutation timeout or transport loss is `unknown`. Transport returns a
complete HTTP response without interpreting it; the protocol adapter maps it to
confirmed/rejected/unknown under an operation-specific contract. An unclassified 5xx is
unknown, not rejection. Proving `not-applied` closes the old operation; it does not trigger
hidden automatic replay.

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

Branch, abort, and reply methods use the same `MutationOutcome`; they do not need separate
abstractions. `AgentRuntime` remains the server-facing facade and gains only normalized
operation/reconciliation capabilities required by `packages/server`.

The snapshot is an evidence envelope, not state to overwrite into a projection. Current
generation/location/session/reconciliation fences are checked before translation. Domain
absence is usable only when complete and causally newer. SSE and pull normalize to the same
persistent entity/revision keys.

## Cross-phase invariants

1. Generic retry never replays a mutation. The durable state machine and crash boundary are
   exactly those in `INVARIANTS.md`.
2. Every logical mutation has one durable operation ID and per-session ordinal; one
   transaction claims its execution before I/O. Recovery treats a stranded claim as unknown.
3. Transport failure/deadline after claim is `unknown`, not rejection. An unkeyed unknown is
   never resubmitted; proof of non-application closes it without hidden retry.
4. User intent/request discovery is durable before external action/display. Attention uses a
   compare-and-set winner; queue rows stay reserved through ambiguity.
5. Reconnect means endpoint refresh plus fenced status/attention/event reconciliation.
6. Only an exact owned instance token can stop/restart. Shared/ensured/external services are
   borrowed; config authority is separate and exact-target.
7. Authority, generation, normalized location, backend session, and reconciliation ordinal
   fence every observation. Stale evidence is discarded before translation.
8. Observation claim, emitted canonical batch, entity checkpoints, and cursor advancement
   are one transaction. SSE and pull share semantic entity keys.
9. Snapshot absence is destructive only when the domain is complete and causally newer.
   Otherwise state remains `unknown`/`reconciling`.
10. Every finite request and scheduler-held network operation has a deadline; SSE has no
    finite REST deadline. Unknown durable state never holds an in-memory lock.
11. Config reads/imports do not write; writes preserve every unowned field and never
    interrupt active/waiting work by default.
12. V2 details are negotiated and contract-tested per capability; generated beta
    declarations alone never enable one.
13. Multiple clients through one server are ordered by durable per-session ordinals.
    Concurrent Polyth servers sharing one data directory are rejected at startup.

### Canonical durable vocabulary

The operations table is authoritative for execution state. When that state is exposed to a
client, append one of these protocol-neutral, ignorable canonical events before projection
or UI broadcast: `mutation/prepared`, `mutation/claimed`, `mutation/confirmed`,
`mutation/rejected`, `mutation/uncertainty-recorded`, or
`mutation/nonapplication-confirmed`. Payloads contain operation ID, ordinal, normalized
mutation kind, and safe code/message only—never credentials, secret answers, raw protocol
bodies, endpoint headers, or SDK DTOs.

Use `reconciliation/started`, `reconciliation/completed`, and
`reconciliation/blocked` for the admission barrier and `reconciling`/`unknown` projection
states. Existing `permission/resolved` and `question/answered` remain completion facts and
are appended only after confirmation. The same transaction as `mutation/prepared` appends
`permission/response-intended` with request ID/reply,
`question/response-intended` with request ID/answers, or
`secret/response-intended` with request ID/action/opaque handle; secret material is never
stored. These intent events do not close attention. Existing unknown event types remain
safely ignorable by reducers.

## P0-1 — Mutation safety and ambiguous outcomes

### Changes

1. Replace method-generic `request` with explicit query and mutation operations.
   Automatically retry only `GET`/`HEAD`; do not replay `DELETE`.
2. Remove catch-all prompt fallback. Select `prompt_async`, `/message`, or V2 `/prompt`
   from a read-only capability/version contract before a logical submission. Never probe by
   sending a prompt. If unsupported can be learned only from a contract-classified
   non-accepting response, reject that operation and cache the capability for a future
   user-authorized operation; do not send the current prompt to another endpoint.
3. Remove `reviving` around `resetSession` and `branchSession`. For `ensureSession`, split
   safe reattachment lookup from create; never replay a create after unknown outcome.
4. Persist a random operation ID and per-session ordinal for each create, prompt, steer,
   fork/revert, abort, delete, permission reply, question reply/reject, or secret reply.
   Never infer identity from equal text/body. Pass the ID upstream only where an
   operation-specific pinned contract proves its meaning. Create the `prepared` operation in
   the same transaction as its owning user-intent event, queue reservation, response intent,
   canonical session shell, or deletion tombstone; neither may exist without the other.
5. Implement the exact durable state machine:
   `prepared -> executing -> confirmed|rejected|unknown` and
   `unknown -> confirmed|not-applied`. Local validation may use
   `prepared -> rejected`. The only additional transition is
   `unknown -> executing` for same-ID replay under a pinned operation-specific idempotency
   contract. Every SQLite transition to `executing` is a single-executor claim and commits
   before network I/O.
6. Recover a stranded `executing` record as `unknown` even if the crash may have preceded
   socket write. An unkeyed unknown is never automatically resubmitted. A
   contract-idempotent retry reuses the same ID; proof of `not-applied` terminalizes the old
   operation and requires a new user-authorized operation.
7. For user messages, retain the existing append-before-runtime order and associate that
   durable event, operation ID, and ordinal with the admission attempt. Unknown is not
   `turn/failed`; it blocks conflicting admission/fork/rewind while reconciliation is
   unresolved. A protocol receipt may bind an upstream user-message ID to this existing
   event; reconciliation never appends a second user message based on text similarity.
8. Replace destructive queue shift with transactional reserve/confirm/release:
   - reserve the head and create its prepared operation atomically;
   - claim and submit it under the same operation rules;
   - delete and append `queue/dispatched` only on confirmed admission;
   - retain `unknown` reservations for reconciliation;
   - release only after `rejected` before admission or authoritative `not-applied`; and
   - block later FIFO entries behind an unknown reservation.
9. For permission/question responses, atomically compare-and-set open to one durable response
   intent and prepared operation, submit once, then append confirmed resolution. Competing
   clients receive the recorded winner. Keep the card open with
   response-in-flight/uncertain and disable another response while outcome is unknown.
   A confirmed rejection/not-applied appends failed intent and atomically makes the same
   request actionable again with a future new operation ID. Dismiss/auto-accept must not
   suppress ambiguity.
10. Persist a canonical session shell and prepared create operation in one transaction
    before backend I/O so an unknown create has durable identity.
11. Make branch cleanup target only a known confirmed backend child; never assume unknown
    create/fork did not happen.
12. Durable unknown state must not retain a session promise lock. All network work under the
    scheduler has a finite deadline and releases in `finally`.
13. Store hard-delete tombstones outside session-scoped rows removed by `deleteSession`.
    Atomically create the tombstone/prepared operation and remove the canonical rows. Retain
    canonical ID, authority/generation/location/backend binding, and delete operation
    outcome. Unknown delete/abort remains tombstoned and non-adoptable across restart; only a
    confirmed upstream delete or explicit purge policy may retire it.

### Primary files

- `packages/contracts/src/index.ts`
- `packages/backend-opencode/src/client.ts`
- `packages/backend-opencode/src/index.ts`
- new `packages/backend-opencode/src/transport.ts`
- `packages/server/src/index.ts`
- `packages/server/src/sessions.ts`
- `packages/session/src/index.ts`

### Tests required before shipping

- A fake accepts `POST /session`, persists it, then drops the response. Assert one HTTP
  attempt, one durable unknown operation, no second backend session.
- Repeat for prompt, steer, fork, abort, delete, permission reply, question reply, and
  question reject/secret reply.
- Read-only capability negotiation chooses one prompt endpoint. When that choice returns a
  contract-classified non-accepting unsupported response, assert the operation is rejected
  and the current prompt is not sent elsewhere; a later new operation may use the cached
  alternate capability.
- A transport error before/after body consumption never causes a second mutation.
- Contract-classified validation/unsupported responses produce `rejected` without retry; an
  unclassified HTTP 5xx produces `unknown` without retry.
- Queue dispatch pre-accept failure retains/releases the same row; post-accept response loss
  reserves it until reconciliation; restart preserves both states and FIFO.
- Crash after `executing` commit both before socket write and after backend commit recovers as
  one unknown operation and performs no unkeyed replay.
- Two clients submit different answers to one request concurrently. Assert one durable
  compare-and-set winner, one upstream mutation, and a deterministic loser response.
- Permission/question reply response loss does not close the local card until reconciled.
- A confirmed rejected/not-applied reply intent makes the same card actionable again; an
  unknown reply remains disabled/uncertain across restart.
- Canonical create exists durably before backend I/O and unknown create is visible/retry-
  guarded.
- Hard delete with abort/delete response loss removes the requested canonical view but keeps
  a binding tombstone; backend sync before and after Polyth restart cannot re-adopt it.
- A thrown, timed-out, and unknown operation releases the in-memory scheduler; conflicting
  work is blocked by durable state, not a never-settling promise.
- Existing append-before-display, fork atomicity, and per-session serialization tests remain
  green.

### Exit gate

No mutating route can reach a loop or a catch-and-submit-different-endpoint path. A test must
enumerate all protocol mutations and assert their replay policy.

## P0-2 — OpenCode runtime/protocol boundary and V2

### Changes

1. Add endpoint lease, transport, and protocol interfaces from the sketches.
2. Move existing legacy shapes/event translation behind `protocolLegacy.ts` without changing
   canonical event types.
3. Implement four endpoint provider modes, independent of protocol:
   - owned local child: exact child token and local config target when applicable;
   - owned SSH child/forward: exact remote/forward tokens and read-only local config;
   - borrowed discovered/ensured service: endpoint-supplied headers, no stop/restart/config;
   - borrowed external URL: environment-referenced authentication, no stop/restart/config.
   Calling `Service.ensure()` never proves exclusivity; even a newly started ensured service
   is borrowed unless a separate pinned contract grants an exclusive instance token.
4. Implement protocol negotiation using health/content-type/capability probes. Cache by
   endpoint generation, not globally.
5. Add `protocolV2.ts` for the beta API:
   - create with explicit `location`;
   - prompt with stable client ID and admission receipt only when duplicate semantics are
     proven;
   - per-session event/history cursor only when retention, inclusivity, invalidation, and
     item identity are proven;
   - pending permission/question pulls classified as partial until completeness and causal
     ordering are proven;
   - V2 status, interrupt, reply, and branch/revert equivalents only when contract-tested.
6. Keep generated V2 DTOs private to `packages/backend-opencode`. Normalize to
   `AgentRuntime`, `RuntimeEvent`, and `RuntimeSnapshot`.
7. Bind backend session ID to authority identity, endpoint generation/continuity, protocol,
   directory, and workspace. Refuse mismatches before I/O. Reuse across generation only when
   authority continuity is verified; URL equality is not proof.
8. Tag every stream callback and reconciliation result with generation and binding. Discard
   stale generations before protocol translation.
9. Do not infer V2 from generated `Session2`/`Session3` class names or infer a capability
   from an optional generated field.

### Primary files

- `packages/contracts/src/index.ts`
- new `packages/backend-opencode/src/endpoint.ts`
- new `packages/backend-opencode/src/protocol.ts`
- new `packages/backend-opencode/src/protocolLegacy.ts`
- new `packages/backend-opencode/src/protocolV2.ts`
- new `packages/backend-opencode/src/runtime.ts`
- `packages/backend-opencode/src/index.ts`
- `packages/backend-opencode/src/remote.ts`
- `packages/backend-opencode/src/plugin.ts`
- `packages/server/src/index.ts`

### Tests required before shipping

- Contract matrix runs the same normalized create/send/event/abort/reply behavior against
  legacy and V2 fakes.
- Negotiation selects legacy, V2, or unsupported deterministically and never mutates during
  probing.
- Borrowed discovered/ensured/external disposal performs zero service-stop, process-kill,
  restart, and config-write calls, including when `ensure()` started a service.
- Owned disposal kills only the exact child associated with the lease.
- Endpoint URL/auth rotation increments generation and rebuilds HTTP/SSE together. Verified
  authority continuity permits fenced rebind; generation-only continuity rejects the old
  binding.
- Every call asserts exact directory/workspace encoding, including create, prompt,
  attachment, fork/revert, status, history, events, permissions, and questions.
- V2 client-operation ID duplicate behavior is tested separately for create, prompt,
  interrupt, branch/revert, each reply kind, and delete against the pinned supported beta.
  Passing one operation never enables replay for another.
- Legacy behavior remains covered by existing adapter and remote tests.

### Exit gate

`packages/server` cannot import OpenCode SDK types or paths. Stop/restart exists only on an
owned lease with an exact instance token. Config write requires an independently matching
writable target. No borrowed implementation imports or invokes service stop.

## P0-3 — Reconnect and reconciliation

### Changes

1. Add a normalized `AgentRuntime.reconcile` seam returning `RuntimeSnapshot`.
2. Reconcile:
   - whenever a session is first wired;
   - after every SSE disconnect/reconnect;
   - after endpoint generation changes;
   - after every unknown mutation; and
   - before queue dispatch or destructive history mutation when persisted state is
     working/waiting/unknown.
   Each trigger enters a per-session admission barrier. The result carries a monotonically
   allocated reconciliation request ordinal; a result older than the latest started/current
   request is ignored.
3. V2:
   - resume per-session events from the last transactionally committed cursor only when the
     event replay contract is enabled;
   - fetch missed durable history/events;
   - pull session status and per-session pending permissions/questions with explicit
     per-domain completeness/watermark classification.
4. Legacy:
   - pull available session status/messages/questions/permissions;
   - normalize stable backend message/part/tool/request identity when available;
   - leave state unknown where the API cannot prove it.
5. Add a persistent entity/observation index keyed by authority identity, normalized
   location, backend-session ID, artifact kind, stable upstream entity ID, and revision/state
   rank. Endpoint generation is deliberately excluded from this uniqueness key; it is an
   ingestion fence.
6. In one SQLite transaction, claim the observation, append its complete deterministic
   canonical event batch, update full-value message/part/tool checkpoints, and advance the
   cursor. A failure rolls all four back, and replay returns the prior canonical mapping.
7. Normalize SSE and pull/history artifacts to the same entity key. For text snapshots,
   append only the suffix when the stored full value is an exact prefix; for tool calls, use
   stable call identity and monotonic state rank, emitting each lifecycle/terminal rank once.
   Divergent text, regressive tools, a changed payload at an already-emitted terminal rank,
   or artifacts without stable identity append explicit uncertainty rather than duplicate
   model output. An upstream user message binds to an existing local user event only through
   a protocol receipt/operation mapping, never through equal text.
8. Merge newly discovered pending requests as normal durable request events. Resolve locally
   open attention only from a reply receipt or absence in a complete, causally-newer pending
   snapshot. Partial/unversioned absence leaves the card open and uncertain; never fabricate
   an answer.
9. Rebuild running/idle/failed/interrupted state only from current, comparable evidence.
   Terminalize an incomplete turn once using a unique `(turn operation, terminal evidence)`
   key. Stale/non-comparable status cannot overwrite a newer projection and leaves unknown
   when evidence is insufficient.
10. Remove the failed-history `finally` marker. Record a success marker only after complete
   import; use a retryable failed/partial marker otherwise.
11. Check durable deletion tombstones before mapping, importing, or reconciling a backend
    session. A tombstoned binding is never recreated as a new canonical session.
12. Extend provider-neutral `SessionStatus` with `reconciling` and `unknown`. Both are
    non-mutable/busy states for server arbitration, queue dispatch, and destructive-action
    confirmation. Render those words through existing session status surfaces without
    exposing protocol or endpoint details; this is status honesty, not a UI redesign.

### Primary files

- `packages/contracts/src/index.ts`
- `packages/backend-opencode/src/protocol.ts`
- `packages/backend-opencode/src/protocolLegacy.ts`
- `packages/backend-opencode/src/protocolV2.ts`
- `packages/backend-opencode/src/events.ts`
- `packages/backend-opencode/src/runtime.ts`
- `packages/server/src/sessions.ts`
- `packages/session/src/index.ts`
- `apps/web/src/packages/reducers.ts`, `apps/web/src/sessionBadges.ts`,
  `apps/web/src/components/sidebar/SessionList.tsx`, and
  `apps/web/src/components/Sidebar.tsx` for protocol-neutral unknown/reconciling treatment

### Tests required before shipping

- Disconnect before permission/question event; pull reconciliation creates one durable card.
- Disconnect after request event but before local receipt; replay/pull produces no duplicate.
- Deliver the same message part/tool transition under different SSE and history event IDs
  and revisions; assert one semantic canonical effect across process restart. A changed
  payload at a repeated terminal tool rank produces uncertainty, not a second result.
- Lose a prompt response, then expose its upstream user message through history. A receipt/
  operation mapping confirms the existing canonical user event without appending another;
  equal text without a mapping remains uncertain.
- Rotate URL/auth while a prior-generation callback and snapshot are delayed; assert both are
  discarded before translation and current evidence remains unchanged.
- Complete two same-generation reconciliations out of order; assert the superseded request
  ordinal cannot regress status, attention, checkpoints, or cursor.
- Browser reload, second client, Polyth restart, and endpoint reconnect each preserve one
  actionable request and one resolution.
- Restart with upstream states running, idle, failed, interrupted, permission-pending, and
  question-pending yields the corresponding honest canonical projection.
- While reconciliation is in flight the projection/UI reports `reconciling`; insufficient
  terminal evidence reports `unknown`. Both block send/queue/fork/rewind and destructive
  action uses the active-session confirmation path.
- Missing terminal SSE event is recovered once from status/history.
- Invalid/expired V2 cursor falls back to a bounded snapshot/history reconcile without
  duplicating output.
- Fail after canonical append staging but before checkpoint/cursor commit; assert transaction
  rollback and exact one-time output after replay.
- A partial or unversioned pending snapshot omitting a known request does not close it; a
  complete causally-newer snapshot does.
- Replayed full text appends only a proven suffix. Divergent text and an unidentified tool
  artifact append no duplicate model-visible event and leave explicit uncertainty.
- Legacy protocol lacking an authoritative pull leaves uncertainty visible and blocks unsafe
  replay.
- Imported-history transient failure retries later and never appends a success marker until
  complete.
- Observation dedup survives Polyth process restart and cursor replay.
- Backend listing contains a tombstoned unknown-delete session after restart; it remains
  hidden/non-adoptable and no stale history is appended.

### Exit gate

Reconnecting an SSE socket without running reconciliation is impossible through the runtime
API. All reconciliation appends are idempotent across process restart and across SSE/history
channels. Cursor movement cannot commit separately from output/checkpoints, and stale
generation/request evidence cannot reach translation.

## P0-4 — Lifecycle and restart safety

### Changes

1. Surface child exit, SSH handle exit, SSE liveness failure, and endpoint-auth failure to one
   generation-aware runtime supervisor.
2. Single-flight endpoint refresh. Replace URL, auth, HTTP client, and SSE together.
   Tag old callbacks with their captured generation so they fail the ingestion fence even if
   they arrive after replacement.
3. For an owned deliberate/config restart:
   - stop admitting new mutations for affected sessions;
   - record a runtime transition;
   - reconcile and require every affected session to be authoritatively idle with no pending
     permission/question/tool work or unresolved unknown operation;
   - if the safe-idle wait reaches its deadline, keep the change pending and reopen existing
     work without stopping the process; do not interrupt by default;
   - for config, require the lease's writable `targetId` to exactly match the changed target
     before writing;
   - stop the exact owned process;
   - spawn and negotiate the next generation;
   - rebind and reconcile all sessions;
   - resume queue admission only after reconciliation.
4. For a crash, keep the admission barrier, replace/rediscover according to ownership, and
   reconcile; do not infer interruption/completion from process exit alone.
5. For every borrowed shared/ensured/external lease, rediscover/reconnect only. Its `dispose`
   and a Polyth config change make zero calls to service stop/restart/config.
6. Make config restart target only owned leases with the exact affected writable config
   target. An owned SSH child remains read-only to the local config applier.
7. Harden PID files with owner instance token, child start identity, and executable/command
   verification; remove blind stale-PID kills. Preserve exact-process handles wherever
   possible.
8. Bind a local listening socket safely or retry local bind collisions with a fresh port.
9. Ensure disposal and restart are idempotent and do not leak listeners, children, forwards,
   or browser-tool registrations.
10. Before opening SQLite or any endpoint, acquire an OS-held exclusive advisory lock on the
    canonical data-directory identity and hold its file descriptor for process lifetime.
    A second Polyth server targeting that identity fails closed. Do not implement this as a
    create-only PID/heartbeat file or steal it on timeout; kernel release on process exit is
    the crash-recovery mechanism. SQLite transactions alone do not provide endpoint
    leadership.

### Primary files

- `packages/backend-opencode/src/endpoint.ts`
- `packages/backend-opencode/src/runtime.ts`
- `packages/backend-opencode/src/index.ts`
- `packages/backend-opencode/src/remote.ts`
- `packages/server/src/index.ts`
- `packages/server/src/opencodePending.ts`
- `packages/server/src/sessions.ts`

### Tests required before shipping

- Process exits during text generation, tool execution, permission wait, and question wait.
  Each case reconnects/reconciles without duplicate mutation or indefinite local state.
- Deliberate restart with active and idle sessions enforces the admission barrier and resumes
  queues only after reconciliation.
- Config restart with active text, tool, permission, or question work reaches its wait
  deadline without interrupting or stopping; the change remains pending.
- Endpoint changes URL and credentials during SSE disconnect; HTTP and stream adopt the same
  new generation.
- Borrowed service returned by `ensure()` records no stop/start/config mutation on apply or
  disposal, including when the service was initially absent.
- Local config apply does not touch SSH runtime handles.
- PID reuse fixture never kills a process whose identity does not match the recorded child.
- Three local bind collisions retry cleanly and leak no children.
- Concurrent restart callers produce one replacement generation.
- A late old-generation callback after restart is rejected before translation.
- A second server using the same data directory fails before creating an endpoint or
  accepting mutations; normal and abrupt process exit release the OS-held writer lease.

### Exit gate

There is one lifecycle supervisor per endpoint lease. Stop/restart exists only on the owned
lease variant and validates the exact instance token. Config write separately validates the
exact writable target. Borrowed disposal contains no service-stop path, and one data
directory has one Polyth endpoint leader.

## P0-5 — Transport deadlines

### Changes

1. Add per-operation finite deadlines and an overall query retry budget to
   `OpenCodeTransport`.
2. Apply the signal to request connection, headers, and response-body consumption.
3. Classify query deadline as retryable within budget; classify mutation deadline as unknown.
4. Make `waitReady` compose short probe deadlines with its absolute startup deadline so one
   probe cannot hang the loop.
5. Add bounded deadlines to remote startup/forward/cleanup orchestration where the
   `RemoteHost` contract permits it. Extend the provider-neutral SSH contract only if
   necessary.
6. Keep SSE free of finite request timeout. Add heartbeat/stall detection only as a reason to
   cancel, refresh, and reconcile, never as mutation failure evidence.
7. Bound every network await performed while a per-session scheduler or endpoint admission
   barrier is held. Release those schedulers/barriers in `finally`; persistent unknown state,
   not an unresolved promise, prevents unsafe work.

### Primary files

- `packages/backend-opencode/src/transport.ts`
- `packages/backend-opencode/src/endpoint.ts`
- `packages/backend-opencode/src/remote.ts`
- `packages/contracts/src/index.ts` only if remote host deadline options must expand

### Tests required before shipping

- Never-responding health, catalog, session list/history, status, and pending-list endpoints
  finish within the configured total budget.
- Slow response body is also bounded.
- Query retry count and total elapsed budget are deterministic under a fake clock.
- Never-responding create/prompt/fork/reply/abort/delete returns unknown after one request.
- Startup cannot exceed its absolute deadline because one health probe hangs.
- SSE remains connected beyond the finite REST deadline and ends only on cancellation or
  liveness policy.
- A never-responding mutation/reconcile/restart releases the in-memory session scheduler and
  endpoint single-flight after its deadline; the durable state remains unknown/reconciling.

### Exit gate

A static call-site inventory shows every finite OpenCode operation passes a deadline and the
stream API has no deadline parameter.

## P1 — Config preservation and runtime assumptions

### Changes

1. Make backend config import/seed read-only. In particular, an empty Polyth MCP store must
   not call `applyMcp` while discovering existing entries.
2. Retain opaque raw fragments for managed MCP entries and all unsupported entries. Patch
   only owned fields when the user changes one entry; do not regenerate the complete block
   from a narrower DTO.
3. Preserve nested unknown provider/model/agent/plugin/MCP properties in every operation.
   Add explicit fixtures for reasoning, modalities, limits, variants, and future fields.
4. Decide whether comment-preserving JSONC edits are required. Until then, document semantic
   field preservation separately from formatting preservation.
5. Read `OPENCODE_SERVER_USERNAME` with the password for legacy Basic auth.
6. Keep protocol selection (`legacy`/`v2`) separate from endpoint control
   (`owned-local`/`owned-ssh`/`borrowed-shared`/`borrowed-external`). External credentials
   are environment-variable names or a credential-provider reference, never literal values
   returned by an API.
7. Validate endpoint scheme/host policy, normalize directory, represent workspace, and bind
   all values into endpoint/session identity.
8. Apply config only when independent config authority is writable and its `targetId`
   exactly matches the changed target. A borrowed endpoint and an owned SSH endpoint may
   report local settings as pending/inapplicable rather than be restarted.

### Primary files

- `packages/backend-opencode/src/config.ts`
- `packages/backend-opencode/src/endpoint.ts`
- `packages/backend-opencode/src/client.ts` or its legacy auth replacement
- `packages/server/src/mcp.ts`
- `packages/server/src/modelVisibility.ts`
- `packages/server/src/opencodePending.ts`
- `packages/server/src/index.ts`
- public safe configuration DTOs in `packages/contracts/src/index.ts` if needed

### Tests required before shipping

- Boot with an empty Polyth MCP store and a populated OpenCode config performs zero writes
  and preserves bytes.
- Edit one MCP entry while unsupported entries and unknown sibling/nested fields remain
  semantically identical.
- Provider visibility preserves API keys, base URLs, reasoning settings, modalities, token
  limits, variants, and arbitrary future nested properties.
- Agent/plugin edits preserve arbitrary future fields.
- Corrupt/non-object config remains untouched.
- Non-default Basic username authenticates.
- Secret literals never enter safe config DTOs, logs, error text, or API responses.
- Borrowed modes and owned SSH refuse local config write/restart; owned local permits only
  its exact writable config target and follows the safe-idle restart barrier.

### Exit gate

Property-preservation tests compare the entire unowned subtree before and after every config
operation. Import-only startup has a zero-write assertion.

## Fault-injection test infrastructure

### Structure

Create reusable fakes instead of adding more one-off HTTP servers:

- `packages/backend-opencode/test/fakeOpenCode.ts`: scripted legacy/V2 HTTP and SSE backend;
- `packages/backend-opencode/test/transportFaults.test.ts`: wire-level retry/deadline/
  ambiguity matrix;
- `packages/backend-opencode/test/protocolContract.test.ts`: normalized protocol contract;
- `packages/backend-opencode/test/reconciliation.test.ts`: cursor/pull/dedup behavior; and
- server-level fixtures that reuse the fake with a real SQLite store.

The fake needs deterministic barriers rather than timing guesses:

- accept and commit, then drop socket before headers;
- send headers, then terminate response body;
- drop before commit;
- never send headers/body;
- explicit status error;
- duplicate, omit, reorder, and pause SSE events;
- replay from inclusive/exclusive cursor and expire a cursor;
- describe one message part/tool transition under different SSE and history event IDs;
- return complete, partial, stale, and unversioned status/attention snapshots;
- rotate endpoint URL/auth generation while delaying old callbacks and older reconciliation
  responses;
- return `Service.ensure()` as both pre-existing and newly started while asserting borrowed
  disposal never stops it;
- preserve upstream state across a Polyth restart;
- clear or retain pending attention across an OpenCode restart;
- assert received directory/workspace/auth and operation ID;
- count each mutation and expose committed records separately from request count; and
- independently configure duplicate-operation-ID behavior for every mutation kind.

### Required matrix

Run every mutation through every applicable fault point. Do not settle for create/prompt
only. The matrix must include create, reset/replacement, fork/revert, prompt, steer/queue,
interrupt/abort, delete, permission reply, question reply/reject, and config mutation where
the protocol uses HTTP, plus secret reply when it crosses the OpenCode boundary.

Existing tests to preserve and extend:

- `packages/backend-opencode/test/client.test.ts`
- `packages/backend-opencode/test/adapter.test.ts`
- `packages/backend-opencode/test/remote.test.ts`
- `packages/backend-opencode/test/config.test.ts`
- `packages/server/test/delivery.test.ts`
- `packages/server/test/mobileIntervention.test.ts`
- `packages/server/test/opencodePending.test.ts`
- `packages/server/test/sessionRuntime.test.ts`
- `packages/server/test/wsGapFill.test.ts`
- `packages/session/test/session.test.ts`

The existing client test that expects mutating POST replay must be replaced with an assertion
that the mutation executes once and returns unknown.

## E2E reliability suite

### Suites

1. **Response-lost-after-commit**
   Start Polyth against the fault fake, create/send/fork/reply, restart Polyth against the
   same fake state and SQLite file, reconcile, and assert one upstream effect and one
   canonical outcome or an honest unresolved unknown where the protocol cannot prove it.
2. **Missed attention**
   Disconnect SSE before permission/question creation, open from another client, restart
   Polyth, reconcile, reply, and assert one card and one upstream response.
3. **Crash during turn**
   Crash/displace OpenCode during text, tool, permission, and question phases. Assert honest
   status, no duplicate prompt, no lost queue row, and eventual reconciliation.
4. **Delete resurrection**
   Lose the backend abort/delete response, remove the canonical session, restart Polyth
   against the surviving backend, and assert the durable tombstone prevents import, mapping,
   event ingestion, and adoption.
5. **Endpoint election**
   Rotate shared-service URL and credentials while connected. Assert rediscovery, generation
   fencing, stale callback/snapshot rejection, no kill, and matching HTTP/SSE endpoint
   generation.
6. **Location isolation**
   Run project root, two worktrees, and an SSH runtime with intentionally colliding backend
   IDs. Assert no cross-location event, status, request, attachment, or reply.
7. **Config preservation**
   Boot and mutate against a config containing unknown current/future fields and unsupported
   MCP entries. Assert no unowned semantic change and no remote/shared restart.
8. **Real OpenCode compatibility smoke**
   Against each pinned supported CLI/client version, run capability negotiation, create,
   prompt, event resume/reconcile, pending-list/reply, interrupt, and disposal ownership
   checks. Gate beta V2 separately from stable legacy.

### Global assertions

- no duplicate unkeyed mutation attempt and no duplicate upstream effect;
- no duplicate semantic message part/tool transition across SSE and pull;
- no model-visible UI event before durable append;
- no unresolved queue row silently deleted;
- no locally closed attention before confirmed receipt or complete causally-newer evidence;
- no terminal state without evidence;
- no stale generation or superseded reconciliation result changing canonical state;
- no tombstoned backend binding resurrected by listing/import/reconciliation;
- no cross-location traffic;
- no secret in logs/API;
- no borrowed/ensured/external process or service stop; and
- no unowned config field loss.

## Parallel implementation ownership

Parallel work begins only after Agent C lands the provider-neutral contract commit. The
following map is exclusive for the full hardening series: no path appears in two rows, and
new or existing tests have an owner just like production files.

| Agent | Exclusive production files | Exclusive existing tests | May add |
| --- | --- | --- | --- |
| **C — contracts and durability** | `packages/contracts/src/index.ts`; `packages/session/src/index.ts` | `packages/contracts/test/contracts.test.ts`; `packages/session/test/session.test.ts`; `packages/session/test/queue.test.ts` | `packages/contracts/test/opencodeRuntime.test.ts`; `packages/session/test/runtimeOperations.test.ts`; `packages/session/test/queueLease.test.ts` |
| **D — wire transport and fault fake** | `packages/backend-opencode/src/client.ts`; `packages/backend-opencode/src/transport.ts` | `packages/backend-opencode/test/client.test.ts` | `packages/backend-opencode/test/fakeOpenCode.ts`; `packages/backend-opencode/test/transportFaults.test.ts` |
| **E — protocol and semantic ingestion** | `packages/backend-opencode/src/protocol.ts`; `packages/backend-opencode/src/protocolLegacy.ts`; `packages/backend-opencode/src/protocolV2.ts`; `packages/backend-opencode/src/events.ts` | `packages/backend-opencode/test/adapter.test.ts`; `packages/backend-opencode/test/snapshots.test.ts` | `packages/backend-opencode/test/protocolContract.test.ts`; `packages/backend-opencode/test/reconciliation.test.ts` |
| **F — endpoint and runtime lifecycle** | `packages/backend-opencode/src/endpoint.ts`; `packages/backend-opencode/src/runtime.ts`; `packages/backend-opencode/src/index.ts`; `packages/backend-opencode/src/plugin.ts`; `packages/backend-opencode/src/remote.ts` | `packages/backend-opencode/test/remote.test.ts`; `packages/backend-opencode/test/browserTool.test.ts` | `packages/backend-opencode/test/runtimeLifecycle.test.ts`; `packages/backend-opencode/test/remoteLifecycle.test.ts` |
| **G — server orchestration and pool** | `packages/server/src/sessions.ts`; `packages/server/src/sessionRuntime.ts`; `packages/server/src/index.ts`; `packages/server/src/opencodePending.ts`; `apps/web/src/packages/reducers.ts`; `apps/web/src/sessionBadges.ts`; `apps/web/src/components/sidebar/SessionList.tsx`; `apps/web/src/components/Sidebar.tsx`; root `package.json` and `package-lock.json` only if an advisory-lock binding is required | `packages/server/test/delivery.test.ts`; `packages/server/test/mobileIntervention.test.ts`; `packages/server/test/opencodePending.test.ts`; `packages/server/test/sessionRuntime.test.ts`; `apps/web/test/eventIngestion.test.ts`; `apps/web/test/sessionBadges.test.ts`; `apps/web/test/sidebarPresentation.test.ts` | `packages/server/test/runtimeReconciliation.test.ts`; `packages/server/test/mutationOutcome.test.ts`; `packages/server/test/runtimePoolLifecycle.test.ts`; `packages/server/test/opencodeReliabilityE2E.test.ts` |
| **H — configuration preservation** | `packages/backend-opencode/src/config.ts`; `packages/server/src/mcp.ts`; `packages/server/src/modelVisibility.ts` | `packages/backend-opencode/test/config.test.ts` | `packages/backend-opencode/test/configPreservation.test.ts`; `packages/server/test/opencodeConfigPreservation.test.ts` |

Collision rules:

1. Agent C first lands only provider-neutral contract types and storage interfaces. Agents
   D–H consume that commit and never edit `packages/contracts/src/index.ts`. Agent C then
   continues the persistence schema/transaction work.
2. Agent D owns the shared fake's code and public script vocabulary. Agents E–G provide
   fixture data in their own tests; a missing fake behavior is added by D, not by editing
   `fakeOpenCode.ts` from another lane.
3. Agent F exclusively wires backend modules in
   `packages/backend-opencode/src/index.ts`. Agents D/E export modules but do not edit that
   file. `endpoint.ts` belongs only to F; H consumes its config-authority contract.
4. Agent G exclusively owns all listed server orchestration files, including
   `opencodePending.ts` and the data-directory writer lease. G is the only lane allowed to
   change root dependency manifests, and only for the advisory-lock implementation. H
   exposes config operations but does not edit server lifecycle files.
5. H never edits endpoint/runtime files to enforce config safety; F exposes read-only versus
   exact writable targets, and G performs targeted safe-idle restart orchestration.
6. Existing broad test files are not shared scratch space. Only the row owner changes an
   existing test. Cross-lane behavior goes in the named new owner test and uses public
   contracts.
7. No lane adds a new production file outside its row without first updating this ownership
   map. Integration conflicts are resolved by the owning agent, not by drive-by edits.

## V2 blockers and decision points

The design can proceed, but V2 cannot be declared supported until these are resolved:

1. The official V2 client/API is beta and may change before stable.
2. The installed `1.18.18` CLI lacks the documented `serve --service` option even though its
   installed SDK contains V2 generated types. Capability negotiation must not equate those
   facts.
3. Client-provided session/prompt `id` fields exist, but their duplicate/idempotency contract
   must be verified independently for every mutation; one passing endpoint enables no other.
4. Event/history `after` types differ, `durable` metadata is optional on generated event
   shapes, and retention/inclusivity/expiration/item-identity behavior needs live contract
   tests. SSE and pull must also prove how they name the same semantic entity.
5. Service election can change URL/auth. Credential refresh, stable authority identity, and
   whether a backend session survives that change must be pinned to a client version. URL
   equality is not continuity proof.
6. `Service.stop()` being available does not confer ownership. All
   discovered/ensured-service leases are borrowed and never call it unless a future API
   supplies a separately contract-tested exclusive instance token.
7. Workspace lifecycle and the relationship between `workspace`, `workspaceID`, directory,
   project, and worktree require capability tests.
8. Config authority for a shared/external service is unspecified for Polyth's use case and
   remains read-only/no-restart.
9. Legacy and V2 fork/revert, attachment, status, and pending-request semantics are not
   shape-compatible and need normalized contract fixtures.
10. Pending-list completeness and causal relationship to reply/status/event watermarks are
    unspecified. Until proven, absence cannot close attention or terminalize work.
