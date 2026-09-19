# Mobile interaction frame and wallpaper

`apps/web/src/mobileViewport.ts` measures the visual viewport. The final
`mobileViewport.css` import owns the compact web frame; the base rules in
`styles.css` remain desktop/pre-measurement fallbacks, not mobile geometry
truth. Electron retains its original frame and transparent-window handling.

## Separate geometry from paint

- `--visual-bottom` is `visualViewport.height + visualViewport.offsetTop` in
  layout coordinates. The mobile `.app` flex frame consumes it. Using only
  `--visual-vh` lifts the composer when Safari pans the viewport; using only
  `100vh` or `100dvh` ignores the measured reachable band. Never subtract the
  keyboard inset again from an already-visible measurement.
- The mobile root chain and app must not enforce a `100dvh` minimum over the
  measured frame. The composer stays in normal flex/sticky flow, not a second
  fixed-position layer with independently calculated offsets.
- New-chat and conversation docks reserve the home-indicator safe area once.
  When the keyboard is open, retain only their existing optical spacing. A
  hidden short-band hero body must not remove the new-chat dock's bottom anchor.
- A non-interactive, viewport-fixed root pseudo-element paints the selected
  wallpaper, including exposed canvas beyond a shorter flow/root box. Its
  large-viewport minimum is decorative only: it must not grow the app or the
  document scroll range. Mobile root/body/app must not paint duplicate images
  with independently scaled gradients. `None` removes the paint layer.
- Do not use screen-height guesses, hardcoded status-bar sizes, or
  `--app-system-bar-color` to substitute a flat strip for the selected image.
  The theme-color meta is only a fallback for browser/OS-owned chrome.

## Resume lifecycle

`startMobileViewport()` also remeasures on `pageshow` and on a transition to
`document.visibilityState === "visible"`. A restored or suspended PWA must
not retain an old keyboard-sized frame or Safari pan offset while waiting
for a resize event that may not arrive. Hidden visibility transitions do not
publish transient geometry. All events use the existing measurement and
unchanged-value deduplication path; there is no second viewport cache, timer,
screen-size guess, or forced page reload.

The isolated `mobileViewportResume.test.ts` tests execute that measurement
module with fake window/document/visualViewport event targets. They cover
resume without resize, hidden-to-visible transitions, stale pan offsets,
missing visualViewport, repeated startup/events and existing native keyboard
updates. They do not render React or emulate an installed iOS WebView.

## Verification

```sh
POLYTH_CHROMIUM_PATH=/usr/bin/chromium POLYTH_REQUIRE_CHROMIUM=1 \
  node --experimental-strip-types --test apps/web/test/mobileViewportFrame.test.ts
node --experimental-strip-types --test apps/web/test/mobileViewportResume.test.ts
```

The frame test loads the real shell, token, composer, and final viewport styles.
It checks both chat states, mismatched CSS/measured heights, panned and
resized keyboard bands, close/restore, landscape, hit-testing, single safe-area
clearance, bottom-canvas pixel continuity, and unaffected desktop/Electron.
It also activates the existing standalone/WebKit CSS guards in Chromium to
check cascade precedence. That is **not** WebKit or installed-iPhone testing.

For device acceptance, inspect a fresh installed iOS launch, keyboard
open/close, rotation and background/resume in light/dark themes with preset
and custom backgrounds. Record `innerHeight`, visual-viewport height/offset,
app/composer rectangles and safe insets. An OS-owned strip outside the WebView
cannot be validated or painted by a DOM fixture; do not mark it device-fixed
based solely on browser tests or a CSS-string assertion.
