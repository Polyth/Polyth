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
- Inputs keep the 16px font floor (`--font-input`) to prevent mobile zoom.

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
