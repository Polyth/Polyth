# Chat, composer, and message rendering

## Current Polyth baseline

`Composer.tsx` is a controlled `<textarea>` with per-session drafts, Enter-to-send, Shift+Enter newline, `/` commands, `#` snippets, model/agent pickers, file drop, and typed leading/trailing slots. `Timeline.tsx` renders chronological reasoning, Markdown-lite text, grouped tool cards, errors, retry, and usage footers. `markdown.tsx` supports basic emphasis, lists, headings, fenced code, and copy. Preserve these working paths while decomposing the composer; do not replace session sending or event replay.

## Proposed component tree

```text
SessionView
├─ PromptNavigatorRail
├─ Timeline
│  ├─ MessageTurn
│  │  ├─ MergedThinking
│  │  ├─ RichMarkdown
│  │  │  ├─ FileReference
│  │  │  ├─ MermaidViewer
│  │  │  ├─ MarkdownImageGallery
│  │  │  └─ JsonTreeViewer
│  │  └─ MessageActions
│  └─ WorkStatusPanel (slot: session.timeline.after)
└─ ComposerShell
   ├─ ComposerTrackerPills
   ├─ ComposerEditor
   ├─ ComposerAutocomplete
   ├─ QueuedMessageList
   └─ ComposerToolbar slots
```

## 1. IME-safe text input boundary

**Sources:** polyth #2691, #2685, #107; Paseo #3517, #3462, #3343.

**Acceptance criteria**

- Pinyin, kana, and Hangul composition is never interrupted by a React rerender, draft persistence, autocomplete, dictation insertion, or external composer replacement.
- Enter during composition commits the candidate and does not send. Shift+Enter inserts a newline after composition, including synthetic mobile-browser key events.
- Native paste and image paste remain observable without replaying stale controlled text.
- Programmatic replacement (history recall, clear-after-send, file insertion, dictation) uses an explicit command API and wins only when no composition is active.

**Source design and Polyth port**

polyth guarded CodeMirror's controlled writeback with `view.compositionStarted`; Paseo generalized the rule into a single uncontrolled editing primitive whose public props omit `value` and `defaultValue`. Implement `components/input/AdaptiveTextInput.tsx` with internal live text, `compositionstart/end`, committed `onTextChange`, and an imperative handle:

```ts
export interface TextInputHandle {
  replaceText(text: string, selection?: { anchor: number; head?: number }): void;
  insertText(text: string): void;
  focus(): void;
}
```

`ComposerEditor.tsx` owns the live editor. `useDraft()` observes committed edits; it does not drive every keystroke back into the DOM. Defer queued imperative commands during composition and apply them on `compositionend` only if their generation is newer than the committed edit. Keep the textarea first; CodeMirror can follow once the boundary tests are green.

No server API or event is needed. Persist only committed text to `polyth.draft.<sessionId>`. Add `.composer-editor.is-composing` only for test/debug styling; it must not animate.

**Edge tests:** consecutive compositions, stale parent rerender, session switch mid-composition, autocomplete open, paste during composition, dictation insert, clear-after-send, synthetic Enter missing modifier state. Browser manual testing must use at least one CJK IME.

## 2. Rich composer language, focus mode, drafts, and width

**Sources:** polyth #2419, #480, #1318, #1401, #963.

**Acceptance criteria**

- `/command`, `#snippet`, and `@path` tokens highlight and autocomplete at any caret position, not only when the whole input is one token.
- Focus mode opens the same draft in a large dialog; close returns selection and scroll position to the inline editor.
- Draft remains per session and survives reload; successful send clears only the captured target session draft.
- Wide chat aligns composer and transcript width.

**Design**

Create a pure parser at `apps/web/src/composer/language.ts` returning ranges:

```ts
type PromptToken =
  | { kind: "command"; from: number; to: number; value: string }
  | { kind: "snippet"; from: number; to: number; value: string }
  | { kind: "file"; from: number; to: number; path: string };
```

Autocomplete queries existing `/api/commands`, `/api/snippets`, and `/api/files/search?projectId&q&limit`. Completion replaces only the active token. Server expansion remains authoritative; `user/message` continues storing expanded `text` plus `raw`.

Add `ComposerFocusDialog.tsx`, `.composer-focus-dialog`, `.composer-token-*`, and settings:

```ts
editorFontSize: number;          // 11..24, default 14
chatWidth: "normal" | "wide";    // existing
composerFocusShortcut: string;   // default Mod+Shift+Enter
```

Keep `polyth.settings` as the browser preference record. Do not migrate `polyth.draft.<sessionId>`.

**Tests:** token parsing around punctuation and fenced code, file paths with spaces, stale search responses, same draft edited in focus/inline modes, send while project switches.

## 3. Active-turn delivery: send, steer, or queue

**Sources:** polyth #1781, #1254, #1978, #2642; Paseo #3394.

**Acceptance criteria**

- When idle, Send starts a normal turn.
- When working, the configured behavior is `steer`, `queue`, or `interrupt`; the toolbar makes the actual action visible.
- `steer` falls back to queue if the runtime rejects live steering. Queued messages never auto-dispatch into a still-streaming turn and dispatch FIFO once idle.
- Project/session switches cannot reroute a captured send.

**API and data**

Extend `UserTurnInput` and the existing endpoint:

```http
POST /api/sessions/:id/message
{"text":"...","delivery":"normal|steer|queue|interrupt","model":{...},"agent":"..."}
→ {"turnId":"..."} | {"queueId":"...","queued":true}
```

`packages/session` owns admission and queue persistence. `packages/backend-opencode` alone translates `steer` to the backend runtime. Add `AgentRuntime.steer()` behind a `steering` capability; no web code calls the SDK. Append `queue/enqueued`, `delivery/steered`, `delivery/fallback-queued`, and `queue/dispatched` before corresponding text appears in the timeline. A queued message is model-visible only when dispatched; its queue event may be `ignorable: true`.

Persist `followUpBehavior: "steer"|"queue"|"interrupt"` in `polyth.settings`. Add `.composer-delivery`, `.queued-message`, and a delivery menu.

**Tests:** idle race, turn stops between click and admission, unsupported steering fallback, restart with queued items, abort then dispatch, duplicate WebSocket replay, captured session ID.

## 4. Queue chips and drag reorder

**Source:** polyth #1831.

`GET /api/sessions/:id/queue` returns ordered `{id,text,createdAt,delivery}` entries. Add `PATCH /api/sessions/:id/queue/order {"ids":[...]}` and `DELETE /api/sessions/:id/queue/:queueId`. Validate that the submitted IDs are an exact permutation for that session; update positions transactionally and append `queue/reordered`.

Render `QueuedMessageList.tsx` above the toolbar with keyboard-accessible move up/down actions in addition to pointer drag. Prefer native pointer/keyboard DnD before adding a dependency. Classes: `.queue-list`, `.queue-chip`, `.queue-handle`, `.queue-position-live`. Announce order changes through an `aria-live="polite"` region.

Test exact-permutation rejection, concurrent dispatch during reorder, restart ordering, keyboard reorder, and removal of the active drag item.

## 5. Send-time permission and question arbitration

**Sources:** polyth #1740, #2445, #2663.

Before accepting a new message, the server resolves open requests belonging to that exact session: reject unanswered questions and deny unresolved permissions, then admits or queues the message. Expose one atomic endpoint rather than client-side races:

```http
POST /api/sessions/:id/message
{"text":"...","dismissPending":true,...}
```

The transaction appends `question/answered` with `{requestId,rejected:true}` and `permission/resolved` with `{requestId,reply:"reject"}` before `user/message`/`queue/enqueued`. Optimistic UI may hide cards after the request starts, but replay is authoritative. A confirmation is unnecessary because sending is itself the user's intent.

Test request IDs from another session, reply arriving concurrently, send failure after dismissal, queue behavior, and replay ordering.

## 6. Work-status panel, live tasks, subagents, and tracker pills

**Sources:** polyth #2776; Paseo #3227, #3482, #2891.

**Acceptance criteria**

- A compact in-chat panel summarizes context usage, cumulative cost, goal/todos, current task, delegated agents, changed files, and MCP status.
- Above the composer, only active task/subagent trackers appear as floating pills. Selecting one opens its panel section without moving the transcript.
- Sections are hideable/collapsible; the panel always retains a Restore sections affordance.

Normalize provider data in `packages/backend-opencode`, then append:

```ts
type TaskSnapshotData = {
  listId: string;
  items: Array<{ id: string; text: string; status: "pending"|"active"|"done"|"failed" }>;
};
type SubagentSnapshotData = {
  agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }>;
};
```

Use `task/snapshot`, `task/updated`, `subagent/snapshot`, and `subagent/updated`. Full snapshots make replay deterministic; incremental events must carry a source revision. Add `workStatus.sections` and `session.timeline.after` slots. Existing context totals and Git status are read through current services, not duplicated.

Settings under `polyth.settings`: `workStatusPanelEnabled`, `workStatusHiddenSections: string[]`, `workStatusExpandedSections: string[]`. CSS: `.work-status`, `.work-status-section`, `.tracker-pills`, `.tracker-pill`.

Test out-of-order revisions, delegated agent completion, hidden-all recovery, missing Git/MCP capabilities, session switch, and event-log replay.

## 7. Assistant Markdown image galleries

**Sources:** polyth #2863 and #2894.

Collect image destinations during one assistant-message render. Render one gallery after the Markdown body; suppress duplicate standalone images. Thumbnails preserve aspect ratio, lazy-load, show alt text on failure, and open a focus-trapped full-screen preview with next/previous controls.

Add `/api/files/raw?projectId&path` only if absent; validate resolved paths stay under the project/worktree, reject directories, and return a strict MIME allowlist with `Content-Disposition: inline`. Remote `https:` images may load directly; reject `file:`, `javascript:`, and untrusted `data:` URLs.

Components/classes: `MarkdownImageGallery.tsx`, `ImagePreviewDialog.tsx`, `.md-gallery`, `.md-gallery-thumb`, `.image-preview`. No session event is added because the source Markdown is already logged.

Test duplicate URLs, mixed valid/invalid images, query strings, relative paths, traversal, keyboard navigation, and gallery rerender while streaming.

## 8. Mermaid pan/zoom, source, and fullscreen

**Sources:** polyth #2100, #490, #438; Paseo #2306.

Detect fenced `mermaid` blocks. Lazy-load Mermaid only when a block intersects the viewport; render with strict security settings and no HTML labels or external links. `MermaidViewer.tsx` provides zoom in/out/reset, wheel+modifier zoom, drag pan, Source/Diagram toggle, and a fullscreen dialog. Preserve source and show a copyable error on parse failure.

Add the latest Mermaid package when implementing. Do not render server-side and do not persist generated SVG. Classes: `.mermaid-viewer`, `.mermaid-toolbar`, `.mermaid-stage`, `.mermaid-fullscreen`. No new API/event.

Test malicious link directives, duplicate diagram IDs, streaming incomplete fences, large diagrams, reduced motion, fullscreen focus return, and Markdown file preview reuse.

## 9. Merged collapsible thinking

**Source:** polyth #1273.

Polyth already shows a per-message `<details>` reasoning block. Change turn projection so consecutive reasoning parts before one assistant answer merge in source sequence. While streaming, the block defaults open and says `Thinking…`; finalized blocks obey `collapsibleThinkingBlocks` and remember only the preference, not per-message open state.

Use source event sequences as React keys and never reorder reasoning around tool calls. Add `collapsibleThinkingBlocks: boolean` and `thinkingDefaultExpanded: boolean` to `polyth.settings`; classes `.thinking-merged`, `.thinking-preview`.

Test reasoning/tool interleaving, reconnect replacement chunks, empty reasoning, finalized replay, and disabled-collapse mode.

## 10. Clickable file references and line ranges

**Sources:** polyth #587, #2000, #1560; Paseo #2309.

Create `fileReferenceParser.ts` with a conservative grammar for `path`, `path:line`, `path:line:column`, and `path:start-end`. Linkify plain Markdown text and path tokens inside fenced code without touching URLs, stack traces that fail path validation, or language syntax.

Extend editor state:

```ts
interface EditorLocation { path: string; startLine?: number; endLine?: number; column?: number }
openEditorFile(location: EditorLocation | null): void
```

Before opening, resolve through `GET /api/files/stat?projectId&path`; enforce root containment and a text-size limit. The editor selects and centers the range. Existing `@path` composer attachment stays unchanged.

Test Windows-like separators as text, punctuation, spaces, `:line` ambiguity, deleted files, binary/large files, code fences, and range clamping.

## 11. LaTeX rendering

**Source:** polyth #929.

Support `$inline$` and `$$display$$` math in assistant/user Markdown and Markdown file preview. Add the latest KaTeX dependency; parse math before emphasis, disable trust/HTML commands, and preserve source with an error tooltip if parsing fails. Lazy-load CSS once.

Classes: `.math-inline`, `.math-display`, `.math-error`. No APIs/events. Test escaped dollars, currency, multiline display, dangerous commands, streaming delimiters, and copy-as-Markdown.

## 12. Interactive JSON tree

**Source:** polyth #786.

Use `JsonTreeViewer.tsx` for `.json` files and tool output that parses as JSON. Nodes show type-aware values, copy path/value, collapse/expand, and keyboard tree navigation. Default-collapse arrays/objects beyond a configurable depth; virtualize only after profiling large payloads. Keep Raw/Tree toggle and never parse over 5 MiB on the main thread.

Settings: `jsonTreeDefault: "tree"|"raw"` and `jsonTreeDepth: number`. Classes: `.json-tree`, `.json-node`, `.json-key`, `.json-value-*`. No event/API change.

Test primitives, deep/cyclic-impossible JSON, duplicate keys in source (raw remains available), huge arrays, invalid JSON, control characters, and accessibility roles.

## 13. Copy/export/share actions

**Sources:** polyth #553, #1305, #1444.

Add a `session.message.actions` slot and built-in message menu: Copy text, Copy Markdown, Copy structured JSON, and Save as image. JSON is a stable public shape `{sessionId,messageId,role,text,reasoning?,time}` and excludes internal tokens/secrets. Image export renders only the selected message in a purpose-built offscreen card, redacts hidden reasoning by default, waits for fonts/images, and reports cross-origin failures.

Add the latest maintained DOM-to-image dependency only for the export module and lazy-load it. Classes: `.message-actions`, `.share-card`. No server persistence. Test long code, remote image CORS failure, dark/light tokens, hidden reasoning, and clipboard denial.

## 14. Prompt navigator

**Sources:** polyth #2054, #2185, #2211; Paseo #2792.

On wide layouts, show a right-edge rail of real user turns. Filter synthetic continuation/audit messages using event metadata, not text heuristics. The current tick follows scroll position; hover/focus opens a bounded prompt list preview; selecting centers the message. Include Load earlier when history is paged.

Use `user/message` event IDs as anchors. Keep fetched history in timeline state during the session. Settings: `promptNavigator: "auto"|"on"|"off"`. Classes: `.prompt-nav`, `.prompt-nav-tape`, `.prompt-nav-tick`, `.prompt-nav-preview`. Hide below 900 px and under reduced-motion use no sliding animation.

Test long sessions, virtualized/unmounted targets, synthetic messages, keyboard use, load earlier, streaming at bottom, and resize.

## Dependency order

1. IME-safe input boundary.
2. Delivery/queue contracts and send-time request arbitration.
3. Task/subagent event projection and work-status panel.
4. Rich composer parser and focus mode.
5. Shared rich Markdown AST/rendering.
6. Image, Mermaid, math, JSON, and file-reference renderers.
7. Message actions and prompt navigator.

## Global implementation contract

- Node 22 erasable TypeScript only; no enums, namespaces, or parameter properties; local imports include `.ts`.
- Cross-package imports use workspace package names.
- Only `packages/backend-opencode` communicates with OpenCode.
- Append all model-visible data to the session log before rendering it.
- Extend `/api` and `/ws`; do not add a parallel transport.
- Use typed slots (`composer.*`, timeline/message/work-status slots) rather than mega-component imports.
- Tests use `node --test` and plain `node:assert`.
