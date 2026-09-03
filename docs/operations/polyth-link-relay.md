# Polyth Link relay operations

Polyth Link v1 uses upstream `iroh-relay = 1.1.0`. Do not run a custom
WebSocket application relay.

## What the relay sees

Endpoint identifiers, timing, packet sizes, and connection duration. It
cannot read pairing secrets, HTTP bodies, grants, or session text.

## Deployment

- DNS A/AAAA for the relay hostname
- TLS certificate for that name
- Listen on 443 (or 8443 behind a TCP passthrough)
- Reverse proxies must not terminate QUIC/HTTP upgrade in a way that
  rewrites the Iroh handshake. TCP passthrough is required.
- Health: process liveness plus TLS accept. No application token check.
- systemd: run `iroh-relay` 1.1.0 with a config that binds 443
- Backup: none for application secrets. Relay has no Polyth keys.
- Upgrade: pin client, host, and relay to the same supported Iroh version.
  There is no silent fallback to an older relay protocol.

## Managed mode

Hosts set `relay-only`. Direct addresses are not placed on the QR.
Authorization still happens on the Polyth host.
