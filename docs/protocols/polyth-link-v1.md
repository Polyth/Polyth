# Polyth Link protocol v1

- Ticket: `polyth://pair?v=1&t=<base64url-json>`
- ALPN: `polyth-link/1`
- Invite secret: 256 random bits
- Pairing id: ≥128 random bits
- Invitation TTL: 120 seconds, memory-only, host-authoritative
- One-time invitation TTL: 7 days (`Limits::v1().invitation_ttl_ms`),
  wall-clock expiry, host-authoritative

## Ticket payload

`PolythPairingTicketV1` in `@polyth/contracts`. Candidate `endpointId` values
must equal `host.endpointId`. Relay URLs must be `https` without credentials
or fragments.

A ticket carries `invitation: bool` (JSON `"invitation"`, omitted when false),
so live tickets stay byte-identical. `validate_ticket_time` accepts an
invitation ticket for the invitation TTL and a live ticket for the pairing TTL,
so older clients reject invitation tickets on the lifetime check and need the
current build.

## Share link

`SHARE_LINK_PREFIX` is `https://polyth.app/join#`; `share_link()` turns
`polyth://pair?v=1&t=<t>` into `https://polyth.app/join#v=1&t=<t>`.
`parse_pairing_ticket` accepts that form and the `https://polyth.app/join/#…`
spelling and nothing else: no other host, scheme, query or port.

## One-time invitations

A host holds at most 64 pending invitations (`active_long_invitations`); live
codes stay capped at 3. Invitation expiry is wall-clock (`expires_at_ms`),
while live codes expire by a monotonic deadline. A verified proof of an
invitation sets `host_confirmed`, so no `pairing.approve` is needed and the
device's confirmation commits it. When the device's pairing connection ends
before it commits, `release_claim` returns the invitation to `created` and
keeps its proof-attempt count.

`pairing.create` takes `invitation: true` and `ttlMs` (clamped 60 s … 7 days)
and answers with `invitation: true`, `shareUrl` and `numericCode: null`.
`pairing.restore {invitations: [{ticket, grants, label}]}` re-admits up to 64
invitations after a host restart, after full revalidation and a host-identity
check, and answers `{restored, rejected: [{index, code}]}`. `pairing.get` and
the `tunnel/pairing-committing` event carry `invitation`.

## Pairing transcript

```
transcript = SHA-256(
  "polyth-link-transcript-v1" || version || pairingId ||
  hostEndpointId || deviceEndpointId || clientNonce || serverNonce || profile
)
proof = HMAC-SHA-256(inviteSecret, transcript)
safety = SHA-256("polyth-link-safety-v1" || transcript || proof)
```

Four words come from the embedded `polyth-link-words-v1` 2048-word list.

States (host): created → claimed → proof-verified → waiting-*-confirmation →
committing → committed. Terminal: expired, cancelled, rejected, failed.

Both device and host confirmations are required. The first valid proof binds
the invitation to one device EndpointId.

## Streams

QUIC streams, not a custom mux over one TCP socket:

| Kind byte | Use |
| --- | --- |
| 1 | Control |
| 2 | One HTTP request |
| 3 | One WebSocket |

HTTP/WS heads are `u32 BE length || CBOR`. No 0-RTT application data.
Mutations are not retried after an ambiguous disconnect
(`transport-outcome-unknown`). GET/HEAD/OPTIONS may bounded-retry only when
the stream was not admitted.

## Identities

Host secret: `<dataDir>/tunnel/identity` (mode 0600, fail closed).
Persistent bearer tokens are not used.
- Mobile: production Android/iOS adapters use the shared Link client through
  the native ABI. Device identity remains native: iOS uses Keychain and Android
  uses Keystore-backed encrypted storage. Pairing confirmation, reconnect, and
  loopback proxy lifecycle stay in the native/shared-client boundary; JavaScript
  receives only bounded connection metadata and bootstrap URLs.
