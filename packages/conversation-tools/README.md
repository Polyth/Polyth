# Conversation

Find text in the active conversation with **Ctrl/Cmd+F** (configurable as
*Find in conversation* in Settings → Shortcuts) or the **Find in conversation**
command. Search opens in a modal dialog on desktop and mobile alike; nothing is
added to the chat by default. On mobile, add the optional **Find in
conversation** mini-widget from the Widget Library (or by editing the composer
rail) to `composer.leading`/`composer.trailing` or a workspace slot. Enter selects the next occurrence,
Shift+Enter selects the previous one, and Escape closes the search. Navigation
wraps at either end. The panel displays the occurrence count and a highlighted
excerpt, and reveals the containing message while retaining search focus.

Search includes the complete canonical user/assistant message text, including
Markdown source, beyond the loaded timeline window. It excludes hidden runtime
prompts, tool output, reasoning and rewound tails. Final answers replace their
streaming chunks. Confirmed message and rewind events refresh an open search.
Results return in bounded pages of 100 occurrences; the count covers the entire
conversation. Search and navigation append no session events and start no
provider turns. State is temporary and closes when the selected session changes
or the package is disabled.

`GET /api/conversation/:sessionId/find?q=...&offset=...` validates session
ownership through `host.forSpace(rc.space)` before reading history. Paired devices
require the existing `core.sessions.read` grant, checked by the gateway on every
request. No search cache crosses Space or account identities.

The package registers the dialog host through `session.composer.before`, the
`conversation-find` capability (`launcherWidget: false`, since the package ships
its own `conversation.find` mini-widget) and that widget (`defaultVisible:
false`). Only one mounted host renders the dialog. The host's
optional `conversation.revealEvent` seam owns history loading and timeline
window navigation. Transcript highlighting requires
host integration; the highlighted result excerpt works independently.

Focused verification:

```sh
node --experimental-strip-types --test packages/conversation-tools/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/conversation-tools
```
