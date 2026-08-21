# UX-TIMELINE-LAYOUT-01 — implementation contract

- Case: `UX-TIMELINE-LAYOUT-01`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-21`
- Repository root: `/workspace`
- Product source baseline: `b63b6c887726896739ead8fc021320f8db52bed8`
- Reference audit: `docs/ux-audit/cases/UX-TIMELINE-LAYOUT-01-REFERENCE-AUDIT.md`
  (`bc-ea2cb674-3a29-5b7d-8368-c95261e959e0`)
- Root-cause audit: `docs/ux-audit/cases/UX-TIMELINE-LAYOUT-01-ROOT-CAUSE.md`
  (`bc-568e4d01-19cb-55fc-b7d4-062639c7407f`)
- Authoritative predecessor:
  `docs/ux-audit/cases/UX-MSG-ACTIONS-SPEC.md`
- Scope: presentation-only timeline layout, scroll behavior, reveal controls,
  prompt navigation, and collision-free message chrome. This artifact changes
  no product code or parity-matrix status.

## 1. Decision and user outcome

The conversation becomes a calm, centered reading surface in which role,
chronology, and progress are apparent without persistent avatars, role labels,
or chrome covering content:

- user turns are right-aligned Ember-tinted bubbles;
- assistant answers are left-aligned, unboxed prose in a centered reading
  column;
- reasoning, tool, task, attachment, code, JSON, Mermaid, math, and image
  surfaces remain distinct, bounded children of that same chronological flow;
- prompt navigation and the timeline-dialog entry occupy one reserved utility
  region, never the transcript's paint area;
- completed-turn times and actions remain in a separate footer below the
  corresponding body;
- a reader at the tail follows a growing answer, while a reader who scrolls up
  keeps the chosen reading position and gets an accessible `Jump to latest`
  action; and
- the final message, action footer, error/retry row, and turn footer remain
  readable above the composer at every required width and zoom.

The visual reference is ChatGPT's layout and scroll behavior, not its DOM,
tokens, inaccessible jump control, or omission of message timing. Polyth keeps
the Ember dark identity: existing color, type, radius, border, focus, shadow,
and semantic signal tokens remain the only styling source. Do not introduce a
ChatGPT-white clone, hard-coded foreign palette, avatar column, or persistent
role heading.

## 2. Interaction and layout model

### 2.1 One timeline and one scroll root

`Timeline.tsx` continues to own exactly one chronological render and exactly
one timeline scroll root. It may wrap the existing `.timeline` scroll element
in a flex shell so reserved utilities sit outside the scrolling paint area; it
must not mount a desktop timeline plus a mobile timeline, clone rows for a
rail, create a second projection, or put a nested transcript scroller inside
the first.

The required structure is:

1. one non-scrolling timeline utility region;
2. the existing `.timeline` scrolling region, fed by the existing reduced
   `rows` suffix window; and
3. one reserved reveal-control region between the scrollport and composer when
   `Jump to latest` is needed.

The utility and reveal regions consume layout space. They may not be
absolutely positioned over the scrolling transcript. The composer remains the
timeline shell's normal-flow sibling; it is not an overlay.

### 2.2 Reading column and turn geometry

- The reading measure is fluid up to `768px`, centered in the available chat
  stage. At narrower widths it fills the stage minus a minimum `16px` logical
  gutter on each side.
- User turns align to the logical end and use the existing Ember user-bubble
  fill/border tokens. Their width is content-sensitive and capped so assistant
  prose retains an obvious independent reading edge.
- Assistant answer text aligns to the logical start and is unboxed: no default
  panel fill or border around ordinary prose. Tool cards, reasoning
  disclosures, error rows, code blocks, JSON trees, Mermaid/math surfaces, and
  image/attachment surfaces retain their own appropriate boundaries.
- Inter-turn spacing is larger than body-to-footer spacing. Message metadata
  is always a separate normal-flow row beneath its message; it never occupies
  body padding or an absolute layer.
- Use logical properties and `dir="auto"` on user/assistant textual content so
  Arabic/Hebrew, Latin, CJK, mixed text, and unbroken URLs wrap without
  document-level horizontal overflow. Application chrome keeps the
  application's direction, while the message's text direction follows its
  content.
- A final normal-flow tail clearance of at least `32px` and a target of `40px`
  separates the last visible timeline surface from the composer boundary.
  Neither the composer nor the reveal control may consume that clearance by
  painting over it.

### 2.3 Prompt navigation and timeline entry

The current `.prompt-nav` and `.timeline-open` controls are consolidated into
one reserved utility region outside the transcript scroll root:

- `Timeline` remains the visible entry to the existing `Session timeline`
  dialog and is named `Open session timeline`.
- `nav` retains the accessible name `Prompts in this session`.
- Prompt buttons remain ordered, window-aware jump controls. Each is named
  `Jump to prompt <n> of <total>: <bounded prompt preview>`; an empty prompt is
  named as empty rather than producing a blank control.
- At wide widths prompt controls may present compact dots/chips. Hover or focus
  may reveal a bounded prompt label and preview only in an in-flow portion of
  the reserved utility region. Revealing it may increase that region's block
  size and reduce the scrollport; it may not overlay a message, reasoning
  disclosure, tool card, timeline entry, or the viewport edge.
- At narrow, zoomed, coarse-pointer, or crowded widths the prompt controls use
  a horizontally scrollable/wrapping reserved strip or the existing timeline
  dialog. No preview popover opens off-screen, and no essential operation
  requires hover.
- Prompt activation first grows the existing suffix window when necessary,
  then aligns the target within the usable scrollport. Direct navigator
  activation retains focus on its invoking button. A prompt selected from the
  closing dialog moves focus to the target message container; neither path
  leaves focus on `BODY`.

There is no `float` on a flex item, no independent sticky `top:8px` controls,
and no transparent sticky paint area above transcript text.

### 2.4 Streaming, reader-held position, window reveal, and latest reveal

- If the scroll root is at/near the tail when a user sends or an assistant
  chunk arrives, the timeline follows growth in the answer's eventual prose
  block. It remains within `2px` of the moving maximum after layout settles.
- If the user scrolls beyond the existing near-tail threshold, incoming
  chunks, finalization, tool updates, error/retry surfaces, and footer
  appearance do not change the reader's `scrollTop` except for sub-pixel
  rounding. The reader is never yanked to the tail.
- While away from the tail, render one native button visibly named and
  accessibly named `Jump to latest` in a reserved region above the composer.
  During streaming it may include a nonessential Ember progress affordance,
  but its name and operation do not change and motion is not required.
- Activating `Jump to latest` grows the suffix window if needed, scrolls to the
  true final surface (including error/retry or completed-turn footer), marks
  follow mode active, and resumes tail-follow for later chunks. Keyboard
  activation must not drop focus to `BODY`; focus moves to the latest message
  container when the control is removed, or remains on the control until the
  next user navigation if it stays mounted.
- `Show earlier`, `Show all`, prompt jumps, session switches, direct reload,
  and post-replay restoration continue to use `timelineWindow.ts` and
  `timelineAnchor.ts`. Growing the suffix keeps the same content at the same
  usable-scrollport offset.
- Anchor capture/restoration is relative to the usable content edge, not a raw
  top coordinate hidden by chrome. With the required out-of-scrollport utility
  structure the inset is normally zero; the helper still owns that invariant
  so future reserved/sticky chrome cannot silently restore a row behind it.
- No reveal, jump, menu, disclosure, or layout preference writes a session
  event.

### 2.5 Message chrome and narrow action menu

The complete `UX-MSG-ACTIONS-SPEC.md` behavior is normative and unchanged.
In particular:

- finalized user and assistant messages retain semantic times and exact
  purpose-and-target action names;
- desktop hover and `focus-within` reveal remain, hidden controls retain no
  pointer hit area, and sequential Tab/Shift+Tab reaches them;
- non-hover or `max-width:480px` retains one persistent named action entry of
  at least `44×44px`, with menu rows at least `44px` high;
- Markdown/JSON/reasoning copy payloads, one live announcement, and focus
  retention remain exact;
- Revert/Fork stay user-message-only, truthfully eligible, append-only,
  failure-atomic, and absent from assistant, tool, task, and reasoning-only
  records; and
- reasoning remains one keyboard-operable disclosure and never becomes a
  duplicate answer bubble.

The following predecessor strings remain exact, including their dynamic full
local date/time target:

- `Copy user message as Markdown`, `Copy user message as JSON`,
  `Copy assistant answer as Markdown`, `Copy assistant answer as JSON`, and
  `Copy reasoning for assistant answer`;
- `Revert and edit user message sent <full local date and time>` and
  `Fork and edit from user message sent <full local date and time>`;
- `Actions for user message sent <full local date and time>` and
  `Actions for assistant answer completed <full local date and time>`;
- `Show reasoning for assistant answer` / `Hide reasoning for assistant
  answer`;
- `Sent <full local date/time>` / `Completed <full local date/time>`; and
- `Message copied as Markdown`, `Message copied as JSON`, `Reasoning copied`,
  and `Couldn’t copy message`.

The narrow action menu changes placement, not semantics. It opens as bounded
normal-flow content associated with the footer, preferably immediately after
the footer. It must push later content rather than cover its target body. Its
inline size is bounded by the reading column; its block size is bounded by the
visible timeline and becomes internally scrollable when every row cannot fit
at once. Opening it may use the existing timeline scroll root to reveal the
menu, including at `scrollTop=0`; it may not extend behind the header or outside
the scrollport. Escape/outside press closes it, action activation closes it,
and focus returns to the opener exactly as the predecessor contract requires.

### 2.6 Composer boundary and constrained height

The timeline and composer remain normal-flow siblings. At ordinary viewport
heights there must be zero geometric intersection between the composer and the
last message body/footer. At `200%` zoom on a physical `768×900` viewport
(`384×450` CSS pixels in the audited browser), the timeline must retain at
least `120px` of usable scrolling height.

This height gate may use responsive CSS in the existing stylesheet to compact
the textarea and arrange existing composer controls for a short viewport.
Every composer operation remains reachable, and the timeline must not win
height by clipping or removing required controls. No composer state machine,
send/stop behavior, draft ownership, queue behavior, or controller is changed.

## 3. Root-cause-to-change contract

| Audited root cause | Required change | Proof required |
|---|---|---|
| `.prompt-nav` is a direct flex item; `float:right` is ineffective; sticky transparent chrome has no exclusion zone. | Remove float/sticky-overlay placement and give prompt navigation plus the timeline entry one reserved, non-overlapping utility region outside the scroll root. | At all required widths/zoom, rectangle and center-point hit tests show no prompt/timeline control over any message, reasoning, tool, footer, or each other. |
| `.timeline-open` independently sticks at the same `top:8px`, so the controls collide with each other and transcript rows. | Render it in the same reserved utility region with deterministic flex/grid sizing and no duplicate sticky slot. | Both controls remain visible, named, focusable, and mutually disjoint after arbitrary timeline scrolling. |
| Expanded prompt labels paint above text and the preview assumes a right-side rail, opening left off-screen. | Make expansion/preview in-flow and viewport-bounded; adapt to strip/dialog presentation when space is insufficient. | Hover, focus, touch, RTL, CJK, long-token, `320/390/768`, and `125–200%` checks have no clipping or content coverage. |
| `.msg-actions-popup` is absolutely positioned above its footer, covering the body; a tall early menu cannot flip/clamp and enters the fixed header. | Replace body-adjacent absolute placement with bounded normal-flow placement and internal scrolling as necessary; retain the exact action set and focus behavior. | First user four-row menu and final assistant menu are fully reachable, in the timeline scrollport, non-covering, and center-hit-testable at `320/390` and `200%`. |
| Stable anchors use the raw scrollport top and can preserve an already occluded row; there is no latest-reveal control. | Extend/reuse `timelineAnchor.ts` around a usable-content inset, keep suffix-window compensation, and add the accessible reserved `Jump to latest` control. | Earlier reveal, hidden prompt jump, session switch, same-tab reload, streaming-away-from-tail, and latest jump preserve the specified row/offset and focus. |
| Event streaming/finalization is not causal; the collision reproduces from a settled canonical log. | Keep the repair presentation-only. Do not alter reducers, event types, chunk/final ordering, or append-before-display paths. | Event arrays and projected content/order are identical before/after non-mutating layout interactions and across full replay. |
| The composer is geometrically separate but fixed-height allocation collapses the timeline at high zoom. | Add short-height responsive allocation in existing CSS while retaining a normal-flow composer and at least `120px` usable timeline height. | `384×450` CSS viewport at 200% has a usable timeline, all composer controls remain reachable, and no surface overlaps. |
| Message text has no per-message direction. RTL content inherited LTR and still entered the broken left strip. | Set textual message direction from content and use logical sizing/alignment properties throughout the repaired layout. | RTL and mixed-direction fixtures wrap and read correctly with zero page overflow and no chrome collision. |

## 4. Accessibility acceptance criteria

1. The single scroll root is a named region, `Conversation timeline`, and is a
   valid focus target for deliberate focus restoration. Do not make the whole
   transcript an assertive live region; streaming must not repeatedly announce
   the growing answer.
2. User and assistant turn containers expose a semantic group/article name
   that distinguishes `User message sent …`, `Assistant answer streaming`, and
   `Assistant answer completed …` without adding visible role labels. Tool,
   task, reasoning, and error semantics remain distinct.
3. Prompt navigation is a named `nav`; every prompt jump is a native button
   with its index, total, and bounded target preview in its accessible name.
   Any visual preview is associated with the focused/hovered control and
   contains no focusable duplicate actions.
4. `Open session timeline` and `Jump to latest` are native buttons with visible
   text or an equivalent persistent visible label. Do not copy ChatGPT's
   `aria-hidden`, `tabindex=-1` jump control.
5. Hover-only discovery remains keyboard reachable through `focus-within`.
   Hidden desktop action chrome has no pointer hit area. Every control has a
   visible Ember focus indicator and remains wholly in the visible scrollport.
6. Tab and Shift+Tab follow DOM/timeline order and pass between timeline and
   composer without a trap. Enter and Space activate buttons/disclosures.
   Escape and outside press close the action menu and restore its opener.
7. Prompt/dialog jumps, action-menu close, reasoning toggle, same-session
   reveal, and latest jump never leave focus on `BODY`, a removed node, or
   obscured content.
8. Existing `UX-MSG-ACTIONS` names, roles, expanded states, semantic `<time>`
   values, polite copy-result live region, exact announcements, and focus
   restoration are byte-for-byte behavior contracts, not optional examples.
9. Pointer targets are at least `44×44px` in non-hover/coarse-pointer layouts;
   unforced center taps hit the intended control. Color, animation, and
   position are never the only state signal.
10. At `prefers-reduced-motion: reduce`, use immediate or minimal scrolling and
    no looping/pulsing latest indicator. Function, names, order, and focus are
    unchanged.

## 5. Responsive acceptance criteria

Test the full state matrix, not only a short settled answer:

| Viewport / input | Required result |
|---|---|
| `1440×900` | Centered `768px` maximum reading measure; utility chrome remains visually subordinate and outside the transcript; no excessive full-width answer boxes. |
| `1024×900` | Same centered measure when available; shell/rail pressure makes the column fluid rather than introducing horizontal page scroll. |
| `768×900` | Reading column and reserved utilities shrink/reflow; no off-left preview, no sticky collision, and no document overflow. |
| `390×844` | Collapsed workspace navigation; minimum `16px` message gutters; persistent `44×44px` message action entry; bounded prompt utility and menu; final footer remains above composer. |
| `320×844` | All `390px` guarantees at the predecessor's minimum width; long labels wrap or scroll internally and no control center is clipped. |
| Physical `768×900` at `125%` and `200%` zoom | No collision or horizontal page overflow. At `200%` (`384×450` CSS in the audited browser), timeline usable height is at least `120px`; menus and composer controls remain reachable. |
| Coarse pointer / `hover:none` | No hover dependency; prompt and message actions are persistent, named, `44×44px`, and center-hit-testable. |
| Keyboard only | Every timeline utility, prompt, body disclosure, action, reveal, retry, and composer control is reachable in meaningful order with visible focus. |
| Reduced motion | No required animation; tail jump and follow settle correctly without smooth-scroll dependence. |
| RTL/mixed direction | Message text uses content direction; role geometry and utility layout use logical properties; no clipping, reversed action meaning, or overflow. |

No required viewport may have document-level horizontal scrolling. Deliberate
internal horizontal scrolling is allowed only for intrinsically wide code,
tables, diagrams, or the bounded narrow prompt strip, and must not move the
whole page.

## 6. Event, API, replay, and security implications

This is a presentation-only change:

- no API route, request/response DTO, WebSocket frame, session event,
  projection schema, reducer order, backend adapter, persistence transaction,
  model-history derivation, export, copy payload, or permission check changes;
- no speculative row, duplicate message, duplicate reasoning record,
  display-before-log path, event deletion, or content reordering;
- all model-visible user, assistant, reasoning, tool, task, attachment, error,
  and image metadata remains durable in the ordered session event log before
  display;
- `timelineWindow` remains a presentation-only suffix over the same render
  model; revealing rows never creates, drops, or rewrites content;
- `timelineAnchor`, action-menu state, prompt-preview state, utility expansion,
  latest-button visibility, hover/focus, and reduced-motion choice remain
  client presentation state and append no event;
- same-tab hard reload/session switching may restore the existing
  session-scoped anchor. A wholly new browser session is not promised an old
  `sessionStorage` position and may start at the tail; either path replays the
  exact canonical content with no silent data loss;
- copy output remains sanitized exactly as specified by
  `UX-MSG-ACTIONS-SPEC.md`: no backend id, credentials, hidden reverted tail,
  internal metadata, or local anchor state; and
- existing Markdown/HTML sanitization, URL policy, image policy, and Mermaid
  sandbox/error fallback remain unchanged. Layout work must not relax them.

The OpenCode boundary remains absolute: only `packages/backend-opencode` may
talk to the process/SDK. This case requires no backend or OpenCode change.

## 7. Minimal implementation seams and technical invariants

| File | Permitted responsibility |
|---|---|
| `apps/web/src/components/Timeline.tsx` | Keep one reduced timeline; add the reserved utility/reveal structure and latest state; consolidate prompt/timeline controls; apply message direction/semantic focus targets; change only action-menu placement mechanics while reusing the current action entries and handlers. |
| `apps/web/src/styles.css` | Centered ChatGPT-aligned turn geometry using Ember tokens; reserved utility/reveal layout; non-overlay menu; logical/RTL properties; responsive, touch, reduced-motion, zoom/short-height, and composer-boundary rules. No new theme system or CSS module. |
| `apps/web/src/timelineAnchor.ts` | Extend the existing stable-row helper only as needed to measure the usable content edge/inset. Preserve the stored stable row id, offset, `atBottom`, session scope, and graceful storage failure. |
| `apps/web/src/timelineWindow.ts` | Reuse the existing suffix/window-growth math. Change only if a focused pure helper is unavoidable; do not introduce a competing window or render model. |
| Existing/new focused files under `apps/web/test/` | Unit and live geometry/interaction gates described below. Extend `messageActions.live.ts` for predecessor preservation and add a focused timeline-layout live gate rather than weakening existing assertions. |

Do not modify `reduce.ts`, server/session/contracts/backend packages,
`builtinSurfaces.tsx`, composer controller/state, APIs, or the parity YAML for
this implementation unless a newly proven blocker contradicts this contract.
Escalate such a blocker instead of broadening the patch.

All TypeScript remains Node-22-erasable: no enums, namespaces, decorators that
need emit, or parameter properties. Local imports use explicit `.ts`
extensions; cross-package imports use workspace names such as
`@polyth/contracts`. Preserve the `@polyth/web` workspace and existing export
boundaries.

## 8. Required states and content to exercise

The live fixture and manual pass must cover every row:

| State/content | Required observation |
|---|---|
| Happy completed turn | User/assistant distinction, centered measure, semantic times/actions, final tail clearance, and turn footer. |
| Empty | One honest empty state; no phantom actions/nav/reveal; composer remains reachable. |
| Loading/initial replay | No false empty-state flash over loaded content, no anchor jump after rows arrive, and utilities appear only when their targets exist. |
| Streaming | Partial answer grows in its final unboxed prose location; tail follow works; finalized metadata appears only at finalization. |
| Scrolled-up streaming | Reader position stays fixed while scroll maximum grows; `Jump to latest` appears and works. |
| Error | Terminal error is readable in flow, announced by its existing semantics, and does not collide with chrome. |
| Retry | Retry remains named/focusable and appends through the existing send path; its new stream obeys the same follow/hold rules. |
| Interrupted/aborted | Interrupted state is distinct from failure, remains chronological, and leaves actions/reveal usable. |
| Long message and long unbroken URL | Wraps without page overflow or utility/action collision. |
| Many short messages / more than 150 rows | Suffix window, `Show earlier`, `Show all`, prompt jump, latest jump, and stable anchor all work without omitted/duplicated rows. |
| Markdown prose and lists | Ordinary answer remains unboxed and readable; nested blocks stay inside the measure. |
| Fenced code and wide table | Internal overflow is bounded; no document overflow; copy/code chrome does not collide with message actions. |
| Mermaid | Rendered diagram and source/error fallback remain bounded and usable. |
| Math | Inline/block math stays readable and bounded at all widths/zoom. |
| JSON | Tree/code representation can scroll internally; controls and focus remain visible. |
| Image plus user attachment pills | Image scales within the reading column; gallery/open controls and pills do not alter timeline width or cover chrome. |
| Reasoning | Exactly one keyboard disclosure, expanded and collapsed, never covered by prompt/message chrome. |
| Tool and task/Worked cards | Pending, completed, failed, collapsed, and expanded content stays chronological and collision-free. |
| RTL and mixed-direction text | `dir=auto` behavior, logical alignment, wrap, prompt labels, actions, and menu are correct. |
| Keyboard only | Full prompt/reveal/action/reasoning/retry/composer traversal and focus restoration. |
| Touch/coarse pointer | Persistent controls, center taps, menu scrolling, no hover dependency. |
| `320`, `390`, `768`, `1024`, `1440`, reduced motion, `125%`, `200%` | Every responsive criterion in section 5. |
| Post-restart/replay | Same-tab hard reload and server restart restore the stable reading anchor after canonical replay; a fresh browser starts deterministically without losing/reordering content. |

## 9. Acceptance tests

### 9.1 Automated gates

1. Extend `timelineAnchor.test.ts` to cover usable-edge/inset capture and
   restore, positive/negative row offsets, `atBottom`, malformed/legacy data,
   session isolation, unavailable storage, and a row that would otherwise be
   occluded.
2. Keep all `timelineWindow.test.ts` suffix, monotonic growth, cap, and
   hidden-target assertions. Add the integration assertion that window growth
   preserves the anchored row's usable-edge offset and creates no duplicate
   row.
3. Add a real-browser timeline layout gate with deterministic settled and
   streaming fixtures. At `1440`, `1024`, `768`, `390`, `320`, `125%`, and
   `200%`, assert:
   - zero document horizontal overflow;
   - reading measure at most `768px`;
   - no rectangle intersection between prompt/timeline utilities and message,
     reasoning, tool/task, message-footer, error/retry, or turn-footer boxes;
   - utility controls do not intersect each other;
   - no body/footer intersection;
   - no composer/last-visible-surface intersection;
   - at least `32px` final tail clearance in ordinary heights and at least
     `120px` usable timeline height at `200%`; and
   - all visible pointer centers hit their intended controls.
4. In the streaming gate, begin at the tail and verify settled distance is at
   most `2px`; repeat after scrolling above the threshold and verify
   `scrollTop` stays within `1px` while `scrollHeight` grows. Verify one named
   `Jump to latest` button, keyboard activation, tail arrival, resumed follow,
   and non-`BODY` focus.
5. Exercise more than 150 mixed rows. Verify `Show earlier`, `Show all`, hidden
   prompt jump, utility prompt jump, session switch, direct reload, and server
   restart preserve content order, target visibility, and anchor offset.
6. Extend `messageActions.live.ts` rather than replacing it. Its complete
   predecessor suite must still pass, plus:
   - first user four-row menu and final assistant menu are normal-flow,
     non-covering, bounded, internally scrollable if needed, and fully
     reachable;
   - exact names, menu roles/expanded state, Escape/outside close, focus
     restoration, one copy announcement, Markdown/JSON payloads, semantic
     times, Revert/Fork eligibility, failure atomicity, and reasoning behavior
     are unchanged.
7. Exercise happy, empty, loading, streaming, failed, retry, interrupted,
   long, many-short, Markdown, code, Mermaid, math, JSON, image/attachments,
   reasoning, tool/task, RTL, keyboard, and touch fixtures. Assert no React
   error, duplicate visible message id, silent row loss, or unexpected event.
8. Snapshot the canonical event array before and after prompt hover/focus,
   prompt jump, timeline-dialog open/close, window reveal, latest jump,
   action-menu open/close, copy, and reasoning disclosure. It must be deeply
   equal. Existing mutation tests separately prove the exact allowed append
   behavior for Retry, Revert, Fork, and replacement send.
9. Keep the OpenCode-boundary grep gate passing, although no backend file
   should be touched.

Run at minimum:

```sh
node --test apps/web/test/timelineWindow.test.ts
node --test apps/web/test/timelineAnchor.test.ts
node --test apps/web/test/smoke.test.ts
node --test apps/web/test/messageActions.live.ts
node --test apps/web/test/timelineLayout.live.ts
(cd apps/web && npx tsc --noEmit)
npm run build:web
```

### 9.2 Manual computer-use checklist

Use a headed browser against an isolated synthetic runtime. Record the final
successful journey; do not use DOM mutation as product evidence.

1. Open the direct multi-prompt session at each required viewport. Scroll from
   top to bottom and confirm the reserved prompt/timeline utilities never
   cover text, reasoning, tool/task cards, metadata, or each other.
2. Hover and keyboard-focus every prompt item. Confirm labels/previews expand
   in flow, remain bounded, expose the correct target, and do not move focus or
   open off-screen. Jump to a visible and a window-hidden prompt.
3. Start a short stream at the tail and observe in-place growth/follow. Start a
   long stream, scroll up, confirm the reading line stays fixed, operate
   `Jump to latest` with keyboard, and confirm subsequent chunks follow.
4. Reveal earlier rows and all rows; switch sessions; return; hard reload the
   canonical URL; restart the isolated server and replay. Confirm the same
   anchor/content returns where promised and no message is omitted,
   duplicated, reordered, or silently replaced.
5. At `390`, `320`, touch emulation, and `200%`, open the first user action
   menu and final assistant action menu. Scroll every row, center-tap copy,
   close with Escape/outside press, and verify no body/header/composer cover
   and correct focus restoration.
6. Execute the `UX-MSG-ACTIONS` preservation journey: desktop hover and focus
   reveal; Tab/Shift+Tab to/from composer; exact accessible names; Markdown,
   JSON, and reasoning copy with one announcement; semantic time; reasoning
   Enter/Space; Revert/reload/Restore; Fork success/failure; and truthful
   disabled states.
7. Inspect empty, initial loading, completed, streaming, failed, Retry,
   interrupted, and active-revert states. Expand/collapse reasoning and
   pending/completed/failed tool/Worked cards.
8. Inspect long prose, long URL, CJK, RTL/mixed direction, Markdown, wide code,
   Mermaid success/error, math, JSON, image, and attachment-pill content.
   Confirm only intrinsic content scrolls internally and the page does not.
9. At the bottom, confirm the last body, message footer, error/retry or turn
   footer, tail clearance, reveal region, and composer occupy disjoint boxes.
   At `200%`, confirm at least `120px` of timeline remains usable and every
   composer control is reachable.
10. Repeat with reduced motion and keyboard only. Confirm no animation is
    required, no trap occurs, every focused element is visible, and no journey
    leaves focus on `BODY`.

## 10. Resolved parity rows

No new parity row is invented. The case ledger must list these existing IDs:

| Parity ID | Why this case touches it | Resolution in this contract |
|---|---|---|
| `OC-02-001` | Timeline dialog and per-user-message Revert/Fork entries are inside the repaired chrome. | Preserve all `UX-MSG-ACTIONS` mutation semantics; placement only. |
| `OC-02-004` | User attachment/image pills share message geometry. | Include attachment/image overflow and collision gates; no pipeline change. |
| `OC-02-008` | Reasoning disclosure is directly occluded by the broken navigator. | Keep one disclosure and prove expanded/collapsed collision-free layout. |
| `OC-02-009` | Expandable normalized tool cards share the affected timeline edge. | Prove pending/done/error and expanded/collapsed cards are not covered. |
| `OC-02-010` | Specialized tool/task/code/JSON outcomes must fit the same reading column. | Add layout-only content gates; no renderer semantics change. |
| `OC-02-011` | Suffix window, earlier reveal, scroll stability, anchors, and latest reveal are timeline behavior. | This row owns the window/anchor/follow/jump acceptance. |
| `OC-02-012` | Prompt navigator is the primary confirmed collision and is currently marked `implemented`. | Treat the row as not acceptance-complete until this contract's live gates pass; retain its preference, preview, jump, and hidden-window behavior. |
| `OC-02-014` | Message copy actions are present in the repaired footer/menu. | Preserve exact Markdown/JSON/reasoning copy behavior and names. |
| `OC-02-015` | Message/turn footer metadata must remain separate and visible above the composer. | Preserve semantic times and one completed-turn footer; add geometry gates. |

`OC-02-005` is not added because no attachment transport/citation behavior
changes. `OC-02-013` is not added because pinning remains out of scope.
`OC-09-009` is exercised as complex content but not changed: Mermaid layout
uses the existing renderer/fallback. `OC-23-002` is not added because browser
zoom acceptance is not a new application scale preference. The matrix status
and `docs/parity/polyth-parity.yaml` remain unchanged in this specification;
the integrator/ledger owner records the case against the IDs above.

## 11. Explicit non-goals

- No product implementation in this specification task.
- No event-log, reducer, projection, API, backend, OpenCode adapter, model
  history, replay order, export, copy payload, or security-policy change.
- No second timeline, duplicate mobile transcript, new timeline data model,
  virtualization library, speculative row, or replacement of
  `timelineWindow.ts` / `timelineAnchor.ts`.
- No change to the exact behavior or eligibility defined by
  `UX-MSG-ACTIONS-SPEC.md`; no assistant/tool/task/reasoning Revert/Fork; no
  event mutation/deletion; no hidden-tail leakage.
- No shell, sidebar, header, rail, pane, plugin, permission, queue,
  notification, theme, workspace-topology, or composer-controller redesign.
  Short-height composer CSS is allowed only to preserve a usable timeline.
- No ChatGPT DOM/CSS copy, light-theme imitation, removal of Ember tokens,
  persistent avatars/role labels, or inaccessible hidden jump control.
- No tool/reasoning/card feature redesign, Mermaid editor work, new math/JSON
  renderer, image gallery redesign, attachment pipeline change, pinning,
  selection-action redesign, share/export redesign, or citation work.
- No new user preference, telemetry, analytics, server-side scroll state, or
  event for layout, hover, focus, preview, disclosure, menu, anchor, or latest
  state.
- No promise to restore session-scoped browser scroll state after a completely
  new browser session; canonical content/order must still replay without loss.

## Exact handoff

`Fable implementer: isolated worktree, implement only
UX-TIMELINE-LAYOUT-01-SPEC.md, focused tests, typecheck/tests on touched
packages`
