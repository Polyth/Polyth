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
(209-row status matrix: 98 implemented, 35 implementing, 75 planned,
1 intentionally-changed).

---

## Unreleased — unified package-owned session import

### Changed — one import surface for every harness

- The project menu had two import actions: the host "Import sessions…" sheet
  (OpenCode-only backend adoption) and the `@polyth/session-import` widget's
  "Import conversation" (snapshot). They are now one entry owned by the
  package. `apps/web/src/components/ImportSessionsDialog.tsx` and the host
  menu entry were removed; the legacy `/api/agent/backend-sessions` route stays
  for programmatic callers and MCP tools.
- The package picker lists every registered harness that exposes a
  `SessionSourceProvider`, groups sessions per harness, and supports selecting
  individual conversations, a whole harness, or all at once. Native
  conversations Polyth already published are hidden (`total` / `imported`).
- Publication identity is derived from Space + project + provider + native
  reference, so re-importing the same conversation resolves to the existing
  canonical session instead of duplicating it. An explicit request id is still
  accepted.
- The picker UI is rebuilt on shared primitives with scoped package CSS that
  inherits font size, transparency, density, corner rounding and motion
  preferences, with a bottom-sheet layout on phones.

---

## Unreleased — recap package extraction and opt-in advanced features

### Changed

- Idle **Recap** is now a real optional package instead of core chat behavior. It owns its server generation lifecycle, settings/read routes, timeline contribution, package settings page, scoped styles, and tests. Package disablement cancels pending timers and prevents in-flight recap work from publishing.
- A neutral server turn-completion bus replaces the recap-specific core hook, keeping canonical session delivery independent from the optional feature.
- **Recap, Fusion, Knowledge, Multi-run, Personal Coach, and Walkthrough are disabled by default** for fresh package state. Home Assistant was already opt-in and remains disabled by default. Existing persisted package choices continue to win over defaults.
- Recap quiet-time data keeps using the existing `assist.json` path for migration compatibility, while package enablement is now the only feature on/off switch.

## Unreleased — project picker: inline "add project" sources

### Changed — alternative project sources are disclosed in place, not stacked dialogs

- The "Open a project" folder picker no longer opens a second modal for
  **Clone repository** or **Open on a server**. Each is now an inline
  disclosure inside the picker: the footer links expand a fields panel, only
  one is open at a time, and Escape collapses that panel before it closes the
  dialog. The panel owns the primary action (`Clone repository` /
  `Open remote project`) in the same place the local `Open project` button sat.
- **Clone** drops its redundant "destination parent folder" field for local
  clones — the picker's own folder browser is the destination, shown live as
  "Clones into …" and changed by browsing. The SSH-clone path keeps a single
  remote parent-path field.
- **Open on a server** is a "solo" source: while open it hides the local file
  manager and its own remote browser takes that space, instead of drawing a
  second file manager on top of the first.
- The `project.create.options` slot contract gains an inline context
  (`browsedPath`, `armedId`, `arm`/`disarm`) so contributed sources render as
  panels in the shared dialog frame rather than as `Dialog`s of their own.

## Unreleased — branch `feat/ssh-connection-plugin-dcfd` (2026-08-23)

Commits `92b11d2`, `e47c6c1` and the docs/parity follow-up.

### Added — SSH remotes: projects on servers, the agent runs on the host

- New `packages/ssh` feature package: a saved SSH-server inventory
  (`data/ssh-connections.json` — host/port/user/auth mode and at most a
  private-key file *path*; never passwords or key material, auth is the user's
  SSH agent or ssh_config) driving one multiplexed OpenSSH connection per host
  (`ControlMaster`, with `ControlPersist` idle disconnect) and exposing
  connect/disconnect/status plus cheap local mux health checks. The package
  implements the new generic `RemoteHost` exec/start/forward seam from
  contracts and knows nothing about OpenCode.
- `backend-opencode` gained `createRemoteOpenCodeRuntime`: a project bound to a
  server probes for the `opencode` binary and the workspace path, starts
  `opencode serve` ON the host (remote PID file for orphan reaping,
  port-collision retry), and reaches it through an SSH `-L` forward — the
  coding agent runs next to the files and only the conversation crosses the
  wire. Unreachable host, auth failure, missing binary, and missing path each
  surface as distinct, honest errors.
- Server: `/api/ssh/*` RouteHandler registered at the composition root —
  connection CRUD (secrets rejected on write, never returned), connect /
  disconnect / status, a round-trip test that also probes the remote runtime,
  remote directory browse, and remote project creation; deleting a connection
  with bound projects refuses. `Project` carries an optional `remote` binding
  (`projects.addRemote`), and the runtime pool picks the remote or local
  runtime per project.
- Web: Settings → SSH Remotes (inventory CRUD, connect/disconnect, test with
  latency + remote `opencode` version) and an "Open on a server…" source in
  the project picker contributed through the new `project.create.options` UI
  slot — a remote directory browser with optional folder creation.
- Parity matrix: OC-21-007 (saved servers + reachability) implemented;
  OC-21-008 (SSH remote managed/external) implementing — the managed
  install/upgrade half is not built.

---

## Unreleased — branch `feat/feature-parity-docs-impl-6b1a` (2026-08-20)

Commits `3928fe9`…`3ec11f2`, then the later-package (L) queue. Three things
happened on this branch: the docs were reset into a maintained developer
handbook, the "this-pass" web-parity slice (P1–P8 from
`docs/dev/implementation-order.md`) was implemented as eight contract-first
commits, and the L-queue packages started landing.

### Added — browser device emulation and annotated capture-to-chat

- Controlled browser sessions now carry their emulated color scheme end to end;
  Chromium applies it through media emulation, while light/dark/default changes
  and responsive, phone, tablet, laptop, and desktop viewport presets are
  available from the Preview toolbar and the agent browser-tool seam.
- Preview frames support drag-selected rectangular annotations with comments,
  plus a keyboard-only centered selection. `Send to chat` requests fresh server
  pixels, appends the persisted browser observation before returning them,
  renders the selection into a PNG, uploads
  it to the session worktree, and sends the comment/image through the normal
  attachment-backed user-message pipeline.

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

### Added — L2: PR lifecycle (F7)

- `packages/github`: `prCreate` (body via stdin, refuses flag-like refs, parses
  the PR number from the returned URL), `prUpdate` (title/body/base, at least
  one field), `prMerge` (squash/merge/rebase flags only — never
  `--delete-branch`). All gh-CLI, fail-soft, no stored tokens.
- Server: `POST /api/github/pr/create|update|merge` (merge requires
  `confirm:true` + a known strategy) and `POST /api/github/pr/describe` —
  small-model title+body from `git diff base...HEAD`, never auto-submits.
  Successful writes append `pr/created`, `pr/updated`, `pr/merged` to the
  originating session before the response.
- Web: `PrCreatePanel` in GitView ("Create PR" — AI prefill, editable, explicit
  submit), merge controls on `PullRequestView` gated on `mergeable` with the
  disable reason shown ("Merged via GitHub" labels the remote merge), Edit
  title/body on the overview, and "+ session" on issue/PR rows that creates a
  session with the issue/PR context saved as the composer draft (never sent).

### Added — L3: MCP management UI and health probe (F10)

- Settings → MCP is now full CRUD: edit prefills the structure (name,
  command/args or URL, secret key names) but never echoes stored secret
  values — leaving a value blank keeps the stored one.
- JSON import: paste an `mcpServers` block (Claude shape `{command, args,
  env}` / `{url, headers}` or OpenCode shape `{type:"local", command:[...],
  environment}`), preview the mapped entries (duplicates flagged), then save;
  env/header values become write-only secrets (`apps/web/src/mcpImport.ts`).
- `POST /api/mcp/servers/:id/probe` (spec name; `/test` kept) stores
  status/lastError from the reachability check; the UI button is "Probe".
- Disabled servers are now removed from the applied backend config entirely
  instead of being written with `enabled:false`. OAuth stays a follow-up
  (`:id/authorize` remains an honest 501).

### Added — L4: voice engines (F8)

- `packages/dictation`: `createWhisperSttAdapter({baseUrl, model, language,
  apiKey})` posts finalize-once WAV uploads (`pcmToWav`) to any
  OpenAI-compatible `/audio/transcriptions` endpoint; `downsampleToPcm16`
  converts browser Float32 capture to the protocol's 16 kHz mono s16le. The
  dictation service now takes an adapter *provider*, so `/api/dictation/capability`
  follows live settings without a restart. `VoicePrefs` grew
  `sttEngine`/`ttsEngine`/`pitch`/`volume`/`summarize`.
- Server: `data/voice.json` stores STT/TTS endpoints where API keys are env-var
  *names* — values are read from the server environment at call time and never
  echoed (`GET /api/settings/voice` returns `configured` flags only).
  `POST /api/tts/speak` proxies the configured `/audio/speech` and returns
  buffered audio, forwarding only standard OpenAI fields; `POST /api/tts/summarize`
  shortens long replies with the small model. Both are honest 503s when
  unconfigured/unwired.
- Web: engine pickers (Browser | Server) for dictation and read-aloud in
  Settings → Voice with endpoint forms and a TTS test button; pitch/volume
  sliders (server playback via WebAudio); summarize-before-speak toggle with
  raw-text fallback; the mic button streams PCM over `/ws`
  (`dictationClient.ts`: seq/ack flow control, reconnect replay, live partial
  transcripts) when a server engine is configured, else browser Web Speech.
- Raw audio and interim transcripts still never enter the session event log.

### Added — L5: small-model idle assist (F9)

- Server `assist.ts`: after a configurable quiet period past `turn/stopped`,
  the small model writes a ≤20-word recap and ONE suggested follow-up. The
  result lives on the session projection keyed to the settled log tail — never
  the event log (it is not model-visible unless the user sends it). Passive
  post-turn bookkeeping (usage/title/goal/isolation metadata) does not cancel
  or hide it; real conversation activity does. One flight per session;
  unusable model output and errors fail soft.
- Hard switch: `data/assist.json` via `GET/PUT /api/settings/assist`
  (off by default; disabled generates nothing at all).
  `GET /api/sessions/:id/assist` answers 404 `stale` once conversation
  activity moves past the recap. Toggle + quiet-time input in Settings → Chat.
- Web: `AssistStrip` renders the fresh recap under the last message plus a
  dismissible suggestion chip; tapping fills the composer and never sends.
  Dismissals are in-memory only.
- Chat→note: `POST /api/sessions/:id/assist/note` distills the transcript into
  a `{title, body}` draft with the same seam (503 unwired); the Knowledge
  panel's "From chat" button opens the draft in the note editor for review —
  saving goes through the normal `/api/knowledge` flow with `sourceSessionId`.

### Added — L6: terminal scrollback replay, resumable bind, tabs (F12)

- `packages/terminal`: bounded replay ring per PTY (default 200 KB,
  `POLYTH_TERM_REPLAY_BYTES`) — byte-exact within the cap and UTF-8-tear-safe:
  a `StringDecoder` on the live path reassembles multi-byte characters split
  across chunks, and the snapshot skips continuation bytes orphaned by
  eviction. New `replay(id)` and `rename(id, title)`; `TerminalInfo` carries
  `exitCode` for exited-but-not-closed terminals.
- Server: `/ws/terminal/:id` now replays the scrollback before live frames on
  every attach, reports `exit` state for dead processes, and answers
  `not-found` for unknown ids so client reconnect loops stop.
  `PATCH /api/terminals/:id` renames a tab.
- Web `TerminalView`: reloading the page reattaches to the same shells with
  visible scrollback (replay frames REPLACE the buffer — no duplicates);
  dropped sockets retry silently with 500ms→5s backoff reusing the same
  terminal id; tabs rename on double-click; closing a running shell asks
  first.

### Added — L7: sidebar import-browse for backend sessions (F14 import half)

- `GET /api/sessions` no longer silently adopts every OpenCode session. New
  `GET /api/agent/backend-sessions?projectId=` lists unadopted backend
  sessions (deduped, most recent first) plus an honest `total`, and
  `POST /api/agent/backend-sessions/import {projectId, ids}` adopts only the
  selected ones through the existing `backendSessionId` seam —
  `session/imported` is logged before the projection broadcasts, and history
  still hydrates lazily on first open. `sessions.sync` remains the
  programmatic bulk-adopt path.
- Sidebar project menu gained "Import sessions…": a sheet with per-session
  checkboxes, select-all, and distinct empty states ("no OpenCode sessions
  found" vs "all N already imported", PS#766).

### Added — L8: usage breakdown and real quota adapters (F13 quota half)

- Quota cards in Settings → Usage group windows by model family (pure
  `modelFamily`/`groupQuotaWindows` helpers, OC#355): family groups collapse
  and remember it, non-model windows stay in an honest General bucket.
- Per-provider visibility checkboxes; hidden providers and collapsed groups
  persist in browser-local `polyth.usagePrefs` and survive reload.
- Real quota providers plug in server-side via `data/quota-providers.json`
  (`createHttpQuotaProvider` in `@polyth/usage`): HTTP endpoint + optional
  `windowsPath` dot path, with the bearer credential referenced by env-var
  *name* so tokens never sit in config or reach the browser; endpoint failures
  degrade to the existing stale-with-reason snapshot path.

### Added — L9: themes with presets, custom JSON, and system-follow (F15)

- A theme is now a JSON token schema (surface, line, ink, brand, signal, and
  syntax color roles) resolved to CSS custom properties at one apply point;
  six presets ship (Ember Dark, Midnight, Forest, Parchment, Mist, Solar) and
  the pre-F15 "dark"/"light" settings values keep resolving to the originals.
- `theme: "system"` follows `prefers-color-scheme` and flips live; hovering a
  theme card previews it and leaving restores the saved pick.
- Custom themes: paste JSON in Settings → Appearance ("Copy current as JSON"
  gives a starting point); invalid input is rejected with the exact reason;
  themes persist in browser-local `polyth.customThemes`.
- Hardcoded-color audit: diff washes, status dots, permission-risk chips,
  glows, the user bubble, switches, and terminal/preview surfaces now derive
  from tokens via `var()`/`color-mix`; the tiny syntax highlighter's `tok-*`
  classes gained theme-driven colors; Mermaid re-renders from live token
  values on theme change. Light mode's previously dark user bubble now derives
  from the accent over the panel surface and is readable.

### Changed — L10: right-pane surface host (F17)

- `ContextRail` no longer enumerates panels: a declarative surface registry
  (`surfaces.ts`) drives the rail. Built-in panels (files, changes, context,
  knowledge, usage, events) self-register in `railSurfaces.tsx`; plugins add
  surfaces through the `workspace.right.tabs` slot or
  `window.__polythSurfaces.registerSurface` — no `ContextRail` edits needed.
- Keep-alive: visited panels stay mounted (hidden, not unmounted) when
  switching surfaces or closing the rail, so tree/editor/scroll state
  survives; surfaces whose plugin is toggled off unmount.
- Per-surface panel width (drag handle on the panel edge) and the last-open
  surface persist in browser-local `polyth.railPrefs` and are restored on
  reload.
- Content-driven visibility hooks (OC#2418): the usage surface stays hidden
  for a session until it has spent tokens; badges (changes count, event count)
  come from the same shared context — no second git-status poller.

### Added — L11: access control with UI password and remembered devices (F16)

- Optional UI password (off by default): set `POLYTH_UI_PASSWORD` in the
  server environment (or a `passwordHash` in `data/auth.json`) and every
  `/api` and `/ws` answer requires a device session; static assets stay
  public so the SPA can render a lock screen. `crypto.scrypt` hashing,
  random 32-byte cookie tokens, httpOnly `SameSite=Strict` `polyth_auth`
  cookie — the server stores only token SHA-256 hashes.
- Login rate limiting per OC#269: 10 wrong passwords inside 10 minutes lock
  the client IP for 15 minutes with `429` + `Retry-After` (clients without a
  socket address share one budget); the lock screen counts the retry down.
- Remembered devices survive restarts (`data/auth.json`), expire after 30
  idle days, and are managed in Settings → Access: per-device revoke and
  "Sign out everywhere" (`POST /api/auth/logout-all`). WS upgrades without a
  valid cookie are rejected at the socket; a mid-session 401 re-locks the UI.
- `POLYTH_UI_PASSWORD_LOCALHOST=optional` is the only bypass: loopback
  connections skip auth, everything else still needs the cookie.

### Added — L12: server auto-accept and web push notifications (F18)

- Per-session auto-accept policy owned by the canonical session (OC#2158): `on`, `off`,
  or `inherit` (the default), resolved to the nearest ancestor with an
  explicit setting — subagents inherit, a child's `off` opts out, the root
  default is off, never global. Explicit choices persist on the session
  projection (older `data/auto-accept.json` entries migrate once); GET/PATCH
  `/api/sessions/:id/permissions/auto-accept`.
- Policy-approved requests persist `permission/requested`, a durable response
  intent, and `permission/resolved{reply:"once", auto:true}` without publishing
  an actionable request, so the event log stays truthful while no banner or
  notification fires; deny rules still win. Enabling reconciles already-pending
  live or reconnected requests and returns the
  session to `working`; composer-shell confirmations stay manual. A loud
  pulsing header chip shows while the effective policy is on.
- Web push (OC#944/OC#199): VAPID (RFC 8292) + aes128gcm payload encryption
  (RFC 8291) implemented on `node:crypto` alone — no push libraries. Keys are
  minted once into `data/push.json`, subscriptions persist beside them, dead
  endpoints (404/410) drop on send. Payloads reuse the in-page notifier's
  bounded, control-stripped template semantics.
- Root-scope service worker (`sw.js`, plain JS copied verbatim to `dist/`)
  shows notifications only when no visible window exists and deep-links
  clicks back to the session — `postMessage` to an existing tab or a new
  window at `/?session=<id>`. Settings → Notifications gains the push toggle
  and a test button; loopback counts as a secure context. Subagent
  completions attribute to the parent session; aborted turns stay silent;
  auto-accepted permissions never push.

### Added — L13: selection quick actions, prompt hover previews, timeline windowing (F3 remainder)

- Selection quick actions (OC#283/OC#1501): selecting transcript text floats a
  mini-menu — Quote in reply (markdown-quotes the selection into the composer,
  bounded so a select-all cannot flood the draft), New session from selection
  (the quote becomes a fresh session's draft, nothing is sent — same bootstrap
  pattern as the GitHub "+ session" flow), and Copy. Buttons act on mousedown
  so the selection survives the click.
- Prompt-navigator hover previews (OC#2054/OC#2211): hovering or focusing a
  rail item shows a preview card with the bounded full prompt text beside the
  rail, so "which prompt was that?" never needs a scroll away.
- Timeline windowed rendering: long sessions render only the last 150 rows —
  the window is a suffix, so appends and follow-scroll are unchanged. "Show
  earlier / Show all" reveals with the viewport anchored (no jump), and
  navigator/timeline-dialog jumps to a hidden prompt grow the window exactly
  far enough first. Pure helpers in `timelineWindow.ts`; presentation-only —
  the event log and render model never change.

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
- New routes: agent control (`/api/agent/sessions`), github,
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
