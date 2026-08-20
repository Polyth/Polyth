# Visual and behavioral baseline

- Case: `UX-VISUAL-BASELINE`
- Recorded: `2026-08-20`
- Runtime source: `docs/ux-audit/RUNTIME-BASELINE.md` at audit handoff revision `379f5bee5b354091859ff8a4ec11832b21c689ad`
- Polyth runtime: `http://127.0.0.1:4401`
- polyth runtime: `http://127.0.0.1:8889`
- Browser: Google Chrome stable

## Method

The audit used the isolated synthetic projects and sessions from the runtime baseline. Each UI was loaded at desktop width before resizing so the same selected project and session were compared at `1440`, `1024`, `768`, `390`, and `320` CSS pixels. The `200%` case used a `1440 × 900` physical capture with a `720 × 450` effective CSS viewport and device scale factor `2`. Reduced-motion and keyboard-only checks used fresh isolated browser contexts.

Severity in this document:

- `P0`: a primary surface or control cannot be used reliably.
- `P1`: a major obstruction, clipping, or accessibility failure has a workaround.
- `P2`: visible degradation that does not block the primary path.

## Executive findings

1. **P0 — Polyth is not usable at 390 px or 320 px.** At `390`, the persistent right rail consumes `44 px`, leaving a `346 px` main surface. The `378 px` header view switcher starts at `x=269.8` and ends at `x=647.8`; nine header controls are clipped and the in-viewport `Git` control overlaps the rail's `Files` control by `70%` of the smaller control. The composer model, agent, attachment, and Send controls occupy the same row space and overlap, including full model/agent overlap and model/Send overlap. Keyboard hints and status text are clipped by hidden overflow rather than exposed through horizontal scrolling.
2. **P0 — the Polyth 320 px state compounds the 390 px failure.** The hero heading begins behind the fixed header, the composer control row remains stacked on itself, only part of the starter-action list fits, and the status bar is truncated. The rail remains fixed at `44 px`.
3. **P0 — polyth also fails at 390 px and 320 px.** Its `280 px` left sidebar does not collapse, leaving about `110 px` at `390` and `40 px` at `320` for the chat surface and right tool rail. Header text and composer copy wrap into near single-character columns. The OpenCode update toast covers the lower interaction area.
4. **P1 — Polyth at 200% zoom clips content vertically.** The hero heading is hidden under the fixed header and two starter buttons extend below the `450 px` effective viewport. The page reports no scrollable document extension, so the clipped content cannot be reached by normal page scrolling.
5. **P1 — polyth's update toast obstructs the composer.** The toast covers composer controls at `1440`, `1024`, `768`, and `200%` zoom; it occupies most of the remaining primary surface at mobile widths. It is dismissible, but the initial state obscures the primary action.
6. **P1 — polyth keyboard focus is not visually distinct on ordinary controls.** Fifty Tab steps were sampled. The composer was reached at step `39`, but sampled active controls had no computed outline or box shadow. The editor caret identifies focus once the composer is reached; earlier icon and session controls do not expose an equivalent visible indicator.

## Responsive matrix

| Width | Polyth | polyth |
|---|---|---|
| `1440` | Primary layout is coherent. Sidebar, header, composer, rail, and status bar fit. | Primary layout fits; update toast covers the composer's right side. |
| `1024` | Primary layout is coherent; long labels truncate intentionally. | Layout fits, but the update toast covers composer controls. |
| `768` | Left project/session sidebar collapses. Header title truncates, but the composer and rail remain usable. | Left sidebar remains `280 px`; main area is constrained and the toast covers most composer controls. |
| `390` | **P0:** clipped/overlapping header, rail, composer controls, keyboard hints, and status content. | **P0:** fixed sidebar leaves an unusably narrow chat column; toast obstructs the bottom. |
| `320` | **P0:** 390 px failures plus hero clipping and missing lower actions. | **P0:** fixed sidebar leaves about `40 px` for the primary surface. |
| `200%` | **P1:** heading and lower actions are vertically clipped with no document scroll extension. | **P1:** sidebar remains wide and update toast covers the composer. |

## Polyth 390 px P0 detail

The screenshot and geometry report agree on four independent failures:

- **Header / rail:** the header's view switcher extends `257.8 px` beyond the viewport. `Terminal`, `Preview`, `Goals`, `Multi-run`, `Fusion`, `Walkthrough`, `Schedule`, `GitHub`, and More actions are partially or fully out of view. The `Git` header button overlaps the right-rail `Files` button.
- **Composer:** the card is only `266 px` wide, but the model control alone is `240 px` and the agent control is `149 px`. Both retain desktop row positioning. Model, agent, attachment, and Send controls overlap, making labels unreadable and hit targets ambiguous.
- **Footer / hints:** keyboard hints and status values remain on desktop-width rows and are visually truncated. Root scroll width still equals `390 px`, so no horizontal recovery path is available.
- **Persistent rail:** the right rail remains `44 px` wide and full height. It is individually in bounds, but it reduces the usable main width and collides with overflowing header controls.

This state should not be treated as cosmetic truncation. Multiple controls share the same coordinates and cannot be reliably identified or activated.

## Input and motion behavior

### Keyboard-only

- Polyth reaches the message textarea at Tab step `25`. The preceding desktop navigation controls have visible orange focus outlines. The textarea itself has no direct outline, while the surrounding composer card changes border through focus-within. Empty Send is disabled and is not in the Tab order.
- polyth reaches the editor at Tab step `39`. The editor caret becomes visible, but the sampled buttons and session controls before it have no computed focus outline or box shadow. The long path and absent indicator make keyboard position difficult to track.

### Reduced motion

- Both runtimes acknowledge `prefers-reduced-motion: reduce`.
- Polyth exposes no active Web Animations and no nonzero CSS animation or transition durations in the sampled state.
- polyth retains one running `1.2 s` CodeMirror cursor-blink animation and `42` elements with nonzero transition durations. Major width/opacity containers include reduced-motion utility classes, while many `150 ms` color and opacity transitions remain styled.

## Evidence

Machine-readable measurements and Tab sequences:

- `/opt/cursor/artifacts/ux_visual_baseline_final_sol_58a2.json`

Polyth screenshots:

- `/opt/cursor/artifacts/ux_visual_polyth_1440_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_1024_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_768_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_390_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_320_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_zoom_200_sol_58a2_v4.png`
- `/opt/cursor/artifacts/ux_visual_polyth_reduced_motion_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_keyboard_sol_58a2_v3.png`

polyth screenshots:

- `/opt/cursor/artifacts/ux_visual_polyth_1440_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_1024_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_768_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_390_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_320_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_zoom_200_sol_58a2_v4.png`
- `/opt/cursor/artifacts/ux_visual_polyth_reduced_motion_sol_58a2_v3.png`
- `/opt/cursor/artifacts/ux_visual_polyth_keyboard_sol_58a2_v3.png`

All evidence uses synthetic runtime-baseline content. No real user chat, credentials, or user-specific filesystem paths are recorded. The runtime services were left running.

## Recommended next task

`SOL`: implement the Polyth `≤390 px` P0 responsive shell fix: collapse the view switcher and right rail behind explicit menus, stack or wrap composer controls without overlap, keep the hero below the fixed header, and make keyboard hints/status content truncate or wrap intentionally. Add automated geometry assertions at `390 px`, `320 px`, and `200%` zoom before parity polishing.
