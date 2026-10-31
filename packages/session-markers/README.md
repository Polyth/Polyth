# Chat markers

Chat markers (`@polyth/session-markers`, package id `session-markers`) let people and
agents mark chats (sessions) by state: **Needs review** (`needs-review`), **Reply
later** (`reply-later`), **Important** (`important`), plus any number of custom markers
(up to 50 per Space) with their own name, color and icon. A marker can carry a
short note ("Token refresh rewritten").

The package is one removable folder. The host never names it; it reaches the UI
only through generic seams and its data lives under its own id.

## Where markers show

| Surface | Seam | What it does |
| --- | --- | --- |
| Navigator row | `session.list.badges` | Tinted glyphs (up to two, then `+n`); the tooltip and accessible name list every marker with its note. |
| Row menu | `sidebar.session.actions` | A **Markers** section after the other actions: toggle each marker, **Custom marker…**, **Remove all markers**. |
| Selection bar menu | `sidebar.sessions.bulk.actions` | Add a marker to every selected chat, or remove it once all of them have it. |
| Chat header | `session.header.status` | Labelled chips for the open chat. |
| Marker dialog | `app.layers` | Name (or pick an existing custom marker), color, icon, optional note. It outlives the menu that opened it. |
| Session lists' Group by | `host.sessions.registerGrouping` | **Marker**: a heading per marker in the marker list's order; a chat with several markers sits under the first, unmarked chats come last. |
| Marked chats widget | `workspace.right` (also left/main/bottom), off by default | Every marked chat of the Space, grouped by marker, with a marker filter. |
| Settings → Customize → Chat markers | settings page | Predefined markers with usage counts; create, edit and delete custom markers. |

Predefined marker names are localized (`src/i18n`, merged by `npm run i18n:generate`);
custom markers keep the name their author gave them. Colors are the canonical
status tokens (`--amber`, `--blue`, `--red`, `--green`, `--purple`, the accent, and
`--muted` for gray), so every theme and contrast mode applies.

## Agents

The package registers the `polyth_session_markers` tool and the
`polyth-session-markers` skill through the `harness.capabilities` registry while it
is enabled. The skill tells an agent that a request such as "review the code of
every chat that needs review" means: call `polyth_session_markers` with
`action: "list"` and the marker first, then read each listed chat (Polyth
`session.get` / `session.messages`). It never guesses from titles.

Tool actions:

- `list` — chats with a marker (`marker` optional, `projectId`, `includeArchived`).
  Each row has the session id, title, project, and every marker with its time,
  author and note.
- `markers` — every marker of the Space with its id, name and description.
- `get` — the markers of one chat (defaults to the calling chat).
- `add` / `remove` — mark or unmark `sessionId` / `sessionIds` (defaults to the
  calling chat). Adding an unknown name creates a custom marker.

A marker is addressed by id or name and matching ignores case, spacing and
punctuation (`"Needs review"`, `needs_review` and `needs-review` are the same).

The tool acts with the view of the person the turn answers (`actorUserId` →
`personSpaceContext`). It sees and marks only chats that person can open. A turn
with no acting person (system work) may read and mark only its own chat. Viewers
cannot change markers. The tool is auto-approved: markers are reversible metadata
on chats the person can already open, and every change shows in the navigator.

## Data, API and access

Markers are Space data stored in one document,
`<space>/packages/session-markers/markers.json` (`version: 1`, a revision,
the custom definitions and `sessionId → markers`). Built-ins are never stored.
Writes in one process are serialized per Space and written atomically.
Every route works on `rc.space`:

| Route | Body | Notes |
| --- | --- | --- |
| `GET /api/session-markers` | — | Definitions plus the marked chats the caller can open (title, project, archived, markers), newest first. |
| `POST /api/session-markers/apply` | `{ sessionIds, add?: [{ marker, note? }] \| string[], remove?: string[], clear?, create? }` | Every chat is checked first. A foreign, hidden or absent id refuses the whole batch with the same `404`, and nothing is written. |
| `POST /api/session-markers/definitions` | `{ label, color?, icon?, description? }` | Creates a custom marker, or returns the existing one with that name. |
| `POST /api/session-markers/definitions/update` | `{ id, label?, color?, icon?, description? }` | The id stays, so chats keep the marker. |
| `POST /api/session-markers/definitions/delete` | `{ id }` | Takes the marker off every chat. Predefined markers can't be changed or deleted. |

Marker ids travel in bodies, never in paths. Paired devices may `GET` with
`core.sessions.read` and use the mutations with `core.sessions.control`
(`SESSION_MARKERS_REMOTE_ACCESS`). A viewer gets `403` on every mutation. A chat
that no longer exists loses its markers on the next read. A chat the caller
cannot open keeps its markers for the people who can, and is never reported to
the caller.

The browser keeps one snapshot (`widgets/client.ts`). It refreshes after each
change, when an agent's `polyth_session_markers` result arrives in a session the
client follows, when the window becomes visible, and every 60 s while visible.

## Tests

`node scripts/run-tests.mjs packages/session-markers/test/*.test.ts` covers the
model (matching, limits, lenient parsing), the routes (Space isolation, hidden
chats, viewers, pruning, definitions), the remote-access policy, and the agent
tool and skill (listing by name, person scoping, system turns, enable/disable).
