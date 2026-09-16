# Content-bound trust for repository instructions

Repository-controlled executable instructions are untrusted input. The first protected consumer is `.agents/loops/*.md`.

## Reused architecture

- `@polyth/schedule` remains the canonical owner of managed loop tasks, cadence, history, and execution state.
- `@polyth/permissions` owns the small generic `ContentTrustReceipt` authorization contract.
- The existing loop scanner remains responsible for discovery, parsing, validation, and SHA-256 content identity.
- No parallel scheduler, permission engine, or repository watcher was added.

## Trust invariant

A receipt binds Space, project, source kind, source identity/path, full content digest, semantic executable digest, approval scope, and approval time. Any mismatch fails closed.

Discovery is not authorization. A new or changed loop is parsed and surfaced, but remains disabled until the exact current version is approved. Once a version has been approved, later repository bytes never overwrite its stored executable prompt/cadence/title/profile before reapproval.

The available decisions are:

- **Trust this version** — promotes exactly the repository version re-read at the approval boundary and persists a `current-version` receipt.
- **Run this version once** — executes an exact temporary snapshot with a `once` receipt; persistent trust and the last approved executable snapshot are unchanged.
- **Keep blocked** — records the decision for the current digest and keeps execution disabled.

## Change detection and TOCTOU safety

Trust is invalidated by effective content identity rather than by Git status. Agent edits, manual edits, pulls, checkouts, merges, rebases, and external filesystem changes therefore have the same effect when the bytes change.

The periodic scanner updates pending metadata for UX, but it is not the final security boundary. The schedule runner re-reads the loop file immediately before dispatch and validates the current path/content/semantic identity against the execution receipt. A change between scan and execution cannot silently run.

## Compatibility

Existing managed-loop records without a content receipt migrate fail-closed: their history is retained, but they are disabled and require one explicit approval of the current repository version. UI-created schedule tasks are unchanged.

The receipt type is consumer-neutral so future executable repository sources (for example project commands or tracks) can reuse the same content identity without sharing schedule state.
