# Polyth Link protocol v1

- Ticket: `polyth://pair?v=1&t=<base64url-json>`
- ALPN: `polyth-link/1`
- Invite secret: 256 random bits
- Pairing id: ≥128 random bits
- Invitation TTL: 120 seconds, memory-only, host-authoritative

## Ticket payload

`PolythPairingTicketV1` in `@polyth/contracts`. Candidate `endpointId` values
must equal `host.endpointId`. Relay URLs must be `https` without credentials
or fragments.

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
| 0 | Control |
| 1 | One HTTP request |
| 2 | One WebSocket |

HTTP/WS heads are `u32 BE length || CBOR`. No 0-RTT application data.
Mutations are not retried after an ambiguous disconnect
(`transport-outcome-unknown`). GET/HEAD/OPTIONS may bounded-retry only when
the stream was not admitted.

## Identities

Host secret: `<dataDir>/tunnel/identity` (mode 0600, fail closed).
Mobile: one device keypair per host, native secure storage only.
Persistent bearer tokens are not used.
