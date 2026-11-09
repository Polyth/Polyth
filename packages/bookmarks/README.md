# Bookmarks

Bookmarks (`@polyth/bookmarks`, package id `bookmarks`) let a person keep what
matters from a chat: an answer with all its links, in a list they can walk
through, read and export. The package is one removable folder: the host never
names it, and without it the chat is exactly as it was.

## Where it shows

| Surface | Seam | What it does |
| --- | --- | --- |
| Under an answer | `session.message.actions` | An ordinary quick action: Settings > Chat > Buttons and bars puts it on the bar, in the More menu or off. On touch it starts in More, like every other answer action. `meta.messageAction.menuLabel` makes the row say Bookmark or Remove bookmark. |
| The list | `host.surfaces.register`, `host.capabilities.register` | A page on a phone, a pane beside Chat on a computer, opened from the Workspace tile or the right rail. A name goes to its place in the chat; the arrow opens the saved text. |
| The chat's bookmark icon | `session.prompt.tabs` | The floating icon that opens the prompt list gains tabs Bookmarks, Links and Prompts once the chat has a bookmark. The icon then fills, and shows in that chat though its setting is off. Before the first bookmark the popover is today's list plus one row that bookmarks the latest answer. |
| A text selection | `session.selection.actions` | Bookmark beside Quote and Copy, in the floating toolbar and the touch dock. It keeps the selected passage as Markdown, so links and code survive. |
| The walk | `session.composer.before` | One line above the composer while walking: position, title, previous, next, end (Alt+Up and Alt+Down on a keyboard). Its title opens the list. |

The row in the popover saves what is being read: the section under the nearest
heading, else the whole answer. A section or a selection reopens on its own words,
which light up for a moment (`revealEvent`'s `passage`), not just on its message.

In the list a person changes a bookmark's title and text, adds their own note
beside it, and writes new notes: a note made in the "This chat" view stays in that
chat's list, one made in "Whole project" stays beside the project's chats. If
another device saved first, the editor says so and lets them choose which version
stays. Editing never touches the chat itself.

A link in saved text behaves like a link in a chat: it opens outside Polyth, and
the list is still there when the person comes back.

## Data, API and access

Bookmarks belong to one person in one Space, not to the chat, so nothing here is
model-visible and nothing enters session history. They live in the person's own
storage (`host.people`), outside the Space and outside every project:

```
people/<userId>/packages/bookmarks/spaces/<spaceId>/index.json       the list
people/<userId>/packages/bookmarks/spaces/<spaceId>/bodies/<id>.md   saved text
```

The list carries no saved text, so refreshing it on a phone stays cheap; a text
is read when it is opened. There is no push channel: the browser refreshes after
each change, when the project changes, when the window comes back, and every
60 seconds while visible.

| Route | Purpose |
| --- | --- |
| `GET /api/bookmarks?projectId=&sessionId=` | The list |
| `GET /api/bookmarks/body?id=` | One saved text |
| `GET /api/bookmarks/export?projectId=&sessionId=` | One Markdown file for a chat or a project |
| `POST /api/bookmarks` | Save (one answer is one bookmark, whichever device saved it) |
| `POST /api/bookmarks/update` | Change, with `revision`; a stale device gets 409, never a silent overwrite |
| `POST /api/bookmarks/delete` | Remove; the answer carries what undo needs |

Paired devices read with the sessions read grant and change with the sessions
control grant. System work has no bookmarks.

Access follows the chat at every read, through the caller's scoped session
service:

- A chat the person can open shows its place. The project and title come from the
  chat, never from what the browser said.
- The person's own deleted chat keeps its bookmarks, without a place to go.
- Someone else's chat: a bookmark hides while access is withdrawn and returns with
  it; once the chat is deleted the copy is erased.
- A foreign or absent chat id gets the same answer.

## Limits

512 KiB of text per bookmark, 20,000 characters per note, 5,000 bookmarks per
person in a Space, 32 MiB per export.
