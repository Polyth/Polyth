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
| `--app-background-image` | Decorative workspace backdrop selected by the user; preset choice is mirrored by account settings, while an uploaded image stays on its device. |
| `--border` | Structural boundary. |
| `--border-soft` | Decorative separator that does not identify a control. |
| `--contour` | The theme's one contour: the edge every glass surface and shell control draws (both rails, the top rail card, header capsules and glyph buttons, the session title, the composer, menus, popovers, help tags, dialogs, sheets and the sessions peek). Resolved on the root, so *Hide interface borders* cannot thin it; each style recipe sets it to its own stroke, and `--material-glass-border` is this token. |
| `--borderless-edge` | Subtle 12% ink line for intentional lines inside content that survive *Hide interface borders*: the chat activity thread, the outlines of the activity and composer-status looks, the lock screen's fields and a file drop target. Not a surface contour; use `--contour` for those. |
| `--control-border` | Recognizable input, button, and interactive-card boundary; stronger on light themes. |
| `--surface-divider` | Divider between adjacent surfaces. |
| `--hair` | Lowest-emphasis hairline. |
| `--hair-strong` | Stronger hairline for hover and internal grouping. |
| `--hair-solid` | `--hair` pre-composited over the chrome glass base. Use it for one edge shared by surfaces with different or transparent fills (the right rail host and its package window), where a translucent hair would take on whatever lies beneath it. |
| `--text` | Primary text. |
| `--text-dim` | Secondary text that still needs clear emphasis. |
| `--muted` | Supporting copy and metadata. |
| `--faint` | Lowest-emphasis readable metadata. |
| `--chat-ink-dim`, `--chat-ink-muted`, `--chat-ink-faint`, `--chat-ink-green`, `--chat-ink-red` | The chat's plateless inks. Inside `.timeline` and the lines above the composer they replace `--text-dim`, `--muted`, `--faint`, `--green` and `--red`; see "Wallpaper wash" below. |
| `--chat-ink-accent` | Accent as small text in plateless chat chrome (the edited-files *Review* action): `--accent-text` mixed toward the wash anchor so it keeps 4.5:1 over a wallpaper. |
| `--chat-wash-anchor`, `--chat-wash-dim`, `--chat-wash-quiet`, `--chat-wash-faint`, `--chat-wash-hue`, `--chat-wash-accent` | The anchor these inks move toward (`--text`, or a step past it under an opposing wallpaper) and each ink's share of it. Set only by the wash rules in `styles.css`. |
| `--control-disabled-bg` | Fill of a disabled button chip; derived from `--text`, so every theme stays in tone. |
| `--control-disabled-border` | Edge of a disabled button chip. |
| `--control-disabled-ink` | Label and glyph of a disabled button: visibly unavailable, still identifiable (about 3:1). See "Buttons" in [the design system](design-system.md#buttons). |

The Appearance page's **Hide interface borders** preference clears component
border colors throughout the shell and active packages: separators and the
lines inside a surface go. Contours are not borders: every glass surface and
shell control keeps the theme's `--contour` (the list is in the token table
above). Both rails keep their block frame and their workspace-facing seam on
it, and the composer keeps its outline; a style recipe may firm a focused
composer's contour but never blanks it or draws a ring of another stroke in its
place. Keyboard focus indicators and task-state marks stay visible through
their own outline/shadow signal instead of a structural border. A surface whose
glass would otherwise paint under a translucent contour sets
`background-clip: padding-box`, so the contour composites over the page instead
of its own bright fill and every contour reads at the same weight.
Affordances keep their edge: a checkbox keeps its outline and a file drop target
its dashed `--borderless-edge`. The few intentional contours in a transcript keep
theirs too: the agent activity thread, the Ledger hairlines, the Chip and
Capsule outlines, the edited-files thread and the subagent branch's thread
(mixed toward the accent or amber) are backgrounds or inset shadows drawn from
`--borderless-edge`, and the inline command Stop keeps its red
outline through an explicit `!important` exception. Markdown structure is
content, not an outline: a quote (`.md-quote`) is a tinted panel whose accent
bar is a `::before` background, and a `---` rule (`.md-hr`) and a table's
header and row lines are backgrounds or inset shadows from `--borderless-edge`,
so a quote never degrades to a bare indent. Activity rings drawn as
borders are signals, not outlines, and keep theirs the same way: `.ui-spinner`,
a session row's running ring (`.session-lead-spinner`, also in the subagent
branch) and the phone navigator's `.mobile-nav-running-ring`. Never draw an intentional line from
`--hair*`/`--border-soft`; borderless mode sets them to transparent.

**Wallpaper wash.** A wallpaper is painted under 76% of `--bg`, and chat chrome
without a plate (activity blocks, the agent status and edited files above the
composer) reads its quiet inks straight off it. `--muted`, `--faint` and the
diff hues are tuned against `--panel`, so a wallpaper that fights the
appearance (the dark default *Signal Bloom* under a light theme, *Paper Prism*
under a dark one) pulled them to 2.8–4.2:1 and Solar's `--text-dim` to 3:1.
The wash rules in `styles.css` move those inks toward `--chat-wash-anchor` by
per-ink shares: a little under any wallpaper, more under one that fights the
appearance, where the anchor is a step past `--text`. A light theme's diff
hues get a share even on a flat `--bg`; the accent starts from the text-safe
`--accent-text`.

Which wallpapers fight is measured, not listed: `html[data-background-tone]`
is `light` when even the darkest 5% of the painted image has a relative
luminance of at least 0.40, `dark` when its brightest 5% stays at or below
0.25, else `mixed` (`classifyBackgroundTone` in `backgrounds.ts`). A preset
carries its tone, measured on 430×932 and 1440×900 frames; a custom image is
sampled when applied. A light theme takes the strong shares on any tone but
`light`, a dark theme on any tone but `dark`, and both take them while a
custom image is still unread (no attribute). The strong shares hold 4.5:1 over
any image, down to pure black under a light theme and pure white under a dark
one, so a mis-measured or mixed image can only lose hierarchy, never
legibility. `apps/web/test/chatWallpaperWash.test.ts` checks every preset
theme, in both appearances and with every platform accent, against every
preset wallpaper's stops and bloom peaks and those extremes at 4.5:1, and
that each preset's tone matches its colours. The scope also covers older
transcript rows (tool previews, durations, response meta) because they share
these inks.

### Accent, status, and overlays

| Token | Purpose |
| --- | --- |
| `--accent` | Primary brand/action color. |
| `--accent-ink` | Text or glyph on a solid accent. |
| `--accent-hi` | Highlight end of an accent treatment. |
| `--accent-text` | The accent as small text: `theme.ts` moves its lightness (hue kept) only until it holds 4.5:1 on `--bg`, `--panel` and `--elevated`. `--accent` is tuned as a fill under `--accent-ink` and can be unreadable as text (macOS 27's dark blue is 3.5:1 on its window), and any accent colour can be chosen. |
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
| `--material-glass-medium` | Theme-derived medium glass material for bubbles and compact summaries. |
| `--material-glass-chrome` | Theme-derived strong chrome material for persistent floating controls. |
| `--material-glass-border` | Glass edge; it is the theme's `--contour` (style recipes set `--contour`, not this alias). |
| `--material-glass-highlight` | Inset highlight shared by glass surfaces. |
| `--material-glass-shadow` | Shared floating-surface elevation. |
| `--material-glass-blur` | Backdrop blur strength for capable, full-resource clients. |
| `--material-glass-fill` | User-controlled center tint for live glass surfaces. |
| `--material-glass-edge` | User-controlled edge tint for live glass surfaces. |
| `--material-glass-control-fill` | Center tint for controls nested inside a glass surface. |
| `--material-glass-control-edge` | Edge tint for controls nested inside a glass surface. |
| `--material-glass-readable-fill` | Mode-aware center floor for text-bearing glass surfaces. |
| `--material-glass-readable-edge` | Mode-aware edge floor for text-bearing glass surfaces. |
| `--material-glass-readable-control-fill` | Mode-aware center floor for nested controls with readable labels. |
| `--material-glass-readable-control-edge` | Mode-aware edge floor for nested controls with readable labels. |
| `--material-glass-mobile-chrome-fill` | Lighter mode-aware center tint for phone navigation destinations that should retain a blurred hint of conversation content. |
| `--material-glass-mobile-chrome-edge` | Lighter matching edge tint for those phone navigation destinations. |
| `--material-glass-saturation` | User-controlled backdrop color response for live glass surfaces. |
| `--material-glass-texture` | Top image layer of live overlay glass (popovers, pickers, menus, tooltips); `none` by default. A theme style may set a grain (Fluent: acrylic noise); opaque fallbacks never paint it. |
| `--surface-activity` | Lightweight theme surface for the task-list card. The agent activity block has no surface. |

### Spacing and control geometry

The desktop session rail measures header clusters in the logical inline
direction and uses logical insets, so its available space remains correct
when the locale switches between LTR and RTL.

| Token | Purpose |
| --- | --- |
| `--space-1` | 4px spacing step. |
| `--space-2` | 8px spacing step. |
| `--space-3` | 12px spacing step. |
| `--space-4` | 16px spacing step. |
| `--space-5` | 24px spacing step. |
| `--space-6` | 32px spacing step. |
| `--density-scale` | Active interface-density multiplier used by conversation geometry. |
| `--gutter` | Standard desktop content gutter; aliases `--space-5`. |
| `--screen-gutter` | Compact/phone screen gutter; aliases `--space-4`. |
| `--chat-measure` | Shared reading measure for the chat timeline, composer, and inline conversation widgets. |
| `--conversation-inset` | Density-scaled conversation gutter. |
| `--conversation-chrome-inset` | Density-scaled viewport inset for floating conversation chrome. |
| `--conversation-related-gap` | Gap between tightly related conversation content. |
| `--conversation-row-gap` | Gap between repeated activity rows. |
| `--conversation-group-gap` | Gap between activity or response groups. |
| `--conversation-message-gap` | Gap between separate conversation messages. |
| `--prose-gap` | Font- and density-scaled rhythm inside rendered response prose. |
| `--tap` | Minimum 44px interactive hit dimension. |
| `--control-h-sm` | Compact 32px control visual. |
| `--control-h` | Standard 40px control visual. |
| `--control-h-lg` | Large 48px control visual. |
| `--control-pad-x-sm` | Horizontal padding for compact controls. |
| `--control-pad-x` | Horizontal padding for standard controls. |
| `--control-gap` | Gap between a control's glyph and its label. |
| `--mobile-island-height` | Density-scaled floating mobile navigation height. |
| `--mobile-session-header-height` | Phone session-title touch height and conversation clearance, including two lines at the selected menu text size. |
| `--activity-row-height` | Density-scaled compact activity/tool row height. |
| `--agent-dock-height` | Density-scaled expanded active-agent dock height. |
| `--composer-height` | Density-scaled resting conversation composer height. |
| `--composer-action-size` | Density-scaled visible send/stop action size. |
| `--composer-max-input-height` | Font-scaled five-line composer input ceiling. |
| `--package-window-header-h` | Shared compact package-window header height. |
| `--package-window-resize-hit` | In-frame resize hit area; host-owned, never package-overridden. |
| `--hit-min` | Density seam: extra hit-area floor. 0px on fine pointers; core raises it to `--tap` under coarse pointers. Use in `max()` with the control's visual size. |
| `--nav-tool-step` | Phone Navigator only (set on `.mobile-navigator`): pitch of the toolbar's trailing tools: the full `--tap` floor, so each tool keeps a 44px box. |

Controls use the smallest visual height appropriate to their density while
retaining a `--tap` hit area on phone/coarse-pointer surfaces. Do not enlarge
switch tracks or glyphs to create the hit area; enlarge the transparent
interactive box around them — the `--hit-min` seam and the `.ui-icon-btn`
pattern in core `styles.css` show the sanctioned mechanism.

That transparent box may reach past its container's edge, and it counts as
scrollable overflow even while its control is `visibility: hidden`. A
vertical-only scroller therefore declares `overflow-x: hidden` beside
`overflow-y: auto`: `auto` on one axis alone computes `auto` on the other, so
a few pixels of overhang make it a sideways scroller that a finger pans (iOS
bounces it far past the overhang) and that `contentOwnsSwipe`
(`swipeSurface.ts`) treats as owning horizontal swipes. The transcript and
the phone new chat follow this (`heroSidewaysPan.test.ts`).

One exception: a trailing cluster of icon tools set to a chat row's mark
rhythm (the phone Navigator's project New chat and ⋮, `docs/dev/ui.md`; the
Navigator's toolbar tools keep full 44px boxes) cannot give every glyph a 44px-wide box. Each target there
is the full bar or row height and runs to its neighbours' targets, so no tap
falls between them; the width is the room between neighbouring glyphs, never
below WCAG 2.2's 24px (`mobileNavigatorLayout.test.ts` pins both).

An inline control inside prose owns the same floor, but its box must never
claim less height than its own content: a `.resource-link.file-ref` is an
atomic inline, so a long path wraps *inside* it. Grow such a target with
symmetric block padding and remove exactly that padding again with a matching
negative block margin (phone rules live in `resource-link.css`), so the line
box always equals the reference's real height — one line or many. Never pair a
fixed one-line `min-height: var(--tap)` with a fixed negative margin: the
wrapped lines then paint over the prose above and below the reference. Keep
the wrapped reference on the paragraph's reading edge (`text-align: start`)
instead of centring it like a control label.

### Icon sizes

UI action glyphs use the icon scale; never hardcode svg dimensions in new CSS.

| Token | Purpose |
| --- | --- |
| `--icon-sm` | 16px compact/dense-row glyph. |
| `--icon-md` | 18px standard control glyph. |
| `--icon-lg` | 20px prominent control or mobile glyph. |
| `--icon-rail` | 22px glyph shared by the left project rail and the right launcher strip. |
| `--icon-xl` | 24px mobile-emphasis or hero glyph. |

### Rail sizing

Settings → Appearance → Layout → **Rail size and spacing** offers three
presets (Compact / Standard / Large: every rail two 5% steps and the icon gap
one step from the defaults, `railPresetSizes` in
`components/settings/appearanceSizes.ts`; hand-set sizes press none) and,
under *Set each rail*, one percentage per rail (70–130%, default 100%). The preference store publishes the scales on `<body>`; the left
project-rail track and every rail icon box/glyph derive from the same value so
centered glyphs, the sessions column, and adjacent pane offsets stay aligned as
the size changes. Never scale a rail track without its icons, or the icons
without their track.

At 100% both side rails use the `--icon-rail` glyph and a 4px gap between tiles.
The project rail is a 49px track (36px tiles, a 6px gutter each side, the 1px
divider; `SIDEBAR_RAIL_WIDTH` in `sidebarLayout.ts` mirrors it) and the launcher
strip a 41px column (32px tiles, 4px gutters, the 1px seam a docked pane adds).
Every control in them is one tile — the collapse toggle, Add, Settings and the
project icons alike — and a tile's keyboard ring is drawn inside it, because
both lists scroll and would clip an outside ring. Touch widens the gap to 8px
(project tiles then sit on a `--tap` pitch) and a transparent `::after` reaches
`--hit-min`.

| Token | Purpose |
| --- | --- |
| `--rail-scale-left` | Left project-rail icon and track scale (default 1). |
| `--rail-scale-right` | Right launcher-strip icon and track scale (default 1). |
| `--rail-scale-top` | Top-rail control and glyph scale (default 1). |

### Radius

| Token | Purpose |
| --- | --- |
| `--corner-radius-scale` | User-selected multiplier applied to scalable geometry: `cornerRadiusScale(rounding)` in `uiPrefs.ts` — rounding ÷ 5 for 0–9 (the default 9 = 1.8), 2.7 at 10, so the last notch is a visible 1.5× step. Platform styles and interface styles divide it by 1.8 (`--lg-round`, `--fluent-round`, `--macos-round`, `--look-round`) so the default draws their native radii. |
| `--radius-control` | Buttons, fields, chips, and compact controls. |
| `--radius-card` | Cards and bounded empty states. |
| `--radius-surface` | Panels and substantial surfaces. |
| `--radius-sheet` | Sheets and modal shells. |
| `--radius-activity` | Standalone run summaries and the task-list card. |
| `--radius-island` | Floating navigation islands. |
| `--radius-dock` | Active status docks and floating persistent layers. |
| `--radius-composer` | Composer-specific radius when its geometry needs an independent role. |
| `--radius-bubble` | Chat bubbles of people talking in a session. |
| `--radius-round` | Fully rounded pill; stays circular at every corner-radius setting. |
| `--radius` | Deprecated alias of `--radius-control`. |
| `--radius-sm` | Deprecated alias of `--radius-control`. |
| `--radius-md` | Deprecated alias of `--radius-card`. |
| `--radius-lg` | Deprecated alias of `--radius-card`. |
| `--radius-xl` | Deprecated alias of `--radius-surface`. |

Use only the semantic radius roles in new CSS. `50%` and `999px` are reserved
for circles and pills. General controls retain the 8/10/12/16px calm scale;
conversation activity, floating islands/docks, and the composer use their
dedicated semantic roles. A surface pinned inside the transcript (the
permissions request card) is a transcript card and takes `--radius-card`, not
the rounder dock role, so it stays concentric with the Chat bubbles and
notices it sits beside. Every scalable radius follows the user multiplier.

Shell surfaces that touch a viewport edge keep that edge's corners at `0`
regardless of the user multiplier; semantic rounding belongs only to their
interior-facing corners and seams.

### Typography

| Token | Purpose |
| --- | --- |
| `--ui-font-size` | User-selected **menu** text size: navigation, labels, panels, settings, session titles, inputs, and agent activity blocks. |
| `--ui-font-scale` | Published multiplier of the menu text size (`fontSize / 15`). The build transform falls back to it for a sheet it never processed. |
| `--chat-font-size` | User-selected **chat** text size: messages and the composer. Independent of the menu size. |
| `--chat-font-scale` | Published multiplier of the chat text size (`chatFontSize / 15`). |
| `--text-scale` | Effective multiplier of the *current text surface*: the menu scale on the shell canvas, the chat scale inside a conversation surface. Every size role multiplies by it, and the build transform rewrites fixed-pixel `font-size` declarations to it. |
| `--header-font-size` | User-selected page, section, and surface heading size. |
| `--subheader-font-size` | User-selected subheading and navigator project size. |
| `--font-input` | Editable-control size; coarse pointers floor it at 16px to prevent mobile zoom. |
| `--font-body` | Responsive body role. |
| `--font-title` | Page/title role. |
| `--font-title-lh` | Title line height. |
| `--font-heading` | Content/section heading role: 0.75 × `--header-font-size` (floored at 15px, never above the title); `uiPrefs.sectionHeadingSize` publishes it on body. |
| `--font-window-title` | Window, dialog and sheet title-bar role (15px × `--text-scale`, weight 650). Chrome titles never use `--font-title`/`--font-heading`. |
| `--font-label` | Control and emphasized label role. |
| `--font-meta` | Readable metadata role. |
| `--font-meta-lh` | Metadata line height. |
| `--font-response` | Conversation body role for chat prompts, assistant answers and thinking/reasoning (14.7px default, scaled by the surface's text size). |
| `--font-response-lh` | Final assistant response line height (`1.5` of `--font-response`). |
| `--font-response-heading` | Conversation heading role (one step above `--font-response`). |
| `--font-response-heading-lh` | Conversation heading line height. |
| `--font-session-title` | Floating session-title role. |
| `--font-session-title-lh` | Floating session-title line height. |
| `--font-session-title-compact` | Compact phone session-title role (13.25px at the default menu scale). |
| `--font-session-title-compact-lh` | Compact phone session-title line height (18px at the default menu scale). |
| `--font-activity-title` | Activity group/step title role. |
| `--font-activity-title-lh` | Activity title line height. |
| `--font-tool-label` | Compact tool action label role. |
| `--font-tool-label-lh` | Compact tool label line height. |
| `--font-technical` | File path, command, and technical value role. |
| `--font-technical-lh` | Technical value line height. |
| `--font-response-meta` | Response and activity metadata role. |
| `--font-response-meta-lh` | Response metadata line height. |
| `--font-code` | Code-surface role for blocks, diffs and the editor (follows `--editor-font-size` and pairs with `--mono`). Inline code inside conversation prose keeps the sentence's own caliber. |
| `--terminal-font-size` | User-selected terminal input/output size. |
| `--editor-font-size` | User-selected editor and code-surface size. |
| `--mono` | Monospace stack. |
| `--ui-font-family` | Active application font stack. |

#### Interface fonts

Polyth bundles curated, high-performance variable `.woff2` fonts served locally (`font-src 'self' data:`):
- **UI Sans:** Open Sans (default), Inter, Montserrat, Roboto, Noto Sans, Geist, Plus Jakarta Sans, Figtree, Outfit, DM Sans, Manrope, Atkinson Hyperlegible, and native System UI.
- **Serif:** Source Serif 4 (editorial reading typeface).
- **Programmer Monospace:** JetBrains Mono, Fira Code, Geist Mono, Cascadia Code, and native System Monospace.

All web font files reside in `apps/web/src/assets/fonts/`, are declared in `apps/web/src/fonts.css` with `font-display: swap`, and are copied to `dist/assets/fonts/` during the web build. They are all SIL OFL 1.1 fonts: a new font adds its copyright notice to `OFL.txt` and a row to the [font provenance table](../../apps/web/src/assets/fonts/README.md) in that directory.

Meaningful metadata uses `--font-meta`; 10–11px literals are only for
tertiary decorative labels, never instructions or state. Navigator session
titles use `--ui-font-size`; worktree names follow that size at exactly
`1px` larger and keep the semibold (600) label weight, independently of
`--subheader-font-size`.

#### Type surfaces

Type has two surfaces because the user has two text-size settings. The shell
canvas (navigation, settings, panels, pickers, docks) reads the **menu** size;
a conversation surface (`.focus-conversation`, `.widget-conversation`) reads
the **chat** size. An agent activity block (`.activity-group`) inside a
conversation returns to the **menu** size, and so does the above-composer agent
status dock (`.agent-status-dock`, with the subagent island it heads,
`.subagent-island`). Prompt-history panels
(`.prompt-nav-panel`) also use the **menu** size, including the portaled bookmark
and desktop navigator nested inside a conversation.

`tokens.css` declares every size role once, on a selector list that names both
kinds of surface, and each surface only re-binds `--text-scale`. This is
deliberate: a custom property resolves its own `var()` references where it is
*declared*, not where it is read, so a role declared only on `:root` would keep
the menu caliber inside a transcript no matter what `--text-scale` says. Roles
that derive from other roles (`*-lh`, `--prose-gap`,
`--composer-max-input-height`) are part of that same list for the same reason.

New type roles belong in that block, expressed as `calc(<base px> *
var(--text-scale, 1))`. Never bind `--ui-font-scale` or `--chat-font-scale`
directly from a role: a rule that hardcodes one surface's scale is exactly the
leak the split exists to remove. `apps/web/test/appearanceTextSizes.test.ts`
pins the caliber of every role and fails if a role is declared outside the
block.

A record written before the split carries no `chatFontSize`; `normalizeSettings`
seeds it from that record's `fontSize`, so an existing profile keeps the
transcript caliber it already had.

Conversation prose is one caliber. The default response size is `14.7px`
(`calc(14.7px * var(--text-scale, 1))`, i.e. `0.98` of the surface text size),
and headings inside a message step down from `--font-response-heading`
to `--font-response` and never below it. An inline code span inherits its
sentence (`1em`) rather than dropping to `--font-code`; it is a translucent
`--text` tint, and package cards anywhere in the transcript column
(`:where(.timeline-viewport)`, e.g. Key callouts) get the same chip by default
instead of the opaque global `code` fill. A Markdown table
keeps the answer size for both its header and its cells. Code *blocks* stay
the one intentionally distinct step, because they are framed surfaces rather
than prose words.

A Markdown table is a grid, not a paragraph that happens to have rules. It
must read correctly at any width and with any cell text, so the renderer wraps
it in `.md-table-scroll` and the CSS gives the table `width: max-content;
min-width: 100%`. The wrapper, never the cells, absorbs a narrow column: a wide
grid scrolls sideways (with `overscroll-behavior-inline: contain` and a
`scrollbar-gutter`) and its columns keep their content width instead of
collapsing. Cells break only between words (`word-break: normal`,
`overflow-wrap: break-word`, `hyphens: none`, `min-width: 6ch`), so a word such
as `Модель` is never split one letter per line the way a squeezed auto table
does; an inline code token in a cell stays whole (`white-space: nowrap`). The
region is focusable and labelled (`role="region"`, `aria-label` from
`markdown.table`) so keyboard and screen-reader users reach the overflow. A
consumer must not make the table itself `display: block` to scroll it — that
destroys the internal table layout; it relies on the host wrapper.

A thought is conversation prose, not a separate type step. The reasoning
separator (`.reasoning-preview`), its expanded body and its live activity row
all use `--font-response` / `--font-response-lh`, so a message never mixes a
`14px` thought with a `14.7px` answer; the thought stays visually quieter
through `--text-dim` color and its two-line clamp, and its code blocks reuse
the answer's `--font-code` surface. Tool rows, file/image names and other
compact metadata keep the separate `--font-tool-label` role.

### Viewport and safe-area layout

| Token | Purpose |
| --- | --- |
| `--visual-vh` | Current visual viewport height published by mobile viewport code. |
| `--visual-frame-top` | Top of the mobile interaction frame in layout coordinates. |
| `--visual-frame-height` | Height of the mobile interaction frame (layout viewport while the keyboard is closed, visual band while it is open). |
| `--visual-frame-bottom` | Lower edge of the mobile interaction frame (top + height). |
| `--visual-bottom` | Compatibility alias for `--visual-frame-bottom`. |
| `--layer-frame-bottom` | Lower edge shared by the app chain and every full-height fixed layer while the keyboard is open: `--visual-frame-bottom`, plus `--keyboard-accessory-band` on WebKit (see [mobile viewport](mobile-viewport.md#full-height-layers)). |
| `--keyboard-inset` | Layout left below the visual band in a Safari pan, or the native keyboard height in a native-resize WebView. Not a height a layer may subtract; see [mobile viewport](mobile-viewport.md#full-height-layers). |
| `--visual-offset` | Compatibility alias for `--visual-frame-top`, used as the `top` of sheets and dialogs: the pan offset while the keyboard is open, 0 while it is closed (see [mobile viewport](mobile-viewport.md#restyle-cost)). |
| `--keyboard-accessory-band` | WebKit text-input accessory height added to the open-keyboard frame (see [mobile viewport](mobile-viewport.md)). |
| `--safe-top` | Top safe-area inset. |
| `--safe-right` | Right safe-area inset. |
| `--safe-bottom` | Bottom safe-area inset. |
| `--safe-left` | Left safe-area inset. |
| `--safe-right-clear` | `--safe-right`, plus `--space-2` when the inset is 72px or more (iPhone Duo's status column, which holds the launcher strip). Chrome beside the column uses it so it never meets the column's edge; a notch keeps its exact inset. |
| `--safe-left-clear` | The same for the left inset. |

### Layering

New overlay CSS layers through the z-scale; legacy hardcoded z-indexes migrate
to it during the Phase 1 cleanup.

| Token | Purpose |
| --- | --- |
| `--z-shell` | Shell chrome (sticky headers, rails, bottom navigation). |
| `--z-stack-workspace` | Phone Workspace layer: above the session header/floats (`--z-shell + 2`), below package windows. |
| `--z-stack-package` | Phone package window: above the Workspace it was opened from. |
| `--z-overlay` | Modal surfaces (dialogs, sheets, full-screen overlays). |
| `--z-toast` | Transient toasts and error banners, above modals. |
| `--z-popover` | Anchored transient surfaces (menus, popovers) above any opener. |
| `--z-tooltip` | Tooltips, topmost. |

### Focus, elevation, and motion

| Token | Purpose |
| --- | --- |
| `--focus-ring` | High-contrast focus outline. |
| `--scrim` | Modal backdrop. |
| `--scrim-media` | Near-opaque dark field behind the full-screen media/attachment viewer, in every theme. |
| `--shadow-sm` | Small control/card elevation. |
| `--shadow-md` | Popover elevation. |
| `--shadow-lg` | Modal/sheet elevation. |
| `--inset-hi` | Subtle inset surface highlight. |
| `--motion-fast` | Immediate interaction transition. |
| `--motion-normal` | Standard component transition. |
| `--motion-surface` | Larger surface entrance/exit transition. |
| `--motion-ease` | Shared application easing curve. |
| `--motion-stack`, `--motion-stack-ease` | Full-screen phone layer travel (push, Back, dismiss); `motionPresence.ts` reads the duration to time the unmount. |
| `--motion-window`, `--motion-window-ease` | A desktop package window's arrival out of its launcher rail: the floating glide, the docked frame and its content, the launcher seam, the tablet cluster's dock and the focused split's entry, on one clock (`ui.md` "Window motion"). |
| `--motion-window-exit`, `--motion-window-exit-ease` | The quicker, accelerating departure back into the rail. `PANE_EXIT_FALLBACK_MS` in `ContextRail.tsx` must stay longer. |
| `--motion-window-travel` | How far a floating window glides out of its rail (the desktop fullscreen layer moves a quarter of it); `--stack-dir` mirrors it. |
| `--motion-keyboard`, `--motion-keyboard-ease` | The iOS keyboard's slide, until the native shell reports the real one (`keyboardMotion()` in `motionPresence.ts` returns it; it is never written back onto `<html>`). The phone composer dock and its transcript ride the keyboard on it (`keyboardRide.ts`, see `docs/dev/mobile-viewport.md`) and the composer morphs between its resting row and engaged card on it. |
| `--stack-parallax`, `--stack-dim` | How far the covered phone layer retreats and how much it dims. |
| `--stack-dir` | `1`, or `-1` under any `[dir="rtl"]` (an RTL locale on `<html>`, or the frames of a mirrored shell): mirrors every stack and window transform. |
| `--shadow-stack-edge` | Leading-edge shadow of a layer travelling over another. |
| `--shadow-drawer-edge` | Trailing-edge shadow of a drawer travelling in from the inline start (the phone Navigator during a swipe). |

#### Top rail surface

Settings → Appearance → Window layout → **Top bar style** chooses how the top
rail meets the workspace below it. The row shows only for the layouts that
draw a bar slab (Classic, and Columns with a spread bar); the island and the
bare title force `floating`. The value is a UI preference (`topRailSurface` in
`uiPrefs.ts`), published on `<body>` by `applyUiSettings` and rendered by
`Header` onto the rail element as `data-top-rail-surface`. The rail element
carries it so the shared glass material rules can skip the rail entirely.

| Value | Rail edge | Rail shadow | Rail material |
| --- | --- | --- | --- |
| `shadow` (default) | yes | yes | glass slab |
| `flat` | none | none | glass slab |
| `floating` | none | none | none |

The rail paints from more than one shell rule — the wide composition's card at
`min-width: 961px` and the compact strip below it — so every rule that paints
the rail's background or blur must keep the
`:not([data-top-rail-surface="floating"])` opt-out. Those rules set the gradient
and `backdrop-filter` with `!important`, so a body-scoped override cannot
out-rank them; adding a rail background outside that opt-out silently
reintroduces the slab and `floating` stops floating. When editing the wide card
rule, keep `width`/`margin` in the unconditional part so a floating rail still
occupies the same box. The rail's own controls (`.workspace-mode-switch`,
`.view-switcher-pill`) keep their surfaces in every mode — they are the elements
that read as floating.

#### Interface styles

Settings → Appearance → **Look** picks a whole-shell look (`shellLook` in
`uiPrefs.ts`, default `standard`, shown as **Standard**). `applyUiSettings`
publishes it as `body[data-shell-look]`, so a change restyles the open shell
at once. The looks live in `apps/web/src/shellLooks.css`, which `main.tsx`
imports last. The picker in `components/settings/ShellLookPicker.tsx` draws
each look as a token schematic in the active theme, standing like a window on
the background in use. A look restyles the shell only: picking one
(`pickShellLook`) never changes the workspace background the person chose.

The Appearance page runs from the whole to the parts: **Look**, **Color**
(mode, the one searchable scheme picker, accent, skin import), **Controls**
(`themeStyle`, see "Theme layers"), **Background and surfaces** (the
workspace background, its **Panel transparency** and **Hide interface
borders**), **Window layout** (the layout cards with each layout's own
options, the top bar style and **Mirror layout**), **Text**, **Layout**
(density, rail size and spacing, rounding, status bar) and the **Tablet
toolbar**. `shellLooks.test.ts` pins the section order and which section owns
each of those rows.

Each family of sizes leads with one control and keeps its per-part rows one
click under it (`SizeDetails` in `pages.tsx`): **Text size** moves all six
text sizes by the same step (`shiftTextSizes`; the number shown is the chat
size), and the rail presets set all four rail values. A settings-search hit
or deep link on a collapsed row reaches the page as its `settingsTarget` and
opens that group. The tablet toolbar editor is open at tablet width and waits
behind *Show* elsewhere. Schemes that ship with a style share its name
(Polyth, Big Sur, macOS 27), so their rows in the picker add "made for the …
style". Behaviour rows live with their owners: swipe navigation in General,
the dictation button and composer quick actions in Chat → Composer
(`appearanceSimplified.test.ts`).

A look paints Settings' material on the shell and clears the list and page
fills. On the phone, the page is pushed over the list in the same grid cell, so
both are on screen for the whole slide (`surfaceMotion.css`). There the page
paints `--look-overlay-solid` (the look's overlay material, opaque; default
`--look-float`) over `--bg`, or the list reads through it.

| Value | Character |
| --- | --- |
| `standard` | Today's glass shell. No rule in `shellLooks.css` matches it. |
| `paper` | One flat sheet with no panels. The composer is a ruled line and the prompt a quoted passage. |
| `line` | A hairline grid: columns and the composer form are drawn by lines, with 6px corners and mono figures. |
| `air` | Soft islands with diffuse shadows and pill shapes, and no lines. |
| `monolith` | Chrome on a deep backdrop; the conversation is one raised sheet with a short, light shadow. |
| `monolith-reverse` | A lit chrome plane with the conversation recessed into it. Raised pieces (composer, prompt, cards) are made of the plane; navigator selection is carved down to the well. |
| `obsidian` | Rimmed glass with gradient edges, an aurora backdrop and a glowing composer. In light mode it reads as pearl. |
| `editorial` | Source Serif 4 titles and prompts, a small-caps index navigator and a letter-field composer on warm paper. |

Six workspace backgrounds in `backgrounds.ts` were drawn alongside the looks.
They are ordinary presets the person picks; no look selects one:
- Linen Dawn — Paper and Editorial;
- Drafting Grid — Line;
- Cloud Drift — Air;
- Basalt — Monolith;
- Dusk Ridge — Reverse monolith (inline SVG, allowed by the `img-src data:` CSP);
- Aurora — Obsidian.

These six follow the theme. The top-level art belongs to one appearance, and
the `dark` or `light` variant holds the other's, with its own description, so
each theme gets an image in its own tone. `backgroundPresetArt(id, appearance)`
resolves the variant. `applyBackgroundToDom` paints it and repaints it on
`polyth:theme`, and the picker tiles show the current theme's art. A tile is
the art as a thumbnail with its name and description under it in `--text` /
`--muted`, never on the art: a scrim over the art muddied the light variants
and missed the copy on short phone tiles. Dusk Ridge
is inline SVG, in night and dawn palettes.

Each art carries two measured values:
- `edge`, the average of the bottom 120px of a 430×932 cover frame, used for
  the keyboard band;
- `tone`, the same measure as the chat's wallpaper wash above
  (`classifyBackgroundTone`, 32px-wide thumbnail, phone and desktop crops):
  `light` when the 5th-percentile relative luminance is at least 0.40, `dark`
  when the 95th percentile is at most 0.25, otherwise `mixed`.

`applyBackgroundToDom` publishes the tone of the art it paints as
`html[data-background-tone]`; the wash and the looks' veils both read it. A
custom image is sampled at runtime with the same thresholds; until then the
attribute stays unset. The other presets keep one image in both appearances:
the four dark gradients are `dark` (their glows stay below mid-grey), and
Paper Prism is `light`. `chatWallpaperWash.test.ts` checks every painted
variant, Dusk Ridge's SVG stops and glow included. The
`systemBar` colours of the paired presets are the average of the top 59px of
the standard tinted root (`--bg` at 76% over the art). They are mirrored in
the pre-boot map in `index.html`. `backgrounds.test.ts` pins the variants,
tones, edges and that map.

Every look covers the header, navigator, rails, conversation and composer,
in-flow cards (agent question, isolated-changes card, edited files, agent
status, empty states) and floating surfaces (toasts, menus, tooltips,
dialogs, Settings, the workspace customize panel). The shared block is
organised by role, not by component, so a control a platform style paints at
class strength joins a role instead of getting a rule of its own:

| Section | Role | Members (examples) | Tokens |
| --- | --- | --- | --- |
| 1 Flatten | No base glass, fill, shadow or border | columns, composer, the status bar, a kept top-rail slab, quiet icon buttons, a code block's header band, Fluent's dialog footer band | — |
| 1a Rules | The dividers a look keeps where it flattened a slab; islands and sheets keep none, the ruled looks (Paper, Line, Editorial) draw their line | status bar top, top-rail foot, package pane head, code block header, dialog head and foot | `--look-rule` |
| 1b Selection | One "you are here", hover, press and segmented language; keyboard focus on a menu row keeps `--look-focus-ring` | session rows, rails, mode switch, host tabs and `.seg` (a package's own tabs inside its window or page keep the package's grammar), menu rows (checked; destructive rows stay red), Settings' current page, the model picker's current model; the base and Fluent accent bars beside a current row are removed | `--look-select*`, `--look-hover`, `--look-segment*`, `--look-control*`, `--look-focus-ring` |
| 1c Options and buttons | Quiet chips; the default (quiet) button is an option and the destructive one its red wash; a disabled button keeps the base's neutral look | queue chips, attachments, New-session Shortcuts, prompt suggestion, add-menu tiles, `.ui-btn--quiet`, `.ui-btn--danger` | `--look-option*` |
| 1f Fields | Every text field and select; a field well is the field and its input stays bare | navigator search, picker filter well, `.ui-field-well`, `.ui-input`, `.ui-textarea`, `.sel select`, the theme picker | `--look-field`, `--look-field-edge`, `--look-field-rule`, `--look-field-radius`, `--look-focus-ring` |
| 1g Corners | One radius role per control | rows, menu items, icon buttons, segments → `--look-select-radius`; push buttons, chips, wells → `--look-control-radius` | — |

Role rules use `:is()` where the shared block owns the element; the button
rules use `:where()` so a look that draws its own button (Line's hairline,
Editorial's underline) stays in charge. A field draws its ring and underline
as inset shadows, so it keeps its box; focus adds the `--look-focus-ring`
ring, and an invalid field keeps a red edge. A floating full-height column takes `--look-column-radius`; a flush one
rounds its inner corners with `--look-rail-radius` (`shellLayout.css`).
Package content (a package's own panes and cards inside its window) is the
package's: it follows the theme tokens, not the look.

**Contract:**
- Look-scoped tokens are `--look-*`. Their shared defaults sit in
  `:where(body[data-shell-look]:not([data-shell-look="standard"]))` at zero
  specificity; a default at normal specificity would beat each look's own
  value.
- The shared block maps the real **Workspace background**
  (`html[data-background]`) and **Panel transparency** (`body[data-glass]`)
  settings onto a transparency ladder:
  - `--look-veil` is the canvas over the wallpaper;
  - `--look-veil-soft` is the same for looks whose canvas is a backdrop;
  - `--look-a` is the raised surfaces;
  - `--look-float-a` is the floating surfaces;
  - `--look-overlay-a` is a layer that covers the conversation: the phone
    navigator, Settings and dialogs. Text sits under it, not only the
    wallpaper, so it never drops below 92% (matched rung) and takes the
    floating blur;
  - `--look-blur` is the blur. Without a wallpaper, everything is solid.
- The ladder has two rungs for each Transparency setting:
  - **readable**, the default. It applies to an image in the other
    appearance's tone, a `mixed` image, or a custom image not sampled yet.
    Every layer under text is at least 84% (`--look-veil`, `--look-veil-soft`,
    `--look-a`, `--look-float-a`), so quiet ink keeps 4.5:1 over the image's
    worst part. Transparency then changes only the blur, not readability;
  - **matched**, when `html[data-background-tone]` equals the theme's
    appearance. Even the image's worst part is then within the quiet ink's
    range, so the veils thin out (matte 74/46/84/90, clear 52/30/60/78;
    `--look-overlay-a` 94 / 92).
- With a wallpaper the root paints the raw image and the look paints its own
  veil. A look that writes the conversation straight on its canvas (Paper,
  Line, Air, Obsidian, Editorial) veils that canvas with `--look-veil`, never
  `--look-veil-soft`.
- A look layers over every **Style** (`html[data-theme-style]`): the macOS 27,
  Big Sur and Polyth recipes re-bind the same elements with `!important` at
  class strength (for example the borderless composer ring of
  `liquidGlassTheme.css`, 0-4-2). So every look rule carries id strength,
  `body[data-shell-look…]:not(#\#)` (1-1-1 and up), and wins whatever the
  recipe's selector; the relative order of look rules is unchanged.
  `shellLooks.test.ts` fails on a look rule without it.
- Corners follow **Corner rounding**: every look radius is written at the
  default rounding as `calc(<n>px * var(--look-round))` (`--look-round` =
  `--corner-radius-scale / 1.8`, like the platform styles' divisors), never as
  a literal length; pills (`999px`) and square corners (`0`) stay as they are.
- The base glass is set with `!important` and borderless mode clears every
  border with `!important`, so look overrides are `!important`. Lines a look
  draws on purpose restate their colour.
- The wallpaper glass keeps its blur on `.sidebar`/`.railbar` with a stronger
  selector, so the reset there uses double id strength. Looks that want those
  panels frosted set `--look-shell-blur`.
- Quiet text uses the theme's contrast-checked inks: `--look-ink-dim`
  (`--text-dim`) for idle rows and `--look-ink-quiet` (`--muted`) for meta
  text. Never use an alpha of `--text` or `opacity` on text, because both fall
  below 4.5:1 over a lighter backdrop or wallpaper. A look whose chrome sits on
  a darker plane moves its own inks or backdrop rather than fading them.
- Each look has one selection language, styled once in the shared block. It
  covers the session row (active, hover), the project rail, top-rail tabs, the
  mode switch, right-rail icons and the sidebar filter. A look only sets
  `--look-select*` / `--look-hover` / `--look-segment*` and must not restyle
  those elements itself (`shellLooks.test.ts` checks this). Pinned rows get no
  pill of their own: the pinned section and its pin mark them, in quiet ink.
- Top-rail controls (mode switch, tool strip, session title, header actions)
  take `--look-control*`. The composer's focus outline takes
  `--look-focus-top/-bottom/-side`; the base accent ring never shows through a
  look. The running-send split, queued prompts, the suggested-prompt chip and
  attachment pills follow the look's option tokens.
- Desktop spacing is logical, so a mirrored shell mirrors the looks.
- A raised `.workspace` leaves room for the right launcher strip with
  `--rail-strip-width-right`.
- The launcher strip's gutters are `--rail-strip-gutter-start` (default
  `--space-2`, toward the workspace) and `--rail-strip-gutter-end` (default
  `--space-1`, the window edge). A strip that floats as a card of its own (the
  tablet cluster, Air and Obsidian islands) and every full-height strip
  (`columns`/`bare`, floating or flush — a flush strip has no frame to give
  the edge-side icons air) split the same width evenly; a flush strip is one
  gutter wider (`--space-2` on both sides), mirroring the navigator's rail.
  With Floating columns the workspace ends at the columns' bottom
  (`--shell-edge`).
- A floating package window extends the launcher rail (shellLooks.css §1d).
  It opens over the column's full height (`ContextRail.tsx`, `railHeight`); a
  look whose idle strip is a short island grows it into the column as the
  window opens. Once the host holds a window it has no fill, edge, shadow or
  filter of its own. The window and the strip share one material
  (`--look-rail*`) and are parted by a seam. The foot squares where the column
  runs into the window's edge and rounds on an island
  (`--look-rail-island`, `--package-window-foot`). A height set by a resize
  lasts until the window closes.
- A pinned (docked) window is part of the rail column (shellLooks.css §1e). It
  and the strip take the idle rail's material (`--look-dock*`: none by default,
  so they sit on the canvas as the idle rail does; Line and Editorial keep the
  rail's hairline down the window's start; Air and Obsidian keep their island).
  A flush column runs square into the header and the window's edge; an island
  closes the frame and rounds. A look that insets the conversation for the idle
  strip (Monolith, Reverse monolith) drops that inset once a window docks, and
  dock admission measures Chat's margin box, so the inset never promotes a pin
  to the full-screen layer. In the classic layout the Monoliths' launcher
  column ends on the sheet's foot line, so a window it opens (floating or
  docked) is a second raised plane level with the sheet, a floating window's
  free foot corner rounded like the sheet's.
- Never put a backdrop filter on an element that holds glass of its own: it
  bounds that glass's backdrop, so the conversation shows through sharp. A look
  frosts its canvas on `.app::after` (`--look-canvas-blur`). The open rail host
  and the rail-collapsed navigator stay unfiltered.
- In the full-height layouts the bar stops a column gap before the idle
  launcher strip, as it starts a gap after the navigator (Header.tsx
  `useShellBarFrame`).
- `apps/web/test/shellLooks.test.ts` pins:
  - one layer per look;
  - no rule for `standard`;
  - the import order;
  - token-only colours;
  - the ladder, including the readable rung's 84% floor, the overlay's 92%
    floor and the conversation canvases of Air and Obsidian;
  - id strength on every look rule.

#### Window layout

Settings → Appearance → Window layout (`ShellLayoutSection`) chooses whether the
side columns run the full window height. The account preferences live in
`uiPrefs.ts` (`shellLayout`, `shellBarStyle`, `floatingColumns`,
`shellToolsDock`, `shellActionsDock`, `shellTitle`); `shellLayout.ts` resolves
them to the layout in effect, and `App` publishes it on `<body>` **for the wide
shell only** — tablet and phone always resolve to `classic` and keep their
headers:

| Attribute | Values | Meaning |
| --- | --- | --- |
| `data-shell-layout` | `classic` · `columns` · `bare` | `classic` is the composition in `styles.css`; nothing in the layout layer applies to it. A fresh install is `bare` with floating columns; a saved record without the field stays `classic`. |
| `data-shell-bar` | `spread` · `island` | `columns`/`bare` only. The bar between the columns as a full-width slab or one centred capsule. |
| `data-shell-floating` | `true` · `false` | `columns`/`bare` only. Columns inset from the window edges by `--shell-edge` with surface radii. |

The geometry is one layer, `apps/web/src/shellLayout.css`, imported after the
theme recipes. It is geometry only: insets, radii and sizes come from canonical
tokens (`--space-*`, `--control-h`, `--radius-*`, the rail tile tokens) and it
paints no colour, material or type, so every theme style and look composes with
every layout. Every rule is scoped to `body[data-shell-*]` (or the sidebar's
own `:has()` / collapsed-rail hooks); `shellLayout.test.ts` enforces the scope
and the absence of colour literals.

- In `columns` and `bare` the `Header` is laid over the top of the workspace,
  not above `.app-shell`. Header measures the workspace box and publishes
  `--shell-bar-left/right`, plus `--shell-bar-reserve-left/right` where the
  idle launcher strip or a floating package window overlays the workspace
  edge (`shellBarReserves` in `shellLayout.ts`: the bar ends one column gap
  before them, so a window never covers the title or the header actions); the
  workspace steps down by `--shell-bar-block`, so nothing renders beneath the
  bar. A fullscreen pane starts below the bar in `columns`.
- The status bar spans the workspace and, in the wide shell, ends one column
  gap short of the idle strip (plus `--shell-edge` with Floating columns), the
  gap that parts it from the navigator; it reserves nothing while a pane is
  open or the strip is hidden, and in the tablet band only holds its
  segments clear of the strip cluster (`StatusBar.css`). A look whose
  workspace is a sheet that already clears the strip (the Monoliths) spans
  the sheet.
- The island capsule is `div.shell-island.ui-glass-island` — the canonical
  glass primitive — and the header element sets
  `data-top-rail-surface="floating"` so the top-rail slab rules above skip it.
  `bare` does the same; its bar is only a quiet chat title line (and the Space
  switcher with several Spaces), and without either the workspace reaches the
  top.
- Up to `1400px` (the tablet band of the wide shell) the idle launcher keeps
  its floating cluster; full-height strip insets apply from `1401px`.
- Desktop app: `.app::before` is the window drag band (the title bar or the
  caption band, whichever is taller; Linux centres its band on the bar's row,
  taller with Floating columns and the island capsule, while Windows keeps its
  32 px native caption), and nothing renders under the caption zone
  (`--desktop-caption-left/-right`, keyed on `data-desktop-caption`; see
  [Desktop](desktop.md#window-chrome-and-interaction)): the workspace starts
  where the band ends (`--desktop-caption-band`, the larger of the bar block
  and the band), a navigator under the zone starts its content below the
  band, the launcher column under it starts below the band in every
  placement, and the bar stops a column gap short of it. Sides are physical;
  `:dir()` of `.app-shell` says which column a mirrored shell puts under the
  zone.
- **The layout owns the columns' geometry, a look owns their material.** The
  looks shape the classic shell's columns at id strength with `!important`
  (a flush grid for Line and Editorial, islands for Air and Obsidian, a raised
  sheet with its own margins for the Monoliths). In `columns` and `bare` a
  block of `:not(#\#)` + `!important` rules in `shellLayout.css` restates the
  workspace step-down (`--shell-bar-block`), the navigator's margins and
  height, and the launcher strip's margins and stretch (Air and Obsidian
  start-align their classic strip as a short cluster, and an absolutely placed
  box honours `align-self`), so the bar never covers the chat, both columns
  run the full height and **Floating columns** does what it says under every
  look. A floating
  navigator takes `--look-column-radius` (every look sets one: Paper and
  Editorial their float corner, the Monoliths their rail corner, Line 6px, Air
  22px, Obsidian 18px, all at default rounding), else `--radius-surface`; a
  floating launcher strip takes `--look-strip-radius` (Obsidian's 999px
  capsule), then the column radius, then `--radius-surface`, so both floating
  columns share one corner. A flush column squares its window-side corners
  and rounds both inner ones with `--look-rail-radius` (square in Line and
  Editorial), the slab bar between the columns with the
  column radius. Line and Editorial columns have no fill, so when they float the
  look closes their hairline on every side.
- Under a look the island is painted by `shellLooks.css` in the look's float
  material (`--look-float*`, like a menu) as a 999px capsule, and the controls
  inside drop the look's control plates. On any style the controls inside the
  capsule also drop borderless mode's restored contour, so the capsule is the
  only surface.

### Chat and syntax

| Token | Purpose |
| --- | --- |
| `--bubble-user-bg` | User-message surface derived from the active accent. |
| `--bubble-user-line` | User-message boundary derived from the active accent. |
| `--bubble-person-bg` | Someone else's person-message bubble (the reader's own uses `--accent`). |
| `--syntax-kw` | Syntax keyword color. |
| `--syntax-str` | Syntax string color. |
| `--syntax-cmt` | Syntax comment color. |
| `--syntax-num` | Syntax number color. |
| `--syntax-punc` | Syntax punctuation color. |

A person's colour is not a token: `[data-person-tone="0"…"7"]` (styles.css)
sets a local `--person-tone` from the theme's own signal colours — red,
red/amber, amber, green, green/blue, blue, purple, red/purple — and
`--person-tone-ink` (`--bg`) for a monogram's letters on it. Any element that
names a person sets the attribute (`personIdentity.ts` picks the tone) and
reads `var(--person-tone)`; never hard-code a person's colour.

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

## Theme layers

Settings → Appearance splits the theme into four independent choices: the
**Color** section (colour scheme, accent, colour mode) and **Controls**
(the `themeStyle` layer, formerly "Platform style"). `resolveTheme` in
`theme.ts` combines them into one concrete theme; nothing else reads them.

| Layer | Setting | What it decides |
| --- | --- | --- |
| Controls (platform style) | `themeStyle`: `liquid-glass` (**macOS 27**, the default), `fluent` (**Polyth**, Windows 11), `macos` (**Big Sur**), `classic` (Quiet Glass, no recipe) | Geometry, materials, control shapes, elevation, focus and motion: a recipe stylesheet keyed on `html[data-theme-style]` plus that style's derived roles (`--hair`, overlays, shadows, scrim). |
| Colour scheme | `theme`: any bundled palette or custom skin | The token roles of both appearances. Every palette draws in every style; the palettes authored for the current style (`ThemeSpec.style`, none for Classic) are listed first as "Made for …". |
| Accent | `accentColor`: "" (the scheme's own) or a source `#rrggbb` | `accentRoles` derives `accent` / `accentHi` / `accentInk` for the style and appearance: light appearances put white ink on the source, deepened only until it holds 4.5:1; dark ones lift it under near-black ink (Fluent, Classic), while the macOS styles keep white ink as long as the colour moves less than 0.12 in lightness. `withAccent` applies it to both appearances, so an exported skin carries it. Each style offers its platform's swatches (`ACCENT_SWATCHES`: Apple's accent colours for both macOS styles, the Windows accent palette for Fluent) plus any colour. |
| Colour mode | `appearanceMode` | Light, dark, or the operating system's (`system`, the fresh-install default). |

A record saved before the layers split has no `themeStyle` and reads as
`auto`: each palette keeps the style it was authored for, so an existing
profile does not change. The first choice made on the Theme section pins the
style on screen (`auto` → that style), so picking a colour scheme never brings
a style along. An imported skin is a whole scheme: it applies its own accent
and its style when it names one.

A style recipe must read the colour roles (`--accent`, `--accent-ink`,
`--bg`…), never a hard-coded palette colour, so it draws any scheme; neutral
ink alphas (black/white strokes, fills, shadows) are part of the style.

## Liquid Glass theme style

`liquid-glass` (style **macOS 27** — the base style and the default of a fresh
install, with the bundled **macOS 27** colour scheme, id `liquid-glass` — or any
skin with `"style": "liquid-glass"`) is the macOS 27 recipe: `theme.ts`
publishes `html[data-theme-style="liquid-glass"]` plus the macOS 27 derived
roles, and `apps/web/src/liquidGlassTheme.css` (imported last by `main.tsx`)
re-binds the canonical tokens and the core `.ui-*` primitives. Packages follow
through the tokens; the host never styles a package's selectors.

The numbers come from Apple's macOS 27 design resources (Figma community file
"macOS 27"): its system colours, Liquid Glass and material pages and its
component pages, measured from the rendered frames. Where a kit colour fails
Polyth's contrast rules it is adjusted and the source is named:

| Aspect | macOS 27 value |
| --- | --- |
| Palette | Both appearances hand-authored (`counterpart`): window / content `--bg` (#ffffff / #1e1e1e), sidebar `--panel` (#f2f2f2 / #2a2a2a), grouped-form card `--raised` (#f7f7f7 / #252525), form row separator `--border-soft`, label ink at 85% (#262626 / #dfdfdf). Secondary ink is darker (lighter) than secondaryLabelColor so it holds 4.5:1 on every surface. `--accent` is the kit's menu and selection highlight #0069f9 in both appearances (the brighter system blue #0088ff holds only 3.5:1 under white), `--accent-hi` its emphasized list selection #0065e2. The signals are the kit's system colours (green #34c759, orange #ff8d28, red #ff383c, blue #0088ff, purple #cb30e0 and their dark values) with the lightness moved just enough to hold 4.5:1 as text on every surface (the dark red a step further, #ff7476, so it also reads over a wallpaper wash); `blue` is the link colour. |
| Radius | 8px controls, fields and rows; 12px cards and menus; 16px popovers, panels and Settings; 22px alerts, sheets, docks and the composer; 18px chat bubbles; 6px help tags. Push buttons, segmented controls and tabs, search fields and toolbar items are capsules (`--lg-radius-capsule`, 22px, a capsule for every control up to 44px). Menu highlights are concentric (menu radius − 5px inset). *Rounding* scales them by `--lg-round` (scale ÷ 1.8): the default 9 draws these radii, 0 squares everything except true pills (switch), the last notch is 1.5×. |
| Proportions | Push buttons 28px (`--control-h-sm`, the kit's large size), fields and medium controls 32px, large 36px, with capsule side padding (10 / 14px); menu rows 26px with no gap, 5px menu inset, 10px text inset. Check box 16px; switch 40×22 with a 22×18 pill knob. |
| Strokes | No control outlines: controls are flat fills. Fields keep a 0.5px ring (12% ink). The contour (`--contour`) is the glass stroke, 7% black / 10% white: every glass surface and shell control draws it (both rails, header capsules and glyph buttons, the session title, menus, popovers, help tags, alerts, the composer and the sessions peek), with a specular rim (`--lg-rim`, a bright top edge and a faint inner ring); a focused composer firms it to the strong stroke. Separators are 8% label ink (`--hair`). *Hide interface borders* keeps the contour and the rims. |
| Materials | Liquid Glass on transient surfaces: the elevated tint at 82% (Clear 66%) over a 28px blur at 190% saturation, no grain. Chrome (sidebar, header, rail host, status bar): 88% of `--panel` over a 44px blur. Toolbar items (session title, view switcher, header view tabs, header glyphs, sidebar search) are glass capsules and circles with the rim and a small shadow; segments inside a toolbar capsule are capsules too, and the selected view tab is a neutral plate rather than the accent segment. The sidebar's sessions peek is a panel on the contour, the glass highlight and shadow. *Glass: Off* is the solid fallback, as macOS with Reduce transparency. Settings is a window on the sidebar colour. |
| Elevation | A tight contact shadow under a wide ambient one: `--shadow-sm` (controls), `--shadow-md` (menus, popovers, composer), `--shadow-lg` (alerts and sheets); stronger in dark. Smoke behind modals is 18% / 42% black. |
| Controls | Push button: a capsule of 7.8% (10%) ink fill, denser on hover and press, no outline; default button: a flat accent capsule, `--accent-hi` on hover, darker when pressed; destructive: a tinted red capsule (red at 14% / 22%) with a red label; toolbar (ghost) button: borderless with a fill under the pointer. Text fields: the content surface on a fine ring; focus adds a 3.5px accent halo (45% / 60%). Check box: accent when checked. Switch: 9% (14%) track, white pill knob on a soft shadow, accent track when on. Segmented control and tabs: a 6% (8%) capsule well whose selected segment is an accent capsule with white ink. |
| Menus | The highlighted item is an accent plate with white ink, icons, details and checkmarks included; a destructive item highlights in red; a row with a switch keeps a neutral highlight. Key equivalents are plain trailing text. |
| Selection | Navigation rows (sessions, Settings) take the unemphasized sidebar selection: a rounded 8% (12%) ink plate behind an unchanged label. Settings sidebar glyphs take the accent (lifted toward white in dark) and its section titles are sentence-case. Text selection is the accent at 24% (40%). |
| Focus | A 3px accent halo at 45% (60%) hugging the control (`--focus-ring`). |
| Type | San Francisco (`-apple-system`, SF Pro Text) is put in front of the default faces (Open Sans, and Inter for older profiles) where the platform has it, then Inter; an explicitly chosen font is kept. Menus and navigation use regular weight, buttons and segments medium. |
| Motion | `cubic-bezier(0.32, 0.72, 0, 1)` — a fast attack and a long, soft landing; 120ms state changes, 220ms normal, 300ms surfaces. |

Links in the conversation take `--blue` instead of the accent, as AppKit
separates the two; inside the user's own accent-tinted message the link leans
toward the label ink so it still holds 4.5:1. The composer gains no accent
outline on focus; its ring firms instead. A disabled control keeps the shared
neutral look from `styles.css`.

### Layering user customizations on the base theme

The base theme is a set of parameters, not a finished picture: every rule in
`liquidGlassTheme.css` reads the canonical tokens and the user's preference
variables, so each customization layers on without a second recipe.

- **Colours.** Any colour scheme draws in this style (see "Theme layers"),
  and *Accent color* recolours it with Apple's accent colours or any colour:
  menus, segments, switches, check boxes, glyphs, focus halos, selection and
  the user bubble all follow, because they are drawn from `--accent` and the
  washes `themeCssVars` derives from it. A skin with `"style": "liquid-glass"`
  supplies a whole palette (both appearances through `counterpart`); keep
  `accentInk` at 4.5:1 over both accent ends, the import shows the advisory
  contrast report. A synced custom theme applies as soon as it arrives, even
  after boot.
- **Rounding** scales every radius role and the capsule (`--lg-round` =
  `--corner-radius-scale / 1.8`, so the default rounding 9 draws these radii
  exactly), down to square at 0 and up to 1.5× at 10. Fluent, macOS and the
  interface styles (`--look-round`) use the same divisor.
- **Interface font** `theme` (the default) draws SF Pro here, Segoe on Fluent
  and Open Sans on Classic; any other choice, Inter and Open Sans included, is
  that exact face on every style.
- **Glass** (Off / Matte / Clear), **Hide interface borders**, **density**,
  **fonts** and **reduced motion** act through their shared variables; the
  recipe only sets the macOS 27 values they start from.

A future customization (a radius preset, a shell composition) should change
these same inputs — a token through `theme.ts`, a preference variable on
`<html>` or `<body>` — never add a parallel rule set.

## Fluent theme style

`fluent` (style **Polyth**, with the bundled **Polyth** colour scheme, id
`fluent` — the base theme before macOS 27 — or any skin with
`"style": "fluent"`) is the Windows 11 recipe:
`theme.ts` publishes `html[data-theme-style="fluent"]` plus the Fluent derived
roles, and `apps/web/src/fluentTheme.css` (imported after the core sheets by
`main.tsx`) re-binds the canonical tokens and the core `.ui-*` primitives.
Packages follow through the tokens; the host never styles a package's
selectors (the model picker keeps its own selection edge, for example).

The numbers come from the WinUI 3 theme resources and the Windows 11 design
guidance (geometry, materials, acrylic):

| Aspect | Fluent value |
| --- | --- |
| Palette | Both appearances hand-authored (`counterpart`): Mica base `--panel` (#f3f3f3 / #202020), content layer `--bg` (#f9f9f9 / #272727), flyout tint `--elevated`, default Windows accent (#005fb8 / #60cdff). Secondary ink is darker (lighter) than Fluent's tertiary text so it holds 4.5:1 on every surface. |
| Radius | Two radii: 4px for controls, rows, tabs and tooltips; 8px for cards, flyouts, dialogs, the composer, islands and docks. *Rounding* scales them by `--fluent-round` (scale ÷ 1.8): native at the default 9, square at 0, 1.5× at 10. |
| Proportions | Standard control 32px, `--control-h` 36px, list row 40px; menu rows 30px on a 2px gap (the 32px context-menu pitch), inset 4px, text 11px from the backplate; once any row of a menu has an icon, every label starts on the icon column. |
| Strokes | Black/white alphas, not palette lines: control 5.78% / 7.06%, its elevation edge darker at the bottom (light, 16.2%) or lighter at the top (dark, 9.4%); text-field underline 44.6% / 54.4%; surface stroke 40% #757575 in both appearances, which is the contour (`--contour`) of every glass surface and shell control (both rails, header controls, the session title, flyouts, dialogs, the composer and the sessions peek); menu dividers 8%. |
| Materials | Acrylic on transient surfaces: one even tint (86%, Clear 70%), 30px blur, 125% saturation, 3% luminance grain (`--material-glass-texture`). Mica on chrome (sidebar, header, rail host, status bar): 92% of `--panel` over a 60px blur. *Glass: Off* is the solid fallback, as Windows with Transparency effects off. Settings is a window, so it sits on Mica. |
| Elevation | Key + ambient shadow: 2 (controls, `--shadow-sm`), 16 (flyouts, `--shadow-md` and `--material-glass-shadow`), 64 (dialogs, `--shadow-lg`). No inset sheen. Smoke behind modals is a neutral 30% black. |
| Controls | Standard button: control fill on the elevation edge; accent button: flat accent, 90% on hover, 80% pressed; subtle button: transparent with a 3.7% / 6% fill. Text fields: strong (or elevation) bottom edge that becomes a 2px accent underline on focus; the composer rests on the surface stroke and takes the same underline on focus. Check box 20px; toggle switch 40×20 with a 12px knob that grows to 14px under the pointer. Segmented control and tabs: a recessed well whose selected segment is a standard-button card with a 16×3px accent pill. |
| Selection | Navigation rows (sessions, Settings) keep a subtle backplate and a 3×16px accent pill on the inline-start edge; the label stays ink. |
| Focus | Ink, not accent: a 2px outline 1px off the control with a 1px contrasting inner stroke. |
| Type | Segoe UI Variable (Text; Display for 20px+ headings) is put in front of the default faces (Open Sans, and Inter for older profiles) where Windows has it; an explicitly chosen font is kept. Buttons, segments and navigation use regular weight; titles semibold. |
| Motion | `cubic-bezier(0, 0, 0, 1)`; 83ms control state changes, 167ms normal, 250ms surfaces. |

*Hide interface borders* still clears structural borders and decorative
separators. The Fluent material edges are not decoration — a control's
elevation edge, a text field's underline, a flyout's or dialog's surface stroke
and the dividers inside a menu identify the thing itself, as the composer
outline and the checkbox do — so they stay. A disabled control keeps the shared
neutral look from `styles.css`.

## macOS theme style

`macos` (style **Big Sur**, with the bundled **Big Sur** colour scheme, or any
skin with `"style": "macos"`) is the macOS Big Sur recipe, built the same way as Fluent: `theme.ts`
publishes `html[data-theme-style="macos"]` plus the Big Sur derived roles, and
`apps/web/src/macosTheme.css` (imported after `fluentTheme.css`) re-binds the
canonical tokens and the core `.ui-*` primitives.

The numbers come from the macOS Big Sur UI kit styleguide (UI8, Figma
community file): its 43 AppKit colour styles per appearance, its border,
shadow, blur and type styles, and its components. Where a styleguide colour
fails Polyth's contrast rules it is adjusted and the AppKit source is named:

| Aspect | macOS value |
| --- | --- |
| Palette | Both appearances hand-authored (`counterpart`): text background `--bg` (#ffffff / #1e1e1e), sidebar `--panel` (#f4f5f5 / #2b2b2b), alert surface `--elevated`, window background `--sunken` (#ececec; dark grid #181818), label ink at 85% (#262626 / #dddddd). Secondary ink is darker (lighter) than secondaryLabelColor so it holds 4.5:1 on every surface. `--accent` is the fill macOS sets white text on: selectedContentBackgroundColor #0063e1 light, the Apple blue #0071e3 dark (the lightest blue under which white still holds 4.5:1). `blue` is linkColor (#0068da / #419cff); the other signals are the Increased Contrast system colours, so they read as text. |
| Radius | 6px controls, rows, tabs; 6px menus with 4px item highlights; 10px cards, popovers, dialogs and Settings (the window radius); 12px composer, islands and docks; 5px help tags. *Rounding* scales them by `--macos-round` (scale ÷ 1.8): native at the default 9, square at 0, 1.5× at 10. |
| Proportions | Push buttons 28px (`--control-h-sm`, the kit's large push button), fields and medium controls 32px, large 36px; menu rows 24px with no gap, 5px menu inset, 10px text inset. Check box 16px; switch 38×22 with a 20px knob. |
| Strokes | Control and field rings are 0.5px shadows, not borders, so *Hide interface borders* leaves them: control 10% black (dark: 25% black under a 15% white top edge), field 15% black / 12% white. The surface stroke, 10% black / 50% black, is the contour (`--contour`) of every glass surface and shell control (both rails, header controls, the session title, menus, popovers, help tags, dialogs, the composer and the sessions peek) and survives *Hide interface borders*; a focused composer firms it to the strong stroke. Separators 10% label ink (`--hair`). |
| Materials | Vibrancy on transient surfaces: the sidebar tint at 84% (Clear 68%), 30px blur, 180% saturation, no grain. Sidebar vibrancy on chrome (sidebar, header, rail host, status bar): 86% of `--panel` over a 50px blur at 190%. *Glass: Off* is the solid fallback, as macOS with Reduce transparency. Settings sits on the sidebar colour; alerts and the composer stay on the content surface. Dark surfaces carry a 0.5px light top edge (`--inset-hi`). |
| Elevation | One soft drop shadow per level, measured from the kit: `0 1px 2px` 15% (controls, `--shadow-sm`), `0 6px 8px` 15% (menus and popovers, `--shadow-md`), `0 20px 18px` 24% (alerts and sheets, `--shadow-lg`), the same in both appearances. Smoke behind modals is 20% / 40% black. |
| Controls | Push button: a white (25% white) plate on its hairline and 1px drop, no hover, darker (lighter) when pressed; default button: the accent plate under a soft top bevel, darkened when pressed; toolbar (ghost) button: borderless with a hover bezel. Text fields: the content surface on a hairline; focus adds the ring instead of recolouring the edge. Check box: white (25% white) box, accent with a bevel when checked. Switch: 9% (14%) track, white knob on a drop, accent track when on. Segmented control and tabs: a 6% (10%) well whose selected segment is a push-button plate; every label in label ink. |
| Menus | The highlighted item is an accent plate with white ink, icons, details and checkmarks included; a destructive item highlights in red; a row with a switch keeps a neutral highlight. Checkmarks and icons take the label ink; key equivalents are plain trailing text. |
| Selection | Navigation rows (sessions, Settings) take the unemphasized source-list selection: a rounded 10% (13%) ink plate behind an unchanged label. Text selection is the accent at 30% (45%). |
| Focus | The macOS focus ring: a 3px accent halo at 50% (65%) hugging the control (`--focus-ring`). |
| Type | San Francisco (`-apple-system`, SF Pro Text) is put in front of the default faces (Open Sans, and Inter for older profiles) where the platform has it, then Inter, the closest bundled face; an explicitly chosen font is kept. Buttons, segments, menus and navigation use regular weight. |
| Motion | Core Animation's default curve `cubic-bezier(0.25, 0.1, 0.25, 1)`; 100ms state changes, 200ms normal, 250ms surfaces. |

Links in the conversation take `--blue` (linkColor) instead of the accent, as
AppKit separates the two. The dark accent is limited by white ink to 3.1:1 on
the sidebar and 3.6:1 on the conversation, so accent-tinted glyphs stay above
the 3:1 non-text minimum while accent text uses `blue`. The composer gains no
accent outline on focus; its hairline firms instead. A disabled control keeps
the shared neutral look from `styles.css`.

## Core UI primitives

`apps/web/src/components/ui/` owns the shared component primitives (Button,
IconButton, inputs, Switch, Tabs, Badge, Spinner, Skeleton, Popover, Menu,
Tooltip, ResponsiveOverlay, …). Their shared styles live in core `styles.css` under the `.ui-` prefix. New core UI composes these
components instead of minting new button/menu/dialog classes; packages consume them through the documented shared UI boundary. UI action icons come from `ui/icons.ts`
(Lucide) sized by the icon tokens; domain/project identity marks keep their
existing assets. `docs/dev/design-system.md` is the usage guide.

Menu rows share one label column: when any row of an open menu carries a
leading icon, check mark or busy spinner — a package's footer row can bring the
only one — the rows without one reserve that column, so every label starts at
the same x. `--menu-leading-column` carries the value; each theme style
re-binds it to its own row inset and gap. A non-row `footer` (a status block,
as in Source Control's identity menu) puts a divider above itself and pads its
start by `--menu-leading-column` when the menu has a check column, so its text
sits on the same x.

#### Motion and restyle cost

Motion stutters when the main thread stalls under it, and the largest stalls
here are whole-app restyles, not the animations themselves. Measured on a
9,000-element chat in Chromium (1× CPU, the phone keyboard probes of
`docs/dev/mobile-viewport.md`):

- Any style change of `<html>` or `<body>` that touches an inherited property
  restyles every element (~260 ms): a custom property written on them, an
  inherited property (`user-select`, `cursor`, `color`, …) a rule keyed on
  their attributes sets, a `html:has(…)`/`body:has(…)` rule that does either,
  a root `background`. Non-inherited changes on them (`overflow`, `height`)
  and attribute flips that only descendant rules react to (targeted by class,
  tag or attribute) cost ~1–3 ms. Never key motion state on `<html>`/`<body>`
  with an inherited effect; scope it to the moving element, or do it in JS
  (`swipeSurface.ts` refuses `selectstart` instead of `user-select: none` on
  `<html>`; the Shift ring suppression names the focused element).
- A selector whose rightmost compound has no class, id, tag or attribute
  (`body[data-x] :focus-visible`, `[data-x] *`) invalidates the whole subtree
  when the flag flips.
- A positional pseudo-class (`:first-child`, `:last-child`, `:nth-child()`,
  `…-of-type`) left of the rightmost compound feeds one invalidation set
  shared by every rule: with a bare tag or nothing on the right
  (`X > div:first-child > span`, `X > :first-child > :first-child`, a
  positional `::first-letter`) any element whose first/last-child state
  changes restyles all such descendants — opening the phone navigator
  (inserted before `.workspace`) restyled the whole chat (9,094 elements,
  ~250 ms) until those rules named their element with a class.
  `cssStructuralInvalidation.test.ts` guards every stylesheet. For "the last
  row has no rule", let the row carry the condition and its cells read it
  (`tr:last-child { --row-rule: 0px }` + `td { border-block-end-width:
  var(--row-rule, 1px) }`).
- `<html>` must not be the subject of a `:has()` rule: the engine re-matches
  `:has()` subjects on DOM insertions, and an `<html>` re-match restyles the
  app. Static shell facts live on `<html>` as attributes
  (`html[data-desktop-app]`, set with `body.desktop-app` in `desktop.tsx`).
- A media query whose result flips rebuilds the rule sets (fonts, keyframes,
  registered properties) and re-lays every box (358 ms of layout against 6 ms
  without). The phone keyboard resizes the viewport, so no stylesheet media
  query may depend on a height the keyboard crosses on a portrait phone:
  publish it as a `body[data-viewport-short]` token (`SHORT_VIEWPORT_QUERIES`
  in `mobileViewport.ts`; `keyboardMediaQueries.test.ts` evaluates every media
  list in the CSS on four phones).
- Prefer `transform`/`opacity`; motion that has to follow something the main
  thread does not own (the native keyboard) runs as a WAAPI transform on the
  compositor (`keyboardRide.ts`) and commits layout only where nothing moves.
- Never animate a size that reflows the transcript (`grid-template-rows`,
  `height`) for a recurring event: each frame re-lays the chat and re-runs its
  follow observers, and WKWebView renders that layout at ~60 fps beside faster
  compositor motion. The activity block's live line swaps its words in one grid
  cell with transform and opacity instead.
- Do not write `will-change` around a WAAPI glide: a running transform
  animation is composited by itself, and on touch WebKit a burst of layers
  created and destroyed in the commit that writes `scrollTop` flashes blank or
  misplaced tiles. The tail lift moves only the rows whose path crosses the
  reading area (`timelineLift.ts`).

Popover, Menu, Dialog, Sheet, Picker, and ResponsiveOverlay use the Quiet
Glass material tokens. Their default is opaque and readable. Core CSS adds
translucency only inside a backdrop-filter `@supports` rule and restores the
opaque material for Glass off or
`body[data-desktop-low-resource="true"]`. Reduced motion only disables
animation; it does not override the selected glass material. Packages should
use shared glass primitives. A package-owned floating surface without a
suitable primitive must start with an opaque `--material-glass*` background
and add its translucent background and paired
`-webkit-backdrop-filter`/`backdrop-filter`
only inside a support rule guarded by Glass off and low-resource states.
Text-bearing surfaces use the readable
`--material-glass-readable-*` floors, so Matte and Clear remain visibly
different without allowing a busy workspace background to erase labels.
Composer command autocomplete is denser than an ordinary anchored menu, so it
uses a stronger local fill floor while retaining the selected blur and mode.
Portaled model and other picker surfaces keep their own glass root; a trigger's
composer ancestor must not disable their backdrop filter.
Light appearances use a lower tint than dark appearances because white glass
otherwise merges with a light workspace. The
full-screen Navigator and Workspace/widget destination
menus are the deliberate exception: their lighter
`--material-glass-mobile-chrome-*` profile keeps a blurred silhouette of the
conversation visible. Nested search, selected rows, and controls keep the
readable profile; Glass off and low-resource mode retain opaque fallbacks.
The phone's floating chrome — the composer and the top navigation/action
islands (`.mobile-session-floats .ui-glass-island`) — is one material: the
same reduced-share fill, the theme's contour composited over the workspace
(`background-clip: padding-box`) and the theme's phone edge (no shadow by
default, the specular rim in Liquid Glass, the shadow in Fluent). A theme that
changes the phone composer's edge changes the islands' in the same rule. The
attention-state title island keeps the lifted chrome glass.
`hostGlassAppearance.test.ts` compares the rendered materials across styles,
glass modes and Hide interface borders.
The phone session-title control defaults to an unboxed transparent touch region,
including attention states. Its smaller centered title balances and clamps at
two lines; the control grows with the menu text scale. Chat settings can hide
the control, add the provider logo, or restore the single-line glass island;
see [the title preference contract](ui.md) for the stored modes.
Conversation clearance follows the selected mode and menu text scale,
independently of chat text size.
Request dots and descriptive copy retain attention feedback. The session
overview shows the current title without a clamp, including while task progress
temporarily occupies the header.

Chat action outcomes stay on the invoking icon: successful controls use the
semantic green signal and a short check-pop, while live result text remains
available to assistive technology. Do not add visible confirmation chips to
message or response action rows.

Nested chrome such as `.sidebar-project-rail`
is a transparent cutout of its parent surface and must not start a second
glass/backdrop stack. The dynamic package peek and its launcher strip each
own that same material locally while their `.railbar` host remains transparent;
their seam uses the shared `--rail-strip-width-right` fallback, and the peek
starts flush with the rail's outer block edge. The collapsed project-session
peek is its own panel instead: it opens `--space-1` clear of the rail, runs
along the rail's block edges into the window's bottom edge like the sidebar
(so only its top corners round, with `--radius-surface`), reuses the selected
readable material, and draws the theme's `--contour` with the glass highlight
and shadow (kept under Hide interface borders, as every contour is). While it
can open, the sidebar
(`.sidebar--rail-collapsed`) paints its glass on a `::before` layer under its
content and carries no backdrop filter itself: an element with a backdrop
filter bounds the backdrop of everything inside it, which left the peek
unblurred over the workspace. The sessions column becomes the peek only once
the navigator has narrowed: while the width transition runs (collapsing or
expanding) it keeps its own width in flow, the navigator clips it at the moving
edge (`.sidebar--rail-motion`) and a leaving column fades
(`.sidebar-main--leaving`), so it never reflows or jumps out beside the
still-wide navigator (`Sidebar.tsx`, `railMotion`). Docked
right-rail package windows use the same single seam, and their outer frame is
the `.railbar` host itself: it keeps the idle rail's `--hair-solid` block and
inline-start edge and simply grows around the pane, so window and strip share
one top/bottom line and only the frame's inline-start corners travel while it
opens. The pane paints only its fill inside that curve, and that fill is the
strip's material (`--material-glass`, the readable glass profile when glass is
on), so a docked window reads as the strip's extension; the strip adds only the
seam divider. A floating (dynamic) window and its strip each paint the same
glass, `--hair-solid` edge and top highlight instead. Package frames reserve
`--package-window-seam-padding` on their inline-end side and grow around the
content box, so the rail tuck does not steal content width. Catalog pickers use
the shared `workspaceCatalog.css` surface; one to four choices collapse to a
compact action grid, while larger catalogs retain their controls and category
headers. The phone Workspace editor and its full-page Add page own
`workspacePanelEditor.css` and `workspaceGallery.css` (see
[UI](ui.md#phone-workspace-editor)). Rail and zone Customize editors use `railEditor.css` (fixed header and
footer, only the body scrolls; see [UI](ui.md#32-rail-and-zone-editor)). On desktop the Canvas grid, its add trigger, and its add-widget panel
reserve the idle launcher lane. Dialog, Sheet, and Settings backdrops use a
light `--modal-backdrop-scrim-share` tint and `--modal-backdrop-blur` to soften
the exposed workspace around the active window. Matte softens more than Clear.
The active surface keeps its own readable glass. Full-screen phone Settings,
project setup, and Workspace omit the surrounding backdrop because the surface
fills the viewport. The phone Settings layer is opaque in every Glass mode
except the user's explicit Clear choice: it is the whole screen rather than a
sheet over the workspace, so the workspace must not ghost through its rows,
group cards or page padding (the pane already fills with `--bg`). Workspace
shares the Navigator's glass material and effect
preferences without an additional scrim or backdrop filter on its sheet host.
Partial-height windows retain an opaque scrim and surface fallback
when Glass is off, resources are limited, or backdrop-filter is unavailable.
Apply transparency to the material background rather than to a whole block
of text and controls. Keep disabled labels visible enough to identify what is
unavailable (the `--control-disabled-*` tokens), and keep drag previews legible
while moving them.

On phones, selection pickers (Picker, Select, Menu pick lists, model/agent/mode
pickers, composer Add menu, and other anchored choosers) open as a **compact
anchored popover** beside the trigger in the finger-travel zone — not a
full-bleed bottom sheet. Bottom sheets remain for **destinations** only
(CommandPalette, SessionSearch, ArchivedSessions, StarterPicker browse/create, settings/nav
sheets, tall contribution forms, SendSheet, and other modal browse surfaces
without a nearby trigger). Compact popovers honor safe areas, the visual
viewport, and `--screen-gutter`; they do not stretch full viewport width.

## Shared empty states

Core exposes one primitive with three size variants:

- `.empty-state--compact`: an inline prerequisite or no-results message.
- `.empty-state--panel`: a bounded state for a rail, card, or docked panel.
- `.empty-state--page`: the primary full-page first-run or error state.

Use one state at a time. A prerequisite state either owns one primary action
or defers to the visible parent action. Do not stack a passive placeholder
beside or above a second first-run card.

`compact` and `panel` draw their own card, and every non-standard Look repaints
them as its card. Inside a pane or card that already draws the surface, use
the default variant and let the owner size and bare it (Source control's clean
change list, empty log and worktree card), or the state nests a second card.
Pass a `mark` that names what is missing; the default clock reads as "pending".

## Field wells

A search or address bar is often one field drawn around a leading icon, a
bare `TextInput` and trailing controls (clear, submit). Mark that container
`.ui-field-well`:

- The owner styles the well for the classic style: fill, edge, radius and a
  `:focus-within` ring. `.ui-field-well .ui-input` (and `.ui-textarea`) is
  bare in the base.
- Platform styles (`liquidGlassTheme.css`, `fluentTheme.css`,
  `macosTheme.css`) paint the well with their own field rule (fill, ring,
  radius, `:focus-within` focus), so its ring survives Hide interface borders,
  and exclude `:where(.ui-field-well) *` with zero added specificity, so they
  never draw a second field inside it.
- Looks paint the well as their field (section 1f) and leave its input bare.

Without the marker a platform style out-specifies a package's bare-input rule
and draws a rounded field that starts after the icon. When the input itself is
the field and an icon only overlays it (Packages search, the desktop Settings
search), do not mark the container. A surface that switches pattern by
breakpoint sets the class with the same media query: the Settings search shell
is a well only on phones. A picker's recessed filter (`.picker-search`) is not
a platform field: it holds a plain `<input>`, as `Picker` does.

A package composer is different: its card holds a bare `Textarea` and a row of
controls, but the card is the owner's surface, not a field. Mark it
`.ui-field-frame`: the base, platform styles and Looks leave both the frame
and the input inside it unpainted, so the owner's card stays the only surface
(the Agents, Creative Studio dock, Planner task and Git commit composers, the
terminal find bar). A Look's field corner may be a pill (Air, Obsidian); text
areas and a well around one (the task-tracker editor) take
`--look-area-radius`, the field corner capped at a card's, so a multi-line
field never rounds into an oval. Tested by
`apps/web/test/fieldWell.test.ts`.

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

## Selector performance

Every stylesheet a package ships is loaded for the whole shell, so a selector
costs on every page, not only where its elements appear. Chromium's `:has()`
invalidation is coarse: a change anywhere under an ancestor that some
`:has()` rule depends on (an inline style write, the text area's own
placeholder update on each keystroke) schedules that rule's subject for a
restyle across the document.

- Do not put `:has()` before a combinator and a universal or bare-negation
  subject (`.a:has(.b) > *`, `.a:has(> .b) > :not(.c)`). Measured on a long
  chat, `.railbar:has(.rail-dynamic) > *` alone turned every composer
  keystroke into two restyles of all ~3,800 elements (~128 ms each).
  `apps/web/test/cssHasNesting.test.ts` rejects the pattern.
- Prefer a class or attribute the owning component sets for its own state
  (`.railbar-dynamic`, `.tt-provider-panel--filtered`) over `:has()` that
  looks for that state from outside, especially when the subject is common
  in the transcript (`small`, `.bubble`, button labels).
- Writes that leave a value unchanged still restyle and still reach
  observers: compare before writing an inline style or attribute on a
  per-keystroke or per-token path (see `apps/web/src/composerAutoGrow.ts`).

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
- use viewport width to lay out embeddable panel/card content;
- put a button `:hover` outside `@media (hover: hover)` or a button
  `:hover`/`:active` without the `:where(:not(:disabled))` guard (see
  "Buttons" in [the design system](design-system.md#buttons)).
