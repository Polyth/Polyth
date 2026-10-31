# Polyth design system

The concrete contract for building Polyth UI. Use it with `docs/dev/styles.md` for the token catalog and package CSS ownership rules. Shared component code lives in `apps/web/src/components/ui/`; shared component CSS lives in `apps/web/src/styles.css`.

## 1. Visual principles

1. **Calm, typography-first.** Hierarchy comes from type roles and spacing,
   not boxes. Prefer a heading + hairline over a bordered card; prefer a
   quieter variant over a louder one. Accent color is for the primary action
   and active state — at most one primary action per view region.
2. **Minimal borders.** Structural boundaries use `--border`; everything
   decorative steps down (`--border-soft`, `--surface-divider`, `--hair`).
   Interactive controls are the exception: they keep a recognizable
   `--control-border`.
3. **Semantic tokens are the only styling vocabulary.** No hex colors, pixel
   radii, ad-hoc shadows, or magic z-indexes in new CSS. If a needed role is
   missing, add a token, document it in `docs/dev/styles.md`, then use it.
4. **Mobile-first interaction, desktop-first density.** Every interactive
   target is ≥44px on coarse pointers (the `--hit-min` seam does this without
   inflating desktop visuals). Desktop keeps compact 32–40px controls.
5. **Motion is semantic and skippable.** Animations communicate state changes
   (enter/exit, progress) using the `--motion-*` tokens; `prefers-reduced-motion`
   disables them globally (core already enforces this with a wildcard rule).
6. **One implementation per pattern.** A second bespoke button/menu/dialog is
   a bug. Compose the primitives; if they can't express a need, extend them.

## 2. Token roles (quick map)

Full catalog in `docs/dev/styles.md`. The roles new UI reaches for:

| Need | Tokens |
| --- | --- |
| Surfaces | `--bg` (canvas) → `--panel` → `--elevated` → `--raised` (hover/selected); `--sunken`/`--input-bg` (wells, editors); `--overlay-bg/-border/-shadow` (floating surfaces) |
| Selection/hover washes | `--surface-overlay`, `--surface-overlay-hover`, `--surface-overlay-strong` |
| Borders | `--border` (structural) · `--border-soft` (subtle) · `--control-border` (controls) · `--surface-divider` (separator) · `--hair`/`--hair-strong` (hairlines) · `--focus-ring` + `--focus-wash` (focus) |
| Ink | `--text` → `--text-dim` → `--muted` → `--faint`; `--accent-text` for accent-coloured small text (`--accent` is a fill) |
| Signals | `--green/--amber/--red/--blue/--purple` + `--*-wash` surfaces + `--green-on-wash`/`--amber-on-wash` ink |
| Spacing | `--space-1..6` (4/8/12/16/24/32), `--gutter`, `--screen-gutter` |
| Control geometry | `--control-h-sm/-h/-h-lg` (32/40/48), `--control-pad-x(-sm)`, `--control-gap`, `--tap`, `--hit-min` |
| Radius | `--radius-control/card/surface/sheet` (+ `--radius-composer`), all × `--corner-radius-scale` |
| Type | `--ui-font-size` (menu), `--chat-font-size` (conversation), `--header-font-size`, `--subheader-font-size`, `--terminal-font-size`, `--editor-font-size`, semantic `--font-*` roles resolved against `--text-scale`, `--font-input` (16px coarse-pointer floor), `--mono` |
| Icons | `--icon-sm/md/lg/xl` (16/18/20/24) |
| Elevation | `--shadow-sm/md/lg`, `--inset-hi`, `--scrim` |
| Motion | `--motion-fast/normal/surface` + `--motion-ease` |
| Layers | `--z-shell/overlay/toast/popover/tooltip` |

A theme style (`liquid-glass`, macOS 27 — the base style; `fluent`, Windows 11
— the Polyth style; `macos`, macOS Big Sur; `classic`, no recipe) re-binds these
same roles and the `.ui-*` primitives; it adds no vocabulary for new UI, so
code written against the roles above renders correctly in every style. The
style, the colour scheme and the accent are chosen independently, so a style
never assumes one palette. Values and rules: `docs/dev/styles.md` "Theme
layers", "Liquid Glass theme style", "Fluent theme style" and "macOS theme
style".

Deprecated aliases (`--radius`, `--radius-sm/md/lg/xl`, `--surface-*`, `--fg`,
`--danger`, `--warning`, `--success`, `--info`, `--border-subtle`, …) still
resolve but are frozen: never use them in new CSS. Existing legacy usages are compatibility debt only. Migrate touched call sites to canonical tokens; never add new uses of deprecated aliases.

## 3. Typography

| Role | Token | Use |
| --- | --- | --- |
| Title | `--font-title` (= Header size, 24 default) | Hero/page titles only; `h1`. Not for window chrome. |
| Heading | `--font-heading` (0.75 × Header size, 18 default, floored at 15) | Content and section heads inside a window; `h2`. |
| Window title | `--font-window-title` (15, menu scale) | Every window, dialog and sheet title bar (`ModuleView`, `dialog-system-header`, `ui-dialog`, `sheet-title`). Weight 650. |
| Body | `--font-body` (~14–16) | Default copy; set on `body`. |
| Label | `--font-label` (14–15) | Controls, row labels, emphasis. |
| Metadata | `--font-meta` (12–13) + `--font-meta-lh` | Timestamps, hints, counts. Never smaller for meaningful content. |
| Code in UI | `--font-code` + `--mono` | Code blocks, diffs, editor, and short UI ids. Inline code inside conversation prose inherits its sentence (`1em`) so words do not jump caliber. |
| Editor/composer | `--editor-font-size` (user-set), inputs floor at `--font-input` (16px) | Prevents iOS focus zoom. |

Weights: 400 body, 500–600 labels/buttons, 650 titles and headings.

Headings: a title bar is chrome and never outweighs the content heading under
it. A content heading with a short subtitle (scope, range, version, time zone)
puts that `--font-meta`/`--muted` subtitle on the **same line**:
`display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--space-2)`,
so a narrow window wraps it under the heading. Sentence-length descriptions
(setup intros, empty states) stay a paragraph under the heading. Avoid 700+ except the
accent-solid primary button. Line lengths: cap prose at ~65ch.

Conversation prose keeps one caliber: the response body defaults to `14.7px`
(0.98 of the surface's text size), headings never fall below it, inline code
inherits its sentence, and tables stay on the response size.
Thinking/reasoning prose shares that caliber too — only color and the two-line
clamp make a thought quieter. Only framed code surfaces take the smaller
`--font-code` step.

Two text-size settings own two type surfaces: the **menu** size for the shell
canvas and a **chat** size for a conversation surface (`.focus-conversation`,
`.widget-conversation`). Size roles are declared once for both and resolve
against `--text-scale`, so a transcript can be enlarged without growing every
label around it. New type roles go in that block, never bound to one surface's
scale — see "Type surfaces" in `docs/dev/styles.md`.

## 4. Spacing, radius, elevation

- **Spacing** is the 4px scale; inside components use `--space-1..3`, between
  components `--space-3..5`, view gutters `--gutter`/`--screen-gutter`.
- **Radius** (the calm scale, all × `--corner-radius-scale`):
  controls 8px (`--radius-control`), cards 10px (`--radius-card`),
  substantial panels 12px (`--radius-surface`), sheets/dialogs/composer 16px
  (`--radius-sheet`/`--radius-composer`). `999px`/`50%` only for pills/circles.
- **Shadows** climb with detachment: `--shadow-sm` cards, `--shadow-md`
  (= `--overlay-shadow`) popovers/menus, `--shadow-lg` modals/sheets. Never
  hand-rolled `box-shadow` colors.

## 5. Motion

| Token | Duration | Use |
| --- | --- | --- |
| `--motion-fast` | 120ms | Hover/press feedback, tooltips, popover enter. |
| `--motion-normal` | 180ms | Component state changes (progress fill, toggles). |
| `--motion-surface` | 240ms | Dialog/sheet/panel enter/exit. |
| `--motion-stack` | 300ms | Full-screen phone layers (Workspace ⇄ package window): push, Back, dismiss. Pairs with `--motion-stack-ease`, not `--motion-ease`. |
| `--motion-window` | 340ms | Desktop package window arriving out of its launcher rail (floating glide, docked growth, seam, tablet cluster dock, focused split). Pairs with `--motion-window-ease`, a long ease-out. |
| `--motion-window-exit` | 220ms | The same window leaving back into its rail. Pairs with `--motion-window-exit-ease`, which accelerates. |

Always pair with `--motion-ease` (stack motion with `--motion-stack-ease`, window motion with its `--motion-window*` curve). No decorative/looping motion except
Spinner/Skeleton, the composer's context liquid (it drifts only while a
turn runs), the subagent state dot's ping (only while a chat's subagents
work; a waiting dot holds still), the arc travelling round a working agent's
mark (only while its run works; reduced motion leaves the arc still), the launch veil's breathing mark (only while a boot or connect
is still running after its status delay) and the one-shot puff of smoke that
confirms a rail icon dragged away from every rail is gone (`railDrag.ts`, about
480ms, none under reduced motion), which are activity semantics. A
phone or native boot is revealed once, from the launch veil, onto a settled
workspace — see "Launch and reveal" in `docs/mobile/platform-behavior.md`. Phone navigation destinations,
session overviews, and full-screen Workspace panels keep a short
presentation-only final frame for their exit, then unmount; reopening cancels
that pending exit. Their entrances and exits stay composited, use motion
appropriate to the surface, and share the surface duration rather than
component-local timing. A package window opened from the Workspace is pushed
above it instead of replacing it: Workspace and package are one stack with one
grammar (travel in from the inline-end edge, the layer beneath retreats and
dims), timed by `--motion-stack` — see "Phone layer stack" in `ui.md`. On
desktop a package window glides out of its launcher rail and back on
transform and opacity only, so it keeps frame rate while the package mounts; a
docked window's content keeps its final width while the frame grows, so it is
laid out once (`ui.md` "Window motion"). A focused split (IDE) never animates
column geometry on entry: it takes its final columns on the first frame and
cross-fades the work surface in (opacity + 8px translate from its launcher
rail's side, `--motion-window`/`--motion-window-ease`); a dock ⇄ layer change
caused by the window rather than the person does not animate at all (`ui.md`
§4.2). Reduced motion is handled globally; do not add per-component
`animation: none` blocks unless you need a non-zero fallback.

## 6. Icons

- UI action icons come from **Lucide** through the curated map
  `components/ui/icons.ts` (semantic names: `CloseIcon`, `MoreIcon`,
  `DeleteIcon`, …). Import from that file, never from `lucide-react` directly,
  so one action keeps one glyph app-wide.
- Sizes are tokens via the `Icon` wrapper: `sm` 16 (dense rows, compact
  buttons), `md` 18 (standard controls), `lg` 20 (prominent/mobile controls),
  `xl` 24 (mobile emphasis, empty-state marks). Stroke width 1.75.
- Decorative icons are `aria-hidden`; pass `label` only when the icon is the
  content.
- Domain identity assets stay: project icons (`assets/project-icons`),
  provider logos, the brand mark, and the legacy domain set in `src/icons.tsx`
  until its call sites migrate.

## 7. Control sizing and density

- Visual heights: `sm` = `--control-h-sm` (32), `md` = `--control-h` (40),
  `lg` = `--control-h-lg` (48). Desktop-dense surfaces (toolbars, list rows)
  use `sm`; forms and primary flows use `md`; mobile primary actions `lg`.
- **Hit areas:** components use `min-height: max(<visual>, var(--hit-min))`.
  `--hit-min` is 0 on fine pointers and `--tap` (44px) on coarse pointers —
  set once in core CSS. `IconButton` additionally extends its hit box with a
  centered transparent `::after`, so a 24px glyph still has a 44px target.
  Never enlarge the visible control to satisfy the target.
- Horizontal padding: `--control-pad-x` (14) standard, `--control-pad-x-sm`
  (10) compact; glyph↔label gap `--control-gap`.

### Buttons

`Button` and `IconButton` (or `buttonClassName()`) own every state below; use
them before painting a button yourself. The same contract binds a button a
package or core component paints itself, and
`apps/web/test/buttonStates.test.ts` enforces its hover and press half across
the shell and every package stylesheet.

- **Hover is pointer-only.** Every `:hover` rule that can reach a button lives
  in `@media (hover: hover)`. A touch screen keeps `:hover` on the last tapped
  point, so a hover outside that query sticks after a tap. Nothing flattens a
  stuck hover on touch any more: that reset also erased selected tabs, pressed
  toggles and filled actions.
- **Hover keeps the button's identity.** A filled, selected or pressed button
  stays in its own color family under the pointer (accent fill →
  `--accent-hi`; an active toggle one wash stronger), never the neutral hover.
  Core `button:hover` (specificity 0,1,1) paints `--elevated` over any fill
  set by a single class: give that fill its own hover, or scope it
  (`button.x`, `.group > .x`) when the button is a swatch or a full-surface
  dismiss target (backdrop, scrim) that must never repaint.
- **Press composes.** Core gives `:active` a `scale(.98)` settle at zero
  specificity (a button that positions itself with a transform keeps it) and
  an inset `--surface-overlay-strong` wash over the fill; `Button` variants
  own their press.
- **Disabled is gray and inert at rest.** No hover, press, tap highlight or
  pointer cursor. Every `:hover`/`:active` rule on a button carries the
  zero-specificity `:where(:not(:disabled))` guard (`:not(:disabled)` where
  the extra specificity is intended). `Button` and the quiet `IconButton`
  paint the neutral chip with `--control-disabled-bg`,
  `--control-disabled-border` and `--control-disabled-ink`; a button a
  package paints itself uses the same tokens. Any other `button:disabled`
  falls back to `opacity: .5; filter: grayscale(1)`, so an accent fill turns
  gray instead of fading. An answered choice that must stay at full strength
  resets both `opacity` and `filter` explicitly.
- **`aria-disabled="true"`** keeps a control focusable to explain why it is
  unavailable: its handler ignores activation, and its hover excludes it with
  `:not([aria-disabled="true"])`.
- **Busy** (`aria-busy`, set by `busy`) keeps the variant, shows the spinner
  and uses `cursor: progress`; the button only stops answering the pointer.

## 8. Choosing an overlay

| Situation | Primitive |
| --- | --- |
| Action list from a trigger | `Menu` (anchored menu on desktop, Sheet on phone — automatic) |
| Anchored non-modal content (filters, small forms, previews) | `Popover`, or `ResponsiveOverlay` with `desktop="popover"` for phone degradation |
| Task that must be completed/dismissed (forms, confirmations with content) | `Dialog` (`ui/Dialog` chrome over the `a11y/Dialog` engine) |
| Simple confirm/prompt | `confirmAlert()` / `promptAlert()` (themed AlertDialog) |
| Phone-mode list/pick/action surface | `Sheet` — automatic via `ResponsiveOverlay`, `Menu`, `Picker`/`Select` |
| Select a value from many | `Select` (simple) or `Picker` (search, groups, multi, footer actions) |
| Transient outcome notice | Toast strategy (§10) |

**`ResponsiveOverlay` is the seam** for "one action, right surface per form
factor": phone → bottom Sheet (swipe dismiss, `--keyboard-inset`-safe);
desktop → anchored Popover (when `anchorRef` is given) or modal Dialog.
Content renders once; no forked business logic per breakpoint.

Overlay mechanics you get for free and must not reimplement: focus trap +
restore (`useModalSurface`), scroll lock, Escape layering (menus close before
their parent surface), both-axis collision + visual-viewport awareness
(`useAnchoredPosition`), z-layering via `--z-*`.

## 9. Component API overview

All from `apps/web/src/components/ui` (see `index.ts`):

- `Button` — `variant: primary | quiet(default) | danger | ghost`,
  `size: sm | md | lg`, `iconStart/iconEnd`, `busy`, `block`.
  ```tsx
  <Button variant="primary" iconStart={AddIcon} onClick={create}>Create session</Button>
  <Button variant="danger" size="sm" busy={deleting} onClick={remove}>Delete</Button>
  ```
- `IconButton` — `icon`, required `label` (aria-label + title),
  `variant: ghost(default) | quiet | danger`, `size`, `pressed`, `busy`.
  ```tsx
  <IconButton icon={MoreVerticalIcon} label="Session actions" {...trigger} />
  ```
- `TextInput` / `Textarea` — token fields; `invalid`, `uiSize`; Textarea
  `autoGrow` + `minRows/maxRows`. The chat composer keeps its IME-safe
  `AdaptiveTextInput`. A search or address bar that draws one field around an
  icon, the input and a clear button is a `.ui-field-well` (see
  [styles.md, Field wells](styles.md#field-wells)).
- `Checkbox` — `checked/onChange/label/description`. Multi-select lists.
  Its outline survives borderless appearance and its corner radius is capped,
  so it never reads as empty space or as a radio button.
- `Switch` — `checked/onChange/label`. On/off settings (settings `Toggle`
  delegates here). One visual, the canonical `.switch`.
- `Select` — simple single-value picker over the canonical `Picker`
  (desktop popover, phone sheet). `searchable={false}` drops the filter field
  for a short list; `align="end"` lines the popover up with a trigger at a
  container's trailing edge. Use `Picker` directly for search-heavy,
  multi-select, or footer-action cases. A picker's filter is the shared
  `.picker-search` well (search glyph + borderless input on a soft tint; the
  model picker mirrors it on desktop in its package CSS as a standing field at
  the edge nearest its trigger — bottom for the composer; `/` or typing on the
  focused list moves to the field, Escape clears a query first; a query also
  lists matches from every other runnable harness, grouped by harness, from
  cached catalogs only. The phone model picker has no field at all, so
  cross-harness search is desktop-only. Its harness tabs stay one
  sideways-scrolling row that opens with the selected harness centred and, on
  touch, fades at an edge it continues past). It owns focus while the list is
  open, so — like the command palette field — focus lights the glyph and
  brightens the well instead of drawing the global ring. The current row is
  marked with a check icon; on touch (`hover: none`) the keyboard-active row
  is only tinted once a filter is typed or the arrow keys move it
  (`data-show-active`), so the first row never reads as a selection.
- `ProjectPicker` — the canonical project chooser: one compact chip plus the
  shared searchable `Picker` surface. It is the project picker above the
  composer in the new-session view, and the Projects settings page and package
  surfaces (for example the schedule planner) delegate to it. Choose among
  projects only through it (or `Select`); do not fork a package-owned project
  overlay. Its only intended variation is the shared `Picker` desktop/phone
  presentation. The chip and every row show the project's own `ProjectGlyph`
  (icon + color, remote marker); the folder icon is only the fallback when
  nothing is selected or a project has no icon, so pass entries with their
  `icon`/`color`/`remote`. Project rows omit the leading checkmark and its
  reserved space so every name starts at the same inset; the current project
  shows the check at the trailing edge instead, and `aria-selected` carries
  the state. Above the composer the project chip is the
  emphasized element of the location row (full-ink, larger name, glyph on a
  tinted tile) so where a chat goes reads before the model picker. Names use the row's full width and wrap when needed. The
  path or custom detail sits beneath the name in smaller muted text, with
  single-line ellipsis for long paths. `ProjectPicker` keeps the order it is
  given; the new-session location row passes projects ranked by recent chats
  (`apps/web/src/projectRecency.ts`): each top-level chat of the last 30 days
  adds a weight that halves every 7 days, ties go to the newest chat, and
  projects without recent chats keep registry order after the rest.
- `Menu` — `label`, `entries: (MenuAction | "separator")[]`, render-prop
  trigger receiving `{ref, onClick, aria-*}`. The popover is a flex column
  whose single `--menu-row-gap` (`--space-1`) spaces every child, so a
  `"separator"` sits in the same rhythm as the rows around it rather than
  widening the gap (`styles.css`, guarded by `uiPrimitives.test.ts`); the
  phone `Sheet` list reads the same token. Its children never shrink: a menu
  taller than its max-height scrolls instead of squeezing rows and dividers.
  A setting with several choices is one drill-in row, not a section of
  radios: give the action `entries` (its choices) and `value` (the current
  one, shown muted before a chevron). Selecting it shows those entries in
  place of the menu under a Back row; the footer belongs to the top level.
  ```tsx
  <Menu label="Session actions" entries={[
    { id: "rename", label: "Rename", icon: EditIcon, onSelect: rename },
    "separator",
    { id: "delete", label: "Delete", icon: DeleteIcon, danger: true, onSelect: remove },
  ]}>
    {(trigger) => <IconButton icon={MoreIcon} label="Session actions" {...trigger} />}
  </Menu>
  ```
- `Popover` — `open/onClose/anchorRef/align/side/ariaLabel/initialFocus`.
- `Dialog` — `title/onClose/footer/size(sm|md|lg|full)`; standard header with
  close button; body owns overflow. `AlertDialog` stays for confirm/prompt.
- `ResponsiveOverlay` — §8. `Sheet`/`SheetRow`/`SheetSection` re-exported for
  direct phone-surface composition.
- `Tabs` + `TabPanel` — `tabs/value/onChange/label`, arrow-key navigation,
  `idBase` links panels. The selected tab keeps its fill under the stuck
  `:hover` touch leaves on the tapped tab: the global touch reset that
  flattens quiet buttons skips `[aria-selected="true"]`, as it skips
  `[aria-pressed="true"]`.
- `Tooltip` — `content`, wraps its trigger; hover (fine pointers, 350ms
  delay) + focus; the trigger must own its accessible name. `disabled`
  drops a pending or shown bubble while the trigger's context already shows
  the same thing (the project rail's tooltip while the sessions peek is
  open); it does not reappear when `disabled` clears.
- `Badge` — `tone: neutral | accent | success | warning | danger | info`,
  `dot`. Text must carry the meaning, not just color.
- `Spinner` (`label` → status role), `Progress` (`value` 0..1, `label`),
  `Skeleton` (`shape: text | block | circle`).
- `EmptyState` — `variant: page(default) | panel | compact`; one per surface.
- `Separator`, `VisuallyHidden`, `Icon`.
- Hooks: `useAnchoredPosition`, `useModalSurface`, `useModalScrollLock`,
  `useDismissibleMenu`.

## 10. Toast strategy

One notification system, one visual standard: every transient message is a
card of the host notification stack (`apps/web/src/notify/`, contract in
[ui.md §4.8](ui.md#notifications)); packages reach it through
`host.notifications`. The card is Quiet Glass (`--material-glass-strong`,
`--material-glass-border`, highlight + shadow, blur through the shared
material lists in `styles.css`) at `--z-toast`, `--radius-surface`, no wider
than 336px, with one even inset (`--notify-pad`, 14px) on every side. Two
tracks, glyph and text: the close is not a column but sits in the corner, so
only the title steps around it and the body, excerpt, progress bar and action
row run to the content's right edge — no dead rail down the right. A tinted
round glyph (32px, a top-lit wash and a 1px inset tone ring, no glow) carries
the kind (`--red` error,
`--amber` warning, `--green` success, `--purple` news; `--accent` only for
what the app itself is doing — progress, update; `info` neutral: `--muted`
glyph on an 8% `--text` wash; `hint` teal, `color-mix(in oklab, --green 45%,
--blue)`, distinct from the accent in every theme), then title
(`--font-body` − 1px, 600), body (`--text-dim`, one step under the title,
3 lines) — with a body, the glyph, the title's first line and the close all
start on one top edge; a title alone and its close centre on the glyph — a
full-width monospace excerpt, progress bar and actions (a `md`
spinner stands in for indeterminate progress; labelled actions are flat and
share the text column evenly, wrapping rather than truncating a long label,
30px on fine pointers / `--tap` on touch: the primary a plain
`--accent` fill with no gradient or glow, the rest a 7% `--text` wash, never
an opaque fill on the glass; beside icon-only actions they keep their size),
a quiet close control whose visible X keeps the
inset the glyph has — the 24px box is pulled out of
its own empty icon padding, so the painted stroke rather than the box lands on
the corner (24px look, `--tap` hit area on touch, anchored to the outer corner
so the card's clip cannot eat it), and a 2px tone hairline
that spends the lifetime, freezes while the stack is paused or the card is
folded, and resumes rather than restarts when a card returns from the queue.
Enter is a short spring on `translate`/`scale`/`opacity` (`linear()` where
supported, `--motion-stack-ease` otherwise), siblings reflow on `transform`
over `--motion-stack`, and a card leaves as an exit ghost (sinking toward its
edge, off its side when swiped, up past the header when flicked on phone);
reduced motion, the in-app setting and low-resource desktop drop all of it
but the hairline. The notification centre's rows reuse the same glyph and
tone (`NotificationGlyph`; completed → success, failed → error, question →
hint, permission → warning, subagent → info) on a glass card with an unread
tone dot, in two columns — glyph and text. The date is the last item of the
meta line (kind … date) and a dead session's note is a line of its own; never
give the date a column, which at ~100px takes over a third of a ~265px rail
panel row and leaves the title a sliver. The host's transient error
(`setUiError`), the desktop updater
(found / downloading / ready, persistent until acted on or closed) and a newer
web build (Reload / Later) are notifications like any other. Durable,
actionable outcomes go
to the notification centre (NTF-01) and, out-of-page, web push. Feedback for
an action on a visible control is an in-place state change (button
label/badge/row update), not a notification; a notification is for outcomes
the person cannot otherwise see (background runs, updates, failures).

Transport classification is shared, not per-call-site:
`apps/web/src/errorPresentation.ts` owns the engine phrasings that mean a
request never produced an HTTP response — Chromium "Failed to fetch", Firefox
"NetworkError…", Android WebView `net::ERR_…`, and the iOS/WKWebView
`Load failed` that the Capacitor shell also reports (the same message covers a
rejected `fetch`, XHR or module request). Typed server diagnostics take
precedence. Untyped browser transport failures describe the connection to
Polyth; only `harness-transport` with recovery state `reconnecting` displays
OpenCode reconnecting. A successful health endpoint does not establish that
the failed operation recovered. Unknown mutation outcomes preserve the draft
and point to session status without offering an unpinned resend. First-send
creation errors may reconnect sync, but never replay the create or send.

Navigator summary pages are additive, not deletion snapshots. Search and
archive filters query the server; bulk worktree actions resolve the complete
selection before enabling confirmation. Imported native histories display
pending/in-progress/failed state until canonical import completes; the empty
conversation hero and send action must not imply a finished import.

If canonical verification proves that the failed startup row is empty and the
automatic cleanup deletes it, the staged first prompt returns to the fresh
composer through the same scoped draft record (text, attachment pills and
native-staged metadata). Cleanup captures the source `PersistenceScope` and
the fresh-draft namespace before awaiting verification/deletion, then re-reads
the source at the safe point. A stale namespace discovered while verification
is in flight aborts the empty-row delete; if the namespace changes during the
delete itself, recovery is fenced. Before activation is cleared, a mounted
Composer gets one local-only flush of its live uncontrolled input, so the
250ms debounce and outgoing layout/unmount cannot lose newer text. A hero-to-
timeline remount initializes its submitted baseline before pending-echo
binding, so later typing or an explicit clear remains a newer edit. It
transfers only when the current connection/account/Space/project namespace,
navigation owner and fresh-draft revision are still the captured ones; a
navigation or newer fresh draft wins and is never overwritten. A nonempty
canonical row is not transferred. The destination persistence is flushed
before the deleted-session source record is cleared; if that flush fails, the
source copy is retained. A failed delete likewise leaves the original session
and draft available.

## 11. Scroll areas

Native scrolling only — no custom scroll library. Apply `.ui-scroll` (or the
equivalent three declarations) to the element that owns overflow:
`overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable`.
Themed thin scrollbars are global. Height caps for overlay bodies derive from
`--visual-vh`, never `100vh` and never reduced by `--keyboard-inset`: the
visible band already excludes the keyboard. A Markdown table is a scroll area
of its own: the renderer wraps it in `.md-table-scroll`, whose `overflow-x:
auto; overflow-y: hidden` keeps the grid at `width: max-content` so a narrow
column scrolls the table instead of crushing its cells.

## 12. Mobile rules

- Phone shell mode (`useShellMode()`) swaps overlays to `Sheet` — get this via
  `ResponsiveOverlay`/`Menu`/`Select` instead of branching in features.
- Never autofocus a text field on open in touch flows (summons the keyboard);
  the desktop `Picker` search autofocus is being gated to fine pointers in 1b.
- Fixed-to-bottom UI must consume `--visual-bottom`; safe areas via `--safe-*`.
  A full-height `position: fixed` layer must not size itself from
  `--visual-vh` or pad by `--keyboard-inset` — it takes the keyboard band in
  `mobileViewport.css` ([mobile viewport](mobile-viewport.md#full-height-layers)).
- No hover-only affordances: message quick actions (user prompts and agent
  answers share `MessageActionBar` and the layout model in
  `apps/web/src/messageActionLayout.ts`) may reveal on hover or keyboard focus
  only with a fine pointer; touch resolves to an always-visible bar or the
  More menu. Each action is placed on the bar, in the More menu or off, in a
  user-chosen order (Settings > Chat). Faded controls keep their space; the
  reveal animates opacity only. Package `session.message.actions`
  contributions are entries of the same layout (`pkg:<contribution id>`), so
  every button under a message can be reordered, moved or turned off; only a
  contribution that declares `meta.messageAction.menu` can fold into More,
  the others stay on the bar. Package buttons use `ChatActionButton`.
- Transcript text selection: a mouse selection gets the floating toolbar beside
  the selection; a touch/pen selection (or the phone shell before any pointer
  is seen) gets the bottom selection dock (`SelectionDock.tsx`) instead, so it
  never collides with the OS callout or the selection handles. The dock sits on
  the measured frame (`--layer-frame-bottom`, above `--safe-bottom`), refreshes
  its quote preview as the handles move, stays put while the timeline scrolls,
  swipes down to clear the selection, and shares the selection-menu glass
  rules. Both surfaces run the same commands (`selectionCommands.ts`).
- Package/panel content adapts with container queries; viewport media queries
  are shell-only.

## 13. Desktop density

Desktop surfaces default to compact visuals: `sm`/`md` controls, 32px
toolbar rows, `--font-meta` metadata. Density is never a separate theme —
it is the fine-pointer default, and `--hit-min` upgrades the same components
on touch. Keyboard: every flow reachable by Tab; arrow keys inside menus,
tabs, and listboxes; visible `:focus-visible` ring everywhere (global rule).
The one exception is a search field that owns focus for its whole surface
(command palette, picker filter wells): it signals focus with its glyph and
fill instead of a ring.

## 14. Adoption and deprecation

- New and edited core UI composes the shared `ui/` primitives.
- Legacy classes such as `.primary-btn`, `.small-btn`, `.danger-btn`, `.icon-btn`, and ad-hoc menu/dialog chrome are compatibility-only; do not add new call sites.
- Packages consume shared primitives and keep feature CSS scoped to their package root. Do not copy host primitive styles into packages.
- Deprecated tokens are listed in §2. `usePopoverPlacement` is superseded by `useAnchoredPosition` for anchored surfaces.
