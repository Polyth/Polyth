# Phase 6 — directory and worktree isolation (OC-REAL-068–072)

Validated 2026-08-28 against real OpenCode CLI `1.18.18` (legacy protocol) on Polyth
HEAD of `feat/opencode-real-world-validation-17e1`. Model: `opencode/big-pickle`.
Runners: `scripts/opencode-real-world/phase6lib.ts` + `phase6_068.ts`–`phase6_072.ts`.

Fixture: `/tmp/polyth-tests/{project-a,project-b}`, each a git repo with a
`worktree-feature` git worktree; every tree carries `IDENTITY.txt` with a unique
marker (`PROJECT_A_MAIN`, `PROJECT_A_FEATURE`, `PROJECT_B_MAIN`, `PROJECT_B_FEATURE`).
Every prompt reads `IDENTITY.txt` (or ships it as an attachment), so any directory
escape becomes marker-visible. All Polyth boots bind port 0 (never 14500); every
forced process stop used a recorded exact PID. R = production `boot` + real
`opencode serve` per location; H = `fakeOpenCode` real-socket endpoints under
production facade/session-service wiring with one SHARED `sessionIdMap`.

Scenario count: **2 pass, 2 partial, 1 fail.**

**BLOCKER 6 (cross-worktree/root-fallback leakage): NOT HIT.** No session ever
escaped its authoritative directory/worktree; no deleted worktree fell back to the
repo root, the last cwd, or another tree; no cross-tree bytes, markers, events,
permissions, or attachment URLs crossed sessions in any scenario.

| ID | Engine | Verdict | Attribution | Result |
| --- | --- | --- | --- | --- |
| OC-REAL-068 | R | **PASS** | NONE | Four concurrent sessions (2 roots + 2 worktrees, identical prompt) each answered with exactly its own marker; upstream cwd, tool paths, directory catalogs, and durable logs never crossed locations. |
| OC-REAL-069 | H | **PARTIAL** | POLYTH | Forced-equal backend session/message/request/event ids across the root and worktree endpoints never crossed: SSE payloads, permission replies, and prompts stayed endpoint-bound. Deleting the colliding ROOT session wiped the WORKTREE session's canonical->backend binding (and reconciliation ordinal) from the shared `sessionIdMap`; the damage self-healed (post-delete send and SSE both worked), so no observable loss. Failing regression test: `packages/backend-opencode/test/regressionSharedSessionIdMap.test.ts`. |
| OC-REAL-070 | R+H | **PASS** | NONE | Same-branch worktree race produced exactly one valid worktree with a bounded loser; jittered create-vs-remove races either bound the verified path or rejected typed (`invalid-input`/`ENOENT`, projection `failed`); deterministic TOCTOU removal before spawn rejected the create with no orphan serve process and no root fallback. |
| OC-REAL-071 | R | **PARTIAL** | POLYTH | Worktree deleted during idle/text/tool/permission phases: durable history survived every phase; session-scoped file/git routes returned typed 404 `session worktree is missing`; post-deletion model work failed truthfully (`NotFound: FileSystem.access(<worktree>)`) with cwd still the deleted worktree — never the repo root; the pending permission survived deletion. Honesty gap: a NEW session created on the rm-rf'd (unpruned) worktree settles `idle` with `worktreeState: "ready"` because git still lists the stale path and the pool reuses the live runtime. |
| OC-REAL-072 | R+H | **FAIL** | POLYTH | Isolation criteria all held: same-relative-name attachments resolved to source-tree bytes/URLs only (root vs worktree vs fork child), the fork child stayed bound to the source worktree, the generation-1 durable attachment record was byte-identical after rotation + root-file mutation, and the respawned serve kept the worktree cwd. Reliability failures (no leak, but broken recovery): see findings below. |

## OC-REAL-072 findings (all POLYTH, none BLOCKER 6)

1. **Post-fork parent terminalization stall (deterministic, 3/3 runs).** After
   `sessions.fork`, the PARENT's next turn completes upstream (assistant reply +
   usage logged) but Polyth never appends `turn/stopped`; the projection sticks at
   `working` forever. Simultaneously the forked child's backend session id starts
   being logged as `opencode event for unmapped session` — the child's
   canonical->backend reverse mapping is dropped from the facade. Evidence:
   `artifacts/opencode-real-world/phase-6/OC-REAL-072/real/details.json`
   (`parentStallProjection`), plus the parent event log in the run database ending
   at `usage/recorded` with no `turn/stopped`.
2. **No session recovery after endpoint rotation (R and H agree).** After the
   worktree `opencode serve` PID is SIGKILLed mid-turn (R) or the endpoint is
   rotated to a new generation via `lease.refresh` semantics (H), the session drops
   to `unknown` and reconciliation stays blocked (`runtime status evidence is
   insufficient`); every subsequent send is refused with `conflict`. The refusal is
   truthful and bounded (nothing lies, nothing leaks, no wrong-cwd work), but the
   session never re-verifies against the recovered/new endpoint generation.
3. **[gap] Attachment-bearing histories cannot be forked.** OpenCode 1.18.18
   stores a `file` prompt part as synthetic user TEXT parts ("Called the Read tool
   with the following input: …" + the file content block), so Polyth's exact-history
   comparison never finds the canonical prefix and `fork` always rejects with
   `history-mismatch`. Truthful bounded rejection — no approximate child, no leak —
   but fork is functionally unavailable after any attachment turn.

## Evidence map

- Per-ID verdicts: `artifacts/opencode-real-world/phase-6/OC-REAL-0{68..72}/verdict.json`
  (+ `manifest.json`, `details.json`/`phases.json` per scenario).
- Wire/WS/polyth NDJSON logs + database snapshots: `logs/opencode-real-world/phase-6/`.
- Superseded attempts are retained as `OC-REAL-0NN-attempt-*` directories.
- Failing regression test (committed intentionally failing, repo convention):
  `packages/backend-opencode/test/regressionSharedSessionIdMap.test.ts` (OC-REAL-069).
