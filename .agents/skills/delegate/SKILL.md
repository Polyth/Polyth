---
name: delegate
description: Run a task as a cost-aware orchestrator — route each workstream to the smallest adequate favorite harness/model with a deliberate thinking variant, fan out bounded packets, verify evidence and integrate. Use when the user asks to delegate, fan out, use subagents/workers, run cheap or fast, or when a task has several independent workstreams.
---
# Cost-aware delegation

You are the orchestrator. Decompose the work, route each part to the cheapest adequate worker, verify what comes back, integrate it, and own the final claim of what was actually checked. A worker summary is never verification.

This skill owns the model-class and thinking-variant routing policy. The mechanics — workspace isolation, the merge lifecycle, canonical child sessions and child cleanup — stay canonical in [bounded agent orchestration](../../../docs/agents/orchestration.md) and the [orchestration skill](../polyth-orchestration/SKILL.md); read one of them if a rule below is not precise enough.

Hard rule: delegation is owned by Polyth. Create workers only with the Polyth control capability `agent.spawn` — never a harness-native `Agent`/`Task`/`task`/`agent`/`invoke_subagent`/custom-agent surface.

## 1. Decide whether to delegate

Delegate when at least two workstreams are genuinely independent, or a bounded question needs more search than the parent should spend, or parallel writers shorten wall-clock time. Keep it yourself when a single tool call, one file, or one sequential boundary is involved — spawn cost plus a duplicate context read makes that slower and dearer, not cheaper.

Add the orchestration itself to the plan/todo list and keep exactly one item in progress.

## 2. Shortlist the fleet once

Call the Polyth control capability with action `agent.models` exactly once before any spawn (`limit`, `windowDays`, optional `harnessId`). It returns ranked lines `N. ★ <harness> <provider>/<model> (<what an alias runs>) · <turns>t/<sessions>s · <fail>% fail · quota NN%` plus one quota line per source. Models are named as each harness's live catalog names them, and models a harness no longer offers are left out.

- Use the row verbatim: pass its `harnessId` and `model {providerID, modelID}` to `agent.spawn`; never invent or "correct" an id. An alias row such as `anthropic/opus (Claude Opus 5.5)` is passed as `opus`; the name in parentheses only says what it runs today.
- Skip `BLOCKED`/`UNAVAILABLE` rows, and prefer listed rows over `model unverified` ones. The quota figure is the fullest applicable window's used share (lower leaves more headroom): prefer favorites with the most headroom and do not drain an account's last few percent on mechanical work.
- A favorite (`★`) you already run warm is usually the fastest first token.
- If the call says model routing is unavailable, fall back to the user's known favorites or omit `model` for Polyth Auto; never guess a provider/model pair.
- One extra `agent.models` call is allowed after a child fails — but with a different row.

## 3. Route by task class

Match the smallest model that is *adequate*, not the smallest that exists:

| Task class | Model class (from the live shortlist) | Thinking variant | Isolation |
| --- | --- | --- | --- |
| **T0 — discover/extract (read-only):** locate symbols, list consumers, extract doc facts, triage a log, collect test names | cheapest/fastest row with headroom; names hint at the tier (`flash`, `mini`, `lite`, `small`, `nano`, `haiku`, free/local rows) | lowest advertised | `shared` |
| **T1 — bounded implementation:** one package/boundary, named acceptance test | cheapest mid/small favorite that can pass | middle or the model default | `isolated` when writers run in parallel, `shared` when sequential |
| **T2 — consequential reasoning:** shared contracts, authz/Space security, concurrency, migrations, architecture, ambiguous debugging, integration review | strongest available favorite, or keep it in the parent | highest advertised | `shared`, read-only for review |

Name heuristics are a hint, not truth: `pro`/`opus`/`max`/`ultra` usually cost more, but verify against observed turns, failures and quota rather than the label. `agent.models` does not expose price; rank cost by (1) smallest adequate class, (2) quota headroom, (3) turn/failure history, (4) an already-warm harness.

### Thinking effort (`variant`)

`ModelRef.variant` is the only reasoning/thinking field; there is no parallel effort parameter. Levels are model-specific (commonly `low`/`medium`/`high`; some add `off`/`minimal`/`xhigh`/`max`), and the backend applies `defaultVariant` when you omit it.

- Pass `variant` only when that harness+model advertises the level. A level the model does not offer is rejected `invalid-variant`, and the rejection lists the valid levels — treat that list as the discovery step, then reuse it for the rest of the session at no further cost.
- Mechanical work gets the lowest advertised level; hard reasoning and final review get the highest. Do not pay a high level for extraction, and never let a low level make a consequential decision.
- If you do not know the levels, omit `variant` on the first spawn instead of guessing.

## 4. Spawn a bounded packet

One child per write set; never two writers on the same boundary. Give the child facts, not the repository:

```
Goal:        <one sentence>
State:       <branch/HEAD, dirty files it must not touch>
Own skill:   <repo-relative SKILL.md to read>
Files:       <exact paths/symbols>
Writes:      <exact allowed paths>
Must not:    <invariants, contracts, security rules>
Verify:      <one exact command>
Evidence:    status, changed paths, command outcome, unresolved risk
Isolation:   shared | isolated
```

Pass `watchCaller: true` so you are woken once when the child settles. Children return compact evidence and `polyth_peer` observations; never copy transcripts between sessions.

## 5. Drive event-driven, then integrate

- Wait on the `watchCaller` wake or `session.watch` (`events: ["completed","error","aborted"]`). Never poll `session.get` in a loop.
- Message a child with `session.send`; `delivery` picks how it lands on a busy chat: `queue` (default, after its current turn), `interrupt` (stop that turn, run this next) or `steer` (join the running turn). Read bounded state with `session.messages`/`session.debug`; exchange findings with `polyth_peer`.
- Parallel writers get `isolation: "isolated"` with non-overlapping write sets; commit your own overlapping edits before merging.
- Read the actual diff and run the owning check on the **integrated** result — a green child branch is not integrated success.
- Bring every isolated child home with `agent.merge` (`agent.resolve` for conflicts; `agent.discard` only to drop work on purpose). Never finish with unmerged isolated work.
- To keep an existing shared child apart after the fact, `session.isolate` it while it is at rest; it then owes an `agent.merge` like any isolated child.
- Clean up a child that produced no assistant/tool/request evidence and no delivered prompt, per the canonical cleanup rule; preserve and report any child with real evidence or uncertainty.

## Cost and quality controls

- A small model must never guess an unknown contract: one strong turn beats a weak model looping on an interface it cannot see. Route ambiguity upward; route mechanics downward.
- Bound every packet (exact files, owning skill, one verification command). Never paste the repo, full logs or chat history into a child.
- Reuse verified context: hand over facts you already established instead of making the child rediscover them.
- Fan-out width: ≤3 concurrent children by default, ≤6 only for an explicitly max-effort task. When two children disagree, consolidate instead of adding a third.
- On a stall, error or unusable result: `session.cancel`, pick a different row, spawn a replacement. Never retry the same failing harness/model pair, and never silently downgrade a consequential task to a cheaper model.
- Raise the parent's own effort only for the decisions that matter; delegate the rest.
- When you finish, report the spend signals: children created, their harness/model/variant, cancellations, which results were merged, and what each verification actually covered.
