# OpenCode hardening

This directory records the durable OpenCode compatibility contract. Runtime
captures, HTTP/SSE dumps, process timelines, database snapshots, and individual
validation runs are intentionally excluded from the repository.

## Architecture

`packages/backend-opencode` is the only OpenCode integration boundary:

- `endpoint.ts` owns runtime identity, generations, credentials, and exact
  child/forward lifecycle.
- `runtime.ts` binds one endpoint generation to one transport and protocol
  adapter and fences stale work before it reaches the adapter.
- `protocolLegacy.ts` and `protocolV2.ts` normalize protocol-specific reads and
  mutations into provider-neutral contracts.
- `events.ts` normalizes live and pulled observations into stable semantic
  identities before the session store claims them.
- `packages/server/src/sessions.ts` persists runtime bindings and model-visible
  events before broadcasting them.

An authority identifies one logical runtime. A generation identifies one
incarnation of that authority. Durable owned-runtime state includes a
deterministic identity fingerprint; changing the local runtime binding or SSH
connection/path rotates authority instead of carrying backend session IDs into
an unrelated OpenCode instance. Generation allocation is serialized by a
crash-atomic SQLite `BEGIN IMMEDIATE` transaction and committed before startup,
so crashes may consume a generation but cannot reuse it.

Persisted sessions may cross a generation only when authority, protocol,
location, backend session ID, and verified continuity all match. Endpoint
ownership alone is not continuity proof. Old callbacks remain fenced by their
captured authority and generation.

## Transport diagnosis and recovery

REST transport failures carry a typed component and operation. The HTTP
envelope adds a request ID, retryability, recovery state and mutation outcome;
it does not expose runtime authority or generation. Browser-to-Polyth errors,
provider failures, authentication, validation and storage failures do not
trigger generic OpenCode reconnect copy. An unknown mutation never grants
permission to retry it; pinned replay and operation reconciliation still own
that decision.

Each physical lifecycle owns one bounded verification episode, even when SSE
remains connected. A local protocol health/control probe does not run a paid
turn. A failed probe enters existing refresh/restart machinery; an owned
restart still requires its exact containment boundary and durable release
proof, and borrowed runtimes are never killed. At most three episodes run
without recovery, separated by a five-second cooldown. A healthy probe leaves
the failed operation degraded until that operation succeeds. Parser/auth
failures do not become restart evidence.

SSE is connected only after successful response headers with the event-stream
content type. Handshake waits are bounded to ten seconds; unfinished frames
to thirty seconds and eight MiB. Comments count as transport activity.
Exponential backoff has jitter and a cancellable wait, resets only after ten
seconds of successful connection, and stops on dispose or stale generation.
Idle thinking, tool and permission waits do not establish a hung runtime.

Facade disposal fences queued callbacks and clears its own listeners, timers,
translation state and reverse mappings. The pool's supplied canonical-to-native
mapping is caller-owned and survives facade disposal. Confirmed session deletion
also releases that session's translation state; uncertain deletion does not.

Runtime storage sweeping retains the existing TTLs and requires a removal
lease. Missing cwd alone is not release proof. The server's periodic Linux
quarantine owner checks at most 32 entries per tick (hard cap 64), yielding
after a 40 ms work budget, with one job and a cancellable one-minute schedule.
The cursor advances across ticks, including past ineligible entries. Snapshot
diagnostics read bounded counters/state without scanning storage.

Deletion holds both the physical pool key and the canonical reference fence.
An exact authority/generation must have durable release evidence. Existing
references, unresolved mutations or an unrepaired reference index block GC;
new create/rebind writes cannot enter the protected checkout during removal.
Legacy metadata without a generation and platforms without the directory-FD
boundary fail closed. No process is killed to make storage eligible.

Only old, regular `opencode.db`, `-wal` and `-shm` files inside an eligible
quarantine directory are removed. Young/modified payloads, unexpected entries
and symlinks are retained. Pinned directory descriptors prevent replaced
parents from redirecting deletion. Live DBs, authority receipts and canonical
storage are excluded. Whole-runtime directory sweeping remains disabled at
startup because its broader evidence-retention lease is not implemented.

## Validation policy

Automated regressions live in `packages/backend-opencode/test` and
`packages/server/test`. Tests create transient state under the operating
system's temporary directory. `packages/backend-opencode/test/fakeOpenCode.ts`
is the single reusable HTTP/SSE fault-injection harness. The compact, redacted
V2 model fixture under `packages/backend-opencode/test/fixtures` is the only
retained capture.

Manual or real-OpenCode validation must write to `$TMPDIR` by default. Preserve
output only when an explicit external output directory is supplied; do not
write run evidence into the repository.

See:

- `COMPATIBILITY.md` for the supported protocol surface.
- `RELEASE-GATE.md` for current acceptance status.
- `FAILURE-MATRIX.md` for scenario-to-test coverage.
- `UPSTREAM-ISSUES.md` for known OpenCode limitations.
