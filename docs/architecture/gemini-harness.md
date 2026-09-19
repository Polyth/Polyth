# Gemini CLI harness integration

Status: implementation contract for `packages/backend-gemini`.

Gemini CLI is integrated as a local, user-owned harness through Google's official
ACP mode. Polyth owns the canonical session, durable event log, project/worktree
identity, queue, capability policy, usage projection, retry policy and runtime
authority. The Gemini native session is an execution leg, never the product
identity.

The adapter is deliberately thin where ACP already has a truthful contract and
Gemini-specific only where Google exposes stronger machine-readable evidence.

## Native surface

Polyth uses:

- the installed `gemini` executable discovered through the shared harness path
  resolver (or `POLYTH_GEMINI_BIN`);
- `gemini --acp` for the official ACP v1 JSON-RPC stdio agent;
- `gemini --version` and `gemini --help` for detection and compatibility;
- ACP `initialize`, `session/new`, `session/load`, `session/prompt`,
  `session/set_config_option`, permission requests and session updates;
- only metadata returned by those documented/native surfaces.

The package does not read Gemini credential files, scrape Google web sessions,
call private quota APIs, or mutate the user's Gemini configuration merely to
make Polyth integration work.

An installed build without `--acp` is reported as incompatible rather than
silently falling back to a different Gemini transport.

## Authentication

Authentication remains owned by Gemini CLI. Current Gemini ACP initialization
advertises native Google login, Gemini API key, Vertex AI and gateway auth
methods. Polyth does not ingest their credentials. The package exposes `gemini`
as the explicit sign-in/setup command and model discovery reports native auth
failure instead of retrying a login loop.

Authentication status is intentionally `unknown` during the lightweight
executable probe because installation is not proof of a valid Google session.

## Models, thinking and native sessions

Model discovery uses the shared ACP session metadata/config-option mechanism.
Current Gemini ACP returns the legacy standardized `models` block, so the
normal Polyth model picker gets the live native model catalog without a static
guessed list.

Model selection is session-scoped and applied through ACP's native model
control. Current Gemini ACP does **not** publish a separate thinking-effort
selector, so Polyth does not invent Gemini thinking variants or encode an
unverified effort value into prompts. If Gemini later publishes a semantic
`thought_level` config option, the shared ACP parser can expose it without a
Gemini-specific static catalog.

Gemini ACP advertises native session loading. Polyth reattaches only by the exact
persisted native session id; titles, timestamps and transcript similarity are
never continuity evidence.

## Polyth prompts and project policy

Gemini participates in the canonical Polyth capability pipeline.

The following are projected through the shared ACP prompt overlay:

- global Polyth behavior instructions;
- project/session instructions contributed by packages;
- prompt-mode Polyth skills;
- scoped context capabilities;
- optional workspace `AGENTS.md` recovery policy on the first prompt of a
  fresh runtime leg;
- bounded cross-harness recovery context when Polyth intentionally creates a
  fresh Gemini leg.

The visible user message is not rewritten in canonical history. Capability text
is appended only at the provider boundary and is re-projected on subsequent
prompts so native compaction cannot silently discard required Polyth policy.

Polyth does not rewrite `GEMINI.md` or install persistent Gemini skills merely
to provide these capabilities. Gemini may still consume the repository's own
ambient `GEMINI.md`/native configuration through its normal cwd behavior.

## MCP and Polyth tools

ACP session creation/load receives the canonical scoped MCP configuration.

This includes the generated `polyth-agent-tools` stdio server, which is the
same authorization boundary used by the other supported local harnesses.
Consequently Gemini can receive Polyth package tools such as Browser and other
AgentTool contributions without private Gemini plugins.

Secrets are resolved only at the trusted provisioning boundary. MCP environment
values/authorization material are never copied into the prompt overlay or
canonical dialogue.

Gemini ACP currently advertises HTTP MCP support as well. The shared ACP layer
requires the native capability advertisement before forwarding HTTP MCP; no
static claim bypasses negotiation.

MCP configuration acceptance is recorded as staged/unverifiable until stronger
native evidence exists. Polyth never claims a tool was invoked merely because a
server was configured.

## Permissions and questions

Gemini's ACP permission requests use the shared Polyth permission bridge.
A native `session/request_permission` becomes a canonical
`permission/requested`; the selected native option id is returned only after
the Polyth decision.

Polyth-specific package tools still execute through the canonical AgentTool
authorization path, so Gemini cannot bypass package permission policy by
changing its own local approval mode.

Generic structured Polyth questions are **not** claimed for Gemini yet. Gemini
has native interactive behavior, but ACP does not currently expose a verified
question lifecycle that maps cleanly onto Polyth's `question/asked` contract.
The adapter therefore reports `questions: false` instead of auto-answering or
inventing a bridge.

## Streaming and tool lifecycle

Shared ACP normalization maps:

- assistant text chunks to canonical streaming text;
- native tool call/update frames to Polyth tool lifecycle events;
- permission requests to canonical permission state;
- native title/session metadata where ACP exposes it;
- completion/cancellation to canonical terminal turn state.

Private thought content is not promoted into canonical dialogue.

Gemini also publishes native slash commands through ACP
`available_commands_update`. The shared ACP command registry exposes those as
session-scoped native commands and invokes them through raw native input rather
than reimplementing Gemini command semantics.

Gemini ACP publishes native approval/session modes as well. Polyth deliberately
does not present those as a second permission-policy system: canonical Polyth
permission decisions remain authoritative and ACP permission requests are
bridged explicitly. A future dedicated read-only planning control may map a
verified Gemini mode, but no mode is silently selected today.

## Usage

Gemini exposes stronger evidence than baseline ACP. A successful
`session/prompt` currently returns `_meta.quota.token_count` and
`_meta.quota.model_usage`.

The Gemini profile converts those values into canonical `usage/recorded`
events with provider `google`. Per-model rows are preferred; the total token
count is used only as a fallback when model rows are absent.

This is request usage, not current context-window occupancy. The adapter
therefore claims `usage: true` while leaving context occupancy unknown and
does not invent cost data.

## Provider limits and automatic continuation

Gemini ACP converts provider capacity exhaustion to a JSON-RPC error with code
429. The profile maps that structural signal to:

- canonical `rate-limited` failure;
- provider `google`;
- the existing durable Polyth resume scheduler.

Gemini ACP does not currently preserve the provider's exact reset timestamp in
that 429 response, so Polyth uses its bounded escalating fallback schedule
rather than inventing a reset time.

Automatic resume has two modes:

1. **Replay** — if no native tool activity was observed, Gemini rolls back the
   failed user request in native history, so Polyth safely replays the original
   hidden prompt after the wait.
2. **Continue** — if tool activity was observed, replaying the original task can
   duplicate side effects. Polyth instead submits a hidden continuation prompt
   to the same native session: continue from the interruption point and do not
   redo completed work.

A model/harness switch can never rely on the old Gemini native state, so an
explicit switch always replays the original prompt on the replacement runtime.

The pending timer state is cleared once the automatic retry has a durable
`turn/started`; this prevents a server restart from blindly replaying an
in-flight turn that may already have mutated tools. Retry lineage — original
owner sequence, attempt and resume mode — is stored on the hidden auto-resume
message instead. A second limit stop therefore increments the attempt and
advances the fallback backoff without leaving a stale replayable timer. A
pending wait that has not yet started still survives server restart.

Polyth never automatically switches billing route/model on Gemini's behalf.

## Attachments

Attachment claims remain negotiated by the shared ACP layer. Gemini ACP
currently advertises image, audio and embedded-context prompt capabilities, so
only those negotiated modalities are passed natively. Unsupported modalities
are rejected before native mutation.

No extra Gemini-only attachment guess is added.

## Capability matrix

| Capability | Claim |
| --- | --- |
| Streaming | yes, ACP |
| Exact native load/resume | yes when advertised by Gemini ACP |
| Model discovery/selection | yes, ACP session config |
| Thinking selection | not currently exposed by Gemini ACP; no guessed variants |
| Native permissions | yes, ACP permission bridge |
| Polyth instructions/context | yes, prompt projection |
| Polyth skills | yes, prompt projection |
| Ambient Gemini project policy | consumed by Gemini itself from cwd |
| MCP | yes, negotiated ACP session config |
| Polyth package tools | yes, through `polyth-agent-tools` MCP |
| Tool lifecycle | yes, ACP tool updates |
| Native slash commands | yes, ACP command discovery/raw native invocation |
| Native approval modes | observed but not exposed as a competing Polyth policy control |
| Token usage | yes, Gemini prompt quota metadata |
| Cost | no verified source |
| Context occupancy | unknown |
| Structured Polyth questions | no verified bridge |
| Manual compaction | no |
| Subagent lifecycle | not claimed until ACP evidence is normalized |
| Steering | no |
| Fork/rewind | no native claim; canonical Polyth history controls remain separate |
| Provider-limit auto-resume | yes, durable replay/continuation strategy |

## Verification requirements

The package has model-free contract tests for:

- `--acp` compatibility detection;
- Gemini quota metadata to canonical usage;
- structural 429 normalization;
- non-success native stop reasons (`max_tokens`, `max_turn_requests`);
- replay vs tool-safe continuation strategy;
- prompt/skill/context projection;
- `polyth-agent-tools` MCP projection without prompt-secret leakage;
- shared ACP provider-result/error hooks;
- durable continuation resume and escalating repeated attempts.

A live authenticated Gemini turn is still required before changing the harness
from manual-only routing to automatic selection. Until then `autoSelect`
remains false. The package must not claim paid-turn validation that CI did not
actually execute.
