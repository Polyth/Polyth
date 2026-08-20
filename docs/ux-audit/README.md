# Polyth Ember UX direction — approval brief

> **Status / Статус:** Awaiting approval before implementing in `apps/web`.
> **Очікуємо на погодження перед будь-якою реалізацією в `apps/web`.**

## Вердикт

Polyth уже має впізнавану теплу Ember-айдентику, але ключові робочі поверхні поки виглядають як технічна оболонка: порожні стани не ведуть до дії, composer розпадається на окремі контролери, а навігація правої панелі та налаштувань вимагає зайвого розпізнавання.

Запропонований напрям зберігає темну теплу палітру Polyth і піднімає продукт до рівня зрілої локальної AI-IDE: впевнений старт, цілісний composer, зрозумілий стан роботи, згруповані налаштування, keyboard-first вибір проєкту та knowledge layer. Persona onboarding, actionable Context і локальні knowledge notes дають Polyth власну перевагу, а не лише паритет з polyth.

## Verdict

Polyth already has a distinctive warm Ember identity, but its core work surfaces still read as technical scaffolding: empty states do not lead to action, the composer is fragmented across separate controls, and the right rail and settings navigation add avoidable recognition cost.

This direction keeps Polyth’s dark, warm character while making it feel like a shipped local AI IDE: a confident start, one coherent composer, visible work status, grouped settings, a keyboard-first project picker, and a useful knowledge layer. Persona onboarding, actionable Context, and local knowledge notes move Polyth beyond parity instead of merely reproducing polyth.

## Punch list

| Priority | Surface | Problem in live Polyth | What polyth does better | Polyth-better proposal |
|---|---|---|---|---|
| P0 | New chat | Passive, technical empty state | Leads with a confident project-aware question | Project-specific hero, warm framing, persona-aware actions, and two rows of useful starting prompts |
| P0 | Composer | Plain textarea; model and agent controls feel attached afterward | Inline tools, model/mode chrome, and clear send hierarchy | One elevated command surface with `+`, `@`, `/`, `#`, `!`, model, agent, voice, and a strong Ember send action |
| P0 | Open project | Requires typing an exact path | Keyboard-first folder browsing | Native-feeling Ember folder picker with breadcrumbs, hidden-file toggle, clone flow, row selection, and keyboard legend |
| P0 | Sessions | “No sessions.” is a dead end | Recent sessions are titled and immediately scannable | Prominent New session action, meaningful titles, relative activity, and a live working indicator |
| P0 | Settings | Flat 16-item list | Groups settings by mental model | Searchable modal grouped into Interface, Workspace, Tools, and Account with dense, calm controls |
| P1 | Right rail | Labels truncate and icons require hover guessing | Clear panel hierarchy | Full readable labels at rest, persistent active state, and precise hover tooltips |
| P1 | Context | Empty copy reports absence but offers no next step | Stronger panel framing | Filled work-status card for context, cost, files, and an actionable goal empty state |
| P1 | Files | File tree has no editor resting state | Tree and editor behave as one workspace | Empty editor canvas with explicit file-picking action and shortcut |
| P1 | Browser / Preview | No running-server awareness | Running servers are visible | Detected localhost services with status, open/copy actions, plus Preview readiness |
| P1 | Knowledge | Notes, todos, and plans are absent from the main flow | Knowledge is a first-class workspace panel | Notes / Todo / Plans tabs, useful seeded notes, and composer `@note` retrieval |
| P2 | Status / help | Footer keyboard hints look like debug output | Chrome is quieter | Compact work-status bar for project, branch, model, and mode; shortcuts move behind discreet help |
| P2 | Onboarding | No explicit working-style setup | Competitor has no equivalent | Persona onboarding for Engineer, Manager, Creator, or Blank; defaults adapt without restricting capabilities |
| P2 | Git | Utility state lacks product framing | Clear dedicated Git panel | Calm “Working tree clean” state, branch context, refresh, and a discoverable stashes link |
| P2 | Command palette | Navigation and commands are distributed | Keyboard access is coherent | One ranked palette across Sessions, Commands, and Files with context-rich results and direct key hints |

## Mockup pages

1. [`mockups/index.html`](mockups/index.html) — review gallery and navigation hub.
2. [`mockups/01-onboarding-persona.html`](mockups/01-onboarding-persona.html) — persona-led first-run setup.
3. [`mockups/02-open-project.html`](mockups/02-open-project.html) — keyboard-first folder picker over the workspace.
4. [`mockups/03-chat-hero.html`](mockups/03-chat-hero.html) — complete new-session hero, composer, Context, rail, and status.
5. [`mockups/04-composer-session.html`](mockups/04-composer-session.html) — active conversation with code response and docked composer.
6. [`mockups/05-settings.html`](mockups/05-settings.html) — grouped, searchable Ember settings.
7. [`mockups/06-files-git.html`](mockups/06-files-git.html) — interactive Files / Git / Preview tool workspace.
8. [`mockups/07-command-palette.html`](mockups/07-command-palette.html) — cross-workspace keyboard command palette.
9. [`mockups/08-knowledge-notes.html`](mockups/08-knowledge-notes.html) — Notes / Todo / Plans as reusable local context.
10. [`mockups/tokens.css`](mockups/tokens.css) — shared Ember tokens and reusable application chrome.

## Approval gate / Точка погодження

These files are design artifacts only. They do not modify the live product. **Awaiting approval before implementing in `apps/web`.**

Ці файли є лише дизайн-артефактами й не змінюють живий продукт. **Очікуємо на погодження перед реалізацією в `apps/web`.**
