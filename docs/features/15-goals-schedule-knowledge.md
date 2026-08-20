# Goals, schedules, loops, and project knowledge

## Current Polyth baseline

`packages/goals` already implements the server-driven objective loop with a small-model audit, continuation/token limits, durable `goal/*` events, restart replay, and `GoalStrip`/`GoalsView`. Preserve it. `packages/schedule` persists one-shot/interval tasks in JSON, prevents double-fire by marking before running, and exposes list/create/update/delete/pause/run. `ScheduleView` manages those tasks; its upstream baseline is polyth #920. The missing work is cron/time-zone cadence, file-managed loops, explicit run workspace ownership, and project knowledge.

## 1. Preserve and expose the existing goal loop

**Source:** polyth #2148.

This source feature is already in Polyth. Follow-on work may improve display but must retain:

- Independent small-model audit after a turn.
- `keep`, `done`, or `stuck` verdict with bounded continuation and token budget.
- Auditor failure becomes stuck, never an unbounded/silent loop.
- Goal state reconstructs from durable events after restart.
- Any goal/audit text shown to the model is appended before use.

Integrate goal status into Work Status and sidebar badges through projection/slots; do not fork the goal state machine. Existing endpoints `/api/sessions/:id/goal`, `/pause`, `/resume`, `/stop` remain canonical.

Regression tests: restart between turn and audit, duplicate terminal event, missing small model, token limit, pause race, and status projection.

## 2. Cron cadence with IANA time zones

**Sources:** polyth #1593; Paseo #1232, #1246, #1909.

**Acceptance criteria**

- Task editor supports Once, Interval, and Cron.
- Cron validates while typing, explains the next five runs, and stores an IANA `timeZone`.
- Existing tasks without `timeZone` use the server's configured default but display that assumption.
- DST gaps/folds behave deterministically and preview matches execution.

Extend:

```ts
type ScheduleCadence =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };
```

Add `cadence` while accepting legacy `kind/at/everyMinutes` during one migration. REST remains `/api/schedule`; add:

```http
POST /api/schedule/preview
{"cadence":{"kind":"cron","expression":"0 9 * * 1-5","timeZone":"Europe/Kyiv"},"count":5}
→ {"runs":[178...],"description":"At 09:00, Monday through Friday"}
```

Use a maintained cron library with IANA time-zone support at its latest version when implementing; wrap it in `packages/schedule/src/cron.ts` so tests do not depend on UI. Reject seconds fields unless explicitly supported, aliases, ranges outside limits, unknown zones, and schedules faster than the configured minimum.

Classes: `.cadence-editor`, `.cron-input`, `.next-runs`. Default new cron zone to `Intl.DateTimeFormat().resolvedOptions().timeZone`, sent explicitly.

**Tests:** spring-forward missing time, fall-back duplicate time policy, leap day, invalid zone, server/client zone difference, migration, preview/executor equality.

## 3. Markdown-managed loops in `.agents/loops`

**Source:** polyth #2698.

Discover `<project>/.agents/loops/*.md` with bounded recursion disabled by default. File format:

```md
---
id: dependency-audit
title: Dependency audit
cron: "0 9 * * 1"
timeZone: "UTC"
enabled: true
agentProfile: review
---
Inspect dependency changes since the last run and report risks.
```

`packages/schedule/src/loops.ts` parses strict frontmatter and reconciles file tasks with server records. File-managed fields are read-only in the UI; Pause may create a local enabled override, but editing prompt/cadence directs the user to the file. Stable identity is project ID + frontmatter `id`, not filename alone.

```http
GET  /api/schedule/loops?projectId=
POST /api/schedule/loops/rescan {"projectId":"..."}
```

Task DTO gains `source: "ui"|"loop-file"`, `sourcePath?`, `sourceDigest?`, and `parseError?`. File changes are watched with debounce and periodic reconciliation; missing files disable/remove the managed task according to an explicit policy.

If loop prompt text reaches a model, session creation appends `schedule/run-started` and the resulting `user/message` before execution. Do not display unlogged generated context in the session.

**Tests:** duplicate IDs, malformed frontmatter, traversal/symlink, rename with same ID, atomic editor save, disabled override, watcher event storm, deleted file during run, 256 KiB limit.

## 4. Schedule runs own visible workspaces/sessions

**Source:** Paseo #1909.

Each task explicitly chooses:

- existing session, or
- fresh visible session per run attached to the project/worktree, or
- dedicated reusable schedule session.

Add:

```ts
interface ScheduleTarget {
  mode: "existing-session"|"new-session-per-run"|"dedicated-session";
  sessionId?: string;
  worktreePolicy?: "project-root"|"fresh-worktree";
}
```

Every run records `lastSessionId`, `runId`, and history `{startedAt,finishedAt,status,error?,sessionId}` (bounded or normalized in SQLite). Add:

```http
GET /api/schedule/:id/runs?limit=50
```

The Schedules surface links to the visible run session. Worktree creation/removal uses `@polyth/git` capabilities; schedule code does not execute Git directly. Concurrent runs follow `overlapPolicy: "skip"|"queue"|"parallel"` with default `skip`.

Test deleted target session, missing worktree, overlap, server restart mid-run, manual Run now, archived session, and project removal.

## 5. Project knowledge: notes, plans, search, and memory

**Source:** polyth #2973.

**Acceptance criteria**

- Right-pane Project Knowledge replaces browser-only notes.
- Users create/edit/delete/search notes and plans. Agent memory appears in a distinct section with source/time and may be disabled.
- Knowledge is project-scoped, revisioned, server-owned, and searchable.
- Attaching a card to chat logs the exact revision/content before it is shown as model context.
- “Agent memory” ships dark behind a setting until retention/redaction policy is configured.

Add a focused `packages/knowledge` capability backed by `node:sqlite`:

```ts
type KnowledgeKind = "note"|"plan"|"memory";
interface KnowledgeItem {
  id: string; projectId: string; kind: KnowledgeKind;
  title: string; body: string; tags: string[];
  source: "user"|"agent"|"import";
  sourceSessionId?: string;
  revision: number; createdAt: number; updatedAt: number;
}
```

```http
GET    /api/knowledge?projectId=&kind=&q=&limit=&pageToken=
POST   /api/knowledge {"projectId":"...","kind":"note","title":"...","body":"...","tags":[]}
GET    /api/knowledge/:id
PATCH  /api/knowledge/:id {"expectedRevision":2,...}
DELETE /api/knowledge/:id
POST   /api/sessions/:sessionId/knowledge {"knowledgeId":"...","revision":2}
```

Use SQLite FTS5 if available; otherwise deterministic case-folded substring search with pagination. Never send knowledge content in list DTOs beyond bounded snippets. Attach appends:

```text
knowledge/attached {knowledgeId,revision,title,body,digest}
knowledge/updated  {knowledgeId,revision,digest}       // if session context refreshes
knowledge/removed  {knowledgeId}
```

The first attach event must contain or immutably reference the exact body needed for replay. Deleting the project record must not make historical model context unreplayable.

UI through `workspace.right.tabs`: `ProjectKnowledgePanel` → Search → `KnowledgeCard`/`KnowledgeEditor` plus `MemorySection`. Settings: server `knowledge.agentMemoryEnabled=false`, `retentionDays`, and redaction patterns; browser `polyth.knowledge.view`.

Classes: `.knowledge-panel`, `.knowledge-card`, `.knowledge-editor`, `.memory-section`, `.knowledge-source`.

**Security/edge cases**

- Enforce project ownership and size limits (title 200, body 256 KiB, tags 32).
- Revision conflict offers compare/reload; autosave never overwrites.
- Treat content as plain Markdown, sanitize rendered HTML, block embedded remote assets by default.
- Memory generation occurs through `packages/backend-opencode` only and appends candidate/accepted events before display.
- Test Unicode search, deleted source session, duplicate tags, conflict, export/import, disabled memory, redaction, stale attached revision, and project deletion.

## Suggested implementation order

1. Cadence union, migration, cron parser, and deterministic next-run tests.
2. Schedule target/run history and overlap policy.
3. Markdown loop discovery/reconciliation.
4. Schedule UI editor and run links.
5. Knowledge package/contracts/routes.
6. Knowledge panel, attach events, and optional memory pipeline.

## Global implementation contract

- Node 22 erasable TypeScript; `.ts` local imports; no enums/namespaces/parameter properties.
- Cross-package imports use workspace names.
- Only `packages/backend-opencode` calls OpenCode for audits or memory generation.
- Append loop prompts, knowledge, and generated memory before model/UI consumption.
- Extend `/api` and `/ws`.
- Knowledge/Schedule surfaces use typed slots.
- Tests use `node --test` and plain `node:assert`.
