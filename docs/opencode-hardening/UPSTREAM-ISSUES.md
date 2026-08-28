# OpenCode validation failure classification

Validated against OpenCode CLI `1.18.18` on 2026-08-28. This ledger classifies
unique failures and concrete contract gaps from the canonical Phase 1–9 results
and final verdicts. Superseded attempts are not counted again. A blocked or
partial scenario is included only when it established a concrete failure or
contract gap.

## Counts

| Class | Unique findings |
| --- | ---: |
| POLYTH BUG | 22 |
| OPENCODE BUG | 4 |
| PROTOCOL AMBIGUITY | 6 |
| ENVIRONMENT | 3 |
| TEST HARNESS BUG | 3 |
| **Total** | **38** |

## Classification ledger

| ID | Class | Finding | Evidence / current state |
| --- | --- | --- | --- |
| C01 | POLYTH BUG | Owned-local occupied ports are not classified and retried. | OC-REAL-001; `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-001/verdict.json`. Open. |
| C02 | POLYTH BUG | Revision-less legacy terminal events are rejected after the first accepted terminal observation, so a session's second turn never emits `turn/stopped` and queues wedge. This subsumes the stale ENV attribution on OC-REAL-037 and the terminalization arms of OC-REAL-017/020/021/022/044/072/073/075/076/086. | `docs/opencode-hardening/FAILURE-REPORT-LEGACY-TERMINALIZATION.md`; Phase 7 `RESULTS.md`. Open; Polyth fails closed (`unknown`/`working`) and does not replay mutations, but does not recover. |
| C03 | POLYTH BUG | A genuine managed config write reserializes JSONC as strict JSON and loses comments. | OC-REAL-025; `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-025/verdict.json`. Known limitation. |
| C04 | POLYTH BUG | V2 history/hydration/reconciliation request `limit=1000`, above OpenCode's live cap. | OC-REAL-032/033 and Phase 5; `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`. Open; request fails explicitly without fallback. |
| C05 | POLYTH BUG | The normal runtime-pool facade does not forward `protocol()`, persisting V2 bindings as legacy. | OC-REAL-026; `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`. Open; send is rejected while state is unknown. |
| C06 | POLYTH BUG | Product composition cannot select the working borrowed/shared endpoint seam. | OC-REAL-030/031/062/063; Phase 5 `RESULTS.md`. Open; normal boot returns 503 and does not kill the shared service. |
| C07 | POLYTH BUG | A successful but transient empty V2 model catalog is accepted as authoritative before service readiness stabilizes. | OC-REAL-026/033; `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`. Open in that run; later BLOCKER 0 evidence must not be generalized to full V2 readiness. |
| C08 | POLYTH BUG | V2 facade capability flags overclaim unavailable streaming/attention/compact/subagent/steer behavior. | OC-REAL-033; `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`. Open; unavailable calls return explicit errors. |
| C09 | POLYTH BUG | Out-of-root V2 attachments are silently omitted instead of rejected before I/O. | OC-REAL-033 execution notes; `artifacts/opencode-real-world/phase-1-v2/RESULTS.md`. Open; no traversal bytes were sent. |
| C10 | POLYTH BUG | Pull recovery can append repeated revisions of the same assistant/tool fact as multiple canonical facts. | OC-REAL-041; `artifacts/opencode-real-world/phase-3/OC-REAL-041/details.json`. Open; the prompt and side effect remained single. |
| C11 | POLYTH BUG | Duplicate SSE delivery with changed transport IDs is not semantically deduplicated and produces duplicate assistant facts plus ingestion errors. | OC-REAL-045; `artifacts/opencode-real-world/phase-3/OC-REAL-045/details.json`. Open; one prompt POST, but duplicate model-visible facts. |
| C12 | POLYTH BUG | A raced child-exit notification could leave an owned lease handing out a known-dead endpoint forever. | OC-REAL-059; Phase 4 `RESULTS.md`. **Fixed and rerun** with regression coverage. |
| C13 | POLYTH BUG | Per-boot random owned authority invalidated persisted bindings after Polyth restart. | Original OC-REAL-060/061 verdicts. **Fixed and rerun**; `OC-REAL-060-RERUN` and `OC-REAL-061-RERUN` pass. |
| C14 | POLYTH BUG | A newly constructed borrowed lease resets generation and can launder a stale generation-only binding. | OC-REAL-064; `artifacts/opencode-real-world/phase-5/RESULTS.md`. Open; a continuously alive lease fences it correctly. |
| C15 | POLYTH BUG | Shared-session history/reconcile hides durable admissions made by other clients. | OC-REAL-067; `artifacts/opencode-real-world/phase-5/RESULTS.md`. Open; no duplicate mutation was observed. |
| C16 | POLYTH BUG | Removing one endpoint's colliding backend session ID removes another endpoint's canonical mapping. | OC-REAL-069; `artifacts/opencode-real-world/phase-6/RESULTS.md`. Open; observed damage self-healed without a cross-endpoint leak. |
| C17 | POLYTH BUG | A new session can report a deleted but unpruned worktree as `ready` because stale git listing and runtime reuse outrank filesystem truth. | OC-REAL-071; Phase 6 `RESULTS.md`. Open; model work fails truthfully in the deleted cwd. |
| C18 | POLYTH BUG | Post-fork reverse mapping loss makes the child an unmapped SSE target. | OC-REAL-072; `artifacts/opencode-real-world/phase-6/OC-REAL-072/verdict.json`. Open; no cross-tree leak. |
| C19 | POLYTH BUG | Sessions do not re-verify and recover after endpoint generation rotation. | OC-REAL-072; Phase 6 `RESULTS.md`. Open; Polyth settles `unknown` and rejects later sends rather than guessing continuity. |
| C20 | POLYTH BUG | SSH occupied-port failures are not recognized, so the next remote port candidate is never tried. | OC-REAL-078; `artifacts/opencode-real-world/phase-8/OC-REAL-078/verdict.json`. Open. |
| C21 | POLYTH BUG | SSH ControlMaster loss couples the forward and remote child lifecycle, replacing the whole generation and preventing active-session/history recovery. | OC-REAL-079–082; Phase 8 `RESULTS.md`. Open; no duplicate prompt or local fallback occurred. |
| C22 | POLYTH BUG | SSH-owned authority/generation is not durable across Polyth restart. | OC-REAL-083; Phase 8 `RESULTS.md`. Open; intent survives once, but first wire fails `binding-mismatch`. |
| C23 | OPENCODE BUG | `read` on a nonexistent path remains running indefinitely. | OC-REAL-021; detailed upstream issue U1. |
| C24 | OPENCODE BUG | Aborting a running bash tool records it as `completed` with `exit:null`. | OC-REAL-017/022; detailed upstream issue U2. |
| C25 | OPENCODE BUG | `ProviderModelNotFoundError` exposes internal bun bundle stack frames to clients. | OC-REAL-021; detailed upstream issue U3. |
| C26 | OPENCODE BUG | A client-supplied session ID collision crosses project directory boundaries and returns the first project's session with HTTP 200. | OC-REAL-066; detailed upstream issue U4. |
| C27 | PROTOCOL AMBIGUITY | Legacy `session.idle`, `session.error`, and `session.status` have no comparable order, while `/session/status` lists only busy sessions. The protocol cannot distinguish a current terminal from a stale one after reconnect. | OC-REAL-020/023/044; failure report F1. Polyth's unsafe-loss avoidance is correct, but its permanent wedge is C02. |
| C28 | PROTOCOL AMBIGUITY | Legacy create/prompt records do not echo the supplied operation ID or another exact mutation receipt, so a committed response-loss outcome cannot later be proven. | OC-REAL-005/034–040; Phase 2 `RESULTS.md`. Polyth retains `unknown` and never retries. |
| C29 | PROTOCOL AMBIGUITY | OpenCode exposes no authoritative shared-service descriptor carrying URL, auth, instance identity, ownership, and continuity. | OC-REAL-027–031/062–065; Phase 5 `RESULTS.md`. Borrowed probes are not product acceptance. |
| C30 | PROTOCOL AMBIGUITY | V2 event replay declares `after` as a string but accepts an integer aggregate sequence, and SSE carries JSON event IDs without wire-level `id:`. | Phase 1 V2 API observations; `artifacts/opencode-real-world/phase-1-v2/OPENCODE-API-SURFACE.md`. |
| C31 | PROTOCOL AMBIGUITY | OpenCode rewrites file prompt parts into synthetic user text in durable history, so canonical exact-prefix fork verification has no stable representation to compare. | OC-REAL-072; Phase 6 `RESULTS.md`. Polyth rejects `history-mismatch`; it does not create an approximate child. |
| C32 | PROTOCOL AMBIGUITY | Occupied-port startup reports generic `ServeError` rather than a stable bind-error code. | OC-REAL-001/030/078; Phase 1 V2 observations. Polyth's missing local/SSH classifications remain C01/C20. |
| C33 | ENVIRONMENT | Free-tier quotas and provider/model behavior prevented some agent loops and one `text/plain` attachment-consumption proof. | OC-REAL-015/016, Phase 1 V2 execution notes, OC-REAL-078. Retried coverage is not counted as a Polyth failure. |
| C34 | ENVIRONMENT | Schema-invalid `opencode.json` MCP transport values prevent `opencode serve` from starting. | Failure report F5 / OC-REAL-025 setup. This is an input constraint, not evidence that unknown valid fields are unsafe. |
| C35 | ENVIRONMENT | No external SSH host was available; Phase 8 used a real localhost `sshd`, sharing the VM kernel/filesystem. | Phase 8 `RESULTS.md`. Remote process and TCP paths were real, but host-separation coverage remains absent. |
| C36 | TEST HARNESS BUG | `fakeOpenCode.finishTurn()` invented `properties.revision`, masking the real revision-less legacy terminal contract. | Failure report F1. Deterministic terminalization tests were not representative of OpenCode `1.18.18`. |
| C37 | TEST HARNESS BUG | OC-REAL-046's fail predicate was confounded: delayed old frames changed no durable tool events, while the rank regression already existed in the pre-release duplicate sequence; cross-generation fencing was not executed live. | `artifacts/opencode-real-world/phase-3/OC-REAL-046/details.json` and `verdict.json`. Treat the target as partial, not an independent Polyth failure; the duplicate-fact defect is C10/C11. |
| C38 | TEST HARNESS BUG | OC-REAL-080 dropped SSH after a confirmed response instead of between upstream acceptance and response bytes, so its narrower response-loss boundary was not exercised. | Phase 8 `RESULTS.md`. The broader post-accept recovery failure remains C21. |

## Genuine OpenCode issues

These are suitable for upstream reporting. They contain no workaround that
weakens mutation, continuity, path, or process-ownership safety.

### U1 — nonexistent-file `read` never terminalizes

- **Class:** OPENCODE BUG
- **Version:** `1.18.18`
- **Minimal reproduction:** run
  `node scripts/opencode-real-world/probe_readhang.ts`; it starts a real server,
  prompts the model to use `read` on `/nonexistent/missing-probe.txt`, and waits
  for a tool error or terminal event.
- **Observed:** the tool remains `running` for 90–120+ seconds with no error part
  and no `session.idle`.
- **Evidence:** `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-021/failure-modes.json`.
- **Polyth graceful failure:** **Partly.** It does not claim completion or replay
  the prompt, but the upstream session remains genuinely busy and cannot
  recover.

### U2 — aborted running bash tool is reported completed

- **Class:** OPENCODE BUG
- **Version:** `1.18.18`
- **Minimal reproduction:** run
  `node scripts/opencode-real-world/s017.ts` (abort matrix) or
  `node scripts/opencode-real-world/s022_023.ts`; start a delayed bash tool,
  abort while it is running, then inspect the durable tool part.
- **Observed:** `state.status` is `completed`, `metadata.exit` is `null`, output
  says `User aborted the command`, and the intended side effect did not occur.
- **Evidence:** `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-022/interruption.json`
  (`killedBashCase`) and OC-REAL-017's abort matrix.
- **Polyth graceful failure:** **No for presentation semantics.** Polyth makes
  one abort attempt and keeps unresolved attention artifacts explicit, but the
  upstream terminal rank itself falsely says completed. The separate missing
  `turn/stopped` behavior is Polyth bug C02.

### U3 — provider model error leaks internal bun stack

- **Class:** OPENCODE BUG
- **Version:** `1.18.18`
- **Minimal reproduction:** run `node scripts/opencode-real-world/s021.ts` and
  submit a prompt with its deliberately nonexistent model ID; inspect
  `session.error`.
- **Observed:** `ProviderModelNotFoundError` contains `/$bunfs/root/chunk-*.js`
  internal stack frames.
- **Evidence:** `artifacts/opencode-real-world/phase-1-legacy/OC-REAL-021/failure-modes.json`
  (`modelError.rawSessionError`).
- **Polyth graceful failure:** **Partly.** The error is durably represented and
  the injected API key is not leaked, but the unbounded upstream stack payload
  reaches the adapter and legacy error terminalization also hits C02.

### U4 — client-supplied session IDs cross project locations

- **Class:** OPENCODE BUG
- **Version:** `1.18.18`
- **Minimal reproduction:** run
  `node artifacts/opencode-real-world/phase-5/tools/run-phase-5.mjs` and inspect
  OC-REAL-066; against one V2 service, create the same explicit session ID first
  with project A's directory and then project B's directory, then GET it with
  project B's directory.
- **Observed:** project B receives project A's session and location with HTTP
  200. Ordinary non-colliding root/worktree catalogs remain isolated.
- **Evidence:** `artifacts/opencode-real-world/phase-5/OC-REAL-066/verdict.json`
  plus its adjacent `details.json`.
- **Polyth graceful failure:** **Not reachable in normal product composition.**
  The borrowed-seam probe exposed the upstream cross-location collision; normal
  Polyth still cannot attach to the shared service (C06). No cross-location
  mutation should be enabled as a workaround.

## Non-issues and superseded claims

- The pre-Blocker-0 claim that V2 core methods are permanent stubs is
  superseded. Native V2 model/session/prompt routes were exercised.
- OpenCode rejecting `limit=1000` is not an upstream bug; Polyth must honor the
  advertised/live maximum (C04). Phase 5 observed a stricter cap of 100, so the
  client should paginate rather than pin another oversized constant.
- Unknown or unregistered V2 paths returning SPA HTML are poor API ergonomics,
  but the campaign did not establish a normative OpenCode error contract. They
  are not counted as genuine upstream bugs.
- OC-REAL-037 is not retained as ENVIRONMENT: Phase 7 tied it to C02.
- The original OC-REAL-060/061 failures are historical fixed Polyth bugs; the
  targeted reruns pass. No release blocker is marked complete by this ledger.
