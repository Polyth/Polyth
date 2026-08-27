# Polyth design system — Phase 1 (P1-W2)

The concrete contract for building Polyth UI. Companion to `docs/dev/styles.md`
(token catalog + package CSS rules) and `docs/ui-redesign/phase-1-audit.md`
(why this exists). Component code: `apps/web/src/components/ui/`; component
CSS: the single `P1-W2` section at the end of `apps/web/src/styles.css`.

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
| Ink | `--text` → `--text-dim` → `--muted` → `--faint` |
| Signals | `--green/--amber/--red/--blue/--purple` + `--*-wash` surfaces + `--green-on-wash`/`--amber-on-wash` ink |
| Spacing | `--space-1..6` (4/8/12/16/24/32), `--gutter`, `--screen-gutter` |
| Control geometry | `--control-h-sm/-h/-h-lg` (32/40/48), `--control-pad-x(-sm)`, `--control-gap`, `--tap`, `--hit-min` |
| Radius | `--radius-control/card/surface/sheet` (+ `--radius-composer`), all × `--corner-radius-scale` |
| Type | `--font-title/heading/body/label/meta/code`, `--font-input` (16px mobile floor), `--editor-font-size`, `--mono` |
| Icons | `--icon-sm/md/lg/xl` (16/18/20/24) |
| Elevation | `--shadow-sm/md/lg`, `--inset-hi`, `--scrim` |
| Motion | `--motion-fast/normal/surface` + `--motion-ease` |
| Layers | `--z-shell/overlay/toast/popover/tooltip` |

Deprecated aliases (`--radius`, `--radius-sm/md/lg/xl`, `--surface-*`, `--fg`,
`--danger`, `--warning`, `--success`, `--info`, `--border-subtle`, …) still
resolve but are frozen: never use them in new CSS. The ~180 legacy usages are
rewritten mechanically in the Phase 1a cleanup, then the aliases are deleted.

## 3. Typography

| Role | Token | Use |
| --- | --- | --- |
| Title | `--font-title` (28–36) | One per page/view; `h1`. |
| Heading | `--font-heading` (20–26) | Section heads; `h2`. |
| Body | `--font-body` (~14–16) | Default copy; set on `body`. |
| Label | `--font-label` (14–15) | Controls, dialog titles, row labels, emphasis. |
| Metadata | `--font-meta` (12–13) + `--font-meta-lh` | Timestamps, hints, counts. Never smaller for meaningful content. |
| Code in UI | `--font-code` + `--mono` | Inline paths, ids, snippets. |
| Editor/composer | `--editor-font-size` (user-set), inputs floor at `--font-input` (16px) | Prevents iOS focus zoom. |

Weights: 400 body, 500–600 labels/buttons, 650 titles. Avoid 700+ except the
accent-solid primary button. Line lengths: cap prose at ~65ch.

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

Always pair with `--motion-ease`. No decorative/looping motion except
Spinner/Skeleton, which are activity semantics. Reduced motion is handled
globally; do not add per-component `animation: none` blocks unless you need
a non-zero fallback.

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
  `AdaptiveTextInput`.
- `Checkbox` — `checked/onChange/label/description`. Multi-select lists.
- `Switch` — `checked/onChange/label`. On/off settings (settings `Toggle`
  delegates here). One visual, the canonical `.switch`.
- `Select` — simple single-value picker over the canonical `Picker`
  (desktop popover, phone sheet). Use `Picker` directly for search-heavy,
  multi-select, or footer-action cases.
- `Menu` — `label`, `entries: (MenuAction | "separator")[]`, render-prop
  trigger receiving `{ref, onClick, aria-*}`.
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
  `idBase` links panels.
- `Tooltip` — `content`, wraps its trigger; hover (fine pointers, 350ms
  delay) + focus; the trigger must own its accessible name.
- `Badge` — `tone: neutral | accent | success | warning | danger | info`,
  `dot`. Text must carry the meaning, not just color.
- `Spinner` (`label` → status role), `Progress` (`value` 0..1, `label`),
  `Skeleton` (`shape: text | block | circle`).
- `EmptyState` — `variant: page(default) | panel | compact`; one per surface.
- `Separator`, `VisuallyHidden`, `Icon`.
- Hooks: `useAnchoredPosition`, `useModalSurface`, `useModalScrollLock`,
  `useDismissibleMenu`.

## 10. Toast strategy

No new toast system in Phase 1. Transient failures use the existing bottom
error banner (`--z-toast`); durable, actionable outcomes go to the
notification centre (NTF-01) and, out-of-page, web push. Success feedback is
in-place state change (button label/badge/row update), not a toast. If a true
ephemeral toast becomes necessary, it will be one core primitive layered at
`--z-toast` — packages must not invent their own.

## 11. Scroll areas

Native scrolling only — no custom scroll library. Apply `.ui-scroll` (or the
equivalent three declarations) to the element that owns overflow:
`overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable`.
Themed thin scrollbars are global. Height caps for overlay bodies derive from
`--visual-vh` / `--keyboard-inset`, never `100vh`.

## 12. Mobile rules

- Phone shell mode (`useShellMode()`) swaps overlays to `Sheet` — get this via
  `ResponsiveOverlay`/`Menu`/`Select` instead of branching in features.
- Never autofocus a text field on open in touch flows (summons the keyboard);
  the desktop `Picker` search autofocus is being gated to fine pointers in 1b.
- Fixed-to-bottom UI must consume `--visual-bottom`/`--keyboard-inset`;
  safe areas via `--safe-*`.
- No hover-only affordances: actions are visible or behind an explicit `Menu`
  on coarse pointers.
- Package/panel content adapts with container queries; viewport media queries
  are shell-only.

## 13. Desktop density

Desktop surfaces default to compact visuals: `sm`/`md` controls, 32px
toolbar rows, `--font-meta` metadata. Density is never a separate theme —
it is the fine-pointer default, and `--hit-min` upgrades the same components
on touch. Keyboard: every flow reachable by Tab; arrow keys inside menus,
tabs, and listboxes; visible `:focus-visible` ring everywhere (global rule).

## 14. Adoption and deprecation path

- New/edited core UI composes `ui/` primitives. Legacy classes
  (`.primary-btn`, `.small-btn`, `.danger-btn`, `.icon-btn`, ad-hoc menus)
  are frozen: no new call sites; existing ones migrate per-surface in 1b/1c
  (order in `docs/ui-redesign/component-migration-matrix.md`).
- Packages adopt in Phase 1c together with the package-CSS repatriation and
  container-query conversion.
- Deprecated tokens: see §2. `usePopoverPlacement` is superseded by
  `useAnchoredPosition` for new anchored surfaces.
