# UX-MSG-ACTIONS — event-log-safe message actions specification

- Case: `UX-MSG-ACTIONS`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `9c658ad3c0cd042333e38b38264679c8db5c7a96`
- Inputs: polyth audit at `a1d4a9d` and Polyth audit at `8cf61bf`
- Scope: Revert and edit, Fork and edit, copy, message timing, reasoning
  disclosure, and their replay/backend safety. This artifact changes no product
  code.

## Decision and user outcome

Polyth keeps its useful Markdown/JSON copy choices and its keyboard-safe
focus-within discovery, but does not ship the audited mutation path.

The per-user-message actions are:

1. **Revert and edit** — keep the current session, hide the selected prompt and
   every later event, and put that prompt's exact raw text and attachments in an
   editable composer draft.
2. **Fork and edit** — create a child from the history immediately **before**
   the selected prompt, then put that prompt's exact raw text and attachments in
   the child composer as an editable draft.
3. **Copy as Markdown** and **Copy as JSON** — copy only the selected projected
   message, announce success or failure, and do not change session state.

The selected prompt is deliberately excluded in both mutation journeys. The
timeline therefore contains no committed copy of the editable draft. Sending
the draft appends exactly one new `user/message`; cancelling or editing it sends
nothing. This resolves the audited Polyth ambiguity where Fork included the
prompt but left the composer empty, and it improves on polyth by making the
branch draft replayable after reload.

Assistant messages expose Copy as Markdown/JSON, semantic completion time, and
one reasoning disclosure. Revert/Fork never appear on assistant, tool, task, or
reasoning-only records. A reasoning part can be disclosed and copied, but can
never also become an ordinary answer bubble.

## Audit comparison the implementation must resolve

| Concern | polyth `a1d4a9d` | Polyth `8cf61bf` | Required Polyth result |
|---|---|---|---|
| Keyboard discovery | Composer traps Tab; focus does not reveal hover actions. | Tab leaves the composer and focus-within reveals the row. | Preserve Polyth's sequential navigation and focus-within behavior. |
| Copy | One plain-text copy; visual checkmark only. | Exact Markdown and JSON; unlabelled flash only. | Keep both formats, use purpose-and-target names, one live announcement, and stable focus. |
| Revert | Durable marker, exact text prefill, reload-safe hidden tail. | Marker replay is sound, but stale `working` state can make the offered action return `409`; Restore leaves the draft and loses focus. | Truthful eligibility, serialized state, replay-derived draft, and deterministic restore focus/draft cleanup. |
| Fork | Child exists, but prefill disappears on reload. | Canonical child copies the prompt while its backend has unrelated history. | Exclude the prompt, persist a child draft marker, and publish no child until canonical and backend histories agree. |
| Reasoning | Disclosure works but preference-gated. | Disclosure works, but missing delta classification duplicates reasoning as an answer. | Buffer untyped deltas, finalize reasoning as reasoning-only canonical content, and render one disclosure. |
| Touch | Persistent `36×36px` controls, sometimes occluded. | Invisible `22.5px` controls, sometimes above the viewport. | Persistent named action entry, at least `44×44px`, inside the visible scrollport at `320/390px`. |
| Timing | Times exist; duration can render `4m 60s`. | No message times; inherited totals can produce `worked 0s`. | Event-derived message times and one completed-turn duration with normalized carry. |
| Failure | Fork failure leaves source selected and no optimistic child. | Same behavior passes. | Preserve it for every backend, validation, and storage failure. |

## Canonical invariants

These are release blockers, not implementation preferences:

1. The ordered session event log is the canonical source for timeline replay,
   model-history derivation, export, mutation eligibility, timestamps, and
   branch-point selection.
2. Model-visible runtime content is appended before broadcast or display.
   `assistant/reasoning-chunk` follows the same rule even though it is a
   provisional surface event.
3. Copy, disclosure open/closed state, hover/focus state, and time formatting
   are presentation-only and append no event.
4. Revert and Fork never mutate or delete prior events. Revert appends a marker;
   Fork creates a child snapshot plus a lineage marker.
5. A child is not returned, projected, broadcast, selected, or navigated to
   until its canonical prefix and backend prefix represent the same history.
6. Runtime callbacks for one canonical session are processed in arrival order.
   A terminal `turn/stopped` cannot be overwritten by an older usage or chunk
   projection update.
7. Replay from event `1`, incremental WebSocket application, direct URL reload,
   export, and `deriveMessages()` produce the same visible prefix and branch
   point.
8. A failed mutation leaves the source event count, source projection, active
   selection, URL, composer, and model backend mapping unchanged.

## Revert and edit

### Eligibility and naming

The visible label is `Revert and edit`; the accessible name is
`Revert and edit user message sent <full local date and time>`.
`session/rewound` remains the event name for compatibility.

The action is enabled only when all of the following are authoritative at
activation time:

- the target is a visible `user/message` in the current replay;
- no runtime turn admission, active turn, unresolved question/permission, or
  queued delivery exists;
- no rewind marker is already active;
- the session is not archived and the target belongs to this session.

The row may explain an unavailable action as `Revert unavailable while a turn
is running`, `…while a request is waiting`, `…while messages are queued`, or
`Restore or replace the current revert first`. The server repeats validation
inside the per-session mutation lock. A race returns a typed conflict and the UI
refreshes eligibility; it never offers a control known to deterministically
fail.

### Event and replay contract

Successful activation appends:

```json
{"type":"session/rewound","data":{"atSeq":42}}
```

New writes do not duplicate prompt text in the marker. The target
`user/message` already owns raw text, expanded text, and attachments. Existing
markers with `restoredText` remain readable.

Replay treats the target and every later pre-marker event as a hidden tail.
`deriveMessages()`, the timeline reducer, export, and backend branch preparation
use the same pure effective-history selector. The active marker also derives a
composer seed from the target's `raw ?? text` and attachments.

Draft persistence records provenance (`rewind:<markerSeq>`) and distinguishes
an untouched seed, an edited draft, and a deliberately cleared draft. Reload
must not overwrite an edit or reinsert a draft the user cleared.

The hidden-tail dock says `<n> reverted timeline items` and offers:

- `Restore original timeline`; and
- the existing explicit replacement path through Send.

Restore appends:

```json
{"type":"session/rewind-cleared","data":{"rewindSeq":57}}
```

If the generated draft is untouched, Restore clears it. If it was edited,
Restore asks before discarding it; the confirmation names both outcomes.
Successful restore focuses the invoking control when it survives, otherwise
the restored target's `Revert and edit` action. Focus never falls to `BODY`.

### Replacement send

A send while a rewind is active first prepares a backend branch that contains
the exact canonical effective history before the target. It must not use the
current audited `resetSession()` behavior, which creates an empty backend.

After backend preparation succeeds, the server appends, in order:

```json
{"type":"session/rewind-cleared","data":{"rewindSeq":57,"replaced":true}}
{"type":"user/message","data":{"text":"edited prompt","attachments":[]}}
```

The normal turn starts only after `user/message` is durable. If backend
preparation fails, the rewind and draft remain active and neither event is
appended. Restore before replacement keeps the original backend conversation;
it does not rebuild or fork it.

## Fork and edit

### Exact branch semantics

Per-message Fork accepts only a visible `user/message` and uses the same idle,
waiting, queue, archive, and active-rewind guards as Revert. The accessible name
is `Fork and edit from user message sent <full local date and time>`.

For target source sequence `atSeq`:

- canonical child history contains the source's effective events strictly
  before `atSeq`;
- model history is `deriveMessages(childPrefix)`;
- the target input is absent from child model history and appears only as a
  draft;
- the backend child ends at the same predecessor as the canonical child; and
- source state is unchanged.

The existing whole-session Fork entry points remain: with no `atSeq`, they copy
the complete effective history at the locked source tail and create no draft.

### Generic runtime seam

Add a provider-neutral optional runtime operation in `@polyth/contracts`:

```ts
interface RuntimeBranchRequest {
  sourceSessionId: string;
  target: CreateSessionInput & { sessionId: string; cwd: string };
  history: ModelMessage[];
}

branchSession?(request: RuntimeBranchRequest): Promise<string>;
```

`sourceSessionId` and `target.sessionId` are canonical ids. The returned string
is the backend child id. The server passes only the canonical effective model
history; it does not know an OpenCode message id.

`packages/backend-opencode` implements this seam by resolving the mapped source
backend session, matching the requested normalized prefix to backend messages,
and using OpenCode's native session fork at the exact predecessor message. An
empty prefix creates a fresh backend session. It reads the child history back
and rejects `history-mismatch` unless role/order/text match the requested
prefix. Duplicate prompt text must not cause an earlier occurrence to be
selected. No other package may call the OpenCode endpoint or SDK.

If a runtime cannot branch or hydrate exact history, return `unsupported`.
Never approximate the prefix with a hidden system prompt, summary, or
optimistic UI-only copy.

The same operation is used to prepare a replacement backend for Revert; in that
case the canonical target id equals the source id and the adapter swaps its
mapping only after the exact prefix is verified.

### Atomic canonical publication

The session store gains one transaction that:

1. inserts the selected child prefix;
2. inserts the child projection with the verified backend id; and
3. appends one child lineage marker.

For per-message Fork the marker is:

```json
{
  "type": "session/forked",
  "data": {
    "fromSessionId": "source-id",
    "sourceAtSeq": 42,
    "copiedThroughSeq": 41,
    "draft": {
      "text": "exact raw prompt",
      "attachments": []
    }
  }
}
```

The marker is `ignorable:true`; the draft is not model-visible. Copied event
times and payloads remain exact so timing/export replay is stable. Copied child
events receive child ids and source-sequence provenance instead of reusing one
event id across sessions.

The server broadcasts copied events, the marker, and the projection only after
the transaction commits. The client stores the marker-owned child draft before
opening the child. On reload, the marker seeds the draft only when there is no
newer child-origin `user/message` and no locally edited/cleared draft record.
Sending therefore consumes the seed exactly once.

Backend preparation failure creates no canonical child. Canonical transaction
failure exposes no child and best-effort discards the unreferenced backend
branch. The source stays selected and receives a bounded explanation.

## Copy contract

Finalized user and answer messages expose:

- `Copy user message as Markdown` / `Copy assistant answer as Markdown`;
- `Copy user message as JSON` / `Copy assistant answer as JSON`.

The visible compact labels may remain `MD` and `JSON`; the accessible names may
not. Reasoning disclosure adds `Copy reasoning for assistant answer`.

Markdown is the exact projected message text. JSON is stable pretty-printed
UTF-8 with `role`, `text`, ISO `time`, numeric `timeMs`, and sanitized visible
attachments; assistant JSON may include the disclosed reasoning. It includes
no backend id, credential, hidden reverted tail, local-storage provenance, or
unresolved internal metadata.

After a successful write, focus remains on the invoked item and one timeline
live region announces `Message copied as Markdown`, `Message copied as JSON`,
or `Reasoning copied`. Clipboard rejection announces `Couldn’t copy message`
and preserves the prior clipboard. Checkmarks/color may supplement but never
replace the text announcement. Copy appends no session event.

## Message timing and completed-turn footer

Every user and finalized assistant answer renders a semantic `<time>`:

- user: visual short local time; accessible name `Sent <full local date/time>`;
- assistant: visual short local time; accessible name
  `Completed <full local date/time>`.

The user time comes from its `user/message.time`. Assistant completion time
comes from the final `assistant/message.time`, not its first streamed chunk.
Copied fork events retain source times. Formatting uses `Intl.DateTimeFormat`
and valid ISO `dateTime`; timezone/12-hour choice follows the browser locale.
No new preference, event, or server clock endpoint is introduced.

The bottom footer belongs to one terminal visible turn. The reducer records its
`turn/started.time`, terminal `turn/stopped.time`, resolved model/agent, and
that turn's usage separately from lifetime totals. Duration is
`max(0, stoppedAt - startedAt)`, normalizes rounded seconds into minutes
(`4m 60s` becomes `5m 0s`), and is absent for an unmatched copied prompt or a
working turn. A branch does not combine inherited lifetime usage with a new
zero-duration pseudo-turn.

## Reasoning contract

`packages/backend-opencode/src/events.ts` must classify a part once before
exposing it:

- explicit delta field `text` or `reasoning` establishes the type;
- a delta with no type is buffered by part id and emits nothing;
- `message.part.updated.part.type` resolves buffered bytes to exactly one
  canonical channel;
- later updates cannot migrate already displayed reasoning into answer text;
- reasoning parts never enter the text-finalization map.

A finalized text part emits `assistant/message { partId, text }`. A finalized
reasoning part emits the existing model-visible shape
`assistant/message { partId, text:"", reasoning }`; `deriveMessages()` skips an
empty text part. `flushAssistantOnIdle()` finalizes known text and reasoning
maps independently and never treats an unknown part as text.

The timeline may show provisional `assistant/reasoning-chunk` content only
after each chunk is durable. The final reasoning-only `assistant/message`
replaces/finishes that part during replay. `mergeThinking()` may visually merge
adjacent reasoning into its answer, but there is one disclosure, no ordinary
reasoning bubble, and no message-copy actions for a reasoning-only record.

The disclosure is a keyboard-operable native control named
`Show reasoning for assistant answer` / `Hide reasoning for assistant answer`,
with truthful expanded state. Enter and Space work, focus remains on the
summary, and expand/collapse appends no event.

## Runtime ordering and projection truth

Wrap each runtime callback in a per-canonical-session promise chain; do not use
unobserved parallel `void onRuntimeEvent(...)` calls. A failure is logged and
contained without breaking the chain.

Projection patches also operate on the latest row in one store transaction.
Token/cost increments are read-modify-written there. A callback must not read a
projection, await, then overwrite fields changed by a later callback.
Broadcast the exact committed projection.

Revert/Fork validation and publication run under the same session mutation
serialization. This closes the activation race between an apparently idle
message row and a newly admitted turn. The event log remains append-before-
broadcast; sequencing is not permission to display first.

## Responsive and accessibility behavior

At hover-capable widths the row may be visually quiet, but:

- message hover and action-row focus-within reveal it;
- hidden controls have no pointer hit area;
- sequential Tab/Shift+Tab reaches every action in DOM/timeline order;
- every focused control has a visible focus indicator and stays in the
  scrollport.

At non-hover or `max-width:480px`, each actionable message has one persistent
`44×44px` minimum button named `Actions for user message sent …` or
`Actions for assistant answer completed …`. Its menu contains the copy and
eligible mutation actions as `44px` minimum rows. The button and open menu stay
inside the visible timeline at `320×844` and `390×844`; no sticky header, panel,
or rail may cover their center points. Time remains visible without opening the
menu.

Menus expose expanded state, close with Escape/outside press, and restore focus
to their opener. Pointer, Enter, and Space produce the same operation. The
composer keeps its existing non-trapping Tab behavior when autocomplete is
closed.

## Minimal implementation files and seams

| File | Exact responsibility |
|---|---|
| `packages/contracts/src/index.ts` | `RuntimeBranchRequest`, optional `AgentRuntime.branchSession`, fork-result/marker draft types, optional reasoning on runtime final records, and atomic persistence seam types. |
| `packages/session/src/index.ts` | Pure effective-history selector shared by replay/model derivation, atomic child snapshot transaction, atomic projection patch, empty-text omission in `deriveMessages`, and lineage provenance. |
| `packages/server/src/sessions.ts` | Per-session runtime/mutation sequencing, truthful guards, backend-first branch preparation, append-before-broadcast, Revert replacement ordering, and all-or-nothing Fork publication. |
| `packages/server/src/index.ts` | Forward `branchSession` through the reviving runtime facade without importing OpenCode details. |
| `packages/server/src/http.ts` and `apps/web/src/api.ts` | Preserve routes; return typed fork draft/lineage and typed conflict/mismatch errors. |
| `packages/backend-opencode/src/index.ts` | Sole native backend fork implementation, exact predecessor resolution/history verification, mapping swap, and orphan cleanup. |
| `packages/backend-opencode/src/events.ts` | One-time part classification, unknown-delta buffering, and independent text/reasoning finalization. |
| `apps/web/src/reduce.ts` | Replay-derived hidden tail, marker-owned seed, final assistant time, terminal-turn timing/usage, and reasoning-only final records. |
| `apps/web/src/messageActions.ts` (new) | Pure labels, copy payloads, timestamp formatting inputs, and action availability presentation. |
| `apps/web/src/components/Timeline.tsx` | Render named actions/menu, semantic times, live feedback, disclosure, dock confirmation, and deterministic focus restoration. |
| `apps/web/src/init.ts`, `apps/web/src/drafts.ts`, and `apps/web/src/attachments.ts` | Save child seed before navigation; persist draft/attachment provenance and intentional empty drafts; consume seeds after send. |
| `apps/web/src/styles.css` | Hover/focus reveal, no invisible hit areas, persistent touch entry, `44px` targets, menu positioning, and focus treatment. |

Tests belong in existing suites:

- `packages/session/test/session.test.ts`;
- `packages/server/test/delivery.test.ts`;
- `packages/backend-opencode/test/adapter.test.ts` plus focused event
  translation cases;
- `apps/web/test/smoke.test.ts` and a live
  `apps/web/test/messageActions.live.ts` browser gate.

Do not modify unrelated shell, rail, theme, plugin, permission, queue, or
composer-controller architecture. Keep the post-audit root-relative asset fix;
canonical URL reload is a regression gate, not a new routing project.

## Acceptance

### Automated event/backend gates

1. Replaying a two-turn log, appending Revert at the second user sequence, and
   rebuilding from event `1` yields only turn one in timeline/model/export and
   derives the exact second raw text plus attachments as the draft.
2. Restore reproduces the exact original log projection. Replacement produces
   prefix + one edited `user/message`; hidden original events remain on disk but
   never enter effective model history.
3. Fork from the second prompt creates prefix-through-turn-one, an ignorable
   lineage/draft marker, no copied second `user/message`, and a backend whose
   exact prior-message probe returns turn one's prompt. Sending the unchanged
   seed creates exactly one second prompt.
4. Identical prompt strings in two turns still select the requested later
   backend predecessor; mismatch/unsupported/backend `500` creates no
   projection, event, selected session, URL change, or draft change.
5. Inject `usage/recorded` and `turn/stopped` callbacks back-to-back without
   awaiting them, repeatedly. Event order stays arrival order, totals apply
   once, projection ends `idle`, and Revert succeeds.
6. A missing-field delta followed by a reasoning part update yields reasoning
   chunks plus one reasoning-only final record, zero ordinary duplicate answer
   bubbles, and one canonical reasoning value after full replay.
7. A text part followed by stop yields one finalized answer. Full replay and
   incremental reduction are deeply equal for messages, reasoning, hidden tail,
   current turn, time, and usage.
8. Forked/copied event times are unchanged. The footer uses one turn's start and
   stop, carries rounded seconds, and does not render `worked 0s` for a draft.
9. Markdown/JSON/reasoning copy payload tests assert exact text, parseable
   stable JSON, ISO and epoch time, sanitized attachments, and absence of
   backend/internal fields.
10. The OpenCode boundary grep still proves only
    `packages/backend-opencode` contacts the process/SDK/endpoints.

### Live interaction gate

Against the isolated synthetic runtime, test completed, failed, empty,
active-turn, queued, waiting, active-revert, fork-failure, and backend-mismatch
states at `1280×900`, `390×844`, and `320×844`:

1. Hover and keyboard focus reveal desktop actions; Tab and Shift+Tab move
   between timeline and composer without trapping.
2. Every action has a purpose-and-target accessible name. Copy announces one
   result and retains focus. Reasoning toggles with pointer, Enter, and Space.
3. Touch action entries and menu rows are at least `44×44px`; unforced center
   taps hit the intended control and no center is covered or outside the
   scrollport.
4. Revert, reload, Restore, Revert again, edit, and replacement all preserve the
   specified timeline/draft state. Restore never leaves focus on `BODY`.
5. Fork selects the child only after success, shows the excluded prompt in the
   composer, survives direct canonical URL reload, and sends it once.
6. Times are semantic and stable across reload/fork. Reasoning appears once and
   copy never includes a hidden reverted tail.
7. A disclosed fork `500` and a forced history mismatch keep the source
   selected, append no canonical event, and show a bounded actionable error.

Run:

```sh
node --test packages/session/test/session.test.ts
node --test packages/server/test/delivery.test.ts
node --test packages/backend-opencode/test/adapter.test.ts
node --test apps/web/test/smoke.test.ts
node --test apps/web/test/messageActions.live.ts
(cd packages/contracts && npx tsc --noEmit)
(cd packages/session && npx tsc --noEmit)
(cd packages/server && npx tsc --noEmit)
(cd packages/backend-opencode && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
```

## Explicit non-goals

- No product implementation in this specification commit.
- No assistant-message Revert/Fork, arbitrary event-level branching, editing a
  committed event in place, event deletion, or database history rewrite.
- No approximate backend hydration, hidden summary prompt, optimistic child,
  client-only transcript hide, or UI history that differs from model history.
- No reasoning generation, reasoning-content rewrite, chain-of-thought
  inference, new reasoning preference, or disclosure telemetry.
- No clipboard history, server-side copy endpoint, copy analytics, timestamp
  event, server timezone preference, or global 12/24-hour setting.
- No message pinning, selection-action redesign, tool-card action redesign,
  whole timeline export redesign, or broad composer/sidebar/header changes.
- No polyth DOM/CSS, `24/36px` targets, hover-only keyboard behavior,
  composer Tab capture, duration bug, or ephemeral fork prefill.
- No OpenCode import outside `packages/backend-opencode`, no backend identifiers
  in browser DTOs/copy output, and no relaxation of append-before-display.

## Exact next task

`Fable-MSG-ACTIONS-implementer`: implement only the seams and acceptance gates
in this specification, then hand the isolated runtime and passing artifacts to
the SOL verifier.
