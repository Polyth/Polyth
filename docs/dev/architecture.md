# Polyth architecture (as built)

Snapshot of the system as it exists on this branch. This replaces the old milestone
plan; nothing here is aspirational — every item is in the tree today.

## Topology

```
apps/web (React 19, esbuild bundle, no framework server)
   │  REST /api/*        WS /ws (sessions, browser frames, dictation audio)
   │                     WS /ws/terminal/:id (PTY byte stream)
packages/server (node:http composition root)
   ├─ kernel context (capability providers)
   ├─ session service (delivery, queue, steering, permission preview)
   ├─ RouteHandler chain (one per feature package)
   └─ runtime pool ── packages/backend-opencode ── `opencode serve` (one per project/cwd)
packages/session (node:sqlite WAL: events + projections + queue/org/profiles)
```

## Packages

| Package | Role |
|---|---|
| `contracts` | Type-only DTOs, `SessionEvent`, service interfaces, `UiSlot` union, capability keys (`CAP`). The normative surface. |
| `kernel` | Scoped plugin contexts: `provide`/`inject`/`optional` capabilities (priority + registration order), `on`/`emit`/`waterfall` events, LIFO effect disposal, `contribute()` for UI slot items, `loadPlugin` with manifest requirement checks, profile resolver (bundles → ordered plugin list). |
| `session` | Append-only event store. `append` allocates monotonic per-session `seq` transactionally; projections (`SessionProjection`) are updated alongside; also owns queue items, folders, labels, agent profiles, and transcript text search (`searchEventText`). `deriveMessages` turns the log into model history (skips `ignorable`). |
| `backend-opencode` | The only OpenCode integration point. Spawns/attaches `opencode serve`, translates its SSE into `RuntimeEvent`s, maps canonical session ids ↔ backend ids, applies behavior/MCP config (`createConfigApplier`), imports pre-existing OpenCode sessions, snapshots task/subagent state as revisioned events. |
| `permissions` | Monotonic fail-closed rule engine; scopes user/project/session; deny beats allow; "always" persists a rule at the chosen scope. |
| `goals` | Objective attach/audit loop: small-model auditor verdicts (`keep`/`done`/`stuck`), budgets, auto-continuation, pause/resume; rehydrates from the event log after restart. |
| `files` | Path-jailed file service: tree/stat/read (revision = mtime+size), revision-guarded `write` (stale `baseRevision` → `conflict`), binary-overwrite refusal, mkdir/rename/delete/upload, scored file search (shared with palette + mentions). |
| `git` | Porcelain wrapper: status/diff/show/stage/unstage/discard/commit/log/graph/branches/checkout/stash/fetch/pull/push/worktrees, diffHead/diffRange for review flows. |
| `commands` | Slash commands + `#alias` snippets: project (`.agents/commands`) and user scopes, `$ARGUMENTS`/`@file`/`!cmd` template expansion, CRUD for the settings UI. |
| `terminal` | PTY sessions (`node-pty` when present) with create/list/close; `/ws/terminal/:id` byte stream. |
| `preview` | Dev-server lifecycle per project: script detection, `PORT` injection, status events, URL for the iframe preview. |
| `multirun` | N parallel one-shot runs (model/agent matrix) inside a session; per-run progress events; pick-a-winner. |
| `fusion` | Multi-model answers + small-model synthesis with weights, attribution, disagreements. |
| `walkthrough` | Generated diff walkthroughs (stable hunk ids, digest-keyed cache) + structured review generation (`ReviewAssessment`) shared with the review flow. |
| `schedule` | at/every/cron cadences (IANA time zones), overlap policies, run history (cap 50), file-authoritative Markdown loops under `<project>/.agents/loops`. |
| `knowledge` | Notes/plans/memories store (own SQLite) with revisions, tags, search; attaching logs `knowledge/attached` (exact revision + digest) before the model sees it. |
| `github` | `gh`-CLI-backed repo/issues/PR list, PR detail/files/diff/comments, failure-first checks aggregation, guarded review submit + risk/confidence labels. No tokens stored. |
| `usage` | Provider-neutral quota adapter contract: jittered polling, in-flight dedup, backoff, bounded last-good persistence, secret redaction, pace/prediction from multi-sample history. |
| `browser` | Agent-drivable Chromium (playwright-core) or fake driver: URL/origin policy (blocks unsafe schemes, private IPs, DNS rebinding, downloads), stale-frame rejection, redacted observations, JPEG frame stream, honest `unavailable` engine state. |
| `dictation` | Server streaming dictation protocol: lifecycle via REST, PCM chunks via `/ws` with acks + `(id,seq)` dedupe + replay-from-last-ack, `SttAdapter` seam (no engine ships by default). |
| `models` | Model preference logic: favorites, provider/name/recent sort, search (shared by picker + settings). |
| `hotkeys` | Keymap model: default bindings, user overrides, conflict detection, sequence matching. |
| `plugins` | Installed-plugin registry (install/enable/disable from dir sources, trust classes, contribution manifests). |
| `server` | Composition root + everything HTTP/WS: see below. |

`apps/web` is the only app: React 19, bundled by `apps/web/build.ts` (esbuild), served
statically by the server with SPA fallback.

## Server internals (`packages/server/src`)

- `index.ts` — `boot()`: data dir, store, project service, permission service, per-project
  **runtime pool** (lazy `opencode serve` per project/cwd, transport-error respawn with a
  stable facade), broadcast box, goal service wiring, multirun/fusion runners, schedule
  runner (visible sessions per target mode), walkthrough/review/review-flow jobs,
  usage service, browser/dictation services, the `routes` array, HTTP+WS attach, shutdown.
- `sessions.ts` — canonical session service: create/fork/archive/restore/rename/organize,
  send with **delivery admission** (`normal` | `steer` | `queue` | `interrupt`,
  steer falls back to queue with `delivery/fallback-queued`), queue CRUD + dispatch,
  runtime event → durable log translation, permission preview enrichment, question/permission
  replies with `dismissPending`, turn hooks (goals), usage/projection updates.
- `http.ts` — core REST (health, projects, sessions, models/agents) + `RouteHandler`
  chain + static bundle. Feature packages never edit this file.
- `ws.ts` — `/ws` gateway: `subscribe` (gap-fill from the durable log, then live, seq-deduped),
  projections fan-out, per-socket rate limits, browser frame stream with newest-frame
  backpressure + `afterRevision` resume, dictation audio path with its own rate budget.
- `routes/` — one file per feature: org (folders/labels/bulk/search), workspace
  (files/commands), git, terminal (+`attachTerminalWs`), preview, browser, dictation,
  multirun, fusion, walkthrough (+review flow), schedule, usage, knowledge, github,
  control (`/api/control/sessions` list/new/fork/abort), snippets, profiles
  (agent profiles + model/agent aggregation), settings (behavior/MCP/plugins/system info),
  goals.
- `behavior.ts` / `mcp.ts` — server-owned behavior instructions (`behavior.md`) and MCP
  server config (`mcp.json`), applied to OpenCode through the adapter's config applier.
- `search.ts` — pure workspace matcher (projects/sessions metadata, `is:archived`).
- `permissionPreview.ts` — redacted, risk-scored previews built server-side before
  `permission/requested` is appended.
- `review.ts` — structured review generation + the bounded implementer/reviewer flow
  (pauses on permission waits, hard iteration limit, structurally cannot merge/push).
- `oneshot.ts` — single-turn utility completion on a runtime (used by goals auditor,
  commit messages, fusion synthesis, walkthrough generation).

## REST surface

Core: `/api/health`, `/api/projects` (+`/create`, DELETE), `/api/sessions`
(list/create/snapshot/events/message/shell/fork/rewind/rewind-clear/abort/archive/restore/bulk),
`/api/sessions/:id/queue` (+`/order`, DELETE item),
`/api/sessions/:id/permission/:reqId`, `/api/sessions/:id/question/:reqId` (+`/reject`),
`/api/models`, `/api/agents`.

Feature routes: `/api/folders`, `/api/labels`, `/api/search/workspaces`,
`/api/search/sessions` (metadata + transcript snippets), `/api/files/*`
(tree/stat/read/raw/write/mkdir/rename/delete/upload/search), `/api/commands`,
`/api/snippets`, `/api/git/*` (status/diff/show/stage/unstage/discard/commit/commit-message/
log/graph/branch(es)/checkout/folder/stash/stashes/fetch/pull/push), `/api/worktrees` (+`/remove`), `/api/terminals`,
`/api/preview` (+start/stop), `/api/browser/*` (sessions/capability/approvals),
`/api/dictation` (+capability), `/api/multiruns`, `/api/fusions`, `/api/walkthroughs`,
`/api/schedule` (+preview/loops/loops/rescan), `/api/usage/quotas` (+refresh),
`/api/knowledge`, `/api/github/*` (status/repo/issues/prs/pr/checks/comments/diff/files),
`/api/control/sessions`, `/api/agent-profiles`, `/api/settings/behavior`,
`/api/mcp/servers`, `/api/plugins` (+install), `/api/system/info`,
`/api/sessions/:id/goal*`.

Errors are `{ error: code, message }` with mapped status; a dead OpenCode transport
returns 503 `unavailable` (the pool respawns on the next call).

## WS protocol (`/ws`)

Client → server: `subscribe {sessionId, afterSeq}`, `browser/subscribe
{browserSessionId, afterRevision}`, `dictation/start {dictationId}`, `dictation/audio
{dictationId, seq, pcm(base64)}`.

Server → client: `event {event: SessionEvent}` (gap-fill then live, seq-deduped),
`projection {session}`, `browser/frame {revision, mime, data}`, `browser/event`,
`dictation/state|ack|transcript|error`, `error {code}`.

The client (`apps/web/src/sync.ts`) resends its subscription on reconnect and dedupes by
`(sessionId, seq)`, so replay and gap-fill never double-apply.

## Event vocabulary

Turn flow: `user/message`, `turn/started`, `assistant/chunk`,
`assistant/reasoning-chunk`, `assistant/message`, `tool/call`, `tool/result`,
`tool/error`, `turn/stopped`, `turn/failed`, `usage/recorded`.

Requests: `permission/requested` (with server-built preview + allowed scopes),
`permission/resolved`, `question/asked`, `question/answered`.

Session lifecycle: `session/created`, `session/forked`, `session/archived`,
`session/restored`, `session/metadata-changed`, `session/imported`,
`session/history-imported`, `session/rewound`, `session/rewind-cleared`. Rewind
markers soft-splice model history in `deriveMessages`; replacement sends reset
the backend session before appending a new tail.

Delivery: `queue/enqueued`, `queue/dispatched`, `queue/reordered`, `queue/removed`,
`delivery/steered`, `delivery/fallback-queued`.

Work state (revisioned snapshots): `task/snapshot`, `subagent/snapshot`. The web
reducer turns task revision deltas into replay-stable created/started/completed
timeline rows; it never appends a second event for this UI derivation.

Workflows: `goal/attached|audit|completed|paused|resumed|stopped|stuck`,
`multirun/started|run-progress|completed|picked`, `fusion/started|completed`,
`walkthrough/generated`, `review/generated|risk-scored|submitted`,
`knowledge/attached`, `schedule/run-started`, `browser/action-requested|
action-completed|action-failed|observation`, `terminal/created|closed`,
`behavior/instructions-applied`.

Rules: types are `domain/past-tense`; payloads JSON-only; `ignorable: true` keeps an
event out of model-history derivation; `surfaceOp: "replace"` lets snapshots supersede
earlier ones in the UI while staying append-only on disk; unknown types must render as
a generic collapsed row (never crash).

## Web app structure (`apps/web/src`)

- `store.ts` — `useSyncExternalStore` app state: projects, sessions, per-session events,
  models/agents, active ids, `AppView` (session/files/goals/multirun/fusion/walkthrough/
  preview/git/terminal/schedule/github), overlays (onboarding/palette/search/settings),
  rail plugin, editor file + location.
- `reduce.ts` — event log → `RenderModel` (messages, pending permissions/questions,
  task deltas, edit-tool changed paths, subagents, usage) — pure and testable.
- `sync.ts` — reconnect-safe WS client (see above).
- `api.ts` — typed fetch wrappers over the REST surface.
- `slots.ts` — client slot registry mirroring the `UiSlot` union; exposed as
  `window.__polythSlots` for out-of-tree plugins.
- `components/` — views + panels. Notables: `Composer` (drafts, delivery modes, prompt
  token grammar from `composer/language.ts`, mic button via slot), `Timeline` +
  markdown pipeline (`markdown/` — fenced code, Mermaid, KaTeX, JSON tree, galleries,
  file references with go-to-line), `PendingChangesBar` (shared git-status source
  with edit-tool fallback), `QuestionCards` (multi-question stepper),
  `PermissionBanner` (preview + scoped Always), `WorkStatus` (usage/tasks/agents
  sections + tracker pills), `ContextRail` (files/changes/context/usage/events/knowledge
  rail with `contextRail.tabs` slot), `CommandPalette` (commands/workspaces/files,
  `Mod+P` file mode), `EditorView` (pane tabs via `workspace/paneStore.ts`, per-tab
  IME-safe autosave, `editor/liveFile.ts` revision/conflict checks, sandboxed
  Markdown/HTML previews), `GitView`, `GithubView`/`PullRequestView`,
  `ScheduleView`, `GoalsView`/`GoalStrip`, `MultiRunView`, `FusionView`,
  `WalkthroughView`/`GeneratedWalkthrough`, `PreviewView` (iframe + browser driving),
  `TerminalView`, `SettingsModal`/`SettingsView` + `settings/registry.ts`
  (item-level search), `Onboarding` (personas), `SessionSearch`.
- Preferences: `settings.ts` (`polyth.settings`), `uiPrefs.ts` (including
  `polyth.editorPrefs`), `sidebarPrefs.ts`,
  `modelPrefs.ts`, `prefs.ts` (personas/enabled plugins), `drafts.ts`
  (`polyth.draft.<sessionId>`) — all browser-local. Server-owned settings go through
  `/api/settings/*` routes.
- `notifications.ts` — kind-filtered, allowlisted-template, replay-deduped web
  notifications; `voice.tsx` — browser TTS/STT with the composer mic slot.

## UI slot model

`UiSlot` (contracts) enumerates injection points: `app.nav`,
`session.header.actions`, `session.list.badges`, `composer.leading`,
`composer.trailing`, `contextRail.tabs`, `settings.pages`,
`commandPalette.commands`, `workspace.main.tabs`, `workspace.right.tabs`,
`session.timeline.before/after`, `session.message.actions`,
`sidebar.project.actions`, `sidebar.session.actions`, `workStatus.sections`.

Server-side plugins contribute `UiSlotItem` descriptors (module keys, capability
requirements) through `PluginContext.contribute`; the client registry
(`slots.ts`) renders them. Built-in features register through the same registry —
extending a slot must never require editing `App.tsx`.

## Persistence layout (`POLYTH_DATA_DIR`, default `./data`)

`sessions.db` (events, projections, queue, folders, labels, profiles),
`knowledge.db`, `projects.json`, `schedule.json`, `quotas.json`,
`walkthroughs.json`, `behavior.md`, `mcp.json`, `plugins/` + `trusted-plugins/`,
`browser-shots/`.

## Security posture

Localhost-first (bind address is configuration, never the Host header). Permission
engine fails closed. Browser sessions run in isolated contexts with an origin policy
(no cam/mic, no private IPs, no downloads); observations are redacted. Quota adapters
redact secrets before snapshots reach the client. GitHub auth is delegated to the `gh`
CLI — no tokens stored. Uploaded files land in a project `_inbox`. There is no UI
auth layer yet (see parity: security domain).
