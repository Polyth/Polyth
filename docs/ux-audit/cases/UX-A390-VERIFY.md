# UX-A390 independent re-verification

- Case: `UX-A390`
- Model / role: `SOL` / verifier
- Target: `4da7d324ba9cfe3af15f1d330af19225c15d60b7`
- Runtime baseline read: `docs/ux-audit/RUNTIME-BASELINE.md`
- Runtime: exact target commit, isolated synthetic data, `127.0.0.1:4454`
- Verdict: **verified**
- Verified: `2026-08-20`

## Repair findings

All three findings from the first verification are fixed.

1. At `390×844`, selecting Terminal with the keyboard, reloading the same
   session route, and waiting for replay restored both the `Terminal` status
   and the accessible name `Change workspace view, current: Terminal`.
2. A loaded timeline saved at `scrollTop=0` with `2516px` available scroll,
   survived the Terminal reload, and returned to exactly `scrollTop=0` after
   switching back to Chat. A separate gate restored a mid-scroll anchor within
   `2px`.
3. Rendered Send text and both gradient token endpoints now enforce `4.5:1`
   directly in every bundled theme. Independent endpoint measurements were:
   Ember `8.55/9.52`, Midnight `7.61/9.18`, Forest `10.14/12.03`,
   Parchment `6.10/7.33`, Mist `5.65/4.77`, and Solar `4.75/5.85`.

## Full gate evidence

- Live Chromium: `13/13` passed. The matrix covered `320×900`, `390×900`,
  `390×844`, `768×900`, `844×390`, `1280×900`, and `720×450@2x`; shell
  overflow, bounds, overlap, center hit-testing, touch targets, drawer/sheet
  modals, keyboard paths, resize, 200% reflow, motion, reload, event safety,
  accessibility names, and bundled-theme contrast all passed.
- Independent browser replay: at `320px`, all eight sampled primary controls
  were in bounds, center-hittable, and at least `44×44px`, with zero page
  overflow. At `390px`, Enter/Space opened the named modal drawer/sheet,
  focus stayed inside, Escape restored each opener, and the Chromium AX tree
  exposed the expected drawer, view, auto-accept, and panel names.
- At `720×450@2x`, the first hero item began below the scroll origin, the last
  action was reachable at positive maximum scroll, page/stage horizontal
  overflow was `0`, and twelve Tab steps kept focus on-screen.
- Session history remained byte-for-byte unchanged through drawer, panel,
  view, anchor, and reload operations (`8522` response bytes before and after).
- Focused responsive/repair tests passed `28/28`; the repository suite passed
  `680`, skipped `1`, and failed `0`. Every configured TypeScript workspace
  typechecked, and the production web bundle built successfully.
- The OpenCode boundary remains intact: SDK/process ownership stays in
  `packages/backend-opencode`; the server uses only its workspace API.

Evidence: `/opt/cursor/artifacts/ux_a390_sol_reverify_evidence.json`,
`/opt/cursor/artifacts/ux_a390_sol_reverify_390.png`, and
`/tmp/polyth-a390-sol-reverify-artifacts/geometry.json`.

## Exact next task

`SOL-A390-INTEGRATOR`: integrate repair
`4da7d324ba9cfe3af15f1d330af19225c15d60b7`.
