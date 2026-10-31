# By the way

Ask a quick **side question** about the current chat — "btw, which file did
you change for the login fix?", "what does that error mean?" — while the agent
may still be working. The answer uses the chat's context, never interrupts or
queues into the running turn, uses no tools, and is never written to the chat's
history.

## Using it

- Type `/btw ` (trigger plus a space) at the very start of the composer, or
  choose **Ask on the side** in the composer's Add menu. The composer enters
  the *By the way* mode: a chip at the start of the input, an accent-tinted
  card, the placeholder "Ask a side question — the agent keeps working" and an
  **Ask** button.
- Enter or **Ask** sends the question to the side. The card above the composer
  shows it, thinks (skeleton shimmer and "Thinking…"), then reveals the answer
  as Markdown. The composer stays in the mode, so the next question is a
  follow-up; earlier questions collapse to one-line rows that expand on click.
- Card actions: **Copy answer**, **Add to chat** (leaves the mode and inserts
  `Q: …` / `A: …` into the draft — it never sends), **Close**. A failed
  answer shows a calm inline error with **Try again**.
- Leave the mode with × on its chip, Esc in an empty draft or Backspace at the
  start of an empty draft. Esc in an empty composer outside the mode, or inside
  the card, closes the card (which also leaves the mode).

The mode is offered only in an agent chat the person can work in: not before a
chat exists, not in a people conversation, not for a view-only reader.

## Ephemeral by design

Threads live in this tab's memory, one per chat: switching chats keeps a
thread, closing the card forgets it (an answer still on its way is dropped),
and disabling the package forgets all of them. Nothing is appended to the
session log, nothing reaches the chat's native agent session, and the person's
draft is cleared only once a question is accepted.

## Server

`POST /api/sessions/:id/btw` with `{ question, thread? }` returns `{ answer }`.

- The session is resolved through `host.forSpace(rc.space).sessions` first; an
  absent id and a known-valid foreign-Space id get the same 404 before the body
  or any history is read. People conversations are refused, and so are readers
  whose shared access is below `collaborate`.
- `question` is 1–4,000 characters; `thread` holds at most 6 earlier
  `{ question, answer }` pairs (answers are clipped to 4,000 characters).
- The transcript comes from the newest 6,000 canonical events
  (`buildBtwTranscript`): user messages and the agent's visible text, including
  the unfinished text of a running turn; tool calls appear only as short
  `[tool: name subject]` notes, and a run of them collapses into one bounded
  line. Hidden prompts, recovery blocks, reasoning and rewound tails are left
  out. The newest entries win a 24,000-character budget and keep their order;
  one long message is clipped in the middle.
- The prompt (`buildBtwPrompt`) frames the transcript as data, asks for a
  concise answer in the question's language from that context only, forbids
  tools and actions, and asks the model to say so when the context lacks the
  answer.
- It runs on the chat's own runtime and model (`host.resolveSessionRuntime`):
  `host.smallModelComplete` uses the runtime's tool-less direct completion when
  it has one and otherwise a throwaway one-shot session; a chat without a
  recorded model uses `host.oneShot` with the runtime default. Neither is the
  chat's native session. Timeout 90 s; failures come back as coded,
  calm errors (`unavailable` for a timeout or an empty answer).
- Remote access is local-only (`localOnlyRemoteAccess(["btw"])`), like fusion:
  `/api/sessions/*` belongs to the core remote scope, so paired devices
  (Polyth Link) cannot reach this route.

## Seams used

- `host.composer.registerMode` / `registerAddMenuItem` / `setMode` /
  `activeMode` — the generic composer-mode seam documented in
  [docs/dev/ui.md](../../docs/dev/ui.md) ("Composer modes").
- A `session.composer.before` slot contribution (order 1000, closest to the
  composer) renders the card for its session.
- `host.ui.components` (`IconButton`, `Button`, `MarkdownDoc`), `host.ui.icons`,
  `host.conversation.insert` and the `[data-composer-input]` hook to return
  focus after closing.

Strings are owned here (`src/strings.ts`, English and Ukrainian; other locales
fall back to English); the host's chip strings are `composer.mode.*`.

## Known limits

- A runtime without a direct completion answers through a one-shot agent
  session. The prompt forbids tools, but that leg is an agent turn, not a
  tool-less completion.
- Polyth Link (paired devices) cannot use btw; phones on the web shell can.
- History older than the newest 6,000 events is not seen.

Focused verification:

```sh
node scripts/run-tests.mjs packages/btw/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/btw
```
