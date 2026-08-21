# UX-TIMELINE-LAYOUT-01 — ChatGPT reference and Polyth pre-observation

- Case: `UX-TIMELINE-LAYOUT-01`
- Model / role: `SOL` / bootstrap and reference auditor
- Status: `auditing`
- Audited: `2026-08-21`
- Polyth source: `b63b6c887726896739ead8fc021320f8db52bed8`
- Required predecessor: `docs/ux-audit/cases/UX-MSG-ACTIONS-SPEC.md`

## Runtime baseline

The repository root is `/workspace`. Current source was exported to and built
at `/tmp/polyth-ux-timeline-layout-01-b63b6c8`. The isolated runtime is healthy
at `http://127.0.0.1:4492`; its synthetic timeline is:

`http://127.0.0.1:4492/p/db081417-e2a9-4920-8c42-19d757b6fc93/s/timeline-layout-audit`

Full launch and access details are in `docs/ux-audit/RUNTIME-BASELINE.md`.
Port `4400` and all pre-existing services were left untouched.

## Live ChatGPT method and scope

This is an observation of the current public `https://chatgpt.com/`
conversation UI, not a reconstruction from memory. The dedicated
`computerUse` executor was not exposed to this worker, so SOL operated a normal
headed Google Chrome window on the desktop with `xdotool`, then attached
Playwright over Chrome DevTools Protocol for repeatable measurements and
screenshots. Chrome's visible Cloudflare checkbox was completed through the
desktop before CDP automation began.

The browser used a fresh, logged-out profile. Three harmless synthetic prompts
created the reference conversation; no account, prior chat, real user content,
credential, token, or repository content was exposed. The main desktop
viewport measured `1434×911`; responsive captures used `768×900` and
`390×844`. The logged-out surface is a real public conversation UI, but it may
omit actions that only authenticated users receive.

## Observed ChatGPT journey

1. **Turn layout and reading width.** The desktop turn container was centered
   in the main stage and capped at `768px`. User turns were right-aligned,
   rounded, lightly tinted bubbles; assistant turns were unboxed prose aligned
   to the left reading edge. This difference supplied role recognition without
   a persistent role label or avatar. Wrapped prose stayed in the same capped
   column, with generous space between user and assistant turns and a smaller
   action row attached beneath each completed turn.

2. **Per-message chrome.** No visible per-turn timestamp, role word, or avatar
   was present in this logged-out journey. A completed user turn showed one
   persistent `Copy message` button below its bubble. A completed assistant
   turn showed persistent `Copy response` and `Share` buttons in a separate
   row below the prose. Each measured `32×32px`; hovering did not reveal an
   additional action set, and the copy control accepted keyboard focus. The
   separate row reserved vertical space and did not cover message text.

3. **Streaming and reflow.** The assistant answer appeared directly in its
   eventual prose block, beginning with a partial first line and growing in
   place. The composer changed its trailing control to a black square Stop
   button. There was no separate avatar, timestamp placeholder, or typing
   bubble beside the answer. At the bottom, sampled scroll distance converged
   from a transient `12.8px` to at most `0.6px` from the moving maximum, so a
   short answer remained followed without visible snap-back.

4. **Scrolled-up reading and reveal.** After SOL deliberately scrolled upward
   during a longer stream, `scrollTop` stayed exactly
   `456.1269836425781` while the scroll maximum grew from `1056` to `1444`
   and then `1921`; the answer did not yank the reader downward. A centered
   circular down-arrow appeared above the composer and changed to animated dots
   while the stream was active. Activating it moved the scroll root to
   `1921.0159` against maximum `1921`. In the observed DOM this visual control
   was `aria-hidden="true"` and `tabindex="-1"` with no accessible name, so it
   is a useful visual reference but not an accessibility pattern to copy.

5. **Composer boundary.** At the bottom of the conversation the final turn,
   action row, and disclaimer remained above the sticky composer. The measured
   clear gap between the final turn and composer was about `40px` at desktop,
   tablet, and mobile (`40.3`, `40.4`, and `39.7px` respectively). The
   composer did not cover the final answer or its action row.

6. **Supplementary content.** The logged-out synthetic journey did not produce
   a tool card, task card, citation panel, or reasoning disclosure. No nesting
   contract is inferred from an unobserved state. A later authenticated or
   fixture-safe reference pass may add evidence, but ordinary timeline layout
   must not depend on it.

7. **Responsive behavior.** At `768×900`, the `260px` sidebar stayed present
   and the main turn width reduced to about `492.8px`; there was no horizontal
   document overflow. At `390×844`, the sidebar collapsed, the turn section was
   about `374.9px`, and the two-row composer was about `342.9×87px`, again with
   zero horizontal overflow. Message actions remained persistent `32px`
   controls. The sticky top bar stayed compact, but at the captured tablet and
   mobile bottom anchors the first partially visible line entered beneath it;
   ChatGPT is therefore a behavioral reference, not a defect-free pixel
   template.

## ChatGPT screenshot evidence

- `/opt/cursor/artifacts/chatgpt_timeline_streaming_desktop.png` — partial
  assistant text and Stop control during streaming.
- `/opt/cursor/artifacts/chatgpt_timeline_desktop_bottom_actions.png` —
  capped answer column, persistent assistant actions, bottom padding, and
  composer boundary.
- `/opt/cursor/artifacts/chatgpt_timeline_scrolled_up_streaming.png` —
  reader-held scroll position while a later answer grows below.
- `/opt/cursor/artifacts/chatgpt_timeline_scrolled_up_jump_latest.png` —
  visual jump-to-latest control while above the tail.
- `/opt/cursor/artifacts/chatgpt_timeline_after_jump_latest.png` — state after
  activating jump-to-latest.
- `/opt/cursor/artifacts/chatgpt_timeline_autofollow_final.png` — short
  bottom-followed turn with user/assistant distinction and action rows.
- `/opt/cursor/artifacts/chatgpt_timeline_tablet_768.png` — tablet-width
  sidebar, narrowed reading column, sticky composer.
- `/opt/cursor/artifacts/chatgpt_timeline_mobile_390.png` — collapsed sidebar,
  wrapped answer, mobile composer, and no horizontal page overflow.

## Preliminary Polyth overlap observation

The current isolated Polyth build does reproduce the case, but the collision
is not between the new message body and its own timestamp/action row in the
measured states. At desktop, `768`, `390`, and `320px`, those rows occupied
separate boxes with zero measured intersection.

The visible collision is the session prompt navigator over the message flow.
At `390px`, the `nav.prompt-nav` landmark named `Prompts in this session`, its
`button.timeline-open` labelled visually `Timeline`, and its
`.prompt-nav-dot` items paint over the first visible assistant/user text.
Hit tests at `(47,100)`, `(47,120)`, and `(47,140)` returned prompt-navigator
elements above the underlying `.bubble`. The same label/dot column crosses the
reading area at `768px` and `320px`. This is enough to identify the candidate
collision without pre-empting the next agent's CSS and history analysis.

The narrow layout also gives the composer about `428.5px` of an `844px`
viewport and leaves the timeline about `279.5px` high. That is a secondary
layout/scroll candidate, not a root-cause conclusion.

Polyth evidence:

- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_desktop.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_768.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_390.png`
- `/opt/cursor/artifacts/polyth_timeline_overlap_preobserve_320.png`

## UX-MSG-ACTIONS constraints to preserve

The layout repair must retain these predecessor requirements:

1. The ordered session event log remains canonical; every model-visible item is
   durable before display. Layout, hover/focus, copy state, disclosure state,
   and time formatting append no event.
2. User and assistant copy actions keep their purpose-and-target accessible
   names, exact Markdown/JSON contracts, one live result announcement, and
   stable focus.
3. Revert/Fork remain user-message-only, append-only, truthfully eligible, and
   replay-safe. No layout change may expose them for assistant, tool, task, or
   reasoning-only records.
4. Desktop hover and `focus-within` reveal, no invisible pointer hit area, and
   sequential Tab/Shift+Tab navigation must remain. The composer must not trap
   Tab.
5. At non-hover or at most `480px`, each actionable message retains one
   persistent named `44×44px` action entry; its menu rows stay at least
   `44px`, inside the visible scrollport, with time still visible.
6. Semantic user/assistant times, one completed-turn footer, and one
   keyboard-operable reasoning disclosure remain separate from ordinary body
   text. Reasoning-only content must not become an answer bubble.
7. Preserve focus restoration, direct canonical URL reload, fork/revert
   failure atomicity, and the OpenCode boundary. Do not broaden this case into
   shell, rail, theme, plugin, permission, queue, or composer-controller
   redesign.

## Explicit next task

`SOL root-cause auditor`: reproduce the Polyth overlap journey, inspect git
history for `Timeline.tsx` and `styles.css`, pinpoint the CSS/layout root cause,
classify it as `works`, `works-but-poor-ux`, `broken`, `missing`, or `blocked`,
and write `docs/ux-audit/cases/UX-TIMELINE-LAYOUT-01-ROOT-CAUSE.md`.
