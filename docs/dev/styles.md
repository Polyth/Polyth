# Polyth web style guide

`apps/web/src/tokens.css` is the source of truth for the web app's canonical
design tokens. The main web app owns this contract. `apps/web/src/theme.ts`
overrides theme-dependent values at runtime; feature packages inherit the
result and do not publish competing global tokens.

Read this guide before editing UI or CSS. Ownership/extension questions:
`docs/dev/ui.md`. Component construction: `docs/dev/components.md`. Widgets:
`docs/dev/widgets.md`. The token catalog below is the single authoritative
list — other docs link here instead of restating it.

## Ownership and inheritance

- Core tokens, shell/layout rules, and shared primitives belong in
  `apps/web/src/tokens.css` and `apps/web/src/styles.css`.
- A package imports its own `packages/<name>/widgets/styles.css` from its web
  entry and scopes every feature rule under a stable package root such as
  `.usage-dashboard`, `.widget-git`, or `.pkg-usage`.
- Package CSS may add component-local custom properties under that root when
  the value has package-specific meaning. Prefix additions with the package
  name, for example `--usage-chart-tone`.
- Package CSS must not redefine canonical tokens, style another package's
  prefix, or target generic app selectors such as `.view-page`, `.small-btn`,
  `.primary-btn`, or `.empty-state`.
- Shared behavior needed by two packages is a core primitive. Move it to
  `apps/web/src/styles.css`; do not copy the selector block.
- Use `var(--*)` for a catalogued color, spacing, radius, type, motion,
  elevation, or control dimension. A literal is appropriate only when the
  value is intrinsic data, such as a provider brand, terminal ANSI slot,
  chart coordinate, or true circle/pill.

## Token catalog

### Surfaces, boundaries, and ink

| Token | Purpose |
| --- | --- |
| `--bg` | Lowest application/workspace surface. |
| `--panel` | Navigation, rail, and panel surface. |
| `--elevated` | Cards, menus, and controls raised above a panel. |
| `--raised` | Active or hovered elevated surface. |
| `--sunken` | Recessed wells, editors, and tracks. |
| `--input-bg` | Editable field background. |
| `--border` | Structural boundary. |
| `--border-soft` | Decorative separator that does not identify a control. |
| `--control-border` | Recognizable input, button, and interactive-card boundary; stronger on light themes. |
| `--surface-divider` | Divider between adjacent surfaces. |
| `--hair` | Lowest-emphasis hairline. |
| `--hair-strong` | Stronger hairline for hover and internal grouping. |
| `--text` | Primary text. |
| `--text-dim` | Secondary text that still needs clear emphasis. |
| `--muted` | Supporting copy and metadata. |
| `--faint` | Lowest-emphasis readable metadata. |

### Accent, status, and overlays

| Token | Purpose |
| --- | --- |
| `--accent` | Primary brand/action color. |
| `--accent-ink` | Text or glyph on a solid accent. |
| `--accent-hi` | Highlight end of an accent treatment. |
| `--accent-wash` | Subtle accent background. |
| `--accent-line` | Accent-tinted boundary. |
| `--focus-wash` | Outer focus halo. |
| `--accent-rgb` | Accent channels for alpha-based CSS. |
| `--green` | Success/healthy signal. |
| `--amber` | Warning signal. |
| `--red` | Danger/error signal. |
| `--red-ink` | Readable ink on a solid danger surface. |
| `--blue` | Informational signal. |
| `--purple` | Auxiliary/syntax signal. |
| `--green-on-wash` | Accessible success text on a success wash. |
| `--amber-on-wash` | Accessible warning text on a warning wash. |
| `--amber-rgb` | Warning channels for alpha-based CSS. |
| `--green-wash` | Success-tinted surface. |
| `--amber-wash` | Warning-tinted surface. |
| `--red-wash` | Danger-tinted surface. |
| `--blue-wash` | Information-tinted surface. |
| `--purple-wash` | Auxiliary-tinted surface. |
| `--surface-overlay` | Subtle theme-aware overlay. |
| `--surface-overlay-hover` | Hover-strength theme-aware overlay. |
| `--surface-overlay-strong` | Selected/pressed theme-aware overlay. |
| `--material-glass` | Readable opaque fallback material for popovers, menus, and pickers; enhanced to translucent glass when backdrop blur is supported. |
| `--material-glass-strong` | More opaque glass material for dialogs and sheets. |
| `--material-glass-border` | Theme-derived glass edge. |
| `--material-glass-highlight` | Inset highlight shared by glass surfaces. |
| `--material-glass-shadow` | Shared floating-surface elevation. |
| `--material-glass-blur` | Backdrop blur strength for capable, full-resource clients. |

### Spacing and control geometry

| Token | Purpose |
| --- | --- |
| `--space-1` | 4px spacing step. |
| `--space-2` | 8px spacing step. |
| `--space-3` | 12px spacing step. |
| `--space-4` | 16px spacing step. |
| `--space-5` | 24px spacing step. |
| `--space-6` | 32px spacing step. |
| `--gutter` | Standard desktop content gutter; aliases `--space-5`. |
| `--screen-gutter` | Compact/phone screen gutter; aliases `--space-4`. |
| `--chat-measure` | Shared reading measure for the chat timeline, composer, and inline conversation widgets. |
| `--tap` | Minimum 44px interactive hit dimension. |
| `--control-h-sm` | Compact 32px control visual. |
| `--control-h` | Standard 40px control visual. |
| `--control-h-lg` | Large 48px control visual. |
| `--control-pad-x-sm` | Horizontal padding for compact controls. |
| `--control-pad-x` | Horizontal padding for standard controls. |
| `--control-gap` | Gap between a control's glyph and its label. |
| `--hit-min` | Density seam: extra hit-area floor. 0px on fine pointers; core raises it to `--tap` under coarse pointers. Use in `max()` with the control's visual size. |

Controls use the smallest visual height appropriate to their density while
retaining a `--tap` hit area on phone/coarse-pointer surfaces. Do not enlarge
switch tracks or glyphs to create the hit area; enlarge the transparent
interactive box around them — the `--hit-min` seam and the `.ui-icon-btn`
pattern in core `styles.css` show the sanctioned mechanism.

### Icon sizes

UI action glyphs use the icon scale; never hardcode svg dimensions in new CSS.

| Token | Purpose |
| --- | --- |
| `--icon-sm` | 16px compact/dense-row glyph. |
| `--icon-md` | 18px standard control glyph. |
| `--icon-lg` | 20px prominent control or mobile glyph. |
| `--icon-xl` | 24px mobile-emphasis or hero glyph. |

### Radius

| Token | Purpose |
| --- | --- |
| `--corner-radius-scale` | User-selected multiplier applied to scalable geometry. |
| `--radius-control` | Buttons, fields, chips, and compact controls. |
| `--radius-card` | Cards and bounded empty states. |
| `--radius-surface` | Panels and substantial surfaces. |
| `--radius-sheet` | Sheets and modal shells. |
| `--radius-composer` | Composer-specific radius when its geometry needs an independent role. |
| `--radius` | Deprecated alias of `--radius-control`. |
| `--radius-sm` | Deprecated alias of `--radius-control`. |
| `--radius-md` | Deprecated alias of `--radius-card`. |
| `--radius-lg` | Deprecated alias of `--radius-card`. |
| `--radius-xl` | Deprecated alias of `--radius-surface`. |

Use only the semantic radius roles in new CSS. `50%` and `999px` are reserved
for circles and pills. The Phase 1 calm scale is 8/10/12/16px before the user
multiplier: controls 8, cards 10, substantial surfaces 12, sheets/dialogs and
the composer 16.

### Typography

| Token | Purpose |
| --- | --- |
| `--ui-font-size` | User-selected base UI size. |
| `--ui-font-scale` | Reserved UI type multiplier. |
| `--font-input` | 16px editable-control floor that prevents mobile zoom. |
| `--font-body` | Responsive body role. |
| `--font-title` | Page/title role. |
| `--font-title-lh` | Title line height. |
| `--font-heading` | Section heading role. |
| `--font-label` | Control and emphasized label role. |
| `--font-meta` | Readable metadata role. |
| `--font-meta-lh` | Metadata line height. |
| `--font-code` | Inline code / code-in-UI role (pairs with `--mono`). |
| `--editor-font-size` | User-selected editor/composer size. |
| `--mono` | Monospace stack. |
| `--ui-font-family` | Active application font stack. |

Meaningful metadata uses `--font-meta`; 10–11px literals are only for
tertiary decorative labels, never instructions or state.

### Viewport and safe-area layout

| Token | Purpose |
| --- | --- |
| `--visual-vh` | Current visual viewport height published by mobile viewport code. |
| `--visual-bottom` | Visual viewport lower edge used around software keyboards. |
| `--keyboard-inset` | Current keyboard overlap. |
| `--visual-offset` | Visual viewport top offset. |
| `--safe-top` | Top safe-area inset. |
| `--safe-right` | Right safe-area inset. |
| `--safe-bottom` | Bottom safe-area inset. |
| `--safe-left` | Left safe-area inset. |

### Layering

New overlay CSS layers through the z-scale; legacy hardcoded z-indexes migrate
to it during the Phase 1 cleanup.

| Token | Purpose |
| --- | --- |
| `--z-shell` | Shell chrome (sticky headers, rails, bottom navigation). |
| `--z-overlay` | Modal surfaces (dialogs, sheets, full-screen overlays). |
| `--z-toast` | Transient toasts and error banners, above modals. |
| `--z-popover` | Anchored transient surfaces (menus, popovers) above any opener. |
| `--z-tooltip` | Tooltips, topmost. |

### Focus, elevation, and motion

| Token | Purpose |
| --- | --- |
| `--focus-ring` | High-contrast focus outline. |
| `--scrim` | Modal backdrop. |
| `--shadow-sm` | Small control/card elevation. |
| `--shadow-md` | Popover elevation. |
| `--shadow-lg` | Modal/sheet elevation. |
| `--inset-hi` | Subtle inset surface highlight. |
| `--motion-fast` | Immediate interaction transition. |
| `--motion-normal` | Standard component transition. |
| `--motion-surface` | Larger surface entrance/exit transition. |
| `--motion-ease` | Shared application easing curve. |

### Chat and syntax

| Token | Purpose |
| --- | --- |
| `--bubble-user-bg` | User-message surface derived from the active accent. |
| `--bubble-user-line` | User-message boundary derived from the active accent. |
| `--syntax-kw` | Syntax keyword color. |
| `--syntax-str` | Syntax string color. |
| `--syntax-cmt` | Syntax comment color. |
| `--syntax-num` | Syntax number color. |
| `--syntax-punc` | Syntax punctuation color. |

### Terminal

| Token | Purpose |
| --- | --- |
| `--term-bg` | Terminal background. |
| `--term-fg` | Terminal foreground. |
| `--term-cursor` | Terminal cursor. |
| `--term-sel` | Terminal selection. |
| `--term-find` | Terminal search match. |
| `--term-find-cur` | Current terminal search match. |
| `--term-link` | Terminal link. |
| `--term-a0` | ANSI black. |
| `--term-a1` | ANSI red. |
| `--term-a2` | ANSI green. |
| `--term-a3` | ANSI yellow. |
| `--term-a4` | ANSI blue. |
| `--term-a5` | ANSI magenta. |
| `--term-a6` | ANSI cyan. |
| `--term-a7` | ANSI white. |
| `--term-a8` | ANSI bright black. |
| `--term-a9` | ANSI bright red. |
| `--term-a10` | ANSI bright green. |
| `--term-a11` | ANSI bright yellow. |
| `--term-a12` | ANSI bright blue. |
| `--term-a13` | ANSI bright magenta. |
| `--term-a14` | ANSI bright cyan. |
| `--term-a15` | ANSI bright white. |

### Deprecated semantic aliases

These remain for migration only. New CSS uses the canonical token named in
the purpose column.

| Token | Purpose |
| --- | --- |
| `--surface-0` | Deprecated alias of `--bg`. |
| `--surface-1` | Deprecated alias of `--panel`. |
| `--surface-raised` | Deprecated alias of `--elevated`. |
| `--surface` | Deprecated alias of `--panel`. |
| `--fg` | Deprecated alias of `--text`. |
| `--text-primary` | Deprecated alias of `--text`. |
| `--text-muted` | Deprecated alias of `--muted`. |
| `--danger` | Deprecated alias of `--red`. |
| `--warning` | Deprecated alias of `--amber`. |
| `--success` | Deprecated alias of `--green`. |
| `--info` | Deprecated alias of `--blue`. |
| `--border-subtle` | Deprecated alias of `--border-soft`. |
| `--overlay-bg` | Deprecated legacy floating-surface background; use `--material-glass`. |
| `--overlay-border` | Deprecated legacy floating-surface boundary; use `--material-glass-border`. |
| `--overlay-shadow` | Deprecated legacy floating-surface elevation; use `--material-glass-shadow`. |

## Core UI primitives

`apps/web/src/components/ui/` owns the shared component primitives (Button,
IconButton, inputs, Switch, Tabs, Badge, Spinner, Skeleton, Popover, Menu,
Tooltip, ResponsiveOverlay, …). Their styles live in one `P1-W2` section of
core `styles.css` under the `.ui-` prefix. New core UI composes these
components instead of minting new button/menu/dialog classes; packages adopt
them per-package during Phase 1c. UI action icons come from `ui/icons.ts`
(Lucide) sized by the icon tokens; domain/project identity marks keep their
existing assets. `docs/ui-redesign/design-system.md` is the usage guide.

Popover, Menu, Dialog, Sheet, Picker, and ResponsiveOverlay use the Quiet
Glass material tokens. Their default is opaque and readable. Core CSS adds
translucency only inside a backdrop-filter `@supports` rule and restores the
opaque material for reduced motion or
`body[data-desktop-low-resource="true"]`; packages must not apply blur or
recreate this fallback locally.

## Shared empty states

Core exposes one primitive with three size variants:

- `.empty-state--compact`: an inline prerequisite or no-results message.
- `.empty-state--panel`: a bounded state for a rail, card, or docked panel.
- `.empty-state--page`: the primary full-page first-run or error state.

Use one state at a time. A prerequisite state either owns one primary action
or defers to the visible parent action. Do not stack a passive placeholder
beside or above a second first-run card.

## Responsive rules

Feature content can render full-page, in a docked rail, or in a Canvas card.
Its layout therefore responds to its container:

```css
.usage-dashboard {
  container: usage-dashboard / inline-size;
}

@container usage-dashboard (max-width: 520px) {
  .usage-dashboard .usage-dashboard-hero {
    grid-template-columns: 1fr;
  }
}
```

Use container queries for package panel/card layout and scope every queried
selector to the package root. Viewport media queries are only for shell-level
behavior such as the global sidebar, application header, software keyboard,
safe areas, and bottom navigation.

## Package additions checklist

Packages may:

- consume every canonical token;
- add a package-prefixed custom property scoped under their root;
- add component selectors under their own root;
- request a new core semantic token or primitive when multiple packages need
  the same role.

Packages must not:

- add `:root` declarations or copy canonical token values;
- create local aliases for canonical spacing, radius, type, or color roles;
- style another package, a generic core class, or unscoped HTML globally;
- copy shared empty-state, tab-scroll, button, card, or form-control blocks;
- use viewport width to lay out embeddable panel/card content.
