# Session reading and bounded delivery

Canonical events remain the source of truth. The session store commits each
event with its own monotonic sequence before publication. Transport batching
does not replace events or relax tool/control/terminal ordering barriers.

## Reads and activation

Session list, snapshot and history reads use persisted state without attaching
a harness, reconciling execution or dispatching queued work. Interactive open
uses `POST /api/sessions/:id/activate` separately. Its body names the intent
(`SessionActivateOptions`). `{ "intent": "open" }`, which the web client sends
when a person opens a chat, runs the lifecycle pass only when the session has
work that needs a runtime: a non-`idle` status (including `epoch-pending`), a
harness transition, delegated settlement, a pending history import, a
reconciliation that is not `ready`, a blocking operation, an open request, or
a non-held queued prompt. A quiet idle chat starts no native process.
`{ "intent": "warm" }`, or no intent (what older clients send), always runs it
and starts the runtime for an imminent turn. The client warms the chat on
screen after 20 s of visible dwell or as soon as the person types into its
focused composer, at most once a minute per chat (`apps/web/src/sessionRuntimeWarm.ts`).
Sending wires the runtime on demand either way. A session lifecycle job owner
provides single-flight activation, two concurrent jobs, a 128-job admission
bound and shutdown cancellation. Each active job owns a cancellation signal;
completed jobs do not retain abort listeners on the owner. Startup recovery submits pending queue,
import and delegated-child work through this owner. Queue admission retains
FIFO, held-for-review and durable mutation reconciliation.

Activating a session that was dormant across a restart is recover-on-use. When
its owned runtime authority no longer exists, wiring marks the epoch pending.
Only a session with work to resume (a cut turn or a queued message) is
recovered without being opened; `activate` starts or joins the recovery — also
for a session that was still wired when its runtime identity broke — and
finishes the lifecycle pass on the replacement epoch, so a normal open never
reports the transient state as a conflict. It still answers `epoch-pending`
(HTTP 409) when the epoch cannot be recovered in place (a borrowed endpoint, or
a runtime that cannot reset) or when the recovery failed, because the durable
pending state is then the truthful outcome.

A session is announced when its projection commits, but its canonical resource
stays `provisioning` until create settles. A history read (`events`) of such a
row gives canonical reconciliation one chance before the access decision, as
`snapshot` does, so a just-announced session is readable instead of answering
404. A principal who could not read the row, and rows in any other lifecycle,
are decided immediately and never trigger reconciliation.

Server control paths that run per runtime event, on a timer or for every row at
startup never replay a session's whole log; long sessions hold six-figure event
counts, and one replay cost about half a second of the server's only thread.
The tool watchdog (arm, sync, rehydrate, stop), the quiet-turn check,
stopped-turn admission and the unadmitted-content check answer from the
incremental log facts, the store's indexed `eventsOfTypes` and
`lastTurnEventType`, and tool events read only after the newest turn boundary.
`packages/server/test/historyReplayHotPaths.test.ts` counts unbounded reads on
those paths.

Native imports expose `historyImport` state. Each batch atomically commits
events and a count/digest checkpoint. Resume checks the native transcript
prefix; mismatch fails instead of duplicating or rewriting canonical history.
Legacy partial imports are matched against canonical message events before
establishing a checkpoint. Sending is blocked until import completes; drafts
remain available. Native transcript acquisition itself is still constrained
by the harness history API, which does not guarantee paging.

## History protocols

The legacy `events` limit selects the **newest** matching records, returned in
ascending sequence. `beforeSeq` pages older windows. Newest/older windows
bound materialization to 2,000 events and 512 KiB; one larger event is allowed
up to the 8 MiB transport ceiling.

`GET /api/sessions/:id/events/forward` returns `events`, `cursor`, `highWater`
and `complete`. Its first page captures the committed high-water sequence;
continuations carry it unchanged. Queries use `seq > cursor AND seq <=
highWater ORDER BY seq ASC`, at most 500 events and 256 KiB per server page.
The store validates continuity. An oversized event fails explicitly; a WS
client closes with 1009 instead of retrying the same event indefinitely.
Legacy unlimited HTTP JSON-array reads stream these pages with socket
backpressure and authorization checks between pages.

WS replay captures live arrivals before reading its boundary, reads bounded
pages, then merges a contiguous live tail. Each page is read only after the
previous one is written to the socket (the `ws.send` callback), which also
yields the event loop; queuing pages ahead of the compressor would cross the
high-water mark and force a resync. The gateway negotiates permessage-deflate
(level 1, frames ≥ 1 KiB; screencast frames never) with clients that offer it;
a real 500-event page measured 184 KB → 39 KB. Polyth Link's host builds its
own upstream handshake without the extension, so Link frames are unchanged. Socket
close, replacement subscription and authorization loss cancel stale work
between pages. Live buffering is capped at 2,048 events / 4 MiB, in addition
to existing socket high-water protection. Client received and applied cursors
are distinct; only the applied contiguous prefix is acknowledged for resume.
HTTP reconciliation/backfill uses bounded pages and stops stale navigation or
Space work. A connected WS owns foreground suffix reconciliation.

## Navigator and client state

`GET /api/sessions/summaries` defaults to 50 rows, at most 100, ordered by
`updatedAt DESC, id DESC`. Search, archive, attention, date and worktree filters
run across the scoped catalog. Rows omit runtime binding, workspace/config
and draft payloads. A page carries completeness, continuation and a
Space-scoped catalog revision. A caller can pin `revision`; changes reject
the continuation with `catalog-changed`. Pages upsert rows and never imply
deletion of other cached sessions. Full metadata is available by ID. The
internal `ids` filter (WS only, at most 100, never read from HTTP) returns just
the named rows of the reader's Space; the socket's reconnect snapshot uses it
for the rows the client still shows as active (`refreshSessionIds`), because no
other query returns a row whose activity ended while the link was down.
A recency page never guarantees a pinned chat, so `pinned=true` filters the
catalog to the reader's pinned rows (their own pin, else the shared pre-v21
one; `pin_position -1` is an explicit unpin). The WS navigator snapshot and the
web client's project refresh read it next to the newest page, so an old pinned
chat stays in the Pinned group after a reload or reconnect. `updatedAt` is
session activity: derived maintenance (runtime wiring, reconciliation,
Auto-Approve/Full access flag sweeps after a Space or project policy change or
at boot) writes the projection without touching it, so such a sweep cannot
reorder the whole catalog.
Summary fields form a complete navigator row: absent pin/folder/label fields
clear the cached value. The row's status-resolving fields (`resume`,
`runtimeControl`, `harnessTransition`) are summary fields too, so a limiter
pause or a dormant owned epoch shows its real mark before the session is
opened. Attention counts come with every projection from the server's durable
open-request table. Only the selected session, whose cached window is the one
kept live, re-derives them from events; another row's cached window (an
earlier visit, a hover warm) may be stale or bounded, so that row keeps the
server's counts and an approval shows as one before it is opened. A
selected session whose open requests are all ones its Auto-Approve/Full
access policy will answer is presented as working, not "waiting for you":
choosing the policy on a card publishes it before the server answers the
request (the server answers that session first, then sweeps the rest). Unsent
runtime/workspace details remain a cache only; opening a summary revalidates
the full row by ID.

New WS clients request summary projections; old clients retain the full
projection protocol. An unselected socket receives projections/notifications,
not all token events in its Space. Projection snapshots publish one batched
upsert and prune once. Runtime-feature refresh is limited to loaded sessions,
with two concurrent requests and a 32-entry queue. Desktop and mobile
navigators share a cancellable pager; revision conflicts restart at the newest
page once. Partial caches never authorize a bulk deletion.
An explicitly selected session receives one full metadata snapshot after
replay, including drafts, even outside the navigator page and when navigating
within the same project. Other rows remain summaries. This closes the metadata
gap between the initial HTTP read and subscription without waking a runtime.

Physical checkout ownership and dependency checks use a derived path index.
Projection create/rebind/isolation/delete transactions maintain it; old writers
leave durable dirty markers repaired in bounded batches before a lookup. This
host-internal check deliberately spans Spaces so a foreign session cannot
borrow a physically occupied checkout. It never exposes foreign identifiers.
Legacy projections without workspace manifests resolve the project root and
use an indexed per-project candidate.

Native quarantine maintenance acquires a bounded store reference lease in
addition to the physical runtime allocation lease. Projection transactions
reject a new reference to that checkout until removal settles; the fence is
released on success or failure. Old operation rows lack physical keys, so an
unresolved operation is located through durable session facts: a live
session's current binding (the usage index), a deleted session's tombstone
directory, and nothing for a transient runtime task (`runtime-task/create-intended`,
never reconciled). Any other unresolved operation conservatively holds every
cache. Under the same lease a cache whose checkout has been gone for 7 days
(a released isolate leaves one) is retired whole: renamed out of the lookup
namespace, then removed; a crash in between is finished on the next pass.
This maintenance lease does not authorize canonical event retention changes.

Event arrays use immutable shared segments. Existing incremental reduction
has an explicit changed-message frontier for text/reasoning-only batches;
timeline grouping reuses the completed prefix. Message revisions remain the
render invalidation signal. The ingestion queue flushes at 256 events or
512 KiB even when background timers stop. Paint scheduling never owns durable
acceptance. Inactive history caches are evicted whole, with 12 session,
8,000-event / 8 MiB per-session and 24 MiB aggregate bounds. These are estimates
of event allocation, not process RSS limits. Render-model caches are capped at
32 sessions and navigation hints at 64; optional pointer prefetch admits at
most four concurrent requests. Active history still requires a
semantic checkpoint before it can be truncated safely; shared segments alone
do not establish a lifetime memory bound.

## Migration and compatibility

Session schema v16 adds derived navigator/unread indexes and Space-scoped
revision triggers; v17 adds checkout references. The existing immediate transaction owns each migration;
canonical event bytes and retention are unchanged. Reopen is idempotent.
Index creation on a large database needs the ordinary controlled upgrade
window and disk headroom; this is not an online maintenance or VACUUM command.
Old HTTP array responses and old WS projection subscribers remain supported.
Rollback of code does not remove these additive indexes/triggers. Schema
downgrade is not provided; restoring a database requires the deployment's
separately verified backup procedure.
