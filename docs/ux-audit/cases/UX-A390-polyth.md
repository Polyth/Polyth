# UX-A390 — polyth responsive shell audit

## Result

**Status: specified. P0 failure reproduced.**

polyth 1.19.0 is usable at 1440, 1024, and 768 CSS px, but its desktop shell does not recompose when a mouse/keyboard browser window narrows to 390 or 320 px. The persisted 280 px session sidebar and right tool rail stay inline. The remaining chat canvas is clipped by overflow containment: there is no horizontal scrollbar, the composer collapses to 14 px, and Send is outside the viewport. Keyboard users can recover by collapsing the session sidebar, but the first render is not viable.

No product files were changed.

## Runtime and procedure

- Runtime: polyth `1.19.0`, source revision `7a2e0ee138fe8a13f4dd65090fcf915a2692356f`, served at the isolated URL recorded in `docs/ux-audit/RUNTIME-BASELINE.md`.
- Browser: Google Chrome stable against the live runtime, not a static fixture.
- Viewports: `1440×900`, `1024×900`, `768×900`, `390×900`, and `320×900`.
- Zoom: actual Chrome 200% zoom in a `1442×902` outer window; the content viewport changed from `1434×811` to `717×406`, and DPR doubled from `0.984375` to `1.96875`.
- Preferences/input: `prefers-reduced-motion: reduce`; keyboard-only Tab, Enter, and Escape paths.
- States: existing-session happy path, project-aware empty session, persisted-open narrow shell, narrow recovery, and the project chooser recovery path.
- Runtime health remained ready and the responsive run recorded no console errors, page errors, or failed requests.

## Matrix

| Condition | Observed shell behavior | Result |
|---|---|---|
| 1440 | Header, 280 px session rail, chat/composer, work-status card, right rail, and sidebar footer remain visible. Composer is 694 px wide; Send ends at x=1025. | Pass |
| 1024 | Primary regions remain visible. Composer is 624 px wide; Send ends at x=943. | Pass |
| 768 | Primary regions remain visible. Composer is 384 px wide; Send ends at x=695. | Pass |
| 390, sidebar open | Main title fragments into a narrow vertical strip. Composer is `14×337.5` px. Send ends at x=483 and starter actions are clipped. The document reports no horizontal overflow, so clipped controls cannot be scrolled into view. | **P0 fail** |
| 320, sidebar open | Main content is almost entirely absent. Composer is `14×1147.5` px; Send ends at x=470; the work-status toggle ends at x=336. | **P0 fail** |
| 390, keyboard recovery | First Tab reaches Open sessions; Enter collapses the rail. Composer expands to 294 px and Send ends at x=321. | Pass after manual recovery |
| 320, keyboard recovery | Collapsing the rail expands the composer to 224 px; Send ends at x=238 and the work-status toggle ends at x=304. | Pass after manual recovery |
| 200% zoom | Effective content viewport is `717×406`. The inline session rail leaves the hero cropped; only the leading composer action was measurable in-view while Send was absent. Document width still equals client width, so the loss is clipping, not scrollable overflow. | **P0 fail** |

## Findings

### UX-A390-01 — Inline desktop rails consume the narrow canvas

Severity: **P0**

At 390 px, the 280 px session sidebar remains inline and the right tool rail remains docked. The chat region receives only a sliver of width. At 320 px, even the top-right work-status control is partially clipped. The sidebar footer remains visible, but that does not compensate for the inaccessible primary task surface.

This is sensitive to pointer type, not only viewport width. Post-observation source review found:

- `packages/ui/src/lib/device.ts` classifies a width at or below 768 px as mobile only when touch input is also present. A narrow mouse/keyboard browser therefore keeps the desktop tree.
- `packages/ui/src/components/layout/MainLayout.tsx` keeps `Sidebar`, chat, context panel, and rail as inline desktop siblings in that tree.
- `packages/ui/src/components/layout/Sidebar.tsx` enforces a 280 px minimum width.
- `packages/ui/src/stores/useUIStore.ts` defaults and persists the sidebar as open.

The failure is therefore deterministic for a narrow desktop window, split-screen use, or high browser zoom when the sidebar was left open.

### UX-A390-02 — Reduced motion does not remove the rail transition

Severity: **P1**

The reduced-motion media query matched, but keyboard collapse followed the same interpolation as no preference:

| Elapsed | Reduced motion x / width | No preference x / width |
|---:|---:|---:|
| 0 ms | 294 / 15.6 | 294 / 15.6 |
| 16 ms | 198.1 / 91.8 | 197.7 / 92.1 |
| 50 ms | 79.8 / 163.8 | 79.7 / 163.8 |
| 150 ms | 14.2 / 163.8 | 14.9 / 163.8 |
| 300 ms | 14 / 163.8 | 14 / 163.8 |

`Sidebar.tsx` includes a reduced-motion utility class, but also supplies the 200 ms transition duration inline. The measured behavior confirms that the effective transition is not removed.

### UX-A390-03 — Existing-session row has a dead duplicate tab stop

Severity: **P1**

The happy path is possible, but the session row exposes two consecutive focus targets with the same accessible name:

1. Tab 13 reaches a `DIV` named “Runtime Baseline”; Enter does nothing.
2. Tab 14 reaches the nested `BUTTON` with the same name; Enter opens the session.

New session is reachable in four Tabs and activates with Enter. Escape dismisses the project chooser. The narrow-shell recovery toggle is the first Tab stop and activates with Enter.

## Required responsive-shell contract

1. At `<=390` CSS px, and whenever desktop zoom produces the same effective width, the session sidebar must be an overlay/drawer or closed by default. It must not consume chat layout width.
2. Persisted wide-layout rail state must not force the unsafe narrow arrangement. Preserve the preference for restoration when width returns, but enter narrow mode safely.
3. Header title/actions, project/branch selectors, composer input, attachment, Send, right rail, and footer controls must remain fully inside the viewport at 390 and 320 px.
4. The composer must retain a usable text area. Secondary actions may wrap, condense, or move into an overflow menu; attachment and Send remain directly operable.
5. Right-side panels must overlay or replace the narrow chat surface rather than subtracting another fixed inline width.
6. Do not treat `scrollWidth === clientWidth` as proof of fit. Acceptance checks must assert key control bounding boxes and minimum composer width.
7. Under reduced motion, rail/drawer open and close must settle within one rendered frame without positional interpolation.
8. A session row must expose one activation target. Enter and Space on that target must open it without a duplicate inert stop.

## Acceptance checks for the Polyth comparison

- Repeat the exact viewport and actual-zoom matrix with the session rail initially open.
- Verify both empty and loaded-session composers, including a multiline prompt and the disabled/enabled Send states.
- Verify keyboard-only open, close, session selection, composer focus, and recovery from an open panel.
- Verify the 390-to-768 and 768-to-390 resize transitions without reload so persisted state cannot reintroduce clipping.
- Verify reduced-motion geometry at 0, 16, 50, 150, and 300 ms.
- Fail the gate if any required control intersects a viewport edge, if the composer falls below its specified minimum, or if hidden overflow is the only reason document width appears valid.

## Sanitized evidence

Evidence is intentionally outside the repository:

- `/opt/cursor/artifacts/polyth_ux_a390_audit_v2_sol_58a2.json`
- `/opt/cursor/artifacts/polyth_ux_a390_1440_empty_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_390_empty_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_320_empty_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_390_recovery_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_320_recovery_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_actual_200pct_v3_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_ux_a390_actual_200pct_metrics_v3_sol_58a2.json`

Next stage: `SOL-A390-POLYTH-AUDITOR`.
