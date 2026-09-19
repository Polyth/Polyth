# Antigravity harness (Google Gemini)

Autonomous `@polyth/backend-antigravity` server package. It registers the
`antigravity` harness on enable and unregisters/disposes its owned runtimes on
disable. It adds no vendor dispatch to the canonical session service and does
not replace the existing Gemini API provider. Automatic harness selection does
not select it by default.

## Setup

Install the current Google Antigravity CLI on the machine running the Polyth
server. Run `agy` interactively once as the same OS user to complete Google's
native sign-in. Check `agy --version` and `agy models`, then select **Antigravity**
in Polyth's existing harness/model picker. Use `POLYTH_ANTIGRAVITY_BIN` only when
the executable is outside normal discovery paths. Restart Polyth after changing
its server environment.

Polyth never copies Google credentials, provisions an OAuth client, or assumes
that a paid Google subscription includes API credits. The account and access
rules remain those of the installed CLI. The non-billing version/catalog probes
report authentication as unknown; native initialization verifies actual access.

## Protocol and ownership

One supervised Polyth worker owns the native CLI leg for each canonical runtime.
It runs `agy --input-format stream-json --output-format stream-json` and replaces
only the idle native leg when the effective Auto-Approve setting changes. With
Auto-Approve on, the launch includes the literal
`--dangerously-skip-permissions` flag; with it off, that flag is absent and the
native init must confirm `request-review`. `--sandbox` is never passed in either
mode. Prompts and worker controls use NDJSON over owned pipes, never shell
command interpolation. Model, effort (`low`, `medium`, `high`) and optional
native agent remain launch arguments; model IDs come from `agy models`, not a
hardcoded or stale fallback list.

The CLI is launched with a private per-runtime `HOME` whose Gemini `config`
directory lives in the Space runtime directory; the rest of the user's home,
including `~/.gemini/antigravity-cli` (authentication and native conversations),
is linked rather than copied. The Antigravity CLI only reads MCP servers from
`$HOME/.gemini/config`; its workspace `.agents/plugins` `mcp_config.json` is not
loaded (verified against CLI 1.2.7), so this private config is the path that
carries Polyth's MCP projection.

Polyth records the native conversation ID from `init` and resumes only that
Space/project/session's recorded ID using `--conversation`. It never uses
ambient `--continue`. Canonical history, worktrees and the UI remain
Polyth-owned; the adapter reads the CLI's generated per-conversation title
metadata (`~/.gemini/antigravity-cli/annotations/<id>.pbtxt`) to publish a
native title, and never imports the native transcript. Native history import,
exact-history reset and fork are unsupported.
A harness switch or runtime recovery therefore starts a fresh Antigravity
conversation through the normal create-session operation and supplies bounded
canonical Polyth continuity separately; it never pretends that the native
history was copied.
A fresh runtime is required after abort/disconnection; uncertain prompt delivery
is not automatically retried. A changed live model/effort/agent is explicitly
rejected with a new-session instruction rather than silently ignored.

Durable input intent precedes stdin. Native step/result evidence is required
before confirming admission; known receipts are idempotent, and uncertain sends
stay uncertain across restart. Conversation, workspace, authority and generation
checks reject foreign observations. EOF, an exit code, or a signal alone cannot
prove execution release. Abort/disposal use the shared process-tree authority;
unproved release stays blocked. Crash-safe cross-harness release requires Linux;
macOS/Windows retain the shared portable authority's explicit crash-fence limits.

## Supported output and honest limits

- Public response streaming, tool calls/results/errors and native subagent
  activity references use existing Polyth timeline events. A tool step that
  streams its arguments across frames accumulates them, and the complete
  object is attached to the terminal `tool/result` so file edits
  (`replace_file_content`, `multi_replace_file_content`, `write_to_file`,
  `sed_file`, `notebook_edit`) carry the path and before/after content Polyth
  needs for diff rendering and changed-file tracking. The native
  `[diff_block_start]` result text is preserved as tool output. A finished
  spawn step does not falsely mark the child completed. Native hidden
  thinking/checkpoint text is not rendered as dialogue.
- Session-cumulative token counters become per-turn deltas. On the first resumed
  turn, where the old baseline is unavailable, only observed final-step usage is
  counted. No fabricated cost, subscription price or context-window figure.
- Native quota, rate-limit and overload failures preserve the provider message
  and enter Polyth's normal limit-recovery flow. Reset timestamps or durations
  reported by the CLI drive the visible countdown; otherwise Polyth uses its
  standard bounded-backoff timer. Current structured `AGY_ERROR` diagnostics
  are reduced to non-sensitive status/timing fields instead of persisting raw
  stderr, which may contain credentials, authentication URLs or native prompts.
- Text prompts and Polyth's existing text-file projection work. Native image,
  PDF, audio and URL blocks are not advertised. Unsupported input fails before
  delivery instead of disappearing silently.
- The stream protocol has no interactive permission reply channel, so Polyth
  supplies a runtime-private `PreToolUse` hook. Standard reads and edits whose
  resolved paths stay inside the canonical workspace are allowed by default;
  traversal, symlink escape, commands, network/research tools, subagents and
  other actions become ordinary Polyth `permission/requested` events. With
  Auto-Approve off, existing Polyth allow/deny rules handle those requests
  before the user sees the normal approval card. Auto-Approve bypasses that
  review path completely. Hook or bridge failure denies the call. The hook is
  re-materialized before every turn and the native CLI still runs in
  `request-review` while Auto-Approve is off, so a missing bridge does not turn
  into the dangerous launch mode. Turning Auto-Approve on is exactly the native
  all-tools bypass on the next native launch; turning it off replaces that idle
  leg before the next prompt. No Antigravity sandbox is used. An unexpected
  native soft-denial is preserved in activity; an empty `SUCCESS` after only
  proven denials becomes a failed turn instead of a silent stop. Native slash
  commands, question replies and steering are not implemented; Polyth MCP tool
  injection (including `@polyth/browser` via `polyth_browser` and the scoped
  `polyth-agent-tools` bridge) is materialized into the private per-runtime
  `~/.gemini/config/mcp_config.json`, merged with the user's own global MCP
  servers, and gated through the permission bridge. The user's native global
  config is linked, not modified, so a session's bearer token never enters a
  shared or user-visible file. The private home links the real home's entries
  instead of copying them; where a platform cannot create a link (for example an
  unprivileged Windows file symlink on another volume), that entry is left
  absent, so a tool that reads it may not see the user's configuration.
- A step the native CLI ends in a failure state (`ERROR`, `INVALID`, `HALTED`,
  `CANCELED`, `INTERRUPTED`) becomes a `tool/error` (or finalizes text it had
  already streamed) and never aborts the canonical turn or disconnects the
  runtime; only a terminal native error result does. Transitional and
  unrecognized step states are ignored forward-compatibly, and a tool call the
  CLI never terminates is closed as an error when the turn result arrives.
  One logical `invoke_subagent` call can arrive as a `tool` proposal step and
  then a `subagent` spawn step at the same index; settling the spawn closes the
  proposal as a result, so a successful delegation is never misreported as an
  unterminated tool error.
- Native subagents/tools configured in Google's CLI can run, but Polyth does
  not manage their definitions or promise live child completion tracking.
- This version executes on the local Polyth server, not an SSH project runtime.
  Mobile/web clients use the normal Polyth server connection.

## Verification

From the repository root, with the normal workspace dependencies installed:

```sh
npm run build:supervisor
node --experimental-strip-types --test packages/backend-antigravity/test/*.test.ts
npx --no-install tsc --noEmit -p packages/backend-antigravity/tsconfig.json
node --experimental-strip-types --test packages/harness-runtime/test/features.test.ts packages/harness-runtime/test/registry.test.ts packages/harness-runtime/test/telemetry.test.ts packages/harness-runtime/test/executableDiscovery.test.ts
```

The protocol/runtime fixtures exercise fragmented Unicode/NDJSON, bounded
frames, duplicate results, cumulative usage, admission races, foreign
conversations, lost initialization, native error-state steps (denial /
interruption), unterminated tool calls, failed release, recorded resume and
uncertain replay. Package tests exercise discovery, lazy enable/disable,
Space/remote gates and the workspace lock. Fixtures are not a live Google
account verification.
No provider login, paid prompt, physical-device test or live model turn is
claimed. MCP discovery was live-checked against Antigravity CLI 1.2.7 with a
local stdio probe: the private home's `~/.gemini/config/mcp_config.json` server
was spawned at startup, `agy models` authenticated through the linked app data,
and no model turn was sent.

Protocol reference, checked 2026-09-19:
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/cli/install/

Keep the parser, fixtures and this support matrix aligned when the upstream
CLI wire format changes; do not infer adapter support from model marketing.
