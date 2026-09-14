# Personal Coach: first-run and workspace repair

Extends `personal-coach.md`; does not replace Coach storage, runtime ownership,
proposals, chat rendering, or Schedule.

## User flow

- New Space: describe a direction, or choose manual setup. The submitted text
  is a real first user turn, not a fabricated assistant greeting.
- Started setup: continue the canonical Coach conversation or review saved
  goals and pending proposals. Choosing a different direction explicitly
  opens a new conversation. Goals entered manually survive reloads too.
- Preferences: explicit confirmation; reminders off by default, unavailable
  Schedule does not block manual setup. Scheduled conversations may use tokens.
- Complete: Overview / Today / Goals / Review. An empty day never restarts
  onboarding. Review stays quiet when there is nothing to act on.
- Goals: add/edit/pause/resume/complete, add next steps, discuss in chat.
- Review: pending Apply/Discuss/Not now proposals, weekly review and
  evidence-backed insights when they actually need attention.
- Today: one main focus without duplicating its row, Done/Move/More, optional
  check-in update and due routines. Future work remains under Next up rather
  than masquerading as today's focus.

## Boundaries

`POST /api/personal-coach/session` additionally accepts `resume`, `text` and
`timeZone`. Inputs validate before effects. Interactive creation prepares
capabilities, persists setup/context and calls scoped canonical `sessions.send`.
Resume selects only the owning Space/package workspace's non-archived sessions,
refreshes bounded context, and never replays a supplied objective. A profile
reset (`new`) prevents old transcripts from being selected as current setup.
Per-Space serialization and a client busy guard cover concurrent starts.

An uncertain first-send result returns the real session ID plus a safe error.
The UI keeps that error visible; continuing the conversation is explicit, with
no automatic replay. Late launch results cannot steal a newer navigation or
navigate after package disposal. Title-only legacy callers keep their previous
create-only behavior.

`POST /api/personal-coach/setup` is a deterministic, explicitly confirmed user
operation. It validates preferences and reminder consent before mutations,
reuses `configureCoachReminders` and `updateProfile`, and cannot accept model
proposals. Existing settings PUT remains unable to forge onboarding state.
The existing local-only remote policy and Space boundary are unchanged.

The existing package-workspace anchor stays hidden. Source inspection found
that the shared workspace gate uses the active project ID, not membership in
its visible project list; no speculative shared-shell rewrite was introduced.
Web navigation now uses `host.conversation.openSession`. New components receive
host UI primitives; package UI should stay behind the stable web-sdk boundary.
Existing widgets and settings/insight/proposal registrations remain available.
One shared Coach client remains the data authority. No polling, extra chat
engine, model extraction pass, or new dependency is required by this flow.

## Verification evidence

Executed in an isolated Node 22.16.0 environment:

```sh
node --experimental-strip-types --test \
  packages/personal-coach/test/sessionFlow.test.ts \
  packages/personal-coach/test/setupFlow.test.ts \
  packages/personal-coach/test/journeyClient.test.ts
```

21 tests passed, zero failures/skips. These are tests of the actual extracted
flow/client modules with explicit mocked service boundaries, not a live
provider or whole-repository integration test. TypeScript syntax transpilation
of all 17 changed/new TS/TSX files and PostCSS parsing of the new stylesheet
also passed. Syntax transpilation is **not** a full TypeScript typecheck.

Not executed: full repository tests, web build, live SQLite/HTTP/provider
journey, browser visual/accessibility checks, native iOS/Android checks.
The isolated environment did not contain the repository dependency graph.

Before merge, run the repository-supported Coach/package-containment checks
and web build, then verify at narrow and wide panel widths:

1. Fresh Space -> exact first objective -> working canonical conversation.
2. Double click, failed provider, reload, Continue: no duplicate first turn.
3. Manual goal + next step -> explicit no-reminders confirmation -> Today.
4. Proposal Apply/Discuss/Not now -> updated durable state; reopen and refresh remain correct.
5. Last step completed -> quiet Today, not first-run; paused goals remain reachable.
6. Reset, package disable/re-enable, navigation away during a slow launch.
7. Keyboard-only setup/tabs, long labels, narrow panels and light/dark themes.
