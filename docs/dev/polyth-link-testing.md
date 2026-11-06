# Polyth Link testing

## Commands

```
cargo test -p polyth-link-core --tests
cargo test -p polyth-link-host --tests
node --experimental-strip-types --test packages/server/test/authIngress.test.ts packages/server/test/httpTunnel.test.ts packages/server/test/remotePolicyCoverage.test.ts packages/tunnel/test/*.test.ts packages/pairing-qr/test/*.test.ts apps/mobile/test/runtime.test.ts
```

The desktop app's client adds `apps/desktop/test/{polythLinkClient,servers,windowSurface,hubProtocol,sessionCookieGuard}.test.ts`,
`apps/web/test/desktopServerList.test.ts` and `cargo test -p polyth-link-client --test stdio`.

To run it for real, build the debug binaries and start Electron from `apps/desktop` with
isolated `HOME`, `POLYTH_DESKTOP_USER_DATA` and `POLYTH_DATA_DIR`, `POLYTH_LINK_CLIENT` set,
and `--remote-debugging-port`. Point it at a second server started with `POLYTH_LINK_HOST`:
`POST /api/tunnel/pairing` gives the link to paste in the list, and
`POST /api/tunnel/pairing/:id/approve` answers once the words are confirmed. A server's CSP
hashes come from `index.html` at boot, so restart it after rebuilding the web bundle.

`lost_transport_reconnects_behind_the_same_loopback_origin` fails intermittently
(about a third of runs on a 4-core arm64 host, on clean code as well).

## Coverage intent

- Auth/ingress negatives (loopback is not a paired device)
- Remote policy default deny and package classification
- Ticket parser (size, version, relay scheme, endpoint match)
- Pairing state machine (dual confirm, single claimant, restart)
- Identity fail-closed
- Header stripping and path denials
- Mutation retry classification
- Relay config validation

Physical-device direct/relay matrices are documented here and executed
when Android/iOS runners or devices are attached. Linux CI covers the
Rust core, host compile, and Node authorization tests.
