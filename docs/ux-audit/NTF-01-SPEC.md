# NTF-01 — persistent notification centre specification

- Case: `NTF-01`
- Model / role: `SOL` / contract and architecture specification
- Status: `specified`
- Specified: `2026-08-23`
- Product source baseline: `a5e2d7dae39907459e411e3e5fa27c0e08805ef5`
- Input: `docs/ux-audit/NTF-01-AUDIT.md`
- Scope: one server-owned notification inbox, its REST/WS contract, and the
  header/rail/settings client surfaces. This artifact changes no product code.

## Decision and user outcome

Polyth gains a persistent notification centre that contains the same canonical,
server-formatted completion, failure, question, permission, and delegated-agent
notices sent to web push. A bell shows the global unread count. Its panel lists
the newest retained notices, supports mark-read/read-all/clear, and opens the
owning session when that session still exists.

The centre records only at `createPushNotifier()`'s transition-only `deps.send`
sink, immediately after `buildPushPayload()`. It does not watch projections,
persist `diffNotifications()` output, or append notification-centre records to
a session event log. This avoids a third transition detector and preserves the
existing append-before-display rule: the source session event is durable before
the derived inbox record, and the inbox record is durable before WS or push.

## Release invariants

These are implementation requirements:

1. `NotificationRecord` is a shared browser/server contract. The inbox file is
   derived server state, never a `SessionEvent` and never model-visible.
2. The only production writer is the `createPushNotifier()` send sink. The
   `/api/push/test` path calls `PushService.send()` directly and therefore never
   creates a centre row.
3. `turn/stopped { reason:"aborted" }` creates no row. Auto-accepted permissions
   create no row. A transition creates at most one row and one
   `notification/added` WS envelope.
4. Persist the row before broadcasting it; broadcast it before attempting web
   push. A push failure does not remove a durable row. A persistence failure
   emits neither WS nor push and is contained by the notifier's existing
   fire-and-forget error boundary.
5. Browser bootstrap/reconnect and live WS can race without duplicating a row.
   They merge by `NotificationRecord.id`, not by array position.
6. Read and clear state is server-owned and global to this local Polyth
   instance. No browser-only copy can become authoritative.
7. Old clients safely ignore the new top-level WS type. Existing event and
   projection subscription filtering and gap-fill behavior do not change.
8. Stored and transported `title`/`body` are bounded, control-stripped, and
   secret-redacted by the fixed server formatter before persistence. This is
   safety hardening, not configurable-template work.

## Shared contract

Add this normative type to `packages/contracts/src/index.ts`:

```ts
export type NotificationKind =
  | "completed"
  | "failed"
  | "question"
  | "permission"
  | "subagent";

export type NotificationRecord = {
  id: string;
  key: string;
  kind: NotificationKind;
  sessionId: string;
  projectId: string;
  title: string;
  body: string;
  ts: number;
  read: boolean;
};
```

Field semantics:

- `id` is a fresh server-generated UUID for one retained occurrence. It is the
  REST/WS merge identity and the mutation handle.
- `key` is the existing stable `diffNotifications()` key for the same
  transition. The server copies it into both the inbox record and push payload,
  and the OS/browser notification tag derives from it.
- `kind` reuses the current five notification kinds; the web-local `NotifyKind`
  becomes an alias/import rather than a divergent union.
- `sessionId` is the click target. For `subagent`, it is the parent session, as
  it is today.
- `projectId` is read from the canonical source projection. A subagent and its
  parent must resolve to the same project before publication.
- `title` and `body` are the fixed, sanitized output of `buildPushPayload()`.
  The browser does not re-template persisted records.
- `ts` is a server epoch-millisecond timestamp. The store makes it strictly
  increasing with `max(Date.now(), last.ts + 1)` so `after=<ts>` cannot skip two
  records created in the same millisecond.
- `read` starts `false` and changes only through the notification routes.

### Stable key compatibility

The server must produce the current key strings, using the source session for
subagent attribution:

| Kind | Key |
|---|---|
| completed | `${sourceSessionId}:turn:idle` |
| failed | `${sourceSessionId}:turn:failed` |
| subagent | `${childSessionId}:subagent:${"idle" \| "failed"}` |
| question | `${sourceSessionId}:question:${openQuestionCount}` |
| permission | `${sourceSessionId}:permission:${openPermissionCount}` |

Question/permission counts are derived from the already-appended durable
request state, not from a stale live projection. The notifier may receive the
count as trusted source metadata or query the existing attention projection; it
must not infer a transition by comparing snapshots.

`key` is deliberately **not** the inbox primary key. Existing keys are
replay-stable but can recur: a later completed turn can again produce
`session:turn:idle`, and a new request after resolution can reuse count `1`.
Collapsing the persistent store by `key` would lose valid notifications. A
single recording operation supplies the same key to push and inbox for
cross-delivery correlation/tag replacement; separate canonical callbacks get
separate `id` values and rows. The client also uses `id`, not `key`, to merge a
REST row with its live WS copy.

## Canonical recording pipeline

Keep `buildPushPayload()` pure. Extend its input/output enough to carry the
trusted `key` and `projectId` alongside the existing push fields, and apply the
same secret redaction currently used by the in-page formatter before returning.
Do not add configurable templates or read browser preferences on the server.

At the composition root, replace:

```ts
send: (payload) => push.send(payload)
```

with one operation, named here `recordAndPush(payload)`:

1. Validate non-empty `key`, `sessionId`, and `projectId`; verify the target
   session, when present, belongs to `projectId`.
2. Construct one `NotificationRecord` with a UUID, monotonic server `ts`, and
   `read:false`.
3. Persist it through the notification store.
4. Call the unfiltered broadcaster method with exactly that persisted record.
5. Call `push.send(payload)` with the same `key`, target session, title, and
   body.

`createPushNotifier()` continues to suppress aborts and attribute subagents to
their parent. It now supplies the source key and project metadata before
calling `deps.send` once. It must not rediscover a transition after the send
sink. Auto-accept remains suppressed because those permission paths still do
not invoke the notifier.

The composition-root broadcast box and `Broadcaster` interface gain
`notification(record: NotificationRecord): void`. This is plumbing only; inbox
records do not enter `appendAndBroadcast()` or any session reducer.

## Storage contract

Implement the server-owned store in `packages/server/src/notifications.ts` and
wire it to `${dataDir}/notifications.json`. The exact version-1 shape is:

```json
{
  "version": 1,
  "items": [
    {
      "id": "5c4d37c5-ea5e-4418-a1bc-21357b991e8f",
      "key": "session-a:turn:idle",
      "kind": "completed",
      "sessionId": "session-a",
      "projectId": "project-a",
      "title": "Polyth — Build docs",
      "body": "Build docs — finished",
      "ts": 1787462640000,
      "read": false
    }
  ]
}
```

Store behavior:

- retain records oldest-to-newest on disk;
- after every append, keep the newest 200 and evict older rows FIFO regardless
  of read state;
- list results oldest-to-newest so REST bootstrap and WS append use one merge
  direction; the panel reverses for newest-first display;
- load only `version:1`; validate every field and kind, discard malformed rows,
  duplicate IDs, and rows after the newest 200;
- a missing, malformed, or unsupported-version file fails closed to an empty
  in-memory store and logs one bounded warning without exposing file content;
- serialize mutations through one in-process promise chain so append/read/clear
  cannot overwrite each other;
- write a complete pretty-printed versioned snapshot to a sibling temporary
  file and rename it over the target; create the parent directory first;
- do not write an unchanged read operation;
- expose only normalized DTOs, never the file object or path.

The service surface is:

```ts
interface NotificationStore {
  list(after?: number): { items: NotificationRecord[]; unread: number };
  add(input: Omit<NotificationRecord, "id" | "ts" | "read">): Promise<NotificationRecord>;
  read(ids: string[]): Promise<{ updated: number; unread: number }>;
  readAll(): Promise<{ updated: number; unread: number }>;
  clear(): Promise<{ cleared: number; unread: number }>;
}
```

Implementations may return promises from every method for a uniform serialized
surface. The observable response shapes and ordering remain as specified.

## HTTP routes

Add `packages/server/src/routes/notifications.ts` as a `RouteHandler` and
register it in the composition-root route array. Do not edit
`packages/server/src/http.ts`.

| Request | Success response | Semantics |
|---|---|---|
| `GET /api/notifications` | `200 { items, unread }` | All retained rows, oldest first; `unread` covers the full retained inbox. |
| `GET /api/notifications?after=<ts>` | `200 { items, unread }` | Only rows with `item.ts > ts`; `unread` still covers the full retained inbox. |
| `POST /api/notifications/read` with `{ "ids": ["..."] }` | `200 { updated, unread }` | Mark matching unread rows read. Duplicate/already-read/unknown IDs are no-ops. |
| `POST /api/notifications/read-all` with `{}` or no body | `200 { updated, unread: 0 }` | Mark every retained row read. Repeating is a no-op. |
| `POST /api/notifications/clear` with `{}` or no body | `200 { cleared, unread: 0 }` | Delete all retained rows. Repeating is a no-op. |

Validation and ownership:

- all routes inherit the existing centralized `/api` auth gate;
- the writer takes `sessionId`/`projectId` only from trusted projections, never
  from an HTTP request;
- mutation bodies contain opaque notification IDs only. A caller cannot supply
  a project/session scope or mutate any object outside the authenticated
  instance's store;
- `ids` must be an array of at most 200 unique-or-duplicated non-empty strings,
  each at most 128 characters. An empty array is a valid idempotent no-op;
- `after` must be a finite, non-negative integer. Missing means `0`;
- invalid `ids` or `after` throws `{ code:"invalid-input", field:"ids" }` or
  `{ code:"invalid-input", field:"after" }`, which the existing HTTP boundary
  maps to a typed `400`;
- persistence errors remain typed `500 internal` at the common boundary, with
  no file path or record body in the response.

Polyth currently has one authenticated local account rather than per-user
project ACLs. Multi-user ownership is explicitly not invented here. Deleted
sessions do not erase their records: the DTO remains readable, but the client
must disable navigation when no matching session with the same `projectId`
exists.

## WebSocket contract

Extend the existing `/ws` broadcaster with exactly one new server-to-client
envelope:

```ts
{ type: "notification/added"; notification: NotificationRecord }
```

Requirements:

- broadcast once, after the JSON store commit and before web-push delivery;
- fan out to every authenticated connected `/ws` client without applying the
  active-session filter;
- do not add this record to `Sub.liveBuffer`, change `afterSeq`, or involve
  session gap-fill;
- add the variant to web `SyncInbound` and validate all required record fields
  in `isSyncInbound()`;
- old clients continue to discard the unknown top-level type in their existing
  parser; no error envelope or disconnect is sent.

There is no new WS acknowledgement/cursor protocol. REST supplies gap-fill:
after initial boot and every WS reconnect, fetch
`GET /api/notifications?after=<largest local ts>`, then merge by `id`. Strictly
monotonic timestamps make this cursor lossless within the retained FIFO window.

## Web client state

Create `apps/web/src/notificationCentre.ts` as a DOM-free, testable external
store/slice. Its public state is:

```ts
type NotificationCentreState = {
  items: NotificationRecord[];
  unread: number;
  loading: boolean;
  error: string | null;
};
```

The slice owns these operations:

- `bootstrap()` fetches the initial list, merges by `id`, caps to 200
  oldest-to-newest, and applies the server's global `unread`;
- `catchUp()` performs the same merge with `after=max(ts)` on every WS open or
  reconnect;
- `append(record)` handles `notification/added`; duplicate `id` is a no-op,
  otherwise append, cap to 200, and increment unread only when `read:false`;
- `markRead(ids)` optimistically flips matching rows and decrements unread,
  POSTs once, then adopts the returned unread count. On failure it restores only
  rows still at the optimistic version and exposes a bounded retryable error;
- `markAllRead()` and `clear()` use the same optimistic/rollback discipline;
- subscribers receive one notification per logical mutation, not one per row.

`startSync()` routes the new inbound variant directly to `append()`. Extend the
sync client with an open/reopen signal or equivalent callback so catch-up runs
after each successful connection; do not poll. The bootstrap/WS race is safe
because both paths merge the exact persisted `id`.

Add typed methods to `apps/web/src/api.ts` for the four REST routes. No
notification-centre data belongs in the main session `store.ts`, URL state,
localStorage, or `deriveMessages()`.

## Header, panel, and settings

### Bell

Register the bell through `app.header.actions`; do not hardcode it in
`App.tsx`. The slot item renders inside the existing `Header` action host:

- accessible name is `Notifications, <n> unread` (or `Notifications, none
  unread`);
- the badge is absent at zero and displays `99+` above 99 while retaining the
  exact count in the accessible name;
- activating sets the rail surface to `slot:notification-centre`; activating it
  while already open closes it, matching existing rail-toggle behavior;
- it remains available when no session is active because the inbox is global.

### Rail surface

Register the panel through `workspace.right.tabs` with ID
`notification-centre`, title `Notifications`, and deterministic order. Do not
edit `App.tsx` or enumerate it in `ContextRail.tsx`.

The panel:

- displays newest first, with kind, sanitized title/body, unread treatment, and
  a semantic `<time dateTime=...>`; kind is not communicated by color alone;
- has loading, empty, offline/error-with-retry, and `No unread notifications`
  states;
- provides `Mark all read` and a confirmed `Clear notifications` action;
- treats archived sessions as live/openable;
- enables a row only when the current session registry contains
  `sessionId` with the same `projectId`;
- on enabled-row activation, optimistically marks that record read and calls
  existing `openSession(sessionId)`; pointer and Enter/Space use one handler;
- renders a missing/mismatched session as a disabled row with the visible
  reason `Session no longer available`. It does not call `openSession()` or
  silently remove the history row;
- keeps controls keyboard reachable, gives every button a visible focus state,
  and uses at least `44×44px` row/action targets in compact rail-sheet mode.

Use a focused component module such as
`apps/web/src/components/NotificationCentre.tsx` for both slot registrations.
The state/merge logic stays in `notificationCentre.ts`.

### Centre history toggle

Add `notificationCentreHistory:boolean` to versioned `UiSettings`, defaulting
to `true`, and a Settings → Notifications row labelled `Centre history` with
the hint `Keep read notifications visible in the notification centre.`

This is a per-browser display preference:

- on: the panel shows unread and read retained rows;
- off: the panel shows unread rows only;
- it never disables server recording, changes read state, or clears data;
- turning it back on reveals retained read rows;
- `Clear notifications` is the explicit destructive action.

Add this item to settings search. Do not couple it to desktop notification,
sound, kind, hidden-tab, or push-subscription preferences. The centre records
all five canonical server kinds; those existing preferences continue to
control only their current native/sound delivery surfaces.

## Minimal implementation map

| File | Responsibility |
|---|---|
| `packages/contracts/src/index.ts` | `NotificationKind` and exact `NotificationRecord` DTO. |
| `packages/server/src/notifications.ts` (new) | Versioned JSON load/validation, serialized atomic mutations, monotonic timestamps, and 200-row FIFO. |
| `packages/server/src/push.ts` | Canonical key/project metadata, fixed redaction, and one send-sink call per transition. |
| `packages/server/src/sessions.ts` | Supply durable attention metadata as needed; extend broadcaster type only. No inbox event append. |
| `packages/server/src/ws.ts` | Unfiltered `notification/added` fan-out. |
| `packages/server/src/routes/notifications.ts` (new) | Typed list/read/read-all/clear `RouteHandler`. |
| `packages/server/src/index.ts` | Construct store, register route, extend deferred broadcaster, and wire persist → WS → push. |
| `apps/web/src/api.ts` | Typed notification REST methods. |
| `apps/web/src/sync.ts`, `apps/web/src/init.ts` | Validate/ingest `notification/added` and REST catch-up on reconnect. |
| `apps/web/src/notificationCentre.ts` (new) | Bootstrap/live merge and optimistic mutation slice. |
| `apps/web/src/components/NotificationCentre.tsx` (new) | Bell and panel; register `app.header.actions` and `workspace.right.tabs`. |
| `apps/web/src/uiPrefs.ts`, settings page/registry | `Centre history` display preference and searchable row. |
| `apps/web/src/styles.css` | Badge, rows, unread/focus/disabled states, and compact target sizing. |
| `docs/parity/polyth-parity.yaml` | Extend only OC-20-001/002/003 notes/tests; retain OC-20-004 as planned. |

No new package is required. Do not edit `packages/server/src/http.ts` or
`apps/web/src/App.tsx`.

## Acceptance gates

### Store and route tests

1. First boot, malformed JSON, unsupported version, invalid records, duplicate
   IDs, and restart all yield the specified normalized version-1 state without
   leaking raw file content.
2. Add 201 records with a fixed clock: timestamps remain strictly increasing,
   the first record is evicted, and disk/reload retain exactly the newest 200 in
   oldest-first order.
3. Two records with the same stable `key` retain different `id` values and both
   remain in history.
4. Read is idempotent for duplicate, unknown, and already-read IDs. Read-all and
   clear are idempotent. Concurrent add/read/clear writes do not resurrect an
   older snapshot.
5. `after=x` returns only `ts > x` while `unread` counts the entire retained
   inbox. Invalid cursors and malformed/oversized `ids` return typed
   `invalid-input` responses.
6. Route tests prove the central auth gate applies and that request bodies
   cannot select a project or session.

### Recording and WS tests

7. Completed, failed, question, permission, and subagent transitions produce
   the exact contract fields and stable keys. Subagents target the parent and
   keep the shared project.
8. Aborted turns, auto-accepted permissions, and `/api/push/test` produce zero
   inbox rows and zero `notification/added` envelopes.
9. Instrumented order is session event append → inbox file commit → one
   unfiltered WS envelope → push attempt. A push failure keeps the row; a store
   failure invokes neither later step.
10. A socket subscribed to another active session still receives the
    notification. Existing event filtering/gap-fill tests remain unchanged.
11. Server formatting redacts secret-shaped title/body text and preserves the
    existing caps. No configurable-template path is introduced.

### Client and interaction tests

12. A delayed initial GET racing an identical WS record yields one row and the
    correct unread count. Disconnect/reconnect catch-up adds missed rows once.
13. Optimistic read/read-all/clear adopt server counts on success and restore
    only their own changes on rejection.
14. The bell is contributed through `app.header.actions`, the panel through
    `workspace.right.tabs`, and existing slot/surface tests prove no host
    enumeration was added.
15. Bell count/name, newest-first order, semantic times, unread treatment,
    history preference, retry, read-all, clear confirmation, and empty states
    work at wide and compact layouts.
16. A live row opens the existing session and becomes read. A deleted or
    project-mismatched session remains visible, disabled, and cannot navigate.
17. Keyboard and pointer activation match; compact controls meet `44×44px`; no
    focused element is covered by the header or rail sheet.

Run at minimum:

```sh
node --test packages/server/test/notifications.test.ts
node --test packages/server/test/push.test.ts
node --test packages/server/test/wsNotifications.test.ts
node --test apps/web/test/notificationCentre.test.ts
node --test apps/web/test/notifications.test.ts
node --test apps/web/test/surfaces.test.ts
(cd packages/contracts && npx tsc --noEmit)
(cd packages/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
npm run build
```

Fable must also perform one live wide/compact walkthrough covering bell →
panel, mark-read, open-session, disabled dead-session, read-all, clear, and the
history toggle, and retain the artifact for the SOL verifier.

## Parity updates after implementation

Keep all four statuses honest:

- `OC-20-001` remains `implemented`; extend tests/notes with the five canonical
  kinds recorded in the persistent centre, stable key compatibility,
  dead-session handling, and bell/session navigation.
- `OC-20-002` remains `implemented`; extend tests/notes with the server-owned
  JSON inbox, REST bootstrap/catch-up, and unfiltered live WS envelope in
  addition to native/web push.
- `OC-20-003` remains `implemented`; extend tests/notes to state that
  auto-accepted requests create neither push nor inbox records.
- `OC-20-004` remains `planned`; add a note that NTF-01 stores the fixed,
  bounded, redacted server payload and does **not** make centre/push templates
  configurable. Existing client-side native template behavior is not evidence
  that this row is complete.

Do not claim complete polyth/Paseo notification parity.

## Fable commit plan

Implement and push in these reviewable commits, with focused tests in each
commit before moving to the next:

1. `feat(NTF-01): add notification contract and persistent store`
2. `feat(NTF-01): add notification routes and live broadcast`
3. `feat(NTF-01): add notification centre client and surfaces`
4. `docs(NTF-01): update notification parity notes`

The first commit owns DTO/store retention and serialization. The second owns
canonical recording order, routes, WS, and server tests. The third owns the
slice, reconnect merge, bell/panel/settings UI, client tests, and live
walkthrough. The fourth updates only parity evidence after all gates pass.

## Explicit non-goals

- No per-device read state or per-user/multi-user inbox partitioning.
- No snooze, per-kind centre filters, centre-triggered sound, or notification
  scheduling.
- No OC-20-004 configurable server templates.
- No Discord, Telegram, Slack, email, or other forwarding.
- No notification records in the session event log, model history, transcript,
  export, or replay reducer.
- No second projection watcher, server execution of `diffNotifications()`, or
  client-created persistent rows.
- No read/clear WS synchronization protocol beyond REST bootstrap/catch-up.
- No durable history beyond the newest 200 rows and no migration to SQLite.
- No change to service-worker click routing beyond carrying the same canonical
  key/tag and existing target session.

## Exact next task

`Fable-NTF-01-implementer`: implement only the contracts, persistence,
recording, routes, WS, client surfaces, tests, and parity-note changes in this
specification, then return passing automated output and the live walkthrough
artifact to the SOL verifier.
