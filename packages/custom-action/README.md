# Custom actions (`@polyth/custom-action`)

One-tap buttons for a person's own commands. An action is a name, a glyph and
tint, a shell command (one line or a whole script), and what a press does:

| Mode | A press… | Runs on |
| --- | --- | --- |
| `background` (*Result card*) | runs on its own; the icon shows a progress ring, then a check or an alert mark; from a rail or toolbar the result shows as a result notification of the host stack, from the window it streams into a run sheet | server run manager (below) |
| `terminal` | opens a Terminal tab with the command, named after the action | the terminal package's ordinary `/api/terminals` route |
| `chat` | runs the command, then starts a new chat with the person's instructions plus the framed output, on a chosen harness and model | server run manager + canonical session service |

An action belongs to one project (`projectId`) or to every project of the
Space (`projectId: null`). Every surface shows the selected project's own
actions plus the Space-wide ones; a run always happens in one concrete project.

An action can **ask before running** (`confirm: { message }`, absent = off;
the editor's *Ask before running* switch plus an optional message of up to
500 characters). Every press of any surface — tile, toolbar, rail launcher,
*Run again* — goes through `startAction`, which awaits the host's themed
confirmation (`apps/web/src/alerts.ts`, via `widgets/confirmRun.ts`) before it
opens a Terminal tab or starts a run. The dialog shows the person's message, or
the first lines of the command when it is empty; declining starts nothing and
leaves no launch feedback. Rejoining a run already in progress starts nothing,
so it does not ask. The step guards against an accidental press; it is not a
permission check, and the server's run route does not require it.

## Surfaces (web, `widgets/`)

- **Window** — `surfaces.register("custom-action")` + capability
  `custom-action` (rail launcher, palette, phone Workspace launcher). A
  shortcut launcher: project picker, a calm *Edit* / *New action* toolbar, and
  fixed-size tiles (glyph over name, an auto-fill grid so a 390px phone gets
  three columns) for the project's actions and the Space-wide ones. A tile
  shows its run state as a hairline edge plus a status line (running
  stopwatch, done, exit code) and no mode label (the mode is in the editor).
  Only non-empty scopes are drawn; headings appear only when both scopes have
  actions, and a dashed *New action* tile ends the grid. Nothing at all gives
  one empty state with starters. *Recent runs* is a collapsed accordion
  (header: count + latest run's status; open state remembered under
  `custom-action.recentRunsOpen`). *Edit* switches a press to "edit"; mouse and
  keyboard also get a ⋯ menu on each tile, touch shows a quiet ⋯ and also opens
  it by long press. Tiles reorder by drag (mouse) or *Move earlier/later*,
  and the same drag carries the action's launcher capability
  (`setDragCapability`), so dropping a tile on any icon rail puts that
  action's icon there (the host arms the rails; `docs/dev/ui.md` § rails).
- **Settings → Customize → Custom actions** — the same library as rows; a row
  opens the editor.
- **Widgets** — `custom-action.bar` (a row of icons for the session header,
  composer, top rail, status bar…; shows itself only once the project has an
  action), `custom-action.panel` (tiles for the Canvas, the phone Workspace and
  the idle screen) and `custom-action.command` (one chosen action; the original
  widget id, so old placements keep working — an old instance that still
  embeds its own command keeps running it in Terminal and offers *Save as
  custom action*).
- **Editor** — dialog on desktop, tall sheet on phone. Glyph and tint picker,
  command, mode cards, the chat options (the composer's own harness tabs and
  model picker, instructions, *Start the chat: always / if it fails / if it
  succeeds*), *Ask before running* with its optional message, and
  *Available in: this project / all projects*. An unnamed
  action is named after its command.
- **Result notifications** (`widgets/ResultCards.tsx`) — what a press from
  a rail launcher or a toolbar widget (`custom-action.bar`,
  `custom-action.command`) shows for a `background` or `chat` run. A
  renderless controller contributed once to the host's `app.layers` slot
  shows one notification per run through `host.notifications`
  (`custom-action.run.<id>`, stored under the package's namespace by the
  activation and dismissed when the package is disabled), so the card,
  placement, stacking, swipe, motion and announcements are the host's
  standard (ui.md §4.8); ticks update it in place. On an older host without
  `host.notifications` the press opens the run in the Custom actions window
  instead. It carries the action's glyph,
  name, live status and stopwatch, the last five plain-text output lines as
  the excerpt, and Stop / Run again / Open chat, Copy and *Full output* (the
  run in the window). A finished success counts down six seconds (the
  hairline; paused while the person is on the stack); a failure is an `error`
  that stays until it is closed and raises no separate host notice. Closing
  it marks the run seen. The window and the panel widget keep the run sheet.
- **Run sheet** — live output with terminal colours, carriage-return
  progress collapsed (`src/terminalText.ts`), Stop, Run again, Copy, Open chat,
  and *Ask an agent* (a new-chat draft holding the framed output).

## One launcher per action

Every action is also a `command` capability, `custom-action.run.<id>`
(`widgets/railLaunchers.tsx`), carrying the action's glyph, so it can sit on any
rail (top, header, right, sidebar, composer, status bar) and in search like a
package icon. A press runs the action in the active project without opening or
closing a pane: a background or chat run shows a result notification of the
host stack (a running one re-opens it), a Terminal action opens its Terminal tab, and from another
project's scope it asks to choose a project first. Renaming or changing the
glyph re-registers the launcher in place, so it keeps its place.

A launcher is **opt-in**: it registers with `standardTier: "technical"`
(searchable, one click away in the rail editor) until it is added to the right
rail. Three ways to do that, all through `host.capabilities.place`: the tile's
⋯ menu *Add to / Remove from rail* (only for the project the window is showing
and only where the action applies; otherwise it is disabled with a hint), the
editor's *Show on rail* switch (shown when the action applies to the open
project; on by default for a new action), or the rail editor itself. Creating
an action confirms it with a `success` notification, "{name} added": "On the
rail" with *Remove from rail* when the editor's switch placed it, or *Add to
rail* when it was left off and the action applies to the open project
(`announceCreated`). Actions
that existed before the rule were on the right rail, so every launcher also
registers `legacyStandardTier: "more"`: a project that had already seen it and
never placed it explicitly keeps it there (`docs/dev/ui.md` §4.4); a never-seen
launcher starts under Technical.

`widgets/store.ts` is the one client store for all of them: the library, the
caller's permissions, runs (polled only while one is active, slower while the
page is hidden) and short-lived launch feedback. Same-browser tabs refresh
each other through a `BroadcastChannel`; other devices refresh on focus. A
failed or timed-out run started in this tab raises one host notice with *Show
output*; a finished `chat` run opens its chat unless the person has moved to
another chat or project since the press.

Hosts read widget availability synchronously, so the web entry re-registers
the widget plugin whenever the set of actions or their scopes changes
(`availabilityKey`); renames do not re-register.

## Server (`src/`)

- `actionModel.ts` — the shared, browser-safe model and validation
  (`normalizeActionInput` names the refused field for the editor).
- `actionStore.ts` — `<space>/packages/custom-action/actions.json` through
  `host.spaceStorage(space)`: per-file write queue, temp file + rename, an
  unreadable file is moved aside (`actions.json.unreadable-<ts>`) instead of
  being overwritten, 200 actions per Space.
- `runManager.ts` — background and chat runs on the terminal package's
  `TerminalService.create({ hidden: true })`: the same kernel containment
  boundary as every Polyth terminal, kept out of Terminal tab lists. Output
  is a 256 000-character tail with absolute offsets (`GET …/output?from=`
  streams only what is new). One running instance per person, action and
  project (a second press joins it), six concurrent runs per person, a
  30-minute limit. A stop or time limit that the terminal service cannot
  confirm is reported as an error that "may still be running", never as
  stopped. Runs are in memory and private to the person and Space that
  started them.
- `chatPrompt.ts` — the hand-off message: instructions first (or the output
  block where `{{output}}` stands), then the command and its outcome, then the
  plain-text tail of the output (48 000 characters, ANSI removed) in fences
  longer than any backtick run, explicitly marked as data, not instructions.
- `serverEntry.ts` — `startChat`: `host.forSpace(space).sessions.create`
  in the run's project (reusing the launching chat's plain worktree when there
  is one) and one `send`. A send that fails after the chat exists reports the
  chat id and is never repeated.
- `routes.ts` — `/api/custom-action/*`. Everything resolves through the
  gateway-validated `rc.space`; a run request carries only ids, never command
  text. Viewers and the `multi-tenant-sandboxed` deployment can neither author
  nor run.

### Paired devices (`CUSTOM_ACTION_REMOTE_ACCESS`)

Default-deny like every package. Reading the library and runs, running and
stopping need `terminal.open` (the grant that already opens a Terminal with a
command); creating, editing, reordering and deleting a command need
`terminal.input`; a `chat` run additionally checks `core.sessions.create` and
`core.sessions.message` in the handler. The list response tells the UI what
the caller may do (`canManage`, `canRun`, `canChat`, `blocked`).

## Verification

```sh
node scripts/run-bounded-check.mjs --seconds 240 --memory-mib 3072 --cpu-percent 100 -- \
  node --experimental-strip-types --test --test-concurrency=1 --test-force-exit packages/custom-action/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/custom-action/tsconfig.json
```

`runManagerTerminal.test.ts` runs real shells through the real terminal
service; `actionLibrary.test.ts` mounts the window in happy-dom against a fake
server. A live chat hand-off needs a real harness turn and is not covered by
the automated tests.
