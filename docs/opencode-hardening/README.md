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
