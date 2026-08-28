# OpenCode hardening baseline audit

Audit target: Git `d6c0f1749e054bac854f6c3f4364f873165dd7e9`, OpenCode CLI and installed
SDK `1.18.18`, inspected 2026-08-28. Documentation is treated as design/history; source and
live wire behavior are ground truth.

## Executive baseline

| Area | What is actually available |
| --- | --- |
| Owned local legacy runtime | Implemented, but only usable when protocol is explicitly forced to `legacy` against real `1.18.18`. |
| Default `protocol:auto` | Blocking defect: selects V2 from the dual legacy/V2 `/doc`; the V2 adapter then rejects core operations. |
| Legacy mutation receipt recovery | Durable local machinery exists, but real `1.18.18` did not persist/reflect `x-polyth-operation-id`; fake receipt recovery is not a live contract. |
| V2 HTTP API in OpenCode | Present under `/api/*` on the normal `opencode serve` process; client-chosen session IDs work in the one create probe. |
| V2 behavior in Polyth | Discovery/gating shell only. Models/agents/sessions return empty, history/SSE are unsupported, reconciliation is unverifiable/unknown, and every mutation rejects. |
| Shared/external runtime | Lease/lifecycle constructors and fake tests exist. Normal Polyth server boot exposes only owned local and owned SSH paths. |
| SSH | Owned remote `opencode serve` plus one local forward is implemented; tests use mock `RemoteHost`, not a live SSH host. |
| Reliability persistence | SQLite WAL operation state, queue reservation, response CAS, observation/checkpoint/cursor transactions, reconciliation barriers and deletion tombstones are implemented. |
| Real compatibility coverage | One skipped “real provider list” test exists. There is no checked-in full real CLI smoke, response-loss proxy run, shared-service run, or live SSH run. |

## Live OpenCode `1.18.18` observations

The audit started:

```text
/home/ubuntu/.local/bin/opencode serve --pure --hostname 127.0.0.1 --port 44991
```

Only bounded response excerpts and conclusions belong here; raw later-run output belongs
under `logs/opencode-real-world/`.

1. `opencode --version` returned `1.18.18`.
2. `opencode serve --help` supports `--hostname`, `--port`, `--mdns`,
   `--mdns-domain`, `--cors`, logging and `--pure`. It does **not** expose
   `--service`. The top-level CLI does expose `attach <url>`.
3. `GET /global/health` returned
   `{"healthy":true,"version":"1.18.18"}`. `GET /api/health` returned
   `{"healthy":true}`.
4. The same `/doc` advertised both legacy prompt paths
   (`/session/{sessionID}/prompt_async`, `/session/{sessionID}/message`) and V2 paths
   (`/api/session`, `/api/session/{sessionID}/prompt`, `/api/session/{sessionID}/event`,
   `/api/session/{sessionID}/history`, V2 pending/status endpoints).
5. Running Polyth's actual `protocol:auto` probe against that server selected `v2`.
   `createSessionOperation` then returned `capability-unsupported`; forced `legacy`
   selected legacy and created a session successfully.
6. A legacy `POST /session` carrying
   `x-polyth-operation-id: audit-create-op-001` succeeded, but neither its response nor
   `GET /session` contained `operationID`/`operationId`.
7. A legacy `POST /session/{id}/prompt_async` carrying
   `x-polyth-operation-id: audit-prompt-op-001` returned `204`; the completed upstream user
   and assistant message records contained no `operationID`/`operationId`. The model
   returned the expected marker, so this was an accepted, completed prompt rather than a
   validation failure.
8. Idle `GET /session/status` returned `{}`. Legacy `GET /permission` and
   `GET /question` returned arrays, but the responses supplied no completeness or causal
   watermark contract.
9. `GET /api/location` returned the active directory and project. V2
   `POST /api/session` accepted an explicit client session ID and returned that exact ID.
   This proves only create behavior for that one version; it does not prove duplicate-ID
   idempotency or any prompt/reply operation.
10. V2 `GET /api/session` returned `{data, cursor}` and included sessions created through
    the legacy surface. For the probed legacy-created session,
    `/api/session/{id}/history` returned `{data: [], hasMore: false}` despite completed
    legacy messages. Cross-surface list visibility therefore does not establish history or
    event semantic equivalence.
11. The installed `@opencode-ai/sdk` is `1.18.18` and exports `./v2`. Its generated V2
    types include client `id` for session create and prompt, paginated sessions, numeric
    history `after`, string event `after`, optional durable metadata, and `workspaceID`.
    Its installed `v2/server` declaration exposes `createOpencodeServer()` returning
    `{url, close()}`; it does not expose the `Service.discover/ensure/stop` interface
    discussed in the architecture research.

These probes do not establish permission/question causality, event retention, cursor
inclusivity, duplicate client-ID behavior, shared-service continuity, or mutation
idempotency. Those remain validation work.

## What V1 and V2 mean here

### “V1” in Polyth means the legacy adapter

The code calls it `legacy`, not `v1`. `protocolLegacy.ts` implements:

- `/provider`, `/agent`, `/session`, `/session/{id}/message`, `/session/status`,
  `/permission`, `/question`, and `/event`;
- session create/reset, positional fork with history verification, prompt/steer, abort,
  delete, permission reply, and question reply/reject;
- file/range attachment conversion, model/agent/thinking forwarding;
- pull reconciliation of history, pending requests and status; and
- normalized mutation outcomes (`confirmed`, `rejected`, `unknown`).

Legacy advertises no event replay, partial pending snapshots and no idempotent mutations.
Every adapter mutation uses `replay: never`. Prompt endpoint selection is read-only from
`/doc` and a failed operation never falls through to another prompt path.

“Full legacy mutation surface implemented” means code paths exist. It does not mean real
response-loss reconciliation is complete: the exact-operation evidence expected in session
and message records is absent in the live `1.18.18` probe. Without that evidence an accepted
create/prompt with a lost response must remain unknown.

### “V2” in Polyth means recognized but deliberately non-operational

`protocolV2.ts` detects `/api/session` plus `/api/session/{id}/prompt`, then:

- reports no event replay, no pending snapshot, and no idempotent mutations;
- returns empty model, agent and session lists;
- exposes no SSE path;
- rejects history as `capability-unsupported`;
- rejects create, reset, branch, prompt, steer, abort, delete and replies as
  `capability-unsupported`; and
- returns an empty, unverifiable snapshot with state `unknown`.

The public facade nevertheless returns fixed capabilities
`streaming/permissions/questions/compaction/subagents/steering: true` without consulting the
selected protocol. On a selected V2 adapter those claims are not operational. Empty V2
catalogs are also not authoritative evidence that OpenCode has no models/sessions.

### What OpenCode actually ships

OpenCode `1.18.18` ships legacy and beta V2 HTTP surfaces on the same ordinary server and a
generated V2 SDK. The CLI does not provide the researched `serve --service` switch, and the
installed SDK declaration does not provide `Service.ensure()` discovery ownership. Thus:

- presence of `/api/*` is real, but does not make Polyth V2-capable;
- presence of both surfaces makes current Polyth auto-negotiation unsafe;
- `attach` and mDNS are not by themselves an authoritative service discovery/ownership
  contract; and
- a generated optional field is evidence to test, not a pinned semantic guarantee.

## Actual implementation by subsystem

### Runtime, endpoint and ownership

- `runtime.ts` composes one endpoint, resolved authentication headers, transport and
  protocol into an atomic generation. Replacement aborts old streams, rebuilds the complete
  generation and fences late HTTP/reconciliation/SSE results.
- Owned local leases spawn `opencode serve`, use a cwd-hashed private JSON PID record, verify
  process start/executable/command identity before every signal, retry bind collisions and
  expose exact-instance restart.
- Owned SSH leases control an exact remote child and local forward but have read-only local
  config authority.
- Borrowed shared/external leases have no stop/restart/config capability. Shared descriptors
  may rotate URL, headers, authority and instance identity; external URLs only rotate
  generation when referenced credential values change.
- Production `packages/server/src/index.ts` creates owned local runtimes or owned SSH
  runtimes based on project binding. It has no configuration path that constructs
  `createBorrowedServiceEndpointLease` or `createBorrowedExternalEndpointLease`.
- All production local/SSH endpoint continuity is `generation-only`. `verified` continuity
  is currently supplied only by tests or a future borrowed descriptor.

### REST, mutations and SSE

- Queries retry transient network/deadline failures up to three attempts inside one absolute
  deadline.
- Mutations are one attempt by default and always carry `x-polyth-operation-id`.
  Replay exists only for PUT/PATCH with `same-operation-id` and an exact
  `pinnedReplayContracts` entry. Production supplies no pinned contract, so no production
  mutation is replayable.
- Complete validation/auth/not-found/conflict/unsupported legacy responses can reject.
  Socket/deadline/unrecognized success/unclassified 5xx outcomes are unknown.
- SSE has no REST deadline and reconnects with 500 ms exponential backoff capped at 5 s.
  Endpoint refresh occurs after disconnect. The optional silent-stream liveness timer is
  disabled by default and normal server construction does not set it.
- Legacy event replay is declared `none`. The runtime does not pass a stored `after` cursor
  when reconnecting the global legacy stream; recovery depends on pull reconciliation.
- In-memory SSE event-ID dedup is bounded to roughly 8,000 IDs and scoped by
  authority/generation. Durable semantic observation identity is separate and must carry
  cross-channel correctness.

### Reconciliation, attention and terminal state

- First wire, lifecycle notifications and unknown mutations enter a durable reconciliation
  barrier. Unsafe admission is blocked while state is reconciling/unknown or an operation is
  unresolved.
- Legacy pull fetches status, up to 1,000 messages, permissions and questions in parallel.
  All three snapshot domains are marked `partial`; absence cannot close attention.
- Busy/running is positive evidence. Idle/failed/interrupted requires a numeric comparable
  revision. The live idle `1.18.18` status response was `{}`, so a rebuilt adapter generally
  cannot prove idle from this endpoint. The in-memory fresh-create causal shortcut is lost
  when the protocol adapter is rebuilt.
- Permission/question discovery is durable before display. A SQLite response-intent CAS
  picks one winner. Unknown replies remain blocking; pending-list presence/absence alone
  cannot prove application or non-application.
- SSE and pull observations use binding/generation/reconciliation fences and transactionally
  persist semantic claim, canonical events, checkpoints and cursor. Divergence becomes
  `reconciliation/uncertainty-recorded`.

### Queue, event store and crash recovery

- `node:sqlite` runs WAL with `synchronous=NORMAL`. Canonical events are append-only during
  normal operation; hard session deletion transactionally removes session rows while a
  separate binding tombstone prevents upstream resurrection.
- Runtime operations are prepared and attached to owning intent in one transaction, then
  claimed before I/O. Startup converts every surviving `executing` operation to `unknown`
  and projects affected non-archived sessions as `unknown`.
- Queue dispatch atomically reserves the existing FIFO head and creates its operation.
  Confirmation removes it; proved rejection/non-application releases it; ambiguity keeps it
  and blocks later rows.
- Reconciliation and observation state are durable, but runtime locks and in-memory
  canonical/backend maps are not. Restart correctness therefore depends on binding recovery
  and real upstream evidence.

### Config, worktrees and SSH

- Config writes are atomic and ownership-scoped; JSONC comments/bytes survive semantic
  no-ops, and unowned fields are preserved through supported edits.
- Behavior writes apply directly because the behavior revision is logged at turn admission.
  MCP/plugin/provider/agent changes are staged. A global admission barrier plus each owned
  lifecycle replacement lock spans fresh safe-idle reconciliation, writes, restart and
  post-restart reconciliation.
- Only live owned-local config targets register as restartable. SSH and borrowed endpoints
  are read-only.
- Runtime pool keys use resolved cwd; session runtime, attachments, shell, fork and
  reconciliation prefer the projection's `worktreePath`. Worktree creation validates
  membership once. `markWorktreeMissing` changes projection state but no torture test proves
  every later action refuses a deleted path without fallback or TOCTOU.
- SSH startup probes standard non-interactive install paths, validates the remote directory,
  starts a tokenized remote child, opens one forward, bounds orchestration waits and attempts
  identity-safe cleanup. Existing tests mock this transport.

## Code-versus-document discrepancies

Later agents must treat these as ground truth until a newer live probe and code change
supersede them:

1. **“Approved legacy P0 scope is complete” is not an operational compatibility result.**
   `FAILURE-MATRIX.md` says the legacy scope is complete, but default `auto` selects disabled
   V2 on the real dual-surface `1.18.18` document. Normal server boot does not force legacy.
2. **Exact-receipt reconciliation is fake-backed, not live-backed.** The failure matrix says
   lost create/prompt responses reconcile by exact operation receipt. `fakeOpenCode.ts`
   copies the private header into `session.operationID` and `message.info.operationID`.
   Real `1.18.18` did not do so for the tested create or completed prompt.
3. **The fake changes the upstream contract it is meant to model.** Its lifecycle explicitly
   persists `x-polyth-operation-id`. Tests proving unknown-to-confirmed settlement therefore
   prove Polyth's handling of hypothetical evidence, not evidence that OpenCode emits.
4. **Auto negotiation prioritizes recognizability over usability.** `protocol.ts` chooses V2
   whenever the dual `/doc` has two V2 paths, before considering verified legacy prompt
   paths. It does not check that required V2 capabilities are enabled.
5. **Facade capabilities can contradict the selected protocol.** Fixed `true` capabilities
   are returned even when V2 has no stream and rejects every mutation.
6. **Shared/external support is not product-wired.** Documentation describes borrowed
   rotation/no-stop as landed. That is true only at contracts/lease/lifecycle/test level;
   the server composition root cannot select a borrowed runtime.
7. **The researched V2 service API is not installed API surface.** The implementation plan
   discusses `Service.discover/ensure/stop`; the installed `1.18.18` CLI/SDK inspected here
   exposes no such interface. Do not substitute `--mdns` or `attach` without a pinned
   ownership/continuity contract.
8. **Legacy terminal authority is safe but presently insufficient for restart convergence.**
   Docs correctly require comparable revisions, but real idle status was empty. A claim that
   reconnect/restart reaches safe idle needs a live source of ordered evidence; current
   deterministic fakes manufacture numeric revisions.
9. **Silent SSE recovery is not on by default.** The E2E silent-stream test passes an
   explicit `sseStallMs`; production server construction does not. A connected but silent
   broken legacy stream may not trigger lifecycle reconciliation.
10. **The required mutation matrix was not completed.** The implementation plan requires
    response-loss faults for create/reset/fork/prompt/steer/abort/delete/permission/question.
    Existing E2E coverage concentrates on create/prompt, queue, and selected permission
    logic; real question/fork/abort/delete ambiguity remains open.
11. **The required real compatibility smoke is absent.** The implementation plan calls for
    negotiation, prompt, event, pending/reply, interrupt and ownership checks against each
    pinned CLI. The only real test found is a skipped provider-list smoke.
12. **Worktree and endpoint tests prove synthetic isolation, not filesystem/process races.**
    Fake servers and injected locations do not cover deletion after validation, same-path
    runtime creation races, or real child ownership transfer.

## Environment constraints

- Repository engines and `.nvmrc` require Node `>=22.18.0`. The default shell resolved
  `/exec-daemon/node` `v22.14.0`, which cannot load `.ts` through Node type stripping and
  fails repository preflight. A usable installed runtime exists at
  `/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node`; validation agents must activate it
  explicitly and record the selected binary.
- OpenCode is at `/home/ubuntu/.local/bin/opencode`; the SDK inspected above is under
  `/home/ubuntu/.opencode/node_modules/@opencode-ai/sdk`.
- The live server warned that `OPENCODE_SERVER_PASSWORD` was unset and was therefore
  unsecured. Network-fault runs must bind loopback or set redacted test credentials.
- Starting with a nominally separate `OPENCODE_CONFIG_DIR` still logged reads of global
  files under `/home/ubuntu/.config/opencode`. Real tests must isolate HOME/XDG paths and
  verify loaded config paths rather than assume one environment variable gives isolation.
- Provider availability is environment-specific. The audit had connected providers and
  completed one marker prompt, but no credential or provider state may be copied into
  committed artifacts.
- No real SSH host or authoritative V2 shared-service controller was available in this
  audit. Those scenario results remain unexecuted.

## Immediate gate for later agents

Run `OC-REAL-026` before all other compatibility work. Then preserve two separate reports:

1. **product-default result** using `protocol:auto` (currently blocked by disabled V2
   selection); and
2. **forced-legacy diagnostic result** used to characterize the remaining legacy surface.

Do not mark a forced-legacy pass as product readiness, do not resolve ambiguity through
title/text similarity, and do not cite the fake's operation reflection as OpenCode behavior.
