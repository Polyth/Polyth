# Mobile interaction frame and wallpaper

`apps/web/src/mobileViewport.ts` measures the visual viewport. The final
`mobileViewport.css` import owns the compact web frame; the base rules in
`styles.css` remain desktop/pre-measurement fallbacks, not mobile geometry
truth. Electron retains its original frame and transparent-window handling.

## Separate geometry from paint

- `--visual-frame-top` and `--visual-frame-height` are the interaction frame.
  With the keyboard closed, the frame is the **layout viewport**, measured from
  `document.documentElement.clientHeight` (the `100vh` box), not from
  `window.innerHeight`. iOS WebKit reports `innerHeight` as the visual band:
  floating browser toolbars and the installed-PWA home-indicator band shrink it
  without shrinking the surface the shell must paint, so a frame sized from
  `innerHeight` ended above the screen and left a permanent strip below `.app`.
  `clientHeight` stays stable while the toolbars move and keeps the document
  exactly as tall as its containing block, so no scroll range can appear while
  the keyboard is closed. A closed-state chrome delta at or above
  `KEYBOARD_MIN_INSET` (96px) is still classified as a keyboard and would keep
  the frame at the visual band; that threshold is the boundary to revisit if a
  device reports taller floating chrome. Keyboard detection additionally
  compares the visual band against a detached, off-flow `100vh` probe, so an
  engine that shrinks `innerHeight` and `clientHeight` together (iOS standalone)
  still flips `body[data-keyboard="open"]` and drops the installed-app `100vh`
  fill. The probe never becomes the frame itself, so `100vh` cannot outgrow a
  WebView that excludes browser chrome (Android Chrome). When the keyboard
  covers the layout, the frame uses `visualViewport.offsetTop` as its separate
  top coordinate and `visualViewport.height` as its height, because that is the
  only measurement that tracks the keyboard. The mobile chain consumes
  **`--visual-frame-bottom`** (top + height), not the height alone: when Safari
  pans the visual viewport to reveal the composer above the keyboard, an app
  bounded only by the visible height stays at the document origin and the rest
  of the panned band paints the canvas — reported as a strip covering most of
  the screen while typing. That pan offset is `visualViewport.offsetTop`, which
  Safari bounds inside the layout viewport. `--visual-bottom` is the
  compatibility alias of the same lower edge; `--visual-vh` still publishes the
  visual band for sheets and pickers.
- `visualViewport.pageTop` and `window.scrollY` are document pan coordinates,
  not frame dimensions. They must never be added to CSS height: Safari can
  auto-pan a focused editor while retaining the full layout viewport, and a
  document-level pan would grow the box past the layout viewport and restore a
  scroll range. The mobile `#root` is an in-flow, vertically bounded frame that
  may follow `visualViewport.offsetTop` but never the document scroll; internal
  timelines and sheets own their scrolling. Neither root nor app may enforce a
  `100dvh` minimum over the measured frame. The composer stays in normal
  flex/sticky flow.
- **Do not size the mobile `html`/`body`/`#root` chain from the viewport while
  the keyboard can be open.**
  Safari resolves `height: 100%`, `100vh`, `100dvh` — and the containing block
  of a `position: fixed` box — against the *large* viewport, which the
  on-screen keyboard does not shrink. Measured on iOS 26 (Safari): with the
  keyboard open `innerHeight` fell to 428px while
  `html { height: 100% }` still computed to 775px. That leaves 347px of scroll
  range, which Safari immediately pans to the end, carrying the whole shell off
  the top — `sY 347`, `root -347..81`, composer pinned under the status bar.
  Two separate attempts failed here: `position: fixed` on `html`/`body`, then
  on `#root` alone. The fix is that every box from the document root to `.app`
  takes the measured `--visual-frame-bottom`, which is the only value that
  tracks the keyboard. `.app` may use `height: 100%` because its parent already
  carries measured pixels.
  `apps/web/test/mobileFoundation.test.ts` rejects `100%`/`vh`/`dvh` and any
  `position: fixed` in the measured chain block; `mobileViewportFrame.test.ts`
  asserts a `static` chain and `scrollHeight <= innerHeight`.
- The installed iOS web app fills the large viewport while the keyboard is
  closed. `@supports (-webkit-touch-callout: none)` +
  `@media (display-mode: standalone)` gives unused `body`/`#root`
  `min-height: 100vh`, and the rule is disabled under
  `body[data-keyboard="open"]`. iOS standalone has a long-standing WebKit
  geometry bug where `100dvh` and `window.innerHeight` can both stop above the
  Home-indicator canvas of the physical screen; no DOM measurement can reach
  that band, while `100vh` (the layout viewport) has historically painted it
  correctly. Android Chrome is deliberately excluded: there `100vh` can exceed
  the WebView, and a clipped (`overflow: clip`) shell could not reach its
  composer. `mobileViewportFrame.test.ts` runs this rule through the existing
  standalone-cascade fixture.
- Safari 26 and Chrome honour `interactive-widget=resizes-content`, so the
  layout viewport is already the visible band there and the measured frame
  collapses to a no-op. The frame exists for engines and standalone modes that
  keep the layout viewport tall.
- WebKit keeps its own text-input accessory (the floating form assistant above
  the keyboard) **inside** the keyboard frame iOS reports, but the page only
  ever sees that frame as its own visual-viewport inset. On iOS the measured
  band therefore ends above the space the OS still leaves visible, and the
  phone composer floated that difference above the keyboard — reported as a
  large gap between the composer and the keyboard. While the keyboard is open
  in a compact frame on WebKit (`CSS.supports("-webkit-touch-callout",
  "none")`), `mobileViewport.ts` extends the published lower edge,
  `--layer-frame-bottom`, by `--keyboard-accessory-band` (48px: the measured
  height of the iOS 26 floating assistant; the token is read once) — the edge
  the app chain and every full-height layer end on. An engine that resizes
  the layout viewport with the keyboard already ends the frame at the
  keyboard, so extending it would push the composer under the keyboard — the
  edge is never extended outside WebKit. The canvas keeps painting whatever
  band remains, so this cannot leave an unpainted strip. The native iOS app is
  WebKit too, but the Capacitor keyboard plugin hides the form accessory
  (`hideFormAccessoryBar` defaults on) and, with `KeyboardResize.Native`, sets
  the WebView frame to window height minus the keyboard height, so the frame
  already ends at the keyboard. The band pushed the composer's lower rail 48px
  under the iOS keyboard there (device report 2026-10-10), so it is never added
  while the native plugin's inset drives the frame (also published as
  `body[data-keyboard-source="native"]`, `"viewport"` otherwise). The decision
  used to live in CSS (`@supports` rules on `html`/`body` keyed on
  `body[data-keyboard]`, an `html:has(body[data-keyboard-source="native"])`
  override); every keyboard state change then restyled the whole app (see
  *Restyle cost* below). `mobileViewportFrame.test.ts` and
  `mobileViewportLayers.test.ts` model the published edge with and without the
  band, `mobileViewportResume.test.ts` runs the decision itself (Chromium
  cascade + source-inspected plugin, not device-verified). Re-measure the token
  on a new iOS keyboard or accessory design: on the reported device the
  reserved band above the assistant measured 60–69px with the composer's own
  4px optical gap on top, so the composer now sits 12–25px above the assistant
  instead of that whole band.
- **Following the native keyboard (iOS app).** The plugin resizes the WebView
  only after the keyboard's slide plus 0.2 s, so a frame that waits for it
  leaves the docked composer behind the rising keyboard until it pops up (and
  in front of the falling one on close). `apps/mobile/src/nativeBridge.ts`
  passes `followKeyboard: true` with the plugin's `keyboardWillShow` height and
  its `keyboardWillHide` (iOS only — Android's WebView is resized by the window
  insets and keeps measuring), and the page follows the keyboard itself:
  - **The keyboard state and the frame are published apart.** The state —
    `body[data-keyboard]`, `[data-keyboard-source]`, `[data-band]` and the
    metrics React reads — follows the keyboard at once. It is cheap: only
    descendant rules react to it. The frame — the root variables above,
    `html[data-keyboard-frame]` and the chain heights — restyles the whole app
    (*Restyle cost*), so `setNativeKeyboardInset` keeps two insets, where the
    keyboard is going and what the published frame reflects.
  - **A keyboard that covers more is ridden first, then committed.** When the
    text entry the keyboard serves sits in a composer dock (the conversation
    dock or the new-chat hero dock, `focusRidesKeyboard()`), the frame keeps
    its keyboard-closed layout and `keyboardRide.ts` moves the dock — and, when
    the reader is at the tail, the transcript column (`.timeline-wrap`) by
    the amount Timeline's follow will scroll — with WAAPI `transform`
    animations: keyframes sampled from the keyboard's curve, run by the
    compositor (Core Animation on iOS), so no main-thread stall can make the
    composer fall behind the keyboard. Each ride starts from where the rider
    is (a FLIP of the state switch: the dock's anchor is the composer card's
    bottom, since rows and clearances change with the state) and is placed on
    the keyboard's clock with a start time, not a `currentTime` measured
    against the last frame. The frame commits once the keyboard has landed:
    on the plugin's WebView resize (the layout height reaching the closed
    layout minus the keyboard) or, at the latest, `max(slide + 80 ms, 700 ms)`
    later. The commit measures where the riders really are and glides any
    residual away (180 ms); a correct prediction leaves none. The commit's
    whole-app restyle then costs nothing visible: the keyboard is still. The
    commit is the keyboard's final geometry, so it bypasses the Safari
    [settle window](#keyboard-open-settle-window): after the WebView resize
    the frame shrinks with the editor focused, and a commit held there for two
    frames let the residual start from the old layout — the composer dipped,
    then the frame landed under the glide and flung it ~290px up before it
    settled.
  - **A keyboard that covers less commits at once.** Closing (or a shorter
    keyboard) publishes the frame immediately — the closed layout is projected
    from the largest keyboard-closed layout seen at this width while the
    plugin still has the WebView at the keyboard's size (up to 1 s, released by
    its resize) — and the riders glide from where they were. The restyle is
    paid inside that event (the ride reads the new layout synchronously), so
    the glide starts on the next frame and is never advanced into the stall:
    it trails the keyboard by the stall rather than jumping.
  - **Only composer docks ride.** A Settings, navigator or module field takes
    the frame at once, as before: those layers anchor to the frame variables.
    Reduced motion (OS or in-app) never rides.
  - **Layers are primed.** A layer created when its animation starts is
    painted first and shows the ride late, so a touch or focus on a docked
    composer marks the dock and its transcript `data-keyboard-rider`
    (`will-change: transform`) until no keyboard ride can follow (1.5 s idle,
    not while the composer holds focus).

  A long draft's editor is capped at 18% of the band while the native keyboard
  drives the frame: the Composer publishes the band the keyboard leaves on its
  own root as `--composer-band` (restyling only the composer, at the start of
  the slide), and the cap eases there on the keyboard's curve. As `18dvh` the
  cap only shrank when the deferred WebView resize landed (~11px on a Pro Max,
  ~50px on an SE); as a root variable it would wait for the commit. Where the
  WebView resizes with the keyboard (Android) the band is the dvh it replaces.
  A dock that mounts behind an open keyboard settles with
  `animation-duration: 0s`; its entrance is never switched off by name, because
  restoring the name on close replayed it (the composer faded in from nothing
  on every keyboard close). The composer's resting row ⇄ engaged card switch
  eases on the keyboard's curve (`composerMorph.ts`, `data-composer-morph`,
  content held at the card's bottom edge, so the ride moving the dock never
  conflicts with it) and must end where the card settles. Build 17 on the
  device ended ~10px taller and snapped back: the morph measured its end while
  the editor still had the resting row's 46px height (the auto-grow was a
  passive effect), and the model line (`.composer-config`, `flex: 1 1 auto`)
  absorbed the difference. Now the auto-grow is a layout effect declared
  before the morph, the rows are frozen while the edge rises, and a row that
  changes mid-way (the band turning short at `keyboardWillShow`, a late
  render) re-aims the morph (`hostComposerMorphKeyboard.test.ts` in Chromium,
  `composerMorphEditorHeight.test.ts` on the mounted Composer). The one row
  that is not frozen is the editor (`.composer-input`, `overflow: clip`): it
  opens between the model line, which holds the rising top edge, and the rail
  at the bottom one. Held at the bottom edge with everything else, the model
  line slid ~25px down against the top edge after it had come into view. The
  morph counts the editor at its content's size and watches its content, not
  its box; the model line stays transparent while the card is too short to
  hold it at the top and fades in in place, on an opacity animation with the
  morph's id and timing so a reported keyboard curve re-times both alike.
  Resting runs the same morph backwards on the engaged rows (the row is
  presented only in the morph's `finish` frame; see `docs/dev/ui.md`), so the
  rest morph's opacity, control and editor glides carry the same id and
  follow a reported keyboard-hide curve too. The editor glide moves the
  editor's box, so the settled-height measurement subtracts its translation
  (it overshot the card by ~10px and snapped back), and the editor row is
  still recognised as the opening row while it stops clipping.

  The tokens (`--motion-keyboard`, 250 ms on one bezier) are only the
  fallback: UIKit moves the keyboard on a private spring (curve 7) whose real
  length differs from its nominal 0.25 s. The iOS app's `PolythKeyboardMotion`
  plugin (`SceneDelegate.swift`) replays that curve on an invisible probe view
  with every `keyboardWillChangeFrame`, reads back the Core Animation (spring
  mass/stiffness/damping or bezier, real duration) and sends it with a
  wall-clock `sentAt`. `apps/mobile/src/keyboardMotion.ts` keeps only plain
  numbers; `setNativeKeyboardMotion` → `apps/web/src/keyboardMotion.ts` keeps
  the timing in memory (spring sampled into a CSS `linear()`; skipped where
  `linear()` is unsupported) for `keyboardMotion()` (`motionPresence.ts`). It
  used to write the two tokens inline on `<html>` — a whole-app restyle at the
  moment the keyboard set off. Running rides are re-sampled to the reported
  curve (`retimeKeyboardRide`), and `syncKeyboardRiders` re-times the composer
  morph (id `keyboard-ride`) and the editor cap's `max-height` transition —
  again on the next frame, for riders React starts after the event — and both
  catch up with the keyboard's travel since `sentAt` (≤ 1 s), whether the
  report lands before or after the inset. Chromium-scrubbed in
  `nativeKeyboardMotion.test.ts` (the ride glued to a fake keyboard, the
  transcript's tail glued to the composer, no frame movement before the
  commit, no jump at the commit, the closing glide, a 500 ms spring reported
  40 ms late, a non-dock field), `hostComposerMorphKeyboard.test.ts` and
  `mobileViewportResume.test.ts`. `composerKeyboardMorphRide.test.ts` drives
  the real Composer through the whole path — the resting row, a tap that
  engages the card while it rides the keyboard, every frame of the WebView
  resize, and a tap on the transcript that rests it as a row again where it
  started: the card keeping its rows while it shrinks, the model line gone
  before the row is presented, Add, Send and the placeholder travelling
  between their row and card places both ways so neither presentation moves
  them, and a re-tap half-way through a rest resuming from where everything
  is. Its scrub pauses only running animations
  (re-scrubbing a finished dock entrance replays it) and finishes the
  scrubbed set itself: a paused animation scrubbed to its end drops out of
  `document.getAnimations()`, so its `finish` — which presents the row — would
  never fire. Measured on the real app in Chromium (a
  60-turn chat, 1× CPU, emulated native keyboard): before, the keyboard-open
  handler held the main thread ~270 ms (two whole-app restyles) and the
  composer stayed behind the rising keyboard until it popped up; after, no
  task during the slide is longer than the focus re-render (~35 ms), and the
  ride's clock matches the keyboard's to 0.3 ms on every frame. Not
  device-verified.
- New-chat and conversation docks reserve the home-indicator safe area once.
  When the keyboard is open, retain only their existing optical spacing. A
  hidden short-band hero body must not remove the new-chat dock's bottom anchor.
- The existing HTML canvas remains the wallpaper/system-bar fallback owner when
  the measured app frame is shorter than the document viewport. Do not move it
  into a negative-z-index pseudo-element or make the HTML canvas transparent
  (the band layer below only paints over it; the canvas stays opaque):
  Safari/WebKit may then expose an unpainted black/white native canvas. Mobile
  body/app surfaces remain transparent so the selected root wallpaper shows
  through without duplicate independently scaled images.
  A root background **image** paints inside the root box only; whatever the
  canvas covers outside it falls back to the flat `background-color`
  (`--app-system-bar-color`). With the keyboard open the measured frame ends
  above the page area the OS still leaves to the page (WebKit's accessory band
  sits below the reported visual viewport), so that band used to paint a flat
  tint instead of the wallpaper — reported as a strip under the composer while
  typing. `background-attachment: fixed` is not a fix: iOS WebKit ignores it,
  so the strip survived an earlier Chromium-only fix. The compact frame instead
  adds one decorative `html::before` layer (compact shells, in `styles.css`
  next to the root wallpaper rules) that
  repaints the root's own wallpaper (`background: inherit`) over a static
  large-viewport box (`top: 0`, `100lvh`, fixed, `z-index: -1`, no pointer
  events). The keyboard never resizes that box, so the band shows the
  wallpaper and the image does not rescale when the keyboard opens. This is
  an extra painter, not a move: the HTML canvas keeps both its colour and its
  image underneath, so the earlier failure (transparent canvas exposing an
  unpainted native canvas) cannot recur. `mobileViewportFrame.test.ts` pins
  the painted band and the flat fallback without the layer with real pixels in
  Chromium. Whether WebKit paints a fixed layer in that band is
  **source-reasoned, not device-verified**.
- Device evidence (iOS 26 Safari, 2026-10-08, with that layer shipped): the
  strip persisted, as a full-width band of exactly the flat system-bar colour
  from the end of the extended frame down to the keyboard (≈94 CSS px under
  Safari's floating address bar and form assistant; Signal Bloom light,
  `#dcebe7` against a lilac wallpaper). The band lies past the end of the
  document, where Safari fills with the root's flat `background-color` and no
  page layer paints. Only a colour can go there, so while the published frame
  is a keyboard frame (`html[data-keyboard-frame="open"]`; a rule on `<html>`
  keyed on the body's keyboard state restyled every element) the compact root
  colour becomes the wallpaper's own bottom-edge tone, tinted like the image
  above it:
  `color-mix(in srgb, var(--bg) 76%, var(--app-background-edge-color))`.
  `backgrounds.ts` publishes that variable from each preset's measured `edge`
  (the image's average over the bottom 120px of a 430×932 frame — re-measure
  when an image changes; a theme-following preset has one per appearance's
  art) and samples a custom image's bottom rows at runtime;
  until a sample exists the band falls back to `--bg`. The closed state keeps
  the system-bar colour, which the status-bar strip uses. That the band
  follows the root colour is inferred from the device capture, not from a
  WebKit trace; confirm on the next device check.
- Do not use screen-height guesses or hardcoded status-bar sizes to substitute a
  flat strip for the selected image. `--app-system-bar-color` and the
  theme-color meta remain the fallback for browser/OS-owned chrome.

## Restyle cost

`<html>` and `<body>` hold the theme's ~260 custom properties, so a style
change on them that touches anything inherited restyles every element of the
app — measured on a 60-turn chat in Chromium (9,000 elements, 1× CPU) at
~260 ms per change: writing a custom property on `<html>`, an
`html:has(body[…])` rule changing one, a root background colour, an inherited
property (`user-select`, `cursor`) set on them. Attribute flips that only
descendant rules react to cost ~1–3 ms. That is why a publish has two halves
(*Following the native keyboard*): the body attributes are the cheap keyboard
state, the root variables, `html[data-keyboard-frame]` and the chain heights
are the expensive frame, written in one batch and only when the frame moved.
"Moved" compares every value the batch writes (top, height, layer edge,
`--visual-vh`, `--keyboard-inset`): a value left out of the comparison is never
rewritten while the others hold still. `--visual-offset`, the `top` of every
sheet and dialog, is therefore the frame's own top (an alias of
`--visual-frame-top`), not the raw `visualViewport.offsetTop`. iOS can report a
closing keyboard's full height while its pan is still at the old offset and
only then scroll back to 0. The raw offset written with the first event
outlived the keyboard, and every sheet opened a keyboard height down the
screen until the next keyboard.
Nothing in `mobileViewport.css` or `styles.css` may key an `html`/`body`
subject on the body's keyboard attributes (`nativeKeyboardMotion.test.ts`).
The general rules are in `docs/dev/styles.md`, *Motion and restyle cost*.

## Short viewports

A height media query whose result flips makes the engine rebuild its rule sets
(fonts, keyframes, registered properties) and lay out every box again: on the
same chat, a viewport resize from 844 to 508 px took 358 ms of layout with the
short-height queries in place and 6 ms without. A portrait phone's keyboard
crosses 560 px every time, so the short-viewport rules are not media queries:
`SHORT_VIEWPORT_QUERIES` in `mobileViewport.ts` evaluates the same conditions
with `matchMedia` (same answers, same moment) and publishes them as
`body[data-viewport-short]` tokens — `"560"` for `(max-height: 560px)`,
`"560-compact"` for `(max-height: 560px) and (max-width: 480px),
(max-height: 480px) and (pointer: coarse)` — which `styles.css` and packages
use through `:where(body[data-viewport-short~="…"])`, keeping each rule's
specificity. Pointer-fine refinements stay media queries (no keyboard resizes
a mouse viewport). The Connection Hub's short-screen rule ships in the same
stylesheet and is published by `ConnectionScreen.tsx` as
`body[data-connect-short]`. The transcript's top/bottom runways
(`--timeline-pad-top`, `--timeline-visible-top-inset`, `--timeline-pad-bottom`)
are registered non-inherited, so a token flip does not restyle the rows.
`keyboardMediaQueries.test.ts` evaluates every media query list in the CSS on
four portrait phones before and after a keyboard takes its height and fails
on any flip. An iPad in landscape still flips the compact-shell queries
(`(max-height: 480px) and (pointer: coarse)`) when its keyboard opens — the
shell turns into the phone layout while typing; a separate decision.

## Keyboard-open settle window

Safari can dispatch the keyboard resize (`visualViewport.height` shrinks) and
the pan that reveals a focused composer above it (`visualViewport.offsetTop`
moves) as two separate events, not one. Publishing the resize alone —
`offsetTop` still at its pre-pan value — undershoots `--visual-frame-bottom`
and briefly exposes the canvas below the composer, reported as the composer
"jumping" too high right as the keyboard opens.

Growing the frame is always safe (more coverage cannot expose the canvas), so
only a **shrink** publishes immediately. A shrink while `covering` is true and
a text entry is focused — the one precondition Safari's pan-to-reveal needs —
is held in `publish()` (`mobileViewport.ts`) for up to two frames, the same
"let geometry settle" idiom `dismissKeyboard()` already uses, so a same-window
offset update lands in the same publish instead of painting one frame too
high first. A ridden native keyboard's landing commit (`settleRide`) is
never held: it is the keyboard's final geometry, not half of a resize/pan
pair. The forced retry after those two frames always applies, so an
engine that never pans (no focused input, or a resize-only engine) still
shrinks immediately — `mobileViewportResume.test.ts` pins both the hold and
the eventual apply with fake `resize`/`scroll` events and a real timer wait.
This is reasoned from the code and the documented two-event Safari behavior
above, not yet confirmed against a fresh installed-iOS keyboard-open capture;
treat it the same as the rest of this file's device-acceptance items below.

Anchored phone pickers (`Picker`, the model picker, the composer Add menu,
the approval level switch in `packages/permissions`) never measure their
anchor under a keyboard that is about to close: they `dismissKeyboard()` and
open after it resolves. `approvalLevelPhone.test.ts` pins the deferred open.
(The iPhone report of the approval switch "near the top of the screen" that
first motivated this turned out to be the pan-offset anchor bug described
under *Anchor coordinates under a pan* below.)

**Keep-keyboard surfaces.** A surface marked `data-keep-keyboard` (the
composer; the terminal's touch chrome and hidden input, see
[terminal.md](terminal.md)) keeps the keyboard open instead. A touch/pen tap
on it, or on a popover it opened, cancels the compatibility `mousedown` that
would move focus (text fields excepted). While that tap holds the editor,
`dismissKeyboard()` is a no-op and overlay focus moves
(`focusUnlessKeyboardHeld()`: Menu first item, Popover `initialFocus`,
return-to-trigger) are skipped. The keyboard
then never changes under the measured surface, and the picker anchors above
the composer in the keyboard-open band. `composerKeepKeyboard.test.ts` pins
this in happy-dom; it has not yet been checked on a real iOS/Android
keyboard. A modal that opens from the composer's flow normally claims focus
and inerts the page behind it, which blurs the editor and closes the
keyboard. `confirmAlert(..., { keepKeyboard: true })` propagates through
`Dialog`/`useModalSurface`, which then skips both the initial focus and the
inert pass on the backdrop's siblings for the subtree holding the held
editor; the Full access confirmation is the only alert that opts in
(`alertKeepKeyboard.test.ts`).

**Anchor coordinates under a pan.** Anchored surfaces are `position: fixed`
(layout-viewport coordinates) but measure their anchor with
`getBoundingClientRect()`. An iPhone screenshot with the keyboard held open
showed the composer's approval switch ≈250px above its button — one Safari
pan offset — so iOS WebKit evidently reports client rects against the panned
band there, not the layout viewport. Dismissing the keyboard first had only
hidden this (no pan, no offset). `useAnchoredPosition` now keeps an invisible
fixed probe at `0,0` beside the surface and subtracts its client position from
the anchor rect, so the result is right whichever space the engine reports;
in Chromium the probe sits at `0,0` and nothing changes. Pinned in
`modelPickerStabilize.test.ts` with a stubbed −250px origin; the WebKit
coordinate behavior is inferred from the screenshot, not device-measured.

## Full-height layers

Settings, the phone navigator, the module/rail/panel layers and the narrow
drawer are `position: fixed`, so they are laid out against the **layout**
viewport, but with the keyboard open the user sees only the visual band. Safari
keeps the layout tall and pans the band inside it to reveal a focused field, so
a layer pinned to `top: 0` — or sized by `--visual-vh` from there, which is what
Settings and the navigator did — slides away with its header, and the chat shows
through below it ("settings is somewhere at the top, part of the chat above the
keyboard"). A native-resize WebView (the Capacitor app,
`KeyboardResize.Native`) instead shrinks the layout itself *and* publishes
`--keyboard-inset`, so a layer that also pads by that inset subtracts the
keyboard twice: the module layers measured a 9% scroll area there.
`--keyboard-inset` means "layout left below the band" in one engine and "native
keyboard height" in the other; it is not a keyboard height a layer may subtract.

The frame variables are correct in both models, so the contract is:

- **Keyboard open** (`body[data-keyboard="open"]`): each layer takes the band
  outright — `top: var(--visual-frame-top)`, bottom at `--layer-frame-bottom`.
  That is `--visual-frame-bottom`, plus `--keyboard-accessory-band` on WebKit,
  i.e. the edge the app chain above already ends on. Sharing it is the point: a
  layer that stopped short would show the bottom of the composer in the
  accessory band. `tokens.css` holds the default; `mobileViewport.ts`
  publishes it, band included, with the rest of the frame.
- **Keyboard closed**: untouched. `inset: 0` is the one box that reaches the
  physical screen edge no measurement can, which is the same reason the
  installed-app `100vh` fill exists.
- Module, rail and panel layers keep their `--keyboard-inset` bottom clearance
  for the closed state only; with the keyboard open the layer already ends at the
  band, so the clearance is `0`. Their top clearance for the shell header becomes
  whatever part of that header is still inside the band — a panned band has
  scrolled it away, but the status bar and notch stay at the physical top, so
  `--safe-top` is the floor.
- A bottom sheet that holds a search field (the widget catalog) takes the band's
  *bottom* edge instead of its top: `bottom: calc(100% - var(--layer-frame-bottom))`.
  A percentage `bottom` resolves against the containing block's height, so that
  is the hidden remainder below the band in a Safari pan and `0` in a WebView
  whose layout already ended at the keyboard, without knowing which engine this
  is. Its height is capped to the band. Transient bottom-pinned chrome without a
  field (the error banner, the quick-background trigger) is not moved and can
  still sit behind the keyboard in a pan; that is a separate decision.
- `mobileFieldReveal.ts` finishes the job. Safari's pan reveals a focused field
  *before* the layer shrinks, so the shrink can leave it below its scroll
  container with nothing left to bring it back. After a covering frame change
  with a text entry focused, `mobileViewport.ts` scrolls the field into view one
  frame later, coalesced and only on a real geometry change so the user's own
  scrolling is never pulled back. Only `overflow-y: auto | scroll` boxes move;
  `hidden`/`clip` boxes are layout clips, and shifting one is how a shell ends
  up permanently offset.
- A new full-viewport `position: fixed` layer must pick a side.
  `mobileViewportLayers.test.ts` lists every shell rule that pins a box to the
  whole viewport height; add the layer to the band block and to `BAND_ANCHORED`,
  or to `EXEMPT` with the reason it holds no input. Package and native-shell
  sheets are outside that scan: packages open dialogs and sheets through the
  shared primitives, which already anchor to the band.

`.app-shell` is `container: app-shell / inline-size`. Chromium does not make a
query container the containing block of its fixed descendants; WebKit applies
layout containment to one, so there the layers may resolve against `.app-shell`
instead of the viewport. `.app-shell` starts at the document origin and ends at
the app frame, so `top: var(--visual-frame-top)` with an explicit height is the
same box either way, and the layer test runs both (`contain: layout` stands in
for WebKit's behavior).

## Resume lifecycle

`startMobileViewport()` also remeasures on `pageshow` and on a transition to
`document.visibilityState === "visible"`. A restored or suspended PWA must
not retain an old keyboard-sized frame or Safari pan offset while waiting
for a resize event that may not arrive. Hidden visibility transitions do not
publish transient geometry. Resume itself is detected from real events only —
there is no polling timer, second viewport cache, screen-size guess, or
forced page reload; the bounded two-frame settle a shrinking publish can take
(above) is a one-shot retry of the same event-driven measurement, not a
resume-detection mechanism.

The isolated `mobileViewportResume.test.ts` tests execute that measurement
module with fake window/document/visualViewport event targets. They cover
resume without resize, hidden-to-visible transitions, stale pan offsets,
missing visualViewport, repeated startup/events, a reduced iOS `innerHeight`
against the full layout viewport, a keyboard hidden behind the dvh band
(``100vh`` probe), existing native keyboard updates, and the keyboard-open
settle window (a held shrink that a same-window offset update corrects before
it ever paints, and a held shrink that still applies once no offset update
arrives). They do not render React or emulate an installed iOS WebView. The
floating-toolbar and installed-PWA strip this closed-state measurement fixes
is device-dependent: `clientHeight` arithmetic is covered by the fake
targets, but only a fresh installed-device launch can confirm the strip
itself.

## Verification

```sh
POLYTH_CHROMIUM_PATH=/usr/bin/chromium POLYTH_REQUIRE_CHROMIUM=1 \
  node --experimental-strip-types --test apps/web/test/mobileViewportFrame.test.ts
POLYTH_CHROMIUM_PATH=/usr/bin/chromium POLYTH_REQUIRE_CHROMIUM=1 \
  node --experimental-strip-types --test apps/web/test/mobileViewportLayers.test.ts
node --experimental-strip-types --test apps/web/test/mobileViewportResume.test.ts
# Following the native keyboard: the ride, the commit, the composer morph.
POLYTH_CHROMIUM_PATH=/usr/bin/chromium POLYTH_REQUIRE_CHROMIUM=1 \
  node --experimental-strip-types --test apps/web/test/nativeKeyboardMotion.test.ts \
  packages/browser/test/hostComposerMorphKeyboard.test.ts \
  apps/web/test/keyboardMediaQueries.test.ts apps/web/test/composerKeyboardMorphRide.test.ts
node --experimental-strip-types --test apps/web/test/composerMorph.test.ts \
  apps/web/test/composerMorphEditorHeight.test.ts apps/web/test/keyboardRide.test.ts \
  apps/web/test/keyboardMotion.test.ts
```

`mobileViewportLayers.test.ts` renders seven full-height layer families (both
Settings stages, the phone navigator, main module view, fullscreen rail pane,
panel sheet, narrow drawer), plus the bottom-anchored widget catalog sheet and
Settings as a centred tablet modal, with the real cascade and the variables
`publish()` writes for a Safari pan (partway, to the layout bottom, none), a
native-resize WebView and a closed keyboard. It crosses that with the WebKit
accessory guard and the contained `.app-shell`. For each family it asserts that the
layer starts at the band top, ends where `#root` ends, answers hit tests at both
ends of the band, keeps its header and a usable scroll area inside the band,
leaves the last field reachable, and that the closed state is still the plain
`inset: 0` box. Separate cases pin the field reveal (including that an
`overflow: hidden` box is never scrolled) and the classification of full-height
fixed rules. All of that is **Chromium** with emulated engine models: it is not
WebKit, and the Safari pan and native-resize geometry come from the published
variables, not from a keyboard.

The frame test loads the real shell, token, composer, and final viewport styles.
It checks both chat states, mismatched CSS/measured heights, panned and
resized keyboard bands, close/restore, landscape, hit-testing, single safe-area
clearance, matching bounded root/app frames, HTML-root wallpaper ownership, and unaffected desktop/Electron. It
samples real pixels for the exposed band below a keyboard-short frame: the band
must paint the selected wallpaper, and the same fixture with the `html::before`
wallpaper layer hidden must not, so the test fails if the layer is dropped. It
checks that the root colour is the system-bar tint with the keyboard closed and
the tinted wallpaper edge tone (or `--bg` without one) with it open. It runs the open-keyboard
frame through both sides of the WebKit accessory guard (measured frame outside
it, measured frame plus the band inside it) and checks that a zero band restores
the plain measured frame. It
also activates the existing standalone/WebKit CSS guards in Chromium to check
cascade precedence. That is **not** WebKit or installed-iPhone testing.

For device acceptance, inspect a fresh installed iOS launch, keyboard
open/close, rotation and background/resume in light/dark themes with preset
and custom backgrounds. Record `innerHeight`, visual-viewport height/offset,
app/composer rectangles and safe insets. For the full-height layers, focus a
field low on a long Settings page, a module field, and the navigator search with
the keyboard up, in the installed web app and in the Capacitor app: the header
stays at the top of what is visible, nothing but the layer shows above the
keyboard, the focused field is visible, and closing the keyboard restores the
full-screen layer without a jump. Also record whether `.app-shell` contains
fixed descendants in WebKit (a layer rect against `.app-shell`'s). An OS-owned strip outside the WebView
cannot be validated or painted by a DOM fixture; do not mark it device-fixed
based solely on browser tests or a CSS-string assertion.
