# Changelog

All notable changes to Polyth. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); entries are grouped as
product milestones, newest first. The project has no version tags yet, so
milestones are named after what shipped.

---

## Unreleased — isolated chats keep their chat images after merge

### Fixed

- Chat images in an isolated chat no longer break after the chat is merged or
  discarded. A chat image is a project-relative path rendered against the
  session's current checkout; untracked media that only lived in the isolated
  worktree (agent screenshots, a non-`_inbox` upload) used to 404 once the
  worktree was deleted. Releasing an isolation record now copies the media the
  session's history references into the destination checkout first, without
  overwriting existing files.

---

## Unreleased — open-source release preparation

### Added

- Polyth is licensed under the Apache License 2.0 (`LICENSE`), with a
  contributor guide (`CONTRIBUTING.md`) and a security policy (`SECURITY.md`).
- The README is rewritten around the current product, with new screenshots of
  the desktop, dark theme, settings and phone layouts.

### Changed

- `npm run polyth:restart` no longer ships deployment defaults for a specific
  host. When it has to create the supervisor unit it reads `HOST`, `PORT`,
  `POLYTH_PUBLIC_ORIGIN`, `POLYTH_TRUSTED_PROXIES`,
  `POLYTH_DEBUG_AGENT_ACCESS` and `POLYTH_WEB_BUILD_FRESHNESS` from
  `~/.config/polyth/restart.env` (the environment wins); without that file the
  unit binds loopback only.

### Removed

- Committed build outputs (the Polyth Link binaries under
  `apps/desktop/resources/polyth-link/`, which the desktop build compiles),
  generated media and reports, dated evidence files and the one-time agent-kit
  installer with its manifests.

## Unreleased — curated fresh-install defaults; beta packages warn

### Changed

- **Fresh installs start with the curated package set.** Knowledge and
  Multirun are now on by default; Docker, IDE mode and the Command Code
  harness are off. Every package that ships off is a preview and declares
  `maturity: "beta"` (Docker, IDE mode, Command Code, Fusion, Personal Coach,
  Recap, Walkthrough) or `"in-progress"`. Settings → Packages badges it
  **Beta** / **In progress**, and while one is on its row warns that it is not
  well tested. Existing installs keep their recorded package choices.
- **Default harness order** (Auto and Harness Settings) is now Claude Code,
  OpenCode, Pi, Antigravity, Codex, Cursor. Saved per-Space harness
  preferences still win.

---

## Unreleased — unfinished packages ship off and say so

### Changed

- **Package descriptors declare maturity.** `polyth.descriptor.maturity:
  "in-progress"` marks an unfinished package; it must be disabled by default
  and Settings → Packages shows an **In progress** badge. Workflows (its live
  browser gate is red), Example Feature (proof of concept), and the fx, Grok
  Build and OMP harnesses (no tests yet) are now off by default on fresh
  installs; Playground and Creative Studio stay off and are marked in
  progress. Existing installs keep their recorded package choices.

### Removed

- **Chat Workspace moved out of the monorepo** into its own
  `polyth-chat-workspace` repository, with the package history. Its host
  wiring went with it: desktop device runtime and `desktop:chat-workspace:*`
  IPC, the WebSocket `chat-workspace/*` frame bus, its contract DTOs and web
  registrations. The Browser package's manual-only profile driver and the
  Handoff package's `sourceKind: "chat-workspace"` provenance value stay.

## Unreleased — readable prompt navigator

### Changed

- **Prompt navigator rows read as sentences** ([docs/dev/ui.md](docs/dev/ui.md)
  "Conversation prompt bookmark"). The rail's hover panel and the bookmark peek use text
  one pixel larger, a short leading mark that echoes the tape (accent for the
  current or pointed-at turn), and labels that start with a capital letter
  without heading/quote/list markers. Commands, mentions, paths and
  identifiers keep their spelling; rail previews skip code-fence lines and
  hold up to 128 characters across two lines.

## Unreleased — phone motion that follows the finger

### Changed

- **Settings closes the way it came** ([docs/dev/ui.md](docs/dev/ui.md)
  "Surface motion"). Opened from the Navigator, phone Settings takes the
  Navigator's side: it slides in over it from the left and a right-to-left
  swipe closes it, the layer following the finger. Opened anywhere else it is
  pushed from the right and swiped back to the right. A settings page is
  pushed over the list and Back (button, Escape, Android Back or a swipe) pops
  it with the list peeking in beneath.
- **The phone Workspace page** leads with Back on the left (no Close) and turns
  editing on and off with an Edit switch; its Back swipe follows the finger
  while editing too.
- **Every menu, popover, sheet, dialog, tour and toast now leaves with an exit
  animation** instead of vanishing, even when its owner simply stops showing
  it. Phone sheets rise from the bottom edge, follow a finger dragging them
  down (by the grabber, the title row, or content scrolled to the top) and
  carry on from where it let go.
- **The media viewer** pages with the finger (the image carries on off the
  edge while the next rides in) and closes with a pull down; the error toast
  can be swiped away; the tablet drawer opens and closes with a swipe and is
  mirrored in right-to-left layouts.

### Fixed

- Swipes no longer jump the 10–12px recognition distance when they start, a
  finger can catch a layer that is springing back, and a drag stranded by the
  app going to the background is released.
- After returning from a package window, the Workspace ignored the next Back
  swipe until it was reopened (a finished animation held its position).
- Navigator session rows trailed the finger while revealing Pin.

## Unreleased — mobile launch and reveal

### Changed

- **One launch picture, one reveal** on iOS, Android and phone browsers
  ([docs/mobile/platform-behavior.md](docs/mobile/platform-behavior.md) "Launch and
  reveal"). The native launch screen, the web shell's first paint, the
  Connection Hub and the Polyth Link bootstrap page all draw the same brand
  night with the 112 pt/dp Polyth mark centred. The workspace is revealed once,
  after projects, the restored chat, synced theme and wallpaper, package
  buttons and the branch label are in place. Every wait is capped.
- The Connection Hub opens a trusted server behind that picture. Its controls
  appear only when the user has something to do or read, with the mark flying
  into the hub's real brand mark.

### Fixed

- A white page with a "Continue" link flashed between the Connection Hub and
  the workspace (the Link bootstrap page).
- The phone boot blinked through a black frame, a bare wallpaper, an opaque
  "Loading projects" page and a dark-to-light theme switch.
- The New Chat branch chip changed two or three times after launch, because a
  finished worktree read was thrown away and redone. Composer buttons that a
  package registers late now fade in instead of popping.

## Unreleased — `polyth` command-line interface

### Added

- **`polyth` CLI** (`packages/cli`, [docs/dev/cli.md](docs/dev/cli.md)). List,
  read, follow and create sessions, chat interactively, send/queue/steer/stop,
  and script Polyth with `events`, `on`, `wait`, `--json`, stable exit codes and
  idempotent sends. Works on a server checkout or Docker (control socket), a
  remote web server (`polyth login` device sign-in), and Polyth Desktop
  (File → Install Command-Line Tool…, no separate Node.js).
- **Command-line access** in Settings → Command line: confirm terminal
  sign-ins, list and revoke CLI tokens, create long-lived automation tokens
  (read / run agents, optional Space pin, expiry), and the owner-only no-token
  mode for this computer or the private network. Tokens can never approve agent
  permission requests.
- Long-poll reads for HTTP-only clients (`waitMs` on forward replay and session
  summaries) and `GET /api/cli/whoami`.

### Changed

- Outside the `local-trusted` profile the control socket answers only health
  and discovery; people use per-person CLI tokens there.
- Account passwords need at least 8 characters (was 12) at setup, account
  creation, password changes and resets.
- `polyth-mcp` finds the control named pipe on Windows.

## Unreleased — Voice mode and refined dictation

### Added

- **Voice mode** (`packages/voice-mode`). A hands-free spoken conversation:
  talk, pause, and hear the agent reply while it is still writing. Your words
  stream into the composer and are sent through the composer's own Send path,
  so the message, target session, model and queue/steer behaviour are exactly
  what typing would produce. Replies are spoken sentence by sentence from the
  live stream; code and tables are summarised as "on screen"; reasoning is
  never read. Start talking (or tap) to interrupt. Desktop shows a compact
  dock above the composer; phones get a full-screen layer with a large
  audio-reactive orb, captions and thumb-sized controls. Keyboard: Space
  interrupts or sends, M mutes, Esc ends; the **Voice mode** shortcut is
  Mod+Shift+H. Settings → Voice mode: send on pause or on tap, pause length,
  interrupt by speaking (off automatically on iPhone/iPad, where an open
  microphone makes replies quiet), recognizer, layout, captions and sounds.
  A pending permission or question pauses voice mode instead of sending a
  message that would dismiss it.
- **Free engines out of the box.** Voice mode and dictation work with the
  browser's own recognizer and voices; the best natural/enhanced voice for
  the language is chosen automatically. Settings → Voice adds one-click setup
  for Groq Whisper (free tier) recognition and a local Kokoro voice.

### Changed

- **Dictation**: the **Dictate** shortcut (Mod+Shift+D) and palette command
  toggle the composer mic from anywhere; Escape stops it; holding the mic with
  a mouse or pen is push-to-talk. Browser recognition prefers the on-device
  recognizer when the browser offers one (with a language-pack download in
  Settings → Voice), and English spoken punctuation ("comma", "period",
  "new line") is applied as you speak.
- **Read aloud** speaks replies in sentence chunks (avoiding the long-utterance
  cut-off some browsers have), prefetches server clips one sentence ahead and
  falls back to the browser voice if the server voice fails.

---

## Unreleased — Workflows window: library and workflow pages

### Changed

- **The Workflows window is two pages.** It opens on a library: a search box,
  New workflow, "Your workflows" and "Templates". Choosing one opens that
  workflow's own page (back returns to the library) instead of an editor
  stacked under the library.
- **Library cards are compact.** Each card shows a small graph glyph, the
  name, a short description and "N agents · N stages" plus the last run's
  status. The full role chain is a tooltip only. Bundled examples drop the
  "Example ·" prefix for an Example badge and show the catalog description.
  Templates open with one click; Customize (copy icon) makes an editable copy.
- **A workflow page has Run and Edit tabs.** Run holds the request, the latest
  run and a collapsed Options panel. Edit holds the pipeline, the node
  inspector and Details. The header keeps undo/redo and a More menu
  (Duplicate, Delete). The redundant Save button, the duplicate Add node
  button and the "+" prefixes are gone; autosave status stays in the header.
- Opening a saved workflow now shows that workflow's latest run, not the run
  of whichever workflow loaded first.
- Newly seeded examples store their description.

---

## Unreleased — MCP tool schemas

### Fixed

- An MCP server whose tool declares an input schema nested deeper (or wider)
  than Polyth's bounds no longer reports zero tools: that one tool keeps a
  free-form object schema with a note in its description, and the server's
  other tools stay available (seen with `rozetka-mcp`). Oversized or malformed
  schemas still fail the inventory closed.

## Unreleased — optional status bar

### Added

- **Status bar setting** in Settings → Appearance → Layout, and a "Status bar"
  command in the palette: **Off** (the new default), **Workflows** (a slim strip
  only while a workflow run is active, in any view) or **Always**. It is never
  shown on phones.
- **Both ends of the bar are widget areas.** Project, Git branch (with commits
  ahead/behind), open file with the cursor position, changed files, model,
  agent, workflow progress and the current view are mini-widgets. Hold Shift
  over the bar (or use Edit layout) to hide, reorder or move them to the other
  end, drag one onto an empty end, or add Search, Settings, the notification bell
  and workspace-tool launchers. The arrangement is per project, like the other
  areas. The Customize menu also has **Hide status bar**.
- The project segment's dot now reports the live connection (connected,
  connecting, problem) and offers **Reconnect** when the connection is down.
- Branch and changed-file segments open Source control.

### Changed

- The bar used to be always on in every view except Chat. It is now off until
  you turn it on, and then shows in Chat too. With the setting **Off**, a
  running workflow no longer brings the bar back by itself; choose
  **Workflows** to keep that strip.
- A bar that is too narrow drops whole segments, last first, instead of
  clipping them. A workflow waiting on you is dropped last, and cannot be hidden
  from the bar. Long project, branch and model names end in an ellipsis with the
  full name in the tooltip; an open file keeps its file name and shortens its
  directory.
- The bar's wording is translated (it was English-only), a clean tree reads "No
  changes", and a folder that is not a Git repository no longer shows
  "0 changed files".

## Unreleased — workflow view layout and runs

### Fixed

- Workflow results and node output no longer show tall runs of blank lines: the
  chat card and the workflow view collapse recorded gaps to one blank line, and
  new runs stop recording them.
- "View workflow" on a run opens that workflow with the preset library
  collapsed and the run in view, and choosing a saved workflow collapses the
  library too, instead of leaving the editor and run screens below the gallery.
- A failed or stopped run now offers the run form, so the next run is a new,
  explicit request, and Run again repeats the recorded request even after a
  reload instead of doing nothing.

## Unreleased — account limits and user management

### Added

- **Account limits** in Settings → Users, for any account except the server
  owner and independent of Protected mode: only selected projects (other
  projects' chats and files are hidden, and the account can't add projects),
  only selected assistants (new chats start on the first; a shared chat moves
  to an allowed assistant when the account sends), and messages / new chats
  per day with today's use shown. Enforced by the server; see
  `docs/architecture/spaces-and-tenancy.md` §12.
- The change adds the `account_limits` and `account_usage` tables
  (control-plane migration v9, additive), applied the next time the server
  starts.
- The owner can rename another account, set a new password for it (it is
  signed out everywhere), and pause/resume its sign-in without disabling it.

### Changed

- Settings → Users is an account list that opens one management view per
  account (profile, sign-in, Space role, projects, assistants, daily limits,
  Protected mode, password, disable). Add user suggests a login, can generate
  an easy-to-type passphrase, and opens the new account to set its limits.
- Owner actions ask for your password only when the server needs a fresh
  confirmation, in a prompt that explains a wrong password in place (the old
  flow showed a bare "invalid credentials" behind the dialog).

## Unreleased — protected household accounts

### Added

- **Protected mode** for a less technical household account. The instance
  owner switches it on per account in Settings → Users → Protection. The server
  then limits that account on every device: only the capabilities the owner
  granted (the paired-device route table), only the owner's model list (the
  first entry is the default for new chats), no composer shell, no Auto-Approve
  or Full access, no "always" replies, "once" only if the owner allows it, no
  native-session import, and a Space role capped at member. A Space with a
  protected member never auto-answers: agents ask a human every time. Sharing
  stays with Spaces. Not available in the legacy single-password mode; see
  `docs/architecture/spaces-and-tenancy.md` §11.
- The change adds the `account_guardrails` table (control-plane migration v8,
  additive). It is applied to live data the next time the server starts.

### Fixed

- Archiving a session whose subtree already contains archived sessions no
  longer fails with "Archived sessions are read-only until restored".
- Opening a session that was dormant across a restart no longer shows an
  `epoch-pending` conflict while recovery is still running, and a history read
  of a just-announced session no longer answers 404.
- Refused requests (not found, conflict, dirty worktree and similar) are no
  longer reported as "result not confirmed".
- A reply that is only tool-call markup is no longer accepted as a generated
  session title.

## Unreleased — guarded Auto-Approve

### Changed

- **Auto-Approve answers routine requests only.** A shared, provider-neutral
  risk assessment (`assessPermissionRisk` in `@polyth/permissions/risk`) now
  gates the server's single automatic decision point. Explicit deny rules
  still win and explicit allow rules still apply, but Auto-Approve never
  answers a high-risk request: destructive deletes, discarding uncommitted
  work, force-pushes/history rewrites, `sudo`-style escalation, system/device/
  process changes, `curl | sh`-style remote code, secret/credential access,
  data uploads, publishing/deploying/remote infrastructure, writes outside the
  session's workspace, database destruction, tools named for destructive
  actions, and commands too large, nested or dynamic to read. Those requests
  wait for a person as an ordinary card that lists localized reasons and
  offers only Deny/Allow. The check is a tripwire on what the harness reports,
  not a sandbox.
- Held requests count in session attention badges even while Auto-Approve is
  on (they were previously zeroed). The web client now hides only pending
  requests the session's level will answer, instead of every pending request,
  so a held card stays on screen.
- The agent actor can no longer grant itself autonomy: the agent session API
  and the Polyth MCP `permission.reply` / `permission.auto.set` actions may
  reject a request or turn Auto-Approve off, but approving a request or
  turning Auto-Approve on returns 403. Those stay user decisions in the UI.
- **Antigravity honours the toggle again.** Since its headless CLI was moved to
  the always-on native permission bypass, the bridge had also allowed every
  tool, so Auto-Approve off did not gate Antigravity. The bypass is now only a
  launch mode (`nativePermissionBypass`); every gated tool goes to Polyth as a
  canonical permission request and the capability reports `permissions: true`.
- The toggle, banner and onboarding copy now say "routine actions" and that
  high-risk actions still ask, in all 12 locales.

### Added

- **Full access** — an opt-in third level (`setting: "all"`) for people who
  accept the risk: every request no explicit deny rule blocks is approved,
  high-risk ones included. It is enabled only after a confirmation, from a
  held card's **Allow all** or the auto-approve control (a click steps Ask →
  Auto-Approve → Full access → Ask; the context menu, right-click /
  Shift+F10, picks a level directly; the new-chat composer arms the same
  levels before the chat exists). It shows in the danger tone on a
  background-less button and inherits to subagents like Auto-Approve. Agents
  cannot enable it. `AutoAcceptDto` gains `level` and projections gain
  `autoAcceptAll`.

### Fixed

- The session-header auto-approve button now reads the session's real state;
  it previously always offered "Turn on" and could never turn the policy off.
- A composer-shell confirmation no longer disappears while Auto-Approve is on.
  No policy answers it, so the command used to wait unseen. Its card now offers
  only Deny and Allow, and its preview judges paths against the session's
  workspace.

## Unreleased — open-project window layout

### Changed

- The **Open a project** folder picker moved its hidden-files switch out of the
  path toolbar and into the "ways to add" row, right-aligned after `New folder`.
  The toolbar is now a single-purpose navigation strip (home, parent, path) and
  the path input uses the width the switch vacated. The switch disappears with
  the local list while a `solo` source (Open on a server) owns its own browser.
- GitLab identity is configured where the repository is actually entered — the
  clone panel — so the post-open opt-in no longer appears in the folder picker.

### Removed

- The `gitlab.add-identity` contribution to the `project.create.options` slot
  and its "Configure GitLab identity after opening" checkbox. The clone panel's
  `gitlab.clone-identity` binding is unchanged.

---

## Unreleased — Usage rebuilt around real session telemetry

### Added

- Project and Global Usage show a **Harnesses** donut and legend: which harnesses ran the work and how much each was used, by tokens, cost, or turns. Usage recorded without a harness stays visible as an unknown harness.
- Usage now has a separate **Limits** page for live harness/provider balances, comparable limit windows, reset times, pace, and bounded exhaustion projections. Limits are operational account telemetry, not a fourth session-analytics scope.
- Limit sources reuse configured harness/provider credentials, keep the last successful snapshot on source failure, separate balances from quota windows, and retain bounded history for pace. Settings control remaining-vs-used display, reset formatting, pace/projections, warning thresholds, and source visibility.

### Changed

- Usage now has exactly three scopes: **Session**, **Project**, and **Global**, all backed by one canonical observation/query pipeline.
- Session usage exposes token composition, cache efficiency, reported cost, TTFT, wall/model/tool time, steps, retries, response tok/s, and whole-turn tok/s.
- Project and Global views use temporal observations rather than assigning a session's cumulative lifetime total to its latest activity bucket.
- Turn-level timing/steps/retries are deduplicated by session + turn id; throughput includes only output tokens belonging to turns with measured timing.
- Legacy quota polling coupled to the analytics dashboard, quota widgets/cards, provider pinning, billing-profile UI, dashboard layout editing, cohort totals, and duplicate turn-stat/widget stacks were removed; the new Limits page uses its own bounded source service.
- The Usage dashboard and chart use stable, non-animated updates; stale-while-revalidate keeps the last successful exact-query report without cross-scope races.

### Removed

- `/api/usage/quotas` and `/api/usage/quotas/refresh` plus the provider quota client API.
- Legacy Usage widgets `usage.quotas`, `usage.sessions-table`, `usage.quota-summary`, and `usage.turn`; persisted layouts retire these ids safely.

### Fixed

- Switching Usage scopes (Session/Project/Global) or the Limits tab no longer blanks into a blocking `Loading…` state: a warm exact-query report is painted from cache on the first frame and revalidated in the background, and the Limits page keeps its last-good snapshot across the remount. A runtime or Space change still clears the cache before the report is trusted.

---
## Unreleased — unified package-owned session import

### Changed — one import surface for every harness

- The project menu had two import actions: the host "Import sessions…" sheet
  (OpenCode-only backend adoption) and the `@polyth/session-import` widget's
  "Import conversation" (snapshot). They are now one entry owned by the
  package. The legacy host import dialog component and menu entry were
  removed; the legacy `/api/agent/backend-sessions` route stays
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

---

## Earlier milestones (August 2026)

Foundational features established during the initial release cycle, grouped by product area:

### Sessions and chat

- **Conversations and streaming:** Multi-turn chat timeline backed by an
  append-only event log with streaming responses and reasoning traces.
- **Composer and attachments:** Rich prompt input supporting file and image
  attachments, drag-and-drop, paste, line ranges, command suggestions, prompt
  history cycling, and persistent drafts.
- **Controls and navigation:** Session rewind, redo, and fork-from-message;
  message delivery queuing; nested folders, pinning, and search; and bounded
  inline composer shell execution (`!command`).
- **Assistance:** Automated post-turn summaries, follow-up suggestions,
  transcript selection quick actions, and prompt hover previews.

### Permissions and safety

- **Granular approvals:** Monotonic fail-closed permission engine with
  risk-scored preview cards and configurable scope rules (once, session, project).
- **Auto-accept policy:** Per-session auto-accept configuration with subagent
  inheritance and mandatory confirmation for high-risk shell actions.
- **Access control:** Optional UI password protection with rate-limited login
  attempts and remembered device sessions with remote revocation.

### Files, Git and terminal

- **File management and editor:** Path-jailed file tree with nested exploration,
  syntax-highlighted editor, debounced autosave, conflict detection, and live
  HTML/Markdown preview.
- **Source control:** Full Git management with diff inspection, staging,
  commits, branch operations, stashes, worktrees, and pull request workflows.
- **Terminal emulator:** Integrated multi-tab terminal with resumable sessions
  and bounded scrollback replay.

### Multi-model runs

- **Side-by-side evaluation:** Multi-run workflows comparing multiple model
  outputs concurrently in a single session.
- **Response fusion:** Synthesis combining multi-model responses with
  attribution, agreement weighting, and disagreement analysis.

### Browser

- **Controlled browser automation:** Sandboxed Chromium sessions with
  responsive viewport presets, theme emulation, and strict network safety policies.
- **Visual capture:** Drag-and-drop and keyboard-driven screenshot annotation
  with direct export to chat attachments.

### Knowledge, schedules and memory

- **Knowledge store:** Searchable notes and persistent instructions attached to
  sessions with revision tracking.
- **Automation schedules:** Cron-based recurring prompts with time-zone
  support, overlap policies, and execution history.
- **Voice integration:** Speech-to-text dictation and text-to-speech playback
  supporting Web Speech and streaming endpoints.

### Remote projects over SSH

- **Remote execution:** OpenSSH multiplexing driving remote agent runtimes
  directly on server hosts over secure tunnels.
- **Connection management:** Saved server inventory, reachability probing, and
  remote directory browsing in the project picker.

### Packages and extension SDK

- **Plugin architecture:** Microkernel runtime supporting dynamic package
  loading, scoped contexts, and reversible lifecycle hooks.
- **Extensible workspace:** Typed UI slots and declarative right-pane surface
  hosting enabling packages to contribute custom views and tools.
- **Tool integration:** Model Context Protocol management interface with JSON
  configuration import and server health probing.

### Settings, themes and accessibility

- **Appearance and themes:** Token-based theme system with built-in presets,
  custom JSON theme import, and automatic system color scheme following.
- **Usage and models:** Model catalog browsing, quota breakdown by family, and
  favorite model configuration.
- **Notifications and accessibility:** Web push notifications via VAPID with
  session deep-linking, keyboard focus management, and screen-reader support.

### Tests

- **Monorepo test suite:** Automated test suites spanning kernel lifecycle,
  event persistence, session delivery, permissions, and web UI.
