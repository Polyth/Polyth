# Sequenced implementation work packages

These 15 packages are ordered by contract/risk dependency. Each should be a reviewable, tested increment. Do not batch all domains into one change.

## WP1 — Contract and migration foundation

**Scope:** Add shared DTOs/events for editor locations/revisions, queue delivery, task/subagent snapshots, session attention, project/session metadata, pane surfaces, profiles, schedules, knowledge, quotas, reviews, browser, and dictation. Add forward-only persistence migrations and backward-compatible decoders.

**Files/packages:** `packages/contracts/src/index.ts`, `packages/session/src/index.ts`, package-owned stores/migrations, `packages/server/src/ws.ts`, `apps/web/src/api.ts`, `apps/web/src/reduce.ts`.

**Done**

- Existing event logs and JSON stores reopen unchanged.
- New fields are optional to old clients; unknown events remain ignorable.
- `/ws` gap-fill/projection behavior is unchanged.
- Contract tests cover serialize/parse/migrate/reopen.

## WP2 — IME-safe input and accessibility primitives

**Scope:** Build `AdaptiveTextInput`, composer editor command handle, dialog/menu/roving-list/live-region primitives, and composition-safe hotkey handling.

**Files:** `apps/web/src/components/input/*`, `components/a11y/*`, `components/Composer.tsx`, `drafts.ts`, `hotkeys.ts`, `uiPrefs.ts`, CSS and web tests.

**Done**

- CJK composition survives rerenders, session draft writes, autocomplete, file/dictation insertion, and focus mode.
- Enter never sends during composition; Shift+Enter newline works.
- Programmatic text changes use the handle, not controlled replay.
- Keyboard/focus tests and real-browser IME walkthrough pass.

## WP3 — Active-turn delivery, durable queue, and request arbitration

**Scope:** Add normal/steer/queue/interrupt admission, persisted FIFO queue, reorder/remove endpoints, runtime steering adapter, and atomic question/permission dismissal on send.

**Files/packages:** `packages/contracts`, `packages/session`, `packages/backend-opencode`, `packages/server/src/sessions.ts`, session routes, `apps/web/src/components/Composer.tsx`, new queue components, `reduce.ts`, `uiPrefs.ts`.

**Done**

- Unsupported/rejected steer falls back to queue.
- Restart preserves queue order; dispatch never enters an active stream.
- Reorder validates an exact permutation and supports keyboard controls.
- Resolution events precede queue/user events atomically.
- Concurrency/replay/ownership tests pass.

## WP4 — Shared rich Markdown and message actions

**Scope:** Replace Markdown-lite parsing with a safe shared renderer; add file references/ranges, Mermaid, image galleries, LaTeX, JSON tree, merged thinking, copy/export/share, and prompt navigator.

**Files:** `apps/web/src/markdown.tsx` (decompose into `markdown/*`), `Timeline.tsx`, `components/message/*`, `EditorView.tsx`, file stat/raw routes, CSS.

**Done**

- Chat and Markdown preview share one sanitized renderer.
- Remote/local image and file URL policies reject traversal/unsafe schemes.
- Mermaid is lazy, strict, zoomable, and fullscreen; math/JSON degrade to source on error.
- File references select centered ranges.
- Streaming/incomplete Markdown and security tests pass.

## WP5 — Project/session organization and attention

**Scope:** Project PATCH metadata/defaults; session rename; folders/grouping; labels; attention badges; archive full surface/bulk operations; atomic project switch and search.

**Files/packages:** project/session contracts/services/routes, `packages/server/src/projects.ts`, `sessions.ts`, `apps/web/src/components/Sidebar.tsx` (decompose), `SessionSearch.tsx`, new Archive/folder/label components, `store.ts`.

**Done**

- Folder cycles/cross-project moves/stale revisions fail safely.
- Question/permission counts derive from events/projections.
- Archive/restore remains idempotent and bulk results report partial failures.
- Project switching never reroutes sends or loses drafts.
- Search covers metadata/branch/labels with bounded snippets.

## WP6 — Workspace pane host and revision-safe file editor

**Scope:** Shared main/right tab host, resource routing, keep-alive activation, file action service, revision-aware autosave/conflicts, go-to-line, Markdown/HTML/JSON previews, search, optional Vim.

**Files/packages:** `@polyth/contracts` UI descriptors, `apps/web/src/components/Main.tsx`, `ContextRail.tsx`, new `workspace/*`, `EditorView.tsx`, `FilesPanel.tsx`, `packages/files`, file routes/API, `uiPrefs.ts`.

**Done**

- Dirty tabs survive hide/move and block accidental close.
- Autosave cannot overwrite a changed revision or write binary/load-lag content.
- HTML preview CSP/sandbox blocks scripts/network by default.
- Unknown/disposed plugin tabs restore to an honest unavailable state.
- Pane keyboard/splitter/responsive tests pass.

## WP7 — Changes-first Git, graph, and local review

**Scope:** Folder stage/unstage/discard, changes-first surface, commit graph/history pagination/actions, main-pane diffs, stable hunk identity, inline local review drafts.

**Files/packages:** `packages/git`, Git routes, `apps/web/src/components/GitView.tsx`, `ChangesPanel.tsx`, new `git/*` and `review/*`, pane registry.

**Done**

- Partially staged/conflicted/renamed files remain distinct and correct.
- Folder actions expand from current Git status.
- Graph renders merges/refs and destructive actions require typed confirmation.
- Review comments anchor by digest and become Outdated on source change.
- Fixed-argv/path safety and real-repo tests pass.

## WP8 — Task/subagent projection, work status, and agent profiles

**Scope:** Normalize task/delegated-agent snapshots in the adapter; work-status sections and floating pills; server-owned profiles, validation/repair, picker, model-row pin flow, favorite migration.

**Files/packages:** `packages/contracts`, `packages/backend-opencode`, `packages/models`, profile store/routes, `apps/web/src/reduce.ts`, `Composer.tsx`, `Timeline.tsx`, `ContextRail.tsx`, settings/model/profile components.

**Done**

- Replay reconstructs task/subagent state from revisioned snapshots.
- Hidden-all work status has a restore affordance.
- Applying a profile is atomic and records resolved turn configuration.
- Invalid provider settings repair visibly; migration is idempotent.

## WP9 — Settings registry, behavior, MCP, and managed plugins

**Scope:** Item-level settings registry; editor font tokens; global behavior revisioning; system info; MCP CRUD/test/auth; plugin install/enable/disable/reload/remove/logs/trust; integrations dashboard.

**Files/packages:** `SettingsView.tsx`, `components/settings/*`, `uiPrefs.ts`, server settings/system routes, `packages/backend-opencode` config implementation, kernel loader, new plugin registry service.

**Done**

- Search focuses exact settings rows, including contributions.
- Behavior writes are atomic/revisioned and applied only through the adapter.
- MCP secrets are never returned/logged and failed apply rolls back.
- Plugin disposal removes all capabilities/routes/jobs/slots; activation is atomic.
- Manifest/path/integrity/trust/redaction tests pass.

## WP10 — Cron schedules, visible runs, Markdown loops, and knowledge

**Scope:** Cron/IANA cadence/migration/preview; run targets/history/overlap; `.agents/loops` reconciliation; project knowledge CRUD/search/revision/attach; memory remains disabled by default.

**Files/packages:** `packages/schedule`, schedule routes/UI/API, new `packages/knowledge`, contracts/routes, `ContextRail` slot contribution, server composition.

**Done**

- Preview and executor agree across DST folds/gaps.
- Loop duplicate IDs/errors are surfaced without deleting healthy tasks.
- Every run links a visible session/workspace and honors overlap policy.
- Attached knowledge logs exact revision before model/UI use and survives source deletion.
- Revision, traversal, restart, and retention tests pass.

## WP11 — PR surface, checks, generated walkthrough, and review flow

**Scope:** GitHub PR detail/files/checks/comments; grouped check summary; explicit walkthrough generation/cache; structured review/risk; guarded remote submit/labels; bounded auto-review.

**Files/packages:** `packages/github`, `packages/walkthrough`, GitHub/walkthrough/review routes, `packages/backend-opencode` structured generation, `GithubView.tsx`, `WalkthroughView.tsx`, pane/review components.

**Done**

- PR read surfaces fail soft for auth/non-GitHub/rate limit.
- Walkthrough source digest/hunk IDs detect staleness.
- Generated review is logged before display and validates strict schema.
- External writes are separate explicit permissioned actions and idempotent.
- Auto-review cannot merge/push/publish and stops at its iteration limit.

## WP12 — Generic quota service and usage UX

**Scope:** Provider-neutral quota adapters/snapshots, polling/backoff/last-good state, quota cards, pace/prediction; preserve cumulative session cost.

**Files/packages:** new `packages/usage`, usage routes, Settings Usage page, `ContextRail.tsx`, provider contribution contracts.

**Done**

- No credentials/raw responses reach browser/logs.
- Last-good snapshot renders stale with reason after failure.
- Pace hides until enough samples and handles reset/counter decrease.
- Existing session usage replay/cost remains unchanged.

## WP13 — Unified palette, shortcuts, and accessibility audit

**Scope:** Project/session/workspace results, enriched file search shared with mentions, sidebar Group by command, custom/searchable shortcuts, plugin contextual commands, keyboard/zoom/reduced-motion audit.

**Files/packages:** `CommandPalette.tsx`, `commands.ts`, `@polyth/hotkeys`, search/file routes, shortcut settings, all changed surface components/CSS.

**Done**

- Palette switches project/session atomically and bounds metadata results.
- Command hints reflect custom bindings; conflicts and composition are safe.
- Every pointer-only action has a keyboard path.
- Dialog/menu/tree/tab semantics, focus return, live regions, 200% zoom, and reduced motion pass.

## WP14 — Real browser service and surface

**Scope:** Browser capability/fake driver/Chromium driver, URL/origin policy, shared sessions, frame/input WS protocol, observation redaction, pane UI, adapter tool bridge.

**Files/packages:** new `packages/browser`, existing `packages/preview`, browser routes/WS, `packages/backend-opencode`, `PreviewView.tsx` replacement/browser components, permission guards.

**Done**

- User and agent operate the same isolated browser context.
- Stale coordinate actions, SSRF/DNS rebinding, unsafe schemes, secrets, and downloads are blocked.
- Frames apply backpressure; reconnect resumes at revision.
- Actions/observations append before model use.
- Missing Chromium falls back honestly to existing preview.

## WP15 — Notifications, question UX, and resilient streaming voice

**Scope:** Typed question stepper/serializers, permission previews/scopes, notification templates/routing/subagent attribution, dictation REST/WS/audio ack/replay/STT, final transcript ordering.

**Files/packages:** contracts/session/permissions, question/permission components, `notify.ts`, settings, `packages/dictation`, dictation routes/WS, `voice.tsx`, optional adapter cleanup in `packages/backend-opencode`.

**Done**

- Multi-question answers persist across steps and submit one validated map.
- Notifications redact secrets, dedupe replay, and route to owning session.
- Dictation replays unacked PCM after reconnect and deduplicates chunks.
- Raw audio/interim transcript never enters session history.
- Final transcript is visible/persisted before normal message send.

## Cross-package quality gates for every work package

1. Relevant package tests use `node --test` + `node:assert`.
2. Each touched package passes `npx tsc --noEmit` from that package directory.
3. Grep confirms only `packages/backend-opencode` references OpenCode process/SDK.
4. Event-order tests prove model-visible data is appended before UI/model consumption.
5. New routes remain under `/api`; live updates remain under `/ws`.
6. Slot registration/disposal tests prove no leaked UI contribution.
7. Existing M1–M3 tests stay green.

## Global implementation contract

- Node 22 erasable TypeScript only; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Cross-package imports use workspace names.
- Only `packages/backend-opencode` communicates with OpenCode.
- The append-only session log remains conversation truth.
- UI extension uses typed slots/capabilities, not mega-component imports.
