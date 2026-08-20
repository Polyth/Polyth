# Gap analysis against current Polyth

## Baseline

The parity matrix contains 209 rows: 34 `implemented`, 41 `implementing`, 133 `planned`, and one `intentionally-changed`. The repository is no longer an M1 shell: it has working packages for sessions, files, Git/worktrees, commands/snippets, goals, terminal, preview, multirun, fusion, walkthrough, schedules, GitHub, models, dictation, and hotkeys. Follow-on work must extend these seams.

### Do not rebuild these capabilities

| Existing behavior | Current seam | Remaining gap |
|---|---|---|
| Append-only session truth, replay, fork, archive/restore, usage projection | `packages/session`, `SessionEvent`, `/api/sessions`, `/ws` | richer session metadata, bulk operations, delivery queue, task/subagent snapshots |
| OpenCode lifecycle and event translation | `packages/backend-opencode` | steer admission, MCP/plugin configuration, richer runtime capability translation; no other package may access OpenCode |
| Permission once/always/reject and question answer/reject | `packages/permissions`, canonical events, session REST | multi-question wizard, request badges, previews, send-time dismissal |
| Per-session browser drafts | `apps/web/src/drafts.ts` (`polyth.draft.<sessionId>`) | IME-safe publication, expanded focus editor, queued drafts |
| Slash commands and snippets | `packages/commands`, `/api/commands`, `/api/snippets` | unified inline token grammar, file mentions anywhere, richer autocomplete |
| File tree/read/write/search/create/delete/rename/upload | `packages/files`, `/api/files/*` | safe autosave revisions, full context menus, go-to-line/ranges, previews |
| Git status/diff/stage/unstage/discard/commit/log/branch/worktrees | `packages/git`, `/api/git/*`, `/api/worktrees*` | folder actions, graph lanes, commit actions, review comments |
| Goal audit/continuation loop | `packages/goals`, durable `goal/*` events | preserve; only UI polish and task/goal work-status integration |
| Scheduled one-shot and interval prompts | `packages/schedule`, `/api/schedule` | cron, IANA time zones, Markdown loops, run workspace ownership |
| Derived walkthrough with durable decisions | `packages/walkthrough`, `WalkthroughView.tsx` | explicit generation jobs, branch/PR snapshots, stable hunk IDs, explanations |
| Dev-server lifecycle and iframe preview | `packages/preview`, `/api/preview` | browser-session broker, navigation/history, logs/network, safe agent control |
| GitHub repo/issues/PR list | `packages/github`, `/api/github/*` | PR detail/checks/comments/review/risk surfaces |
| Session token/cost totals | `usage/recorded`, projections, context rail, turn footer | provider quota adapters, reset windows, pace/prediction |
| Basic browser speech recognition and TTS | `packages/dictation`, `voice.tsx`, `polyth.voice` | server streaming protocol, buffered reconnect, durable/transient state split |
| Settings shell, page-level search, typed page slot | `SettingsView.tsx`, `settings.pages` | item registry search, server-owned settings, plugin/MCP lifecycle |
| Command palette with commands and file search | `CommandPalette.tsx`, `/api/files/search` | projects/workspaces, grouping command, plugin contributions and richer scoring |
| Context rail with surface icons and typed tab slot | `ContextRail.tsx`, `contextRail.tabs` | general tab host, keep-alive instances, per-pane routing and persistence |

## Architectural gap decisions

### Contracts and persistence

Add DTOs to `@polyth/contracts`, not `apps/web/src/api.ts` alone. Long-lived server-owned records belong in `node:sqlite` or an existing package-owned data file. Browser-only layout preferences remain under namespaced localStorage keys. Each mutable endpoint must validate project/session ownership and reject path traversal.

Proposed durable records:

- `session_queue(session_id, queue_id, position, text, delivery, created_at)`
- `project_meta(project_id, name, color, icon, defaults_json)`
- `session_folder(id, project_id, parent_id, name, position)` plus `session_folder_member`
- `agent_profile(id, name, provider_id, model_id, agent, mode, thinking, features_json, notes, icon, color, revision)`
- `workspace_label(id, name, color, position)` plus project/session assignment
- `quota_snapshot(provider_id, account_key_hash, windows_json, fetched_at, error)`
- `project_knowledge(id, project_id, kind, title, body, source, revision, updated_at)`
- `plugin_install(id, source, version, enabled, trust, status, updated_at)` and bounded log entries

Schema migrations must be forward-only, transactional, and covered by reopen tests.

### Event vocabulary

New model-visible data must be appended before display. Recommended events:

- `queue/enqueued`, `queue/reordered`, `queue/removed`, `queue/dispatched`
- `delivery/steered`, `delivery/fallback-queued`
- `task/snapshot`, `task/updated`; `subagent/snapshot`, `subagent/updated`
- `knowledge/attached`, `knowledge/updated`, `knowledge/removed`
- `browser/action-requested`, `browser/action-completed`, `browser/action-failed`
- `review/generated`, `review/risk-scored`
- `dictation/transcript` only when text is committed to the conversation; interim audio/transcript state is not model-visible

Pure UI preferences, file reads, quota polling, and inspector telemetry are not model-visible and should not pollute the log. If browser page text, knowledge, a generated review, or a transcript is shown as agent context, log it first.

### Surface model

Extend `UiSlot` with focused seams rather than importing feature components into `App.tsx`:

```ts
export type UiSlot =
  | ExistingUiSlot
  | "workspace.main.tabs"
  | "workspace.right.tabs"
  | "session.timeline.before"
  | "session.timeline.after"
  | "session.message.actions"
  | "sidebar.project.actions"
  | "sidebar.session.actions"
  | "workStatus.sections";
```

The shell owns pane sizing, tab identity, focus restoration, and error boundaries. Contributions provide descriptors (`id`, `title`, `icon`, `module`, capability requirements), never mounted React nodes in server contracts.

## Gap priority

### P0: correctness foundations

1. IME-safe text-input boundary and delivery admission.
2. Request ownership and send-time question/permission dismissal.
3. Contract-first task/subagent snapshots.
4. Revision-aware file writes and worktree/session ownership.

### P1: high-frequency workspace UX

1. Rich Markdown, file references, Mermaid, JSON, image galleries.
2. Project/session metadata, folders, badges, grouping and bulk archive.
3. General pane/tab host and changes-first Files/Git.
4. Agent profiles and work-status panel.
5. Command/settings item registries.

### P2: workflows and external data

1. Cron/time-zone schedules and Markdown loops.
2. Knowledge store.
3. PR detail/checks/review and generated walkthrough.
4. Generic quota service.
5. Managed plugins and MCP configuration.

### P3: high-complexity integrations

1. Real browser broker with safe agent control.
2. Server-streaming dictation and reconnect buffering.
3. Automated review loop.

## Global implementation contract

- Node 22 erasable TypeScript only; no enums, namespaces, or parameter properties; local imports include `.ts`.
- Cross-package imports use workspace names such as `@polyth/contracts`.
- Only `packages/backend-opencode` communicates with the OpenCode process or SDK.
- Model-visible information is appended to the session event log before UI display.
- REST extends `/api`; live delivery extends `/ws`; no second gateway.
- New surfaces use typed slots and capability contracts.
- Tests use `node --test` and plain `node:assert`.
