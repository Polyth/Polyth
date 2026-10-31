# Workflow

Multi-agent DAG pipelines. Review units end with a `Verdict:` line that decides
whether their upstream work is sent back (bounded by `reviewRounds`).

## Who a run acts for

The workflow service and its store are shared by everyone in a Space, but each
run acts for the person who started it. The launcher's user id is stored beside
the run (`launchers` in `workflows.json`, never in run snapshots sent to
clients); every unit, rework round and retry fork creates and sends its child
chats through `host.personSpaceContext(launcher, space)`, so private harnesses,
account limits, chat ownership and authorship follow that person. A retry fork acts
for whoever asks for it (a system retry keeps the original launcher), so
re-running someone else's run never borrows their accounts. If the person can no longer act in
the Space the unit is refused before any child exists (retryable, but never held
for a fix: no other route helps). A unit the run holds for a fix (`needsFix`) can
be fixed in place only by the person who started the run, so the continued run
keeps acting for them. Runs started
by system work use `host.systemSpaceContext`. Runs saved before launchers were
recorded were stopped at load and never continue. On installations with one person, where the host names
nobody, the person's own validated request context is used.

## Templates and fixes

Every workflow is a template; runs belong to the chat that ran them and never
mark a template. A unit refused before its turn was admitted (an unavailable
model or harness) holds the running run until a person picks another route;
`POST /api/workflow-runs/:id/retry` continues it in place, and
`saveToWorkflow: true` keeps the route on the template (bundled templates keep
it per project in `routes` of `workflows.json`). Details:
[docs/dev/workflows.md](../../docs/dev/workflows.md#fixing-a-unit-while-the-run-waits).

## Judgment use: `workflow.review-verdict`

Scope `workflow.review-verdict.v1`, evidence `long`, off by default. Registered
from the server enable hook (and lazily on first use if Judgment enabled later).

- **Policy.** An explicit `Verdict:` line always wins and Judgment is never
  called. Only when the parser finds no usable verdict is the last 4,000
  characters of the report put to a `choice` question (approved /
  changes_requested / cannot_tell).
- **Parameters.** `threshold` (default 70%) and `margin` (default 20%): the top
  choice must pass both. `uncertain`: `ask` (default) or `approve`.
- **Outcome.** Confident `changes_requested` → rework, as with a verdict line.
  Confident `approved` → approved. Otherwise `ask` applies no verdict and marks
  the review "Uncertain" (amber notice in the run view, noted in the run
  context) with no auto-rework; `approve` approves.
- **Fallback.** Use off, Judgment missing, error, timeout or cancel → no verdict,
  exactly as before. The answer never starts anything beyond a bounded rework.
- **Record.** `WorkflowRunNodeDto.judgment` (optional, additive) holds the
  probabilities, margin and applied verdict; the UI shows "Judged · 54%".
