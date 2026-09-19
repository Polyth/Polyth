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

One owned child process runs
`agy --input-format stream-json --output-format stream-json` per canonical
runtime. Prompts go through stdin, never shell command interpolation. Model,
effort (`low`, `medium`, `high`) and optional native agent are launch arguments;
model IDs come from `agy models`, not a hardcoded or stale fallback list.

Polyth records the native conversation ID from `init` and resumes only that
Space/project/session's recorded ID using `--conversation`. It never uses
ambient `--continue`. Canonical history, worktrees, titles and the UI remain
Polyth-owned. Native history import, exact-history reset and fork are unsupported.
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
  activity references use existing Polyth timeline events. A finished spawn step
  does not falsely mark the child completed. Native hidden thinking/checkpoint
  text is not rendered as dialogue.
- Session-cumulative token counters become per-turn deltas. On the first resumed
  turn, where the old baseline is unavailable, only observed final-step usage is
  counted. No fabricated cost, subscription price or context-window figure.
- Text prompts and Polyth's existing text-file projection work. Native image,
  PDF, audio and URL blocks are not advertised. Unsupported input fails before
  delivery instead of disappearing silently.
- The stream protocol has no interactive permission/question reply channel.
  Native policy remains in force: no automatic permission bypass, no fake
  approval buttons. Tool permission denial is preserved in activity. Native
  slash commands, steering and Polyth MCP injection are not implemented.
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
conversations, lost initialization, failed release, recorded resume and uncertain
replay. Package tests exercise discovery, lazy enable/disable, Space/remote gates
and the workspace lock. Fixtures are not a live Google account verification.
No provider login, paid prompt, physical-device test or live `agy` run is claimed.

Protocol reference, checked 2026-09-19:
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/cli/install/

Keep the parser, fixtures and this support matrix aligned when the upstream
CLI wire format changes; do not infer adapter support from model marketing.
