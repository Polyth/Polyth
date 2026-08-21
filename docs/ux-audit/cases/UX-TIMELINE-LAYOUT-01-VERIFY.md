# UX-TIMELINE-LAYOUT-01 — independent verification

- Case: `UX-TIMELINE-LAYOUT-01`
- Model / role: `SOL` / adversarial verifier
- Branch: `ux-timeline-layout-01`
- Merge base: `d35350116e756ddc86a8da24653e335792ef6c58`
- Reviewed commits: `362d00f` and
  `8ab5768a9f934e50f897fd6bdb9e937a597dec8a`
- Verified: `2026-08-21`
- Verdict: **changes-required**

## Verdict

Do not integrate `8ab5768`. The reserved timeline chrome and normal-flow
message menu repair the original overlay in the settled fixtures, and all
submitted tests pass, but four acceptance failures remain in required states.

## Required changes

### 1. The 200% composer overlaps its own controls

At the required `384×450` CSS viewport, the short-height one-row composer puts
`.composer-selectors` and `.composer-actions` in the same paint area. Measured
intersections include Technical options/Dictate, Model/Dictate, Model/Add,
Agent/Add, Agent/Open focused editor, Agent/Send, and Profile/Send. The Dictate
center hits Model; the Open focused editor center hits Agent; the Profile
center starts outside the viewport.

This fails the no-text-overlap requirement, SPEC §2.6's requirement that every
composer operation remain reachable, and the responsive center-hit contract.
Make the short-height bar a single non-overlapping layout sequence (or
otherwise give the two groups disjoint geometry) while retaining all controls
and the internal horizontal-scroll behavior.

Evidence:

- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_zoom200_adversarial.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_findings.json`

### 2. Dynamic reserved regions break the 120px 200% timeline floor

The submitted geometry gate checks the `135px` settled-tail scrollport only.
In two required interactive states the same scrollport falls below SPEC §2.6's
`120px` minimum:

- keyboard-focus of a prompt mounts the in-flow preview and reduces the
  timeline to `62px`;
- scrolling away from the tail mounts `Jump to latest` and reduces it to
  `95px`.

Preserve at least `120px` of timeline height after every reserved utility or
reveal region is mounted, not only in the settled state.

Evidence:

- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_zoom200_prompt_focus.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_zoom200_jump_reveal.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_findings.json`

### 3. Initial replay flashes the fresh-session hero over a populated session

With the canonical `tl01-rich` event request delayed by two seconds, the
direct session URL first renders `What are we working on in Timeline Layout
Fixture?`, no timeline, and zero messages. After replay arrives it switches to
the 12-message timeline. This is the false empty/fresh state prohibited by
SPEC §8's initial-loading row.

Represent unresolved replay as loading and do not choose the fresh-session
hero until the selected session's canonical event load has completed.

Evidence:

- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_findings.json`

### 4. Required reveal/menu focus restoration is incomplete

Two keyboard/focus paths violate SPEC accessibility criteria 6–7 and the
normative UX-MSG-ACTIONS contract:

- keyboard activation of `Show all` removes the reveal controls and leaves
  `document.activeElement === BODY`;
- outside-press closure of a narrow message action menu calls
  `closeMenu(false)` and moves focus to the `Conversation timeline` region
  instead of restoring the action-menu opener.

When an in-timeline reveal control unmounts, hand focus to a stable revealed
row or the named timeline region. Restore the message-menu opener on outside
press as required, matching Escape and action activation.

Evidence:

- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_findings.json`

## Independent diff and safety review

The complete merge-base diff was inspected: 12 changed files, 1,864 insertions
and 250 deletions. Production changes are limited to `Timeline.tsx`,
`messageActions.ts`, `styles.css`, and `timelineAnchor.ts`. No reducer,
event/DTO, API, session, server, contract, backend, OpenCode adapter, or parity
file changed. The interaction event-array equality gate passed. The patch is
presentation-only apart from synthetic test infrastructure.

The branch and remote both resolve `8ab5768` as the head under review, with
`362d00f` as its parent and `d353501` as the merge base.

## Passing evidence

- `NODE_OPTIONS=--experimental-strip-types node --test apps/web/test/*.test.ts`:
  `372` passed, `0` failed.
- `messageActions.live.ts`: `7` passed, `0` failed, including Revert,
  Restore/replacement, Fork success/failure/mismatch, Markdown/JSON/reasoning
  copy, semantic timing, disclosure, narrow menus, and the submitted
  desktop/mobile state matrix.
- `timelineLayout.live.ts`: `6` passed, `0` failed, including the submitted
  width matrix, settled geometry, streaming follow/hold/latest, suffix window,
  prompt/dialog jumps, reload/switch/restart anchors, and event purity.
- `(cd apps/web && npx tsc --noEmit)`: passed.
- `NODE_OPTIONS=--experimental-strip-types npm run build:web`: passed.
- `git diff --check d353501..8ab5768`: passed.

The environment's Node `22.14.0` requires the same
`NODE_OPTIONS=--experimental-strip-types` used by the recorded runtime
baseline; without it Node rejects `.ts` entry points before application code
runs.

Passing browser captures:

- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_timeline/layout-rich-1440.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_timeline/layout-rich-390.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_timeline/streaming-jump-latest-1280.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_message_actions/touch-menu-390.png`
- `/opt/cursor/artifacts/ux_timeline_layout_01_verify_message_actions/copy-reasoning-1280.png`

## Runtime baseline update

The reviewed branch bundle was rebuilt and served against disposable synthetic
data on confirmed-free port `4464`:

- URL:
  `http://127.0.0.1:4464/p/tl01-project/s/tl01-rich`
- data: `/tmp/polyth-tl01-data-9c41`
- home: `/tmp/polyth-tl01-home-9c41`
- tmux: `polyth-ux-timeline-layout-01-verify`
- health: `GET /api/health` returned `200` with `ok:true`

The earlier baseline on `4492` and all occupied user ports were left
untouched. The dedicated `computerUse` executor was unavailable; independent
interaction replay used real Google Chrome through `playwright-core`, the same
fallback recorded by the reference/root-cause audits.

## Exact next task

`Fable repairer`: fix the four findings above and extend the live gates so
`384×450` checks composer control intersections/center hits and the dynamic
preview/latest heights, delayed replay checks no false fresh state, and
keyboard/outside-close checks the two focus destinations.
