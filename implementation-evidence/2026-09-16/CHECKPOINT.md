# Identity foundation checkpoint — 2026-09-16

## Status and provenance

**Partial implementation. Not release-qualified. The complete blueprint is not implemented.**

- Repository: `otto-assistant/polyth`.
- Branch: `feat/identity-governed-workspaces-20260916`.
- Uploaded source checkout: `29f13bdd2e4b5451d129e58a0476108f9ea31098`.
- Blueprint baseline: `ff883b3f245545306f107c8fdc90b872e76762d0`.
- Previous published checkpoint: `df7a67c3deaa77d0a3bf7b54d8eddf4e39c7b660`.
- Latest code commit: `af6529cda869908a8537977481e2a668725948df`.
- Tested code tree: `96a812ef555d9419ce9679fad6e92e69f364fe4d`.
- The later documentation-only commit adds this report and the task-status manifest.
- Functional change set versus uploaded source: 42 files, 2385 additions, 86 deletions.

Inputs:

| Archive | SHA-256 |
| --- | --- |
| `polyth.zip` | `9d517071cc866da2937f3787c15214a29e0fc76d3640669c330b8bcbea487836` |
| `polyth-full-implementation-blueprint-2026-09-16(1).zip` | `8b91d7c54ee16999856fb7674117e6b603813a5113caa76b70daff6d0b5261d5` |

Changes were published through GitHub Git-object/ref APIs, not shell `git push`.
Each completed published code tree was compared with the local Git staging tree.
The local reconstructed baseline has different commit metadata but the exact same
source tree as the previous remote checkpoint. No existing feature commits were
force-overwritten. Master was not changed or merged. No production data, model
provider, external identity provider, secret, or deployment was used.

## Implemented and locally verified

### Control authority

`packages/control-plane` supplies a private SQLite authority with WAL, foreign
keys, checksummed append-only migrations, a durable installation sentinel, nested
transactions/savepoints, and fail-closed recovery behavior. It refuses fresh
initialization over an existing data root; that refusal is not a legacy migration.

Version 1 migration bytes are unchanged. Version 2 adds auth epochs, immutable
identity constraints, provider/issuer/subject mapping uniqueness, active-owner
constraints, and durable outbox lease/retry metadata. Owner checks preserve the
last **active** owner even when another owner is disabled.

Mutations can commit their audit event, outbox entry and replay receipt together.
A replay rechecks current authorization; a changed request under the same key
conflicts. Outbox delivery is ordered and **at least once**, not exactly once:
consumers must deduplicate by installation ID and event ID. Expired leases fence
late acknowledgements; poison events remain visible and block later delivery.
No production delivery loop/consumer has been connected by this checkpoint.

### Identity domain and isolated HTTP adapter

`packages/identity` supplies opaque local user IDs, operator-issued browser-bound
setup claims, recovery-code acknowledgement, and one atomic transaction creating
the owner, organization, Personal Space, memberships, recovery set and session.
The operator claim issuance API is not exposed as a public HTTP endpoint.

Password work uses real asynchronous bounded scrypt; legacy credentials can be
upgraded after verification. Sessions and setup/recovery tokens persist hashes,
not usable raw tokens. Account renaming preserves identity; session revocation,
logout-all, password change, suspension and recovery invalidate old access.
A recovery code cannot reactivate a suspended account or grant memberships.
A new local account receives no implicit organization, Space or owner grant.

The separately composed HTTP adapter validates configured transport/origin,
CSRF, cookies and bounded JSON bodies. It exposes account-first auth endpoints
and a live WebSocket authorizer. Tests exercise actual local HTTP/WS connections.
The WS fixture reauthorizes messages and closes revoked access; production WS
broadcast/message/stream invalidation remains a separate integration requirement.

### Existing application fixes that are wired

- Existing server auth JSON loading no longer silently resets malformed data to
  an empty installation. Only an absent file is treated as first boot. Legacy
  ownerless-session adoption is restricted to the old file format.
- An explicitly invalid deployment-profile value throws instead of falling back
  to `local-trusted`. An absent value still retains the legacy default.
- Browser bootstrap requires explicit authorization and a verified account scope.
  Failed/malformed auth responses keep the UI unavailable/locked; a late response
  cannot override an intervening auth-required event. Login reloads to restore
  the authenticated cookie/account namespace.

These are targeted hardening changes, not a claim that all legacy identity
fallbacks or client-cache/WS cleanup have been removed.

## Verification

Runtime: Node `22.16.0`, npm `10.9.2`, Git `2.47.3`, Linux x86-64.

| Check | Result |
| --- | --- |
| Combined targeted Node tests below | **96 passed, 0 failed, 0 skipped**, exit 0 |
| Control-plane TypeScript project | Passed, exit 0 |
| Identity TypeScript project | Passed, exit 0 |
| `git diff --check` | Passed, exit 0 |
| Full web TypeScript project | Exit 2; 110 diagnostics, byte-identical to baseline |
| Full server TypeScript project | Exit 2; 25 diagnostics, byte-identical to baseline |
| `npm run build:web` | Exit 1: uploaded esbuild binary is macOS ARM, runtime is Linux x86-64 |
| Bounded `timeout 15s npm test` | Exit 124; incomplete, failures observed before timeout; **not passed** |
| Legacy server auth/authIngress suites | Could not load due to missing `semver`; **not passed** |
| Linux dependency GitHub Actions run | Failed before runner steps on both attempts; no artifact |
| Browser UI / positive live HTTPS / native / physical devices / external providers | Not verified |

Reproduce targeted tests from the repository root with compatible installed dependencies:

```sh
node --experimental-strip-types --test \
  packages/control-plane/test/*.test.ts \
  packages/identity/test/*.test.ts \
  packages/server/test/authState.test.ts \
  packages/tenancy/test/*.test.ts \
  apps/web/test/authBootstrap.test.ts \
  apps/web/test/multiUserAccountScope.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/control-plane/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p packages/identity/tsconfig.json
```

Coverage includes a real SIGKILL during an SQLite transaction, independent-process
first-owner races, two-connection lease takeover, crash after delivery/before ack,
once-only recovery races, post-KDF authorization rechecks, actual scrypt hashing,
worker saturation, HTTP Origin/CSRF rejection and WS session revocation. Fast
transaction fixtures use an explicitly injected test-only password verifier;
separate tests use the actual production KDF. Browser-bootstrap tests are logic
and source-regression checks, **not browser E2E**.

`checkpoint.json` records command outcomes and SHA-256 hashes of local logs.
The 96 implementation tests are not 96 accepted blueprint catalog entries.
The blueprint contains 104 tasks and 1159 catalog tests; no complete milestone
or full task acceptance is certified by this checkpoint.

## Remaining release blockers and next integration order

1. Complete the reviewed read-only legacy inventory, backups, dry-run and staged
   migration. Preserve/remap existing ownership and storage identities explicitly;
   quarantine ambiguous data. Never initialize a second authority over it.
2. Wire the control-plane/identity authority into the main server and replace the
   legacy JSON auth/tenancy consumers coherently. Remove ambient `usr_owner`,
   loopback-as-human and lazy account provisioning, including internal services.
3. Wire protected HTTP, WS, stream/broadcast, tool and background consumers to
   live actor/resource authorization and epoch invalidation. Implement the
   human-session/paired-device-grant intersection and trusted ingress contracts.
4. Implement and validate account-first setup/login/recovery/profile UI, real
   browser cache and connection invalidation, accessibility and native UX.
5. Complete the remaining blueprint contracts, authorization/policy/resource
   graph, identity providers, passkeys/linking, project/Space governance, secrets,
   package isolation, RAG, import/export, performance and external/native gates.

The new identity package is **not activated by the main Polyth server**. Running
`npm start` does not enable the new account-first flow. The old server still has
legacy synchronous KDF and ambient-owner behavior outside the targeted fixes.
No full switch-over, data migration, production security certification, successful
application build or all-tests-green result should be inferred from this branch.

## Dependency and publication notes

Only four workspace records were added to `package-lock.json` by offline npm
lock-only generation. Registry package versions and integrity values did not
change. Exact new lock blob: `6f59de912717c85949b1d33dccb61819752d2fa5`.
No fake dependency or substitute crypto/archive implementation was used.

The Linux dependency workflow run is `35063119780`; retry job `104721226029`
ended with `steps: []` and `runner_id: 0`. The underlying reason could not be
resolved through the available connector; no billing/quota cause is asserted.
The existing repository has both manual and narrowly scoped CI workflows.

An isolated draft PR #224 was used only to obtain a byte-exact test-merge lock
blob through the text-only connector. It is **closed without merge**; its helper
ancestry is not part of the implementation branch. Helper refs
`tmp/identity-lock-base-20260916-ac876` and
`tmp/identity-lock-delta-20260916-ac876` remain because no branch-delete action is
exposed by the connector. They are disposable, not implementation branches.
