# OpenCode hardening invariants

Status: normative conditions of architecture approval. An implementation that violates one
of these rules is not compatible with the approved design.

1. **Operation identity.** Every logical upstream mutation has one random operation ID and
   one per-session ordinal, both committed before network I/O. Transport, restart, queue
   recovery, and reconciliation never regenerate it; equal text or equal request bodies are
   not identity. The prepared operation and its owning user-intent event, queue reservation,
   response intent, session shell, or deletion tombstone commit in one transaction. One-shot
   and multirun mutations use the same durable prepare/claim/settle rule under stable logical
   task/run identity; background execution is not an exemption.
2. **Operation state.** The durable states are `prepared`, `executing`, `confirmed`,
   `rejected`, `unknown`, and `not-applied`. The only ordinary transitions are
   `prepared -> executing -> confirmed|rejected|unknown` and
   `unknown -> confirmed|not-applied`. Local validation may use `prepared -> rejected`.
   `unknown -> executing` is permitted only for replay with the same operation ID under the
   operation-specific contract in invariant 4.
3. **Crash boundary.** Claiming `executing` is transactional and precedes the first possible
   write. After a crash, `executing` is treated as `unknown`, even if no bytes were sent.
   An uncertain operation never owns an in-memory lock.
4. **Replay.** Generic transport never replays mutations. An `unknown` operation may be
   resubmitted only with the same operation ID and only for an operation whose pinned
   protocol contract proves duplicate submissions have one effect. Otherwise it remains
   unknown until authoritative evidence resolves it.
5. **Rejection and absence.** Transport loss, deadlines, and unclassified HTTP 5xx responses
   are never rejection. `rejected` requires a complete operation-specific protocol response
   that proves no effect. `not-applied` requires an exhaustive operation lookup or a complete
   causally-newer snapshot whose protocol contract proves absence. History similarity is not
   proof. A normalized snapshot must identify the exact non-applied operation; a generic
   domain `complete` flag or continued presence of a pending request is never sufficient by
   itself.
6. **Attention.** Discovery and response intent are durable. A transactional compare-and-set
   chooses one response intent for a permission/question; competing clients get the recorded
   winner. The card closes only on a receipt or authoritative causally-newer evidence.
   Confirmed `rejected`/`not-applied` appends a failed-intent fact and atomically makes the
   same request actionable again; `unknown` does not.
7. **Queue.** Dispatch reserves the existing queue row with its operation ID. Confirmation
   deletes it; rejection proven before admission releases it; ambiguity retains it and
   blocks later FIFO entries.
8. **Binding and fencing.** Every observation carries authority identity, endpoint
   generation, normalized location, backend session ID, and reconciliation request ordinal.
   The complete active binding is persisted with the session projection. Data from a
   non-current generation, location, session binding, or superseded request is rejected
   before translation and again before SQLite claim. Reusing a backend session across a
   generation change requires verified authority continuity.
9. **Observation identity.** Deduplication uses a protocol-proven durable event identity or
   stable upstream entity ID plus revision/state rank. Endpoint generation is a fence, not
   part of the dedup key. Mutable content hashes and arrival order are not identity.
10. **Atomic ingestion.** Observation claim, all canonical events emitted from it, persistent
    message/part/tool checkpoints, and cursor advancement commit in one SQLite transaction.
    Every observation in one normalized snapshot participates in that same transaction; no
    artifact may commit independently. The cursor never advances past an uncommitted
    observation. Projection repair after commit is sequence-idempotent and replay-safe.
11. **Cross-channel recovery.** SSE and pull/history paths normalize the same upstream
    message, part, tool call, and request to the same persistent entity key. Text recovery
    appends only a proven suffix of a stored full-value checkpoint. Divergent or unidentified
    content becomes an explicit uncertainty; it is not appended as duplicate output. One
    tool call emits each lifecycle/terminal rank at most once; a different payload at an
    already-emitted terminal rank is uncertainty, not a second result. An upstream user
    message linked by a protocol receipt to a local prompt operation binds to the existing
    canonical user event and never emits another; content similarity is not a link.
12. **Snapshot authority.** Snapshot absence can close attention or terminalize work only
    when that domain is marked complete and its watermark is comparable with and newer than
    stored evidence. Partial, stale, or unversioned snapshots may add identified facts but
    may not erase or terminalize facts. In particular, legacy `idle`, `failed`, or
    `interrupted` state text without a comparable watermark cannot reopen admission.
13. **Restart barrier.** First wiring, endpoint replacement, and uncertain persisted state
    enter `reconciling`. Mutations, queue dispatch, fork, rewind, and status terminalization
    remain blocked until reconciliation supplies sufficient evidence or the operation stays
    explicitly unknown. "First wiring" includes newly created, forked, imported, and lazily
    materialized sessions; copied/imported history carries a durable baseline so
    reconciliation cannot append it twice.
14. **Ownership.** Only a lease holding an exact child/forward instance token may stop or
    restart it. A discovered/ensured/shared/external service is borrowed by default:
    `dispose` releases Polyth resources and never calls service stop. Config authority is a
    separate exact target and is read-only unless explicitly proven writable.
15. **Config restart.** Config application never interrupts active or waiting work by
    default. It fences admission, waits for authoritative safe-idle, updates only matching
    owned targets, replaces the generation, and reconciles before reopening admission. The
    admission fence is one critical section spanning the safety check, config writes,
    replacement, and reconciliation. Pending restart intent is linked to captured endpoint
    generations so a newer generation that already supersedes it is not destructively
    restarted again. A timeout leaves the change pending; it does not force a kill.
16. **Lock liveness and clients.** Every network await under a session scheduler has a finite
    deadline and releases the scheduler in `finally`. Durable state, not a held promise,
    blocks conflicting work. Multiple clients through one Polyth server are ordered by the
    durable per-session ordinal. Multiple Polyth server processes sharing one data directory
    are unsupported and must be prevented at startup unless endpoint leadership is also made
    durable.
17. **Protocol gating.** A generated field is not a capability. V2 mutation replay, cursor
    resume, complete pending snapshots, service continuity, and writable ownership stay
    disabled until pinned live contract tests establish their exact semantics.
18. **Canonical truth.** Model-visible facts are appended before display. Canonical events
    are immutable, and stale backend evidence can only be ignored or appended as explicit
    uncertainty; it never overwrites newer durable truth. Hard deletion retains a durable
    binding tombstone outside the deleted log until upstream deletion is confirmed or an
    explicit purge policy applies, so restart cannot re-adopt stale backend state.
