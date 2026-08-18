# Polyth — Merged Build Plan (polyth × DeepSeek-Harness synthesis)

**Status:** active build contract · **Date:** 2026-08-17 · supersedes the two source specs (EN spec + UA spec, which are one document in two languages).

## 1. Decision

New repository. Tiny composition kernel + everything product-specific as plugins. OpenCode is the first backend, accessed **only** through `packages/backend-opencode` — no other package may import `@opencode-ai/sdk` or talk to the opencode process.

## 2. Invariants (non-negotiable, from both specs)

1. Kernel loads/scopes/orders/disposes plugins; implements **no** product feature.
2. Every capability = explicit contract key (`ctx.*`); consumers never import concrete providers.
3. Plugin registration is reversible — dispose removes services, events, UI slots, routes, jobs.
4. **Model-visible means logged**: append-only `SessionEvent` log is conversation truth; replay reconstructs identical model history after restart.
5. Permissions fail closed, monotonic (later guards only restrict).
6. UI extends via typed slots, not imports into a mega-component.
7. Profiles/bundles define product shape.
8. Parity is testable (`docs/parity/polyth-parity.yaml`).

## 3. Layered architecture

```
L0 kernel        plugin loader, scoped ctx, effects/disposal, typed events, profile resolver
L1 contracts     type-only: service keys, SessionEvent, DTOs, UI slot contracts
L2 infra         session log (node:sqlite), permissions, settings
L3 capabilities  backend-opencode, projects, git, terminal, mcp, skills ... (plugins)
L4 workflows     goals, multirun, fusion, walkthrough, review, scheduler    (plugins)
L5 surfaces      web, (later: desktop/vscode/mobile/cli)
```

## 4. What is built NOW (milestone 1 — "working web product")

| Package | Owner | Contents |
|---|---|---|
| `packages/contracts` | core | all normative types (done, do not fork semantics) |
| `packages/kernel` | subagent A | Context, provide/inject w/ priority, effect disposal, typed emit/waterfall, child scopes, plugin loader, profile→bundles→patch resolver |
| `packages/session` | subagent A | append-only event store on `node:sqlite` (WAL), transactional seq, `events(afterSeq)`, fork, `deriveMessages`, sessions projection, JSONL export |
| `packages/backend-opencode` | subagent B | spawns `opencode serve`, REST+SSE client, `AgentRuntime` contract impl, translate OpenCode events → canonical `SessionEvent`s, permission/question bridge, models/agents discovery |
| `packages/permissions` | core-lite | monotonic guard chain, session/project rules, approve once/always |
| `packages/server` | core | HTTP API + WS gateway, serves web bundle, boots profile, wires plugins |
| `apps/web` | subagent C | React 19 UI: sidebar (projects/sessions/status), chat timeline (streaming, tool cards, reasoning), composer (model/agent pickers), permission prompts, context gauge, fork/export. Slot registry client-side |
| `packages/goals` | stretch | goal attach, small-model auditor loop, `goal/*` events — only if slice is green |

Deferred (documented, plugin-shaped, not built in M1): multirun, fusion, walkthrough, review, github, worktrees UI, terminal PTY, browser/preview, scheduler, voice, relay/pairing/tunnels, themes/i18n, usage, MCP, skills, desktop/vscode/mobile shells. Each already has a designated plugin name + contracts seam (§7 of EN spec) so M2+ adds them without touching kernel.

## 5. Wire protocol (FIXED — server and web build against this)

REST (JSON, prefix `/api`):
- `GET  /api/health` → `{ok, version, capabilities:[...]}`
- `GET  /api/projects` / `POST /api/projects {path, name?}` / `DELETE /api/projects/:id`
- `GET  /api/sessions?projectId=` / `POST /api/sessions {projectId, title?, model?, agent?}`
- `GET  /api/sessions/:id` → projection `{id,title,status,model,agent,projectId,createdAt,updatedAt}`
- `GET  /api/sessions/:id/events?afterSeq=0` → `SessionEvent[]`
- `POST /api/sessions/:id/message {text, model?, agent?}` → `{turnId}`
- `POST /api/sessions/:id/abort`
- `POST /api/sessions/:id/fork {atSeq?}` → `{sessionId}`
- `POST /api/sessions/:id/archive` · `POST /api/sessions/:id/restore`
- `POST /api/sessions/:id/permission/:requestId {reply:"once"|"always"|"reject"}`
- `POST /api/sessions/:id/question/:requestId {answers}` / `.../reject`
- `GET  /api/models` → `[{providerID, modelID, name, context?, cost?}]`
- `GET  /api/agents` → `[{name, description?, mode}]`

WS `/ws`: client → `{type:"subscribe", sessionId?, afterSeq?}` (sessionId omitted = all sessions of active project). Server → `{type:"event", event:SessionEvent}` (gap-fill from DB first, then live, no race), `{type:"projection", session: {...}}` on status changes, `{type:"error", code, message}`.

## 6. Canonical SessionEvent vocabulary (M1 subset, extensible)

`session/created metadata-changed archived restored forked` · `turn/started stopped failed` · `step/started completed` · `user/message` · `assistant/chunk reasoning-chunk message` · `tool/call result error` · `question/asked answered` · `permission/requested resolved` · `attachment/added` · `context/pinned unpinned` · `compaction/started completed` · `goal/attached audit completed stuck` · `usage/recorded`.

Envelope: `{id, sessionId, seq, time, type, data, ignorable?, surfaceOp?, sourceEventSeqs?, producerPlugin?, v:1}` — see `packages/contracts`.

## 7. Tech constraints (ponytail)

- Node 22 runs TS directly (type stripping). **Erasable TS only** — no enums/namespaces/parameter properties. Imports of local files use explicit `.ts` extension.
- `node:sqlite` (stdlib) for persistence. No ORM.
- `ws` for websocket. `esbuild` for the single web bundle. React 19.
- No build step for server packages; `npm start` must work after `npm install && npm run build:web`.
- Tests: `node --test`, assert-based, one contract suite per capability.

## 8. Parity tracking

`docs/parity/polyth-parity.yaml` carries all 209 OC-* rows with `status: planned|implementing|implemented|platform-na`. M1 turns the session/chat/projects/permissions rows green. CI gate: no orphan rows.

## 9. M2+ roadmap (per source specs, unchanged)

session spine hardening → coding workspace plugins (files, terminal, git, worktrees, commands/snippets/skills, mcp) → workflows (goals full, multirun, fusion, walkthrough, review) → browser/preview + github → cross-device (pairing, relay E2EE, ssh, tunnels) → voice/themes/i18n/marketplace. Trust classes + plugin manager UI arrive with the first third-party plugin milestone.

## 10. Definition of done for M1

- `npm install && npm run build && npm start` → web UI on :4400, add project, chat with streaming via spawned `opencode serve`, tool cards, permission prompt (once/always/reject), abort, fork, archive, reconnect with zero duplicate/lost events after server restart (replay from SQLite).
- Kernel hot-dispose test: mount plugin → exercise → dispose → baseline state.
- No package except `backend-opencode` references opencode anything (grep gate).

---

## 11. Milestone 1 — RESULT (verified 2026-08-17)

Green. `npm install && npm run build:web && npm start` → UI on :4400. Verified end-to-end against a real spawned `opencode serve`: project add, session create/fork/archive/restore, streaming assistant + reasoning chunks, tool call/result cards, turn lifecycle, `usage/recorded` with real tokens/cost, WS gap-fill + live, **server restart replay from SQLite with zero duplicate/lost events**, message sent from the real browser UI. 30 tests pass, `tsc` clean, opencode-SDK grep gate clean.

## 12. Milestone 2 — scope (FIXED protocol; server + web build against this)

New plugins: `packages/git` (git + worktrees), `packages/files`, `packages/commands` (slash commands + snippets), `packages/goals` (auditor loop).

REST additions (all project-scoped; `projectId` required unless noted):

```
GET  /api/git/status?projectId=            → {branch, ahead, behind, staged[], unstaged[], untracked[], conflicted[]}
                                              entry = {path, status, staged}
GET  /api/git/diff?projectId=&path=&staged= → {path, diff}            (unified text, "" if none)
POST /api/git/stage    {projectId, paths[]}      → {ok:true}
POST /api/git/unstage  {projectId, paths[]}      → {ok:true}
POST /api/git/discard  {projectId, paths[]}      → {ok:true}
POST /api/git/commit   {projectId, message}      → {sha}
POST /api/git/commit-message {projectId}         → {message}   (small-model, server-side)
GET  /api/git/branches?projectId=                → {current, branches:[{name, current, remote?}]}
POST /api/git/branch   {projectId, name, from?}  → {ok:true}
POST /api/git/checkout {projectId, name}         → {ok:true}
GET  /api/git/log?projectId=&limit=20            → [{sha, shortSha, subject, author, date}]

GET  /api/worktrees?projectId=                       → [{path, branch, head, isMain}]
POST /api/worktrees   {projectId, branch, path?, base?} → {path, branch}
POST /api/worktrees/remove {projectId, path, deleteBranch?} → {ok:true}

GET  /api/files/tree?projectId=&path=&hidden=false → [{name, path, dir, size?}]   (one level, path relative)
GET  /api/files/read?projectId=&path=              → {path, content, truncated, tooLarge?}
POST /api/files/write {projectId, path, content}   → {ok:true}
GET  /api/files/search?projectId=&q=&limit=50      → [path]                        (name match)

GET  /api/commands?projectId=  → [{name, description, prompt, agent?, model?, scope:"user"|"project"|"builtin"}]
GET  /api/snippets?projectId=  → [{alias, text, scope}]

POST /api/sessions/:id/goal {objective, budgetTokens?, maxContinuations?} → GoalState
GET  /api/sessions/:id/goal            → GoalState | null
POST /api/sessions/:id/goal/pause      → GoalState
POST /api/sessions/:id/goal/resume     → GoalState
POST /api/sessions/:id/goal/stop       → {ok:true}
```

`GoalState = {objective, status:"active"|"paused"|"completed"|"stuck"|"stopped", continuations, maxContinuations, tokensUsed, budgetTokens, lastVerdict?, updatedAt}`.

Session creation accepts optional `worktreePath` (absolute); the runtime for that session uses it as cwd. `POST /api/sessions/:id/message` expands `/command args` and `#snippet` server-side before the model sees it (`user/message` event stores the **expanded** text plus `raw` field).

New canonical events: `goal/attached|audit|paused|resumed|completed|stuck|stopped`, `git/snapshot`.

## 13. Milestone 2 — RESULT (verified 2026-08-17)

Green. New plugins: `packages/git` (git + worktrees), `packages/files`, `packages/commands`, `packages/goals`; server route groups are plugin-contributed (`RouteHandler`), not hardcoded in the gateway.

Verified live against real repos and real models:
- **Goals**: attach → auditor (Small Model, `POLYTH_SMALL_MODEL`) → `goal/audit` → auto-continuation → `goal/completed`; continuation/token limits produce `goal/stuck`; auditor failure counts as stuck (never a silent loop); state rebuilds from the durable log after restart.
- **Git**: status/diff/stage/unstage/discard/commit/log/branches over HTTP; AI commit message generated from the staged diff ("Add multiply function").
- **Worktrees**: create/list/remove (+branch cleanup); a session created with `worktreePath` runs its agent inside the worktree (`pwd` proved it).
- **Files**: tree/read/write/search with path-escape rejection; Files rail tab browses and views.
- **Commands/snippets**: `/summary #terse @math.js` expands server-side before logging; the log stores expanded `text` plus `raw`; composer autocomplete lists commands/snippets.
- **Multi-project**: each project/worktree gets its own `opencode serve` on an OS-assigned free port (fixed-port bug found and fixed).

80 tests pass, `tsc` clean, opencode-SDK boundary gate clean. Parity: 29 implemented / 25 implementing / 156 planned.

### M3 next (unchanged plugin seams)
multirun + fusion → walkthrough/review → terminal PTY + preview/browser → github → usage/notifications → remote (pairing/relay/ssh/tunnels) → voice/themes/i18n → plugin manager UI + trust classes.
