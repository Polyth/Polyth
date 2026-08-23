# Spec-driven tracks

Tracks are the minimal composition of existing Polyth services for sequential,
verified feature work. They are not a second agent framework.

## Lifecycle

1. `POST /api/tracks` creates a track plus two project-scoped Knowledge records:
   a `spec` item and a managed `plan` item.
2. `POST /api/tracks/:id/start` requires a clean Git worktree, attaches the current
   step as a bounded Goal, and dispatches its prompt through a one-shot Schedule into
   the selected session.
3. The existing Goal auditor continues the session until it reports `done`.
4. Polyth runs the step's declared test with the bounded terminal runner. A failure,
   timeout, conflict, or empty change set blocks the track and creates no commit.
5. On success, all step changes are staged and `GitService.commit` creates exactly one
   commit. The full hash is persisted on that step and rendered into the managed plan.
6. The next step starts only after that hash is durable. The final step moves the track
   to `completed`.

Blocked work can be resumed with `POST /api/tracks/:id/retry`. The UI also exposes
creation, start, retry, and manual finalization (normally automatic) through the
Knowledge package's `workspace.right.tabs` contribution.

## Durable state

- Specs and plans: `knowledge.db`, through `@polyth/knowledge`.
- Track execution ledger: atomically-written `tracks.json`.
- Goal and track lifecycle: append-only session events
  (`track/step-started`, `track/step-completed`, `track/step-failed`,
  `track/completed`).
- Dispatch audit: normal schedule state and `schedule/run-started` events.
- Step result: the Git commit itself plus its full hash in the track ledger.

Every prompt still goes through `SessionService.send`, which appends it before the
runtime sees it. Track lifecycle events are ignorable workflow state and never become
model history.
