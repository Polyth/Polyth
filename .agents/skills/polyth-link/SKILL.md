---
name: polyth-link
description: Work on Polyth Link, QR/digital pairing, Rust/native transport and remote policy while preserving trust boundaries.
---
# Polyth Link, QR pairing and remote policy

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context link`. This command is a navigation aid, not an audit.

- `docs/architecture/polyth-link.md`
- `packages/plugins/src/serverPackage.ts`
- `apps/mobile/src/polythLink.ts`
- `Cargo.toml`
- `docs/agents/security.md`
- `docs/agents/mobile-matrix.md`

## Workflow and constraints
Treat Link as application-layer access to canonical HTTP/WS, not a VPN, arbitrary proxy or unauthenticated share URL. Preserve authenticated transport identity, short-lived pairing, device grants and server-created ingress as separate trust boundaries. Loopback address or a request header is not proof of paired identity.

Before changing a handshake or Rust FFI surface, read the current protocol owner and pinned Cargo dependencies. Ticket parsing does not implement secure identity storage, pairing confirmation, proxy lifecycle or native reconnect. Do not guess cryptographic parameters from historical prose. Keep private keys and pairing secrets out of JS, logs, diagnostics and generated examples.

Remote routes are default-deny. Review the package's route scopes and allowed methods/capabilities; privileged local administration must not become remotely reachable via a generic API forwarder. Recheck grants on upgraded sockets and actively terminate affected connections on revoke. Partial revocation must remain a partial/error result, not optimistic success.

Test invalid/expired/replayed tickets, cancellation, host substitution, incorrect safety confirmation, direct-to-relay changes, paired request authorization, revoked HTTP and WS, and unknown routes. Use the current `select-tests.mjs polyth-link` owner set rather than inventing a second list. Run relevant Rust and native tests when their layers change. Never call mobile production pairing complete from TypeScript mocks or ticket-parse FFI tests.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/server/test/remotePolicy.test.ts`; `packages/server/test/wsRemoteAuth.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
