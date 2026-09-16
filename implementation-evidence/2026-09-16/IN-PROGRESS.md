# Blueprint implementation — working branch, NOT release-qualified

Source archive: `polyth-full-implementation-blueprint-2026-09-16(1).zip`.
Source checkout: `29f13bdd2e4b5451d129e58a0476108f9ea31098`.
Blueprint baseline: `ff883b3f245545306f107c8fdc90b872e76762d0`.
Branch: `feat/identity-governed-workspaces-20260916`.

The branch is an implementation workspace. A created branch or this record is not an accepted task. No feature is declared complete by this file. The final evidence manifest must distinguish source inspection, passing automated tests, browser evidence, external adapters, native/physical-device evidence, and remaining release blockers.

Initial sequence: transactional control authority and safe legacy handling; removal of ambient human identity and fail-open bootstrap; account-first setup/login and session revocation; then downstream scoped authorization and feature integration in dependency order.

The scoped dependency workflow installs the pinned lockfile without lifecycle scripts on Linux and publishes only `node_modules` for offline validation. It does not use deployment secrets, access private application data, call model providers, or run deployment jobs. The repository's ordinary CI remains manual-only.
