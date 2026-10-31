# Polyth component contract

How to **create** a new component and — more often — how to **safely modify an
existing one**. Read `ui.md` first for ownership/extension questions and
`styles.md` before writing any CSS. This guide applies to both host
components (`apps/web/src/components/`) and package components
(`packages/<feature>/widgets/`); the ownership rules differ, the construction
rules do not.

## 1. Ownership: know whose component it is before touching it

Before editing anything, answer four questions:

1. **Locate the owner.** Is this component host/core UI (`apps/web/src/…`) or
   feature UI (`packages/<feature>/widgets/`)? Host components implement the
   shell, shared primitives, and registry hosts. Feature components implement
   one package's views. There is no third layer.
2. **Locate existing consumers.** `grep -rn "<ComponentName>" apps packages`
   — every import site. Changing a component's props/behavior is a change to
   every consumer.
3. **Locate existing reusable primitives.** Before building, check
   `apps/web/src/components/ui/` (Button, IconButton, Checkbox, Switch,
   Select, TextInput, Textarea, Tabs, Badge, Spinner, Skeleton, Popover,
   Menu, Tooltip, Dialog, ResponsiveOverlay, Notice, Separator, Progress,
   VisuallyHidden, …), `components/a11y/` (Dialog, Menu, roving, live
   regions), `components/EmptyState.tsx`, `CopyButton.tsx`. Also search the
   package's own `widgets/` tree — the component you need may already exist.
4. **Classify the change.** Host-level primitive change → host work.
   Feature-level behavior change → package work. If the fix "belongs" to the
   other layer, fix it there; do not patch around it.

Rules of ownership:

- **Never fork.** Do not create a second implementation because changing the
  first one is harder. If two or more packages need the same visual or
  interaction primitive, move/generalize it into the appropriate shared UI
  layer (host primitive for app-wide, package-owned component for one
  package) instead of copying CSS or component implementations.
- **Never override another owner's CSS.** Fix a component in the layer that
  owns it. Package CSS may not restyle shell components or other packages'
  components (`styles.md`).
- **Never mix package behavior into generic core primitives.** A host
  primitive stays generic; package-specific behavior is props, composition,
  or a package wrapper — not hardcoded package logic inside the primitive.
- **Host primitives stay contract-stable.** They are consumed by every
  package; changing one is a shared-contract change (find all consumers,
  update them, update tests).
- **Package surfaces are content, not windows.** `ContextRail` always wraps
  them in core `ModuleView`; packages never emit or
  style `.module-view*`/`.view-page`, duplicate the outer title, close,
  fullscreen, padding, scrolling, or responsive frame. A package may style a
  toolbar or detail heading inside its stable feature root.

Workspace content toolbars share `WorkspaceSurfaceHeader` through
`host.ui.components`; features supply scope selectors, filters and actions. It
does not replace the surrounding `ModuleView`. File links use the host
`ResourceLink` with explicit Project/session/repository provenance.
`host.resources.drag` preserves that identity and optional line selection or
working-change context. `host.projectSettings.open(projectId, contributionId)`
opens a registered Project settings contribution through the host dialog. See
[workspace behavior](workspace.md) for resolution, preview, drag-and-drop and
missing-repository rules.
A package row above the composer (`session.composer.before`) wraps its content
in the optional `host.ui.components.ComposerNoticeRow` so it grows in and
folds away with the composer's other notice rows.

## 2. Creating a component

1. Reuse before build (ladder above). If a primitive exists, compose it —
   do not reimplement.
2. Place it with its owner: package components under
   `packages/<feature>/widgets/<area>/`, host components under
   `apps/web/src/components/<area>/`, host primitives under
   `apps/web/src/components/ui/`.
3. Export through the owning index when one exists
   (`components/ui/index.ts`, package `widgets/index.tsx` entry).
4. Style with canonical tokens, scoped selectors, container-relative layout
   (`styles.md`).
5. Ship the minimal states that actually occur (see §4) and a runnable check
   for non-trivial logic (plain `node:test` + `node:assert`, DOM-free pure
   helpers separated from the component).
6. A component is not integrated until it is registered or mounted through
   the owner's seam (`ui.md` §3) — for feature UI that is `widgets/index.tsx`.

## 3. Modifying an existing component

- Inspect **all** call sites before changing props, behavior, or public API.
  Grep by name and by prop name; include tests and fixture files.
- Change consumers and tests **in the same change**. Do not leave a shim
  behind unless a consumer genuinely cannot be updated — compatibility shims
  are debt; add them only when actually needed and mark them
  (`# ponytail:`-style comment naming the removal path).
- Preserve the component's contract where the change is internal; extend
  props with optional fields where the change is additive (backward
  compatible, mirroring the event-log rule: optional fields, never repurposed
  ones).
- If the change alters model-visible data flow, verify the event-log
  invariant: append before display, and keep pure UI state out of the log.
- If the component is a registry host (SlotHost, WorkspaceHost, canvas,
  surface hosts), preserve per-contribution error isolation and deterministic
  ordering/disposal semantics (`ui.md` §7).

## 4. States

Consider deliberately, and only where they actually occur:

- normal
- hover
- active/pressed
- focus-visible
- disabled / unavailable (with an honest reason)
- loading / working / running (progress where duration is meaningful)
- empty / no-results
- error / failed
- selected / active (tabs, filters, list rows)
- narrow-container / mobile behavior

Do not mechanically add every state to every component; a state that cannot
occur is dead code. States must be communicated to assistive tech
(`aria-busy`, `role="status"`, `aria-expanded`, live regions — see §6).
Button hover, press, disabled and busy follow one contract ("Buttons" in
`design-system.md`): hover only where a pointer can hover, and a disabled
button is gray at rest and answers no hover, press or tap.

### Transient notifications

A passing message that is not tied to one control — an error, a run result,
a new version or its download progress, a hint, news — is a notification of
the host stack: `notify()` (`apps/web/src/notify/store.ts`) in the shell,
`host.notifications.show()` in a package. Never portal a bespoke toast,
banner or floating card, and never restyle the stack's cards from a package;
pass `icon`, `excerpt`, `actions` and `data-*` hooks instead. Status that
belongs to its control (a form error, "Saved" beside a toolbar button) stays
inline. A list of notification records (the notification centre) draws its
kind with the same `NotificationGlyph` (`apps/web/src/notify/`), never a
second icon/colour map. Cards are not live regions — the stack announces —
so do not add `role="alert"`/`aria-live` to notification content. Contract
and defaults: [ui.md §4.8](ui.md#notifications).

### Commands in the conversation

Expanded agent commands render as one terminal surface: a highlighted prompt
followed by the result. Command and result copy actions float over their own
regions and copy the complete payload, including output outside the preview.
Wide surfaces with fine pointers reveal actions on hover or keyboard focus;
touch and narrow surfaces keep them visible with the shared hit-area floor.
Long output expands inline or opens the shared full-output viewer. Execution
options and raw metadata are available through the terminal's details action;
elapsed time stays in the summary and only nonzero exit codes appear in the
terminal. The surface follows terminal font preferences and wraps commands
and long output in narrow containers.

## 5. Responsive / mobile behavior

Polyth runs on desktop, and its panels and widgets render inside resizable
containers — **feature content responds to its container, not to the
viewport**:

- Use container queries (`@container`) for embedded panel/card content
  (`styles.md` §Responsive rules).
- Viewport media queries are shell-level only (sidebar, header, bottom
  navigation, keyboard/safe-area handling).
- Respect: safe areas (`--safe-*` tokens), the visual viewport and software
  keyboard (`--visual-vh`, `--visual-bottom`, `--keyboard-inset`), coarse
  pointers (`--hit-min`/`--tap` hit targets — enlarge the transparent
  interactive box, never fake it with tiny glyphs), long labels (wrap, ellipsis
  where truncation is intended), and overflow (scroll containers inside
  bounded panes, never page growth).
- Phone **pickers** (Select, Picker, Menu pick lists, model/mode pickers,
  composer Add menu, and other anchored choosers) use a **compact Quiet Glass
  popover** adjacent to the trigger in the finger zone via
  `ResponsiveOverlay` / `Popover`. Do not default pickers to bottom sheets.
  Pass `phone="sheet"` or `mobileSheet` only for destination-like surfaces.
  Do **not** autofocus filter/search inputs when opening a phone picker (avoid
  summoning the keyboard on open).
- Motion comes with the primitives: `Sheet`, `Popover`, `Menu`, `Dialog` and
  Settings animate in and out by themselves — including when their owner just
  stops rendering them (exit ghosts) — and phone sheets follow a dismissing
  drag. Do not add a private entrance/exit or a second drag handler around
  them; a mode in a sheet's title row is `action: { kind: "switch", … }`
  rather than a toggling text button (see [UI architecture](ui.md), "Surface
  motion").
- Inputs keep the 16px font floor (`--font-input`) to prevent mobile zoom.
- Hover styling belongs inside `@media (hover: hover)`: touch engines keep
  `:hover` on the last tapped control, which reads as a stuck highlight and
  can mask a toggle's pressed tint. Press feedback uses `:active`.
- The composer keeps the editor focused when a touch/pen tap lands on one of
  its controls (Send included) or on a picker/menu it opens: the control acts
  on the first tap and the software keyboard stays open. Text fields still
  take focus. The rule is the host keep-keyboard seam in `mobileViewport.ts`:
  a surface opts in with `data-keep-keyboard` (the composer, and the
  terminal's bottom controls — [terminal.md](terminal.md)); while it holds
  the keyboard, `dismissKeyboard()` is a no-op (the usual "close the
  keyboard before a picker opens" rule does not apply) and overlay focus
  moves (Menu first item, Popover `initialFocus`, return-to-trigger) go through
  `focusUnlessKeyboardHeld()`. New overlay focus code must use that helper.
  Sheets and dialogs keep their own focus, except an alert that opts into
  `confirmAlert(..., { keepKeyboard: true })` — the Full access confirmation
  reaches `useModalSurface` with `keepKeyboard`, which then neither claims
  focus nor inerts the subtree holding the editor. A dialog that collects
  input (a prompt) must never opt in: it needs focus in its own field.

## 6. Accessibility basics

- Prefer semantic controls (`<button>`, `<input>`, `<select>`,
  `<dialog>`) and the host primitives, which already implement the hard parts
  (Dialog focus trap + restoration, Menu keyboard/roving, Popover
  positioning + dismissal, live regions).
- Keyboard navigation: every interactive element reachable and operable by
  keyboard; visible focus (`--focus-ring`, `focus-visible` styles).
- Accessible names: `aria-label`/`aria-labelledby` on icon-only controls
  (IconButton requires a `label`), inputs labelled by `<label>` or
  `aria-label`.
- State communication: `aria-expanded`, `aria-pressed`, `aria-busy`,
  `role="status"`/`"alert"` for async outcomes; `VisuallyHidden` text rather
  than nothing.
- Dialogs/popovers: use the host `Dialog`/`Popover`; restore focus on close
  (`resolveRestoreFocus` on the shared Dialog when the default is wrong).
- Never wrap a clickable in a non-interactive parent click handler; the
  interactive element itself handles activation.
- Hit targets: `--tap` (44px) on coarse pointers, `--hit-min` seam for
  dense rows.

## 7. Review checklist (component work)

- [ ] Owner identified; component placed in the owning layer
- [ ] All consumers found; contracts changed with consumers + tests together
- [ ] Existing primitive reused before a new one was considered
- [ ] No fork, no CSS override of another owner, no package logic in core
- [ ] Tokens used; styles scoped (`styles.md`)
- [ ] Only real states implemented; accessible state communication
- [ ] Container-relative responsive behavior; mobile hit targets
- [ ] Disposal/subscriptions cleaned up
- [ ] Tests updated; non-trivial logic has a runnable check
