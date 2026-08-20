# UX-A390 independent verification

- Case: `UX-A390`
- Model / role: `SOL` / verifier
- Target: `7067970777ffd77d6a60691cf644a642f6b43c05`
- Runtime baseline read: `docs/ux-audit/RUNTIME-BASELINE.md`
- Verdict: **changes required**
- Verified: `2026-08-20`

## Passing evidence

- The live Chromium gate passed all `12/12` tests against the isolated
  synthetic runtime on `127.0.0.1:4453`. It exercised `320×900`, `390×900`,
  `390×844`, `768×900`, `844×390`, `1280×900`, and `720×450@2x`, including
  phone/tablet/desktop geometry, center hit-testing, modal focus, keyboard
  paths, 200% reflow, reduced motion, normal motion, reload, and theme checks.
- The focused responsive tests passed `14/14`. The repository suite passed
  `672`, skipped `1`, and failed `0`. TypeScript passed in all `25` configured
  workspaces. The production web bundle built successfully.
- An independent browser replay confirmed drawer, panel, terminal-view, and
  Escape flows. The accessibility tree exposed `Open projects and sessions`,
  `Close Files panel`, and `Files panel`.
- Opening and closing the drawer and panel and selecting Terminal did not
  mutate session history: the event sequence remained byte-for-byte
  equivalent at `26` events.
- The implementation adds no package, contract, event, DTO, route, or direct
  OpenCode coupling. Protected ports `4400` and `8888` were not touched.

## Changes required

1. **The selected view is not durable across reload.** At `390px`, the
   verifier selected Terminal, observed `Terminal` in the status bar, and
   reloaded the same project/session route. The restored view was `Chat`.
   `setActiveView()` changes only in-memory state, while the specification
   requires the active view to survive reload. The committed reload test never
   changes the view, so it cannot detect this failure.
2. **The timeline scroll anchor is not durable across reload.** In the loaded
   synthetic session the timeline had `2460px` of available scroll. The
   verifier placed it at `scrollTop=0`; after reload it restored at
   `scrollTop=2414`. The specification requires the scroll anchor to survive
   reload, but the committed reload test does not measure it.
3. **Bundled-theme Send contrast violates the explicit `4.5:1` requirement.**
   Measured token endpoint ratios for normal-size Send text are: Parchment
   `2.34–2.82:1`, Mist `3.54–4.39:1`, and Solar `2.38–2.93:1`. The live test
   knowingly lowers its threshold to each theme token pair's existing
   capability with `Math.min(4.5, ...)`, so it passes values the specification
   rejects.

The live gate should also assert a non-default active view and a non-bottom
timeline anchor through reload, and enforce `4.5:1` directly for Send in every
bundled theme.

## Exact next task

`FABLE-A390-FIX`: persist the selected view and timeline scroll anchor across
reload without weakening event safety, correct Send contrast in Parchment,
Mist, and Solar to at least `4.5:1`, strengthen the live assertions, and return
the repair commit to `SOL-A390-VERIFIER`.
