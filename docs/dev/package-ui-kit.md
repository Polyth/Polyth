# Package UI kit (`host.ui.components`)

Reference for a Polyth package that renders in the app's own realm through
`@polyth/web-sdk`. It covers what each shared primitive is for, its real props,
its keyboard and ARIA behaviour, whether it is controlled, and which one to take
instead of drawing a lookalike.

This is not the sandboxed-extension surface: an isolated extension describes a
RemoteUI tree (see [extensions](extensions.md#remoteui)) and never mounts host
components. Widget/surface registration, content layout and ownership rules are
in [package content](package-content.md) and
[components](components.md#1-ownership-know-whose-component-it-is-before-touching-it).

The kit is the shell's own code. Sizes, colours, edges, focus rings, hover and
disabled states therefore follow the installed Polyth version, every theme and
the person's preferences. A package that copies a Button's CSS loses all of
that at the first host release.

## Getting the primitives

Two supported shapes, both from `host` (never from `apps/web`):

```tsx
// Inside a render/handler: read the host directly.
return <host.ui.components.Button variant="primary" onClick={save}>Save</host.ui.components.Button>;

// Module scope, for files that use parts at the top level.
import type { ReactNode } from "react";
import { bindHostUi } from "@polyth/web-sdk";

const ui = bindHostUi(() => getHost(), "Usage");
const Panel = ({ children }: { children: ReactNode }) => (
  <ui.components.SettingsSection title="Usage">{children}</ui.components.SettingsSection>
);
```

- `bindHostUi` resolves every part from the configured host **at render time**, so
  a test or host swap never leaves a stale component behind. Bind it once at
  module scope; do not read `host.ui.components.X` into a constant before the
  host is configured (an early read is `undefined`, not a later error).
- **Core parts are always promised**: `Button`, `IconButton`, `Menu`, `Tabs`,
  `TextInput`, `Textarea`, `Checkbox`, `Select`, `EmptyState`, `MarkdownDoc`.
- **Optional parts** exist on newer hosts only: `TabPanel`, `Dialog`, `Switch`,
  `Spinner`, `Badge`, `Notice`, `Skeleton`, `Icon`, `Picker`, `SettingsRow`,
  `SettingsSection`, `MediaViewer`, `ComposerNoticeRow`, `FolderPicker`,
  `ResourceLink`, `WorkspaceSurfaceHeader`, and `ui.tabIds` / `ui.confirm`
  alongside them.
- Feature-detect an optional part by reading the raw
  `host.ui.components.<Name>` (`host.ui.components.Switch ? … : <select …/>`).
  The `bindHostUi` proxy is always a truthy component and only throws
  `host.ui.components.<Name> is unavailable` when it renders, and
  `BoundHostComponents` types every key as present, so a `bindHostUi` value
  cannot answer "does this host have it?".
- Glyphs come from `host.ui.iconSet` (action glyphs, see `WEB_ICON_NAMES`) or
  `host.ui.icons` (legacy domain marks). Do not ship a package SVG for something
  the icon set already names. Add a name there when a genuinely new action
  appears in two packages.
- `host.ui.confirm`, `host.ui.tabIds`, `host.ui.locale` and
  `host.notifications.show` live next to the components (see below).
- Every control is typed with its real props (`WebButtonProps`,
  `WebSelectProps`, …), and each consumer's own `tsconfig.json` is what checks
  a package against a changed prop contract; `apps/web/test/packageUiParts.test.ts`
  proves instead that the current host supplies every promised part, glyph and
  `tabIds` entry.

The core/optional split above is drift-checked: `packages/web-sdk/test/packageUiKitDoc.test.ts`
fails when a part is added, removed or re-classified in
`WebPackageHost["ui"]["components"]` without this document. Update both in the
same change.

## Choose the primitive

| Need | Use | Not |
| --- | --- | --- |
| Any action, submit, cancel | `Button` | a styled `div`/`a` |
| One glyph-only action | `IconButton` with a required `label` | a `Button` with only an icon |
| Immediate on/off preference | `Switch` | `Checkbox` |
| Multi-select inside a list | `Checkbox` per row | one `Switch` per row |
| Pick one value from a known set | `Select` | a row of buttons |
| Same, with groups/detail/multi-select/footer | `Picker` | a bespoke popover |
| Peer views inside one surface | `Tabs` + `TabPanel` | `nav` + `aria-current` |
| Move between different surfaces/pages | `<nav>` link with `aria-current="page"` | `role="tablist"` |
| A list of commands behind one trigger | `Menu` | a custom dropdown |
| Confirm a destructive step | `host.ui.confirm` or `Dialog` | a second Button labelled "Are you sure" |
| Transient result/error/update | `host.notifications.show` / `host.errors.show` | `Notice` as a toast |
| Inline status tied to the form | `Notice` `role="alert"`/`"status"` | the notification stack |
| Empty / no results / first run | `EmptyState` | centered `<p>` |
| Indeterminate busy | `Spinner` with `label`, or `Skeleton` under `aria-busy` | a spinning custom SVG |
| Status on a row | `Badge` (text carries meaning) | colour alone |
| A settings page body | `SettingsSection` + `SettingsRow` | hand-rolled label/control grid |
| Show files or attachments | `MediaViewer`, `ResourceLink` | an `<img>` lightbox |

## Components

### Button

`WebButtonProps`: `variant` `primary | ghost | quiet | danger` (**`quiet` is the
default**: a bordered neutral action), `size` `sm | md | lg` (`md`), `busy`,
`block`, `iconStart`, `iconEnd`, plus every native button attribute. `type`
defaults to `button`, so a submit inside a form needs `type="submit"` explicitly.

- `busy` shows a spinner, sets `aria-busy` and disables the control; do not also
  pass `disabled` for the same state.
- Disabled is inert and gray at rest, with no hover or press. Say why next to it
  (a `hint`, a `Notice`), do not leave a dead control unexplained.
- Keyboard: native — Enter and Space activate, Tab reaches it, focus ring is the
  host's. Icons inside are decorative (`aria-hidden`), the label is the name.
- Not a link. Navigation to another surface is an anchor/`nav` item, not a
  `Button` with an `onClick` that pushes a route.

### IconButton

`icon` (an `iconSet` glyph), `label` (**required** accessible name, also the
default tooltip/`title`), `variant` `quiet | ghost | danger` (`ghost`), `size`,
`busy`, `pressed`.

- `pressed` maps to `aria-pressed`; use it for a toggle, not to fake a selected
  row.
- The hit area grows to `--hit-min`, which core sets to the `--tap` floor (44px)
  on coarse pointers, without enlarging the visual control; a 24px icon button
  is still reachable on a phone.

### Menu

```tsx
<host.ui.components.Menu
  label="Session actions"
  entries={[
    { id: "rename", label: "Rename", onSelect: rename },
    { heading: "Move" },
    { id: "pin", label: "Pinned", kind: "checkbox", checked: pinned, onSelect: togglePin },
    "separator",
    { id: "delete", label: "Delete", danger: true, onSelect: remove },
  ]}
>
  {(trigger) => <host.ui.components.Button {...trigger} iconEnd={MoreIcon} aria-label="More" />}
</host.ui.components.Menu>
```

- `label` is the accessible name of the menu (and the phone sheet title unless
  `title` is set). `entries` take actions (`kind`: `action | radio | checkbox |
  switch`, `checked`, `danger`, `disabled`, `swatch`, `keywords`), `{ heading }`
  or `"separator"`; `entries` on an action makes it a drill-in level.
- `children` is a render prop: spread its trigger props on the opening control.
  They include `aria-haspopup` and `aria-expanded`; do not hand-wire those.
- Keyboard: opening focuses the first item; `↑`/`↓` cycle, `Home`/`End` jump,
  `Enter`/`Space` activate, `Escape` closes and returns focus to the opener,
  outside press and window blur dismiss. `→` opens a drill-in level, `←` goes
  back (RTL-aware). Checkbox/switch entries stay open after a toggle.
- Semantics: `role="menu"` with `menuitem`/`menuitemradio`/`menuitemcheckbox` and
  `aria-checked`. On a phone the default `phonePresentation="popover"` keeps the
  anchored list; `"sheet"` is opt-in for long destination lists and drops the
  menu roles in favour of a dialog-like sheet.
- `open`/`onOpenChange`, `returnFocusRef`, `anchorRef`, `header`, `footer` and
  `renderContent({ close, sheet })` exist for composed cases. Do not re-implement
  dismissal; `renderContent` content must call `close()` itself.

### Tabs and TabPanel

`WebTabsProps`: `tabs` (`{ id, label, disabled? }[]`), `value`, `onChange`, `label`
(accessible name of the strip), `idBase`, `size` `sm | md`. `TabPanel`: `idBase`,
`tabId`, `active`, `children`.

- Take `idBase` and panel ids from `host.ui.tabIds.tab(idBase, id)` /
  `.panel(idBase, id)` when the host has `tabIds`; they are the same ids
  `Tabs`/`TabPanel` emit.
- Keyboard: roving tabindex with **automatic activation** — `←`/`→` move and
  select the next enabled tab, `Home`/`End` jump to the ends, `Tab` leaves the
  strip. Exactly one tab is in the tab order, even when the selected value is not
  in this strip.
- ARIA: `role="tablist"`/`tab` with `aria-selected`, `aria-controls`; the panel is
  `role="tabpanel"`, labelled by its tab, and focusable (`tabIndex=0`).
- An inactive `TabPanel` renders **nothing**, so state inside it is lost. Keep the
  view state in the package (or keep both mounted behind your own visibility
  rule) when it must survive a tab switch.
- `Tabs` is not navigation. Different surfaces keep `nav` + `aria-current`.

### TextInput and Textarea

`WebInputProps`: every native input attribute plus `invalid` (sets
`aria-invalid`) and `uiSize` `sm | md`. `WebTextareaProps`: native textarea plus
`invalid`, `autoGrow`, `minRows` (2), `maxRows` (12).

- Neither draws a label. Wire one yourself: `<label htmlFor={id}>` plus
  `aria-describedby` for the hint, or `aria-label` when the visible label would
  duplicate a surrounding heading. An unlabelled field is a defect, not a style
  choice.
- The size comes from `--font-input` (`15px × --text-scale`); on coarse pointers
  core raises it to at least 16px so focusing never zooms mobile Safari. Do not
  set a smaller font in package CSS.
- `autoGrow` tracks content between `minRows` and `maxRows`, then scrolls. Do not
  animate the height from JS.
- Validation: set `invalid` only after a real check, and put the message in a
  `Notice` or a hint referenced by `aria-describedby`.

### Checkbox and Switch

`WebCheckboxProps`: `checked`, `onChange(next: boolean)`, `label` (required),
`description`, `disabled`. `WebSwitchProps`: `checked`, `onChange(next: boolean)`,
`label` **or** `labelledBy`, `disabled`.

- Both are controlled: pass the new value back in, or the control snaps back.
- `Checkbox` renders a native `input` (visually hidden, focusable) inside its
  label, so Space toggles it and the label text is the name. Use it for
  multi-select and for choices that are submitted later.
- `Switch` is a `role="switch"` button with `aria-checked`; Space/Enter toggle.
  Use it for a preference that applies immediately. `label` is optional only when
  an external `<label id>` is wired through `labelledBy`; an unnamed switch is a
  defect.
- `description` is a hint, not a replacement for a name.

### Select

`WebSelectProps`: `label` (required), `value`, `options` (`{ value, label, group?,
detail? }`), `onChange(value)`, `placeholder`, `disabled`, `ariaLabel`,
`searchable`, `mobileSheet`, `align`.

- `label` names the trigger; the selected option is its visible text. On a phone
  it stays a compact anchored popover unless `mobileSheet` is set.
- It is the searchable `Picker` underneath: the trigger has `aria-haspopup`
  (listbox, or dialog in a sheet) and `aria-expanded`; the filter field is a
  combobox with `aria-activedescendant` over `role="option"` rows and
  `aria-selected`. `↑`/`↓`, `Home`/`End`, `Enter` select, `Escape` closes and
  returns focus; single-select closes after a pick.
- `searchable` defaults to true. Turn it off only for a genuinely short list.
- Controlled: `value` must match an option `value`; `onChange` gives you the id.

### Picker

The multi-select/chip trigger behind `Select`. `label` (required), `items` (`{ id, label, group,
detail?, keywords? }`), `value` or `values` (multi), `onPick`, `onOpen`,
`placeholder`, `searchPlaceholder`, `searchable`, `disabled`, `align`,
`triggerIcon`, `displayValue`, `itemIcon`, `emptyMessage`, `emptyAction`,
`footerAction`, `mobileSheet`.

- Multi-select toggles keep the popover open and the trigger shows a count.
- `emptyAction`/`footerAction` are the supported places for "create new" or
  "configure" exits; do not portal your own menu next to it.
- Keyboard and ARIA are the same listbox/combobox contract as `Select`.

### Badge

`tone` `neutral | accent | success | warning | danger | info`, `children`, `dot`.
A quiet wash with accessible on-wash ink. Meaningful state must also be in the
text — "Failed" is readable, a red dot alone is not. It is not interactive and
not a button.

### Spinner and Skeleton

`Spinner`: `size` `sm | md | lg`, `label`. With a `label` it is `role="status"`
with that accessible name; without one it is decorative (`aria-hidden`) and the
surrounding control owns the state (`Button busy`).
`Skeleton`: `shape` `text | block | circle`, `width`, `height`. Every block is
decorative; put `aria-busy="true"` and a status label on the container, and keep
the shimmer (the host pauses it under reduced motion).

### Notice

`tone` `error | warning | success | info` (`info`), `heading`, `children`,
`actions`, `leading`, `icon`, `iconPosition`.

- It has **no live-region role by default**. Pass `role="alert"` for an error that
  just appeared and `role="status"` for a confirmation; static explanatory copy
  stays role-less.
- Tied to the form or the row: keep it there. Anything transient or app-level is
  `host.notifications.show`, and the stack owns its own announcements — never add
  `role="alert"` to a notification.
- Do not restyle it into a toast or a banner.

### EmptyState

`title` (required), `description`, `actionLabel` + `onAction`, `variant` `page`
(default, first run or a whole-surface failure) `| panel` (a rail, card or docked
panel) `| compact` (inline prerequisite or no results). The SDK type does not
expose the host's `mark`; use the default glyph.

### Dialog

`WebFramedDialogProps`: `title`, `onClose`, `children`, `footer`, `size`
`sm | md | lg | full`, `hideHeader`, `initialFocus` (CSS selector inside the
dialog), `resolveRestoreFocus`, `ariaDescribedBy`.

- The framed dialog: header with title and close, scrolling body, and a footer
  action row pinned under it. Put the confirming Button last and give it the
  primary or danger variant.
- Modal semantics are the host's: `role="dialog"` + `aria-modal`, focus moves to
  `initialFocus` (or the first enabled control), Tab and Shift+Tab are trapped,
  `Escape` closes one layer, background siblings become inert/`aria-hidden`, and
  focus returns to the opener. Do not add a second trap or your own Escape
  handler.
- `onClose` is the only close path; render the dialog conditionally from package
  state and hide it in `onClose`.
- A destructive confirmation with one sentence of copy is `host.ui.confirm(message,
  { title, confirmLabel, destructive })` → `Promise<boolean>`, not a hand-built
  dialog.

### SettingsSection and SettingsRow

`SettingsSection`: `title`, `hint`, `action`, `itemId`, `tone: "danger"`,
`children`. `SettingsRow`: `label`, `hint`, `itemId`, `layout` `inline | stacked`,
`top`, `disabled`, `children`.

- Section titles are the only headings inside a settings page (the shell owns the
  page title); the section is labelled by its own heading and `tone="danger"`
  frames destructive settings at the page end.
- `itemId` is the stable id for settings search and reveal; give one to every row
  the person might search for.
- `layout="stacked"` for textareas, long inputs and lists; `top` aligns the label
  with a tall control.
- `disabled` here only dims the copy. The control inside must be disabled by you,
  with a reason, and it must not silently save a value.

### Icon

`icon` (an `iconSet` component), `size` `sm | md | lg | xl` (`md` = the 18px
control glyph), `label`. With `label` it is `role="img"` with that name; without
one it is `aria-hidden` decoration. Do not size icons with raw pixels.

### MediaViewer

`items` (`{ id, name, url, mime? }[]`), `start`, `index`/`onIndexChange`
(controlled position), `onClose`, `renderOverlay(item, index)`, `aside` +
`asideLabel`, `actions`, `gesturesDisabled`.

- The host viewer: swipe/arrow paging, pinch/wheel/double-tap zoom, pull to
  dismiss, thumbnail strip and glass chrome. Extend it; never copy it. It is a
  modal (`A11yDialog`): focus is trapped and restored, `Escape` closes it.
- `renderOverlay` draws exactly over the fitted image inside the zoomed frame, so
  percentage coordinates land on image pixels.
- `aside` is a package panel beside the stage (stacked under it on phones, its
  region named by `asideLabel`); `actions` is a row of package controls under the
  stage, and each direct child becomes a glass island. Gallery's annotation
  viewer is the reference.
- `gesturesDisabled` suspends zoom/paging/pull while the person draws; the
  buttons, keys and strip keep working. Arrow keys page, `Escape` closes.

### MarkdownDoc

`text` (required), `keyBase`, `streaming` (withhold an undecided trailing block),
`frontmatter`, `conversation`, `showGalleryShortcut`. It is the same sanitized
renderer as chat and file preview — one parsing path, sanitized link/image URLs,
no raw HTML. Use it for any Markdown a package must show; never mount a second
Markdown implementation. Set `conversation` only for agent output in a chat.

### Host-only neighbours

`FolderPicker`, `ResourceLink` and `WorkspaceSurfaceHeader` appear in
[package content](package-content.md) (workspace toolbars and file links).
`ComposerNoticeRow` exists for a row above the composer: wrap the content so it
grows in and folds away with the composer's other notices.

## Theme, preferences and tokens

Colours, edges, type, radii, spacing, motion and control sizes come from the
host's tokens, so a package looks native in every theme and when the person
changes density, text size, corner rounding, transparency, accent or motion.
`apps/web/src/tokens.css` is the source of truth and
[the token catalog](styles.md#token-catalog) is the authoritative list — read it
there instead of copying values. What matters when writing package CSS:

- **Scope every rule** under a stable package root (`.pkg-usage`,
  `.usage-dashboard`, …). Package CSS must not redefine canonical tokens, style
  another package's prefix, or target generic shell selectors (`styles.md`).
- **Pick by intent**: `--bg`/`--panel`/`--elevated`/`--raised` for surfaces,
  `--border`/`--border-soft`/`--contour`/`--control-border` for edges, `--text`/
  `--text-dim`/`--muted`/`--faint` for ink, `--accent`/`--accent-text` for
  emphasis, `--space-1…6`, `--radius-control/card/surface`, `--font-body/
  heading/label/meta`, `--motion-*`, `--tap`, `--control-h*` for geometry.
- **Density, text scale and rounding are already in the tokens**
  (`--density-scale`, `--text-scale`, `--corner-radius-scale`). Never hardcode a
  row height, a 13px font or an 8px radius; the person's settings would not reach
  your surface.
- **Motion**: use `--motion-fast/normal/surface` and `--motion-ease`. The shell
  removes transitions and animations under reduced motion and the desktop
  low-resource setting, so never animate from JS or depend on a transition to
  reveal content.
- **Transparency/glass**: do not add your own `backdrop-filter`, blur or
  translucency; the theme decides whether a surface is glass. Paint content on
  the surface you were given.

### `hideBorders` removes every border

Appearance → *Hide interface borders* is a stored preference that defaults to on. The
host sets `data-hide-borders="true"` on `<body>`, turns the border tokens
(`--border`, `--border-soft`, `--border-subtle`, `--hair*`, `--control-border`,
`--surface-divider`, `--material-glass-border`, `--overlay-border`,
`--bubble-user-line`) transparent, **and** applies `border-color: transparent
!important` to every element. A package's `border: 1px solid var(--border)` does
not fade — it disappears, taking the card, the divider and the outline with it.

- An intentional line inside content is an **inset shadow from
  `--borderless-edge`**:
  `box-shadow: inset 0 -1px 0 var(--borderless-edge)`.
  That is the documented recipe for table rules, activity threads and drop
  targets, and it survives borderless mode.
- A surface contour uses `--contour`, which the theme resolves on the root and
  borderless mode deliberately keeps. Do not draw a contour from `--hair*`.
- Focus indicators are restored (`:focus-visible` gets the accent edge) and
  signal rings such as `Spinner` keep theirs; do not "fix" those with your own
  outline.
- If you draw a border for structure, test the surface with borderless on. There
  is no per-package override: a package that needs `!important` to keep a border
  is drawing the wrong thing.

### `--elevated` is invisible on glass and on a light canvas

`--elevated` is the *host's* raised-surface step, not a universal card fill:

- In light themes it is white or near-white (`#ffffff` in most light themes,
  `#fffdf5` in e.g. Solarized) while the canvas is already
  `#f4f6f8`/`#faf8f4`, so a white card on a white content area has no edge.
- In glass themes the material itself is `--elevated`
  (`--material-glass: var(--elevated)`), so a nested card painted with it is
  exactly the panel it sits on.

Nest with a **wash**, not a second surface: `background: var(--surface-overlay)`
at rest, `--surface-overlay-hover`/`--raised` for hover or selection, plus
`--contour` (or a `--borderless-edge` inset line) for the edge. The same rule
applies to the third level inside a card: at some point the answer is spacing, not
another fill.

## Recipes

The recipes assume a current host. `Switch`, `Skeleton`, `Badge`, `SettingsRow`
and `SettingsSection` are optional parts — feature-detect them when the package
must also run on an older host.

### 1. A package settings form

```tsx
<host.ui.components.SettingsSection title="Usage" hint="Counting is local to this project.">
  <host.ui.components.SettingsRow label="Show cost" hint="Adds an estimate beside each turn." itemId="usage.showCost">
    <host.ui.components.Switch
      checked={showCost}
      onChange={(next) => save({ showCost: next })}
      label="Show cost"
    />
  </host.ui.components.SettingsRow>
  <host.ui.components.SettingsRow label="Window" layout="stacked">
    <host.ui.components.Select
      label="Window"
      value={range}
      options={[{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]}
      onChange={(next) => save({ range: next })}
    />
  </host.ui.components.SettingsRow>
  <host.ui.components.SettingsRow label="Note" hint="Optional." layout="stacked">
    <host.ui.components.TextInput
      id="usage-note"
      value={note}
      invalid={note.length > 200}
      onChange={(event) => setNote(event.target.value)}
      aria-describedby="usage-note-hint"
    />
  </host.ui.components.SettingsRow>
  {error && <host.ui.components.Notice tone="error" role="alert">{error}</host.ui.components.Notice>}
</host.ui.components.SettingsSection>
```

Rows carry the labels and hints; the control only needs its own accessible name
where the row's label does not label it (`Switch` is a button, `TextInput` is a
bare input), which is why both repeat the name here.

### 2. Search, list, empty and loading

```tsx
<div className="usage-list" aria-busy={loading || undefined}>
  <label htmlFor="usage-search" className="usage-search-label">Search runs</label>
  <host.ui.components.TextInput
    id="usage-search"
    type="search"
    value={query}
    onChange={(event) => setQuery(event.target.value)}
    placeholder="Filter by model or date"
  />
  {loading ? (
    <div role="status" aria-label="Loading runs">
      {[0, 1, 2].map((row) => <host.ui.components.Skeleton key={row} shape="block" height={48} />)}
    </div>
  ) : runs.length === 0 ? (
    <host.ui.components.EmptyState
      variant="compact"
      title={query ? "No runs match" : "No runs yet"}
      description={query ? "Try a shorter search." : "Runs appear here after your next turn."}
      {...(!query ? { actionLabel: "Open chat", onAction: openChat } : {})}
    />
  ) : (
    <ul className="usage-rows">
      {runs.map((run) => (
        <li key={run.id}>
          <button type="button" className="usage-row" onClick={() => open(run.id)}>
            <span className="usage-row-title">{run.model}</span>
            <span className="usage-row-meta">{run.when}</span>
            <host.ui.components.Badge tone={run.ok ? "success" : "danger"}>{run.ok ? "Done" : "Failed"}</host.ui.components.Badge>
          </button>
        </li>
      ))}
    </ul>
  )}
</div>
```

The search field is labelled, the busy state is on the container (skeletons are
decorative), each row is a real button with visible text, and the badge never
relies on colour alone. No `role="listbox"` here: it is a list of links/actions,
not a select.

### 3. Confirm before destroying

```tsx
const remove = async () => {
  const ok = await host.ui.confirm("Delete this saved view? This cannot be undone.", {
    title: "Delete view",
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!ok) return;
  await host.storage.delete(`view.${id}`);
  close();
};

// Or, for a form that needs more than one line of copy:
<host.ui.components.Dialog
  title="Delete view"
  onClose={close}
  footer={
    <>
      <host.ui.components.Button variant="ghost" onClick={close}>Cancel</host.ui.components.Button>
      <host.ui.components.Button variant="danger" busy={deleting} onClick={remove}>Delete</host.ui.components.Button>
    </>
  }
>
  <p>“{name}” will be removed for everyone in this project.</p>
</host.ui.components.Dialog>
```

`confirm` is the one-sentence path (it resolves `false` on cancel or `Escape`);
the framed `Dialog` is for copy the person must read. Both keep focus handling,
which a hand-built overlay does not.

## Checks before shipping

- No import from `apps/web` or another package; parts come from the host.
- Optional parts feature-detected, no unconditional `bindHostUi` access to an
  optional component.
- Every control has an accessible name, every icon-only button a `label`.
- Dialog/Menu/Tabs state is controlled from package state; no second focus trap
  or Escape handler.
- `grep` for `border:` in package CSS and confirm the surface still reads with
  *Hide interface borders* on; no hardcoded px font sizes, radii or durations.
- Package CSS is scoped under its root and redefines no canonical token.
