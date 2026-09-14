# Command Code harness integration

Status: implementation contract for `packages/backend-commandcode`.

Command Code is integrated as a **local, user-owned harness**. Polyth controls the
process it launches and owns the canonical session, event log, queue, project,
worktree relationship, mutation journal, runtime authority, capability state,
and reconciliation state. A Command Code native session is a subordinate runtime
leg, never the product identity.

This document describes the native surfaces Polyth intentionally uses and the
boundaries it must not cross. Source and regression tests are authoritative when
historical prose disagrees.

## Allowed native surfaces

Polyth uses documented Command Code local CLI / Mod surfaces only:

- `command-code status --json` for authentication status.
- `command-code --list-models` for the live model catalog.
- headless `-p --output-format json` for NDJSON AgentEvents and the final result.
- exact `--resume <nativeSessionId>` for continuation.
- `--model`, `--effort`, `--permission-mode`, `--tools-enable`,
  `--skip-onboarding`, and `--no-auto-update` for explicit per-run behavior.
- repeatable `--skill <root>` for Polyth-staged native skills.
- the transient Polyth runtime `--mod` for the admission barrier, title mirroring,
  question interception, and live steering.
- an additional transient capability `--mod` using `appendSystemPrompt` for
  Polyth instruction/context projection.
- Mod `cmd.queueMessage({ content, deliverAs: "steer" })` for a follow-up that
  must join the currently active native run.
- native `ask_user_question` plus Mod `beforeToolCall` interception for a
  structured Polyth question lifecycle.
- native `read_file` for already-project-relative file, range, and PDF/document
  references. Polyth never exposes an absolute host path in the provider-bound
  attachment instruction.
- native Command Code project/user MCP, custom agents, skills, and `AGENTS.md`
  through Command Code's normal cwd/config discovery.

The adapter checks the installed CLI help surface instead of guessing a minimum
semantic version. An installed binary missing a required flag is
`incompatible`; a binary whose help surface cannot be inspected is `degraded`.
Neither is allowed to spawn a runtime.

## Explicitly forbidden shortcuts

The integration must not:

- read or copy `~/.commandcode/auth.json` or any other Command Code credential.
- call undocumented/private billing, identity, dashboard, or website APIs.
- scrape the Command Code website or native transcript/session storage.
- use the Command Code Provider API as a substitute for the Command Code
  harness runtime.
- find a native session by title, timestamp, transcript similarity, or
  `--continue`; only the exact persisted native ID is valid.
- append `--trust`, `--yolo`, or an equivalent permission bypass silently.
- enable automatic Command Code updates inside a Polyth turn.
- rewrite user/project Command Code settings merely to install hooks,
  instructions, skills, or MCP servers.
- claim Polyth-managed transient MCP/tool projection when only ambient native
  Command Code MCP configuration is being consumed.
- adopt an ambient Command Code process as Polyth execution authority.
- retry an outcome-unknown turn, steering mutation, or question answer
  speculatively.
- reinterpret per-model-request input-token usage as current context-window
  occupancy without an explicit native occupancy contract.

Account-wide Command Code quota/credits telemetry stays unavailable until a
documented machine-readable surface can provide it without extracting native
credentials. Per-turn token usage from AgentEvents is independent and supported.

## Process and authority model

`backend-commandcode` materializes two generated runtime files inside
Space-owned package storage:

1. a Node worker that owns the one-shot Command Code child process and its NDJSON
   framing; and
2. a transient Command Code Mod bridge passed with `--mod`.

Capability provisioning may additionally materialize immutable per-revision
artifacts inside Space-owned runtime storage:

- rendered system prompt text;
- a tiny capability Mod whose only job is `appendSystemPrompt`;
- native skill directories containing `SKILL.md`.

Those artifacts are Polyth-owned and revision-addressed. They do not mutate
Command Code user/project settings.

The worker itself is launched through Polyth's `createHarnessProcessAuthority`.
The provider never uses a bare unmanaged child as execution authority.

The runtime endpoint therefore has Polyth authority ID + generation semantics;
the Command Code native session ID is only conversation continuity inside that
owned runtime leg.

Cross-harness release uses the common process-authority proof. Where Polyth
cannot prove the exact old authority empty, it must refuse replacement rather
than infer release from a timeout, missing PID, disconnected stream, or abort
acknowledgement.

## First and resumed turn admission

Command Code creates/exposes the native session at run start, while Polyth must
not allow provider inference or tools to escape before the canonical runtime leg
has an exact durable native receipt. The transient Mod is the barrier.

For every turn, including resumed turns:

1. Polyth persists the canonical mutation intent first.
2. Capability launch state, when present, is captured for the exact desired
   revision before native spawn.
3. The adapter starts the owned headless process with a unique operation ID.
4. Command Code emits `run_start { sessionId }`.
5. The Mod records that exact native ID and **that exact turn-submit operation
   receipt** in the Polyth binding file.
6. The Mod `onTurnStart` returns only after the atomic binding write succeeds.
7. Only then may Command Code emit `turn_start`, start the model request, or run
   tools.
8. The worker confirms admission only after reading both the expected native ID
   and the exact current operation receipt.
9. Capability provisioning is settled only after the same native admission
   boundary. Prompt/skill application is marked `unverifiable` where native
   consumption/discovery has no authoritative headless readback.

A resumed turn must never treat the session ID left by a previous turn as proof
that the new turn was admitted.

If the process exits before `run_start` and before the exact receipt, the worker
can prove non-application and return a rejection. This is how trust/setup errors
avoid leaving a false outcome-unknown fence. If any native run evidence was
observed, or the exact receipt exists, the outcome is not downgraded to a
rejection.

The worker also suppresses `turn-exit` for a process that provably died before
admission. Canonical terminal events are reserved for admitted or genuinely
ambiguous native runs.

## Durable binding state

The Space-owned binding contains non-secret execution metadata only:

- Polyth adapter binding ID.
- canonical session-create operation ID.
- display title.
- exact native Command Code session ID once known.
- native bind timestamps.
- bounded accepted mutation receipts (`turn-submit`, `turn-steer`,
  `question-reply`, `question-reject`).

It must not contain Command Code auth tokens, provider credentials, native
transcript copies, taste files, or MCP secrets.

Writes are atomic rename-based writes with restrictive file mode. The Mod
serializes binding updates so question/steering metadata cannot clobber the
admission receipt.

## Streaming and canonical events

Documented AgentEvents are translated at the adapter boundary:

- `turn_start` -> `turn/started`
- `text_delta` -> `assistant/chunk`
- `message_end` -> `assistant/message`
- `tool_queued` -> original tool input capture
- queued `ask_user_question` -> canonical `question/asked`
- queued `todo_write` -> revisioned `task/snapshot`
- `tool_running` -> `tool/started`
- `tool_completed` -> `tool/result`
- `tool_errored`, `tool_denied`, `tool_hook_blocked` -> `tool/error`, except the
  deliberate answered-question hook block, which is not surfaced as an error
- `session_titled` -> non-placeholder `session/title-generated`
- `model_request_end` -> `usage/recorded` token usage only
- `compaction_start` / `compaction_done` -> unknown-source context/compaction
  state; `compaction_done` also emits `session/compacted`
- subagent lifecycle/progress -> revisioned `subagent/snapshot`

Private `thinking_*` frames are deliberately excluded from canonical dialogue.
`run_error` and `interrupted` are control evidence, not conversation content.
Unknown future AgentEvents are ignored until explicitly integrated.

Undocumented `cost`-looking fields are not promoted to canonical cost telemetry.
`cost:false` remains truthful until Command Code documents a stable source.

Automatic native compaction can be observed, but Polyth advertises
`compaction:false` because it cannot currently invoke manual compaction honestly
for an idle one-shot headless session. `model_request_end.usage.input` is usage
for that native model request, not a documented current context-window snapshot;
therefore `contextOccupancy` remains `unknown`.

## Steering

A live headless process exposes a tiny authenticated loopback control channel
from the transient Mod. The random token and ephemeral descriptor are generated
per run and never exposed as a product API.

For `turn-steer`:

1. Polyth persists the user's steering intent before provider I/O.
2. the worker sends one authenticated control record to the Mod.
3. the Mod calls native `cmd.queueMessage(..., deliverAs: "steer")`.
4. after native acceptance, the Mod atomically persists the exact steering
   operation receipt.
5. only then does it acknowledge the worker.

If the acknowledgement is lost but the receipt exists, Polyth can recover
`confirmed`. If no receipt exists after an ambiguous send, the outcome remains
`unknown`; the message is never silently replayed.

When no native run is active, steering is rejected so the session layer can use
its normal queue fallback.

## Questions

`ask_user_question` has a real headless bridge rather than an auto-answer shim.

When Command Code queues the tool, Polyth emits a normalized `question/asked`
with single/multi/text question metadata. The transient Mod blocks completion in
`beforeToolCall` and waits for the canonical Polyth response over the authenticated
loopback control channel.

Before releasing the blocked hook, the Mod persists the exact
`question-reply`/`question-reject` operation receipt and request ID. A lost ACK
can therefore recover as confirmed without sending the answer twice. Rejection
is explicit; the bridge never silently chooses an option for the user.

Pending questions are represented in runtime reconciliation while the owned
worker is connected. This is a question bridge only; it does not imply a generic
per-tool permission bridge.

## Permissions and workspace trust

Polyth does not fake a per-tool permission bridge.

Command Code native permission checks occur before Mod `beforeToolCall`, and the
documented Hooks configuration lives in user/project settings. Mutating those
settings automatically would violate the integration boundary.

Current mapping:

- Polyth effective auto-accept -> Command Code `--permission-mode auto-accept`.
- otherwise -> `--permission-mode dont-ask`.

`dont-ask` is the fail-closed default. Native allow/deny rules still apply;
unresolved permission prompts become denied instead of blocking an invisible
headless UI.

Polyth never appends `--trust`. A workspace that Command Code has not trusted is
a user-action/setup condition. When Command Code rejects before `run_start`, the
worker can surface a clear trust message as proven non-application. Trust remains
owned by the user through Command Code.

## Titles

The canonical Polyth title remains product authority. SessionService supplies
that title to the runtime, and `titleSync` injects the latest canonical value into
every native `start_turn`, including exact resume. The worker passes it to the
transient Mod, which can call native `setSessionName`.

This avoids searching transcripts or native session storage and avoids replaying
a stale adapter binding title over a newer manual rename. Native
`session_titled` events remain observable and can generate canonical title
events, but they do not replace the canonical identity model.

## Attachments and custom agents

Polyth currently transports project-relative file/range/PDF references by
adding provider-only instructions to use Command Code's native `read_file` tool.
The canonical user message is not rewritten in history, and absolute host paths
are never included in the provider-bound prompt.

Supported attachment modalities through this adapter are therefore:

- `file`: native for project-relative references;
- `pdf`: native for project-relative document references;
- `image`, `url`, `audio`: unsupported;
- arbitrary uploaded files without a canonical project-relative path:
  unsupported / invalid attachment.

Command Code custom agents are discovered as delegated native subagent metadata.
They are not valid Polyth primary-agent selectors; an attempted primary-agent
selection is rejected rather than silently ignored.

## Capability provisioning

Polyth capability provisioning is intentionally narrower than Command Code's
ambient native configuration.

Supported projections:

- instruction -> transient prompt via `appendSystemPrompt` Mod;
- context -> transient prompt via `appendSystemPrompt` Mod;
- skill -> native repeatable `--skill` root.

Because every Polyth turn starts a fresh Command Code headless process, a new
revision can be applied at the next native admission without mutating persistent
Command Code configuration. Provisioned artifacts live under Space-owned
revision storage, reject symlink escape, and are immutable for a given desired
revision.

Not supported for Polyth-managed projection:

- MCP server configuration;
- Polyth tool bridge through MCP;
- arbitrary extensions.

Command Code may still consume the user's/project's own native MCP configuration
from the cwd. That is why runtime `mcp:true` is compatible with provisioning
`mcp-server: unsupported`: the former describes native consumption, the latter
would require Polyth to modify or transiently inject vendor configuration.

## Failure semantics

Documented native exits map conservatively:

- `3` -> `auth-expired`
- `5` -> `rate-limited` with a rate retry hint
- `10` -> `quota-exhausted`, not automatically retryable
- other exits -> `unknown` unless stronger native structured evidence exists

In particular, generic Command Code exit `7` is a server/API error, not proof of
capacity overload.

A raw `SIGTERM` is not a user abort: Polyth also uses SIGTERM for owned cleanup.
Abort requires Polyth abort intent, native exit `130`, `SIGINT`, or the native
`interrupted` AgentEvent. Native `run_error` takes precedence over ambiguous
process termination and is secret-redacted before canonical error delivery.

Protocol/process failure after admission is terminal error evidence, never a
user abort.

## Current capability claims

| Capability | Claim | Meaning |
| --- | --- | --- |
| Streaming | yes | native AgentEvent text stream |
| Exact resume | yes | exact persisted native session ID |
| Model catalog / selection | yes | live `--list-models`, `--model` |
| Effort | yes | native `--effort` when selected |
| Tool lifecycle | yes | native tool AgentEvents |
| Tasks | yes | native `todo_write` enabled per run and translated |
| Subagents | yes | native lifecycle observability; custom agents are not Polyth primary agents |
| Steering | yes | native Mod queue steering + durable receipt |
| MCP consumption | yes | Command Code consumes its own ambient native MCP config |
| Polyth-managed MCP provisioning | no | no verified transient native projection; vendor config is not rewritten |
| Token usage | yes | native per-model-request token usage |
| Native title | yes | latest canonical title projected on every start/resume + native title events |
| Interactive Polyth permissions | no | native permission engine only |
| Questions | yes | structured `ask_user_question` bridge + durable reply/reject receipts |
| Manual compaction | no | automatic compaction may still be observed |
| Context occupancy | unknown | no verified native current-occupancy contract |
| Cost | no | no documented stable cost telemetry used |
| Fork/rewind/checkpoints | no | native tree controls are not canonical Polyth history controls |
| Project files | yes | project-relative references through native `read_file` |
| Project PDFs | yes | project-relative documents through native `read_file` |
| Images / URLs / audio | no | no verified adapter transport |
| Native slash commands | no | headless command invocation is not claimed |
| Account-wide quota | no | no documented credential-free machine surface used |
| Polyth instruction/context provisioning | yes | transient capability Mod; consumption remains unverifiable |
| Polyth native-skill provisioning | yes | repeatable `--skill`; discovery remains unverifiable headlessly |

`autoSelect` stays false until live evidence and release review are complete.

## Verification

Provider-local tests cover:

- model-list parsing and CLI compatibility inspection;
- conservative launch flags and prohibited-flag guards;
- exact per-turn admission receipts, including resumed-turn regression guards;
- durable session binding and unknown-admission reconciliation;
- native steering receipts and lost-ack recovery;
- structured question interception, durable answer/reject receipts, and
  pending-question reconciliation;
- canonical title injection on exact resume;
- project-relative attachment fencing and custom-agent primary-selection refusal;
- transient prompt/context + native skill provisioning, revision immutability,
  and symlink-boundary rejection;
- protocol framing/translation, private-thinking exclusion, task/subagent state,
  title filtering, and documented telemetry boundary;
- explicit regression coverage that token usage is **not** context occupancy;
- documented native failure classification and secret redaction;
- SIGTERM vs user/native-interrupt semantics;
- account-quota compliance boundary (no credential/network access).

No paid/live Command Code turn is required in ordinary CI. Live validation is a
separate explicitly authorized gate.

At the time of this update, the repository's `Polyth Link` and `Agent Knowledge`
PR jobs were failing before any job steps were assigned/executed. That
infrastructure failure is not treated as passing or failing code evidence.

## Distribution boundary

This adapter is designed for a user's own locally installed and authenticated
Command Code CLI. It is not a hosted Command Code proxy, account pool, reseller,
or service bureau, and Polyth does not receive the user's Command Code
credentials.

Before a public/commercial release that markets or distributes this integration,
the release owner should re-check the then-current Command Code terms and obtain
written clarification/approval where their restrictions remain ambiguous. Code
architecture can minimize compliance risk; it cannot manufacture legal certainty.
