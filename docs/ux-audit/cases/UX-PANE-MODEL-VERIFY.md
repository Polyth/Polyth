# UX-PANE-MODEL — SOL verification

- Case: `UX-PANE-MODEL`
- Model / role: `SOL` / verifier
- Target: `fb71bc12fe12bd56b1c4eb88a3865f056c3860e8`
- Status: `review-failed`
- Verified: `2026-08-20`

## Verdict

Do not integrate `fb71bc1`. The automated suite is green and compact
navigation works at `820/768/390/320`, but two P0 live failures violate the
specified safety path:

1. Files can dock while visible composer actions do not win their center hit
   tests, including at `1440×900`.
2. Reloading the canonical session URL with Files open blanks the application
   with React error `#185` (maximum update depth).

The exact draft was synchronously written before the failed reload, so the
draft-flush portion of the target commit works. The open-pane reload crash
prevents acceptance of draft/timeline restoration as a user journey.

## Verification method

The target commit was built and served from `/tmp/wt-pane-model-impl` on an
isolated Polyth runtime at `127.0.0.1:4465`. Google Chrome stable was driven
through `playwright-core`; this subagent did not expose a `computerUse`
executor. The live run switched Files/Git/Terminal/Preview, resized by
keyboard, expanded/collapsed, reloaded, and exercised desktop, tablet, and
phone viewports.

Automated evidence:

- `node --test apps/web/test/workspacePane.test.ts apps/web/test/pane.test.ts apps/web/test/surfaces.test.ts`: `26/26` passed.
- `(cd apps/web && npx tsc --noEmit)`: passed.
- `npm run build:web`: passed.
- `npm test`: `701` passed, `1` skipped, `0` failed.

## P0 findings

### PANE-VERIFY-01 — dock guard accepts covered composer actions

At `1440×900`, Files docked at `674px` beside a `450px` Chat workspace. The
nominal `320px` floor passed, but the center of **Attach files** hit a Model
picker span and the center of **Open focused editor** hit an Agent picker
caret. At `1200×900`, Chat was `354px` and Model/Attach/focused-editor centers
were obstructed. The `1024` and `1000` samples also recorded composer
collisions; `1000` remained docked instead of taking the required full-screen
fallback.

The desktop screenshot visibly shows the picker chips painting over the action
buttons:

- `/opt/cursor/artifacts/pane_model_desktop_1440_sol_run2.png`

`ContextRail` runs `chatDockViable()` before the final dock layout settles.
Its guard key is based on the total workspace width and requested pane width;
the total remains constant when the pane first consumes Chat width, so the
guard is not rerun against the resulting composer geometry.

### PANE-VERIFY-02 — open-pane reload enters a render loop

After typing a fresh draft, opening Files, resizing, expanding/collapsing, and
immediately reloading the canonical session URL:

- `localStorage["polyth.draft.<sessionId>"]` contained the exact draft;
- `document.body.innerText` was empty;
- `.app`, `.rail`, and `.composer` were absent; and
- Chrome emitted React error `#185`.

The guard promotion is self-cancelling: `guardPromoted` makes `mode` become
`"layer"`, then the layout effect clears `guardPromoted` whenever mode is not
`"docked"`. A still-invalid dock is retried and promoted again, producing the
maximum-update-depth loop.

## Passing live checks

- Files/Git/Terminal/Preview switching preserved the same Timeline and Composer
  DOM nodes before reload; inactive kept-alive bodies were hidden, inert, and
  `aria-hidden`.
- Expand made Chat inert and removed it from the accessibility tree; Collapse
  returned to docked mode.
- Keyboard resize changed Files from `674px` to `658px` in one `16px` step.
- At `820`, `768`, `390`, and `320`, Files used the full-screen layer. The
  bottom navigation had exactly five `>=44px` targets and no horizontal page
  scroll. Git/Terminal/Preview switching and Chat return worked at `320`.
- Pane-only interaction left the six-event session log byte-for-byte
  unchanged.
- Phone evidence:
  - `/opt/cursor/artifacts/pane_model_mobile_390_sol_run2.png`
  - `/opt/cursor/artifacts/pane_model_mobile_320_sol_run2.png`

## Required Fable repair

1. Latch a guard-triggered promotion until a real geometry input changes; do
   not clear it merely because its own promotion selected layer mode.
2. Validate the actual post-dock Chat/composer layout after the pane width is
   committed and before pointer input is enabled. Resize/observer callbacks
   must include composer-action geometry, not only the constant Chat+pane sum.
3. Add a live regression that seeds an open Files preference and reloads the
   canonical session URL; assert one app, one Timeline, one Composer, and no
   React error.
4. Add center hit-test gates at `1440/1200/1024/1000/900` with the full
   engineer composer. Assert every visible action hits itself or a descendant
   and that an invalid dock promotes without a render loop.

Next stage: `Fable repair`, then rerun the SOL verifier.
