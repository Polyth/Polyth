---
name: delegate
description: Run a task as a cost-aware orchestrator — route each workstream to the smallest adequate favorite harness/model with a deliberate thinking variant, fan out bounded packets, verify evidence and integrate. Use when the user asks to delegate, fan out, use subagents/workers, run cheap or fast, or when a task has several independent workstreams.
---
# Cost-aware delegation

You are the orchestrator. Decompose the work, route each part to the cheapest adequate worker, verify what comes back, integrate it, and own the final claim of what was actually checked. A worker summary is never verification.

This skill owns the model-class and thinking-variant routing policy. The mechanics — workspace isolation, the merge lifecycle, canonical child sessions and child cleanup — stay canonical in [bounded agent orchestration](../../../docs/agents/orchestration.md) and the [orchestration skill](../polyth-orchestration/SKILL.md); read one of them if a rule below is not precise enough.

Hard rule: delegation is owned by Polyth. Create workers only with the Polyth control capability `agent.spawn` — never a harness-native `Agent`/`Task`/`task`/`agent`/`invoke_subagent`/custom-agent surface.

## 1. Decide whether to delegate

What a worker costs is its context size multiplied by its model calls, not its answer: over 723 delegated sessions measured on 2026-11-23, 97% of all tokens were the context being read again on each call and under 1% were output. A child starts at 30–45k tokens before it does anything, and the sessions that delegated recorded about twice the spend of all their children together. So the saving is whatever bulky work stays out of the parent, and the waste is anything read twice.

- Delegate when the next step needs about eight or more tool calls or produces bulky raw output (search, logs, test loops, screenshots), when at least two workstreams are independent, or when parallel writers shorten wall-clock time.
- Keep it yourself when it is a single tool call, one file or one sequential boundary: the child's start-up context plus your packet and its report cost more than the work.
- Never repeat a worker's search in the parent. Check only what your decision rests on, by reading narrow line ranges.

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

What the same history shows about routing (same date; the classes did not receive the same tasks, so read it as cost and reliability, not as a quality ranking):

- Top-tier workers were a fifth of the children and four fifths of the recorded child spend; a median top-tier child cost about eight times a mid-tier one and was sent a follow-up message more often (30% of them against 19%). Use the top tier as a worker only for T2, preferably as a read-only reviewer of a finished diff, and give T1 to the mid tier by default.
- Nine of ten children that stopped on an error stopped on a rate or quota limit, not on bad work, and a quarter of the top-tier children hit one. Read the quota lines before every fan-out, spread children across providers, and do not put more than two children on one 5-hour window that is already above half.
- Skip a row whose 30-day failure share is 30% or more while another adequate row exists.

Name heuristics are a hint, not truth: `pro`/`opus`/`max`/`ultra` usually cost more, but verify against observed turns, failures and quota rather than the label. `agent.models` does not expose price; rank cost by (1) smallest adequate class, (2) quota headroom, (3) turn/failure history, (4) an already-warm harness.

### Thinking effort (`variant`)

`ModelRef.variant` is the only reasoning/thinking field; there is no parallel effort parameter. Levels are model-specific (commonly `low`/`medium`/`high`; some add `off`/`minimal`/`xhigh`/`max`), and the backend applies `defaultVariant` when you omit it.

- Pass `variant` only when that harness+model advertises the level. A level the model does not offer is rejected `invalid-variant`, and the rejection lists the valid levels — treat that list as the discovery step, then reuse it for the rest of the session at no further cost.
- Mechanical work gets the lowest advertised level; hard reasoning and final review get the highest. Do not pay a high level for extraction, and never let a low level make a consequential decision.
- If you do not know the levels, omit `variant` on the first spawn instead of guessing.

## 4. Spawn a bounded packet

One child per write set; never two writers on the same boundary. Give the child facts, not the repository. Packet length did not predict whether a child needed a follow-up; these fields did:

```
Goal:      <one sentence, and the observable result that means done>
State:     <branch/HEAD, dirty files it must not touch>
Facts:     <path:line — what you already located; the child does not search for these again>
Read:      <exact files, line ranges, and doc sections by heading; own skill: repo-relative SKILL.md>
Writes:    <exact allowed paths, or "read-only">
Must not:  <invariants, contracts, security rules>
Verify:    <one exact command per touched package, memory-capped, under 10 minutes>
Stop:      <when to stop: the question answered / the check green / N tool calls spent; blocked or missing a permission → report, do not explore or wait>
Report:    <at most 40 lines of `path:line — fact`, changed paths, command outcome, unresolved risk; longer material in .scratch/<task>/<name>.md, return its path>
Isolation: shared | isolated
```

End every packet with these standing lines:

- Bound every command's output (`rg -n --max-count`, `sed -n 'a,bp'`, `| head -n 60`, `git diff --stat` before a full diff) and read line ranges, not whole files. One call in eight produced about two thirds of all tool output in the measured sessions, and all of it is read again on every later call.
- Read the named section of a large guide, never the whole file: `docs/dev/ui.md` alone is over 100k tokens.
- Do not spawn subagents. Run heavy checks one at a time through the shared lock and memory cap ([bounded verification](../../../docs/agents/verification.md#bounded-local-verification)); no single command may run over 10 minutes.
- Parallel isolated children never write a shared document: return the text in the report and the parent adds it after merging.

Over half of every worker's shell calls were search and file reads, at any model tier. `Facts` and `Read` are what remove them. When you have not located the code yourself, do not pay an implementer to find it: send a T0 scout first, have it write `.scratch/<task>/map.md` (at most 60 lines of `path:line — fact`), and give the implementer that path in `Read`. The map goes from worker to worker without passing through your context; you read only the lines your decision needs.

When parallel children share a contract (a DTO, a route, a document format), write and commit it yourself before spawning them.

Pass `watchCaller: true` so you are woken when the child's turn ends. Children return compact evidence and `polyth_peer` observations; never copy transcripts between sessions.

## 5. Drive event-driven, then integrate

- Wait on the `watchCaller` wake or `session.watch` (`events: ["completed","error","aborted"]`). Never poll `session.get` in a loop.
- After the first spawn of a fan-out, check that child once with `session.debug` (working, no recent errors) before spawning the rest: a returned session id does not prove the worker started.
- A wake means a turn ended, not that the task is done. Read the child's last message; if it is not the report, re-arm with `session.watch` and do not merge, because merging removes a worktree its background checks may still use.
- Message a child with `session.send`; `delivery` picks how it lands on a busy chat: `queue` (default, after its current turn), `interrupt` (stop that turn, run this next) or `steer` (join the running turn). Read bounded state with `session.messages`/`session.debug`; exchange findings with `polyth_peer`.
- Parallel writers get `isolation: "isolated"` with non-overlapping write sets; commit your own overlapping edits before merging.
- Read the actual diff and run the owning check on the **integrated** result — a green child branch is not integrated success.
- Bring every isolated child home with `agent.merge` (`agent.resolve` for conflicts; `agent.discard` only to drop work on purpose). Never finish with unmerged isolated work.
- A child that changes visible UI returns its `.scratch/` screenshot paths. Before its `agent.merge`, look at them and run `node scripts/pr-screenshots.mjs adopt <child-worktree>`: the child's workspace and gitignored `.scratch/` go away with the merge, and the adopted copies are what your pull request attaches ([screenshots in pull requests](../../../docs/agents/verification.md#screenshots-in-pull-requests)).
- To keep an existing shared child apart after the fact, `session.isolate` it while it is at rest; it then owes an `agent.merge` like any isolated child.
- Clean up a child that produced no assistant/tool/request evidence and no delivered prompt, per the canonical cleanup rule; preserve and report any child with real evidence or uncertainty.

## 6. Check the result, cheapest check first

A worker's "all green" covers only the checks it chose. Run the gates in this order and stop at the first that fails:

1. **Deterministic guards, run by the parent.** `git diff --stat` stays inside the write set; no weakened assertions (`git diff -- '*.test.*'` for loosened patterns, deleted cases, `skip`); the full test directory of every touched package, plus the host suite for UI work; for added CSS, every `var(--x)` has a definition. For a mechanical sweep, state the guard in the packet (for example "every removed line contains the label").
2. **Diff review by the parent** for T1: every hunk, against the packet's `Must not`.
3. **An independent read-only reviewer** only for T2 or a diff too large to read: a different model family from the author, given the diff range, the contract and the `Must not` list, not the history. It returns findings as `- [blocker] path:line — what is wrong and what done looks like` or `- [note] …`, then one last line `Verdict: approved` or `Verdict: changes requested` (the format the workflow engine's review loop reads).

Rounds:

- Send blockers back to the **same** child session with `session.send`: its context is already paid for, and a fresh child would read everything again. Send only the findings and the failing output, a few lines each.
- At most two rounds. A child that fails the same gate twice does not get a third: take the remaining fix yourself or reroute it one class up with the findings as `Facts`. Never rerun the same harness/model pair after an error stop, and never silently move a consequential task to a cheaper model.
- A visible UI change is not accepted on tests: look at its before/after screenshots.

## Cost and quality controls

- A small model must never guess an unknown contract: one strong turn beats a weak model looping on an interface it cannot see. Route ambiguity upward; route mechanics downward.
- Reuse verified context: hand over facts you already established instead of making the child rediscover them. Never paste the repo, full logs or chat history into a child.
- Fan-out width: ≤3 concurrent children by default, ≤6 only for an explicitly max-effort task. When two children disagree, consolidate instead of adding a third.
- Make long work resumable: one output file per chunk, so a quota stop loses nothing.
- Raise the parent's own effort only for the decisions that matter; delegate the rest.
- When you finish, report the spend signals: children created, their harness/model/variant, cancellations, rounds, which results were merged, and what each verification actually covered.

## What this cannot promise

No routing rule makes a worker's result flawless, and Polyth records no per-child quality outcome (accepted as delivered, accepted after rework, discarded), so the routing above rests on cost, failure and follow-up counts plus reviewed samples. Quality comes from the gates in section 6, and those cost tokens: delegation lowers the cost of a unit of work only where it removes repeated reading, unbounded output, failed starts and top-tier workers on mechanical work. For T2 work the cheaper option is usually one strong session, not a pipeline.
