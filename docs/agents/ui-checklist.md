# UI acceptance and design maintenance

Use this as a scenario selector, not a requirement to test every screen for every CSS change. Verify the states affected by the diff and representative shared surfaces when primitives change. Current canonical tokens and preferences are the styling authority; this document intentionally contains no duplicate token table.

## Before editing

Identify the owning surface, user action, current failure and desired visible result. Determine whether it is package content or host geometry. Inspect existing primitives and settings hooks before creating new components. Keep compact visuals, restrained materials and clear hierarchy without shrinking hit targets or hiding state.

## Behavioral states

Check empty/loading/ready/error/disabled, pending/cancelled/completed actions, long labels, long model names, translated text, large counts and missing optional providers. Distinguish unsupported from unavailable and from loading. Avoid displaying stale previous-session results as if current.

For buttons: a disabled button is gray at rest and answers no hover, press or tap; a filled, selected or pressed button keeps its color under the pointer; and nothing stays highlighted after a tap on touch ("Buttons" in `docs/dev/design-system.md`, pinned by `apps/web/test/buttonStates.test.ts`).

For inputs/composer: focus, selection, paste, file picker, Enter versus multiline behavior, keyboard open/close, queued-message affordances and send/stop transitions. Input methods must not accidentally submit while composing text. For menus/sheets: keyboard traversal, escape/back, focus return, pointer dismissal and nested overlay behavior. A tooltip is not the only accessible label.

For phone pickers: confirm the surface opens as a compact anchored Quiet Glass popover beside the trigger (finger-travel zone), not a full-bleed bottom sheet; verify safe-area/visual-viewport placement, transparency/low-resource opaque fallback, and that search/filter inputs do not autofocus on open. Destination browse surfaces (CommandPalette, SessionSearch, StarterPicker, tall forms) should still use sheets.

For widgets/package windows: small container, resizes, two instances, pinned/dynamic/fullscreen state as supported by current host, package disable/re-enable and persisted layout. Features must not own duplicate global window shells. On phone also check the layer stack (`docs/dev/ui.md` "Phone layer stack"): open from the Workspace and from Chat (Tools resume), Back lands on the Workspace and stays, Close/Escape/session switch dismiss to Chat, a second tap on Back, native Back and the edge swipe, reopening a kept-alive package, RTL and reduced motion. Package content that drags or swipes horizontally must either be a scroller, use `touch-action: none`, or carry `data-owns-swipe`/`data-no-edge-swipe`, so the surface-wide Back swipe leaves it alone (`docs/dev/ui.md` "Phone shell swipes"). For long timelines: scrolling, selection/copy and asynchronous streaming without forced jumps.

## Visual and preference states

Exercise the affected narrow/wide viewport or container, light/dark theme, density/font/radius settings, reduced motion, transparency/resource settings and high-contrast needs. Glass must retain a readable fallback. A subtle fade/mask must begin at the actual overlapping chrome and not conceal neighboring useful content or intercept gestures.

Safe-area, keyboard and viewport calculations belong to established host/native seams. Avoid fixed magic offsets or `100vh` patches without inspecting the visual viewport behavior. Check horizontal overflow and usable touch hit areas separately from how small the icon looks.

## Evidence

Record route/state, viewport, theme/preferences, platform and a before/after observation. Actual screenshots are useful for geometry but do not prove keyboard/gesture/accessibility behavior. Automated DOM tests are useful for interaction but do not prove platform rendering. Without browser/device access report the unverified layers and provide the exact reproducible scenario; never substitute a generated mock image as implementation evidence.
