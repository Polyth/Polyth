# Personal Coach — product and implementation plan

Status: implementation plan for `feat/personal-coach`

## Product thesis

Personal Coach is a long-lived execution layer, not a chat persona and not another task manager. Its job is to reduce planning overhead and keep durable context across disposable Polyth sessions.

Core loop:

`understand -> plan -> commit -> act -> observe -> review -> adapt`

Chat is only the ambiguity/reasoning surface. The package must remain useful when no model is available and must consume zero model tokens while idle.

## Target audience

Primary release audience:

- developers, designers, founders, freelancers, managers, consultants, researchers, creators;
- already comfortable with AI assistants;
- juggling work, learning, side projects and personal commitments;
- dissatisfied with maintaining complex todo/Notion/habit systems;
- needs prioritization, accountability and continuity more than raw task capture.

Secondary audience after the core loop is proven:

- self-directed learners;
- independent creators;
- people working through a defined multi-week or multi-month transition.

Explicit non-goals for MVP:

- therapy or medical coaching;
- nutrition/clinical tracking;
- employee monitoring/team performance management;
- social accountability, leaderboards or heavy gamification;
- general GTD/task-manager replacement.

## Jobs to be done

1. Decide: identify what matters now from many possible actions.
2. Commit: turn intent into a concrete promise/action.
3. Remember: preserve durable decisions without replaying old chats.
4. Notice: identify patterns from evidence, not intuition alone.
5. Adapt: adjust a failed plan without shame or streak punishment.

## UX principles

1. `Today` is the primary product surface. The dashboard is not the product.
2. Default to one main focus and at most three primary commitments.
3. Every common mutation must be deterministic and instant: done, skip, reschedule, reorder, pause, resume, check-in.
4. LLMs reason and propose. They do not sit in the path of trivial UI actions.
5. AI-originated strategic changes are proposals until explicitly accepted.
6. Sessions are disposable; Coach state is durable.
7. Empty states should collapse away rather than create dead cards.
8. Avoid synthetic productivity scores, streak pressure and decorative analytics.
9. A model outage must not break goals, commitments, check-ins or Today.
10. Personal data stays Space-scoped by default.

## Domain model

### Area

Long-lived domain such as Career, Learning or Personal. Areas are organizational context, not progress metrics.

### Goal

Desired outcome. Progress may be metric-based, milestone-based or qualitative. Never manufacture a percentage when there is no meaningful metric.

### Milestone

Intermediate measurable or observable outcome within a goal.

### Commitment

The central execution primitive: a concrete promise to perform an action. It has an explicit lifecycle (`open`, `done`, `skipped`, `cancelled`) and retains reschedule/miss reasons as event history.

### Routine

Recurring behavior definition. Future occurrences are computed for the requested range rather than materialized indefinitely.

### Check-in

Tiny point-in-time signal: energy 1-5, focus 1-5 and optional short note. It is not health telemetry.

### Reflection

A conclusion or observation explicitly supplied by the user.

### Insight

A Coach-generated hypothesis tied to evidence. Insights must be correctable/rejectable and never silently promoted to personal fact.

### Review

Periodic aggregation of events and outcomes, optionally synthesized by a model.

### Proposal

Pending model-originated mutation. Applying a proposal performs a normal deterministic mutation and emits audit events.

## Default interaction model

### First open / morning

Show:

- one main focus;
- up to three primary commitments;
- next relevant routine occurrence;
- at most one attention item.

### During the day

Primary actions are `Done`, `Later`, `Talk`.

If an item does not happen, ask for one low-friction reason only when useful: no time, too large, blocked, not important, other.

### Evening

If unresolved commitments remain, offer finish/move/drop. Do not force a daily ritual.

### Weekly

Build deterministic statistics first, then optionally synthesize a short review. Proposed plan changes remain pending until accepted.

## Widgets

Phase 1 widgets:

1. **Today** — signature medium/large surface with main focus and commitments.
2. **Next Action** — tiny widget showing one useful next action.
3. **Commitments** — small/medium list, capped visually.
4. **Goal** — one configured goal with next milestone/action and meaningful progress only.
5. **Check-in** — tiny energy/focus input without model traffic.

Later widgets:

- Insight;
- Weekly Review;
- Routines;
- Upcoming;
- Momentum.

All use the existing web-sdk widget registry and Polyth workspace/pinning/fullscreen behavior. No parallel widget framework.

## Persistence and tenancy

All tenant-owned Coach data must be stored under:

`host.spaceStorage(space).packageDir("personal-coach")`

Initial persistent store:

`coach.db`

Use built-in `node:sqlite`, WAL, foreign keys, prepared statements, explicit transactions and `PRAGMA user_version`. No ORM, Redis, vector database or background indexing service.

Tables planned for the first implementation:

- `coach_meta`
- `coach_profile`
- `coach_areas`
- `coach_goals`
- `coach_milestones`
- `coach_commitments`
- `coach_routines`
- `coach_checkins`
- `coach_reflections`
- `coach_insights`
- `coach_proposals`
- `coach_events`

Current-state mutation and corresponding append-only audit event must be in the same transaction.

Initial indexes should stay minimal and query-driven:

- commitments by status/planned time;
- goals by status/priority;
- events by time;
- events by entity;
- routines by status.

## Knowledge integration

Do not block the package on refactoring `@polyth/knowledge`. Its current contract is project-scoped. Structured Coach state belongs in `coach.db`.

A later adapter may expose selected reflections/accepted insights through generalized Space-scoped knowledge once that abstraction has another real consumer.

## Sessions and runtime

Polyth sessions currently require a project. Personal Coach must not appear to the user as a fake coding project.

Preferred platform abstraction: a package-owned workspace/runtime anchor that is:

- Space-scoped;
- stable for `(space, package)`;
- hidden from ordinary Projects UI;
- not Git/worktree semantic;
- usable by existing SessionService, runtime pool, model picker, streaming, compaction and usage accounting.

The first implementation may be backed internally by a reserved system project/runtime ID, but the Coach package must depend on the package-workspace abstraction rather than constructing hidden projects itself. This keeps future project-less session work replaceable behind one seam.

## Agent capabilities

Coach should register through the existing harness capability registry.

Instruction capability:

- `personal-coach.behavior`

Read tools:

- read context;
- list/get goals;
- list commitments;
- list recent activity.

Deterministic mutation tools:

- complete explicit commitment;
- reschedule explicit commitment;
- cancel explicit commitment;
- record check-in;
- record user reflection.

Proposal tools:

- propose goal;
- propose commitment when intent is ambiguous;
- propose routine/plan change.

The model never receives direct SQL access.

## Context builder

Each Coach session gets a bounded snapshot rather than full history.

Always include:

- Coach preferences;
- current date/timezone;
- active goals.

Current:

- today commitments;
- due routine occurrences;
- unresolved attention items.

Recent/relevant:

- latest review;
- a bounded recent event window;
- accepted insights/reflections relevant to the current goal/topic.

Target normal snapshot: roughly 2-4k model tokens. Old history remains queryable through tools rather than preloaded.

Do not perform a separate LLM extraction pass after every conversation turn.

## Structured chat proposals

The model should emit typed proposal data, never React/HTML.

A generic package-owned message part/renderer seam should eventually render proposal cards inline in conversation:

- package owner;
- renderer/resource type;
- resource ID;
- presentation hint.

Personal Coach is the first consumer, but the contract must remain generic enough for future Calendar, GitHub, Home Assistant, Tasks and similar packages.

## Proactivity

Levels:

- Reactive — no unsolicited work;
- Balanced (default) — unresolved commitments, due review, important deadline;
- Proactive — additionally stalled goals/repeated rescheduling/overload.

Rules determine whether attention is needed. They must not require continuous model inference.

Reuse `@polyth/schedule` later rather than adding a Coach scheduler. The current schedule package is project-scoped, so integration follows package-workspace availability.

## Frontend data flow

One package-owned Coach store feeds all Coach widgets. Widgets must not independently poll/fetch the same state.

Primary endpoint:

`GET /api/personal-coach/home`

Returns a bounded projection containing:

- revision;
- onboarding/profile state;
- today/main focus;
- commitments;
- due routines;
- active goals;
- attention item;
- current insight/review-due state.

Revalidate on:

- surface open;
- app focus;
- successful mutation;
- notification/deep-link activation.

No 15-second Coach polling loop.

## API shape

MVP routes:

- `GET /api/personal-coach/home`
- `GET|PUT /api/personal-coach/settings`
- `GET|POST|PATCH /api/personal-coach/goals`
- `GET|POST /api/personal-coach/commitments`
- `POST /api/personal-coach/commitments/:id/complete`
- `POST /api/personal-coach/commitments/:id/reschedule`
- `POST /api/personal-coach/commitments/:id/skip`
- `POST /api/personal-coach/checkins`
- `GET /api/personal-coach/activity`
- `POST /api/personal-coach/proposals/:id/accept`
- `POST /api/personal-coach/proposals/:id/reject`
- later: `POST /api/personal-coach/session`

Prefer explicit routes over a generic RPC endpoint.

## Performance budget

Idle Coach:

- 0 LLM requests;
- 0 Coach polling;
- no embeddings/indexing worker;
- no package-owned periodic timer in MVP.

Targets:

- cached widget paint immediately;
- local deterministic mutation should feel sub-100ms;
- local API p95 goal <150ms for ordinary mutations;
- Home payload target <25 KiB;
- Home projection uses bounded indexed queries, not full event history.

React widgets should select narrow Coach-store slices so unrelated changes do not repaint the whole package surface.

## Shared UI boundary

New Coach UI must not deepen existing imports from `apps/web/src/components/...`.

If current `host.ui` is sufficient, use it. Otherwise extract/re-export only the minimum stable primitives required by the package. Do not build a second design system or migrate every existing package in the Coach branch.

The host remains responsible for global geometry, density, glass/transparency, motion and tokens. Coach owns semantic layout only.

## Safety and permissions

Default Coach sessions should not require shell, Git, SSH or filesystem mutation.

The package may plan and reflect, but specialized medical/mental-health/financial decisions are not promoted into authoritative Coach actions. External mutations must go through the owning package/service and its permission boundary.

## Delivery plan

### Wave 0 — source-of-truth and boundaries

- commit this plan;
- follow repository package/security/UI guidance;
- keep changes additive and isolated.

Exit: implementation scope is reviewable before behavior changes.

### Wave 1 — Coach core/store

Add discovered `@polyth/personal-coach` server package with:

- Space-scoped SQLite store;
- profile/area/goal/milestone/commitment/routine/check-in/reflection/proposal/event domain;
- deterministic validation;
- atomic current-state + event mutations;
- restart persistence;
- isolation tests.

Do not add LLM/runtime/UI dependencies in this wave.

Exit: domain is useful and testable without a model.

### Wave 2 — routes and Home projection

Add explicit package routes and a bounded server-side Home projection.

Required fixtures/tests:

- fresh/empty Space;
- normal day;
- overdue commitment;
- too many commitments;
- paused goal;
- timezone day boundary;
- foreign-Space ID isolation.

Exit: one request contains everything required by initial widgets.

### Wave 3 — package workspace/runtime seam

Add the smallest general package-workspace abstraction needed to create normal Polyth sessions without exposing a fake coding project.

Enumerate every consumer touched by any public session/project contract change before modifying it. Prefer an additive adapter over changing `CreateSessionInput` broadly.

Exit: a feature package can obtain a normal session/runtime anchor that has no user-facing Git/project semantics.

### Wave 4 — Coach capabilities/context

Register Coach instruction and typed tools. Add bounded context builder and Coach-session creation through package workspace.

Exit: conversational planning can read durable Coach state and create deterministic mutations/proposals through tools.

### Wave 5 — Home + initial widgets

Add package web entry, one shared Coach store and only the five MVP widgets. Use existing web-sdk surfaces and host layout behavior.

Exit: Coach is useful without opening chat on desktop and mobile widths.

### Wave 6 — generic inline proposal rendering

Add the minimum generic structured package-message seam, with Coach proposal card as first consumer.

Exit: AI-originated strategic changes are visible and can be accepted/rejected without embedding package HTML in model output.

### Wave 7 — onboarding

One free-text question, bounded interpretation, confirmation, Coach tone/initiative, first plan. No long questionnaire/tutorial carousel.

Exit: a fresh Space reaches first accepted goal/commitment with minimal setup.

### Wave 8 — reviews/insights

Deterministic review aggregation first; small-model synthesis only on demand/due review. Insights require evidence and remain rejectable.

Exit: accumulated history improves planning without continuous inference.

### Wave 9 — schedule/proactivity/integrations

Reuse schedule and external package capabilities. Add anti-spam/quiet-hour policy only when notifications are introduced.

Exit: Coach can close important loops without owning duplicate schedulers/task/calendar systems.

## First production milestone

Stop the first major milestone after Waves 1-7. Reviews, proactive scheduling and broad integrations are explicitly second-wave scope.

Definition of done for that milestone:

1. enable package in a Space;
2. start from one natural-language objective;
3. accept an initial goal/commitment plan;
4. restart Polyth and retain state;
5. render correct Today instantly from stored state;
6. complete/reschedule without a model call;
7. open a normal Coach session;
8. give the model only bounded relevant Coach context;
9. render AI plan changes as pending proposals;
10. never apply strategic AI changes without consent;
11. keep all Coach state isolated from another Space;
12. keep Today/goals/commitments usable if the model/provider is unavailable;
13. produce no idle model traffic or Coach polling.

## Verification discipline

For each wave:

- inspect current defining contract and at least one consumer/test before modifying it;
- add focused tests next to the owner;
- test package disable/re-enable where lifecycle resources exist;
- preserve package containment and browser-safe imports;
- run only repository-supported relevant checks, then broader checks when a shared public contract moves;
- record source-inspected/tested/live/device evidence separately.

The guiding implementation rule is: reuse existing Polyth seams, delete unnecessary complexity, and choose the smallest correct diff that preserves security, tenancy and user-visible behavior.
