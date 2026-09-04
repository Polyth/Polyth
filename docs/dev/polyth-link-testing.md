# Polyth Link testing

## Commands

```
cargo test -p polyth-link-core --tests
cargo test -p polyth-link-host --tests
node --experimental-strip-types --test packages/server/test/authIngress.test.ts packages/server/test/httpTunnel.test.ts packages/server/test/remotePolicyCoverage.test.ts packages/tunnel/test/*.test.ts packages/pairing-qr/test/*.test.ts packages/tunnel-relay/test/*.test.ts apps/mobile/test/runtime.test.ts
```

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
