# UX-TIMELINE-LAYOUT-01 — fresh independent re-verification

- Case: `UX-TIMELINE-LAYOUT-01`
- Model / role: `SOL` / independent adversarial re-verifier
- Branch: `ux-timeline-layout-01`
- Head: `3cd7c73cbe2282f7a44052bd6a138801685b2292`
- Repair: `becb8f4e28638737433fed85c2d7b896ec62f3fc`
- Merge base: `d35350116e756ddc86a8da24653e335792ef6c58`
- Re-verified: `2026-08-21`
- Verdict: **approved**

## Verdict

Approve `3cd7c73` for integration. This was a fresh pass over the full
merge-base diff and a rebuilt isolated runtime, not a reliance on the
repairer's report. All four findings in the prior `VERIFY.md` are closed, the
required responsive/live journeys pass, and no new release-blocking regression
was found.

## Prior findings closed

| Prior finding | Independent result |
|---|---|
| 1. 200% composer control overlap | Closed. At `384×450`, the command bar is one internally scrollable row. Pairwise control and group intersections are zero. An additional per-control probe scrolled each of the 8 controls into view; Technical options, Model, Agent, Profile, Dictate, Add, focused editor, and enabled Send were wholly visible, center-hit-testable, and keyboard focusable. The initially empty Send was truthfully disabled; after entering a draft it became focusable and remained fully visible and center-hit-testable. There was zero document horizontal overflow. |
| 2. Dynamic regions break the 120px floor | Closed. Independently measured timeline `clientHeight` at `384×450`: settled `153px`, prompt focus `153px`, Jump-to-latest reveal `124px`, and reveal plus prompt focus `124px`. All are at or above the required `120px`, and utility/reveal/composer boxes remained disjoint. |
| 3. False fresh-session replay flash | Closed. With the canonical rich-session event request delayed by 2 seconds from document start, the UI rendered `Loading session…` as `role=status`, with no fresh-session hero, phantom messages, or fresh composer. The 12-message timeline replaced it after replay. A document-wide mutation observer saw no fresh hero at any point. |
| 4. Reveal/menu focus restoration | Closed. Keyboard `Show all` and final `Show earlier` activation both moved focus to the named `Conversation timeline` region when their bar unmounted. Narrow-menu outside press on inert content restored the exact action opener; Escape and action activation remained intact. A deliberate press on the composer closed the menu and correctly retained textarea focus rather than stealing the user's new target. No path left focus on `BODY`. |

## Full contract spot-check

- Real Chrome covered `1440×900`, `1024×900`, `768×900`, `390×844`,
  `320×844`, the `125%` CSS equivalent, and `384×450` for physical
  `768×900` at `200%`. Every size had zero page overflow, a reading measure no
  wider than `768px`, named/disjoint utility chrome, no message/body/footer or
  composer intersection, and valid visible-control center hits.
- The final journey covered centered user/assistant geometry, unboxed assistant
  prose, semantic times, Markdown/code/long-token/RTL content, reasoning,
  Worked/tool cards, tail clearance, narrow action menus, and the composer
  boundary. No message text was covered by prompt, timeline, menu, reveal, or
  composer chrome.
- Streaming followed within `2px` at the tail, held a scrolled-up reader within
  `1px` while content grew, exposed one reserved `Jump to latest`, handed off
  keyboard focus, and resumed follow. More-than-150-row reveal, hidden prompt
  jump, dialog jump, reload, session switch, and server restart preserved row
  order/anchors without duplicates.
- Reduced motion was enabled for the full live matrix. Keyboard prompt/reveal,
  timeline-dialog, reasoning, message-action, Escape, outside-close, and
  composer traversal paths passed. Touch/narrow targets and menu rows remained
  at least `44px`.
- The complete normative `UX-MSG-ACTIONS` live suite passed: desktop
  hover/focus reveal, purpose-and-target names, Markdown/JSON/reasoning copy
  and one announcement, semantic time, Revert/Restore/replacement, Fork
  success/failure/mismatch, truthful state matrix, narrow menus, and focus
  retention/restoration.
- Layout-only interactions left the canonical rich-session event array deeply
  equal. The implementation diff changes no contracts, reducer, session,
  server, backend/OpenCode adapter, or parity matrix.

The dedicated computer-use executor was not available in this run. As in the
prior audit baseline, the fallback drove installed Google Chrome
`148.0.7778.96` through `playwright-core`; the checks used normal browser
input/layout APIs and did not mutate the product DOM.

## Verification commands and results

- `NODE_OPTIONS=--experimental-strip-types node --test
  apps/web/test/timelineLayout.live.ts` on a fresh isolated fixture and free
  port: **10 passed, 0 failed**.
- `NODE_OPTIONS=--experimental-strip-types node --test
  apps/web/test/messageActions.live.ts`: **7 passed, 0 failed**.
- `NODE_OPTIONS=--experimental-strip-types node --test
  apps/web/test/*.test.ts`: **373 passed, 0 failed**.
- `(cd apps/web && npx tsc --noEmit)`: passed.
- `NODE_OPTIONS=--experimental-strip-types npm run build:web`: passed.
- `git diff --check d353501..3cd7c73`: passed.

The first timeline invocation against the long-running repair fixture on
`4463` passed 9/10 but could not observe the first streaming container. The
canonical log showed that the already-restarted synthetic backend had reused
fixture-only `partId` values from earlier repair runs. Per the handoff, the
suite was rebuilt with distinct disposable data on confirmed-free port `4465`;
all 10 tests, including streaming and an in-suite server restart, then passed.
No occupied port was stopped or reused.

## Evidence

- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_isolated/layout-rich-1440.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_isolated/layout-rich-390.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_isolated/layout-rich-zoom200.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_isolated/layout-rich-zoom200-reveal-focus.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_isolated/streaming-jump-latest-1280.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_actions/touch-menu-390.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_actions/copy-reasoning-1280.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_actions/revert-replacement-1280.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_reverify_actions/fork-child-1280.png`

## Handoff

`SOL integrator`: record the approved case in the execution ledger and proceed
with integration/PR handling.
