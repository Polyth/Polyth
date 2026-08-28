# OpenCode hardening release gate

Snapshot 2026-08-28 against real OpenCode CLI `1.18.18`.

Rules: a box is checked ONLY when the cited scenario ID was actually executed and
`docs/opencode-hardening/REAL-WORLD-RESULTS.md` or the phase RESULTS/verdict
artifacts record **pass** (or pass after rerun). Code inspection alone never
checks a box. Partial, fail, blocked, or not-run stays unchecked, with the
failing scenario IDs named. Evidence lives under
`artifacts/opencode-real-world/<phase>/` and `logs/opencode-real-world/<phase>/`.

## Scenario gates

- [x] **Mutation ambiguous outcome** — OC-REAL-034, -035, -036, -038, -039,
  -040 all PASS (Phase 2): one POST per mutation, durable unknown, no retry,
  no similarity adoption. Evidence: `artifacts/opencode-real-world/phase-2/RESULTS.md`.
- [x] **Crash after upstream acceptance** — OC-REAL-050 and OC-REAL-051 PASS
  (Phase 4): prompt/create accepted upstream, response swallowed, child
  SIGKILLed; one durable unknown operation, resend blocked, exactly one POST
  across recovery. Evidence: `artifacts/opencode-real-world/phase-4/RESULTS.md`.
  The Phase 13 variant OC-REAL-101 (crash before `settleOperation` commit) was
  NOT executed.
- [x] **Durable queue exactly once** — OC-REAL-073 and OC-REAL-075 PASS
  (Phase 7, rerun on `1b327c54` after `dbadbcd7 fix(opencode): terminalize
  repeated legacy turns`): no queue loss or duplication, correct
  reservation/FIFO/edit semantics, every queued dispatch terminalized, and
  the queue fully drained on real legacy `1.18.18`. Evidence:
  `artifacts/opencode-real-world/phase-7/OC-REAL-07{3,5}/verdict.json`.
  Tracked separately, not this box: OC-REAL-037 FAIL (ENV) never reached
  accepted-head ambiguity; OC-REAL-086 (scaled) PARTIAL — 80 post-fault queue
  admissions rejected 409 under generation-only continuity.
- [x] **Permission missed-event recovery** — OC-REAL-042 PASS (Phase 3):
  dropped `permission.asked` recovered exactly once via pull, one answer POST.
  Evidence: `artifacts/opencode-real-world/phase-3/OC-REAL-042/verdict.json`.
- [x] **Question missed-event recovery** — OC-REAL-043 PASS (Phase 3): dropped
  question recovered once despite a faulted-empty first pending list, one
  reply POST. Evidence: `artifacts/opencode-real-world/phase-3/OC-REAL-043/verdict.json`.
- [x] **Session completion while disconnected** — OC-REAL-077 PASS (Phase 7):
  every UI disconnected mid-tool and mid-permission; backend completed with
  zero UIs, side effect exactly once, new UI rehydrated the full durable order
  with completion and `idle`. Related backend-SSE variant OC-REAL-044 is
  PARTIAL (output recovered once, terminal stays explicit `unknown` because
  legacy idle carries no revision) — tracked under the F1 finding, not this box.
- [x] **Owned runtime crash recovery** — OC-REAL-048–061 all 14 PASS (Phase 4;
  OC-REAL-060/061 PASS after rerun on the authority/generation fix). Evidence:
  `artifacts/opencode-real-world/phase-4/RESULTS.md`.
- [ ] **Shared V2 daemon ownership** — FAIL/BLOCKED. OC-REAL-062–067
  (Phase 5): 0 pass, 4 fail (062/064/067 POLYTH, 066 OPENCODE), 2 blocked.
  Normal product boot cannot borrow/attach to a shared service; borrowed-seam
  evidence is not product acceptance.
- [ ] **Worktree isolation** — mixed. OC-REAL-068 and OC-REAL-070 PASS;
  OC-REAL-069 and OC-REAL-071 PARTIAL (POLYTH); OC-REAL-072 FAIL (POLYTH:
  post-fork stall, no post-rotation recovery, attachment-history fork
  impossible). The isolation invariant itself held — no leak or root fallback
  (see BLOCKER 6) — but the row verdicts keep this box open.
- [x] **Multi-client consistency** — OC-REAL-073–077 all PASS: OC-REAL-074,
  -076, -077 from the original run; OC-REAL-073 and OC-REAL-075 after the
  rerun on `1b327c54` (the second-turn terminalization wedge no longer
  reproduces). Convergence, CAS, and exactly-once held in every run (see
  BLOCKER 7). Evidence: `artifacts/opencode-real-world/phase-7/RESULTS.md`.
- [ ] **SSH reconnect** — FAIL. OC-REAL-078–083 (Phase 8): 0 pass, 2 partial,
  4 fail, all POLYTH. ControlMaster loss replaces the whole generation,
  strands accepted turns, and SSH authority/generation is not durable across
  Polyth restart. No duplicate prompt or local fallback was observed.
- [ ] **Long-running soak** — not the defined soak. OC-REAL-084 (scaled) PASS,
  but it was a **10.1-minute scaled dense soak, not the 24-hour / 10,000-turn
  soak** the plan defines; OC-REAL-085 NOT RUN (no response-loss injection was
  composed in); OC-REAL-086/087 (scaled) PARTIAL. No 24-hour claim is made.

## BLOCKER 0 — V2 model discovery

- [x] **BLOCKER 0 closed for its blocker scope** (V2 adapter stubbed the model
  catalog to `[]`): live `protocol:auto` selects V2 on the real dual-surface
  server; `models()` uses native `GET /api/model` (68/68 vs native, failures
  throw, no artificial empty catalog); native session create/prompt/steer/
  interrupt/SSE routes work; missing branch/delete return typed
  `capability-unsupported`; the UI model picker renders selectable models with
  no "No models available". Evidence:
  `artifacts/opencode-real-world/blocker-0-sol/final-validation.md`,
  `.../HTTP-VERDICT.md`, `.../polyth-v2-runtime-validation.json`,
  `packages/backend-opencode/test/protocolV2.test.ts`.
  This does NOT claim full V2 parity: the OC-REAL-026 revalidation still
  records FAIL rows (transient-empty catalog readiness, facade `protocol()`
  not forwarded, message `limit` cap) and Phase 5 ownership gates stay open.

## BLOCKER 1–10 — stop-the-line classes from the original campaign

Numbering as used by the executed phase evidence (phase-2/3 verdicts and the
phase-5/6/7 RESULTS). "Not triggered" means the class was probed by executed
scenarios and never occurred; it does not close the scenario gates above.

- [x] **BLOCKER 1 — duplicate prompt admission/POST**: not triggered.
  Phase 2 (OC-REAL-034–036), Phase 4 (048–061), Phase 7 (073) each proved
  exactly one prompt POST under response loss, crash, and same-tick races.
- [x] **BLOCKER 2 — duplicate permission/question answer**: not triggered.
  OC-REAL-014/016 (races), OC-REAL-038/039 (lost acknowledgement), OC-REAL-074
  (two-client CAS) each produced exactly one upstream answer.
- [x] **BLOCKER 3 — lost permission request**: not triggered. OC-REAL-042 PASS
  recovered the dropped request exactly once; OC-REAL-013/038/056 kept cards
  durable through detach, ambiguity, and kill.
- [x] **BLOCKER 4 — lost question / false terminal from missed events**: not
  triggered. OC-REAL-043 PASS; OC-REAL-044 stayed explicit `unknown` rather
  than inventing a terminal state.
- [x] **BLOCKER 5 — shared-service ownership escalation**: not triggered.
  Phase 5 explicitly records the shared PID surviving every borrowed shutdown
  with its external SSE client connected (OC-REAL-062–067).
- [x] **BLOCKER 6 — cross-worktree/root-fallback leakage**: not triggered.
  Phase 6 explicitly records no session escaping its directory/worktree and no
  deleted worktree falling back to root (OC-REAL-068–072).
- [x] **BLOCKER 7 — multi-client duplication/cross-session leakage**: not
  triggered. Phase 7 explicitly records no double admission, duplicate answer,
  duplicate WS event, or cross-session leak (OC-REAL-073–077).
- [ ] **BLOCKER 8 — duplicate model-visible fact / stale-event state
  regression**: **TRIGGERED — FAIL (POLYTH)**. OC-REAL-041 produced 4
  duplicate assistant/message facts after an event-family drop (its
  verdict.json carries a blocker tag numbered 3; by observed behavior it
  belongs to this duplication class); OC-REAL-045 turned replayed SSE frames
  into 2 assistant facts plus 4 internal observation errors. OC-REAL-046 was
  rerun after the SSE fencing commits (HEAD `1b327c54`) and **no longer
  regresses**: 2 held real old tool-start frames were released after the
  pull/current terminal checkpoint and both were rejected typed
  `observation-regressive` — durable tool events unchanged, no rank
  regression (verdict `partial` only because cross-generation fencing remains
  deterministic-only in that run; attribution NONE, no blocker tag). The box
  stays open on OC-REAL-041/045. Evidence:
  `artifacts/opencode-real-world/phase-3/OC-REAL-04{1,5,6}/verdict.json`.
  OC-REAL-047 has no verdict (run never completed).
- [x] **BLOCKER 9 — duplicate fork / unkeyed create**: not triggered.
  OC-REAL-040 PASS (orphan child never adopted, no second create) and
  OC-REAL-018 PASS (no duplicate child, failed verification left source
  mapping untouched).
- [ ] **BLOCKER 10 — UI state contradicting durable/upstream truth
  (UI-before-log, false idle/terminal)**: not triggered in the executed
  subset, but coverage is PARTIAL so this stays open. Phase 10 verified
  idle/working/failed/unknown and reload persistence truthful against the DB;
  the "composer enabled during working" claim was a false alarm — the durable
  queue contract intends it (OC-REAL-075/090; see
  `artifacts/opencode-real-world/phase-10/RESULTS.md`). The stale-IDLE
  double-admission probe (OC-REAL-099/100) and most of OC-REAL-088–100 were
  not executed.

## Not executed

Phase 13 was executed on 2026-08-28 as an independent reliability
verification (P13-G1–G8): all eight adversarial guarantee re-checks record
PASS against real OpenCode `1.18.18` (G4 pass same-generation on the real
serve; cross-generation fencing remains deterministic-only, unchanged from
Phase 3). P13-G1 attacked the closest achievable OC-REAL-101 window for real
(crash after upstream prompt acceptance, before settle: exactly one POST
across both Polyth lives; the literal "crash before the operation row
persists" is impossible by construction, proven in the same run). Evidence:
`artifacts/opencode-real-world/phase-13/RESULTS.md`. The remaining
OC-REAL-102–112 rows were not run as individually scripted scenarios, and
this phase closes no still-open box above. Phase 3's OC-REAL-047 (SSE
disconnect storm) produced no verdict and may not be cited as evidence for
any box above.
