# Polyth push service

The stateless forwarder every Polyth server sends native push through
(`https://push.polyth.app` by default, `POLYTH_NATIVE_PUSH_RELAY_ORIGIN` on the
server). APNs and FCM deliver only for keys of the team that publishes the app,
so the publisher runs this one service; users set up nothing. The phone never
talks to it: it registers its token with its own server over Polyth Link
([notifications](../../docs/mobile/platform-behavior.md#notifications)).

It has no database and no accounts. It knows no users, Spaces, sessions,
projects or text: a request carries a device token and either an alert or a
Live Activity update, it signs with the app's APNs key or Firebase account,
answers the provider's classification and forgets.

## API

`POST /v1/send`, `application/json`, at most 8 KiB, every field exact:

```json
{ "to": { "platform": "ios", "environment": "production", "token": "<hex>" },
  "alert": { "version": 1, "subscriptionId": "sub_…", "notificationId": "<uuid>",
             "kind": "completed", "tag": "<opaque>", "sealed": "<base64url, optional>" } }
```

or `"activity": { "event": "update"|"end", "state", "waiting", "working",
"staleAt", "urgent", "startedAt"?, "dismissAt"? }` (iOS only; times in Unix
seconds within a day of now, counts 0–99). Android is `{"platform":
"android", "token": "<fcm>"}` with an alert. The answer is `200
{"result": "success"|"permanent"|"auth"|"rate"|"transient"|"config"|"invalid"}`;
`permanent` means the token is dead and the server drops it. A malformed
request is 400, a limit 429, overload 503. `GET /v1/health` is `{"ok": true}`.

- Alerts show generic text ("Polyth / A task completed"); `sealed` is the real
  text encrypted by the host for that one device, never decoded here
  ([native push content](../../docs/mobile/native-push-content.md)). APNs gets
  `mutable-content` and FCM a data-only message only with `sealed`; a provider
  payload over 4096 bytes goes without it.
- A Live Activity push carries a state, counts and times, never words
  (`apns-push-type: liveactivity`, priority 10 when `urgent`, otherwise 5;
  `startedAt` in seconds since 2001 as ActivityKit decodes a `Date`).

## Abuse limits

Per minute: 60 sends per device token and 1200 per sender address; at most 64
provider calls in flight; 50 000 rate windows in memory. Only a server the
phone registered with knows its token. Requests and outbound calls time out at
5–10 seconds; APNs reuses one HTTP/2 session per environment with one
reconnect after GOAWAY. The log line is `{provider, status, code, latencyMs}`:
no token, payload or address.

## Running it

Node 22.16+, no dependencies. Keys live in `PUSH_RELAY_KEYS_DIR` (default
`/keys`):

- `apns.json` `{"teamId", "keyId", "topic"?}` and `apns.p8`, re-read when they
  change (the same files a server reads for its [own key](../../docs/mobile/platform-behavior.md#own-apns-key));
- `fcm.json`: the Firebase service-account JSON (its `project_id` names the
  project), read at start.

It refuses a non-loopback listener unless `PUSH_RELAY_TLS_TERMINATED=1` (a
reverse proxy terminates TLS). `PUSH_RELAY_TRUSTED_PROXY` is the proxy's
address as the listener sees it; only its `X-Forwarded-For` (last entry) names
the sender for the per-address limit. `PUSH_RELAY_HOST`/`PUSH_RELAY_PORT`
default to `127.0.0.1:8787`.

The deployment is a locked-down container behind the host's TLS proxy:

```sh
docker run -d --name polyth-push --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
  --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 \
  --log-opt max-size=5m --log-opt max-file=2 \
  -p 127.0.0.1:8787:8787 \
  -e PUSH_RELAY_HOST=0.0.0.0 -e PUSH_RELAY_TLS_TERMINATED=1 -e PUSH_RELAY_TRUSTED_PROXY=<bridge gateway> \
  -v /opt/polyth-push/app:/app:ro -v /opt/polyth-push/keys:/keys:ro \
  node:22-alpine node --experimental-strip-types /app/src/cli.ts
```

`/opt/polyth-push/app` holds this package's `src/`; the keys directory is
readable by uid 65534 only.
