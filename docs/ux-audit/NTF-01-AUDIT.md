# NTF-01 — Notification centre SOL audit

**Scope:** Phase 1 audit only; no feature implementation.
**Audited:** `packages/server/src/push.ts` in full, the web notification detector and WS ingestion path, the auto-accept store/route/service path, and parity rows OC-20-001 through OC-20-004.

## Verdict

Polyth already has a canonical server-side transition detector. `createSessionService()` receives runtime outcomes, durably appends their session events, updates the projection, and only then calls the `notify` seam. `createPushNotifier()` converts that seam into a `PushPayload`.

The notification centre must record at that existing server seam. It must **not** add another watcher over session snapshots: that would be a second transition detector and would inherit the same ambiguity already present in the browser detector.

The exact pure conversion function is `buildPushPayload()` in `packages/server/src/push.ts:119-134`. The transition-only convergence point suitable for a durable side effect is the injected `deps.send(payload)` callback used by `createPushNotifier()` at lines 291, 301, and 308 and currently wired in `packages/server/src/index.ts:406-409`.

## A. Canonical recording point

### Current flow

1. `createSessionService()` handles a runtime event in `onRuntimeEvent()` (`packages/server/src/sessions.ts:226`).
2. It appends and broadcasts the truthful source event before notifying:
   - `turn/stopped` is appended, the projection becomes `idle`/`failed`, then `deps.notify.turnStopped(...)` runs (`sessions.ts:236-244`).
   - a permission or question is appended, its projection becomes `waiting` when human action is actually needed, then `deps.notify.attention(...)` runs (`sessions.ts:249-299`).
   - auto-accepted permissions append `permission/requested` and `permission/resolved { auto: true }` without reaching `notify` (`sessions.ts:262-277`).
3. `createPushNotifier()` resolves the latest projection, classifies parent/subagent routing, calls `buildPushPayload()`, and passes the result to `deps.send`.
4. The composition root currently supplies `send: (payload) => push.send(payload)`.

### Phase 2 recording seam

Replace that composition-root callback with one named operation such as `recordAndPush(payload)`:

1. create a unique inbox record and persist it;
2. broadcast `notification/added`;
3. invoke `push.send(payload)`.

Persistence must happen before either UI broadcast or web-push delivery. The inbox record needs its own unique ID and server timestamp; `PushPayload.tag` is deliberately non-unique across repeated `(sessionId, kind)` notifications because native notifications replace by tag.

Do not put inbox persistence in either of these broader functions:

- `buildPushPayload()` is a pure formatter and has no persistence dependencies;
- `PushService.send()` is also used by `POST /api/push/test` (`packages/server/src/routes/push.ts:29-35`), so recording there would create a synthetic inbox entry with an empty session ID.

There is therefore a single usable recording point: **the transition-only `deps.send` sink of `createPushNotifier()`**, immediately after `buildPushPayload()`. No server snapshot watcher is needed.

One data caveat should be resolved in the record DTO: a subagent payload changes `sessionId` to the parent and discards the child ID. If the centre needs “which delegated session finished,” `createPushNotifier()` must pass source-session metadata to the recording sink; it must not rediscover the transition later.

## B. Client/server divergence

Yes. `apps/web/src/notify.ts` and server push can diverge because they do not consume the same signal:

- The server consumes explicit runtime outcomes (`completed`, `aborted`, `error`) and attention callbacks.
- The browser's `diffNotifications()` infers transitions from consecutive `SessionProjection` snapshots.

Observed edge cases:

1. **Abort mismatch.** Server push explicitly suppresses `reason === "aborted"` (`push.ts:294-296`). The server still changes the projection from `working` to `idle`; `diffNotifications()` classifies every `working -> idle` transition as `completed`. A foreground/native completion can therefore fire for an aborted turn.
2. **Waiting mismatch.** The client `DONE` set includes `waiting` (`notifications.ts:28`), so `working -> waiting` can emit a false `completed` notification at the same point the server correctly emits only `question` or `permission`.
3. **Live attention counts are not authoritative in the browser detector.** Attention is enriched when `SessionService.list()` reads durable events (`sessions.ts:1255-1263`). Live projection broadcasts carry the raw projection, and `store.upsertSession()` replaces the prior object. Consequently the count-increase detector can miss a live question/permission while the server notifier fires.
4. **Count-based dedupe can suppress distinct requests.** Client keys use the current count, such as `session:question:1`. After one request resolves from one to zero, a later distinct request returning to one reuses the same key and `notify.ts`'s `emitted` set suppresses it. The server seam fires once per actual request.
5. **Replay/first-sight behavior differs.** The client deliberately primes unseen snapshots silently. The server reacts at event handling time and does not rely on a previous browser snapshot.
6. **Formatting and privacy differ.** Client rendering supports allowlisted variables, project names, configurable templates, and secret redaction. Server payloads use a fixed template, do not use the declared `projectName` option, and only strip control characters. A secret-looking session title is redacted client-side but not server-side.
7. **Settings differ.** Client notification kinds, foreground/hidden suppression, and `notifyOnComplete` are local UI preferences. Server push generation does not consult them; visibility suppression happens later in service-worker delivery.

The notification centre should therefore persist the server-generated canonical payload. It should not persist the output of `diffNotifications()` and should not run that function on the server. Longer term, native in-page notifications can consume canonical `notification/added` records to eliminate dual detection, but that is outside this audit.

## C. Existing WS ingestion

`apps/web/src/init.ts:startSync()` creates one `SyncClient`, then handles messages at `init.ts:253-260`:

- `{ type: "event", event }` messages are micro-batched and passed to `store.applyEvents()`;
- `{ type: "projection", session }` messages immediately call `store.upsertSession()`.

`SyncClient` currently validates only `event`, `projection`, and `error` envelopes (`apps/web/src/sync.ts:7-10,31-42`). For an ordinary session event, `init.ts` does not switch on the inner `event.type`, so an inner `SessionEvent` named `notification/added` would pass through the existing event batch unchanged.

That shortcut is insufficient for a global inbox:

- `Broadcaster.event()` sends a live event only to sockets with no session subscription or a matching active `sessionId` (`packages/server/src/ws.ts:242-255`). A notification from another session would not reach a client currently subscribed to the active session.
- `store.applyEvents()` only stores the event under `state.events[sessionId]`; it does not update inbox state.
- placing UI inbox records in every source session's canonical event log is unnecessary if the inbox has its own persistent store.

The clean integration is to reuse the existing `/ws` connection but add a top-level inbound variant:

```text
{ type: "notification/added", notification: <NotificationDto> }
```

Phase 2 must extend `SyncInbound` and `isSyncInbound()`, add an unfiltered notification fan-out method to the server broadcaster, and add a `notification/added` branch in `startSync()` that inserts the DTO into the web inbox store. The notification list still needs a REST/bootstrap read from the durable inbox store after boot/reconnect; unlike session events, a direct notification WS envelope has no current gap-fill protocol.

If Phase 2 instead chooses an inner `SessionEvent`, `init.ts` already transports it, but WS fan-out must explicitly bypass the active-session filter and the client must project it into inbox state before the generic session reducer safely ignores the unknown type.

## D. Auto-accept JSON-store mechanics

There is no checked-in `/workspace/data/auto-accept.json` in this checkout; it is runtime-generated at `${dataDir}/auto-accept.json` by `createAutoAcceptStore()` (`packages/permissions/src/index.ts:107-132`). Its on-disk shape is a JSON object keyed by session ID:

```json
{
  "parent-session-id": "on",
  "child-session-id": "off"
}
```

Store behavior:

- startup synchronously reads and parses the whole file;
- only values exactly equal to `"on"` or `"off"` enter the in-memory `Map`;
- missing/malformed files fail closed to an empty map;
- `get()` returns `"inherit"` when no explicit entry exists;
- setting `"inherit"` deletes the key rather than persisting `"inherit"`;
- changed state creates the parent directory and synchronously rewrites the full pretty-printed JSON object;
- idempotent writes return without touching disk.

The composition root injects this store into `createSessionService()` at `packages/server/src/index.ts:415-418`. Effective policy is resolved through the nearest explicit ancestor, with cycle/depth guards and a root default of off. `autoAcceptSet()` recomputes all projections, broadcasts changed effective flags, and auto-resolves eligible already-pending runtime permissions. Explicit permission rules run first, so deny still wins; composer-shell confirmations are excluded.

`packages/server/src/routes/autoAccept.ts` is a thin feature route:

- `GET /api/sessions/:id/permissions/auto-accept` delegates to `sessions.autoAcceptGet()` and returns `{ setting, effective }`;
- `PATCH` accepts only `on`, `off`, or `inherit`, then delegates to `sessions.autoAcceptSet()`;
- missing service methods return `unsupported`; the service itself verifies that the session exists.

This is a useful pattern for a small local server-owned JSON store: load/validate into memory, expose DTOs rather than file contents, mutate through a feature route, and persist only normalized values. An inbox will write more frequently and needs unique IDs, ordering, read state, retention, and bootstrap listing, so it should copy the ownership/validation pattern rather than blindly copy the `Record<string, "on" | "off">` schema.

## Parity context

- OC-20-001 (finish/error/question/permission notify): `implemented`.
- OC-20-002 (native + web push background): `implemented`.
- OC-20-003 (auto-accept suppression): `implemented`.
- OC-20-004 (configurable templates): `planned`.

The client already contains template machinery, but the server push path remains fixed and has no equivalent redaction. This audit does not treat OC-20-004, a persistent inbox, or complete notification-centre parity as shipped.
