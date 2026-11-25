# Apps (`@polyth/page-apps`)

A person keeps a page an agent drew (a ```` ```page ```` block of
`@polyth/chat-blocks`) as an **app**: it gets a name, opens from the Workspace
or in a window of its own, and remembers what it stores. This is stage 1 of
"artifacts as apps": the app is exactly the sandboxed page it was in the chat,
plus persistence. It has no network, no access to chats, files, tools or
models, and asks for no permission, because it is given nothing to permit.

## What a person sees

- **Save as app** on every page block (the grid button before Full screen).
  Saving the same page again updates the app instead of making a second one:
  the same project file (`from=`), or the same chat and title, is the same
  app, and a changed page becomes its next version. The notification names
  the outcome and offers Open.
- **Apps** in the launcher (Workspace window `page-apps`): the list, newest
  first, each with *Open in a window* and a menu (Rename, Remove).
- A running app fills the window edge to edge under a slim bar (All apps,
  Reload, Open in a window, menu): the surface declares the `workspace`
  content mode (`withSurfaceContent`), so the list owns its own padding. On a
  phone the window's own Back returns to the list (`host.ui.useWindowBack`)
  and the bar draws no second arrow. **In a window of its own** the bar is gone and the window is
  named after the app (`host.navigation.openPaneWindow`, `docs/dev/ui.md`
  "Second windows"): one window per app, beside the main window, on the
  desktop app a native window.
- An app updated elsewhere (saved again from the chat, or on another device)
  reloads when its window next has focus; one removed elsewhere says so.

## Boundaries

- **Person-owned.** Apps live in the signed-in person's own storage, per
  Space: `host.people.storage(userId, "page-apps")` →
  `spaces/<spaceId>/apps/<id>/{app.json,page.html,storage.json}`. Nobody else
  in the Space sees them; a system authority keeps none. Another person's or
  another Space's app id answers exactly like an id that never existed (404).
- **Ids are minted by the server** (UUIDs) and checked against that shape
  before any path is built; they travel in bodies and queries, never in a
  path segment.
- **The page is data.** It is returned as JSON text to the person who saved it
  and shown only in the `sandbox="allow-scripts"` frame under the page policy
  (`@polyth/chat-blocks/page-surface`). No route serves it as a document of
  the Polyth origin, and none must: that would run agent-written script with
  the person's session.
- **Limits** (`src/apps.ts`, shared with the page block's own): 100 apps per
  person and Space, 512 KB a page, 120 characters a name; storage 200 keys,
  64 KB a value, 256 KB in all. A write over the storage limit is refused as a
  whole (413) and the app says its data was not saved.
- **Source** (`sessionId`, `projectId`, `from`) is kept only to recognise the
  same page again. It is compared with the person's own apps and never used to
  open a chat, a project or a file.
- Paired devices follow `PAGE_APPS_REMOTE_ACCESS`: reading needs the session
  read capability, changing the session control capability, bodies bounded.

## Routes (`/api/page-apps`)

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `GET /api/page-apps` | | `{ apps }`, records without pages |
| `GET /api/page-apps/app` | `?id=` | `{ app, html, storage }` |
| `POST /api/page-apps` | `{ title, html, source? }` | `{ app, outcome }`, outcome `created`, `updated` or `unchanged` |
| `POST /api/page-apps/update` | `{ id, title }` | `{ app }` |
| `POST /api/page-apps/delete` | `{ id }` | `{ removed }` |
| `POST /api/page-apps/storage` | `{ id, clear?, remove?, set? }` | `{ keys }`; applied as clear, then removals, then values |

## Storage a page keeps

The page uses `window.polyth.storage` (see the chat-blocks README). The
runner seeds the frame with the stored map, mirrors every change in the
window at once, and sends the changes of a burst as one request, one request
at a time (`createStorageWriter` in `widgets/client.ts`); what is pending is
sent when the window is hidden or closed. Two windows of one app each keep
their own mirror: the last write of a key wins, and a window sees the other's
values on its next load.

## Not in this stage

No notifications, tray or shortcuts for an app, no network, no call to an
agent or a connector from a page, no sharing with other members, no install
to a phone's home screen. `polyth.send` does nothing in an app.

## Tests

`test/serverEntry.test.ts` (ownership with a known-valid foreign id, ids and
paths, limits, damaged files), `test/apps.test.ts` (the pure model),
`test/client.test.ts` (the storage writer), `test/widgets.test.ts` (the
mounted window against a stubbed transport: list, running app, own window,
phone Back, and what Save as app sends and says).
