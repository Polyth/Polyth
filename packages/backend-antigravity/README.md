# Antigravity harness (Google Gemini)

Autonomous `@polyth/backend-antigravity` server package. It registers the
`antigravity` harness on enable and unregisters/disposes its owned runtimes on
disable. It adds no vendor dispatch to the canonical session service and does
not replace the existing Gemini API provider. Automatic harness selection does
not select it by default.

## Setup

The Google Antigravity CLI must be on the machine running the Polyth server.
**Settings → Harnesses → Antigravity** installs it in one click with Google's
official installer, run unattended as the server's OS user (no sudo or
administrator rights; the script checks the download's SHA-512 against the
release manifest and exits early if `agy` is already present). To install by
hand instead:

- macOS / Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  (installs `~/.local/bin/agy`)
- Windows (PowerShell): `irm https://antigravity.google/cli/install.ps1 | iex`
  (installs `%LOCALAPPDATA%\agy\bin\agy.exe`)

Polyth finds both locations without a PATH change. Then run `agy` interactively
once as the same OS user to complete Google's native sign-in — installation does
not sign in. Check `agy --version` and `agy models`, then select **Antigravity**
in Polyth's existing harness/model picker. Use `POLYTH_ANTIGRAVITY_BIN` only when
the executable is outside normal discovery paths. Restart Polyth after changing
its server environment. Settings compares `agy --version` with the release
manifest the installers read and offers `agy update` when a newer build exists.

Polyth never copies Google credentials, provisions an OAuth client, or assumes
that a paid Google subscription includes API credits. The account and access
rules remain those of the installed CLI.

Authentication is reported from evidence, never guessed. `agy --version`
answers identically with an empty home, so the cheap version probe cannot see
credentials and stays `unknown`. `agy models` is the opposite: the CLI refuses
to list a single model until the account is signed in, so a non-empty parsed
catalog is positive proof. Model-catalog discovery therefore reports
`authenticated: true` and `ready`, and that proof is then reused by the cheap
probe for the same Space, project, workspace and binary. The two windows are
deliberate and different: a cached model list becomes refresh-eligible after 30
seconds, while the account fact expires five minutes after the successful
catalog check, matching the registry's detail-cache window. A forced re-check clears
the claim and proves the account again, another Space or project never inherits
it, and an older in-flight catalog cannot restore proof after invalidation.
A failed catalog check or scope eviction also revokes any older cached proof
for that scope, including while a newer refresh is pending. The account proof
is bounded; the UI's displayed snapshot can additionally lag by its refresh
interval or remain visible while offline. It is not a live sign-in guarantee. A catalog failure still
propagates, so the CLI's own sign-in wording becomes the "Sign in required"
state instead of a ready-looking row. No probe here spends a paid prompt, and
actual access is still verified by native initialization.

## Protocol and ownership

One supervised Polyth worker owns the native CLI leg for each canonical runtime.
It runs `agy --input-format stream-json --output-format stream-json` and
replaces that leg — on a stop, after the leg exits, or when the launch-mode
flag changes — while keeping one durable process authority for the canonical
session. Because the headless CLI cannot answer an approval prompt and never
converts a `PreToolUse` `allow` into a grant, the launch always carries the
literal `--dangerously-skip-permissions` flag and the native init must confirm
`always-proceed`; the adapter still supports the flagless `request-review`
launch, but no Polyth setting selects it, because that mode auto-denies every
gated tool. The flag is a launch mode, not an approval. The runtime-private
`PreToolUse` bridge is installed in **both** modes and is the enforcement
point: it denies native delegation (and beta-mode mutations), allows workspace
reads/edits and the turn's own staged attachments, and sends every other tool
to Polyth as a canonical permission request. Polyth answers it with the
session's rules, Auto-Approve (which never answers a high-risk request), or a
person; the hook allows or denies accordingly and fails closed on any bridge
error. `--sandbox` is never passed. The same private `hooks.json` also registers `PreInvocation` and `Stop`
handlers (the flat handler form of the CLI's hooks contract). Every hook
command names its event, the generated client rebuilds each reply per event so
no unexpected field reaches the CLI's parser, and the model's final text is
stripped before a `Stop` payload crosses the socket. A tool gate fails closed;
the loop events fail open (no injected step, a normal stop).
Prompts and worker controls use NDJSON over owned pipes, never shell command
interpolation. Model, effort (`low`, `medium`, `high`) and optional primary
native agent remain launch arguments; model IDs come from `agy models`, not a
hardcoded or stale fallback list. `agy models` lists each effort as its own ID
(`gemini-3.8-flash-high`, `gemini-3.8-flash-low`, …). The catalog groups those
rows into one model per base slug (`gemini-3.8-flash`, label without the
`(High)` suffix) whose `variants` are exactly the efforts the CLI listed for it
(`gemini-3.1-pro` offers only `low`/`high`, `gpt-oss-120b` only `medium`); the
default is `high` when listed. A grouped selection launches as
`--model <base> --effort <variant>`. A model without effort levels
(`claude-sonnet-4-6`) stays a single row and never gets `--effort`. Sessions
pinned to a legacy suffixed ID keep launching it unchanged: that ID needs no
flag, and a conflicting remembered effort is rejected before launch with the
catalog entry to pick instead (the CLI refuses it too).

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
A harness switch or a new process authority therefore starts a fresh Antigravity
conversation through the normal create-session operation and supplies bounded
canonical Polyth continuity separately; it never pretends that the native
history was copied.

Stopping a turn terminates the native process group only. The worker proves that
tree released, keeps the authority's containment boundary, and relaunches the
recorded conversation with `--conversation` on the next turn, so a stop (or the
tool watchdog's abort) no longer leaves the canonical session permanently
answering `runtime-unavailable`. A native leg that exits on its own is reported
and recovered the same way; the interrupted turn is terminalized and never
replayed, and the relaunched leg restarts its usage/step/turn baselines exactly
like a resume. Only a lost worker, an unproved release or a protocol failure
still fences the runtime, and that case needs a fresh runtime. Uncertain prompt
delivery is not automatically retried. A changed live model/effort/agent is
explicitly rejected with a new-session instruction rather than silently ignored.

Session start is a handshake, not a race. The worker waits a bounded grace for
the CLI's own `init` frame before falling back to the CLI 1.2.10 content-less
initialization probe, so a modern CLI keeps one healthy native leg that takes
the first turn directly. When the probe is used, that leg is disposable: a real
prompt that arrives while it is still open replaces the leg and relaunches the
pinned conversation instead of being written into a leg that is already
exiting. The runtime accepts a well-formed same-conversation replacement
initialization whether or not it requested one, validating the replacement's
own confirmed permission mode, conversation ID, model and agent. This closes
the window where the first turn of a new session could be rejected as an
unexpected replacement initialization.

Durable input intent precedes stdin. Native step/result evidence is required
before confirming admission; known receipts are idempotent, and uncertain sends
stay uncertain across restart. Conversation, workspace, authority and generation
checks reject foreign observations. EOF, an exit code, or a signal alone cannot
prove execution release. Abort/disposal use the shared process-tree authority;
unproved release stays blocked. Crash-safe cross-harness release requires Linux;
macOS/Windows retain the shared portable authority's explicit crash-fence limits.

## Supported output and honest limits

- Public response streaming and tool calls/results/errors use existing Polyth
  timeline events. A tool step that
  streams its arguments across frames accumulates them, and the complete
  object is attached to the terminal `tool/result` so file edits
  (`replace_file_content`, `multi_replace_file_content`, `write_to_file`,
  `sed_file`, `notebook_edit`) carry the path and before/after content Polyth
  needs for diff rendering and changed-file tracking. The native
  `[diff_block_start]` result text is preserved as tool output. Native hidden
  thinking/checkpoint text is not rendered as dialogue.
- Session-cumulative token counters become per-turn deltas. On the first resumed
  turn, where the old baseline is unavailable, only observed final-step usage is
  counted. Context occupancy is `derived`: each settled model call's
  `input_tokens` (its whole prompt) is published as the used context. The
  headless CLI reports no context-window size, cost or compaction trigger, so
  no limit, fraction, cost or subscription price is fabricated. The CLI still
  compacts long conversations on its own: its transcripts record the summary
  as a `SYSTEM` `CHECKPOINT` step. A settled `checkpoint` step is recorded as
  `session/compacted` with the compaction time, occupancy becomes unknown until
  the next model call reports its prompt size (the checkpoint's own call read
  the pre-compaction conversation), its tokens still count toward usage, and
  its summary text is never shown as dialogue.
- Native quota, rate-limit and overload failures preserve the provider message
  and enter Polyth's normal limit-recovery flow. Reset timestamps or durations
  reported by the CLI drive the visible countdown; otherwise Polyth uses its
  standard bounded-backoff timer. Current structured `AGY_ERROR` diagnostics
  are reduced to non-sensitive status/timing fields instead of persisting raw
  stderr, which may contain credentials, authentication URLs or native prompts.
- Attachments are `emulated`. Stream-json input is text-only (CLI 1.2.9 and the 1.2.11 recheck end the
  session on any non-`text` content block), but the CLI's own `view_file`
  reads images, PDFs and audio as model media and `read_url_content` fetches a
  link. Polyth copies each image/PDF/audio attachment (including a browser
  capture) into `<hook root>/attachments/<turn>/` — private `0700`/`0600`,
  inside the `--add-dir` root, with the canonical extension for its MIME — and
  the `PreInvocation` hook injects `view_file`/`read_url_content` tool calls
  before the turn's first model call. The prompt also lists every staged path
  and link, so a model can open one itself if a CLI version ignores injected
  steps. Ref paths must resolve (after symlinks) inside the session workspace
  or its selected repository; limits are 16 attachments, 64 MB per file and
  128 MB per message, and the newest 24 turn directories are retained so a later
  turn can reopen an earlier attachment. Text files keep Polyth's server-side
  text projection. `agy models` reports no modalities, so the catalog uses a
  conservative family table (Gemini: image/PDF/audio; Claude: image/PDF; any
  other family: text only); `view_file` stays the final authority and refuses a
  type the selected model cannot read. Refused input fails before delivery.
- The stream protocol has no interactive permission reply channel, so Polyth
  supplies a runtime-private `PreToolUse` hook. Headless Antigravity auto-denies
  every tool that needs an approval interaction it cannot prompt for, and a hook
  `allow` decision is audited but never converted into a permission grant
  (live-verified against CLI 1.2.7), so the bridge alone cannot approve a tool.
  The only working headless mode is therefore the native
  `--dangerously-skip-permissions` bypass, and this harness always launches with
  it. The bypass only removes the CLI's own prompt; it never answers a tool.
  Under it the hook decides: workspace reads/edits and the turn's staged
  attachments are allowed, and every other tool raises a Polyth
  `permission/requested` that the session's canonical policy answers (rules,
  Auto-Approve with its high-risk hold, or a person) while the hook waits.
  MCP tools reach the hook as one native `call_mcp_tool` step carrying
  `ServerName`, `ToolName` and `Arguments` (object or JSON text); the bridge
  asks about the wrapped tool as `mcp__<server>__<tool>`, so rules, the
  session-plan exemption (`polyth_todo` never waits for a person) and the risk
  assessment see the real tool. Before calling one the model often reads its
  schema from the CLI's MCP descriptor cache
  (`<private home>/.gemini/antigravity-cli/mcp/`); reads inside that directory
  are allowed like workspace reads, with the same symlink-escape check. The
  capability reports `permissions: true`. That a hook `allow` proceeds and a
  hook `deny` blocks under the bypass is source- and fixture-tested here; a
  paid live turn has not re-verified the waiting path.
  Delegation and beta workspace denials still run first. The bridge denies
  the known native delegation tools before any approval is considered:
  `invoke_subagent`, `define_subagent`, `manage_subagents`, `manage_task` and
  `browser_subagent`, observed in CLI 1.2.11's `init` frame. The model is
  directed to Polyth `agent.spawn`; a hook or bridge failure denies the call.
  Names ending in `*_agent(s)` or `*_subagent(s)` are also denied, but different
  tool names in future releases require another protocol review. Only the
  names were verified live: `manage_task` is conservatively denied without a
  claim about its exact semantics. The hook is
  re-materialized before every turn and no Antigravity sandbox is used. A
  native denial is preserved in activity, and an empty `SUCCESS` after only
  proven denials becomes a failed turn that names the bypass instead of a
  silent stop. Polyth MCP tool
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
  Native subagent/spawn frames are never promoted to `subagent/snapshot` or
  any provider-only child identity. A stale/external frame may only settle the
  ordinary tool lifecycle for an already-open call. New native delegation calls
  are blocked by the permission bridge and are not a supported creation path.
- Questions are supported. Headless print mode has no dialog for the native
  `ask_question` tool and records it as "AskQuestion cancelled by user", so the
  `PreToolUse` hook intercepts it before Auto-Approve is considered, raises a
  Polyth `question/asked` (native option IDs are the answer values and a
  write-in is always allowed), and waits for the reply. The answer — or the
  user's dismissal — reaches the model as the hook decision's reason; the
  settled native call is shown as that answer, not as a failed tool. A question
  still open when the turn ends is released with the turn.
- Steering is supported through the `PreInvocation` hook: accepted text is
  injected as a native user message before the next model call. Steering is
  only accepted after that hook has run in the current turn (otherwise Polyth
  queues it as the next turn), and a model/effort/agent change is refused. If
  the model was already finishing, the `Stop` hook re-enters the loop once so
  the message is delivered; a stop caused by an error or the step limit is
  final. Steering the CLI never received (that final stop, or a leg that exited)
  is prepended to the next prompt; a user Stop discards it.
- Native skills are the native slash commands. Discovery runs the CLI's local
  `agy -p /skills --output-format json` report (no model call, no conversation;
  stdin closed, the report's process group killed on its 90 s timeout), scoped
  and cached like the model catalog, and published through
  `runtime/commands-changed`. A selected command is sent as the whole message
  (`/<skill> <arguments>`), because print mode expands only a leading slash
  command; nothing is prepended or appended to it and attachments are refused.
- The adapter advertises `subagents: false`, like every harness: the shared
  registry suppresses native subagents. Delegated work uses the shared Polyth
  `agent.spawn` capability (reached through the injected `polyth-agent-tools`
  MCP bridge) and therefore appears as a canonical child session rather than
  native provider-only activity.
- Fork, a compaction trigger and cost stay unsupported. Print mode serves only
  the local reports its `/help` lists (`agents`, `changelog`, `config`,
  `credits`, `effort`, `help`, `hooks`, `model`, `permissions`, `skills`,
  `usage`); `/fork`, `/rewind` and `/context` are TUI-only. `/compact` is not
  a headless trigger: print mode sends it to the model as ordinary prompt text
  (live-checked on CLI 1.2.9), so the adapter never sends it. Native fork
  clones the CLI's private conversation database, which Polyth does not touch.
  The CLI's cost estimate exists only in the TUI status line; `agy models`
  lists no prices. Quota is not cost: Antigravity's 5-hour and weekly quota
  windows are reported by `@polyth/usage`. Polyth's own rewind/fork continues
  through canonical history on a fresh native conversation instead of claiming
  a native branch.
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
interruption), unterminated tool calls, failed release, recorded resume,
stop-and-relaunch and uncertain replay. `worker.test.ts` runs the generated
worker as a real process against a fake CLI and covers the stopped leg, the
proved release, the self-exited leg and both relaunches. Package tests exercise
discovery, lazy enable/disable, Space/remote gates and the workspace lock.
`attachments.test.ts`, `questions.test.ts` and the runtime/permission fixtures
cover attachment staging (private copies, canonical extensions, traversal and
symlink escape, missing repositories, size/count limits, retention), injected
`view_file`/`read_url_content` steps, steering (seam gating, idempotent
receipts, the single `Stop` re-entry, carry-over and stop-discard), native
question normalization and answers, per-event hook sanitization with fail-open
loop events and a fail-closed tool gate, and the bounded `/skills` report.
`protocol.test.ts` also covers checkpoint compaction (recorded once, no
dialogue, no stale occupancy) and the effort catalog (suffixed IDs grouped into one model with the listed
variants, legacy suffixed IDs launch without a redundant flag, a conflicting
effort is refused). `package.test.ts` drives a fake
`agy` executable to pin the authentication contract: the version probe stays
`unknown`, a signed-in catalog reports `ready` and lets the same scope's next
cheap probe reuse that proof across subsequent probes, a forced re-check
clears it, another Space or project never inherits it, a failed fresh check
revokes any older proof for the same scope, and an older in-flight catalog
cannot restore proof after invalidation. A sign-in failure also surfaces the `auth-required`
state without leaving a cached claim behind. The
runtime fixture denies each native delegation surface the CLI advertises and
proves ordinary tools that merely mention agents still pass.
Fixtures are not a live Google account verification.
No provider login, paid prompt, physical-device test or live model turn is
claimed. MCP discovery was live-checked against Antigravity CLI 1.2.7 with a
local stdio probe: the private home's `~/.gemini/config/mcp_config.json` server
was spawned at startup, `agy models` authenticated through the linked app data,
and no model turn was sent. On 2026-09-22 the launch contract was re-checked
live against CLI 1.2.8 without sending a prompt: `--dangerously-skip-permissions`
reports `permission_mode: "always-proceed"` in `init`, the init frame arrives
about two seconds after launch, and `--conversation <id>` re-initializes the
same conversation ID. On 2026-09-23, again without a prompt, CLI 1.2.9 loaded the
generated `hooks.json` with its `PreToolUse`, `PreInvocation` and `Stop`
handlers ("loaded 1 named hooks"), its headless `init` listed `ask_question`,
`view_file` and `read_url_content` among the tools, and the `/skills` report
returned the installed skills in about 13 seconds with no model request in the
CLI log. Later that day, still on CLI 1.2.9: the local `/help`, `/model`,
`/effort`, `/usage` and `/credits` reports answered without a model call;
`--model gemini-3.8-flash-high --effort low` failed CLI validation ("conflicts
with --effort=low"), the same ID with `--effort high` or no effort passed, and
`--model claude-sonnet-4-6 --effort low` failed ("--effort is not supported") (on 2026-10-08, CLI 1.3.1 also
resolved the base slug: `/model --model gemini-3.8-flash --effort low` reported
`gemini-3.8-flash-low`, and an effort the model does not list failed with
"gemini-3.1-pro has no \"medium\" effort (available: low, high)");
one `-p /compact` probe in a scratch workspace was sent to the model as an
ordinary prompt (one model turn, about 39k input tokens, no compaction step),
which is why the adapter never sends it; the binary rejects any non-`text`
stream input block ("stream input content block type %q is not supported").
The `checkpoint` wire name comes from the transcripts' `CHECKPOINT` step type
and the stream's lower-case step names; no live compaction was streamed. That
the CLI actually fires `PreInvocation` in print mode, runs the injected steps
and passes an injected image to the model is taken from its bundled hooks
reference and step schema; it is not yet live-verified with a model turn.

On 2026-09-25 the same launch contract was re-checked against the CLI 1.2.11
installed on the server, again with no model turn. `agy --version` still
answers with an empty `HOME`, while `agy models` refuses to list anything
("Please sign in to view available models"), which is what makes the catalog
positive sign-in evidence. The headless `init` frame still reports
`permission_mode: "always-proceed"` under `--dangerously-skip-permissions`, and
the worker's content-less probe still returns a `num_turns: 0` result whose
error is "stream input \"user\" message has no content", so the deferred-init
probe path added for 1.2.10 keeps working. That `init` tool list is also where
the extra native delegation surfaces came from: `invoke_subagent`,
`define_subagent`, `manage_subagents`, `manage_task` and `browser_subagent` are
all advertised, which is why the bridge denies the whole set. The
`{"command":{"name":"skills","data":{"skills":[…]}}}` report shape is
unchanged — 36 skills parsed — and `agy models` still returns a non-empty
catalog whose effort-suffixed IDs pass the parser and the conflicting-effort
refusal.

Protocol reference, checked 2026-09-19:
- https://antigravity.google/docs/cli/headless
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/cli/install/

Hooks contract, checked 2026-09-23 against CLI 1.2.9: the bundled
`agy-customizations` skill's hooks reference and the `exa.hooks_pb` schema in
the installed binary (`injectSteps` with `toolCall`/`userMessage`,
`Stop.decision: "continue"`); public copy at https://antigravity.google/docs/hooks/.

Keep the parser, fixtures and this support matrix aligned when the upstream
CLI wire format changes; do not infer adapter support from model marketing.
