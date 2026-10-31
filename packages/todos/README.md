# Todos

`@polyth/todos` owns Polyth's canonical todo model and the optional
"require todo lists" rule.

Polyth already tracks a session's todo list as the revisioned, full-state
`task/snapshot` event. The web reducer turns it into `SessionModel.tasks`, which
the timeline plan, desktop session status and phone island render. This package
is the single source for turning any native todo/plan shape into that event.

## Model (`@polyth/todos`, browser-safe)

- `normalizeTodoStatus` / `normalizeTodoItems`: native statuses (`in_progress`,
  Codex `inProgress`, `completed`, `cancelled`, …) and rows (`content`, `step`,
  `subject`, `text`, plain strings) become `{ id, text, status }` with
  `pending | active | done | failed`. Duplicate ids are made unique.
- `createTodoSnapshotTracker`: one per native session. It publishes revisioned
  `task/snapshot` events and drops repeats and an initial empty list. With
  `revisionClock: Date.now`, revisions stay ahead of a previous runtime leg,
  because the reducer ignores revisions that do not increase.
- `createTodoToolTracker`: transcript-tool harnesses. It accepts full-list tools
  (`TodoWrite`, `update_plan`, `todowrite`, `write_todos`) and Claude Code's
  incremental `TaskCreate` / `TaskUpdate` / `TaskList`. A `TaskCreate` id comes
  from the tool result.
- `todoProgress`, `mergeTodoItems`, `latestTodoItemsFromMessages`: shared
  selectors. The phone island uses the last one as its fallback when a session
  has no snapshot.

## Progress bar and sub-agent panel (widgets)

Two opt-in widgets (`defaultVisible: false`; place them from the Widget Library
into `session.composer.before`, `workspace.right`, `workspace.bottom` or
`workspace.main`). Both are presentation-only: they read canonical session
events and projections through `host.sessions` and write nothing.

- `todos.progress`: `done/total`, a progress bar, the active (else next
  pending) item, failed count and elapsed time. Elapsed starts at the first
  `task/snapshot` of the current list (clearing the list starts a new span),
  ticks once a second only while work remains, and freezes at the settling
  snapshot.
- `todos.subagents`: rows from the newest `subagent/snapshot`, joined with each
  child's projection (live status wins over the stale snapshot status) and
  rolled up through nested children (depth ≤ 4, cycle-safe): tokens are
  `input + output`, cost is `costTotal`. A row opens the child session.
  Selectors: `sessionProgress`, `summarizeSubagents` in `src/progress.ts`.

### Status-bar segments

Two mini-widgets for the status bar's widget areas (`defaultVisible: true`,
hideable, movable between the ends; empty, so taking no room, until there is
something to show). A click opens a popover rather than leaving the chat.

- `todos.statusbar.progress` (leading end): `done/total` and the step in
  progress (capped, full text in the tooltip); green once the list settles,
  red count with a failed step. The popover lists every step with its state.
- `todos.statusbar.background` (trailing end): running sub-agents (same
  `summarizeSubagents` roll-up as the panel) and queued messages, e.g.
  `2 running · 1 queued`. The queue count is `queuedMessageIds` in
  `src/background.ts`, read from `queue/enqueued` / `queue/dispatched` /
  `queue/removed` and the admitted `user/message` the same way the host
  composer's `departedQueueIds` does, so the bar needs no queue request. The
  popover is the sub-agent panel plus the queued count.

Limits: children are discovered through the parent's `subagent/snapshot`, not a
`parentId` query (the web SDK exposes no session list). A child whose
projection or events the browser has not loaded shows no usage and marks the
total as partial. Motion: the bar fill transition and the running pulse are
disabled under `prefers-reduced-motion` and `data-reduce-animations`. Strings
are in `widgets/strings.ts` for every host locale (the host catalogs carry no
Todos keys); counts, tokens, cost and elapsed time use `Intl` in the host
locale. Layout follows the widget's own width (`todos-widget` container
query), and agent-written labels and steps are bidi-isolated for RTL.

## Harness mapping

| Harness | Native surface | Owner |
| --- | --- | --- |
| Claude | `TodoWrite`, `TaskCreate`/`TaskUpdate`/`TaskList` tool calls | `backend-claude` |
| Codex | `turn/plan/updated` (`update_plan`) | `backend-codex` |
| ACP agents (Grok, OMP, Fx, Cursor, …) | `session/update` `plan` entries | `backend-acp` |
| Cursor | `cursor/update_todos`, `cursor/create_plan` | `backend-cursor` |
| OpenCode | `todo.updated`, `todowrite` part | `backend-opencode` |
| Command Code | `todo_write` | `backend-commandcode` |
| Pi, Antigravity (no native surface) | Polyth `polyth_todo` tool | `todos` |

Codex app-server ships `update_plan` disabled, so `backend-codex` enables
`tools.update_plan.enabled` on conversation threads. Snapshots are emitted only
inside a turn that Polyth admitted.

Pi and Antigravity have no native todo surface. They keep the list through the
Polyth `polyth_todo` tool below. Source inspection shows both project package
tools over local MCP. This is not live-verified, and the tool is not available
on remote hosts.

## `polyth_todo` agent tool

The package registers a deployment-wide `polyth_todo` tool and a `polyth-todo`
skill through the `harness.capabilities` registry. It registers them in
`onEnable` and disposes them in `onDisable`. Every harness that projects
package tools receives them.

- No `todos`: returns the current list. `todos` without `merge`: replaces the
  list (`[]` clears it). `merge: true`: updates or appends items by id. Rows can
  use any native shape and go through `normalizeTodoItems`.
- The tool runs only for the session the host resolved from the tool grant. It
  reads that session through `forSpace(grant Space).sessions`, so a session in
  another Space is rejected. It appends `task/snapshot` with
  `producerPlugin: "todos"` before it returns.
- Its name is not a native todo tool name (`isTodoToolName` is false), so
  adapters and the UI fallback never turn its call into a second snapshot.

### Revision rule with native todo tools

The tool and native adapters write the same `todo` list, and the reducer applies
only increasing revisions. The tool reads the newest canonical snapshot from
any producer and writes `newest + 1`. Calls in one session are serialized.

- Clock-seeded adapters (Claude, Codex, ACP, Cursor) always land above a tool
  write, so a later native write wins.
- Counter-based adapters (OpenCode, Command Code) can fall at or below a tool
  write. The reducer ignores their snapshots until the counter catches up.
- A tool write can override a native list.

So the tool never jumps ahead with a clock, and the skill says to use the
native tool when one exists and never both in one session.

## Todo rule

**Settings → Customize → Todos** toggles a short mandatory rule and lets the
user edit its text. The rule is off by default. When enabled, the package
registers it through the host `SERVER_BEHAVIOR_SECTIONS` seam. It is appended
to the deployment-wide global behavior that every harness receives, and the
`behavior/instructions-applied` digest follows it.

- Settings are global: the rule is part of global behavior. They are stored
  under the shared package root (`packages/todos/rule.json`) and are revisioned
  and conflict-checked.
- `GET /api/todos/rule` reads the settings. `PUT` requires instance-owner
  authority. Paired devices have no access.
- Disabling the package removes the section and re-projects behavior.

The default wording was checked live with cheap models on a four-step file task
(three runs per condition). With the rule, Claude Haiku 4.5 and Codex
`gpt-6-luna` each kept a todo list in 2 of 3 runs. Without it, neither did in any
run. A softer "keep a todo list" wording was ignored by Haiku. Treat the rule as
a strong nudge, not a guarantee.
