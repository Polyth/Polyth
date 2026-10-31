# Bounded agent orchestration

Delegation is optional. One agent is often best for a local fix. Use a separate explorer for a difficult bounded question, implementers for independent write sets, and a verifier for consequential changes. Model names, subscriptions and capabilities change; inspect what is available rather than pinning a speculative model identifier in repository rules.

## Canonical delegation

Every delegated worker in Polyth is a canonical child session. Harness-native `Agent`, `Task`, `task`, `invoke_subagent`, custom-agent or equivalent spawn paths are not the product orchestration surface. Use the Polyth control capability with `agent.spawn`; the created session carries `parentId`, appears in the session tree, inherits normal authorization/recovery rules, and can itself spawn another canonical child.

The harness runtime layer forces native subagent capability reporting off and hides native-only subagent descriptors. Adapters additionally disable or block native delegation where their public integration surface permits it. Harnesses without a provider-level disable switch still receive the mandatory Polyth delegation instruction; do not claim stronger structural enforcement than that provider exposes.

## Choosing the worker model

Call the control capability's `agent.models` action once before `agent.spawn`. It returns a few plain lines, about 350 tokens for 12 rows. Each candidate line shows harness, provider/model, ★ favorite, turns/sessions and failure share over 30 days, its worst live quota fraction, and `BLOCKED`/`UNAVAILABLE`. Models are named as each harness's live catalog names them, so the id is one `agent.spawn` accepts: Claude Code's alias `anthropic/opus (Claude Opus 5.5)`, never the `claude-opus-5-5` its turns report. Models a harness no longer offers are left out, with a count. One line per quota source follows with its windows and resets. Pass the chosen row's `harnessId` and `model` to `agent.spawn` exactly. Optional `harnessId`, `limit` (default 12, max 50) and `windowDays` (default 30) narrow it. The data is Polyth's own: the account's synced model-picker favorites, the Usage analytics index, the Limits poller's cached snapshots and the server's harness model catalog, re-read through the harness registry when its copy is older than a minute. The call never runs a model turn or a quota request. Ranking and quota rules are documented in [the Usage package README](../../packages/usage/README.md#delegation-shortlist).

The per-task model class and thinking-variant routing policy (mechanical work to the cheapest adequate model and lowest advertised level, consequential work upward) lives in the [cost-aware delegation skill](../../.agents/skills/delegate/SKILL.md).

## Choosing the worker's workspace

Decide per child with `agent.spawn` `isolation`:

- `shared` (default): the child runs in the delegator's checkout, sees its uncommitted files and writes straight into them. Use it for read-only exploration and review, small sequential edits, and work that needs uncommitted context.
- `isolated`: Polyth gives the child its own managed Git worktree (`polyth/isolate/<id>`) branched from the delegator's last commit, with merge-back pointed at the delegator's checkout. Use it for parallel implementers whose write sets could collide, risky or experimental changes, and work that may be thrown away. When the delegator itself runs in an isolated checkout (or shares one as a child), the new child nests inside it: its merge lands on that isolate branch and reaches the project branch only through the owner's own merge.

An isolated spawn returns the worktree, branch and merge target, reports how many uncommitted delegator files the child cannot see, and arms a one-shot completion wake unless `watchCaller=false`.

A person may pause a child from the subagent list. The delegator is woken with `paused` (the watch stays armed), sees `paused: true` in `session.get`, and must not message, replace or restart that child: only the person continues or stops it ([watch semantics](architecture.md)).

`session.isolate` (`sessionId`) moves an existing chat at rest into isolation after the fact, for example a shared child that should be kept apart before parallel or risky edits. It runs the same Git-owned flow as the session menu's **Move to isolated workspace** (see [workspace isolation](../dev/workspace.md#mutation-release-and-recovery)), through the acting person's scoped sessions. The rules:

- A running, archived or already isolated chat is refused, and so are a people-only conversation and the caller's own running session.
- The worktree branches from the last commit of the checkout the chat worked in, and merge-back returns there.
- Uncommitted files stay behind; the result reports how many as `uncommittedLeftBehind`.
- A child that worked in the delegator's checkout becomes an ordinary isolated child of the delegator, with the same `agent.merge` duty and merge reminder. Any other chat returns its work through its own isolation card.

## Integration duty

The delegator owns integration of every isolated child. `agent.list` reports each child's workspace, isolation state and whether it still holds unmerged work. `agent.merge` squashes a settled child's work into the delegator's checkout as one commit and releases its worktree; a child without changes is only released. It never prepares an AI repair of the delegator's uncommitted work: overlapping uncommitted edits are refused (`reason: "target-overlap"`) so the delegator can commit first. A content conflict leaves the child isolated with the conflicting paths; `agent.resolve` asks the child to merge the delegator's latest work and fix them, and wakes the delegator when it ends. `agent.discard` drops an isolated child on purpose (`force=true` while it still has changes).

Polyth enforces the duty in three places:

- A delegator that completes a turn while all its isolated children have settled and one still holds an isolation record is woken once with the pending list. Each distinct pending state reminds at most once; aborted or failed turns and still-running children never trigger it.
- The control tool refuses to archive an isolated child that still holds work.
- A managed checkout cannot merge, discard or be deleted while a delegated isolation still merges into it; its isolation status lists those children as `delegated` and the isolation card links to them. Lifecycle details: [workspace isolation](../dev/workspace.md#delegated-isolation).

## Task packet

Give each worker the requested behavior, baseline/dirty scope, owning skill, key files/symbols, constraints, allowed write paths, expected integration contract and verification requirements. Include only relevant evidence; do not broadcast the whole repo, logs or chat. A worker must verify an assumption before turning it into code.

## Ownership and integration

No two workers edit the same boundary concurrently without explicit coordination. A shared DTO/export/schema has one owner; dependents consume the reviewed change. Do not use hidden stashes or destructive git cleanup. After merging work, inspect the combined diff and re-run checks affected by integration. Branch-local success is not integrated success.

## Efficient reporting

Return status, changed paths, observed mechanism, test commands/outcomes and unresolved risk. Keep raw logs with the executor unless a small redacted excerpt is needed. Compress repeated context, not evidence. An expensive model should make consequential decisions, not repeatedly rediscover a documented package entry; a cheaper model should never be asked to guess an unknown contract.

The phrase “ponytail extreme,” when used by the task owner, should mean this concrete operating discipline: bounded reads, reused verified context, minimal duplication, deliberate delegation and evidence-based stopping. It is not a provider setting or an excuse to omit verification.

## Review honesty

A verifier reads actual source/diff and outcomes, not just summaries. If a separate agent is unavailable, label self-review honestly. Read-only roles may be unable to run tests that write artifacts. Do not fabricate a subagent run, external check or future background completion. Long tasks should leave a concise durable handoff with exact state and next verification point.
