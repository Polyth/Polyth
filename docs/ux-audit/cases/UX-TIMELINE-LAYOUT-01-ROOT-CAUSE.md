# UX-TIMELINE-LAYOUT-01 — Polyth root-cause audit

- Case: `UX-TIMELINE-LAYOUT-01`
- Model / role: `SOL` / root-cause auditor
- Status: `auditing`
- Classification: `broken`
- Audited: `2026-08-21`
- Repository root: `/workspace`
- Audited source: `b63b6c887726896739ead8fc021320f8db52bed8`
- Runtime: `http://127.0.0.1:4492/p/db081417-e2a9-4920-8c42-19d757b6fc93/s/timeline-layout-audit`
- Predecessor contract: `docs/ux-audit/cases/UX-MSG-ACTIONS-SPEC.md`

## Decision

Polyth is `broken`, not merely visually rough. Once the reader scrolls a
multi-prompt session, the sticky prompt navigator and sticky `Timeline` button
occupy the same left/top space and paint above message content. At narrow
widths the collision covers user text; at every tested width it can cover the
left edge of assistant text. Expanding the navigator covers a much larger
portion of the answer, and its preview opens off the wrong side of the
scrollport.

There is a second, independent narrow-screen failure in the presentation
required by UX-MSG-ACTIONS. The persistent action entry is correctly separate
from its message body, but its absolutely positioned menu opens upward over the
body. For a four-item user menu near the top, scrolling cannot make the popup
fit: its top is behind the fixed header and the first menu row is not visible.
The fix must preserve the predecessor's names, targets, focus, copy semantics,
Revert/Fork eligibility, and append-only event behavior while changing the
layout/placement of this chrome.

No application source or runtime event data was changed for this audit.

## Reproduction and measurements

The recorded isolated runtime was healthy (`/api/health` returned `200`) and
contained only synthetic audit text. Because the dedicated `computerUse`
executor was not exposed to this worker, the existing visible headed Chrome
window was operated through desktop input and its DevTools connection. The
same session was exercised at `1280×900`, `768×900`, `390×844`, and `320×844`,
plus real Chrome zoom steps. No account or private data was shown.

Journey:

1. Open the direct synthetic session and leave the prompt navigator in its
   default `auto` state. Five prompts make it visible.
2. At the top, the navigator and `Timeline` button occupy separate flow slots.
3. Scroll down about `40px`: message rows begin moving behind the sticky
   navigator. At about `72px`, the `Timeline` button reaches the same sticky
   `top: 8px` position as the navigator.
4. At `scrollTop≈150–170`, inspect or hit-test the left edge of the visible
   message. At `390px`, `(48,94)` is ordered navigator dot → navigator item →
   navigator → `Timeline` button → user message/bubble. At `1280px`, the same
   stack appears over the first visible assistant bubble.
5. Hover a prompt item at `768px`. The navigator grows from `40px` to `300px`
   and its labels paint above the assistant text. Its preview measures
   `x=-331.9..6.0`, almost entirely outside the viewport.
6. At `390px`, expand `Thinking` and align it near the top. The reasoning box is
   `x=16.0, y=88.3, w=347.9, h=113.6`; the navigator is
   `x=16.0, y=88.0, w=40.0, h=68.0`. Navigator items hit above the summary and
   reasoning body.
7. At the bottom, open the final assistant action menu. The popup is
   `x=113.9, y=277.4, w=250.0, h=113.0`; its target bubble is
   `x=16.0, y=192.4, w=347.9, h=200.0`. The popup is inside the scrollport but
   covers the lower-right `250×113px` of answer text.
8. Open the first user action menu. Its four rows wrap to a `255px`-high popup
   whose top is `y=11.6`, while the timeline starts at `y=56.0`. The fixed
   header wins hit-testing there, and `Copy user message as Markdown` is hidden.

At the bottom with all popups closed, the ordinary layout does **not** collide:

| Viewport | Timeline bottom | Composer top | Last message-meta bottom | Body/meta intersections |
|---|---:|---:|---:|---:|
| `1280×900` | `698.0` | `698.0` | `647.9` | `0` |
| `768×900` | `646.0` | `646.0` | `595.8` | `0` |
| `390×844` | `489.1` | `489.1` | `438.4` | `0` |
| `320×844` | `489.1` | `489.1` | `437.8` | `0` |

Thus the timestamp, closed action row, and composer are not covering their own
message in the settled fixture. The last footer has about `50.7px` clearance
from the composer at phone widths.

## Exact elements and trigger conditions

| Element pair | Result | Trigger |
|---|---|---|
| `.prompt-nav` / `.prompt-nav-dot` over `.bubble` text | Confirmed collision | Navigator `auto` with at least three prompts, or forced `on`; timeline scrolled roughly `40px+`; assistant rows at all tested widths, and sufficiently wide/wrapped user rows at narrow widths. |
| `.timeline-open` over `.bubble` text | Confirmed collision | Any session with a user prompt; after roughly `72px` scroll it sticks at the same top/left position. The navigator normally hides it only because navigator `z-index:5` beats its `z-index:4`. |
| `.prompt-nav` over `.timeline-open` | Confirmed collision | Both are present and have reached `top:8px`; their first `40×22.5px` overlaps. |
| Expanded prompt labels over message text | Confirmed collision | Hover or `focus-within`; width expands to `300px` without reserving content space. |
| `.prompt-nav-preview` outside the scrollport | Confirmed clipping | Hover/focus preview; it is positioned to the left of a navigator that is itself incorrectly on the left. |
| `.prompt-nav` over `.reasoning` summary/body | Confirmed collision | Reasoning disclosure scrolls into the sticky band; expanded state makes the overlap explicit. |
| `.msg-actions-popup` over its target `.bubble` | Confirmed collision | Non-hover device or `max-width:480px`, menu open. The popup always opens immediately above the footer and over the adjacent body when their horizontal ranges meet. |
| Header over first user `.msg-actions-popup` row | Confirmed clipping | Four-item user menu opened near scroll start at `390px`; popup is taller than available space above its opener and placement has no flip/clamp. |
| `.msg-time` or closed `.msg-meta` over its own body | No collision | Zero body/meta rectangle intersections at all four tested viewports. |
| Streaming `.caret` over own time/actions | No dedicated collision in code | The caret is inline in an unfinished bubble; metadata is rendered only after finalization. Streaming was not live-generated because the isolated fixture has no model. |
| Avatar or role label | Not present | Timeline renders role-specific `.msg` classes but no per-message avatar or visible role label. |
| Tool cards, code chrome, attachment pills | Not present in this fixture | They were not claimed as live evidence. They use the same left-edge message flow, so the sticky controls can cover them whenever they enter the sticky band. |

### Content, script, width, and zoom stress

- **Length:** the sticky collision is structural, not gated by a character
  count. Longer/wrapped messages keep text in the affected band longer. User
  bubbles avoid the left strip only while their intrinsic width remains narrow
  enough to stay right-aligned.
- **Long token/URL:** a transient DOM-only presentation probe used one
  unbroken synthetic URL. `.bubble { overflow-wrap:anywhere }` prevented page
  overflow, but four wrapped line boxes intersected the navigator's
  `16..56px × 88..156px` rectangle.
- **CJK:** a synthetic repeated CJK probe also produced no horizontal document
  overflow, but four line boxes intersected the same sticky rectangle.
- **RTL:** Polyth supplies no per-message `dir` in `Timeline.tsx`. Arabic
  therefore inherited LTR in the first probe and intersected on four lines.
  With explicit `dir=rtl`, long lines still reached `x=48.2` while the
  navigator ended at `x=56`, so the structural overlap remained.
- **Streaming vs settled:** settled content reproduces the defect. Streaming
  uses the same `.bubble` and adds only an inline `.caret`; growth and
  auto-follow move earlier rows under the sticky chrome. If the reader scrolls
  away from the tail, Polyth stops following, but it offers no jump-to-latest
  control.
- **Narrow width:** at `390px` and `320px`, content and sticky controls all
  start at `x=16px`; wrapped user bubbles join assistant/reasoning content in
  the collision zone. The normal phone composer is `275.1px` high and leaves a
  `433.1px` timeline.
- **Zoom:** at Chrome's 125% layout step, a physical `768×900` window exposed a
  `614×720` CSS viewport and the collision persisted. At 200%, the CSS viewport
  was `384×450`, the phone action-menu mode activated, and hit-testing again
  returned navigator → `Timeline` button → bubble. More seriously, the fixed
  shell left only a `41px`-high timeline above a `273px` composer, with
  `2010px` of timeline scroll range. The navigator itself is about `68px` high,
  so the reading surface becomes effectively unusable.

## CSS, component, and event-flow root cause

### 1. A float is being used inside a flex column

`apps/web/src/styles.css:454-458` defines `.timeline` as a column flex
container. `Timeline.tsx:728-732` then renders `.prompt-nav` and
`.timeline-open` as the first two direct flex items.

`apps/web/src/styles.css:2544-2548` attempts to put the navigator on the right
with `float:right`, but floats do not float flex items. The navigator therefore
stays at the physical start of the reading column. It is also sticky,
transparent, `z-index:5`, constrained to `40px`, and pulled with a negative
right margin. No grid column, padding inset, or sibling wrapper reserves its
paint area.

The `Timeline` button has the same unresolved design:
`styles.css:2520-2521` gives it `position:sticky; top:8px; z-index:4`.
Neither control has an exclusion zone. Once normal-flow rows scroll beneath
them, overlap is guaranteed; because both use the same sticky top, they also
overlap each other.

### 2. Hover expansion and preview assume the rail is on the opposite side

`styles.css:2549-2559` expands the same in-flow/sticky flex item to `300px` and
reveals labels above the transcript. `styles.css:2562-2577` positions the
preview with `right:calc(100% + 10px)`, which would make sense for a rail on the
right. Because the ineffective float leaves the rail on the left, the preview
opens farther left and is clipped by the timeline/viewport.

The component behavior is otherwise straightforward:
`Timeline.tsx:450-476` renders one button per prompt, while
`Timeline.tsx:589-595` auto-enables the navigator at three prompts. The
collision is a layout error, not a wrong prompt index or event projection.

### 3. The narrow action menu has no collision-aware placement

`Timeline.tsx:226-252` correctly puts `<time>`, desktop actions, and the
persistent action entry in one footer after the body. The closed footer is
sound. On open, however, `styles.css:2487-2492` absolutely positions a
minimum-`250px` popup at `right:0; bottom:calc(100% + 4px)`. It has no top/bottom
flip, viewport clamp, reserved row, portal boundary, or non-covering placement.

`Timeline.tsx:186-190` calls `scrollIntoView({block:"nearest"})` on that absolute
popup. This can move later messages enough to keep the popup in the timeline,
but it cannot scroll before `scrollTop=0`; therefore a tall early user menu
extends behind the fixed header. It also cannot prevent the popup from covering
the target body because the CSS explicitly places it in that body-adjacent
space.

This issue was introduced with the UX-MSG-ACTIONS presentation, but the action
semantics are not the cause and must not be removed. The repair needs a bounded
placement contract that retains one named `44×44px` entry, `44px` menu rows,
focus restoration, Escape/outside close, and all purpose-and-target names.

### 4. Scroll/anchor code preserves content position but knows no occlusion

`Timeline.tsx:512-528` follows new model versions only while the scroll root is
within `80px` of the bottom; an intentionally scrolled-up reader remains in
place. `Timeline.tsx:599-617` preserves position when earlier windowed rows are
revealed, and `timelineWindow.ts:1-30` changes only the rendered suffix.

`timelineAnchor.ts:50-59` defines “topmost visible” relative to the raw
scrollport top, without subtracting sticky chrome. Restoration at
`Timeline.tsx:619-642` faithfully reapplies that raw offset. This code does not
create the overlays, but it considers a row behind them visible and can
faithfully restore an already-occluded position. Prompt jumps use
`scrollIntoView({block:"center"})` (`Timeline.tsx:643-652`), which usually avoids
the top band but supplies no general overlay inset.

Polyth also has no jump-to-latest control in `Timeline.tsx`. Once
`atBottom.current` becomes false, the reader must manually scroll to the tail.

### 5. Streaming/event order is not the collision source

`reduce.ts:344-369` projects durable `assistant/chunk`,
`assistant/reasoning-chunk`, and final `assistant/message` events into one
assistant part. `Timeline.tsx:256-264` renders unfinished text in its eventual
bubble with an inline caret and does not render message metadata until the
answer is finalized. `utils.ts:83-124` merges reasoning-only parts into one
reasoning disclosure/answer presentation.

The observed collision needs no event mutation, speculative row, duplicate
reasoning record, or display-before-log path. It is wholly reproducible with a
settled canonical log. A fix must remain presentation-only and preserve the
append-before-display invariant.

### 6. The composer boundary is geometrically separate but zoom-fragile

`components/workspace/builtinSurfaces.tsx:94-106` renders the flexing
`.timeline-wrap` and the composer as siblings. `styles.css:454-458` makes the
timeline the scroll root, while `styles.css:594-599` keeps the composer in
normal shell flow. This explains the zero physical intersections and the
approximately `51px` bottom clearance in the normal phone run.

The shell is fixed to `100vh` with overflow hidden (`styles.css:192-194`).
Combined with the `86px` textarea minimum (`styles.css:714-717`), the phone
two-tier composer (`styles.css:3147-3180`), status bar, and fixed bottom
navigation, high zoom leaves almost no flexible timeline height. This is a
height-allocation failure, not the composer painting over content.

## Git history: introduction, amplification, and non-causes

- `84e776c` (2026-08-18, initial commit) already made `.timeline` a flex column.
- `c27c6a5` (2026-08-20, “polyth and Paseo web parity features”) introduced
  `PromptNavigator` and the current sticky/`float:right` CSS directly into that
  flex column. The float was ineffective on arrival. The primary defect is
  therefore longstanding for the prompt-navigator feature, not a regression in
  the latest merge.
- `0d0be86` (2026-08-20, “Add session rewind, redo, and fork-from-message”)
  added the sticky `Timeline` button with the same `top:8px`, creating the
  second sticky item in the collision slot.
- `1766577` (2026-08-20, “Add selection quick actions, prompt hover previews,
  and timeline windowing”) added the left-opening preview and `300px` hover
  surface. It amplified the collision and made the placement error obvious;
  the suffix-window and reveal math are not causal.
- `faa3f5c` (2026-08-20, “event-derived message actions”) introduced the
  semantic message footer and mobile menu. The footer removed self-overlap in
  its closed state, but the absolute popup added the separate body-covering and
  top-clipping condition.
- `fb71bc1` (2026-08-20, stable timeline anchor) and the later consolidation
  commits preserved raw scroll positions but did not change the sticky CSS.
- Recent `Timeline.tsx` consolidation at `8c6d549` and current merge
  `b63b6c8` did not repair these selectors. `git blame` still attributes the
  primary navigator lines to `c27c6a5`, the preview to `1766577`, and the
  message popup to `faa3f5c`.

## ChatGPT reference versus Polyth

| Concern | ChatGPT reference audit | Actual Polyth |
|---|---|---|
| Turn layout | Centered `768px` reading column; right/tinted user bubble; left unboxed assistant prose; no role/avatar row. | Gutter-derived `920px` column with `860px` boxed user and assistant surfaces. Role is conveyed by alignment/color; no role/avatar row. Wider assistant boxes increase exposure to the left sticky strip. |
| Per-message chrome | Persistent separate `32×32px` copy/share row; no visible timestamp; row never covered text. | Semantic times and required UX-MSG-ACTIONS controls are in a separate footer and do not collide while closed. The narrow popup covers its body and a tall early user menu is clipped behind the header. |
| Streaming | Partial answer grows in its final prose block; Stop replaces send; short bottom-follow remains near maximum. | Chunks grow in the final bubble with an inline caret and no premature meta row. Code follows only while near the bottom. Live generation was unavailable in the no-model fixture. |
| Scrolled-up reading and reveal | Reader position stayed exact; visual jump-to-latest control appeared and restored the tail. | Reader position is retained through `atBottom` and stable anchors, but there is no jump-to-latest control. Sticky prompt controls cover the retained reading position. |
| Composer boundary | Final action row remained about `40px` above the composer at desktop/tablet/mobile. | No normal physical overlap; measured phone clearance is about `51px`. The phone composer is about `275px` high, and at 200% zoom the timeline collapses to `41px`. |
| Reasoning/tool cards | Not produced in the logged-out reference, so no parity contract was inferred. | One keyboard-operable reasoning disclosure is correctly separate from answer text, but the navigator covers it in the sticky band. No tool card was present in the target fixture; its shared left-edge geometry is a code-level risk, not claimed live evidence. |
| Responsive behavior | No horizontal overflow at `768px` or `390px`; mobile composer about `87px` high. | No horizontal document overflow in the fixture or URL/CJK probes, but `768`, `390`, `320`, 125% zoom, and 200% zoom all retain the sticky collision. Narrow action placement and high-zoom height allocation are materially worse. |

ChatGPT is a behavioral reference, not a source of DOM/CSS to copy. In
particular, Polyth must keep the stronger UX-MSG-ACTIONS semantic timing,
purpose-and-target names, JSON/Markdown copy contracts, reasoning disclosure,
and append-only Revert/Fork rules.

## Evidence

Primary target evidence:

- `/opt/cursor/artifacts/polyth_timeline_root_cause_desktop_1280_clear.png` —
  settled desktop timeline before deliberate scroll; body and footer are
  separate.
- `/opt/cursor/artifacts/polyth_timeline_sticky_nav_overlap_desktop_1280.png` —
  desktop prompt dots and `Timeline` button above assistant text.
- `/opt/cursor/artifacts/polyth_timeline_sticky_nav_overlap_768.png` — tablet
  collision over the first visible assistant line.
- `/opt/cursor/artifacts/polyth_timeline_sticky_nav_overlap_390.png` — phone
  collision over the first user message.
- `/opt/cursor/artifacts/polyth_timeline_sticky_nav_overlap_320.png` — same
  collision at the predecessor's smallest acceptance width.
- `/opt/cursor/artifacts/polyth_timeline_prompt_nav_hover_collision_768.png` —
  expanded labels covering assistant text; preview is off-screen.
- `/opt/cursor/artifacts/polyth_timeline_reasoning_expanded_nav_collision_390.png`
  — navigator dots and `Timeline` button covering expanded reasoning.
- `/opt/cursor/artifacts/polyth_timeline_actions_popup_over_body_390.png` —
  assistant menu covering the answer it controls.
- `/opt/cursor/artifacts/polyth_timeline_user_actions_menu_clipped_390.png` —
  first user menu clipped behind the header; its Markdown row is absent from
  the visible menu.
- `/opt/cursor/artifacts/polyth_timeline_zoom_125_actual_overlap.png` — sticky
  collision persists at Chrome's 125% layout step.
- `/opt/cursor/artifacts/polyth_timeline_zoom_200_overlap.png` — 200% zoom
  leaves a sliver of transcript between header and composer while sticky chrome
  still covers the message.

Reference behavior and its screenshot inventory remain in
`docs/ux-audit/cases/UX-TIMELINE-LAYOUT-01-REFERENCE-AUDIT.md`.

## Next task for the specifier

Write `docs/ux-audit/cases/UX-TIMELINE-LAYOUT-01-SPEC.md` as a
presentation-only implementation contract reconciled with
`UX-MSG-ACTIONS-SPEC.md`. It must specify:

1. one collision-free home for prompt navigation and the timeline dialog entry
   at desktop, touch, `320/390px`, RTL, long-token/CJK, and 125–200% zoom;
2. non-covering, viewport-bounded action-menu placement that preserves all
   UX-MSG-ACTIONS names, targets, focus, menu rows, and event invariants;
3. sticky-overlay-aware scroll anchors plus a keyboard-operable
   jump-to-latest/reveal contract without adopting ChatGPT's inaccessible
   control;
4. a minimum usable timeline height and composer-boundary behavior under
   high zoom/short viewports;
5. live gates for settled, streaming, scrolled-up, reasoning, tool, code, and
   attachment states; and
6. parity YAML resolution. `OC-02-012` (“Prompt navigator”) is currently marked
   `implemented` despite the confirmed break. The specifier should also decide
   whether scroll/window acceptance belongs in `OC-02-011` and where the
   UX-MSG-ACTIONS presentation gate is represented, rather than inventing an
   untracked case row.

Exact handoff:

`SOL UX/architecture specifier: write UX-TIMELINE-LAYOUT-01-SPEC.md implementation contract reconciled with UX-MSG-ACTIONS-SPEC; resolve parity YAML row IDs`
