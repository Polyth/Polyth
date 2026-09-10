# Polyth Push Relay

This is a separately deployable Node 22.14+ service for APNs and FCM device
destinations. It deliberately does not know Polyth users, Spaces, sessions,
projects, notification contents, or actions. The caller supplies only a
precomputed binding digest and fixed notification metadata.

Run it behind a TLS-terminating proxy; the relay refuses a public HTTP listener
unless `PUSH_RELAY_TLS_TERMINATED=1` is explicitly set. `PUSH_RELAY_TEST_MODE=1`
is limited to `127.0.0.1`, `::1`, or `localhost`.

Required environment:

```text
PUSH_RELAY_DB=/var/lib/polyth-push/relay.sqlite
PUSH_RELAY_MASTER_KEY=<32 random bytes, base64url without padding>
PUSH_RELAY_TLS_TERMINATED=1
```

Optional APNs configuration is `PUSH_RELAY_APNS_TEAM_ID`,
`PUSH_RELAY_APNS_KEY_ID`, `PUSH_RELAY_APNS_P8`, and
`PUSH_RELAY_APNS_TOPIC`. Optional FCM configuration is
`PUSH_RELAY_FCM_PROJECT` and `PUSH_RELAY_FCM_SERVICE_ACCOUNT_JSON`. A hosting
environment using workload identity supplies an `AccessTokenProvider` when
constructing `FcmProvider`; no ambient credential file is read.

SQLite contains AES-256-GCM ciphertext/nonce/tag for each provider token and
SHA-256 capability hashes only. Every registration, claim, sender cap, and
provider result is scoped to an opaque subscription ID. Wrong, expired, and
replayed claims return the same authorization response. A permanent provider
result retires only the destination version that was sent, so a concurrent
token rotation cannot be retired by an old result.

The process makes no retry loop. APNs reuses fixed-origin HTTP/2 sessions and
performs exactly one reconnect after GOAWAY; FCM uses its HTTP v1 endpoint.
Request and outbound timeouts are five seconds. In-memory one-minute limits are
20 registrations per IP, 30 claims independently per IP and claim hash, and
120 deliveries independently per subscription and sender by default. They are
intentionally per-process; deploy a single relay authority or impose equivalent
limits at the trusted edge.

The logger receives only `{subscriptionId, provider, status, code, latencyMs}`.
It receives no provider response body, capability, binding, or provider token.
AES-GCM also authenticates each token's
subscription/version/platform/environment context, so ciphertext copied
between rows fails closed.
