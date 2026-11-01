# Polyth architecture (as built)

Snapshot of the system as it exists on this branch. This replaces the old milestone
plan; nothing here is aspirational — every item is in the tree today.

The [session reading contract](../architecture/session-reading.md) defines
persisted reads, lifecycle activation, bounded replay and navigator pages.

## Orientation (read this first)

One-minute map for a new agent; everything after this section is the deep reference.

- **One UI, one server.** `apps/web` (React 19 SPA, esbuild) talks REST `/api/*` + WS `/ws` to `packages/server` (node:http composition root). Electron embeds it with a local server; Capacitor embeds the same build as a client of an existing server. The server wires every feature service and lazily spawns `opencode serve` per project through `packages/backend-opencode` — the only package allowed to touch the OpenCode process/API.
- **Truth lives in the event log.** `packages/session` stores append-only events in SQLite (WAL). Anything model-visible is appended before the UI sees it; `deriveMessages` rebuilds model history from the log (skipping `ignorable` events).
- **Contracts first.** `packages/contracts` is the normative surface — mostly types (DTOs, `SessionEvent`, `UiSlot`) plus a few runtime exports (`cap`, `CAP`, `UI_SLOTS`, `isUiSlot`, `MODEL_VISIBLE_TYPES`, `errorBodyText`). `packages/kernel` provides plugin scopes, capabilities, and slot contributions. Built-in feature services are wired directly at the composition root (`packages/server/src/index.ts`), not dynamically loaded; the kernel and the installed-plugin registry are the plugin seams.
- **Extending the server:** add a feature package exposing a `RouteHandler` and register it at the composition root — never edit `packages/server/src/http.ts`.
- **Extending the UI:** feature UI lives in the feature package
  (`packages/<feature>/widgets/`) and registers through `@polyth/web-sdk`
  (`defineWebPackage` → `WebPackageHost`: slots, widgets, system package
  windows, capabilities, settings, project context, reducers). The host owns the
  registries (`apps/web/src/slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `capabilities.ts`, `settings/registry.ts`)
  and renders contributions through `SlotHost`/surface hosts — never edit
  `App.tsx`/`Main.tsx` for a feature. Full guide: `docs/dev/ui.md`.
- **Feature packages** (one directory each under `packages/`): permissions, goals, files, editor, git, commands, terminal, multirun, fusion, walkthrough, schedule, planner, knowledge, github, usage, browser, dictation, models, hotkeys, plugins, ssh, secure-safe (Credential Vault), personal-coach, recap, task-trackers, workflow, example-feature.
- **Conventions:** erasable TS on Node >= 22.16 (type stripping; no
  enums/namespaces/parameter properties), explicit `.ts` on local imports,
  `@polyth/*` workspace imports, `node --test` + `node:assert`. Browser code
  may use ES2023 array methods (`toSorted`, `toReversed`, `toSpliced`,
  `findLast*`, `at`) and the WebKit 15.4 globals (`Object.hasOwn`,
  `structuredClone`, `crypto.randomUUID`): `apps/web/src/arrayCompat.ts`
  installs each only when missing, first in `main.tsx`, for older WebViews
  (the iOS app targets iOS 15). Other
  post-iOS-15 built-ins need the same treatment, and *syntax* cannot be
  polyfilled: a regex literal with lookbehind (`(?<=…)`, WebKit 16.4) or a
  class static block in browser code makes the whole bundle (a package entry
  included) fail to parse, so write those without it. A managed plugin UI or
  package entry that fails to import is retried with backoff and on
  foreground/online (`pluginBridge.ts`, `packages/registry.ts`). Full rules: `/AGENTS.md`. Feature workflow: `docs/dev/README.md`.

## Topology

Workspace repository resolution, resource identity and editor/search behavior
are specified in [Workspace repositories and resources](workspace.md).

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
| `contracts` | DTOs, `SessionEvent`, service interfaces, `UiSlot` union (types) plus runtime values: `cap()`, `CAP` capability keys, `UI_SLOTS`/`isUiSlot`, `MODEL_VISIBLE_TYPES`, `errorBodyText()` (reduce a non-JSON HTTP error body — including proxy HTML pages — to one readable line). The normative surface. |
| `kernel` | Scoped plugin contexts: `provide`/`inject`/`optional` capabilities (priority + registration order), `on`/`emit`/`waterfall` events, LIFO effect disposal, `contribute()` for UI slot items, `loadPlugin` with manifest requirement checks, profile resolver (bundles → ordered plugin list). |
| `session` | Append-only event store. `append` allocates monotonic per-session `seq` transactionally; projections (`SessionProjection`) are updated alongside; also owns queue items, folders, labels, projection-only session pins, agent profiles, and transcript text search (`searchMessages`: an FTS5 mirror `events_fts` of displayed user/assistant text, trigger-maintained, with `events_fts_keys` mapping `(session_id, seq)` to the FTS rowid — FTS5 cannot index its `UNINDEXED` columns, so every mirror delete must go through that key table, never `WHERE session_id = …` on `events_fts` (a full scan; per deleted event it stalled the server for minutes), prefix + diacritic folding, bm25 rank, scoped by Space/project through the projection join; `searchEventText` is the unscoped compatibility wrapper). `deriveMessages` turns the log into model history (skips `ignorable`). |
| `backend-opencode` | The only OpenCode integration point. Spawns/attaches `opencode serve`, translates its SSE into `RuntimeEvent`s, maps canonical session ids ↔ backend ids, applies behavior/MCP config (`createConfigApplier`), imports pre-existing OpenCode sessions, and snapshots native task state. Delegated agents are canonical Polyth child sessions, not OpenCode task snapshots. |
| `permissions` | Monotonic fail-closed rule engine; scopes user/project/session; deny beats allow; "always" persists a rule at the chosen scope. |
| `goals` | [Session goals](goals.md): objective audits (`keep`/`done`/`stuck`), canonical descendant waits and reports, bounded continuation, pause/resume and durable admission recovery. |
| `recap` | Optional idle-session recap + grounded next-step suggestion, plus key callouts (`src/callouts.ts`): heuristic must-know items from the last completed turn quoted verbatim from their source, with an explicit, verbatim-checked model pass at `/api/sessions/:id/assist/callouts`. Dismissed callouts are a browser-local preference (latest turn per session, `widgets/calloutDismissals.ts`), never written to history. Disabled by default; owns its generation lifecycle, quiet-time settings, freshness-checked read route, and timeline/settings UI. |
| `personal-coach` | Optional durable goals, commitments, routines, and coaching state. Disabled by default. |
| `files` | Path-jailed file service: tree/stat/read (revision = mtime+size), revision-guarded `write` (stale `baseRevision` → `conflict`), binary-overwrite refusal, mkdir/rename/delete/upload, scored file search (shared with palette + mentions). Explorer + file `ResourceProvider`; does not own CodeMirror. The raw-content route `/api/files/raw` answers single byte ranges (`Range: bytes=start-end`) with `206` + `content-range` and `accept-ranges: bytes`, or `416` when unsatisfiable, so browsers can seek media without refetching the file. Read-only views (`read`, `stat`, `readRaw`, local and SSH) also accept an absolute path: inside the project it is an ordinary jailed path; outside it only the folders and file types of the installation-wide policy open (`src/externalReads.ts`, `GET`/`PUT /api/files/external-reads`, instance owner only; default the temp folder plus the inline-safe media/PDF/text types). The request is checked before the disk is touched and again after symlinks resolve (SSH: lexical only); a refusal is `403`. Writes never leave the project. Settings → File editor → *Files outside the project*. |
| `editor` | Sole CodeMirror 6 owner: one `EditorView` per visible group, `EditorState` retained per tab, honest language grammars (JS/JSX/TS/TSX/JSON/YAML/Markdown), word/language completions and bracket closing. Its scoped TypeScript language workspace (`/api/editor/language`) answers definition, references, rename, completion, hover and diagnostics. Packages add language smarts through the data-only `editor.intelligence` slot (`widgets/intelligence.ts`); the optional `code-intelligence` package registers the TypeScript/JavaScript provider. Registers Authoring and Development workbench profiles. |
| `git` | Porcelain wrapper: status/diff/show/stage/unstage/discard/commit/log/graph/branches/checkout/stash/fetch/pull/push/worktrees, diffHead/diffRange for review flows. Session-scoped Git routes resolve an owned worktree cwd server-side. |
| `commands` | Slash commands + `#alias` snippets: project (`.polyth/commands`, snippets in `.polyth/snippets`) and user scopes, `$ARGUMENTS`/`@file`/`!cmd` template expansion, CRUD for the settings UI. |
| `terminal` | Terminal sessions on a real PTY when the optional `node-pty` dependency builds (full-screen TUIs, true resize), falling back to piped `node:child_process` shells (COLUMNS/LINES exported, resize → SIGWINCH) otherwise; the shell is an explicit `SHELL` or the OS account login shell (`os.userInfo().shell`), so a Finder-launched macOS app gets the user's zsh instead of POSIX `sh`; Settings → Terminal can pin another installed shell per Space (`GET/PUT /api/terminals/shell`, `auto` default, choices from `/etc/shells` + PATH or pwsh/powershell/cmd on Windows, validated on save and again at spawn — a stale choice falls back to auto; local terminals only, SSH keeps the remote `$SHELL`; server-owned harness install/sign-in terminals instead run through the system shell — `/bin/sh` or `cmd.exe` with a verbatim command line — on this machine, and are listed as `purpose: "harness-setup"` in every Terminal view of the project); create/list/close/rename; bounded per-terminal replay ring (default 200 KB, UTF-8-tear-safe) replayed on every `/ws/terminal/:id` attach; terminals survive socket drops — close only via REST or process exit. The web client renders through its own VT emulator (`apps/web/src/terminal/emulator.ts`): cell grid + scrollback, 16/256/truecolor SGR, alternate screen, mouse reporting, OSC 8 links, DSR/DA replies. |
| `preview` | Dev-server lifecycle per project: script detection, `PORT` injection, status events, URL for the iframe preview. |
| `multirun` | N parallel one-shot runs (model/agent matrix) inside a session; per-run progress events; pick-a-winner. |
| `fusion` | Multi-model answers + small-model synthesis with weights, attribution, disagreements. |
| `walkthrough` | Replay tab (`src/replay.ts`): event-log-derived play/step/scrub through the last turn's (or a chosen turn range's) file edits with before/after panes, per-file filter and jump to the originating message; see `packages/walkthrough/README.md`. Generated diff walkthroughs (stable hunk ids, digest-keyed cache) + structured review generation (`ReviewAssessment`) shared with the review flow. |
| `agents` | **Agents** (package id `agents`, `@polyth/agents`; installed as `schedule` before 2026-10-23, so its manifest lists `formerIds: ["schedule"]` and the host moved its data at boot). Routes `/api/schedule`, webhook URLs `/hooks/schedule/<token>`, the rail capability `schedule`, widget ids `schedule.*`, the `schedule/run-started` event and `via: "schedule"` keep their names: `/api/agents` is the host's harness-agent list, and the others live in saved layouts, other services and session history. The service key is `agents`. A task is an agent: `title` = name, `prompt` = standing instructions (charter), `target.mode` = context policy (`new-session-per-run` fresh, `dedicated-session` rolling, `existing-session` one chosen session). Wakes: at/every/cron cadences (IANA zones) or `manualOnly`; Run now accepts an optional user note. Rolling agents continue their last session and start a new one when the charter/model/harness/profile key changes, after a compaction, or when `contextWindow.fraction` reaches `rotateAt` (default 0.6; unknown occupancy keeps the session but repeats the charter). A new session receives charter + the last 3 journal notes + the wake (`src/agentPrompt.ts`, shared with the editor preview). Daily budgets (runs/tokens/cost over 24 h) are checked before a scheduled run, never mid-run; exceeding one trips the agent until the window has room; `pauseAfterFailures` trips it until the user resumes; at most 4 scheduled runs are in flight host-wide. Journal = run records with the run's last `assistant/message` (bounded) and summed `usage/recorded` tokens/cost, derived from the session log. `POST /api/schedule/draft` asks the account small model for a draft from a description or a session excerpt; it only pre-fills the editor. Overlap and catch-up policies, run history (cap 50), file-authoritative Markdown loops under `<project>/.agents/loops` (an `agentProfile` is applied on create and send). A run stays `running` until its admitted turn emits `turn/stopped` in the target session (read after the run's own `schedule/run-started` seq, following `queue/dispatched` when the prompt was queued); a run whose outcome cannot be confirmed is `unknown` and is never replayed. Tasks persist per Space in `packages/agents/schedule.json`. The session menu offers "Make an agent…" (`sidebar.session.actions`). Chat agents create and manage agents through the `polyth_agents` tool and `polyth-agents` skill (`src/agentTool.ts`, registered on `harness.capabilities`): `list`/`get`/`create`/`update`/`run` in the chat's project (or another project of the same Space), acting for and owned by the turn's person; `create` defaults to on demand (`manualOnly`) with rolling memory and takes name, charter, description, icon, colour, notebook, notify, an optional cron schedule and heartbeat. The skill routes "create an agent in Polyth" here instead of to a delegated child session, a harness agent file or an AGENTS.md persona. Event wakes (`src/agentEvents.ts`): `session` triggers (a session in the agent's project completes/fails/is stopped, from the host `SERVER_TURN_STOPPED_BUS`; delegated children and stops with a pending provider-limit resume are ignored) and `agent` triggers (another agent's run in the same Space completes/fails); optional field filters; pace = quiet period (debounce, capped at 5×), `latest`/`batch` coalescing and a per-hour limit that holds events until a slot frees. Matching events persist on the agent before anything runs; an agent never wakes on its own sessions/runs; event chains stop at depth 3. Event text reaches the agent marked as data. `POST /api/schedule/trigger-preview` replays the last 24 h of session stops (or the followed agent's runs) through the same rules. Webhook wakes: an anonymous `POST /hooks/schedule/<token>` (outside `/api`, so it never resolves a tenant; the 32-byte URL token is the only authority, shown once in the create/update response and stored only as its SHA-256, so it is never shown again — Settings offers "Get a new address", which saves only the wakes with that wake under a new id so a new token is issued and the old URL stops working; body ≤64 KB, 120 calls/min per wake, unknown and removed tokens answer 404; the body reaches only that agent, as data). Integration wakes: packages publish through the host `AGENT_EVENT_SOURCES` registry (`register`/`publish`/`subscribed`) to agents in the same Space (optionally one project); Monitoring publishes `memory-high`/`load-high`/`service-down` when a warning newly appears. It samples every minute, projects with a subscribed agent first and then every other project, and only a project whose policy grants agents metrics or services; a new warning in a project without a subscribed agent opens (or notifies on) one `sysadmin` incident chat, bounded by the incident limit, and one host's warning is claimed by one project (`decideDispatch` in `packages/monitoring/src/alerts.ts`). Context and cache (`src/agentCache.ts`, `GET/POST /api/schedule/:id/context`): a new session's prompt starts with the unchanged charter so its prefix is cacheable; the agent page shows session occupancy against `rotateAt`, the estimated charter/journal/wake layers, per-run cache share (`cacheRead / (input + cacheRead + cacheWrite)`, provider-normalized) and the provider's documented cache lifetime (from `@polyth/usage/cache-ttl`). Rolling agents may set `whenFull: "compact"`: at `rotateAt` the harness compacts the session (`SessionService.compact`) and the charter is repeated; harnesses without compaction fall back to a new session. `keepWarm: "auto"` sends a short keep-alive turn just before the cache expires between scheduled wakes only when the harness has measured cache reads, the provider documents a lifetime, the agent is within budget and idle, and the keep-alives cost less than a cold start (read 0.1×, write 1.25× of input price); keep-alive stops are never published as session events. Repository agents: `.agents/agents/<id>.md` (format `agent/v1`, see [content-bound trust](content-bound-trust.md)) alongside legacy `.agents/loops`; the editor's File view edits the same text (`src/agentFile.ts`, browser-safe) and round-trips exactly with the form; `POST /api/schedule/:id/file` exports an app agent or converts a trusted loop; the wake preview's dry run lists the latest events with why each would or would not wake the agent. Wake scripts (`src/agentScript.ts`, server-only): any event wake may carry `script`, the body of `function (events, agent)` run after the pace in QuickJS compiled to WebAssembly (`quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync`): no files, network, process or host objects exist inside; input crosses as JSON; 16 MB memory, 256 KB stack and a 50 ms interrupt per run. It returns `{ action: "run", note? }` (the run records the note as `note`, apart from the person's `input`; the prompt carries it under its own heading as the wake script's words, which may quote event data, never as the user's, and the page shows it with the run's events, not as the person's bubble; event runs written before this stored the note in `input` and are moved once on load), `"skip"` or `"pause"`; any error or other value skips the wake and is recorded in the event log. Scripts are syntax-checked before an agent is saved, are part of an agent file's trusted content, and can be tested on the latest matching events (`POST /api/schedule/script-test`, no state changes). Runs record approval requests waiting in their session (`waiting`); `approvals` can deny a waiting permission or stop the run after a timeout (default: wait for the person). Backup models: `fallbackModels` (≤8 harness-qualified refs, priority order; none for an `agentProfile` agent) are tried after the main route only when that route is refused outright — at admission when create/send throws a route code (`ROUTE_FAILURE_CODES`, e.g. `invalid-model`, `auth`, `model-unavailable`, `runtime-unavailable`, quota/rate limits; an uncoded or uncertain error is never retried), and mid-run when the turn stops with `rate-limited`/`quota-exhausted`/`overloaded`/`auth-expired`/`model-unavailable` (or a rate/quota/overload retry plan), through `SessionService.resumeNow` with the backup's model and pinned harness; the run records the backup that served it (`backup`, 1-based). Every run starts on the main route again. Permissions: `permissions` (`ask`/`routine`/`all` = session auto-accept `off`/`on`/`all`; absent = inherit) is applied to the run's session before the prompt is sent — always on the agent's own sessions, only when set on a chosen chat; raising it requires an owner and goes through the owner's guarded session service, so an account that may not auto-approve fails the run instead of escalating. Reports (`src/agentReport.ts`, browser-safe): every prompt ends with the report protocol; the last `Report: quiet|update|alert — <headline>` line of a run's final message becomes the run's `signal` and `headline` (an answer without one counts as an update headed by its first line; failed/unknown runs carry no signal), `Remember: <note>` lines (≤5 per run, outside code fences) are appended to the agent's `notebook` (≤6000 chars, oldest bullet notes give way, a person's prose never), and the stored summary keeps only the prose. Quiet runs are filed silently: they never publish agent events, never notify and are left out of journal notes. Heartbeat (`src/agentHeartbeat.ts`): `heartbeat {everyMinutes 10–1440, activeFrom/activeTo (local minutes, may wrap), timeZone, checklist}` adds light checks inside the rolling conversation (a heartbeat requires `target.mode: dedicated-session`); beats have their own clock (`nextBeatAt`/`lastBeatAt`, never moving `nextRunAt` or `runs`), are skipped without a journal entry while the agent works or the host is at its run limit, are not caught up after downtime, respect budgets, and their turns are not offered to session-event wakes. Notebook: a new session's prompt carries it; a continuing session gets it again only when the person changed it (`notebookRev`/`notebookSentRev`); notes the rolling session wrote itself do not re-send it. Feedback: `POST /api/schedule/:id/runs/:runId/feedback {verdict: up|down|null, note?}`; feedback no run has heard is listed in the next prompt once and marked `delivered` at admission. `POST /api/schedule/:id/seen {at}` moves the person's read mark (`seenAt`, never backwards, never ahead of the clock); `POST /api/schedule/:id/stop` aborts the agent's runs in progress. A run started with a message from the person queues behind the run in progress instead of being skipped; the person's messages to one agent are handled one at a time. A further message while one waits joins it: texts joined, files concatenated, a later explicit continue/new choice wins; a waiting scheduled wake becomes the person's run, a waiting event wake stays one (its events, script `note` and the schedule's clock kept) and carries their words. A join is refused, never cut: 413 `payload-too-large` when the joined text would pass `AGENT_INPUT_LIMIT` (8000 characters, `src/agentThread.ts`; a single message is trimmed to it and the composer's box takes no more) or the files 16, and 409 `conflict` while a one-off run of a file version waits; the page puts the refused words back in the box and says why in the person's language. The person's waiting start is saved in the task (`queuedStart`, with the display list `queued`) until the save that records its run removes both, so a restart neither loses nor repeats it: `stop()` starts nothing that waited, `start()` waits again behind a resumed run or sends at once, and a saved start that no longer validates (or a malformed `queued` entry) is dropped on load. While the agents are stopped or starting again (shutdown drain, package disabled), nothing runs: the person's message joins the saved start and goes after `start()`, a wake without their words (Run now, a one-off file version) is refused with 503 `unavailable`, scheduled, event and heartbeat wakes wait with their events kept on disk (also those that arrive while a wake script runs into the stop, unless that wake was removed meanwhile), and a wake that waited behind a run in memory only (a plain or one-off wake under the `queue` policy) becomes a skip that says so (with its trigger and events). Consumers of `runNow` treat `unavailable` as "later": a Knowledge track step keeps its one-shot task armed for the first tick after the restart. `start()` first lets the observers the stop released let go (at most 10 s; one that lets go later is followed again once it has, and its run counts as at work meanwhile), so their runs are followed again from their sessions before anything saved is sent. A message holds the agent's message lock until its run is admitted, at most 30 s. A repository agent's waiting start whose file changed to an untrusted version is not sent: it becomes a skip that keeps the person's words, files and the reason. `packages/agents/schedule.json` carries `v` (schema 5). Where a waiting message goes is fixed when it queues (the runner's `thread` hook, the same decision as `followUp`); at execution only that session is checked again (gone, archived, outside the project or Space, not an agent session, a changed key or full → a new conversation with that reason; the 8 h window is not checked again), while a rolling agent follows its ongoing conversation. The owner's view lists the waiting messages as `queued` (each with the session it goes to; absent = a new conversation) and `followUp` names where the waiting run goes, since the next message joins it; `queuedStart` is never shown and other people see neither — except on a repository agent, which every Space member owns, so its waiting messages are everyone's, like its history. Conversations (`src/agentThread.ts`, browser-safe; the runner and the owner's `followUp` preview share it): the person's message to a fresh agent goes on in the session of its newest visible exchange (their own words or a report that says something) for 8 h after it ended (`FOLLOW_UP_WINDOW_MS`), unless they ask for a new conversation (`continuation: "new"`; `"continue"` overrides only the 8 h window), its instructions/route key changed (a run recorded before runs kept their key counts as unchanged), its context reached the default `rotateAt` (a fresh agent ignores `whenFull`/`rotateAt` and never compacts on its own; a session compacted otherwise goes on with the charter sent again), or the session is gone, archived, outside the agent's project or not an agent session (`purpose: "agent"`); scheduled and event wakes of a fresh agent always start a new session, and a rolling agent follows its rotation rules (`"new"` rotates it). An agent bound to one chosen session refuses `"new"` (400). Every run records its session's `key`, `continued` when it went on in an earlier session, and `fresh` with the reason when it carried the person's words (or rotated) yet started a new one. The owner's view of every task carries `followUp` — where the next message goes (`{sessionId, at, until}`, `until: null` = no limit, or `{reason}`) — from the same rules. A message may carry up to 16 files already uploaded under the project's `_inbox/` (`attachments`, file/image only, validated like a session message) and may be files alone; they reach the session as ordinary message attachments. While a run works its newest step (`activity`: a tool with a bounded copy of its input, or the newest line it wrote or thought) and `steps` (tool calls so far) are read from its session by the settlement observer and saved at most about once a second; `activity` is dropped when the run ends. Notifications: `notify` (`alerts` default, `updates`, `off`) decides which finished runs notify through the host `SESSION_ATTENTION_SERVICE.notify`; a failure streak that stops the agent notifies unless `off`; the package claims the routine turn notifications of the agent's own sessions (`claimTurnNotifications`), so a quiet heartbeat never becomes a "finished" notification, while approvals and questions still notify as usual. Sessions the runner creates carry `purpose: "agent"`; the web package claims that purpose with `host.sessions.claimListing`, so they are read from the agent's diary rather than the session list. Presentation: agents appear at the top of each project's session list (`sidebar.project.leading`) as a foldable "Agents" group (folded per project on this device, Alt-click folds every project; folded, the header still shows who waits, has stopped, works or has news — amber when the news is an alert). The default glyph is `bot` (the robot the Agents window carries); `src/agentPrompt.ts` `AGENT_ICON_IDS` is the picker's ordered set and `widgets/AgentGlyph.tsx` `AGENT_ICONS` maps each id to a glyph, falling back to the robot. A row reads as a chat row: the agent's glyph, or its state mark (while it works its own glyph with an arc travelling round it, amber shield, red `!`, unread dot), the name, and the elapsed time (the same clock as its page's status line and its conversation's live turn) or next wake; its menu (right click, ⋮, long press, Shift+F10) runs or stops it, pauses or resumes its wakes, marks it read, renames it (also double click/F2), lists its Conversations (its sessions, newest first, each opening in Chat — the same drill-in sits in the page's ⋯ menu), opens Settings, duplicates or deletes it. An agent's session opened in Chat names its agent in the session header (`session.header.status`): the agent's mark and name, a click back to its page. A row opens the agent's page **in place of Chat** (`host.pages`, page `agents`, resource = agent id; no package window): header with status (a run in progress reads as working even when an earlier failure streak stopped the agent), one lead action (Run now, Stop, Resume or Activate) and a menu, then Conversation (oldest first, by day; each session the agent talked in — more than one run, the person's words, a continuation, or the rolling agent's ongoing one — is one conversation along a spine in the agent's colour: a filled cap where it began (with why, when it could have gone on), a hollow cap where it comes back after another came between, a dimmed hollow cap where the person's waiting message will start one, none where it goes on past a day label; a fresh agent's lone wakes read as one loose stream; reports speak from the spine, the person's words are chat bubbles, quiet checks fold, "New" sits before the first unread report; the run at work closes its conversation with the agent's mark and its newest step as the chat's live line, step count and clock; waiting requests dock above the composer. The composer is Chat's material: files (button, paste, drop on the conversation; uploaded to `_inbox/`), a chip saying where the message goes — on in the conversation since a time, or a new one, with the reason, switchable from its menu — Stop and send-after-the-run while a run works, the unsent draft kept per agent on this device and ↑ for the last message; the words leave the box on Send and show at once where they will land, and a refused message returns to the box ahead of anything typed since, only for the agent it was written to), Memory (the editable notebook, feedback history, and context and cost) and Settings (the editor: one page of open sections — About, Instructions, When it works, Notifications, What it may do — each a heading, a one-line explanation and its fields, nothing folded; an "Advanced settings" switch, remembered per browser, adds backup models, the first-run prompt, catch-up, heartbeat checklist, approval timeouts, Memory and context, Limits, event-wake conditions/pace/scripts/dry runs and the File view behind "Edit as a file"; a save dock only while something changed). Without a resource the page is the agents' home: what waits for the person across agents (answerable in place) and every agent by project; resource `new` starts a new agent (describe it for a draft, start from scratch, or pick a template). Tasks that post into one chosen chat (`existing-session`) are listed apart as that chat's scheduled messages, not as agents. |
| `planner` | **Planner**: plain scheduled prompts, separate from Agents (`schedule`). A task = title + prompt + cadence (once / daily / weekly / monthly / interval / custom cron, IANA zone) + target (`new-session-per-run`, `dedicated-session`, `existing-session`) + overlap/catch-up policies. Runs send as the task's owner (`plannerTurnAdmission`), stay `running` until the admitted turn's `turn/stopped` after the run's own `planner/run-started` event, and become `unknown` (never replayed) when the outcome cannot be confirmed; history is capped at 50. Agents schedule into their own session through the auto-approved `polyth_planner` package tool (`packages/planner/src/agentTool.ts`; `create`/`list`/`cancel`): it only ever creates an `existing-session` task for the calling session in the grant Space, owned by the turn's person (`ToolExecutionContext.actorUserId`, none for system work), resolves `HH:MM` / wall-clock / RFC 3339 times in an IANA zone (default: the server's), allows at most 10 active tasks per session and repeats no faster than 5 minutes; list/cancel see only that session's tasks. No charters, journals, budgets, event wakes or `.agents/loops` (those stay in `schedule`, so a repository file never fires twice). Tasks persist only per Space in `packages/planner/planner.json`; a task whose project has no Space is refused, so the package writes nothing into the shared data root and is removable as one folder. In the chat it posts into, a task shows on a line above the composer (next run, its actions, the chat's other planned tasks) and each run as a timeline fact before its prompt (`widgets/ChatSchedule.tsx`; see [UI](ui.md), "A chat's planned runs above the composer"). UI: a mobile-first list scoped to the shell's current project by default (following project switches; the person can pick another project or All projects for the browser session), with a Next up card, upcoming runs grouped by day, Paused/Done filters and templates, and a task page with a cadence editor and live next-run preview; layout adapts through container queries. Enabled by default and direction-universal (`projectAffinity` has no `directions`), so its launcher arrives in every project's rails: top for operations/home/wellbeing/finance, right otherwise. |
| `knowledge` | Space-owned Notes/plans/memories SQLite under `spaceStorage(space).packageDir("knowledge")`, with revisions, tags, search, bounded Memory recall, and scoped `knowledge.space` service wiring; attaching logs `knowledge/attached` (exact revision + digest) before the model sees it. See [Memory](memory.md). |
| `github` | `gh`-CLI-backed repo/issues/PR list, PR detail/files/diff/comments, failure-first checks aggregation, guarded review submit + risk/confidence labels. No tokens stored. The shared `code-hosting` list view debounces search (350 ms), caches each project/query result in the browser (fresh for 60 s, then shown and revalidated in the background), drops a project's cached lists after any write, and its Refresh button bypasses the cache. **Pull request watch** (`@polyth/code-hosting/watch` engine, GitHub source and wiring in `packages/github/src/prWatch.ts`): a chat watches one of its pull requests (`POST /api/github/pr/watch`, `/stop`, `GET …?sessionId=`; the agent's `watch_pull_request` tool and `polyth-watch-pull-request` skill; *Watch in this chat* in the PR view). Polyth polls as the person who started it (their account, resolved on every poll like their own request; the installation `gh` only for the instance owner) — 60 s while checks run, 3 min when quiet, backing off on errors — and wakes the chat with one hidden turn (`hiddenUserMessage`, the person's facade, `via: "schedule"`) carrying the failed checks of the head commit (annotations and the failed-step log tail of GitHub Actions jobs) and new comments with file and line. Only repository members (OWNER/MEMBER/COLLABORATOR), the acting account and review bots can wake the agent; strangers' comments are counted (`heldComments`), never sent, and bots' plain comments are ignored. Nothing is sent while the chat is busy; each failure (`sha:check`) and comment wakes once; the wake text and its operation id are persisted before the send, so a retry after a restart replays the same admission. A watch ends on merge/close, Stop, a new watch in the same chat, 8 wake-ups, 72 h without change, 6 h of failing polls, or when its person leaves the Space or its chat is gone. Watches persist per Space in `packages/github/change-request-watches.json`; timeline facts are `github/pr-watch` events (`phase: started|woke|ended`); the person is notified (`SESSION_ATTENTION_SERVICE.notify`, one key per watch) once per commit when all checks pass, and when the watch ends on merge/close, the wake limit or an outage. |
| `usage` | One canonical event-log analytics pipeline with Session, Project, and Global scopes. Prompt-cache health (`src/analytics/cacheHealth.ts`): last cache activity, provider TTL only when known, and cache burn (tokens re-written after expiry) with a countdown on the session card, and a person-requested **Keep warm** for a chosen period from the composer context card (`src/keepWarm.ts`: just-in-time, verified keep-alives sent as `keepAlive` turns that the host hides and keeps silent; see `packages/usage/README.md`). `usage/recorded` events become normalized observations; server aggregation owns accurate range totals, cache/cost/token accounting, turn timing, TTFT, steps/retries, throughput, project/model/harness breakdowns, and bounded drill-down. Unknown telemetry remains unknown; provider identity is only an attribution dimension. Opening is cached end to end: the browser persists reports, identity and the limits snapshot in `localStorage` and warms them at activation, the runtime id is stable per storage root so a restart keeps them valid, and the server re-reads a session log only when its tail advanced or a collector-relevant field changed (not on status ticks), relabelling cached reports on title/status changes instead of rebuilding them. Limits pace status uses projected consumption at reset when an observed rate is available; otherwise it compares consumption to the steady window budget after five minutes have elapsed. Forecasts require two observations spanning at least five minutes in the current reset window, after the latest counter decrease. The UI labels projected capacity as remaining at reset at the current rate; budget differences use unsigned percentage points above/below budget and are hidden when a forecast exists. A placeable Limits widget shows the current harness/model's limits, chosen sources, or all sources in one of seven display styles from the same limits service and shared limit preferences; it adds no second quota path. |
| `browser` | Shared user/agent Chromium context per canonical session, generic package-tool permissions, background activity, optional workspace reveal, user takeover, paced CDP frames, Space-scoped access and redacted durable audit. See [Browser](browser.md). |
| `dictation` | Server streaming dictation protocol: lifecycle via REST, PCM chunks via `/ws` with acks + `(id,seq)` dedupe + replay-from-last-ack, `SttAdapter` seam plus `createWhisperSttAdapter` (finalize-once WAV upload to any OpenAI-compatible `/audio/transcriptions` endpoint); the service takes an adapter *provider* so capability follows live settings. |
| `models` | Model preference logic: favorites, provider/name/recent sort, search, and per-harness picker visibility (`hiddenProviders` as a bulk switch, with `hiddenModels`/`shownModels` as single-model exceptions, edited in Settings → Harnesses → *harness* → Models), shared by picker + settings. The complete account preference object is server-backed through `/api/settings/client`; browser storage is only a synchronous cache/migration seed. |
| `judgment` | Provider-neutral typed semantic evidence, bounded execution, budgets, observations and Space/project settings. See [Judgment](../../packages/judgment/README.md) and its [architecture decision](../architecture/adr-judgment.md). |
| `judgment-jev` | Recommended Judgment backend; owns the TypeSafe SDK, Vault callback, supported provider/model catalog and native normalization. |
| `judgment-judges` | Built-in Judgment uses (completion check, waiting for you, keep warm) and person-defined judges that ask after a turn, on a waiting permission request (`SERVER_PERMISSION_WAITING_BUS`) or at a usage limit, mark the chat and, when the person chose actions, act with that person's access: send a fixed message, merge an isolated chat, approve or deny the request, change Auto-Approve, switch the model. See [Judges](../../packages/judgment-judges/README.md). |
| `hotkeys` | Keymap model: default bindings, user overrides, conflict detection, sequence matching. |
| `plugins` | Installed-plugin registry (install/enable/disable from dir sources, trust classes, contribution manifests). |
| `server` | Composition root + everything HTTP/WS: see below. |

Fresh installs default `recap`, `fusion`, `knowledge`, `multirun`, `personal-coach`, and `walkthrough` to disabled. Persisted package choices remain authoritative after an upgrade.

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
  steer falls back to queue with `delivery/fallback-queued`, or to interrupt when the
  runtime cannot steer; an interrupt admission returns `interrupting: true`), queue CRUD + dispatch,
  and validated memory narrowing (`memory.read` / `memory.remember`: `inherit` or
  `off`). Narrowing is carried in canonical user/message and queue records,
  survives retries and recovery, and cannot enable or broaden project policy.
  Session-owned defaults are persisted in `SessionProjection.memoryPolicy` and
  exposed at `/api/sessions/:id/memory-policy`; project policy remains the
  feature service's authority.
  runtime event → durable log translation, permission preview enrichment, question/permission
  replies with `dismissPending`, turn hooks (goals), usage/projection updates.
  Turn-admission fence (legacy live ingress): turn content — the
  `RUNTIME_TURN_CONTENT_EVENT_TYPES` set in `@polyth/contracts`, a turn's own
  `turn/stopped` included — becomes canonical history only for a turn Polyth
  admitted: a live turn in the log, or the `turn/started` that travels with the
  batch. The legacy `rt.onEvent` path refuses the rest and counts it, so a leg
  that keeps streaming after its turn closed (a stranded turn, a replaced
  runtime, a harness running its own loop) cannot make a session render as idle
  while it is being worked on. `backend-claude` refuses the same events at the
  source and interrupts an unowned native loop after a bounded number of them.
  Background work is the legitimate reason a native thread wakes itself: a
  backgrounded shell or subagent settling while the session is idle. Instead of
  letting that loop be refused (which silently lost the result and left an
  orchestrator waiting forever), the adapter emits the non-content
  `runtime/wake-requested` `{ wakeId, reason: "background-task", text }` and
  stops the CLI's own loop as soon as it starts; the session service turns it
  into one hidden `send` whose client operation id is derived from the session
  and `wakeId`, so a replayed observation cannot run it twice. While a
  provider-limit resume is pending the wake is held in memory (it would cancel
  the countdown and hit the same limit) and sent once a turn stops without a
  new resume plan. A turn submitted
  while an unadmitted loop is still unwinding waits (bounded) for that loop's
  result, so the loop's output and close never land in the new turn.
  Notifications that arrive inside a live turn stay with that turn
  (`packages/backend-claude/test/streamingAdmission.test.ts`,
  `packages/server/test/runtimeFeaturesHardening.test.ts`).
  Bookkeeping no turn owns — capability, command and context telemetry, session
  compaction — is never turn content and is not gated. Requests
  (`permission/requested`, `question/asked`) are never gated either: they stay
  answerable, and dropping one would strand a tool call waiting for a reply
  nobody asked for.
  The v2 observation path is deliberately not fenced. Every fact it carries is
  journaled as a revisioned durable entity owned by reconciliation, and restart
  recovery legitimately re-derives a turn Polyth had lost — fencing it would
  drop recovered work. Closing that gap needs a recovery-aware admission rule,
  not a blanket refusal.
  Tool watchdog: one tool execution over `toolExecutionTimeoutMs` (default ten
  minutes) is hard-stopped — a hung tool is never left running, and its abort is
  journaled as `turn-abort` with `turn/abort-requested{reason:"tool-timeout",
  source:"tool-watchdog"}` plus a model-visible `tool/error`. Other tools
  canceled with that turn receive a separate cancellation error; only the
  timed-out call is identified as exceeding the limit. A proven stop is
  then followed by a hidden continuation turn (`user/message` with
  `autoResume`, same native thread) telling the agent the call was killed and to
  continue with bounded work, so a stuck shell does not discard the turn's
  reasoning. Same autoResume seam as rate-limit resume and owned-epoch
  recovery: admitted only when the session is idle, reconciled, unqueued and
  turn-free, never before a confirmed abort, bounded per stuck episode by
  `toolTimeoutContinueLimit` (default 1, `0` disables) and restored when a turn
  ends on its own. The nudge never replays the original prompt. An abort that
  is not proven within the 8 s abort deadline defers the nudge instead of
  dropping it: it runs once a later reconciliation settles `ready` with the
  session idle, and is discarded if any turn or user message started meanwhile.
  A reconciliation that settles `unknown` for lack of status evidence (a probe
  timing out while the killed tool is still dying) is not a dead runtime: it is
  re-probed read-only on a bounded backoff (`reconcileRetryDelaysMs`, default
  5 s/15 s/1 min/5 min), so the barrier, queue and deferred nudge release
  without a person (`packages/server/test/toolTimeoutContinue.test.ts`). Adapters
  must latch "disconnected" only on transport close, never on one slow probe.
  Pause (`SessionService.pause`, `POST /api/sessions/:id/pause`): a person
  interrupts a running turn like Stop, but its `turn/abort-requested` carries
  `pause:true`, so the stop that follows — whichever leg reports it — is
  persisted as `turn/stopped{reason:"aborted", paused:true}` (old readers see
  an interruption) and the projection gains `paused {at, stopSeq}` while its
  status is idle. The pre-pause queue stays held (a user Stop), keep-alives
  and the tool-watchdog nudge are refused, agents' `session.send` is refused,
  automatic hidden sends (a harness's background wake, a delegated request)
  wait in the queue instead of continuing it, the queue dispatcher leaves
  hidden work queued while it is paused, and session watches deliver `paused`
  without disarming (see [agent architecture](../agents/architecture.md)). The
  pause ends with `session/pause-ended`: `continued` when a turn is admitted
  into the session (Continue, `POST …/continue`, admits the hidden
  `autoResume` prompt `PAUSE_CONTINUE_PROMPT` on the same history ahead of the
  held queue, which drains after that turn; a person's own message does the
  same), or `stopped` when Stop is pressed on it, which finishes the paused
  work as aborted for watches, goals and workflows and lets work held only by
  the pause dispatch as after any Stop. A turn that stops while a pause is
  still recorded (one no admission started, such as a compaction's) ends it
  with `continued`/`source:"turn"`, so the log and projection agree. A pause
  survives a server restart: it is durable projection state, cleared only by
  those paths (`packages/server/test/sessionPause.test.ts`).
  F18: per-session auto-accept policy (`on`/`off`/`inherit`, nearest-parent
  resolution from `@polyth/permissions`, explicit settings on the canonical
  session projection; legacy JSON settings are imported) — policy-approved
  requests persist the request and durable response intent/outcome before
  `permission/resolved{auto:true}`; successful automatic replies never set
  `waiting`. Enabling reconciles already-pending requests in their owning
  session, then refreshes only that session and the subagents inheriting
  through it (a descendant with its own choice, and its subtree, is skipped);
  that follow-up is best-effort per session (an `epoch-pending` chat's
  requests wait for its fresh-epoch recovery) and never fails the
  already-saved change. A single chat's change never sweeps the whole Space:
  that sweep takes every chat's lock in turn, and a new chat's first prompt
  waits for this request (`refreshAutoAcceptSubtree` in `sessions.ts`). A parent's mirrored child permission card never reaches the parent's
  runtime or creates a second response operation; the child's policy, including
  an explicit `off`, controls automatic approval and its resolution closes both
  cards. A composer `!` command (`SessionService.runShell`) asks no question:
  the person's send is the consent, so an `ask` verdict runs it and only an
  explicit deny rule rejects it (guarded Spaces and the agent-beta profile
  refuse it before evaluation). Composer-shell confirmations left pending in
  logs written before that change stay manual; the effective flag rides the
  projection. Auto-accept answers routine requests only: explicit deny rules
  win, explicit allow rules apply, and `assessPermissionRisk`
  (`@polyth/permissions/risk`, pure and provider-neutral) holds every
  high-risk request for a person — destructive deletes, discarded work,
  force-push/history rewrites, privilege escalation, system/device/process
  changes, remote code execution, secret/credential access, data uploads,
  publishing/deploying/remote infrastructure, writes outside the session's
  workspace roots (its exposed checkouts and runtime directory), database
  destruction, infrastructure destruction (`infrastructure-destruction`:
  terraform/pulumi/cdk destroy, kubectl delete, cloud delete/terminate,
  `docker compose down -v`, VM/storage removal — it also carries an older code
  where one applies), destructive tool names, and anything too large, nested or
  dynamic to read ("unreviewable"). The same assessment builds the preview's
  `risk` and stable `reasons`, so a held card states why; it is a tripwire on
  what the harness reported, not a sandbox, and cannot see inside scripts or
  package scripts. A request that only writes the session's own todo list
  (`isSessionPlanPermission`: bare native todo/plan tools such as `TodoWrite`,
  `todowrite`, `update_plan`, plus Polyth's `polyth_todo` under the
  `polyth-agent-tools` MCP names — Claude `mcp__…__`, OpenCode `…_`, Antigravity
  `mcp_…_` and its unwrapped `call_mcp_tool`) is answered automatically at every level,
  `off` included; explicit deny rules and guarded Spaces still win, and another
  MCP server's `todo` tool is not exempt. Held, undeliverable and manual requests count in
  `attention.permissions` even while auto-accept is on. A third explicit
  setting, `all` ("Full access"), approves every request that no explicit
  deny rule blocks, high-risk ones included; it inherits like `on` (a nearer
  `on`/`off` narrows it), the projection carries `autoAcceptAll`, and
  `AutoAcceptDto.level` reports `off`/`routine`/`all`. The UI only enables it
  after a confirmation, from a held card's "Allow all" or the auto-approve
  control (a click opens a tiny icon-only segmented switch — Ask /
  Auto-Approve / Full access — that picks any level directly; choosing Full
  access asks first).
  Approval defaults (Settings → Permissions and Project settings → Approvals,
  owned by `@polyth/permissions`) give the root level of a chain with no
  explicit choice: the session's project's own level if it has one, else the
  Space's (`off`, `routine` or `all`); an explicit `on`/`off`/`all` anywhere in
  the chain still wins. The default follows the session's *own* project, so a
  subagent spawned into another project falls back to that project's level;
  `chainAutoAcceptLevel` in `sessions.ts` resolves it, `inherited` included.
  They are stored per Space in `<space>/packages/permissions/full-access.json`
  (the historic name: `level` and `projects` are current; `enabled` is still
  written, true only when the Space is `all` and no project is narrower, so an
  older server fails closed) and read through the
  `permissions.approval-defaults` service; an unknown level or project entry
  reads as `off`. Changing one refreshes every session's flags in that Space
  and answers waiting requests the new level allows; a guarded Space ignores
  them. `GET /api/permissions/defaults` (any Space member; `canEdit` marks the
  instance owner) lists the Space level and the levels of its own projects;
  `PUT /api/permissions/defaults` `{level}` and
  `PUT /api/permissions/defaults/projects/:projectId` `{level|"inherit"}` are
  instance-owner only, resolve the project through the caller's Space (another
  Space's id is not found), and refuse any raise that does not come from a
  person (public listener or full-access paired device), so the agent control
  socket can only lower them. The UI asks through two separate warnings before
  Full access becomes a Space or project default; lower levels save at once.
  `GET/PUT /api/permissions/full-access` remains for older clients as a switch
  over the Space level (`enabled: false` returns a Full access default to
  `off`). `AutoAcceptDto.inherited` reports the level clearing a choice would
  give, which the agent route uses to refuse an `inherit` that would raise
  autonomy. An `always` reply without a scope is remembered for its session
  only.
  The agent
  actor (`/api/agent/sessions/*`, the Polyth MCP `permission.*` actions) may
  only reduce autonomy: it can reject a request or turn auto-accept off, but
  approving a request, setting `on` or `all`, or clearing a choice so that an
  ancestor's broader level would apply returns 403 — those are user decisions
  in the UI. The one exception is a person's per-request delegation: from a
  subagent's card (its own, or the parent's mirror) "Let agent decide" calls
  `SessionService.delegatePermission`, which appends `permission/delegated`
  (child: `delegateSessionId` + wake `operationId`; parent mirror:
  `sourceSessionId`) and wakes the parent with a hidden, model-visible prompt
  carrying the redacted preview. Only that exact parent session may then answer
  through the harness `polyth` tool's `permission.reply` (`once`/`reject`,
  `replyDelegatedPermission`); a person may still answer the card. Delegation
  is refused for (legacy) composer-shell confirmations, root sessions and guarded
  Spaces, and a delegated mirror no longer holds its parent `waiting` or
  queues the deciding turn behind it. The wake queues while the parent's turn
  runs, so a parent blocked inside a native in-turn subagent tool cannot
  decide until that turn ends. A `notify` seam fires `attention` (permission/question that
  actually reached the UI) and `turnStopped` for out-of-page delivery.
- `sessionSweep.ts` — pristine-session garbage collection. A session whose log
  never left the create/reconcile lifecycle (no prompt, no package/tool/browser
  activity, no queue, no draft, no child) is eligible only when it is an old
  `failed`/`unknown` startup remnant. Idle sessions and sessions owning a
  worktree, isolation or package purpose are retained. Deletion carries the
  observed event/projection versions so a concurrent draft, queue or status
  change wins. Delegated children are excluded; their lifecycle belongs to the
  parent's settlement path.
- `failedStartupCleanup.ts` — every automatic removal of a failed or
  never-started session (browser cleanup, delegated-child settlement in
  `sessions.ts`, the pristine sweep) obeys the synced
  `product.autoDeleteFailedStartupSessions`. The server reads the account
  recorded for the session, then the nearest ancestor's, then requires every
  Space member to allow it; an unresolvable Space keeps the session. A
  delegated child whose delivered prompt ended in a recorded turn error
  (`turn/failed`, `turn/stopped` reason `error`, e.g. `rate-limited`) is never
  auto-deleted. Forensics for a vanished session: `deletion_tombstones` and
  `runtime_operations` rows with `mutation_kind` `session-delete`.
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
  `POLYTH_UI_PASSWORD_LOCALHOST=optional` is the legacy local-password exception.
  Canonical identity instead requires a real account session, except for the explicit
  development-only `POLYTH_DEBUG_AGENT_ACCESS=1` loopback agent mode described below.
- `push.ts` (F18) — web push in `node:crypto` only: aes128gcm payload encryption
  (RFC 8291) + VAPID ES256 authorization (RFC 8292). Keys are minted once into
  `data/push.json` (rotation would orphan every browser subscription) and
  subscriptions persist beside them; `send` encrypts per subscription, drops
  dead endpoints (404/410) and returns `{sent, dropped, failed}`. Every non-2xx
  answer and network error is logged with the endpoint host only (the full
  endpoint URL is a bearer capability) and a bounded, redacted response body;
  other rejections (403 VAPID mismatch, 413, 429) keep the subscription. `createPushNotifier` bridges the session service's
  notify seam to templated payloads (same allowlisted bounded semantics as the
  in-page notifier): subagent completions attribute to the parent session,
  aborted turns stay silent, and auto-accepted permissions never reach the seam.
  The body says what happened when the durable events show it — a plain-text
  excerpt of the turn's final reply, the error, the first question, or the
  requested command/path first (`Run: npm test`) — read from bounded keyset
  pages of that session only (`tail`, never a log replay): the walk reads at
  most four pages backwards and stops at the first `turn/started`, so a
  tool-heavy turn's reply is still found without ever crossing into an earlier
  turn, and a top-level chat waiting for the person carries that reply too.
  Anything missing within the bound falls back to the status text, and content
  is redacted and capped at 200 characters. The native relay stays blind (ids
  and kind only).
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
  voice (engine settings + TTS proxy + summarize), assist (explicit prompt/suggestion/chat→note/task-brief actions; idle recap settings/read live in `packages/recap`), auth (F16 status/login/logout/logout-all/device sessions),
  autoAccept (F18 per-session policy GET/PATCH), push (F18 key/subscribe/test), goals.
- `behavior.ts` / `mcp.ts` — server-owned behavior instructions (`behavior.md`) and MCP
  server config (`mcp.json`), applied to OpenCode through the adapter's config applier.
  Disabled MCP servers are removed from the applied config entirely (F10); secret
  values live in `mcp-secrets.json` and are never returned by any API. Space/project
  servers are admin-managed; personal servers live in the person's `mcp` storage and
  vault partition (Spaces §14.6).
- `search.ts` — pure workspace matcher (projects/sessions metadata, `is:archived`).
- `permissionPreview.ts` — redacted, risk-scored previews built server-side before
  `permission/requested` is appended.
- `review.ts` — structured review generation + the bounded implementer/reviewer flow
  (pauses on permission waits, hard iteration limit). The implementer is a normal
  tool-capable session: the handoff prompt instructs it not to merge/push/publish,
  but nothing structurally prevents it.
- `oneshot.ts` — single-turn utility completion on a runtime. Adapters that
  can address a provider without a session implement `completeSmallModel`
  (opencode direct provider HTTP; pi, claude, codex, cursor, antigravity and
  command-code CLI print modes through the shared `harness-runtime` runner);
  `oneshot` remains the compatibility fallback for goals auditor, commit
  messages, fusion synthesis and walkthrough generation. It settles on the
  runtime's `turn/stopped`; for runtimes that publish the finished answer but
  never the idle notification (OpenCode V2), a quiet-interval reconcile that
  reports a terminal state settles it, as the session service's quiet-turn
  check does for conversations.
- `assist.ts` — explicit small-model composer suggestion, prompt-rewrite, and
  chat→note helpers. It does not schedule background model work.
- `packages/recap` (F9) — optional, disabled-by-default idle watcher. While the
  package is enabled it subscribes to the neutral server turn-completion bus,
  waits for the configured quiet period, then writes a ≤20-word recap + at most
  one grounded follow-up to the projection. Disabling the package unsubscribes
  the watcher and clears pending timers.

## REST surface

Core: `/api/health`, `/api/projects` (+`/create`, DELETE), `/api/sessions`
(list/create/snapshot/events/message/shell/fork/rewind/rewind-clear/abort/archive/restore/bulk;
`message` accepts `attachments` — shape-checked, path-traversal-rejected and
existence-verified against the session root before anything is logged or queued;
URL attachments are link-only and never fetched server-side),
`/api/sessions/:id/queue` (+`/order`, DELETE item),
`/api/sessions/:id/permission/:reqId` (+`/delegate`), `/api/sessions/:id/question/:reqId` (+`/reject`),
`/api/models`, `/api/agents`.

Feature routes: `/api/folders`, `/api/labels`, `/api/search/workspaces`,
`/api/search/sessions` (metadata matches + ranked FTS5 transcript hits with `seq`/`role`/`time`/highlight `ranges`; `projectId`/`role` filters), `/api/files/*`
(tree/stat/read/raw/write/mkdir/rename/delete/upload/search), `/api/commands`,
`/api/snippets`, `/api/git/*` (status/diff/show/stage/unstage/discard/commit/commit-message/
log/graph/branch(es)/checkout/folder/stash/stashes/fetch/pull/push; optional owned
`sessionId` selects its worktree), `/api/worktrees` (+`/remove`), `/api/terminals`
(POST input, PATCH rename, DELETE close; `/ws/terminal/:id` replays scrollback then streams live),
`/api/preview` (+start/stop; optional owned `sessionId` selects its worktree), `/api/browser/*` (sessions/capability/approvals),
`/api/dictation` (+capability), `/api/multiruns`, `/api/fusions`, `/api/walkthroughs`,
`/api/schedule` (+preview/draft/trigger-preview/sources/:id/context/:id/file/loops/loops/rescan), `/hooks/schedule/<token>` (anonymous webhook), `/api/planner` (+preview/:id/:id/pause/:id/resume/:id/run/:id/runs), `/api/usage/identity`, `/api/usage/stats`,
`/api/knowledge`, `/api/memory` (project-scoped list/CRUD/review/policy/import/export/clear), `/api/github/*` (status/repo/issues/prs/pr/checks/comments/diff/files;
F7 writes: `pr/create`, `pr/update`, `pr/merge` — merge requires `confirm:true` and a
squash/merge/rebase strategy, never deletes the branch; `pr/describe` returns a
small-model title+body draft from `git diff base...HEAD` and never submits),
`/api/agent/sessions`, `/api/agent/backend-sessions` (GET unadopted OpenCode
sessions `{items, total}`; POST `/import {projectId, ids}` adopts selected —
listing sessions no longer auto-adopts), `/api/agent-profiles`, `/api/settings/behavior`,
`/api/mcp/servers` (CRUD + POST `:id/test`|`:id/probe` reachability check that
stores status/lastError; `:id/authorize` is an honest 501 until the backend
bridge exists; writes need a Space admin), `/api/mcp/personal/servers` (the
caller's own servers: CRUD, `:id/tools`, `:id/test`|`:id/probe`), `/api/mcp/access`, `/api/plugins` (+install), `/api/system/info`,
`/api/settings/voice` (GET/PUT engine endpoints in `data/voice.json`; a key is either a
write-only value typed in Settings — PUT `keys: {slot: value|null}`, stored per service slot
(`tts:<provider>`, `tts-secret:<provider>`, `dictation:<provider>`, `stt`) in owner-only
`data/voice-secrets.json` and preferred over the env ref — or an env-var *name*; a key pasted
into a name field is moved into that file. GET returns only `configured` flags and the
`storedKeys` slot names, never a value), `/api/tts/speak`
(server voice through the configured `tts.provider`: an OpenAI-compatible
`/audio/speech` URL, or OpenAI TTS, ElevenLabs, Google Cloud TTS, Amazon Polly (SigV4,
key-pair env refs + region) or Gradium at their fixed endpoints — `dictation/src/ttsProviders.ts`;
buffered audio back, only standard fields forwarded, honest 503 when the URL or key is
missing; local-only for paired devices),
`/api/tts/voices` + `/api/tts/local` (built-in Piper/Kokoro voices run by the
dictation package's sherpa runtime in a child process; one-step install of voice +
engine, WAV synthesis with measured real-time factor; listing and synthesis are
paired-device safe, install/remove are not), `/api/tts/summarize`
(small-model shortening for read-aloud; 503 when no small model is wired),
`/api/settings/assist` (Recap-package quiet-time settings; route exists only while Recap is enabled),
`/api/sessions/:id/assist` (Recap-package freshness-checked recap+suggestion — 404 `stale` once conversation activity moves past it), `/api/sessions/:id/assist/note` (small-model chat→note
DRAFT; saving goes through the normal `/api/knowledge` flow),
`/api/auth/*` (F16: GET `status {required, authorized}` and POST `login {password}`
are the only public `/api` paths — login mints an httpOnly SameSite=Strict
`polyth_auth` cookie, 401 `invalid-password` on a miss, 429 `rate-limited` +
`Retry-After` when the IP window locks; POST `logout` / `logout-all`, GET
`sessions` device list, DELETE `sessions/:id` per-device revoke),
`/api/sessions/:id/permissions/auto-accept` (F18: GET `{setting, effective, level}`,
PATCH `{setting: on|all|off|inherit}` — the explicit setting is stored on the
canonical session projection; enabling reconciles live and reconnected pending
requests through the same server resolver),
`/api/push/key` (VAPID public key + subscription count), `/api/push/subscribe`
(POST registers the browser's PushSubscription, DELETE removes by endpoint),
`/api/push/test` (POST sends a test notification to every subscription and
answers `{sent, dropped, failed, ownDropped}`, where `ownDropped` says whether
the optional caller-named `endpoint` expired; other devices' endpoints never
leave the server; never creates a notification-centre row), `/api/notifications` (NTF-01: GET
`{items, unread}` oldest-first from the server-owned inbox in
`data/notifications.json`, optional `after=<ts>` cursor over strictly
increasing timestamps while `unread` stays global; POST `read {ids}`,
`read-all`, `clear` — bodies carry opaque notification ids only, never a
project/session scope; rows are recorded at the push notifier's send sink,
newest 200 retained FIFO; a package may take over the routine turn
notifications of sessions it owns through
`SESSION_ATTENTION_SERVICE.claimTurnNotifications` and report outcomes itself
with `notify` (approval and question notifications are never claimed)),
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

Subscribe order is a priority contract: the subscribed session's gap-fill, then
its full `projection`, then the navigator `projections` page (which omits that
row). A subscriber that sends `syncToken: <int>` also gets `synced {phase,
token}` after each part — `phase: "session"` once the open session and its row
are current, `phase: "sessions"` once the list is too (sent on every subscribe,
also when a same-scope resubscribe skips the list). The client
(`SyncClient.onFreshness`) marks both parts stale when the transport breaks or
the subscription moves, ignores receipts for a superseded token, and — only
until it has seen one receipt — settles an old gateway after
`receiptFallbackMs`. `apps/web/src/syncCatchUp.ts` turns that into the
"Updating…/Reconnecting…" pill (after 700 ms; stale data stays visible and
usable) and holds connection-loss toasts for up to 20 s while healing; see
[mobile platform behavior](../mobile/platform-behavior.md).

## Event vocabulary

Turn flow: `user/message` (optionally carrying sanitized `attachments:
AttachmentRef[]` — file/image/range/url; persisted before the runtime sees
them, so replay/fork keeps them), `turn/started`, `assistant/chunk`,
`assistant/reasoning-chunk`, `assistant/message`, `tool/call`, `tool/result`,
`tool/error`, `turn/stopped`, `turn/failed`, `usage/recorded`.

Streamed deltas are journaled as *checkpoints*, not tokens. Backends emit one
`assistant/chunk`/`assistant/reasoning-chunk` per provider delta; the ingress
(`packages/server/src/streamCoalesce.ts`) merges a run of consecutive deltas for
one part into a single event, written at most once per 250 ms window, at a
4 KiB per-part cap, or before the next non-stream event — whichever comes
first. The first delta after a quiet period is persisted immediately, so
first-token latency is unchanged, and journal order still equals delta order
because only adjacent same-part runs merge. Replay semantics are unchanged: the
reducer appends part text and the turn's `assistant/message` (which carries the
complete text and reasoning) still finalizes the part, so a crash can lose at
most one window of a *partially* streamed part. The v2 observation ingress is
not covered by this policy — its observations carry per-observation cursors,
and the only v2 runtime already coalesces its own deltas.

Requests: `permission/requested` (with server-built preview + allowed scopes;
the preview's `risk` and optional `reasons` codes come from the same
assessment that gates auto-accept), `permission/resolved` (carries
`auto: true` when the session's F18 auto-accept policy resolved it — appended
immediately after the request so the log stays truthful while no banner shows;
a high-risk request is never resolved this way), `permission/delegated`
(a person handed a subagent request to its parent agent), `question/asked`,
`question/answered`.

Session lifecycle: `session/created`, `session/forked`, `session/archived`,
`session/restored`, `session/metadata-changed`, `session/imported`,
`session/history-imported`, `session/rewound`, `session/rewind-cleared`. Rewind
markers soft-splice model history in `deriveMessages`; replacement sends reset
the backend session before appending a new tail. A rewind targets a visible
`user/message` or a non-declined `question/answered` of the session's own
question (never a subagent mirror); the latter keeps the question and cuts from
the answer onward. A runtime that branches natively (OpenCode) may keep the
original answer inside the cut question's tool call; the edited reply then
arrives as the next message (source-inspected, not live-verified).

Runtime status: `context/updated`, `session/compacted`. Compaction markers are
ignorable canonical facts: the harness package renders them in the timeline.
An optional `summary` carries the harness's own condensed context when it
shares one (Antigravity's checkpoint content, Claude Code's summary when it
streams one, and every Polyth-owned compaction; Codex and OpenCode markers
carry none). It feeds runtime-epoch recovery and the marker's expanded
view and new-chat draft, and never becomes dialogue.
Manual compaction (`SessionService.compact`: `/compact`, the context gauge,
"Compact before proceeding", agents' `whenFull: "compact"`) uses the runtime's
native compaction when it declares one. A runtime that finishes in the
background (Claude Code) confirms `compactOperation` with
`completion: "pending"`; sends then queue (reason `compaction`) until it
reports `session/compacted` or the `session/compaction-failed` runtime event
(persisted with `strategy: "runtime"`), with a 10-minute backstop. Otherwise
Polyth compacts itself
(`compactWithFreshLegLocked` in `packages/server/src/sessions.ts`, helpers in
`packages/session/src/compaction.ts`): it records `session/compaction-requested`
(`strategy: "fresh-runtime-leg"`) and sets the context window's
`compaction.active`; the session's own model (the owning account's small
model, else `POLYTH_SMALL_MODEL`, as fallback, through `SmallModelService`; `summarizeSessionFirst` in
`packages/server/src/smallModel.ts`) summarizes the confirmed canonical
history since the last summary-bearing compaction. The summary runs first on
the session's own wired runtime through its direct completion only, because a
session-bound harness (Antigravity) cannot lend a project-scoped runtime; a
project runtime is used only when that runtime has no direct completion or
for the small-model fallback. A rate-limit resume's "Compact before
proceeding" asks the small model first (`smallModelFirst`), and falls back to
this Polyth compaction when the runtime's native one fails. A same-harness fresh leg
(the rewind replacement path: release proof, fresh native session, epoch
transition) replaces the native context; and `session/compacted` follows with
`source: "polyth"`, the `summary` and `epochMarkerSeq`. That leg's first turn
restores the summary ahead of a short verbatim tail
(`planRuntimeEpochRecovery` reason `compaction`, still within the 16k-character
recovery cap). A failure before the switch changes nothing and records
`session/compaction-failed`. The HTTP request returns once the compaction is
under way; the summary runs in the next flight of the session lock, and the
timeline's "Compacting…" row (harness package) carries progress and failure.
The first turn after an unrestored `session/compacted` re-delivers the durable
context a native summary may have dropped — the active goal, user pins and, when
workspace instructions are enabled, the workspace `AGENTS.md` (otherwise sent
only on a runtime leg's first turn) — and stamps `compactionRecovery` on that
`user/message` so later turns do not repeat it.
Context pressure: when the live context window of the current runtime
generation reaches 50% or 75% (`CONTEXT_PRESSURE_LEVELS`), the next admitted
turn's `recoveryContext` carries a `<polyth-context-pressure>` note that
suggests delegating broad reads and independent work through `agent.spawn`
(at 75% also compaction or a fresh session), and stamps
`contextPressure.level` on that `user/message`. Each level is announced once
until the next `session/compacted`. The note follows the subagent-routing
behavior policy; with that policy off nothing is added.
Native commands: a `user/message` with `command` (a `raw-native-input`
runtime command) reaches the runtime as exactly `/name args`, because a
harness runs a command only when the prompt starts with it. It carries no
`recoveryContext`, memory, epoch or compaction recovery, workspace `AGENTS.md`
or pressure note, and stamps none of them, so each stays pending for the next
ordinary prompt; its turn does not spend the runtime leg's first-prompt
bootstrap either (`isContextFreeNativeCommand` in `@polyth/session`).
User-attached files still ride with the command. The builtin `/compact` is not
a native command: it is the host action above, even on Claude Code.

Delivery: `queue/enqueued`, `queue/dispatched`, `queue/reordered`, `queue/removed`,
`delivery/steered`, `delivery/fallback-queued`. Queued items keep their
attachments and memory narrowing durably (queue table columns); steering is text-only, so a steer
with attachments falls back to queue (`steer-attachments`).

Work state (revisioned snapshots): `task/snapshot`, `subagent/snapshot`. The web
reducer turns task revision deltas into replay-stable created/started/completed
timeline rows; it never appends a second event for this UI derivation.
Adapters build `task/snapshot` with `@polyth/todos` (status/shape normalization,
clock-seeded revision trackers, incremental `TaskCreate`/`TaskUpdate` support);
see [`packages/todos/README.md`](../../packages/todos/README.md) for which native
todo/plan surface each harness maps. Harnesses without one use the package's
`polyth_todo` agent tool, which writes the same list (revision rule in that README).
The package also ships two opt-in widgets, `todos.progress` (done/total, active
item, elapsed) and `todos.subagents` (children from the newest
`subagent/snapshot` with status and rolled-up tokens/cost; totals are marked
partial while a child's usage is not loaded, because the host has no
children-by-`parentId` query yet).

Workflows: `goal/attached|audit|continuation-admitted|completed|paused|resumed|stopped|stuck`,
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
  config, `polyth.widgetLayout.<projectId>` local cache plus project-settings
  persistence),
  `WidgetCanvas.tsx` (the drag/resize canvas), `widgetLibrary.ts`,
  `builtinWidgets.tsx`/`builtinMiniWidgets.tsx`/`capabilityWidgets.tsx`
  (shell widgets), `areas.ts`/`builtinAreas.ts` (placement areas). Full
  guide: `docs/dev/widgets.md`.
- `components/` — views + panels. Notables: `Composer` (drafts, delivery modes, prompt
  token grammar from `composer/language.ts`, mic button via slot; dictation
  streams into the draft through `COMPOSER_DICTATION` — one run owns one span
  at the end of the draft and every cumulative update *rewrites* it, so
  re-punctuation corrects itself and a send or a typed word mid-run re-anchors
  the span instead of being overwritten, see `composer/transcriptSpan.ts`),
  `Timeline` +
  markdown pipeline (`markdown/` — while a row is the live row of a working turn,
  `holdBackStreamingTail` withholds a trailing block whose type is still
  undecided (pipe rows before their table separator, an open table row, a lone
  `#`/fence/`$` marker) so it never flashes as prose; fenced code, Mermaid, KaTeX, JSON tree, galleries,
  conservative file references with go-to-line — a token must name a file
  (`apps/web/src/store.ts`, `docs/README`), never a bare value pair or ratio
  (`static/visible`, `35/35`); L13: windowed rendering via `timelineWindow.ts` —
  long sessions render only the last 150 rows as a suffix window, "Show earlier"
  reveals anchored, prompt jumps grow the window; the prompt-navigator rail gains a
  hover-preview card with the bounded full prompt; `SelectionMenu` floats over
  transcript selections with Quote in reply / New session from selection / Copy,
  pure helpers in `selectionActions.ts`), `PendingChangesBar` (shared git-status source
  with edit-tool fallback), `QuestionCards` (in-timeline multi-question stepper row),
  `PermissionBanner` (preview + scoped Always), `ContextRail` (F17 surface host: renders the
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
  `packages/recap/widgets/RecapStrip` (F9: package-owned fresh recap line under the last message; its suggested next prompt rides on the composer's one suggestion chip, never a second chip),
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
user text. A newly-created session whose first startup fails before any agent
output is recorded is the exception: the existing error is shown, then the
session is removed when `autoDeleteFailedStartupSessions` is enabled (the
default). Canonical unknown outcomes, recoverable retry plans, agent output,
and user aborts remain recoverable.

- Theming (F15): `theme.ts` — JSON token schema (surface/line/ink/brand/signal/
  syntax roles) resolved to CSS custom properties at one apply point
  (`applyTheme`); 34 bundled palettes. New installations start from the
  curated appearance in `DEFAULT_SETTINGS`/`UI_DEFAULTS` (the Glass look, the
  macOS 27 theme — id `liquid-glass`, the Liquid Glass style — following the
  system's light/dark mode, compact density, Open Sans 14px menus / 15px chat,
  rounding 9, the bare window layout with floating columns); a
  saved record that lacks one of those fields keeps its earlier value
  (`midnight`/`Midnight`, `appearanceMode: "system"` following
  `prefers-color-scheme` live, …), so changing a default never restyles an
  existing profile. Text scales against the fixed `TEXT_SCALE_BASE` (15px), not
  the default size. Custom themes are pasted JSON validated with
  the rejection reason and stored in `polyth.customThemes`. `styles.css` derives
  every surface (diff washes, syntax roles, user bubble, glows) from tokens via
  `var()`/`color-mix`; Mermaid re-renders from live token values on the
  `polyth:theme` event. A theme may carry an optional validated 16-colour
  `ansi` palette (used by the terminal; dropped when adapting to the opposite
  appearance). Icons have no skin token and inherit `currentColor` from text
  roles; a legacy `iconTint` field still loads and is dropped. Skins can be
  pasted or loaded from a `.json` file (≤256 KB), and the 16 ANSI slots edited
  in Settings. Settings can preview the unsaved draft live, warn on low
  contrast (`themeContrastIssues`, advisory) and download a skin file
  (`exportThemeJson`). Four settings are independent and meet only in
  `resolveTheme`: the **style** (`themeStyle`: `liquid-glass`, the macOS 27
  recipe in `liquidGlassTheme.css`; `fluent`, the Windows 11 recipe named
  Polyth in `fluentTheme.css`; `macos`, the Big Sur recipe in `macosTheme.css`;
  `classic`, Quiet Glass with no recipe; published as `html[data-theme-style]`),
  the **colour scheme** (`theme`, any palette, drawn in any style), the
  **accent** (`accentColor`, a source colour `accentRoles` turns into
  accent/accentHi/accentInk at 4.5:1 for the style and appearance, over both
  appearances of the scheme) and the **colour mode**. A palette's own `style`
  names the style it was authored for: Settings lists those schemes first, and
  a record saved before the split (`themeStyle: "auto"`) keeps drawing each
  palette in it until the user chooses anything on the Theme section, which
  pins the style shown. An imported skin brings its style when it names one and
  its own accent. A theme may also carry a hand-authored `counterpart` for the
  opposite appearance, used instead of the generated adaptation; an unknown
  style loads as a plain palette. A selected custom theme that arrives after
  boot (account sync) is applied as soon as it lands. See `docs/dev/styles.md`
  "Theme layers", "Liquid Glass theme style", "Fluent theme style" and "macOS
  theme style".
- Preferences: `settings.ts` (`polyth.settings`), `uiPrefs.ts` (including
  `polyth.editorPrefs`), `sidebarPrefs.ts`,
  `prefs.ts` (personas/enabled plugins), `draftRecord.ts` (scoped local
  text, attachments, recovery shelves and server revision metadata),
  `utils.ts` (dirty draft sync after idle time, on session switch and page
  hide), and `drafts.ts` (draft presentation helpers). `modelPrefs.ts` keeps a
  synchronous account-local cache but is canonically mirrored in
  `/api/settings/client` with the other server-owned client preferences; the
  models package's `modelVisibilityPrefs.ts` caches the OpenCode Providers &
  Models toggles the same way, in the server-owned `modelVisibility` section.
  Server-owned settings go through `/api/settings/*` routes.
- `attachments.ts` (F2) — pending composer pills per session
  (`polyth.draft.att.<sessionId>`; the draft store owns text + pills): stat-verified
  project-file/range refs, `_inbox/` uploads for drops/pastes and annotated browser
  captures, GitHub PR/issue URL pills gated on the project's remote
  (`/api/github/repo`). Rendered by `AttachmentPills` (composer: removable;
  timeline: read-only); Files owns its row/context actions in the package
  `EditorView` instead of a shared app-level row-actions component.
- `notifications.ts` — kind-filtered, allowlisted-template, replay-deduped web
  notifications; `voice.tsx` — engine-aware TTS/STT with the composer mic slot
  (browser Web Speech by default; built-in server voices via `/api/tts/local`,
  custom server voices via `/api/tts/speak`, and the
  `/ws` streaming dictation client in `dictationClient.ts`, with optional
  summarize-before-speak through `/api/tts/summarize`). The mic slot renders
  the button alone: interim words go to the composer, lifecycle/failure reasons
  go to the live region and the tooltip, and listening is shown by the button
  brightening with measured speech loudness (`--mic-level`, fed by
  `Pcm16CaptureOptions.onLevel`; Web Speech has no audio, so recognized words
  pulse it instead).
- Access control (F16): `main.tsx` checks `/api/auth/status` before `init()`
  runs — when a password is required and the device has no session,
  `LockScreen` renders instead of the app (login → cookie → normal boot). A
  401 on any non-auth endpoint dispatches `polyth:auth-required`, which
  re-locks the UI (reload-on-unlock keeps store/WS state clean). Settings →
  Users → your account lists the browsers signed in to the account with
  per-device sign-out and "Sign out everywhere".
- Auto-accept + push/PWA: the permissions package's
  auto-approve control (session header and composer; server owns the policy;
  its tooltip says high-risk actions still ask) reads the session projection
  when its slot host passes only a session id (the header) and shows Full
  access in the danger tone. It has no background: the state is the icon
  colour and glyph (empty shield = Ask, shield-check = Auto-Approve, shield-alert =
  Full access). A click or tap opens the same anchored icon-only segmented
  switch on desktop and phone (`Popover`, `compact` on phones); level names
  and meanings live only in each segment's label/tooltip so the switch never
  resizes while switching, arrows move within the radio group, a choice
  closes it (Full access asks first), and the new-chat composer holds the choice until the chat exists
  (`setDraftAutoApprove`); until a level is picked it shows, and the chat
  inherits, its project's approval default (else the Space's). The trigger's
  tooltip says whether the level was chosen for the chat or follows a
  default; a chat (or draft) with its own level also gets a "Use default"
  button after a divider, which sets `inherit` (a subagent's goes back to its
  parent chat) and asks first when the level it would get is Full access,
  read from the server's `AutoAcceptDto.inherited`. `reduce.ts` marks
  policy-resolved permissions `auto` so the timeline can label them, and
  legacy composer-shell confirmations `manual`. It tags tool items produced by
  `composer-shell` (`ToolMsg.composerShell`); `groupActivity` keeps them out of
  agent activity blocks like a prompt, and the timeline renders them as an open
  terminal row (`ComposerShellRow`) with the command, output and exit state. While auto-accept is on, the store
  hides (and leaves out of the attention overlay) only pending requests the
  effective level will answer (`autoAcceptAnswers` in `store.ts`), so held
  high-risk and composer-shell cards stay visible and counted. A mirrored
  subagent/workflow-node card is never hidden by the parent's policy: the
  server mirrors it (with the child's preview and scopes) only after the
  child's policy held it for a person, and the card's session/Full access
  actions change the child's policy, not the parent chat's. A
  high-risk card lists its localized reasons and a "What this affects" blast
  radius (`describeBlastRadius` in `@polyth/permissions/risk`, computed in the
  card from the request patterns and the session's runtime directory/worktree:
  paths and whether they are inside the workspace, the whole workspace, Git
  data, outside or unresolved; force-pushed/deleted refs; SQL statements;
  destroyed resources; upload hosts; "nothing narrows it" for unfiltered
  scopes; targets stripped of URL credentials and token-like values). Paths
  inside the workspace are shown relative to it, and each target renders as
  a left-to-right monospace span so RTL locales cannot reorder it. It
  explains, never decides. Reason codes are append-only and clients skip
  unknown ones. The card offers Deny, Allow, or
  "Allow all" (Full access after confirmation), because routine auto-approve
  cannot resolve it; a composer-shell card offers only Deny and Allow, since
  no policy answers it. A parent's mirrored card names its subagent (with an
Open action) and, like a subagent's own card, offers "Let agent decide"
unless it is a composer-shell confirmation; once delegated it says the parent
agent is deciding and keeps Deny/Allow. `push.ts` registers the root-scope service worker
  at authenticated app boot (`sw.js`, plain JS copied verbatim to `dist/`),
  while `manifest.json` + 192/512 any/maskable icons make the root-scoped app
  installable in standalone mode. Enabling push mints a `PushSubscription`
  against the server's VAPID key, and keeps the server list in sync;
  Settings → Notifications has the toggle + test button (needs a secure
  context — https or loopback). The test button names expired and failed
  counts; when this browser's own subscription expired it unsubscribes it,
  mints a fresh one without a prompt (permission is already granted) and
  sends the test once more (`sendTestPush` in `apps/web/src/push.ts`). The worker shows notifications only when no
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
`session.header.actions`, `session.header.status`, `session.list.badges`, `composer.leading`,
`composer.trailing`, the headless `composer.suggestion` (next-prompt sources),
`contextRail.tabs`, `settings.pages`,
`commandPalette.commands`, `workspace.main.tabs`, `workspace.right.tabs`,
`session.timeline.before/after`, `session.message.actions`,
`sidebar.project.actions`, `sidebar.session.actions`, `sidebar.sessions.bulk.actions`, `sidebar.project.leading`,
the widget placement slots (`workspace.header/left/main/right/bottom/floating`,
`widget.catalog`, `widget.settings`), and the fine-grained toolbar areas
(`app.header.leading/center`, `app.statusbar.leading/trailing`,
`workspace.rail`, `sidebar.toolbar`,
`composer.meta/pending`, `composer.config`, `composer.context.details`, `session.footer`, `session.empty.widgets`,
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
per-Space `packages/knowledge/knowledge.db`, per-Space `packages/usage/analytics-v1.json` (rebuildable analytics checkpoint), host-account `packages/usage/usage-limits-v1.json` (last-good provider/harness limit snapshots plus bounded pace samples), `projects.json`, per-Space `packages/planner/planner.json`, per-Space `packages/agents/schedule.json` (formerly `packages/schedule/`; the shared `schedule.json` keeps only tasks whose project has no resolvable Space; the pre-split copy is kept once as `schedule.json.pre-space-split`),
`behavior.md`, `mcp.json`, `plugins/` + `trusted-plugins/`, `packages/<id>/`
(each removable package's deployment-wide data, e.g. `packages/ssh/ssh.json`,
`packages/walkthrough/walkthroughs.json`, `packages/dictation/{models,voices,runtime}`;
files a package once wrote at the root are moved there on first start by
`adoptLegacyPackageData`), per-Space `packages/browser/browser-shots`, `auth.json` (F16: password hash + remembered device sessions —
token SHA-256 hashes only, never tokens or passwords), `auto-accept.json` (F18:
legacy per-session on/off records imported into canonical session projections),
`push.json` (F18: VAPID keypair + push subscriptions).

## Security posture

Canonical `boot()` binds `127.0.0.1` by default; wildcard/public exposure is
an explicit deployment choice. Addresses shown in system info come from configuration,
never from the Host header. Canonical browser identity normally requires a real account
session, while Polyth Link carries its own server-minted ingress identity and grant
checks.

`POLYTH_DEBUG_AGENT_ACCESS=1` is an explicit development-only exception for local
agent/API inspection. Direct loopback public HTTP/WS may be projected to the active
owner without a browser session. Startup rejects this mode if the listener is not
loopback-only, if `POLYTH_PUBLIC_ORIGIN` is configured, or if the deployment profile
is not `local-trusted`. The exception is evaluated from server-created ingress, never
client headers, so it does not apply to Polyth Link. Canonical `/api/auth/*` setup,
same-origin and CSRF handling stay unchanged. In that local-only profile a
direct-loopback `GET /api/auth/status` also mints one reusable owner session, because
reporting `authorized` while every other identity read still demanded a cookie left
the beta browser UI locked with no credential to enter.

Permission engine fails closed. Browser sessions run in isolated contexts with an
origin policy (no cam/mic, no private IPs, no downloads); observations are redacted.
Quota adapters redact secrets before snapshots reach the client. GitHub auth is
delegated to the `gh` CLI — no tokens stored. Uploaded files land in a project
`_inbox`.
