# Session isolation hardening — 2026-09-08

Audited and changed current master `c8d7ca79` after PR #128. The canonical session,
conversation and history remain intact when temporary isolation ends. This is not
a parity claim or a replacement feature.

## Root causes and resulting architecture

- **Resource ownership:** `managed.inspectOwned` is the common authority for
  source reads, publication and deletion. It checks the session-derived branch
  and path, Git listing, marker kind/session/branch/origin, canonical path and
  base ancestry. Integration cleanup additionally requires a detached checkout
  and that session's marker. There is no recursive-delete fallback. Creation
  owns rollback across the Git call, lost responses, revision lookup and marker
  writing; uncertain identities are retained and logged. Branch cleanup uses
  expected-SHA deletion. A durable canonical session takes ownership even when
  subsequent native startup fails; it is returned to the UI with its source intact.
- **Source integrity:** snapshots use a temporary index, `write-tree` and
  `commit-tree`. They preserve source HEAD, actual index, staged/unstaged split,
  working files and ignored-file behavior. Internal commits/ref operations bypass
  user hooks and signing. Source revisions include mode/symlink identity and are
  checked across snapshot, immediately before publication, and before/after
  terminal closure during cleanup. Late source edits retain the source for review.
- **Publication:** session lock precedes the common-Git-directory/branch lock.
  Creation uses the captured base SHA. Merge requires the original branch checkout
  to exist before publication; it never silently chooses another return location.
  An atomic Git ref transaction updates the target with expected-old-SHA and
  creates `refs/polyth/isolation/<session-id>`. That receipt proves publication even
  after an external target reset. Prepared integration HEAD anchors its commit
  across failures. Checkout synchronization uses a checked two-tree `read-tree`
  update; dirty, obstructed or unrelated checkouts are preserved. A clean later
  descendant is accepted without rolling it back. Three bounded retries are for
  proven target movement only. Commit messages are deterministic.
- **Runtime ownership:** `releaseSession` belongs to the generic harness pool.
  Cached session leases and physical occupancy protect shared runtimes; the last
  per-session owner disposes once. A failed release stays fenced. Events,
  observations and deferred lifecycle work verify wiring tokens. Rebind uses the
  existing durable native operation/epoch protocol and reuses an already-published
  destination epoch on retry. A definitively rejected initial native creation can
  establish its first destination binding through the same durable operation
  journal; retries reuse confirmed receipts. It does not hold the branch lock while constructing
  or replaying the destination runtime. Terminal closure belongs to owned-source
  cleanup. Unknown native outcomes must be reconciled before workspace mutation.
- **UI:** one contracts action policy drives the card and badge. Pending phases,
  missing/unowned/corrupt resources and unavailable origins remain visible.
  Recovery has an explicit POST action; GET remains observational. Managed origins
  are filtered, nested isolation and sharing its source through ordinary
  create/fork are rejected, and delete waits for finalization. Project-default
  isolation preserves the selected harness. Status requests cannot apply another
  session's late response.

## Durable state machine and compatibility

| Phase | Legal payload and exit |
| --- | --- |
| `active`, `merge-ready` | No transaction payload; Keep stores only a revision dismissal. |
| `conflict` | Conflict message/paths; agent resolves inside the owned source. |
| `merging` | Preparation only. A restart can abandon preparation safely. |
| `publishing` | Required expected SHA, result/snapshot SHA, target ref; new records also carry receipt, checkout and source revision. Receipt + Git reality decide recovery. |
| `rebind-pending` | Optional published result and source revision; no source deletion. Resume canonical runtime/epoch transition. |
| `cleanup-pending` | `rebound: true`; verify canonical destination and source identity/revision before deletion. |
| `missing`, `unowned`, `corrupt` | Resource diagnosis; restricted actions and explicit reinspection. Malformed lifecycle evidence is preserved rather than repaired into an active record. |

`SessionIsolation` is an immutable-origin shape intersected with a discriminated
lifecycle union. `transitionIsolation` drops fields from the previous phase.
Normalization recognizes legacy `merging + publish` and
`cleanup-pending + rebound:false` without destructive migration. Illegal tuples
and unknown phases fail closed, including records already labeled `corrupt` that
still contain publication evidence. Old publication intents lack atomic receipts:
when Git cannot prove publication, they remain preserved for manual inspection;
recovery does not guess that resetting to the expected SHA means never published.

Merge-ready remains a projection repaired from durable completed-turn events during
startup. Read-only status can derive the same eligibility immediately. A completed
turn preceding the latest conflict does not resolve that conflict.

## Failure injection and recovery coverage

Real Git repositories cover creation failure before/after side effects, lost create
responses, revision/marker failures, rollback failure, changed identity, branch-only
ambiguous failure, symlink parents, and user/other-session ownership mismatches.

Snapshot tests cover staged and unstaged edits in one file, deletion, untracked and
ignored files, executable changes, symlinks, newline names, failing hooks, signing,
failed object creation and failed integration without source mutation.

Publication tests cover target movement/CAS rejection, receipt creation, restart
before/after publication, reset to the expected old target after publication,
checkout branch/index/file changes, untracked obstruction, pristine descendants,
origin loss/restoration, conflicts, retry exhaustion, concurrent sessions and
same-session operations. Integration refs survive uncertain publication and orphan
cleanup cannot prune another active or unknown canonical session's workspace.

Runtime tests cover durable session-create failure, unknown native-create outcome,
shared/per-session release, release failure, destination startup failure, unknown
epoch outcome, completed epoch reuse, late/queued old callbacks and preservation of
canonical history. Cleanup tests inject failure before deletion, process-close
failure, terminal write flushing, late source edits, missing source, mismatched
ownership and branch replacement after physical removal.

These are deterministic injected effect/durability failures and reconstructed
service recovery tests, not an exhaustive OS SIGKILL/filesystem fault campaign at
every instruction boundary.

## Simplification

The orchestration stays in one service rather than adding another layer of
managers. Removed the OpenCode-specific project/cwd release seam, model generation
inside publication, source `git add`/normal commit snapshotting, permissive cleanup
fallbacks and repeated ad hoc ownership checks. The durable union replaces mixed
optional transaction flags. Merge and discard share one finalization/recovery path. Card/badge share a
cancellation-safe status view and action policy. Most added code is failure-oriented tests and Git correctness
primitives; the orchestration and ownership services remain approximately their
previous combined size.

## Changed files by responsibility

- Contracts: `packages/contracts/src/index.ts`, contract policy and lifecycle tests.
- Git ownership/publication/recovery: `packages/git/src/{index,managedWorktrees,sessionIntegration,serverEntry}.ts`;
  real-Git isolation, managed resource, snapshot and publication tests.
- Runtime/session ownership: `packages/harness-runtime/src/index.ts`,
  `packages/server/src/{index,sessions}.ts`, harness registry and isolation rebind tests.
- UI/API: `packages/git/widgets/{IsolationCard,GitView}.tsx`, Git translation catalogs,
  `packages/session/src/webApi.ts`, shell Composer, WorktreeSessionDialog, Timeline,
  SessionList, `init.ts`, `shell.ts`, and mounted isolation UI tests.
- Engineering record: this document. No parity rows were marked complete.

## Validation

Final validation commands:

```sh
node --test packages/contracts/test/*.test.ts packages/git/test/*.test.ts packages/server/test/isolationRebind.test.ts packages/harness-runtime/test/*.test.ts
npm test
npm run build
git diff --check
```

The combined focused run passed **263 tests**, with **3 skipped** and no failures.
`npx tsc --noEmit` passed in `packages/contracts`, `packages/git`, `packages/server`,
`packages/harness-runtime`, `packages/session`, and `apps/web`. The independent
broad runtime/epoch/reconciliation/occupancy suite passed 141 tests.

Baseline `npm test` on unmodified master: 3,240 tests, 3,173 passed, 13 failed, 10 cancelled,
44 skipped. Baseline logs were captured before edits. Final `npm test`:
**3,329 tests: 3,262 passed, 13 failed, 10 cancelled, 44 skipped**. Failure names
match baseline exactly; there are 89 additional passing tests. `git diff --check`
passed. Logs: `/tmp/polyth-{baseline-test,final-test,related-verified}.log` and
`/tmp/polyth-types-*.log`. A detached unmodified master
build with its own workspace links independently reproduces the 10 browser-bundle
Node builtin import errors in `commands` and `harness-runtime`.

The configured running project at `http://192.168.1.200:4400/` was unavailable;
mounted DOM tests were used rather than claiming live-browser verification.

## Remaining boundaries / release gate

- Abrupt death between Git creating a resource and marker establishment can leave
  unmarked infrastructure. Branch-only or externally changed creation outcomes,
  symlinked roots, missing-marker branches and resources from an unknown canonical
  session are preserved, never guessed safe to delete. Use a canonical repository
  path for new isolation. Manual inspection can be necessary.
- Atomic publication receipts are retained intentionally. Automated receipt
  compaction/retention is not implemented.
- External Git/filesystem actors do not honor in-process locks. The implementation
  revalidates and refuses observed changes, but this is not filesystem isolation
  against a writer racing the final validation/removal syscall. Avoid external
  writes while finalizing temporary infrastructure.
- An unavailable origin or dirty/unrelated published checkout requires restoring
  the recorded destination/checkout, then Retry recovery. There is no automatic
  branch switch or arbitrary destination selector.
- Unknown native operations require existing runtime reconciliation. A rejected
  initial native create retains its visible failed canonical session and source;
  returning the session retries definitive rejection at its destination while
  preserving the same canonical identity.
- Repository-wide pre-existing test/build failures remain release integration
  gates. This pass does not claim a clean production build or complete parity.


**Release verdict: NOT READY.** The hardening patch passes its focused tests and
typechecks, but current master still cannot produce the web build and retains the
baseline suite failures. Resolve those integration gates before calling this a
release-ready product. The preserved/manual recovery cases above are intentional
fail-closed boundaries, not silently completed cleanup.
