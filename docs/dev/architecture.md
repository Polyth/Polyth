# Polyth architecture (as built)

Snapshot of the system as it exists on this branch. This replaces the old milestone
plan; nothing here is aspirational — every item is in the tree today.

## Orientation (read this first)

One-minute map for a new agent; everything after this section is the deep reference.

- **One UI, one server.** `apps/web` (React 19 SPA, esbuild) talks REST `/api/*` + WS `/ws` to `packages/server` (node:http composition root). Electron embeds it with a local server; Capacitor embeds the same build as a client of an existing server. The server wires every feature service and lazily spawns `opencode serve` per project through `packages/backend-opencode` — the only package allowed to touch the OpenCode process/API.
- **Truth lives in the event log.** `packages/session` stores append-only events in SQLite (WAL). Anything model-visible is appended before the UI sees it; `deriveMessages` rebuilds model history from the log (skipping `ignorable` events).
- **Contracts first.** `packages/contracts` is the normative surface — mostly types (DTOs, `SessionEvent`, `UiSlot`) plus a few runtime exports (`cap`, `CAP`, `UI_SLOTS`, `isUiSlot`, `MODEL_VISIBLE_TYPES`). `packages/kernel` provides plugin scopes, capabilities, and slot contributions. Built-in feature services are wired directly at the composition root (`packages/server/src/index.ts`), not dynamically loaded; the kernel and the installed-plugin registry are the plugin seams.
- **Extending the server:** add a feature package exposing a `RouteHandler` and register it at the composition root — never edit `packages/server/src/http.ts`.
- **Extending the UI:** feature UI lives in the feature package
  (`packages/<feature>/widgets/`) and registers through `@polyth/web-sdk`
  (`defineWebPackage` → `WebPackageHost`: slots, widgets, system package
  windows, capabilities, settings, project context, reducers). The host owns the
  registries (`apps/web/src/slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `capabilities.ts`, `settings/registry.ts`)
  and renders contributions through `SlotHost`/surface hosts — never edit
  `App.tsx`/`Main.tsx` for a feature. Full guide: `docs/dev/ui.md`.
- **Feature packages** (one directory each under `packages/`): permissions, goals, files, editor, git, commands, terminal, multirun, fusion, walkthrough, schedule, knowledge, github, usage, browser, dictation, models, hotkeys, plugins, ssh, secure-safe, home-assistant, task-trackers, workflow, example-feature.
- **Conventions:** erasable TS on Node >= 22.14 (type stripping; no
  enums/namespaces/parameter properties), explicit `.ts` on local imports,
  `@polyth/*` workspace imports, `node --test` + `node:assert`. Full rules: `/AGENTS.md`. Feature workflow: `docs/dev/README.md`. Feature status: `docs/parity/polyth-parity.yaml`.

## Topology

```
apps/web (React 19, esbuild bundle, no framework server)
   ├─ apps/desktop (Electron: starts a loopback server + bundled OpenCode)
   ├─ apps/mobile (Capacitor: connects to an existing Polyth server)
   │  REST /api/*        WS /ws (sessions, browser frames, dictation audio)
   │                     WS /ws/terminal/:id (JSON terminal frames)
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
| `contracts` | DTOs, `SessionEvent`, service interfaces, `UiSlot` union (types) plus runtime values: `cap()`, `CAP` capability keys, `UI_SLOTS`/`isUiSlot`, `MODEL_VISIBLE_TYPES`. The normative surface. |
| `kernel` | Scoped plugin contexts: `provide`/`inject`/`optional` capabilities (priority + registration order), `on`/`emit`/`waterfall` events, LIFO effect disposal, `contribute()` for UI slot items, `loadPlugin` with manifest requirement checks, profile resolver (bundles → ordered plugin list). |
| `session` | Append-only event store. `append` allocates monotonic per-session `seq` transactionally; projections (`SessionProjection`) are updated alongside; also owns queue items, folders, labels, projection-only session pins, agent profiles, and transcript text search (`searchEventText`). `deriveMessages` turns the log into model history (skips `ignorable`). |
| `backend-opencode` | The only OpenCode integration point. Spawns/attaches `opencode serve`, translates its SSE into `RuntimeEvent`s, maps canonical session ids ↔ backend ids, applies behavior/MCP config (`createConfigApplier`), imports pre-existing OpenCode sessions, snapshots task/subagent state as revisioned events. |
| `permissions` | Monotonic fail-closed rule engine; scopes user/project/session; deny beats allow; "always" persists a rule at the chosen scope. |
| `goals` | Objective attach/audit loop: small-model auditor verdicts (`keep`/`done`/`stuck`), budgets, auto-continuation, pause/resume; rehydrates from the event log after restart. |
| `files` | Path-jailed file service: tree/stat/read (revision = mtime+size), revision-guarded `write` (stale `baseRevision` → `conflict`), binary-overwrite refusal, mkdir/rename/delete/upload, scored file search (shared with palette + mentions). Explorer + file `ResourceProvider`; does not own CodeMirror. |
| `editor` | Sole CodeMirror 6 owner: one `EditorView` per visible group, `EditorState` retained per tab, honest language grammars (JS/JSX/TS/TSX/JSON/YAML/Markdown). Registers Authoring and Development workbench profiles. |
| `git` | Porcelain wrapper: status/diff/show/stage/unstage/discard/commit/log/graph/branches/checkout/stash/fetch/pull/push/worktrees, diffHead/diffRange for review flows. Session-scoped Git routes resolve an owned worktree cwd server-side. |
| `commands` | Slash commands + `#alias` snippets: project (`.polyth/commands`, snippets in `.polyth/snippets`) and user scopes, `$ARGUMENTS`/`@file`/`!cmd` template expansion, CRUD for the settings UI. |
| `terminal` | Terminal sessions on a real PTY when the optional `node-pty` dependency builds (full-screen TUIs, true resize), falling back to piped `node:child_process` shells (COLUMNS/LINES exported, resize → SIGWINCH) otherwise; create/list/close/rename; bounded per-terminal replay ring (default 200 KB, UTF-8-tear-safe) replayed on every `/ws/terminal/:id` attach; terminals survive socket drops — close only via REST or process exit. The web client renders through its own VT emulator (`apps/web/src/terminal/emulator.ts`): cell grid + scrollback, 16/256/truecolor SGR, alternate screen, mouse reporting, OSC 8 links, DSR/DA replies. |
| `preview` | Dev-server lifecycle per project: script detection, `PORT` injection, status events, URL for the iframe preview. |
| `multirun` | N parallel one-shot runs (model/agent matrix) inside a session; per-run progress events; pick-a-winner. |
| `fusion` | Multi-model answers + small-model synthesis with weights, attribution, disagreements. |
| `walkthrough` | Generated diff walkthroughs (stable hunk ids, digest-keyed cache) + structured review generation (`ReviewAssessment`) shared with the review flow. |
| `schedule` | at/every/cron cadences (IANA time zones), overlap policies, run history (cap 50), file-authoritative Markdown loops under `<project>/.agents/loops`. |
| `knowledge` | Notes/plans/memories store (own SQLite) with revisions, tags, search; attaching logs `knowledge/attached` (exact revision + digest) before the model sees it. |
| `github` | `gh`-CLI-backed repo/issues/PR list, PR detail/files/diff/comments, failure-first checks aggregation, guarded review submit + risk/confidence labels. No tokens stored. |
| `usage` | Provider-neutral quota adapter contract: jittered polling, in-flight dedup, backoff, bounded last-good persistence, secret redaction, pace/prediction from multi-sample history. Real providers plug in via `data/quota-providers.json` (`createHttpQuotaProvider`): HTTP endpoint + bearer credential referenced by env-var name, so tokens never sit in config or reach the browser. |
| `browser` | Agent-drivable Chromium (playwright-core) or fake driver: URL/origin policy (blocks unsafe schemes, private IPs, DNS rebinding, downloads), stale-frame rejection, redacted observations, viewport + color-scheme emulation, JPEG frame stream, honest `unavailable` engine state. |
| `dictation` | Server streaming dictation protocol: lifecycle via REST, PCM chunks via `/ws` with acks + `(id,seq)` dedupe + replay-from-last-ack, `SttAdapter` seam plus `createWhisperSttAdapter` (finalize-once WAV upload to any OpenAI-compatible `/audio/transcriptions` endpoint); the service takes an adapter *provider* so capability follows live settings. |
| `models` | Model preference logic: favorites, provider/name/recent sort, search (shared by picker + settings). |
| `hotkeys` | Keymap model: default bindings, user overrides, conflict detection, sequence matching. |
| `plugins` | Installed-plugin registry (install/enable/disable from dir sources, trust classes, contribution manifests). |
| `server` | Composition root + everything HTTP/WS: see below. |

`apps/web` is the host shell of the single React UI implementation: React 19,
bundled by `apps/web/build.ts` (esbuild), served statically by the server with
SPA fallback. Feature UI is bundled separately per package
(`apps/web/buildPackages.ts` → `packages/<id>/dist/web/`, published via
`/packages-manifest.json`) and activated only when the server says the package
is enabled (`apps/web/src/packages/webEntries.ts` + `registry.ts`). Disabled
packages stay at catalog metadata. `apps/desktop` and
`apps/mobile` are platform shells around that canonical output; mobile never
starts Node or OpenCode. See `docs/mobile/architecture.md`.

## Server internals (`packages/server/src`)

- `index.ts` — `boot()`: data dir, store, project service, permission service, per-project
  **runtime pool** (lazy `opencode serve` per project/cwd, transport-error respawn with a
  stable facade), broadcast box, goal service wiring, multirun/fusion runners, schedule
  runner (visible sessions per target mode), walkthrough/review/review-flow jobs,
  usage service, browser/dictation services, the `routes` array, HTTP+WS attach, shutdown.
- `sessions.ts` — canonical session service: create/fork/archive/restore/rename/organize
  (folder/labels plus projection-only pin positions),
  authoritative worktree-path validation + branch/state projection metadata,
  send with **delivery admission** (`normal` | `steer` | `queue` | `interrupt`,
  steer falls back to queue with `delivery/fallback-queued`), queue CRUD + dispatch,
  runtime event → durable log translation, permission preview enrichment, question/permission
  replies with `dismissPending`, turn hooks (goals), usage/projection updates.
  F18: per-session auto-accept policy (`on`/`off`/`inherit`, nearest-parent
  resolution from `@polyth/permissions`, store in `data/auto-accept.json`) —
  policy-approved requests append `permission/requested` +
  `permission/resolved{auto:true}` back-to-back and reply to the runtime without
  ever setting `waiting`; enabling reconciles already-pending requests
  (composer-shell confirmations stay manual); the effective flag rides the
  projection. A `notify` seam fires `attention` (permission/question that
  actually reached the UI) and `turnStopped` for out-of-page delivery.
- `http.ts` — core REST (health, projects, sessions, models/agents) + `RouteHandler`
  chain + static bundle. Feature packages never edit this file. F16: one auth gate
  runs before all routing — every `/api` path 401s without a session cookie except
  `/api/auth/status` and `/api/auth/login`; static assets stay public so the SPA
  shell can render the lock screen.
- `auth.ts` (F16) — optional UI password: `crypto.scrypt` hashing
  (`scrypt$salt$hash`), random 32-byte cookie tokens stored as SHA-256 hashes in
  `data/auth.json` (remembered devices survive restarts; 30-day idle expiry;
  lastSeen writes throttled), clock-injected login rate limiter (10 failures /
  10 min window → 15 min lockout with `Retry-After`; clients without a socket
  address share one "anon" budget). Password comes from `POLYTH_UI_PASSWORD`
  (hashed at boot, never persisted) or a `passwordHash` in `auth.json`;
  `POLYTH_UI_PASSWORD_LOCALHOST=optional` lets loopback connections skip auth.
  Off entirely when no password is configured.
- `push.ts` (F18) — web push in `node:crypto` only: aes128gcm payload encryption
  (RFC 8291) + VAPID ES256 authorization (RFC 8292). Keys are minted once into
  `data/push.json` (rotation would orphan every browser subscription) and
  subscriptions persist beside them; `send` encrypts per subscription and drops
  dead endpoints (404/410). `createPushNotifier` bridges the session service's
  notify seam to templated payloads (same allowlisted bounded semantics as the
  in-page notifier): subagent completions attribute to the parent session,
  aborted turns stay silent, and auto-accepted permissions never reach the seam.
  Human-needed payloads bind `sessionId` + `requestId`; simple closed
  single-choice questions may include at most two bounded quick answers.
- `ws.ts` — `/ws` gateway: `subscribe` (gap-fill from the durable log, then live, seq-deduped),
  projections fan-out, per-socket rate limits, browser frame stream with newest-frame
  backpressure + `afterRevision` resume, dictation audio path with its own rate budget.
- `routes/` — one file per feature: org (folders/labels/bulk/search), workspace
  (files/commands), git, terminal (+`attachTerminalWs`), preview, browser, dictation,
  multirun, fusion, walkthrough (+review flow), schedule, usage, knowledge, github,
  agent control (`/api/agent`: complete discoverable session control plus backend
  session browse/import), snippets, profiles
  (agent profiles + model/agent aggregation), settings (behavior/MCP/plugins/system info),
  voice (engine settings + TTS proxy + summarize), assist (F9 settings + recap
  read + chat→note), auth (F16 status/login/logout/logout-all/device sessions),
  autoAccept (F18 per-session policy GET/PATCH), push (F18 key/subscribe/test), goals.
- `behavior.ts` / `mcp.ts` — server-owned behavior instructions (`behavior.md`) and MCP
  server config (`mcp.json`), applied to OpenCode through the adapter's config applier.
  Disabled MCP servers are removed from the applied config entirely (F10); secret
  values live in `mcp-secrets.json` and are never returned by any API.
- `search.ts` — pure workspace matcher (projects/sessions metadata, `is:archived`).
- `permissionPreview.ts` — redacted, risk-scored previews built server-side before
  `permission/requested` is appended.
- `review.ts` — structured review generation + the bounded implementer/reviewer flow
  (pauses on permission waits, hard iteration limit). The implementer is a normal
  tool-capable session: the handoff prompt instructs it not to merge/push/publish,
  but nothing structurally prevents it.
- `oneshot.ts` — single-turn utility completion on a runtime (used by goals auditor,
  commit messages, fusion synthesis, walkthrough generation).
- `assist.ts` (F9) — idle assist watcher: N quiet seconds after `turn/stopped` the
  small model writes a ≤20-word recap + ONE suggested follow-up, stored on the
  projection keyed to the log tail seq (never the event log — not model-visible
  until the user sends it); any newer event makes it stale. Hard off-by-default
  switch in `data/assist.json`; one flight per session. The same seam distills
  chat→note drafts.

## REST surface

Core: `/api/health`, `/api/projects` (+`/create`, DELETE), `/api/sessions`
(list/create/snapshot/events/message/shell/fork/rewind/rewind-clear/abort/archive/restore/bulk;
`message` accepts `attachments` — shape-checked, path-traversal-rejected and
existence-verified against the session root before anything is logged or queued;
URL attachments are link-only and never fetched server-side),
`/api/sessions/:id/queue` (+`/order`, DELETE item),
`/api/sessions/:id/permission/:reqId`, `/api/sessions/:id/question/:reqId` (+`/reject`),
`/api/models`, `/api/agents`.

Feature routes: `/api/folders`, `/api/labels`, `/api/search/workspaces`,
`/api/search/sessions` (metadata + transcript snippets), `/api/files/*`
(tree/stat/read/raw/write/mkdir/rename/delete/upload/search), `/api/commands`,
`/api/snippets`, `/api/git/*` (status/diff/show/stage/unstage/discard/commit/commit-message/
log/graph/branch(es)/checkout/folder/stash/stashes/fetch/pull/push; optional owned
`sessionId` selects its worktree), `/api/worktrees` (+`/remove`), `/api/terminals`
(POST input, PATCH rename, DELETE close; `/ws/terminal/:id` replays scrollback then streams live),
`/api/preview` (+start/stop; optional owned `sessionId` selects its worktree), `/api/browser/*` (sessions/capability/approvals),
`/api/dictation` (+capability), `/api/multiruns`, `/api/fusions`, `/api/walkthroughs`,
`/api/schedule` (+preview/loops/loops/rescan), `/api/usage/quotas` (+refresh),
`/api/knowledge`, `/api/github/*` (status/repo/issues/prs/pr/checks/comments/diff/files;
F7 writes: `pr/create`, `pr/update`, `pr/merge` — merge requires `confirm:true` and a
squash/merge/rebase strategy, never deletes the branch; `pr/describe` returns a
small-model title+body draft from `git diff base...HEAD` and never submits),
`/api/agent/sessions`, `/api/agent/backend-sessions` (GET unadopted OpenCode
sessions `{items, total}`; POST `/import {projectId, ids}` adopts selected —
listing sessions no longer auto-adopts), `/api/agent-profiles`, `/api/settings/behavior`,
`/api/mcp/servers` (CRUD + POST `:id/test`|`:id/probe` reachability check that
stores status/lastError; `:id/authorize` is an honest 501 until the backend
bridge exists), `/api/plugins` (+install), `/api/system/info`,
`/api/settings/voice` (GET/PUT engine endpoints in `data/voice.json`; API keys are env-var
*names*, never values — GET returns only `configured` flags), `/api/tts/speak`
(proxy to the configured OpenAI-compatible `/audio/speech`, buffered audio back, only
standard fields forwarded, honest 503 when unconfigured), `/api/tts/summarize`
(small-model shortening for read-aloud; 503 when no small model is wired),
`/api/settings/assist` (GET/PUT the F9 hard switch + quiet time),
`/api/sessions/:id/assist` (freshness-checked recap+suggestion — 404 `stale` the
moment the log outgrows it), `/api/sessions/:id/assist/note` (small-model chat→note
DRAFT; saving goes through the normal `/api/knowledge` flow),
`/api/auth/*` (F16: GET `status {required, authorized}` and POST `login {password}`
are the only public `/api` paths — login mints an httpOnly SameSite=Strict
`polyth_auth` cookie, 401 `invalid-password` on a miss, 429 `rate-limited` +
`Retry-After` when the IP window locks; POST `logout` / `logout-all`, GET
`sessions` device list, DELETE `sessions/:id` per-device revoke),
`/api/sessions/:id/permissions/auto-accept` (F18: GET `{setting, effective}`,
PATCH `{setting: on|off|inherit}` — the explicit setting is stored on the
canonical session projection; enabling reconciles live and reconnected pending
requests through the same server resolver),
`/api/push/key` (VAPID public key + subscription count), `/api/push/subscribe`
(POST registers the browser's PushSubscription, DELETE removes by endpoint),
`/api/push/test` (POST sends a test notification to every subscription; never
creates a notification-centre row), `/api/notifications` (NTF-01: GET
`{items, unread}` oldest-first from the server-owned inbox in
`data/notifications.json`, optional `after=<ts>` cursor over strictly
increasing timestamps while `unread` stays global; POST `read {ids}`,
`read-all`, `clear` — bodies carry opaque notification ids only, never a
project/session scope; rows are recorded at the push notifier's send sink,
newest 200 retained FIFO),
`/api/sessions/:id/goal*`.

Errors are `{ error: code, message }` with mapped status; a dead OpenCode transport
returns 503 `unavailable` (the pool respawns on the next call). When a UI password
is set (F16), every `/api` path except `/api/auth/status` + `/api/auth/login`
answers 401 `unauthorized` without a valid session cookie, and `/ws` +
`/ws/terminal/:id` upgrades are rejected at the socket with HTTP 401.

## WS protocol (`/ws`)

Client → server: `subscribe {sessionId, afterSeq}`, `browser/subscribe
{browserSessionId, afterRevision}`, `dictation/start {dictationId}`, `dictation/audio
{dictationId, seq, pcm(base64)}`.

Server → client: `event {event: SessionEvent}` (gap-fill then live, seq-deduped),
`projection {session}`, `notification/added {notification: NotificationRecord}`
(NTF-01: unfiltered global fan-out after the inbox commit and before web push —
never buffered into gap-fill state; REST `after=<ts>` owns reconnect catch-up),
`browser/frame {revision, mime, data}`, `browser/event`,
`dictation/state|ack|transcript|error`, `error {code}`.

The client (`apps/web/src/sync.ts`) resends its subscription on reconnect and dedupes by
`(sessionId, seq)`, so replay and gap-fill never double-apply.

## Event vocabulary

Turn flow: `user/message` (optionally carrying sanitized `attachments:
AttachmentRef[]` — file/image/range/url; persisted before the runtime sees
them, so replay/fork keeps them), `turn/started`, `assistant/chunk`,
`assistant/reasoning-chunk`, `assistant/message`, `tool/call`, `tool/result`,
`tool/error`, `turn/stopped`, `turn/failed`, `usage/recorded`.

Requests: `permission/requested` (with server-built preview + allowed scopes),
`permission/resolved` (carries `auto: true` when the session's F18 auto-accept
policy resolved it — appended immediately after the request so the log stays
truthful while no banner shows), `question/asked`, `question/answered`.

Session lifecycle: `session/created`, `session/forked`, `session/archived`,
`session/restored`, `session/metadata-changed`, `session/imported`,
`session/history-imported`, `session/rewound`, `session/rewind-cleared`. Rewind
markers soft-splice model history in `deriveMessages`; replacement sends reset
the backend session before appending a new tail.

Delivery: `queue/enqueued`, `queue/dispatched`, `queue/reordered`, `queue/removed`,
`delivery/steered`, `delivery/fallback-queued`. Queued items keep their
attachments durably (queue table column); steering is text-only, so a steer
with attachments falls back to queue (`steer-attachments`).

Work state (revisioned snapshots): `task/snapshot`, `subagent/snapshot`. The web
reducer turns task revision deltas into replay-stable created/started/completed
timeline rows; it never appends a second event for this UI derivation.

Workflows: `goal/attached|audit|completed|paused|resumed|stopped|stuck`,
`multirun/started|run-progress|completed|picked`, `fusion/started|completed`,
`walkthrough/generated`, `review/generated|risk-scored|submitted`,
`pr/created|updated|merged` (F7 external writes, logged to the originating
session before the response), `knowledge/attached`, `schedule/run-started`,
`track/step-started|step-completed|step-failed`, `track/completed`,
`browser/action-requested|action-completed|action-failed|observation`,
`terminal/created|closed`, `behavior/instructions-applied`.

Rules: types are `domain/past-tense`; payloads JSON-only; `ignorable: true` keeps an
event out of model-history derivation; `surfaceOp: "replace"` lets snapshots supersede
earlier ones in the UI while staying append-only on disk; unknown types are safely
ignored by the web reducer (never crash).

## Web app structure (`apps/web/src`)

- `store.ts` — `useSyncExternalStore` app state: projects, sessions, per-session events,
  models/agents, active ids, `AppView` (session/goals/multirun/fusion/walkthrough/
  schedule/github — files, Git, terminal, and preview are workspace panes opened
  beside a still-mounted Chat via `openWorkspacePane()`, not `AppView` values;
  legacy persisted ids map onto panes), overlays (onboarding/palette/search/settings),
  rail plugin, editor file + location.
- `reduce.ts` — event log → `RenderModel` (messages, pending permissions/questions,
  task deltas, edit-tool changed paths, subagents, lifetime usage plus the latest
  turn input sample for the context estimate) — pure and testable.
- `sync.ts` — reconnect-safe WS client (see above).
- `api.ts` — typed fetch wrappers over the REST surface.
- `slots.ts` — client slot registry mirroring the `UiSlot` union; the
  host-internal implementation behind `host.slots.register`. Also exposed as
  `window.__polythSlots` for legacy out-of-tree plugins.
- `packages/` — the web package loader: `webHost.ts` implements the
  `WebPackageHost` from `@polyth/web-sdk` over the host registries,
  `webEntries.ts` loads `/packages-manifest.json` as catalog metadata and
  activates an enabled package (CSS, module, factory, installer),
  `activation.ts` scopes host registrations to one owner package,
  `projectContext.ts` aggregates live per-project package snapshots,
  `registry.ts` (`bootPackages()`) enables/disables in sync with
  `/api/packages`, and `reducers.ts` hosts client-side event reducers.
- `widgets/` — widget system: `catalog.ts` (definitions + `registerWidget`/
  `registerWidgetPlugin`), `widgetLayout.ts` (zones, placement, per-instance
  config, `polyth.widgetLayout.<projectId>` localStorage persistence),
  `WidgetCanvas.tsx` (the drag/resize canvas), `widgetLibrary.ts`,
  `builtinWidgets.tsx`/`builtinMiniWidgets.tsx`/`capabilityWidgets.tsx`
  (shell widgets), `areas.ts`/`builtinAreas.ts` (placement areas). Full
  guide: `docs/dev/widgets.md`.
- `components/` — views + panels. Notables: `Composer` (drafts, delivery modes, prompt
  token grammar from `composer/language.ts`, mic button via slot), `Timeline` +
  markdown pipeline (`markdown/` — fenced code, Mermaid, KaTeX, JSON tree, galleries,
  file references with go-to-line; L13: windowed rendering via `timelineWindow.ts` —
  long sessions render only the last 150 rows as a suffix window, "Show earlier"
  reveals anchored, prompt jumps grow the window; the prompt-navigator rail gains a
  hover-preview card with the bounded full prompt; `SelectionMenu` floats over
  transcript selections with Quote in reply / New session from selection / Copy,
  pure helpers in `selectionActions.ts`), `PendingChangesBar` (shared git-status source
  with edit-tool fallback), `QuestionCards` (multi-question stepper),
  `PermissionBanner` (preview + scoped Always), `WorkStatus` (usage/tasks/agents
  sections + tracker pills), `ContextRail` (F17 surface host: renders the
  declarative registry in `surfaces.ts` — built-ins self-register in
  `railSurfaces.tsx`, plugins contribute via the `workspace.right.tabs` slot or
  `window.__polythSurfaces` — with keep-alive mounting for visited panels,
  content-driven visibility, badges, and per-surface width + last-open persisted
  in `polyth.railPrefs`; `contextRail.tabs` slot unchanged), `CommandPalette` (commands/workspaces/files,
  `Mod+P` file mode), `EditorView` (pane tabs via `workspace/paneStore.ts`, per-tab
  IME-safe autosave, host `resources/liveFile.ts` revision/conflict checks, sandboxed
  Markdown/HTML previews), `GitView` + `WorktreeSessionDialog` (sidebar/Git/palette
  entry points, existing-or-new worktree selection, branch-template suggestions),
  `GithubView`/`PullRequestView` (F7: `+ session` bootstraps a session with the
  issue/PR as the composer draft; merge is gated on `mergeable` + explicit
  confirm; `PrCreatePanel` in GitView prefills via describe but never
  auto-submits),
  `AssistStrip` (F9: fresh recap under the last message + a dismissible
  suggestion chip that fills the composer and never sends),
  `ScheduleView`, `GoalsView`/`GoalStrip`, `TracksPanel` (Knowledge package
  contribution through `workspace.right.tabs`), `MultiRunView`, `FusionView`,
  `WalkthroughView`/`GeneratedWalkthrough`, `PreviewView` (iframe + browser driving,
  device/color-scheme emulation, pointer/keyboard rectangular annotations, screenshot-to-chat),
  `TerminalView` (F12: tab strip with double-click rename and confirm-close
  while running; reconnects with backoff reusing the same terminal id, replay
  frames replace the local buffer so reattach never duplicates),
  `SettingsModal`/`SettingsView` + `settings/registry.ts`
  (item-level search), `Onboarding` (personas), `SessionSearch`.

Phase 3 Wave 2 keeps command ownership at the extension seam:
`commandBridge.ts` adapts `commandPalette.commands` slot descriptors into the
shared command registry, while `CommandPalette` uses `ResponsiveOverlay` for
its dialog/sheet presentation. Session continuity surfaces share the pure
`sessionStatus.ts` taxonomy. Recoverable failures stay in place: a delayed
reconnect pill lives in the header contribution, failed sends retain the draft
with an inline retry, and a failed-turn tail can seed (but never send) the last
user text.

- Theming (F15): `theme.ts` — JSON token schema (surface/line/ink/brand/signal/
  syntax roles) resolved to CSS custom properties at one apply point
  (`applyTheme`); 6 bundled presets, `theme: "system"` follows
  `prefers-color-scheme` live, custom themes are pasted JSON validated with the
  rejection reason and stored in `polyth.customThemes`. `styles.css` derives
  every surface (diff washes, syntax roles, user bubble, glows) from tokens via
  `var()`/`color-mix`; Mermaid re-renders from live token values on the
  `polyth:theme` event.
- Preferences: `settings.ts` (`polyth.settings`), `uiPrefs.ts` (including
  `polyth.editorPrefs`), `sidebarPrefs.ts`,
  `modelPrefs.ts`, `prefs.ts` (personas/enabled plugins), `usagePrefs.ts`
  (`polyth.usagePrefs`: F13 quota-card model-family grouping helper plus
  per-provider visibility and collapsed-group persistence), `drafts.ts`
  (`polyth.draft.<sessionId>`) — all browser-local. Server-owned settings go through
  `/api/settings/*` routes.
- `attachments.ts` (F2) — pending composer pills per session
  (`polyth.draft.att.<sessionId>`; the draft store owns text + pills): stat-verified
  project-file/range refs, `_inbox/` uploads for drops/pastes and annotated browser
  captures, GitHub PR/issue URL pills gated on the project's remote
  (`/api/github/repo`). Rendered by
  `AttachmentPills` (composer: removable; timeline: read-only) and the shared
  `FileRowActions` menu (Open / Copy path / Add to chat) on Files/Changes rows.
- `notifications.ts` — kind-filtered, allowlisted-template, replay-deduped web
  notifications; `voice.tsx` — engine-aware TTS/STT with the composer mic slot
  (browser Web Speech by default; server engines via `/api/tts/speak` and the
  `/ws` streaming dictation client in `dictationClient.ts`, with optional
  summarize-before-speak through `/api/tts/summarize`).
- Access control (F16): `main.tsx` checks `/api/auth/status` before `init()`
  runs — when a password is required and the device has no session,
  `LockScreen` renders instead of the app (login → cookie → normal boot). A
  401 on any non-auth endpoint dispatches `polyth:auth-required`, which
  re-locks the UI (reload-on-unlock keeps store/WS state clean). Settings →
  Access lists remembered devices with per-device revoke and "Sign out
  everywhere".
- Auto-accept + push/PWA (F18 + OC-24-003/004): the `Header` shows a loud pulsing chip while the
  session's effective auto-accept is on (click toggles; server owns the
  policy); `reduce.ts` marks policy-resolved permissions `auto` so the
  timeline can label them. `push.ts` registers the root-scope service worker
  at authenticated app boot (`sw.js`, plain JS copied verbatim to `dist/`),
  while `manifest.json` + 192/512 any/maskable icons make the root-scoped app
  installable in standalone mode. Enabling push mints a `PushSubscription`
  against the server's VAPID key, and keeps the server list in sync;
  Settings → Notifications has the toggle + test button (needs a secure
  context — https or loopback). The worker shows notifications only when no
  visible window exists. Permission pushes offer Allow once/Deny; a single
  closed single-choice question with at most two options exposes those choices;
  complex questions expose Answer/Reject and otherwise open the normal
  stepper. Actions call the existing authenticated session APIs with the
  payload's exact session/request pair. The session service serializes and
  validates the pending request, reattaches its runtime after restart, appends
  the resolution before replying, and rejects stale/cross-session duplicates.
  Failed or ordinary clicks deep-link via `postMessage` to an existing tab
  (handled in `init.ts` via `installPushDeepLinks`) or open
  `/?session=<id>`, which `boot()` resolves and strips. Nothing in this path
  implements a remote relay or E2EE pairing.

## UI extension model

`UiSlot` (contracts) enumerates injection points: `app.nav`,
`session.header.actions`, `session.list.badges`, `composer.leading`,
`composer.trailing`, `contextRail.tabs`, `settings.pages`,
`commandPalette.commands`, `workspace.main.tabs`, `workspace.right.tabs`,
`session.timeline.before/after`, `session.message.actions`,
`sidebar.project.actions`, `sidebar.session.actions`, `workStatus.sections`,
the widget placement slots (`workspace.header/left/main/right/bottom/floating`,
`widget.catalog`, `widget.settings`), and the fine-grained toolbar areas
(`app.header.leading/center`, `workspace.rail`, `sidebar.toolbar`,
`composer.meta/pending`, `session.footer`, `session.empty.widgets`,
`project.create.options`).

Feature web UI registers through the **web-sdk host**
(`@polyth/web-sdk`: `defineWebPackage` + `WebPackageHost` — slots, widgets,
system package-window surfaces, capabilities, settings pages/items, reducers,
store, navigation, ui, errors). The host implements that contract in
`apps/web/src/packages/webHost.ts` over the client registries
(`slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
`workspace/surfaceRegistry.ts`, `capabilities.ts`, `settings/registry.ts`,
`packages/reducers.ts`); `SlotHost` and the surface/canvas hosts render
contributions with per-contribution error isolation and deterministic
ordering. The built-in Chat remains the only internal workspace surface;
package homes are system windows from `surfaces.ts`, hosted by
`ContextRail.tsx` in dynamic, pinned, or fullscreen mode.

Installed server-side plugins declare `UiSlotItem` descriptors (slot + module
key) in their manifests, and `PluginContext.contribute` is the kernel seam —
but the production registry is wired with no slot sink and no client module
bridge, so those descriptors are validated and stored, not rendered. The
rendered extension path for packages is the web-sdk seam above; the
`window.__polythSlots`/`__polythWidgets`/`__polythSurfaces`/
`__polythCapabilities` globals remain for legacy
out-of-tree browser scripts.

## Persistence layout (`POLYTH_DATA_DIR`, default `./data`)

`sessions.db` (events, projections, queue, folders, labels, profiles),
`knowledge.db`, `projects.json`, `schedule.json`, `quotas.json`,
`quota-providers.json` (optional, hand-written: HTTP quota adapter specs),
`walkthroughs.json`, `behavior.md`, `mcp.json`, `plugins/` + `trusted-plugins/`,
`browser-shots/`, `auth.json` (F16: password hash + remembered device sessions —
token SHA-256 hashes only, never tokens or passwords), `auto-accept.json` (F18:
explicit per-session on/off records — "inherit" is the absence of a record),
`push.json` (F18: VAPID keypair + push subscriptions).

## Security posture

The server binds all interfaces: `boot()` calls `server.listen(port)` with no host
argument, so it is reachable on `*:4400` by default and no localhost-only bind
option exists — set `POLYTH_UI_PASSWORD` whenever anything beyond your own machine
can reach the port (with no password configured there is no auth at all). Addresses
shown in system info come from configuration, never from the Host header. Permission
engine fails closed. Browser sessions run in isolated contexts with an origin policy
(no cam/mic, no private IPs, no downloads); observations are redacted. Quota adapters
redact secrets before snapshots reach the client. GitHub auth is delegated to the `gh`
CLI — no tokens stored. Uploaded files land in a project `_inbox`. UI auth is the
optional F16 password gate described above (`auth.ts`): when a password is
configured it covers every `/api` path and WS upgrade; when none is configured
it is off entirely.
