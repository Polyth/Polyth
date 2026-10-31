# Command Code package-tool boundary

Status: normative addendum to `commandcode-harness.md` for Polyth-contributed package tools.

This document exists because Command Code has two distinct permission layers:

1. Command Code authorizes a custom Mod tool before its `run()` implementation is entered.
2. Polyth authorizes the package tool again at the canonical AgentTool execution boundary.

Those layers must not be conflated.

## Supported today

Only Polyth tools whose capability descriptor has `mutating: false` are projected into Command Code.

For each admitted turn:

- the provisioner generates a transient Mod containing the tool id, name,
  description and JSON input schema;
- the Mod registers the tool through documented `cmd.addTool(...)` with
  `readOnly: true`;
- the generated Mod contains no AgentTool URL, bearer token or other secret;
- tool calls cross private fd3/fd4 to the Polyth-owned worker;
- the worker accepts only capability ids in the exact projected allowlist for
  that turn;
- the scoped AgentTool bearer remains in Polyth-controlled memory;
- the worker calls the loopback `/internal/agent-tools` authority directly;
- that authority revalidates the grant, semantic capability revision, active
  canonical session, Polyth permission policy and live contribution before the
  package executor runs.

A native tool name is presentation metadata, not authority. Execution and
application evidence are bound to the capability id.

## Mutating tools are intentionally unsupported

Command Code applies its own native permission engine to every tool call before
a custom Mod tool's `run()` executes. Polyth normally launches headless turns in
`dont-ask` unless canonical auto-accept is enabled. A mutating custom tool can
therefore be denied by Command Code before Polyth receives the invocation.

Polyth must not claim an interactive approval path that it cannot reach.
Consequently, a `mutating: true` package-tool capability is recorded as
`unsupported` by the Command Code provisioner and is omitted from:

- the generated `cmd.addTool` Mod;
- the worker capability allowlist;
- Command Code-visible package-tool schemas.

This can be revisited only when a documented transient Command Code surface can
delegate or bridge the native pre-run permission decision without rewriting
user/project permission configuration and without weakening fail-closed policy.

## Evidence rules

Admission of the transient tool Mod proves only that its revision was staged; it
is initially `unverifiable`.

A tool becomes `applied` only after the worker observes a response from the
canonical AgentTool route that proves the exact capability reached authorization
or execution:

- HTTP 2xx;
- `permission-required`;
- policy `forbidden` after scoped identity checks;
- `tool-failed` from the package executor.

The following are not invocability evidence and must never promote the
capability:

- invalid bearer / HTTP 401;
- missing tool / HTTP 404;
- `stale-capability`;
- `session-unavailable`;
- transport failure or cancellation before an authoritative response.

A Command Code `mod_error` for `mod:polyth-tools` marks the exact admitted tool
revision failed. If that failure arrives before the turn-admission RPC returns,
the later admission settlement must not downgrade it back to `unverifiable`.

## Secret and transport constraints

The AgentTool URL/token must not appear in:

- generated Command Code Mod files;
- Command Code environment variables;
- canonical session events;
- tool schemas or model-visible text.

The worker accepts only an HTTP(S) loopback AgentTool endpoint at the canonical
`/internal/agent-tools` path. The private fd relay is bounded, cancellable and
closed with the native turn.

Vendor MCP configuration is unrelated to this bridge. Polyth package tools do
not require writing Command Code MCP settings, and Polyth-managed transient
vendor-MCP projection remains unsupported.