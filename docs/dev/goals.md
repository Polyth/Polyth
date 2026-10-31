# Session goals

`packages/goals` owns the objective, audit decisions and bounded continuation
policy. Canonical session admission, queues, execution and history remain owned
by the session service. Goal state is rebuilt from ignorable `goal/*` events;
there is no separate goal database or native agent loop.

With the opt-in Judgment use `goals.audit` the completion audit asks Judgment
instead of the small model (done/stuck/progressing plus a 0–4 progress score);
any failure falls back to the small-model audit. See
[packages/goals/README.md](../../packages/goals/README.md).

## Delegated work

An audit reads the parent's latest canonical reply and bounded reports from its
descendants. The tree follows `parentId` within the same Project and Space.
`session/forked` identifies provenance branches, which are excluded along with
their descendants. Reading context uses persistence and does not activate native
runtimes. Indexed history reads pass through the package host's scoped session
guard before querying persistence. Only user prompts and assistant text become reports; raw tool payloads,
reasoning and secret events are excluded. Chunk-only reports are supported.

Working, waiting, queued and uncertain descendants keep the parent goal active.
An idle child whose completed turn is still being assessed by its own active goal
also remains pending, and so does a child a person paused (`projection.paused`)
until it is continued or stopped. Failed or aborted children settle as failures to inspect;
their unfinished goals do not make the parent wait indefinitely. A request for
user action or uncertain execution is never treated as proof of completion.

Dependency waits append `goal/audit` with `verdict: "keep"`,
`disposition: "waiting"`, and `waitingFor` canonical session IDs. They reset the
stuck streak and consume neither model calls nor continuations. The goal can
still be paused or stopped, and its reason appears in the goal UI.

Canonical terminal notifications (`completed`, `error`, `aborted`) and the
settlement of a child's own goal audit reconcile waiting ancestors. When every
dependency settles, an idle parent with no pending input gets one bounded
continuation containing the child reports. The parent must integrate, handle
failures and verify the objective before its next audit can declare completion.
A child completing its turn never completes the parent's goal by itself.
Existing session watches can already wake the parent; working or queued parents
are left to finish that input, preventing an extra goal continuation.

Readiness covers all descendants. Report content is limited to sixteen children
and a 16,000-character allocation, with recent reports first and an omission
count. Session IDs let the parent read omitted reports through ordinary session
tools. The goal token budget continues to account for its own session's usage;
it is not a shared spending limit for the session tree.

## Concurrency and recovery

Each goal serializes assessments and coalesces notifications using a canonical
context revision. A changed parent turn or child state invalidates an in-flight
verdict. Pause, stop, replacement and package teardown also fence inference.
Package disable does not imply that a provider process has been released.

A continuation intent, including its text and operation UUID, is persisted in
`goal/audit` before admission. A failed persistence write cannot authorize
delivery; the same intent must be recorded successfully before admission.
Delivery uses the existing session service
`clientOperationId` boundary. `goal/continuation-admitted` records acknowledgement
without overwriting a concurrent goal control action. Restart or re-enable
reconciles durable waits and unacknowledged intents once, without polling.
The same UUID recovers confirmed/queued admission; an unresolved canonical
operation is refused by the session service and leaves the goal stuck. Recovery
never retries an uncertain native mutation.

New goals persist the requesting account ID for utility-model selection after
restart. Legacy logs remain readable. Background goal execution uses the existing
trusted-local system session boundary; this does not add shared-deployment
background authority.

## Verification

Run the owning goal tests and the adjacent session admission, watch, track and
web replay checks with explicit Node type stripping. Use the resource limits in
[verification](../agents/verification.md). `packages/goals/test` covers dependency
waits, nested trees, known-valid foreign-Space exclusion, fork isolation, chunk
reports, pause/replacement races, limits, replay and interruption around admission.
Fake completions establish deterministic behavior without paid provider turns.
