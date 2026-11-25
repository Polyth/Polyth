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

The Workflows window holds template settings and nothing else. Starting a
run, watching it and every run action belong to the chat the run was started
from ([Chat execution](#chat-execution)); the window makes no run request.

It has two pages. It opens on the library: search, New workflow and the
Templates list, each entry a compact card (graph glyph, name, description,
agent and stage counts and a copy action; the role chain is only a tooltip).
A bundled example keeps its stored "Example · " name but the card shows an
Example badge instead, with the sample catalog's description when the stored
workflow has none. Choosing a card opens that template's settings page, which
replaces the library; its back button returns. Workflow settings on a run's
card and the composer launcher's Open workflow builder land on that page;
neither hands over a run or a request (`widgets/workflowLaunch.ts` carries
only the project and the template).

A settings page holds the pipeline, the unit inspector, Details (description)
and Defaults for runs (approvals, review rounds, parallel agents, unit
timeout), which are saved with the template as `defaults` and apply to every
run started from it; an invalid value blocks saving. One muted line says that
a workflow is started from a chat's composer. Templates are read-only: the
page offers Customize, which creates an editable copy. Undo retains up to 50
local edits for the selected workflow and survives autosave acknowledgements;
switching workflows resets it. Leaving a page with pending edits saves them
at once; edits that cannot be saved (an empty name or role) ask before they
are discarded.

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
later prompts and answers read below it. The card's Workflow settings action becomes available when the package
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

The card is the whole run surface (`widgets/WorkflowTimelineCard.tsx`, with
the shared held-unit controls in `widgets/WorkflowRunUnits.tsx`). It is
folded by default: one header line (mark, name, the status as a word in its
tone, elapsed time, a toggle) and one summary line: what runs now with the
unit count and a thin progress bar, or the first line of the result with the
recorded outcome as quiet text. Everything else appears when the card is
opened, and state is said once.

The block belongs to the chat's activity-block family and has no plate,
outline or shadow in any state (`widgets/timelineCard.css`;
`test/workflowTimelineLook.test.ts` pins this on the stylesheet): text on the
chat surface, its mark and name on the activity block's columns, a hairline
thread from the mark through the opened block, and matching rules for the
other activity looks (`body[data-activity-style]`). One accent speaks at a
time: the status is a dim word, progress is the count alone (the bar stays a
`progressbar` for assistive technology but is not drawn), and colour is spent
only where the person must act. A decision or a fix is a short passage with
at most one filled button, and only when the person is the one who acts;
everything else is a text button. The harness strip above a held unit's model
picker is hidden while it offers fewer than two choices. The activity
thread's values are copied from the same tokens, because the host scopes
`--activity-*` to `.activity-group`.

The card knows who steers the run. A run the chat's agent started through
the workflow tool carries `wake`; fixing a held unit and settling a review
gate are then the agent's job, so the folded card says "The agent is on it"
with the reason and offers a quiet Step in that opens the card, instead of
raising "waiting for you". An approval or a question inside a unit's own chat
still asks the person in every run, because the agent is not woken for those.
A run a person started keeps the person as the one who decides: the row that
waits for them (gate decision, held-unit fix, approval) shows while the card
is folded, with its control inline and the held unit's real error above the
fix. The outcome buttons show for a person-started run without a record, and
for an agent-steered one only when nothing was recorded.

Opened, the card holds:

- a unit's details hold its report (shown at once, not behind a second
  fold), a review's findings and its route, read as "By role: Implement →
  harness · model" when a routing role chose it;
- a review gate that waits after its rounds shows the decision (Accept as is
  / Another round) under its row;
- a unit the run holds because it could not start is fixed under its row,
  with another route when the route was the problem; a failed unit of a
  settled run keeps its plain retry;
- the request, Stop while the run runs, Workflow settings, and under the
  result of a settled run the outcome row with Change
  ([Run outcomes](#run-outcomes));
- a done run offers Run again, which repeats the run's recorded request and
  options in the same chat. A failed or stopped run is never replayed in one
  click: unit retry stays the only way to continue it, and a new run is a new
  request from the composer.

Whatever points at a run opens its parent chat, where the card is: the status
bar segment, a waiting notice, the launcher after a start. Nothing opens the
Workflows window to show a run.

Recorded node output and run results keep at most one blank line between blocks.
The runner joins only non-empty streamed parts (reasoning-only and marker
messages create empty ones), and the chat card and workflow surface normalize
older records; stored records are not rewritten.

From an open chat the launcher retains the draft until admission succeeds.
From the unsent new chat it does not wait: once the parent session exists it
starts tracking the request (`widgets/workflowStart.ts`, UI-only state), clears
the composer and opens the parent chat, where the run's card appears as soon as
the run is admitted. The start stays with that chat: while it is in flight the
composer's workflow button is busy; if it fails, the button shows an attention
state, a notice says so, and opening the launcher shows the failed start above
the template list with its request, Retry (the same request and
`clientOperationId`, so a lost response never admits a second run) and Dismiss.
Dismiss puts the request back into an empty composer; when a draft is already
typed it is never replaced and Copy request is offered instead. Someone who left the new chat while the parent was created
keeps their place and the launch behaves like an open-chat one. The host's conditional
composer replacement checks scope and exact submitted text before clearing it,
including after a composer remount. Late responses must preserve newer text and
newly attached files.

## Routing roles

A unit may name a routing role (`WorkflowNodeDto.routingRole`: `explore`,
`implement`, `verify`, `review`, `vision`, `write` or a `custom-…` id from
Settings → Orchestration). When the pass starts, the engine asks the
launcher's delegation policy for that role's first usable model
(`WorkflowDeps.routeFor`, served by `SERVER_DELEGATION_POLICY.route` of the
optional Orchestration package) and runs the unit on it; the run row then
carries that `model`/`harness` and `routedRole`.

- The role applies only while the person who started the run routes By role.
  In Auto mode, for system runs, without the Orchestration package, and when
  nothing in the role's chain is usable, the unit runs on its own route (its
  pinned model/harness, an Auto allow-list, or the inherited chat route).
- A role model refused before the turn was admitted (the same pre-admission
  proof that otherwise holds a unit for a fix) moves to the role's next
  usable model, then to the unit's own route. Only when every route was
  refused does the run hold the unit for a person. Nothing ran, so nothing is
  repeated; at most six routes are tried.
- A rework round continues in the unit's child session and keeps the route
  that session began on.
- A route a person picks while fixing a held unit, or saves for a bundled
  template, removes the unit's role: an explicit route is the route.
- A role chain's `maxConcurrent` is advisory and is not enforced by the
  scheduler; `maxParallel` bounds a stage.

In the settings page the unit inspector has a "Model by role" select (Off or
a role) above the unit's own route, which is then captioned as the fallback.
Unit route text reads "By role: Implement" on a definition and "By role:
Implement → harness · model" in the details of a run's unit on the chat card
when the role chose its model.

Bundled templates name a role on every unit: workers `implement`, researchers
`explore`, leads and review units `review`. A person who routes By role
therefore gets their own models per kind of work instead of the launching
chat's model on every unit.

## Located facts

Units share what they located so the next one does not search again.

- Every unit's brief asks for a closing `# Located facts` section of at most
  20 lines `- locator — what is there`. A locator is whatever lets the next
  unit open the thing again, in any kind of project: a file (`a/b.ts`,
  `a/b.ts:12`, `a/b.ts:12-40`, `notes.md#part`), a folder path, or the URL of
  a web source. `parseFacts` (`prompt.ts`) keeps only lines that start with a
  locator; the section ends at the next heading or at a review's verdict
  line.
- The heading stays in English whatever language the report is in (the brief
  says so), and is accepted as a markdown heading, a bold line or a plain
  `Located facts:` line, because models differ in how they write it.
- The run keeps the map in `WorkflowRunDto.facts` (at most 40 lines of 240
  characters, oldest first; a full map keeps what it has). A launch may seed
  it with `WorkflowLaunchOptionsDto.facts`; a retry fork inherits it.
- Each brief carries the map as `# Located facts so far`, before the upstream
  reports and within 3,000 characters of the 12,000-character brief. Upstream
  reports are passed without their facts section, so nothing is repeated.
- A launch that shares only the request (`context: "request"` without a
  source message) no longer repeats the input as conversation context.

## Run outcomes

A finished run says the units ended, not that the result was used.
`WorkflowRunDto.outcome` records that: `accepted` (used as delivered),
`reworked` (kept after more work outside the run) or `discarded`, with an
optional one-line note, the time and `by: "person" | "agent"` (never a user
id).

- `POST /api/workflow-runs/:id/outcome` `{ value, note? }` and the agent
  tool's `outcome` action call `recordOutcome`. Only a settled run takes an
  outcome, only the person who started it (or an agent turn acting for that
  person) records it, and a later record replaces the earlier one.
- The service appends `workflow/run-outcome` to the parent chat before it
  stores the record; clients fold runs from events, so both reducers
  (`apps/web/src/reduce.ts`, `widgets/workflowRunProjection.ts`) read it.
- The run's card in the chat shows one quiet row under the result of a
  settled run: the question with Accepted / Reworked / Discarded, or the
  recorded outcome with who recorded it and a Change action
  (`widgets/WorkflowRunOutcome.tsx`).
- `GET /api/workflow-outcomes?projectId` and the tool's `stats` action count
  settled runs per template: done/error/stopped, the three outcomes,
  unrecorded runs, and how many units a review sent back. This is the
  evidence for choosing between a template and hand-driven delegation.

## Agent tools

`packages/workflow/src/agentTool.ts` registers two tools and the
`polyth-workflow` skill through `harness.capabilities` in the enable hook.

| Tool | Actions | Approval |
|---|---|---|
| `polyth_workflow` | `templates`, `template`, `run`, `runs`, `status`, `output`, `stop`, `retry`, `outcome`, `stats` | approved by the package |
| `polyth_workflow_manage` | `create`, `update`, `delete` (templates), `decide` (a held review gate) | the chat's permission flow |

Boundaries, all enforced in the handler:

- A call acts for the person of the calling turn (`ctx.actorUserId`), exactly
  as a route acts for the signed-in person; a turn with no person runs as
  system work. A viewer can read but not run or change anything.
- Templates are those of the calling chat's project. Runs are only the ones
  started from the calling chat; any other run answers not-found.
- A run the agent starts always uses `permissions: "manual"`, so its units
  inherit the chat's own approval level, and a template the agent saves
  always stores `manual`. An agent cannot raise approvals through a workflow.
- `run` starts with the chat's route as the launch default, `context:
  "request"` unless the agent asks for `recent`, the agent's `facts`, and
  `wake` on by default.
- Input is read the way models of any strength write it: a template is found
  by id, by a bundled short id, or by its name when exactly one template of
  the project carries it; an outcome value is taken in any verb form
  (`accept`, `Reworked`, `discard`); a model is `provider/model` as
  `agent.models` prints it (the object form is accepted too).

Standing context is a cost every user pays on every request, so it is
budgeted. Harnesses that do not defer tools carry both schemas with each
request, and prompt-delivered skills carry the skill text with each prompt.

- The two tool descriptors and the skill text are terse on purpose (about 450
  and 500 tokens for the tools, under 200 for the skill);
  `packages/workflow/test/agentTool.test.ts` fails when they grow past their
  character budgets. Guidance needed at one step goes into that step's
  output instead: `run` says to end the turn, a wake notice names the next
  action, `templates` says how to start one.
- Outputs are bounded and do not repeat what the chat already holds:
  `templates` is one line per template, `template` clips unit prompts to a
  preview unless `full` is passed (a copy keeps them whole), `status` omits a
  settled run's result because the run's `package/context` record already
  put it in the chat, `output` returns the end of one report within a limit.
- A unit's brief adds a fixed 1.1k characters (handoff and facts rules)
  before the task, the map and the upstream reports.

Nothing here depends on one installation. Without the Orchestration package,
for a person in Auto mode and for a role with no models, units run on their
own route exactly as before; the tools, the skill text and the briefs name
no harness, model or project type.

A run started with `wake` (`WorkflowRunDto.wake`) tells the parent chat's
agent, as a hidden turn sent for the launcher, when it settles, when a unit
could not start on any route (`needsFix`), when a review still has blockers
after its rounds (`needsDecision`), and when a server restart fenced it. A
stop the agent itself asked for sends nothing. Delivery only: a lost wake
never changes the run (`WorkflowDeps.onRunAttention`).

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
- `packages/workflow/src/agentTool.ts` owns the two agent tools and the
  `polyth-workflow` skill text; it reaches runs only through `WorkflowService`.
- `packages/workflow/src/runner.ts` bridges to canonical child sessions.
  Provider protocols, processes, and execution release remain with the existing
  session and harness owners.
- `packages/workflow/widgets/index.tsx` registers the surface, composer widget,
  message actions, and the `session.list.badges` workflow-session badge through
  supported web package seams. `WorkflowTimelineCard.tsx` owns the run
  surface in the chat; `WorkflowView.tsx` owns the settings UI and reuses
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
