# Changelog

All notable changes to Polyth, reconstructed from the full git history (initial
commit through the current branch). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); entries are grouped as
product milestones rather than per-commit, newest first. The project has no
version tags yet, so milestones are named after what shipped. Short commit
hashes are given per milestone for traceability.

Companion docs: `docs/dev/architecture.md` (the system as built),
`docs/dev/parity.md` (what upstream does vs what Polyth does),
`docs/dev/new-features.md` (specs F1–F18 for the remaining gaps),
`docs/dev/implementation-order.md` (sequencing P1–P8 done, L1–L13 next),
`docs/dev/HANDOFF.md` (the live handoff), `docs/parity/polyth-parity.yaml`
(209-row status matrix: 66 implemented, 42 implementing, 100 planned,
1 intentionally-changed).

---

## Unreleased — branch `feat/feature-parity-docs-impl-6b1a` (2026-08-20)

Commits `3928fe9`…`3ec11f2`, then the later-package (L) queue. Three things
happened on this branch: the docs were reset into a maintained developer
handbook, the "this-pass" web-parity slice (P1–P8 from
`docs/dev/implementation-order.md`) was implemented as eight contract-first
commits, and the L-queue packages started landing.

### Added — L1: message attachments on the wire (F2)

- Contracts: `AttachmentRef` gained `kind` ("file" | "image" | "range" |
  "url"), `path`, and `range`; `ModelMessage` gained a `file` part;
  `CanonicalTurnRequest` and `QueueItemDto` carry attachments.
- Server: `/api/sessions/:id/message` accepts `attachments`, sanitizes them
  (shape, mime, size vs the shared upload cap, path traversal, http(s)-only
  URLs) and existence-checks paths against the session root — deleted files
  refuse attachment — before persisting them in `user/message` data. Queued
  messages keep attachments durably (queue table column); steer with
  attachments falls back to queue (`steer-attachments`).
- Adapter (`backend-opencode`, the only L-queue adapter change): attachments
  map to OpenCode `file://` parts on `startTurn` (line ranges via
  `?start=&end=`); URL attachments ride as link-only text parts and are never
  fetched server-side.
- Web: removable composer pills fed by drag-drop, the file picker, pasted
  images, and pasted GitHub PR/issue URLs (pill only when `/api/github/repo`
  matches); pills persist in the per-session draft store; Files/Changes rows
  share an Open / Copy path / Add to chat menu; timeline user messages render
  their attachments (image thumbnails from the sanitized raw endpoint).

### Removed — stale planning artifacts (`3928fe9`)

- `docs/features/*` — the 19-file upstream research dump (polyth/Paseo PR
  indexes, gap analysis, per-domain feature notes, old implementation order,
  test plan). Superseded by `docs/dev/*`.
- `docs/PLAN.md` — the original milestone-1 build contract; its invariants now
  live in `docs/dev/README.md`, its architecture in `docs/dev/architecture.md`.
- `Polyth UI mockups kickoff.zip` and `docs/ui-sample/index.html` — static UI
  mockups that the shipped UI has replaced.

### Added — developer handbook (`599b6a2`, `f3fad3c`)

- `docs/dev/README.md` — how to build a feature from zero: the three seams
  (RouteHandler, append+broadcast, typed UI slot), ground rules, step-by-step
  checklist, test/runbook commands.
- `docs/dev/architecture.md` — as-built snapshot: packages, server internals,
  REST surface, WS protocol, event vocabulary, web app structure, slot model,
  persistence layout, security posture.
- `docs/dev/parity.md` — narrative parity map vs polyth + Paseo across 15
  product domains (HAVE / GAP / N/A), sourced from all 1,039 merged polyth
  and 1,092 merged Paseo PRs.
- `docs/dev/new-features.md` — implement-now catalog F1–F18 (why, seam,
  contracts, UI, acceptance, tests, risks per feature).
- `docs/dev/implementation-order.md` — work packages: this-pass slice P1–P8,
  later packages L1–L13.
- `docs/dev/HANDOFF.md` — the scope contract for the implementation pass.
- `docs/dev/pr-index.json` — machine-readable disposition of every scanned
  upstream PR.
- Refreshed `docs/parity/polyth-parity.yaml` against the actual code; pointed
  `README.md` and `AGENTS.md` at the new docs.

### Added — this-pass web parity, P1–P8

Each landed as one commit, contracts before UI, with parity-matrix and
architecture-doc updates in the same commit.

- **P1 — Session rewind, redo, fork-from-message** (`0d0be86`): new
  `session/rewound` / `session/rewind-cleared` marker events; `deriveMessages`
  soft-splices the tail after the marker (history stays append-only; the
  adapter resets the backend session before the replacement send);
  `POST /api/sessions/:id/rewind` + `/rewind/clear`, rejected during a running
  turn; timeline hover actions (Rewind here / Fork from here), collapsed dimmed
  undone tail with Restore, composer prefilled with the reverted prompt.
- **P2 — Composer shell mode + prompt history** (`85cc4ca`): a leading `!`
  runs the command through a bounded executor backed by `@polyth/terminal`,
  gated by the `shell` permission family (deny → a visible rejected tool card;
  ask → a real `permission/requested` with preview); output is appended as
  `tool/call` + `tool/result` events (`producerPlugin: "composer-shell"`) so it
  is model-visible next turn, and is length-capped. ArrowUp/Down at the input
  edges cycles previously sent prompts without losing the unsent draft
  (`composer/history.ts`).
- **P3 — Git deepening** (`23061d3`): `@polyth/git` gains per-commit `show`,
  stash save/apply/drop, and fetch/pull/push (explicit remote,
  `GIT_TERMINAL_PROMPT=0`, errors surfaced verbatim, no credential storage);
  `/api/git/show|stash*|fetch|pull|push` routes; GitView commit rows expand to
  their diff, stash section, Sync button with per-step errors; unified/split +
  whitespace + wrap toggles persisted in `polyth.gitPrefs`
  (`apps/web/src/gitPrefs.ts`).
- **P4 — Pending-changes bar + task timeline rows** (`60cd688`): pure-UI
  derivation, no new events. `PendingChangesBar` above the composer counts
  changed files from a shared git-status source (`gitStatusStore.ts`, one
  poller shared with the rail) with an edit-tool fallback
  (`pendingChanges.ts`), jumps to the diff, auto-clears on commit/new send.
  The reducer turns `task/snapshot` revision deltas into replay-stable
  created/started/completed timeline rows.
- **P5 — Editor autosave + preview modes** (`cb305af`): debounced IME-safe
  autosave with Saving…/Saved states driven by the pure `editor/liveFile.ts`
  state machine; stale `baseRevision` conflicts offer Reload vs Overwrite
  (Overwrite only when locally dirty), deleted files get a recreate notice;
  sandboxed `srcdoc` HTML preview and Markdown preview with an
  open-in-preview-by-default pref (`polyth.editorPrefs`).
- **P6 — Session pinning** (`2fa12b9`): `pinned: { position } | null` on the
  organize patch; projection-only pins in the session org store (never the
  event log); pinned section above every sidebar grouping mode with persisted
  drag reorder.
- **P7 — Context gauge** (`3b33b8f`): estimated context-window fill computed
  in the reducer from the latest turn's `usage/recorded` input sample against
  the active model's `context` metadata; rendered in the Header and
  ContextRail, labeled as an estimate, honest "unknown" when the model has no
  metadata.
- **P8 — Worktree sessions from the UI** (`3ec11f2`): `WorktreeSessionDialog`
  (from the sidebar project menu, GitView worktree rows, and the palette)
  picks an existing worktree or creates one with a branch-template suggestion,
  then creates the session with `worktreePath`; session-scoped git, terminal,
  and preview routes resolve the owned worktree cwd server-side; session rows
  are badged with their branch.

### Notes for next work

The remaining catalog is specced in `docs/dev/new-features.md` and sequenced as
L1–L13 in `docs/dev/implementation-order.md`. **Not done yet**: L1 attachments
on the wire (F2 — the only near-term adapter change), L2 PR lifecycle (F7),
L3 MCP management UI (F10), L4 voice engines (F8), L5 small-model assist (F9),
L6 terminal replay + tabs (F12), L7 sidebar session import (F14 import half),
L8 usage breakdown + real quota adapters (F13 quota half), L9 themes (F15),
L10 right-pane surface host (F17), L11 access control (F16), L12 server
auto-accept + web push (F18), L13 selection quick actions + hover previews +
timeline virtualization (F3 remainder). Start at L1.

---

## Previous shipped work (master)

### polyth and Paseo web parity features — PR #3 (`c27c6a5`, 2026-08-20)

The largest expansion (~28k insertions, 204 files): closed a broad swath of the
parity matrix across every product domain.

#### Added — new packages

- `browser` — agent-drivable Chromium (playwright-core) or a deterministic fake
  driver: URL/origin policy blocking unsafe schemes, private IPs, DNS
  rebinding, and downloads; stale-frame rejection; redacted observations; JPEG
  frame stream; honest `unavailable` engine state.
- `knowledge` — notes/plans/memories store (own SQLite) with revisions, tags,
  search; attaching appends `knowledge/attached` (exact revision + digest)
  before the model sees the content.
- `plugins` — installed-plugin registry: install from directory sources, trust
  classes, enable/disable, contribution manifests.
- `usage` — provider-neutral quota adapter contract: jittered polling,
  in-flight dedup, backoff, bounded last-good persistence, secret redaction,
  pace/prediction from multi-sample history.

#### Added — session & delivery

- Delivery admission on send: `normal` | `steer` | `queue` | `interrupt`,
  with steer falling back to queue via `delivery/fallback-queued`; durable
  queue with CRUD, reorder, and dispatch events (`queue/enqueued|dispatched|
  reordered|removed`); `QueuedMessageList` UI.
- Session organization: nested folders with cycle guards, labels,
  archive/restore + bulk ops with partial-failure reporting, transcript text
  search (`searchEventText`), workspace search with `is:archived`.
- Agent profiles (send-time resolution with repair reporting) and
  `/api/agent-profiles`.
- Permission previews: redacted, risk-scored previews built server-side before
  `permission/requested` is appended; scoped Always (user/project/session) in
  the banner UI.

#### Added — server & adapter

- Structured review generation plus a bounded implementer↔reviewer flow
  (pauses on permission waits, hard iteration cap, structurally cannot
  merge/push) — `review.ts`.
- Server-owned behavior instructions (`behavior.md`) and MCP config
  (`mcp.json`) applied to OpenCode through the adapter's new config applier;
  settings routes for both.
- `backend-opencode`: imports pre-existing OpenCode sessions
  (`session/imported`), snapshots task/subagent state as revisioned events
  (`task/snapshot`, `subagent/snapshot` with `surfaceOp: "replace"`).
- Dictation: full server streaming protocol — lifecycle via REST, PCM chunks
  over `/ws` with acks, `(id,seq)` dedupe, replay-from-last-ack, and an
  `SttAdapter` seam (no engine ships by default).
- Schedule grew cron cadences with IANA time zones, overlap policies, run
  history, and file-authoritative Markdown loops under `.agents/loops`.
- GitHub grew failure-first checks aggregation and guarded idempotent review
  submit with risk/confidence labels.
- Walkthrough grew generated diff walkthroughs (stable hunk ids, digest-keyed
  cache) shared with the review flow.
- New routes: browser, dictation, knowledge, org, profiles, settings, usage;
  WS gateway extended with browser frame streaming (newest-frame backpressure,
  `afterRevision` resume) and the dictation audio path with its own rate
  budget.

#### Added — web app

- Markdown pipeline rewrite (`markdown/`): fenced code, Mermaid (lazy, zoom,
  fullscreen), KaTeX, JSON tree, image galleries, file references with
  go-to-line, sanitization.
- `AdaptiveTextInput` + tested prompt-token grammar (`composer/language.ts`):
  `/commands`, `#snippets`, `@file` mentions at any caret, fenced spans
  opaque; composer focus dialog; multi-question stepper with IME-safe
  text/Other and copy as Markdown/JSON.
- Sidebar `SessionList` with grouping modes flat/folder/status/worktree
  (persisted, plugin-extensible), attention badges from durable events.
- `WorkStatus` (usage/tasks/agents sections + tracker pills), editor pane tabs
  (`workspace/paneStore.ts`: keyed tabs, dirty guard, reorder, keep-alive),
  `PullRequestView`, `KnowledgePanel`, `GeneratedWalkthrough`,
  `AgentProfileForm`, `ViewErrorBoundary` per view.
- Kind-filtered, allowlisted-template, replay-deduped web notifications;
  settings registry with item-level search; a11y primitives (dialog focus
  management, live regions, roving tabindex).
- Tests: ~20 new suites across delivery, org, review, settings, browser
  routes, WS dictation, markdown, notifications, panes, question serializers,
  sidebar grouping, and more.

Also added the `docs/features/*` research corpus and refreshed the parity
matrix (both superseded on the current branch by `docs/dev/*`).

### UI polish to match and exceed polyth — PR #2 (`d4f1247`, 2026-08-19)

#### Added / Changed

- Replaced the prototype tab strip with an icon view switcher; composer card
  with starter suggestion chips; centered session hero for empty sessions;
  shared `EmptyState`; layered dark chrome across all views.
- Settings modal with left-nav pages; Settings gear in the sidebar.
- Human session titles with status dots (UUID titles hidden); the status bar
  always shows a model token; "Inactive" for a stopped preview.
- Static UI target sample under `docs/ui-sample` (removed later once the real
  UI matched it).

#### Fixed

- OpenCode SSE fetch no longer poisons session create: `/event` is streamed
  over `node:http` instead of undici fetch, transient REST errors are retried,
  a dead runtime is respawned once, and failures return 503 `unavailable`
  instead of a raw fetch-failed 500. `alert()` replaced with an inline error
  banner.

### Plugin-first workspace UI with polyth-shaped plugins — PR #1 (`da7696b`, 2026-08-19)

#### Added — new packages

- `schedule` (timed prompts service), `github` (`gh`-CLI-backed repo/issues/PR
  lists, no tokens stored), `models` (favorites/provider/recent sort, search),
  `hotkeys` (default bindings, user overrides, conflict detection, sequence
  matching), `dictation` (initial dictation seam; the server streaming
  protocol came in PR #3).
- New routes: control (`/api/control/sessions` list/new/fork/abort), github,
  schedule, snippets.

#### Added — web app

- Persona onboarding, command palette, slot-driven icon rail, settings shell
  with pages (commands, integrations, models, sessions, shortcuts, voice).
- Files panel as a nested tree with syntax-highlighted preview/edit, binary
  upload, hidden-files toggle, and drag-and-drop into the session; full-screen
  file editor with selection-to-chat.
- Per-session composer drafts (autosave, cleared on send), `ScheduleView`,
  `GithubView`, `SessionSearch`, web notifications, voice (Web Speech
  dictation + speechSynthesis TTS), model favorites in the picker, palette
  file search.

#### Fixed

- Saved persona restored instead of re-onboarding on every reload (TDZ bug in
  `load()`); composer `@path` inserts no longer clobber drafts via a stale
  closure.

### Multi-run, fusion, walkthrough, preview, terminal, and git views (`155ec7c`, 2026-08-19)

#### Added — new packages

- `multirun` — N parallel one-shot runs (model/agent matrix) inside a session
  with per-run progress events and pick-a-winner.
- `fusion` — multi-model answers plus small-model synthesis with weights,
  attribution, and disagreements.
- `walkthrough` — first walkthrough service (later extended with generation
  and review in PR #3).
- `preview` — dev-server lifecycle per project: script detection, `PORT`
  injection, status events, URL for the iframe preview.
- `terminal` — PTY sessions (`node-pty` when present) with create/list/close
  and the `/ws/terminal/:id` byte stream.

#### Added — server & web

- Routes for multirun, fusion, preview, terminal, and walkthrough, plus the
  multirun runner; contracts extended with the new event families
  (`multirun/*`, `fusion/*`, `terminal/*`).
- Web views: `MultiRunView`, `FusionView`, `WalkthroughView`, `PreviewView`,
  `TerminalView`, `GitView`, `GoalsView`, `StatusBar`, header view switching;
  richer markdown rendering.
- (Also added the UI mockups zip, removed on the current branch.)

### Initial monorepo — Milestone 1 "working web product" (`84e776c`, 2026-08-18)

The founding commit (~11.5k lines): a plugin microkernel with OpenCode as the
first backend, plus a working React web product. The invariants set here still
hold: kernel implements no product feature; every capability is an explicit
contract key; **model-visible means logged** (append-only `SessionEvent` log is
conversation truth; replay reconstructs identical model history); permissions
fail closed and are monotonic; UI extends via typed slots; only
`packages/backend-opencode` may talk to the OpenCode process (grep-gated);
erasable TypeScript only, run directly by Node 22.

#### Added — packages

- `contracts` — type-only normative surface: `SessionEvent` envelope
  (`{id, sessionId, seq, time, type, data, ignorable?, surfaceOp?, …}`),
  `AgentRuntime`, `SessionService`, `PluginContext`, `UiSlot`, capability keys.
- `kernel` — plugin loader with manifest requirement checks, scoped contexts
  (`provide`/`inject`/`optional` with priority), reversible effects (LIFO
  disposal), typed `on`/`emit`/`waterfall` events, `contribute()` for UI slot
  items, profile resolver (bundles → ordered plugin list).
- `session` — append-only event store on `node:sqlite` (WAL): transactional
  per-session `seq`, `events(afterSeq)`, fork via copy-at-seq,
  `deriveMessages` (skips `ignorable`), sessions projection.
- `backend-opencode` — spawns `opencode serve` per project, REST + SSE client,
  translates OpenCode events into canonical `SessionEvent`s, bridges
  permissions/questions, discovers models/agents.
- `permissions` — monotonic fail-closed rule engine (deny beats allow,
  once/always).
- `server` — `node:http` composition root: REST `/api/*` (health, projects,
  sessions, message/abort/fork/archive/restore, permission/question replies,
  models, agents), `/ws` gateway with subscribe + gap-fill from the durable
  log then live (seq-deduped), one-shot utility completions, static bundle
  serving.
- `goals` — objective attach + small-model auditor loop
  (`keep`/`done`/`stuck` verdicts), `goal/*` events.
- `commands` — slash commands + `#alias` snippets with
  `$ARGUMENTS`/`@file`/`!cmd` template expansion (project + user scopes).
- `files` — path-jailed file service: tree/stat/read/write, uploads.
- `git` — porcelain wrapper: status/diff/stage/unstage/discard/commit/log/
  branches.

#### Added — web app & docs

- `apps/web` (React 19, esbuild bundle): sidebar (projects/sessions), chat
  timeline with streaming chunks and reasoning, tool cards, composer with
  model/agent pickers, permission banner, question cards, goal strip, files
  panel, changes panel, context rail, project form; reconnect-safe WS sync;
  client slot registry.
- `docs/PLAN.md` (the build contract, since retired) and the first
  `docs/parity/polyth-parity.yaml`.
- Test suites (`node --test`, plain `node:assert`) for kernel, session,
  adapter, commands, files, git, goals, and a web smoke suite — the testing
  pattern every later milestone follows.

---

## Remaining gaps

Polyth is not at full polyth/Paseo parity. The authoritative list is
`docs/dev/new-features.md` — still open: **F2** (attachments on the wire),
**F7–F10** (PR lifecycle, voice engines, small-model assist, MCP management
UI), **F12–F18 remainder** (terminal replay/tabs, usage quota half, sidebar
import half, themes, access control, right-pane surface host, server
auto-accept + web push), and the F3 remainder (selection quick actions).
Sequencing lives in `docs/dev/implementation-order.md` as **L1–L13**;
row-level status in `docs/parity/polyth-parity.yaml`. The next pass starts at
**L1 — attachments on the wire** (see `docs/dev/HANDOFF.md`).
