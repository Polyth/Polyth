# Workflow presets

A workflow is a small team of agents arranged in a flow. Normal composer Send
always uses the conversation's current route. The composer Workflow action opens
one compact anchored picker rather than a large window: the first prioritized
project workflows are immediately runnable, `More` reveals the next choices, and
`Open workflow builder` moves to the full editor. Launching keeps chat usable.

## Presets and customization

The bundled catalog contains Build + Review, Development, Parallel
Development, Visual Development, Backend, Research, and Review. There is no
single-agent template: one agent is an ordinary chat, not a workflow. An old
run or preference that names the removed `simple` template keeps its recorded
definition; the id itself no longer resolves. A workflow is
the way a chat works with its agents, so everything in the library is a
template: one "Templates" list with a search — the project's own templates
first, then the bundled ones — where every card looks and acts the same (open,
or copy into an editable copy). A template has no run status of its own; a
run, and whether it failed, belongs to the chat that ran it. A category is
still stored on a definition (`WorkflowDto.category`, used by preference
ordering) but no longer appears in the UI. Pinned, selected, and recent
workflows take priority in the composer picker.

Built-ins are canonical, versioned definitions. Use runs a built-in directly;
Customize creates a user-owned copy. Older seeded examples remain ordinary
editable workflows. Updating Polyth can improve built-ins without replacing
customized copies. The one thing a project can change on a built-in in place
is a unit's route, through a fix kept for future runs (see "Fixing a unit
while the run waits"): the workflow store keeps it as `routes[templateId][nodeId]`
and `WorkflowService.withRoutes` lays it over the bundled definition for the
list endpoint, `GET /api/workflows/:id` and every run, so prompts and the graph
still follow the bundled version. A blank workflow begins with one agent.

Each node has a role, instructions, and optional harness/model assignment.
When launched from Chat, wholly unassigned nodes capture the current chat
model, harness, and agent as their default; an explicit node assignment always
wins. A node is either **Auto** or **Model**: Auto stores an allow-list
(`allowedModels`), and the run resolves the node at launch — the inherited
chat model while it is allowed and compatible with the node's harness, otherwise
the first allowed entry. An empty list means "any model"; when a node pins a
harness different from the parent chat route, the inherited model is omitted so
the selected harness chooses its own default. If an API-authored or older Auto
node also has `model`, launch ignores that stale pin. Model pins one model.
Selecting Auto clears an earlier pin; changing the harness clears its old
allow-list. The Auto allow-list is the composer's model picker in its
multi-select mode (capped at 24). The builder and retry controls use the
composer's model picker and
`modelPicker.header`
harness picker; both read the shared, cached runtime catalog, so selecting
a known node harness never starts a native probe. Unavailable assignments
remain visible for replacement instead of silently switching providers. Auto
routing does not leave an unresolved pinned highlight: its enabled harness
entries remain rendered and keyboard-enterable until a runtime resolves a
target or the user chooses one.
Execution profiles (`WorkflowDto.profile`) are a retained, ignored field: the
builder no longer offers them, and a saved value changes nothing at run time.

Each node has a kind: **Lead** (plans and allocates, never reworked),
**Worker** (executes) or **Reviewer** (a gate, see "Review loop"). The kind
select in the inspector explains the gate; the canvas marks a reviewer with
"Can send work back".

Parallel groups display ordinary nodes and dependency edges. Each member still
has its own canonical child session, result, and failure. Desktop arranges the
flow automatically; narrow layouts use a vertical structure and a shared mobile
inspector. Editing keeps dependencies valid and offers explicit actions that do
not depend on dragging. On coarse pointers, inspector move/delete actions are
distinct 44px controls rather than overlapping glyph hit areas. RTL layouts
reverse horizontal flow arrows; compact layouts retain vertical flow. The phone
launcher remains an anchored,
keyboard-aware popover; its short list scrolls internally so More and the
builder action stay reachable.

The surface has two pages. It opens on the library: search, New workflow and
the Templates list, each entry a compact card (graph glyph, name,
description, agent and stage counts and a copy action; the role chain is only a
tooltip). A bundled example keeps its stored "Example · " name but the card
shows an Example badge instead, with the sample catalog's description when the
stored workflow has none. Choosing a card opens that workflow's page, which
replaces the library; its back button returns. Opening the surface from a run
(View workflow) or from the composer with a workflow lands on that page.

A workflow page has Run and Edit tabs. Run holds the request form, the open
chat's latest run of the workflow (never another chat's) and collapsed run Options (approvals, review rounds,
parallel agents, timeout); Edit holds the pipeline, inspector and Details
(description). The latest run renders as the run's own stages: one row per
unit with its status, a "Round n" badge once a review sent work back, an
Approved / Changes requested badge on reviews, the roles a review sent work
back to, and the unit's report folded under a disclosure. Saved workflows and
templates open on Run; a new blank workflow or a copy opens on Edit. Templates
are read-only: the header and Edit tab offer Customize, which creates an
editable copy. Undo retains up to 50 local edits for the selected workflow and
survives autosave acknowledgements; switching workflows resets it. Leaving a
page with pending edits saves them at once; edits that cannot be saved
(an empty name or role) ask before they are discarded. View workflow on a run
brings that run into view once.

## Chat execution

The composer picker uses the current request and its attachments. Existing
message actions can send a user request or assistant result to a workflow.
The server assembles bounded context from effective canonical history. Entry
agents receive that shared context; downstream agents receive dependency
outputs. Raw tool histories and secret events are not workflow context.

Every execution unit receives a completion handoff requirement, including
older saved workflows: finish the unit's authorized work, report actual checks
and outcomes, and identify unresolved requirements. The Build & Review example
asks the Reviewer and Verifier to send unmet findings back to the Builder and
the Finalizer to resolve anything still open after those rounds and rerun
checks after its last edit. A worker's completed turn is execution evidence,
not proof that the requested behavior is correct.

### Review loop

A node of kind `review` is a gate, not just another report. Its prompt always
ends with the `# Review verdict` requirement (`buildNodePrompt` appends it, so
older saved reviews get it too): request changes only for concrete, actionable
findings and finish with exactly one line, `Verdict: approved` or
`Verdict: changes requested`. `parseReviewVerdict` reads the last such line
(markdown emphasis, list markers, a trailing period and "not approved" are
handled); a report without a readable verdict never sends work back.

After each stage settles, `reviewLoop` in `packages/workflow/src/index.ts`
looks at every review in that stage whose verdict is `changes-requested`:

1. Its **rework targets** are its direct dependencies that execute
   (`reworkTargets`: kind `worker` or untagged; leads and other reviews are
   never reworked). No targets, no loop — the Review preset (review → verify)
   simply reports.
2. Each target re-runs as a **follow-up turn in its own child session**
   (`RunNodeContext.resumeSessionId`); the runner reads the child's newest
   event sequence first so earlier turns cannot be mistaken for the new one,
   and falls back to a fresh child (re-briefed, with its previous report) only
   when the session cannot be reached. The follow-up carries the review
   findings (`buildReworkPrompt`, "Rework (round n)").
3. Every already-completed unit downstream of a target within the processed
   stages re-runs the same way: the review itself ("Re-review (round n)",
   with the reworked reports) and any sibling such as a Verifier that already
   consumed the old output ("Update (round n)"). Stages after the gate have not
   started yet and run normally afterwards.
4. The gate decides again. The loop ends when every review approves, a review
   stops requesting changes, or the run option `reviewRounds` (default 2,
   0–5; 0 disables) is spent. A review still requesting changes then does
   **not** move on silently: see "Convergence" below.

**Severity-aware findings.** The review brief asks for one finding per line,
`- [blocker] path:line — what is wrong and what done looks like` or
`- [note] path:line — …`, before the final `Verdict:` line.
`parseReviewFindings` (`review.ts`) reads only lines whose severity word is in
square brackets (blocker|critical|major|must-fix, or warning|minor|nit|note|
suggestion|optional, any case, emphasis tolerated); plain bullets such as
`- Note: …` are prose. Up to 30 findings of 400 characters are stored on the
review row (`findings`). Decision rule: when a report lists at least one
structured finding the **blockers decide** — none approves (an early exit;
notes stay visible), one or more request changes — even if the verdict line
says otherwise, and Judgment is not consulted. Without structured findings the
verdict line (then Judgment) decides as before.

**Builder's position.** The rework prompt asks the executor to fix every
blocker and to end with `Disputed: <finding> — <why>` for each one it leaves
unchanged; `parseDisputes` stores them on the executor row (`disputes`).

**Convergence.** When the rounds are spent and a gate still requests changes,
the run holds that gate (`needsDecision` on the review row: each open blocker
beside the builder's matching dispute, matched by path or shared words) until
the person who started the run decides through
`POST /api/workflow-runs/:id/decision` (`WorkflowService.decide`, launcher
only, idempotent): `accept` continues with the review still
`changes-requested` and `decision: "accepted"` (the parent's "Review outcome"
line says the person accepted it), `another-round` runs one more round beyond
the limit with an optional note (≤2000 characters) delivered to the executors.
At most two extra rounds per gate; after that only accept is offered. After 24
hours (`decisionTimeoutMs`) the run moves on and records
`decision: "timed-out"`. Stopping the run releases the hold; a restart drops it.

**The call, as the person sees it.** A held gate counts as waiting for a person
everywhere a permission or answer does (`workflowNeedsDecision` in
`workflowRun.ts`): the chat's run card asks for attention, reads *Waiting for
your decision* and offers **Decide**, which opens the run view (not the
reviewer's chat); the unit there is marked `needs-human`. Its decision card
(`ReviewFindings.tsx`) is a quiet `--sunken` well with an amber mark, not a
warning box: the open blockers under one *Reviewer / Builder* header in two
columns, each beside the builder's dispute (or *No reply*), and **Accept as
is** as the one primary. A panel 560 px wide or less reads it as a thread, the
reply indented under its blocker on a `--borderless-edge` line. While the card
shows, the findings list above it keeps only the notes, so a blocker is read
once.

**Notification.** `onReviewSettled` fires once per outcome: when a gate is held
(the server calls `waitingForPerson` for the parent chat) and when every review
approved at the end of the run ("Review approved on the first round" / "in n
rounds", via the optional `notify`, skipped when the host lacks it). The parent
chat has no other workflow-completion notice, so there are no duplicates.

Each re-run bumps the node's `round` (1 is the first pass) and `attempt`; a
re-running review has its `verdict` cleared (published as `null`) until it
decides again. A failed rework blocks the re-review (`skipped`, upstream
failed) and fails the run like any other failure; node retry applies. Rounds
are bounded per stage, so two gates in one stage (Reviewer + Verifier) share
the budget and trigger one combined rework per round. Rework turns never run
while the run is stopping, and every unit still runs through the canonical
session service with the same approvals, timeout and abort behaviour.

Downstream handoffs use the child's last nonempty assistant report, preserving
chunk-only responses when a runtime does not supply message text. Immediate
dependencies receive context priority over older ancestor briefs. Shortened
reports retain their conclusions and canonical child-session references so a
worker can read the full findings. Progress remains visible in the child log;
it does not replace the final report. Empty results and unconfirmed terminal
markers fail the unit rather than unlock its dependents.

Launching leaves chat usable. Run progress and the final result appear in the
conversation as one card placed at the run's `workflow/run-started` position, so
later prompts and answers read below it. The View workflow action becomes available when the package
surface has registered, including during cold startup. Child sessions remain available for inspection and human
questions or permissions; a node's permission request that its own policy holds
for a person is also mirrored into the launching chat. Node sessions inherit the
launching chat's approval level (`inherit`, so a mid-run change in the chat
applies to running nodes): run option `manual` ("Same as chat") adds nothing,
while `auto` raises a chat that asks for everything to routine Auto-Approve and
still inherits the chat's Full access. A node reports "waiting
for your approval" only once the child is `waiting` (its policy held the
request) or the request stays open past a 5 s grace — a request its Auto-Approve
or Full access answers never flashes that state — and progress throttling
always publishes the start and end of such a wait.

The card has no composer hand-off. Every settled run appends one canonical
`package/context` record (`sourceId` `run:<id>`) to its parent: status, the
request, each unit's status and child session id, and the result when one
exists. A stopped or failed run says so and never presents a successful result.
A native runtime leg receives only each turn's own text, so the session service
prefixes the next ordinary prompt with every `package/context` appended since
the previous one (`pendingPackageContext` in `@polyth/session`, bounded, newer
context per source supersedes older). A native command carries none and does
not end that window. The prompt persists it as its
`recoveryContext` before delivery, which also marks it delivered; an epoch
recovery restores it with the confirmed dialogue instead.

The chat card shows the same facts compactly: a unit's detail line reads
"Round 2 · Changes requested · Sent back to Builder", the summary says
"Rework round n" while units re-run, and a review that sent work back uses the
return glyph instead of a check mark.

The run panel keeps the next step explicit. A running run offers Stop. A done run
offers Run again, which repeats the run's recorded request and options and does
not depend on any hand-off. A failed or stopped run is never replayed in one
click: the surface shows the run form below it (prefilled with the run's request
when it was opened with View workflow), so the next run is a new request the user
launches. Node retry stays the only way to continue a failed run.

Recorded node output and run results keep at most one blank line between blocks.
The runner joins only non-empty streamed parts (reasoning-only and marker
messages create empty ones), and the chat card and workflow surface normalize
older records; stored records are not rewritten.

From an open chat the launcher retains the draft until admission succeeds.
From the unsent new chat it does not wait: once the parent session exists it
starts tracking the request (`widgets/workflowStart.ts`, UI-only state), moves
the task into the workflow window, opens the parent and hands the window the
launch. The window shows the starting run with indeterminate progress, a failed
start with Retry (the same request and `clientOperationId`, so a lost response
never admits a second run), and switches to the admitted run as soon as the
request returns. Someone who left the new chat while the parent was created
keeps their place and the launch behaves like an open-chat one. The host's conditional
composer replacement checks scope and exact submitted text before clearing it,
including after a composer remount. Late responses must preserve newer text and
newly attached files.

## Ownership and extension points

- `packages/workflow/src/presets.ts` owns the browser-safe catalog, categories,
  ordering, and compact topology summary.
- `packages/workflow/src/review.ts` owns the verdict parser and the pure
  rework-set helpers; `prompt.ts` owns the first-pass brief, the verdict
  requirement and the rework/re-review follow-ups.
- `packages/workflow/src/index.ts` owns definitions, revisions, scheduling,
  the review loop, run records, and preferences. Groups reuse the existing DAG
  scheduler.
- `packages/workflow/src/serverEntry.ts` validates the request's
  Space/project/session and obtains storage and sessions through
  `host.spaceStorage` and `host.forSpace`.
- `packages/workflow/src/runner.ts` bridges to canonical child sessions.
  Provider protocols, processes, and execution release remain with the existing
  session and harness owners.
- `packages/workflow/widgets/index.tsx` registers the surface, composer widget,
  message actions, and the `session.list.badges` workflow-session badge through
  supported web package seams. `WorkflowView.tsx` owns the builder UI and reuses
  the composer model picker plus the `modelPicker.header` harness slot.
- DTOs live in `@polyth/contracts`; `@polyth/session/web-api` exposes the typed
  transport for workflow routes.

Revisions reject stale saves. A client operation identifier represents one
launch intent and is reused after a lost response. Reconnect reads the existing
run; restoring a component must never launch another one. Run records retain
the execution's definition and completed outputs. Restart recovery marks
uncertain execution and never automatically replays mutations. Retry is offered
only when the server can safely restart the affected unit. Abort acknowledgement,
timeout, and a missing PID are not execution-release proof.

A capacity/rate-limit stop with a canonical server resume plan keeps its
workflow unit running while the session service admits the continuation. The
workflow watches that same child; it does not submit a duplicate turn or choose
another model. The original node deadline bounds the wait. Cancelling the wait
stops the unit, and workflow stop/timeout cancels its pending resume before
aborting the child. A failed or stopped dependency blocks its descendants,
including the Finalizer; a run with stopped or unfinished units cannot publish
a successful result. Already settled historical runs remain settled and use
the explicit retry path when execution can safely restart.

### Fixing a unit while the run waits

A unit whose failure proves its turn never started — the runner's
`pre-admission` failures with `retryable: true`, such as a model the engine
does not offer or a pinned harness that cannot be resolved — does not fail the
run. The unit is marked `needsFix` (status `error`, `retryable`), nothing
after it is skipped, and the run stays `running` while it waits for a person,
bounded by the run's node timeout. The run view shows the unit in the
attention (amber) tone with "Waiting for your fix", the error, the shared model
and harness pickers and **Continue**; the chat card offers **Fix**, which opens
that view, and the status-bar chip reads "Fix needed". Continue posts the same
`POST /api/workflow-runs/:id/retry` as node retry: for a held unit the service
applies the route to the running run (its definition and the unit's row), puts
the unit back in the queue and resumes it in place — a new route starts a fresh
child session — instead of forking. A repeated `clientOperationId` returns the
same run. Only the person who started the run can fix it while it runs; anyone
can still fork it after it settles. Stop, or the deadline passing, ends the
wait: `needsFix` is cleared and the settled run keeps the unit retryable. A
restart drops a pending fix with the fenced run. Failures after admission, and
a refusal because the run's launcher left the Space (`fixable: false`), still
fail the run as before.

Choosing another route shows **Use for future runs** (on by default).
`saveToWorkflow: true` keeps the route on the run's template before the unit
continues: a stored template's node is updated in place (a chosen model pins
the unit, leaving Auto) with a new revision, and a bundled template keeps it as
this project's route for that unit. A template that no longer has the unit
refuses the save with a conflict instead of silently fixing only this run. The
same option is offered when retrying a settled run.

Retry requires a settled run, preserves completed independent work, and restarts
only the selected failed unit and its blocked descendants. Each run admits at
most one retry fork; further retries continue from that fork. A lost admission
response retains its operation binding. An unavailable pinned harness detected
before child creation, or canonical proof that a turn was never admitted, can
permit retry. Unknown execution remains fenced. Proven-empty children are
removed through the canonical session service with a revision check; children
with execution evidence remain available for inspection.

Cancellation preserves completed results. Configured parallelism bounds worker
startup; presets grant no extra approval or tool authority. Usage remains in
canonical child-session telemetry. Workflow/run/node identity, session lineage,
harness/model assignment, and retry attempts connect runs to those observations;
there is no separate workflow analytics store or fabricated cost estimate.

Workflow sessions carry the package-owned purpose `workflow`, which the
navigator renders as the Workflow badge. That purpose is a session marker, not a
workbench lane: the shared lane rule keeps the run parent and its node children
in their nearest ancestor's lane (ordinary Conversation when the run lives in an
ordinary chat) so the run is visible instead of being filtered out of every
list. Each unit's child session is a subagent of the run's parent
(`parentId`): the navigator (desktop and phone) lists it only inside its
parent's subagent disclosure, never as a chat of its own, even though the
parent runs no turn and its units are therefore newer than it. Only rows of
their own take page slots (`isNavigatorRoot` in `apps/web/src/sessionTree.ts`);
a child whose parent has not loaded yet is withheld while
`apps/web/src/sessionParents.ts` reads that parent once, and stands alone only
when the parent is archived, filtered out or gone. Opening a unit unfolds its
parent and keeps the parent in view. A workflow-created parent session is
created untitled (a task-less launch takes the workflow's name) and, once the
run is admitted, the workflow service's `onRunStarted` hook asks
`SessionService.requestAutomaticTitle` to name it from the run's task: Custom
Titles when enabled, otherwise the prompt-derived title. The parent never
receives the task as a user turn, so ordinary first-message naming cannot reach
it, and the hidden delegated-permission messages it may receive later never name
it. Parents created before this change keep their manual prompt titles; Custom
Titles' **Regenerate title** names them from the run's task. `sessions.create`
marks explicit titles `titleSource=manual`;
each child uses its trimmed node role as an explicit title and disables
automatic title generation for its workflow turn. The navigator therefore
keeps the execution role instead of deriving a title from the `# Role` prompt
heading. Existing child titles are not rewritten retroactively.

A run outlives its workflow window. The package appends the canonical
`workflow/run-started`/`workflow/run-completed` events first and then publishes
`backgroundWork.workflow` on the parent projection, so the navigator shows the
parent as working while any run is active and emits one completion/failure
notice when the last one settles. Runs still marked running in a previous
process are fenced as stopped at service creation; their stale active count is
dropped without inventing a terminal result, so a restart cannot leave a
phantom working chat.

Child output remains complete in canonical history. Workflow projections retain
at most 64,000 characters per node with a truncation notice. Adjacent streamed
chunks are coalesced before progress updates; lifecycle changes persist the run
snapshot while activity/output updates are throttled.

`workflow/node-progress` events in the parent log are deltas. After a node's
first publish in a server process the event is `partial: true`: `node` carries
the id, status and only the fields that changed (`null` clears one), and output
that merely grew arrives as `outputDelta`. The first publish of a key, and the
first after a restart, is a full `node` snapshot without `partial`. The web
reducer merges partial events and replaces on full ones, so logs written by
either shape replay the same run. Full snapshots repeated the static prompt and
the whole accumulated output every 250 ms, which made one run's parent history
about 11 MB and opening that chat page through ~30 backfill requests.

## Verification

Use `node --experimental-strip-types --test --test-concurrency=1` with explicit
workflow test files for the affected boundary. Run `workflowOrchestration.test.ts`
separately: it imports the real browser journey and builds the web application
unless `POLYTH_WORKFLOW_SKIP_BUILD=1` is set after a fresh build. Use
`POLYTH_COMPDISC_FIXTURE_ROOT` and `POLYTH_LIVE_ARTIFACTS` under the repository's
ignored scratch directory, with an unused `POLYTH_WORKFLOW_TEST_PORT`. The fixture
authenticates through the real Space gateway with an isolated synthetic owner.
Other installed provider CLIs are excluded from this synthetic fixture's discovery.
The fixture builds the web application but not the runtime supervisor. Real
runs need that gitignored binary (`npm run build:supervisor`, which `npm test`
and `build:web` already run); without it session creation fails with "Polyth
runtime supervisor binary is missing". Never run a broad test glob concurrently
with builds on a constrained host.

The launcher UI
entry runs its Happy DOM cases in a child process with a 384 MB JavaScript heap
cap, a 60-second deadline, and bounded diagnostic output. These limits apply
even when the entry is invoked directly; the heap cap is not a total RSS limit.
Assertions must compare primitive DOM evidence, never whole DOM/React objects.
Run browser checks separately from other builds and tests on shared hosts.
Shared replay/host
changes also require relevant `apps/web/test/` checks and the web build. The
browser fixture uses a synthetic runtime and isolated data; responsive evidence
does not establish native device behavior or paid provider execution.
