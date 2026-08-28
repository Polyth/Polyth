# Phase 2 — Wave 2 handoff: chat, thinking, tools, tasks, permissions

Wave 2 owned the conversation surfaces: message presentation, thinking
disclosure, tool/MCP rows, the task list, and permission approvals. Wave 1
navigation and all Phase 1 primitives/tokens were treated as fixed. Composer
chrome was not touched (Wave 3).

## UX decisions

### Message taxonomy (kept, polished)

The existing taxonomy already matched the target narrative and was kept:
user bubbles (compact, end-aligned, attachment pills), unboxed assistant
prose in the reading measure, flat execution rows for tool work, one bordered
card each for the task list and approvals, and `role="alert"` errors. No new
cards were introduced; the wave's work was making each register truthful and
quiet rather than re-framing everything.

### Thinking: real reasoning behind progressive disclosure

The previous expanded state showed derived "milestones" (canned category
labels), not what the model thought. That failed the "readable when expanded"
requirement, so it was replaced:

- Collapsed (settled): one quiet line — `Thinking · 18s`. The duration comes
  from new `reasoningStartedAt`/`reasoningEndedAt` bounds captured per
  reasoning chunk in the reducer and preserved across `mergeThinking` merges.
  Replayed logs that only carry a final pre-merged `assistant/message` have no
  bounds and degrade to plain `Thinking` — never a fabricated duration.
- Collapsed (streaming): spinner + live tail (`reasoningTail`, the last
  non-empty line stripped of markdown markers, bounded to 110 chars). The
  block does NOT auto-expand while running; expansion is purely user-driven.
- Expanded: the actual reasoning rendered as markdown, styled secondary
  (muted, smaller, flattened headings, left hairline), inside a
  `max-height: min(42vh, 380px)` scroll well so long thinking never breaks the
  page. While streaming and open, the well self-follows its own newest line.
  A quiet `Copy reasoning` action sits below the well.
- `reasoningMilestones` was removed (`execution.ts`); nothing else consumed it.
- The `collapsibleThinkingBlocks` / `thinkingDefaultExpanded` uiPrefs contracts
  are respected (flat variant renders the same body without a disclosure).

### Tool rows

The execution-row language (icon + verb-first label + target preview +
duration + glyph state) already matched the spec and was kept. Fixes:

- States never ride on color alone: pending `…`, running spinner, done `✓`
  in a ring, failed `×`, cancelled `⊖` (derived from cancel/abort error text),
  each with a text label in the status column / SR text on mobile.
- MCP brand casing: `displayIntegration` now maps well-known integrations
  (GitHub, GitLab, PostHog, MongoDB, PostgreSQL, MySQL, GraphQL, OpenAPI, …)
  and title-cases the rest, so rows read `GitHub · Read pull request #2693`.
- The raw technical identifier (`mcp__github__get_pull_request`) now appears
  in the expanded details footer (`.execution-tool-id`, mono, faint) — primary
  presentation stays human.
- Large output was already bounded (preview cap + "Show all N lines" +
  full-screen viewer above 200k chars); verified against a ~200KB fixture log
  and left unchanged.

### Task list

- Collapsed summary: `Tasks · 3/7 complete · 1 failed · <active task>` —
  count first, failures called out, current work visible without expanding.
- Failed items get a distinct `×` mark tinted `--red` plus a visually hidden
  `(failed)` text status; done items are muted with `✓` — the legacy
  strikethrough+accent styling leaked from `.message-plan-card` and was
  removed by dropping that class from the task list markup.
- Auto-collapse when every item settles (done/failed) was kept.

### Permissions: always action-required

The banner previously collapsed each request behind a "Review" disclosure —
decisions were hidden behind a click. Rewritten (`PermissionBanner.tsx`):

- Every request is a card that shows, with no expansion step: intent (the
  server-built redacted preview title), `via <tool>`, risk badge, target
  lines (preview lines, or raw patterns for old events) in a bounded
  (132px max) scrollable block, and the decisions.
- Decisions use core `ui/Button`: `Allow once` (primary), `Always` + explicit
  scope select (session/project — never silently global), `Deny` (danger,
  end-aligned).
- Narrow containers (≤480px container width) stack decisions as full-width
  `--tap`-height rows via `@container` queries — the banner is embedded chat
  content, so it no longer uses viewport media queries (the legacy
  `700px + pointer:coarse` block was removed).
- `role="alert"` + `aria-live="assertive"` container and the visible
  `Permission requested` header remain.

### Streaming

Verified live against the fake backend (`turnBehavior: "work"`, added to
`msgActionsFakeBackend.mjs`): reasoning streams into the collapsed tail with a
spinner, a tool row appears pending → running → done mid-turn, answer text
streams, upward scroll is never fought by auto-follow (scrollTop held at 0
during an active stream), and the settled turn collapses to `Thinking · Ns`.
Composer geometry was not touched.

## Touched surfaces / files

- `apps/web/src/reduce.ts` — `AssistantMsg.reasoningStartedAt/EndedAt`,
  captured in the `assistant/reasoning-chunk` handler.
- `apps/web/src/utils.ts` — `mergeThinking` carries earliest-start/latest-end
  bounds through merges.
- `apps/web/src/execution.ts` — `reasoningTail` (replaces
  `reasoningMilestones`), `INTEGRATION_BRANDS` casing, MCP preview
  capitalization.
- `apps/web/src/components/Timeline.tsx` — `Thinking` rewrite; `TaskList`
  summary copy, failed marks, SR status text; dropped `message-plan-card`
  class from the task list.
- `apps/web/src/components/ExecutionRow.tsx` — technical tool id in the MCP
  details footer.
- `apps/web/src/styles.css` — new `.reasoning*` block (summary line, capped
  body, foot), `.task-list` failed marks + selector rename,
  `.execution-tool-id`, removal of the dead `.permission-execution-*` rules.
- `packages/permissions/widgets/PermissionBanner.tsx` — action-first rewrite
  on `ui/Button`.
- `packages/permissions/widgets/styles.css` — card layout, bounded preview,
  container-query stacking; legacy viewport MQ for the banner removed.
- `apps/web/test/executionUi.test.ts` — approval contract test rewritten for
  always-visible decisions; `reasoningTail` tests; GitHub casing fix.
- `apps/web/test/smoke.test.ts`, `apps/web/test/markdown.test.ts` — reasoning
  bound tracking/merging assertions.
- `apps/web/test/packageContainment.test.ts` — `components/ui/Button.tsx`
  added to the documented generic-shell imports (it is the Phase 1 primitive
  packages are meant to adopt).
- `packages/plugins/test/featurePanelsResponsive.test.ts` — the exact legacy
  `700px+coarse` media assertion now accepts the container-query contract.
- QA tooling (committed, manual): `apps/web/test/wave2ChatFixtureSetup.mjs`
  (disposable fixture: thinking, 20+ tools, failed/cancelled/huge output, MCP,
  task list with a failed item, markdown/KaTeX/Mermaid/tables, attachments,
  pending permissions, stream-capable session) and
  `apps/web/test/wave2ChatQa.mjs` (Playwright driver: screenshots + streaming
  pass). `msgActionsFakeBackend.mjs` gained the additive `work` turn behavior.

## What was validated

- `npm run build` — clean.
- `npm test` — 1547 pass / 0 fail (2 pre-existing skips).
- `npx tsc --noEmit` in `apps/web` and `packages/permissions` — clean.
- Browser QA via the fixture (`wave2ChatQa.mjs`, Chromium 1280/390/320 px):
  - Thinking: `Thinking · 18s` collapsed; expanded body capped at 378px and
    scrolls internally; live session shows spinner + tail preview.
  - Tools: 20+ row session groups correctly; failed build row expands to
    Command/Details/Error; cancelled watch run shows `⊖`; ~200KB output stays
    behind a bounded (220px) preview; MCP rows read `GitHub · …` collapsed
    with the raw id in details.
  - Task list: `3/7 complete · 1 failed · <active>` summary; distinct marks.
  - Permissions: both requests show decisions without any click; phone
    buttons ≥44px tall; 320px width has no horizontal overflow.
  - Markdown: tables, KaTeX (block+inline), Mermaid, wide code (internal
    scroll only), long-URL wrapping, user attachments — no page overflow.
  - Streaming (fake backend `work` turn): live thinking → tool lifecycle →
    streamed answer → settled duration label; reader-hold verified.

## Known issues / leftover for later waves

- `QuestionCards.tsx` (agent questions) still uses its own form styling; it
  is action-required UI and should get the same action-first treatment
  (Wave 4/5 candidate).
- The `.message-plan-card` legacy CSS block (~4167) is now unreferenced by the
  task list; a broader dead-CSS sweep of stacked redesign layers in
  `styles.css` is still owed (matrix row "Duplicate core selectors").
- KaTeX only renders `$…$`/`$$…$$`; models that emit `\(...\)`/`\[...\]`
  delimiters fall back to plain text. Parser-level normalization is a product
  question for Wave 5 (note for `phase-3-candidates.md`).
- The reasoning well self-follows only its own scroll; if a user scrolls the
  reasoning well upward mid-stream it will keep following on the next chunk.
  Minor; fix by tracking well-local reader intent if it ever bothers anyone.
- `webfetch`-style requests without a server preview show the raw permission
  name as the card title (see fixture `w2-permission` second card). A
  server-side preview builder for more permission kinds would improve intent
  copy — backend work, out of scope for this wave.

## Notes for Wave 3 (composer/chat interaction)

- The permission banner renders in `session.timeline.after`, directly above
  the composer, and is now taller when requests are pending (decisions always
  visible). If Wave 3 reworks composer docking/height, re-check that a
  pending-approval + open-keyboard phone layout keeps both the Deny button
  and the composer reachable (`.permission-toast` is capped at
  `min(62dvh, 520px)` and scrolls).
- Thinking/tool/task widths all key off the same reading measure as assistant
  prose; nothing in this wave depends on composer geometry.
- The `w2-stream` fixture session + `work` turn behavior is the quickest way
  to QA composer behavior during a streaming turn.
