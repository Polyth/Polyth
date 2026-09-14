# Command Code harness integration

Status: implementation contract for `packages/backend-commandcode`.

Command Code is integrated as a **local, user-owned harness**. Polyth controls the
process it launches and owns the canonical session, event log, queue, project,
worktree relationship, mutation journal, runtime authority, and reconciliation
state. A Command Code native session is a subordinate runtime leg, never the
product identity.

This document describes the surfaces Polyth intentionally uses and the
boundaries it must not cross. Current source and tests remain authoritative when
a historical capability table disagrees.

## Allowed native surfaces

Polyth uses documented Command Code local CLI / Mod surfaces only:

- `command-code status --json` for authentication status.
- `command-code --list-models` for the live model catalog.
- headless `-p --output-format json` for NDJSON AgentEvents and the final result.
- exact `--resume <nativeSessionId>` for continuation.
- `--model`, `--effort`, `--permission-mode`, `--tools-enable`,
  `--skip-onboarding`, and `--no-auto-update` for explicit per-run behavior.
- a transient absolute `--mod <polyth bridge>` for the admission barrier,
  title mirroring, and live steering.
- Mod `cmd.queueMessage({ content, deliverAs: "steer" })` for a follow-up that
  must join the currently active native run.
- native Command Code project/user MCP, skills, and `AGENTS.md` loading through
  the normal Command Code cwd/config rules.

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
- rewrite user/project Command Code settings merely to install hooks.
- adopt an ambient Command Code process as Polyth execution authority.
- retry an outcome-unknown turn or steering mutation speculatively.

Account-wide Command Code quota/credits telemetry stays unavailable until a
documented machine-readable surface can provide it without extracting native
credentials. Per-turn token usage from AgentEvents is independent and supported.

## Process and authority model

`backend-commandcode` materializes two generated files inside Space-owned
package storage:

1. a Node worker that owns the one-shot Command Code child process and its NDJSON
   framing; and
2. a transient Command Code Mod bridge passed with `--mod`.

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
2. The adapter starts the owned headless process with a unique operation ID.
3. Command Code emits `run_start { sessionId }`.
4. The Mod records that exact native ID and **that exact turn-submit operation
   receipt** in the Polyth binding file.
5. The Mod `onTurnStart` returns only after the atomic binding write succeeds.
6. Only then may Command Code emit `turn_start`, start the model request, or run
   tools.
7. The worker confirms admission only after reading both the expected native ID
   and the exact current operation receipt.

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
- bounded accepted mutation receipts (`turn-submit` / `turn-steer`).

It must not contain Command Code auth tokens, provider credentials, native
transcript copies, taste files, or MCP secrets.

Writes are atomic rename-based writes with restrictive file mode. The Mod
serializes binding updates so title and steering metadata cannot clobber the
admission receipt.

## Streaming and canonical events

Documented AgentEvents are translated at the adapter boundary:

- `turn_start` -> `turn/started`
- `text_delta` -> `assistant/chunk`
- `message_end` -> `assistant/message`
- `tool_queued` -> original tool input capture; `todo_write` additionally
  becomes a revisioned `task/snapshot`
- `tool_running` -> `tool/started`
- `tool_completed` -> `tool/result`
- `tool_errored`, `tool_denied`, `tool_hook_blocked` -> `tool/error`
- `session_titled` -> non-placeholder `session/title-generated`
- `model_request_end` -> `usage/recorded` token usage
- `compaction_done` -> observed `session/compacted`
- subagent lifecycle/progress -> revisioned `subagent/snapshot`

Private `thinking_*` frames are deliberately excluded from canonical dialogue.
`run_error` and `interrupted` are control evidence, not conversation content.
Unknown future AgentEvents are ignored until explicitly integrated.

Undocumented `cost`-looking fields are not promoted to canonical cost telemetry.
`cost:false` remains truthful until Command Code documents a stable source.

Automatic native compaction can be observed, but Polyth advertises
`compaction:false` because it cannot currently invoke manual compaction honestly
for an idle one-shot headless session. Context occupancy remains `unknown`.

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
| Subagents | yes | native lifecycle observability, not independent Polyth spawn control |
| Steering | yes | native Mod queue steering + durable receipt |
| MCP | yes | Command Code consumes its own native MCP config |
| Token usage | yes | native model request usage |
| Native title | yes | title event + best-effort binding mirror |
| Interactive Polyth permissions | no | native permission engine only |
| Questions | no | no honest headless interactive bridge yet |
| Manual compaction | no | automatic compaction may still be observed |
| Context occupancy | unknown | no verified native occupancy contract |
| Cost | no | no documented stable cost telemetry used |
| Fork/rewind/checkpoints | no | native tree controls are not canonical Polyth history controls |
| Attachments | no | no verified adapter translation yet |
| Native slash commands | no | headless command invocation is not claimed |
| Account-wide quota | no | no documented credential-free machine surface used |

`autoSelect` stays false until live evidence and release review are complete.

## Verification

Provider-local tests cover:

- model-list parsing and CLI compatibility inspection;
- conservative launch flags and prohibited-flag guards;
- exact per-turn admission receipts, including resumed-turn regression guards;
- durable session binding and unknown-admission reconciliation;
- native steering receipts and lost-ack recovery;
- protocol framing/translation, private-thinking exclusion, task/subagent state,
  title filtering, and documented telemetry boundary;
- documented native failure classification and secret redaction;
- SIGTERM vs user/native-interrupt semantics;
- account-quota compliance boundary (no credential/network access).

No paid/live Command Code turn is required in ordinary CI. Live validation is a
separate explicitly authorized gate.

At the time this integration was developed, the repository's `Polyth Link` PR
workflow was failing before runner assignment (`runner_id=0`, no job steps), so
that infrastructure failure was not treated as passing or failing code evidence.

## Distribution boundary

This adapter is designed for a user's own locally installed and authenticated
Command Code CLI. It is not a hosted Command Code proxy, account pool, reseller,
or service bureau, and Polyth does not receive the user's Command Code
credentials.

Before a public/commercial release that markets or distributes this integration,
the release owner should re-check the then-current Command Code terms and obtain
written clarification/approval where their restrictions remain ambiguous. Code
architecture can minimize compliance risk; it cannot manufacture legal certainty.
