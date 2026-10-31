# ADR: provider-neutral Judgment evidence

Status: accepted. Date: 2026-09-22.

Sources: the Judgment Phase 1 contract, `packages/judgment/src/types.ts`, and
`packages/judgment/src/server.ts`.

## Problem and existing seams

Polyth needs bounded semantic evaluation with typed probability-bearing answers,
independent of an executing agent's model. Session one-shot generation has different
ownership and cannot supply that contract. Package discovery, server services,
Space storage, Vault callbacks and shared model descriptors/picker already provide
the integration boundaries. No session/harness dispatch or action authority is added.

## Decision

`@polyth/judgment` owns provider-neutral types, validation, limits, run/shared budgets,
cancellation, retry, concurrency and observations. Its root has no Node, network,
environment or secret access. Its separate server entry owns scoped configuration
and engine contributions. `@polyth/judgment-jev` owns the first backend, pinned SDK,
credential callback, compatibility and normalization. `@polyth/judgment-local` owns
the on-server engine for TinyDecide-format models (pinned, hash-verified engine and
presets; user models from Space storage), executed in a worker thread.

The canonical [Judgment invariants](../../packages/judgment/README.md#architectural-invariants)
and [runtime/configuration contract](../../packages/judgment/README.md) govern future
adapters and consumers. Application policy interprets evidence, performs authorization
and decides effects. There is no automatic LLM fallback. Since 2026-10-16 the core
package also registers an opt-in `agent` engine: one tool-less direct completion
(`host.smallModelComplete` with `requireDirect`) on a model of the person's own
connected harnesses, with no API key or Credential Vault entry. It is never the
Space default; user-defined judges always target it, so a judge never depends on a
hosted engine's key. The SDK speaks one protocol;
the adapter reaches it through a fixed table of routes (TypeSafe direct plus gateway
routes), each a Judgment provider with its own pinned origin and credential.
Unknown providers fail explicitly. Canonical provider/model DTOs are reused without
inheriting a harness identity.

## Consumers, security and persistence

Server consumers resolve `JUDGMENT_SERVICE` lazily, create an owned Space/project
run, judge and dispose it. Since 2026-10-11 consumers register *uses*
(`registerUse`/`resolveUse`): Judgment owns their generic settings (switch,
parameters, per-use model) and each consumer owns its policy, fallback and display
(see the [use table](../../packages/judgment/README.md#uses-features-that-ask-judgment)).
Every use is opt-in, and an answer may only take an automatic action away or add a
marker/score; no use approves, executes or sends on its own. Since 2026-10-15 a
person may give a user-defined judge (`@polyth/judgment-judges`) actions: send a
fixed message, merge an isolated chat, approve or (since 2026-10-26) deny a waiting
request, change Auto-Approve, or continue a limited turn on an allowed model. The
judge's code, not the answer, runs them, and only through the session facade of the
person who saved the judge (their chat access, guardrails and limits); a Space that
does not answer automatically gets no approval from a judge (a denial still runs
there, as that Space's own deny rules do), and each outcome is recorded before or
with its effect.
Facts shown to people still belong in the consumer's canonical event path before
delivery.

Settings routes are local-only. Global means Space-wide; project and scope overrides
are separate from adapter credentials. The adapter uses the existing Vault callback,
a fixed HTTPS origin per route (a credential is only ever sent to its own route) and
redirect rejection; there is no user-supplied endpoint. Credentials, raw evidence and native
responses never enter ordinary logs, telemetry, browser DTOs or judgment history.
A timeout does not release concurrency occupancy until actual adapter settlement.

Versioned configuration files use atomic replacement. Existing data is not migrated
in bulk; the Jev adapter reads its version 1 file compatibly and writes version 2 on
the next credential change.
Disabling packages cancels runs and unregisters backend contributions. Failures carry
no semantic defaults. Rollback can remove/disable these additive packages without
rewriting session history or credentials.

## Packaging and compatibility

Both packages use `polyth.serverEntry`; Judgment owns `polyth.webEntry`. The desktop
build generates static factory imports from the same manifests through
`apps/desktop/serverPackageInventory.ts`, because packaged Electron cannot scan
repository sources. Every package uses its ordinary manifest entry; features need
no manual desktop row.

Session/harness APIs remain unchanged. New adapters implement the same contribution
and interface without consumer redesign. Observations are a future Usage seam;
Judgment calls are not ordinary agent turns and add no separate analytics store.

## Verification and limits

Owned package tests/typechecks run in the deterministic release-quality gate,
using fake engines or the real SDK with injected transport. They cover invalid
responses, retries, aborts, budgets, Space isolation, credential/catalog races and
settings interactions. Desktop tests cover generated imports. Paid live service
quality, signed distributions and native-device behavior require separate evidence.
