# UI acceptance and design maintenance

Use this as a scenario selector, not a requirement to test every screen for every CSS change. Verify the states affected by the diff and representative shared surfaces when primitives change. Current canonical tokens and preferences are the styling authority; this document intentionally contains no duplicate token table.

## Before editing

Identify the owning surface, user action, current failure and desired visible result. Determine whether it is package content or host geometry. Inspect existing primitives and settings hooks before creating new components. Keep compact visuals, restrained materials and clear hierarchy without shrinking hit targets or hiding state.

## Behavioral states

Check empty/loading/ready/error/disabled, pending/cancelled/completed actions, long labels, long model names, translated text, large counts and missing optional providers. Distinguish unsupported from unavailable and from loading. Avoid displaying stale previous-session results as if current.

For inputs/composer: focus, selection, paste, file picker, Enter versus multiline behavior, keyboard open/close, queued-message affordances and send/stop transitions. Input methods must not accidentally submit while composing text. For menus/sheets: keyboard traversal, escape/back, focus return, pointer dismissal and nested overlay behavior. A tooltip is not the only accessible label.

For widgets/package windows: small container, resizes, two instances, pinned/dynamic/fullscreen state as supported by current host, package disable/re-enable and persisted layout. Features must not own duplicate global window shells. For long timelines: scrolling, selection/copy and asynchronous streaming without forced jumps.

## Visual and preference states

Exercise the affected narrow/wide viewport or container, light/dark theme, density/font/radius settings, reduced motion, transparency/resource settings and high-contrast needs. Glass must retain a readable fallback. A subtle fade/mask must begin at the actual overlapping chrome and not conceal neighboring useful content or intercept gestures.

Safe-area, keyboard and viewport calculations belong to established host/native seams. Avoid fixed magic offsets or `100vh` patches without inspecting the visual viewport behavior. Check horizontal overflow and usable touch hit areas separately from how small the icon looks.

## Evidence

Record route/state, viewport, theme/preferences, platform and a before/after observation. Actual screenshots are useful for geometry but do not prove keyboard/gesture/accessibility behavior. Automated DOM tests are useful for interaction but do not prove platform rendering. Without browser/device access report the unverified layers and provide the exact reproducible scenario; never substitute a generated mock image as implementation evidence.
