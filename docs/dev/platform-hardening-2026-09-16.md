# Platform hardening and agent observability — 2026-09-16

This change set extends existing Polyth seams rather than adding parallel schedulers, message buses, diff engines, or prompt registries.

## P0 — content-bound trust for repository loops

`.agents/loops/*.md` remains owned by `@polyth/schedule`. Discovery is not authorization: new or changed repository content is parsed and surfaced but is not executable until the exact observed version is approved.

Trust receipts bind Space, project, source kind, source path, SHA-256 content digest, semantic executable digest, approval scope, and approval time. Repository changes preserve the last approved executable snapshot; unapproved bytes never overwrite it. `Trust this version`, `Run once`, and `Keep blocked` are explicit decisions. The scheduler re-reads the source immediately before dispatch, so agent edits, manual edits, checkout/pull/merge/rebase changes, and filesystem races all invalidate stale trust identically.

Legacy managed-loop records migrate fail-closed and retain history.

## P1 — hunk-level Git mutations

The existing diff parser/digest logic is shared by review anchors and the Git mutation backend. The browser receives a SHA-256 identity for the exact Git-produced diff snapshot. A hunk mutation submits only:

- project/session scope,
- path and staged state,
- hunk index and hunk digest,
- exact snapshot digest,
- whitespace-view preference.

The server regenerates the current diff, checks the full snapshot first, checks the indexed hunk identity second, then applies only the exact Git-produced hunk bytes with `git apply` through argv + stdin. No raw browser-provided patch and no shell-interpolated command is accepted.

Supported operations are stage, unstage, and discard. Binary patches, rename/copy metadata, and submodule changes remain file-level operations and return an explicit unsupported error. A stale diff is rejected rather than heuristically relocated.

## P2 — bounded peer observations

Related delegated sessions communicate through the canonical session event log, not through a new transport. `polyth_peer` writes ignorable `session/observation` events with one of:

`finding | question | answer | artifact | blocker | review`

Each observation carries source/target/root session provenance, project id, optional task id, and bounded artifact references. Writes and reads are restricted to the same authenticated Space, project, and delegated session tree. Payload sizes and read windows are bounded.

Observations are deliberately not synthesized into user/assistant messages. Parent/sibling agents inspect them explicitly, so peer traffic cannot silently inflate or mutate model-visible chat history.

## P3 — prompt-prefix cache diagnostics

The canonical `harness.capabilities` registry already provides deterministic id ordering and semantic descriptor revisions. Prompt-prefix diagnostics reuse the same `desiredBundleRevision()` used by provisioning instead of introducing a second cache-key algorithm.

The diagnostic identity covers the **Polyth-owned desired capability prefix** only. It does not claim to fingerprint opaque vendor-internal system prompts.

Exposed data is content-free:

- prefix identity,
- bundle revision,
- contributor count,
- contributor id/kind/owner/scope/semantic revision.

Instruction bodies, context text, tool schemas, prompts, cwd, tokens, secrets, and timestamps are not returned. Project-level identities therefore remain stable across session ids, worktree paths, registration ordering, and process restart, while semantic capability changes rotate the identity.

The read-only route is Space-scoped and validates an optional session/project pairing. Existing Runtime Recovery → Technical details shows the prefix identity and contributor revisions when available.

## Verification focus

The test additions cover exact trust/version invalidation, fail-closed legacy migration, hunk stage/unstage/discard and stale snapshots, peer lineage/project boundaries and payload bounds, deterministic prefix identity, semantic rotation, volatile-metadata stability, content non-disclosure, route scoping, and technical-detail presentation.

GitHub-hosted jobs were unavailable while this branch was implemented (jobs terminated before runner allocation). Do not treat that infrastructure failure as a passing or failing product test; merge review must distinguish connector/static inspection and locally reproduced Git hunk behavior from CI that actually executed.
