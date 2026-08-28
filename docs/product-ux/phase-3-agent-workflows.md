# Phase 3 Wave 3 — agent workflows

Wave 3 deepens the existing Multirun and Fusion packages without creating a
second conversation timeline or a form-factor-specific application.

## Multirun user model

### Before a run

Multirun is a comparison workflow: the user writes one prompt, chooses one or
more text models and, optionally, one backend-reported agent mode. Every
selected model receives the same prompt independently. The launch summary names
the number of runs, the parallel execution model, and whether the workspace
default or an explicit agent will be used.

Polyth does not predict cost before launch. Providers and models do not expose a
uniform trustworthy estimate, so the setup explicitly says that cost will
appear only when reported.

### During a run

The comparison header keeps the original prompt visible and reports finished,
running, waiting, completed, and failed counts. Progress is based on settled
runs, not an invented percentage of model work. Each run identifies its model,
agent, status, and elapsed duration.

The session remains `Working` in global navigation while any Multirun work is
active, even if its normal chat turn is idle. Leaving the Multirun surface does
not hide that state.

### After a run

Each completed response can be selected as the picked result or copied into the
canonical composer with **Continue in chat**. Picking records the result in the
Multirun workflow; continuing deliberately returns to the session conversation
and seeds, but does not auto-send, the response.

Per-run duration, total input-plus-output tokens, and provider-reported cost are
compact secondary metadata. The comparison summary adds only the known
aggregate cost. Missing usage remains absent rather than appearing as zero or
as an estimate.

### Desktop and phone

- Desktop uses one summary plus model tabs and one selected response panel. It
  avoids simultaneous full-markdown columns, keeping comparison readable
  without becoming a benchmark dashboard.
- Phone starts with a compact run overview. Selecting a run opens one response
  detail; **Back to overview** returns to the list. Full responses are never
  squeezed into side-by-side phone columns.

## Fusion is a separate semantic workflow

Fusion is not a Multirun winner picker. The user selects source models, each
source answers independently, and a separate synthesis pass produces one
answer. The result leads with that answer and keeps evidence progressively
disclosed:

- **Sources and provenance** shows each source answer and its normalized
  attribution weight.
- **Disagreements** shows reported conflicts or states that the material points
  agree.
- **Continue in chat** seeds the synthesis into the canonical composer without
  auto-sending it.

The current Fusion runner does not report utility-run cost or token totals, so
the UI makes no estimate. This is intentionally different from Multirun's
provider-reported per-run usage.

## Agent switching

Wave 3 adds no dedicated agent-switching surface. The existing composer agent
picker remains canonical on desktop and phone. Its options come from the
backend-reported main agents, include each available description, and make the
effect explicit: the choice applies to the next message in the current session;
it does not create a session or discard history. The pending choice is stored
per session draft and the authoritative agent is recorded with the sent turn.

Multirun reuses the same backend agent catalog but applies one optional agent to
all runs in a comparison. Fusion has no independent agent picker because its
runner is model-source and synthesis oriented.

## Task progress decision

No Wave 3 task-progress hierarchy was added. The current conversation contract
has a flat task plan and task activity for created, started, completed, and
failed states. It has no backend-backed nested, blocked, retry, or cancelled
task model. Presenting those states in a new progress surface would imply
control and fidelity the runtime does not provide.

Existing task progress remains in the conversation: a compact plan summary,
individual task state, and execution milestones. Deeper task topology is
deferred until the backend event contract can support it.

## Activity timeline decision

Wave 3 intentionally does not add a separate activity aggregator. The canonical
conversation timeline already interleaves user messages, agent answers,
reasoning, task activity, tool execution, workflow cards, and failures in event
order. Completed execution folds while active and failed work stays visible.

A second feed would duplicate the same append-only history, introduce ordering
and unread-state conflicts, and compete with the conversation on phones.
Global navigation therefore summarizes attention and working state; inspection
continues in the owning session and workflow surface.

## Background workflows and D17

Multirun and Fusion publish durable background-work counts into the owning
session projection after their start event is appended. Completion updates the
same projection with a replay-dedupable terminal result. The shared D17 status
resolver combines normal turn state with those counts:

1. approval and reply requests retain priority;
2. an active chat turn, Multirun, or Fusion resolves to `Working` with elapsed
   time;
3. failed, reconnecting, unknown, unread, and idle states follow the existing
   priority order.

The sidebar, session hero, mobile navigation, and palette therefore agree when
work continues off-screen. A completed or failed background workflow can also
produce the existing bounded, redacted completion notification, routed back to
its owning session and deduplicated across replay.
