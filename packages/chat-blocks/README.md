# Chat blocks (`@polyth/chat-blocks`)

Agents show options, products, places, records, metrics, plans and forms as
interactive, host-rendered blocks by writing a few lines in a ```` ```ui ````
fence inside an ordinary answer — or by pointing the block at a data file they
already wrote. No tool call, no new event type: the fence is plain
assistant text in canonical history, so every harness supports it and every
client that cannot render it still shows readable text.

- `src/parse.ts` — pure, browser-safe, streaming-tolerant parser (never throws),
  plus `withRecords`, which fills a block from file records with the same
  per-view row builders.
- `src/records.ts` — JSON / JSON Lines / CSV / TSV → records, with limits.
- `src/rule.ts` — what models are told. The always-on rule (about 1260 characters,
  roughly 300 tokens) joins every harness's global behavior while the
  package is enabled (`SERVER_BEHAVIOR_SECTIONS`). The full reference (about
  3k characters) is the `polyth-chat-blocks` skill
  (`harness.capabilities`), which harnesses load on demand; how a harness
  surfaces skills is its own (some inline them). `src/serverEntry.ts` registers
  both on enable and withdraws both on disable. No routes.
- `widgets/` — the fence renderer registered through
  `host.markdown.registerFence` (see `docs/dev/ui.md` §4.11): `ChatBlock.tsx`
  (frame, selection, sending), `collections.tsx` (cards, list, table, stats,
  choice), one file per other view, `useBlockRecords.ts` (`from=` loading) and
  scoped CSS under `.chat-block`.

## Format

```
<view> <title> · key=value · key=value
- field | field | field          one item per `- ` line; `\|` is a literal bar
- [x] field | …                  preselected item
> Button label                   sends "Button label[: selected titles]"
> Button label = message {sel}   sends the message; {sel} = selected titles
any other line                   caption text
```

Rows may use `-`, `*`, `•`, `+` or a numbered marker. A `table` is also
tolerant of a Markdown pipe table copied without row markers
(`| a | b |`, the first line as headers, an optional `|---|---|` rule
skipped), so the same content still renders when a model leaves the bullets
out. In every other view a line without a row marker stays a caption.

A `·` segment may contain spaces in its value (`cols=fixed:Fixed in`); options
written after the title without `·` are single words (`cards Shops pick=one`).
The first line goes on its own line after the opening fence. A model that
instead puts it on the opening line (writing `ui steps Plan` after the
backticks) is still understood: the host keeps the first token as the language
and passes the rest to the renderer as the first line of the block, so the
block parses the same way. The canonical two-line form is preferred because a
language without a renderer shows only the body in the host's code frame.

| View | Row fields | Notes |
| --- | --- | --- |
| `cards` | `image \| title \| subtitle \| value \| badge \| link` | grid; a narrow block becomes a swipeable rail; `ratio=1:1` / `16:9` sets the media shape |
| `list` | same as cards | rows with a thumbnail and trailing value; cards and list can be switched in the header. A value of up to 18 characters sits at the row's end (dropping under the title in a block narrower than 440px); a longer one is running text and wraps under the title; titles wrap whole, never clip; the pick mark is the last cell of every row |
| `table` | first row = headers (or `cols=a,b,c`) | local sort (numeric columns detected), filter from 7 rows, 10 rows then 50 more per click; `` `code` `` and http(s) URLs in cells render as code and links; `sort=-Column`; also accepts a Markdown pipe table without `- ` row markers, skipping a Markdown separator rule. A table wider than the chat pans by mouse drag, keeps native touch scrolling, and scrolls with arrow keys while focused; a drag never fires a header sort click |
| `stats` | `label \| value \| delta \| 3,5,4,8` | delta sign/arrow sets up/down colour; last field is a sparkline |
| `choice` | `label \| detail` | single answer by default, `pick=many` for several; Send posts "title — answer" |
| `chart` | `label \| n1 \| n2 …` | `type=bar` (horizontal bars, default), `line`, `area`, `donut`; a first row of names or `series=A,B` names the series (numeric names need `series=`); `unit=` suffix; line/area axis ends on a round number; pointer and arrow keys move a crosshair with a tooltip; a donut folds slices beyond 7 into "Other" |
| `compare` | first row `- \| A \| B` names the objects; `- image \| url \| url`; `- Feature ↑ \| … ` | ↑ higher wins, ↓ lower wins (ties win nothing); `pick=one` selects a column for the buttons |
| `form` | `name \| Label * \| type \| default \| extra` | types text, textarea, number, select, toggle, date, email, url; `*` = required. `extra` is the options of a select (`a, b` or `S/M/L`), a `min..max` range for number and date (`18..120`, `2026-01-01..`; either side may be empty) or a `/regex/` the whole text must match. Send stays disabled and names the fields that are missing ("Fill in: …") or invalid ("Check: …"); invalid inputs are marked `aria-invalid`. Send posts "title — Label: value; …" |
| `steps` | `done\|doing\|todo\|fail\|skip \| title \| detail` | read-only timeline, never selectable: filled markers (a number ahead, a glyph once settled) so nothing reads as a checkbox; "In progress" and "Failed" print, other states are screen-reader text; head shows done/total once a step has moved, else the step count; `` `code` `` and URLs in title/detail render as code and links. For options the user should pick, use `choice` |
| `media` | `image \| caption \| link` | gallery; a tile opens the shared full-screen viewer (arrows, swipe, thumbnails) |

Image and link are optional: a first field that is an http(s) URL or a
project-relative image path is the image (anything with another scheme is not);
a last field that is an http(s) URL is the link.
`tone=success|warning|danger|info|accent|neutral` anywhere in a row colours its
badge. `id=<key>` (up to 80 characters, no spaces or bars) anywhere in a cards,
list, choice or media row gives it a stable id: a click names the item as
`Title (#key)`, so the agent does not have to match titles. Options: `pick=one|many` (cards, list, choice, media, compare),
`sort=value|-value|title` (cards/list) or a column name (table), `send=draft`
(clicks fill the composer instead of sending).

Inline limits: 200 rows, 12 fields, 6 buttons, 600 characters per field.

## Data files (`from=`)

```
table Vulnerabilities · from=_out/audit.json · cols=name:Package,severity,fixed:Fixed in · sort=-severity
cards Hotels · from=_out/hotels.jsonl · map=title:name,value:price,image:photo · pick=one
chart Daily visits · from=_out/visits.csv · type=line · cols=date,visits
```

- The path must be project-relative (no scheme, leading `/`, `~`, `\`, `..` or
  empty segment) and end in `.json`, `.jsonl`/`.ndjson`, `.csv` or `.tsv`.
- The browser reads it through `/api/files/read` with the block's project and
  session, so the Files package's Space scoping and root confinement apply and
  an isolated session reads its own worktree. Project-relative images use
  `/api/files/raw` with the same session for the same reason.
- JSON: an array of objects, an array of arrays (first row = keys), a list of
  primitives, or an object whose first array value is any of those. JSON Lines
  skips malformed lines. CSV handles quotes, escaped quotes, embedded newlines
  and a BOM, and guesses `,`/`;`/tab.
- The server returns at most 512 KB: a cut JSON document is reported as too
  large; line formats keep their complete lines. At most 5000 records are used;
  the block says "Showing the first N of M rows" when anything was cut.
- `cols=key[:Label],…` picks and renames columns (table, chart, compare); for
  a chart the first column is the label and the rest are series. `map=role:key`
  assigns roles (image, title, subtitle, value, badge, link, tone, id) for
  cards, list, media, stats, steps and choice; without it common key names are
  recognised (`name`, `price`, `thumbnail`, `url`, `rating`, `id`, …). A boolean
  `selected` key preselects a row.
- Reads are cached per file and project/session (24 entries); failures are not
  cached. The header's Refresh re-reads the file. Missing project, missing
  file, too large, wrong format and empty files each show a specific notice.

## Interaction contract

- Sorting, filtering, paging, view switching, chart inspection, selection and
  form input cost no tokens and are never persisted as events.
- Only an explicit click on a button sends one short user message through
  `host.conversation.send` to the block's own session. Without a session, with
  `send=draft`, or when the send is refused, the text goes into the composer
  as an editable draft. While a send is in flight the buttons are disabled; a
  sent block hides its buttons, locks its inputs and shows what it sent.
  The buttons form one end-aligned group that wraps inside itself (the
  primary, last, stays at the trailing edge); in a block narrower than 480px
  each line of buttons fills the width.
- Images and links pass the Markdown URL policy (`sanitizeImageSrc`,
  `sanitizeLinkHref`); links open in a new tab with `noopener noreferrer`, and
  images load lazily without a referrer. A broken or missing image falls back
  to a monogram.
- While the fence streams, finished rows appear and the unfinished trailing
  line shows a placeholder; buttons appear and `from=` files load only once
  the fence is closed.
- A block that was already answered stays answered. The host passes the user
  message that followed the answer (`MarkdownFenceContext.reply`, read from
  canonical history). When that message is exactly one this block sends — a
  button's message for a selection of its own items or columns, or the form's
  message — the block shows "Sent to the agent" with the selection or form
  values the message names, after a reload too (`answeredBy` in
  `src/parse.ts`). Any other reply leaves the block open.
- An unknown view or a renderer failure shows the host's plain code block.
  Every block has "Show as text" and "Copy as Markdown".

## Problems

The parser never throws; everything it drops or ignores becomes a problem
(`doc.problems`, at most 20) with the line, the source text and a hint written
for the agent: `unknown-view`, `bad-row` (with the view's row signature),
`bad-button`, `bad-source`, `unknown-option` (lists the view's options),
`bad-option`, `bad-field`, `too-many-rows`, `too-many-buttons`,
`too-many-fields`. Once the fence is closed the block shows them folded under
one quiet line ("Problems in this block: N"); an unknown view shows the same
line under the host's code frame. In an agent's answer that has no reply yet,
"Ask the agent to fix" sends them as one message (`problemsMessage`), so the
agent resends the block; the button then reads "Asked the agent to fix".

## Conformance fixtures

`test/fixtures/<name>.ui` holds a fence body and `<name>.json` the parse it
must give (`test/conformance.test.ts`). Every fixture also streams: any
character prefix parses without throwing, a row never changes once the next
line has begun, and the stream converges on the closed parse. After a
deliberate format change, regenerate with `UPDATE_CHAT_BLOCK_FIXTURES=1` and
review the JSON diff. New syntax gets a fixture.
- Card, row and media hit areas are stretched, chromeless controls (a
  `<button>` when the block selects, an `<a>` when it links) and must stay
  transparent in `:hover`/`:active`. The host's generic button skin outranks a
  lone `.chat-block-hit` rule, so `widgets/styles.css` keeps a
  `.chat-block`-scoped state rule that overrides it; without it the hit paints
  an opaque background over the block's own text.

## HTML pages (```` ```page ````)

```` ```page Checkout mockup ```` followed by a full HTML document or a body
fragment shows a live, self-contained page inline. Title = the rest of the
opening line, else a first-line `<!-- title: X -->`, else "Page". The host
passes the opening line's extra tokens both as the renderer's `info` prop and
folded in as the first line of the text; `parsePageFence` prefers `info` when
the host supplies it (an older host without it still falls back to the
"first line that does not start with `<`" heuristic).
`from=<project-relative .html path>` loads the page through the same Files
API path as data files (same path rules, 512 KB cap); inline pages are capped at
256 KB and show a "too large" notice beyond it.

- `src/page.ts` — pure, browser-safe: fence parsing, `buildPageDocument`, the
  message protocol, download name. The document is `<!doctype html>`, charset,
  a Content-Security-Policy meta (no network, no frames, no forms, inline
  script/style and `data:`/`blob:` media only) and a no-referrer meta, then the
  host's theme style and bridge script, then the agent's content untouched
  (nothing is spliced into an agent `<head>`, so no agent byte precedes the
  policy).
- `widgets/PageBlock.tsx` mounts it as `<iframe sandbox="allow-scripts"
  srcdoc>` — never same-origin, navigation, popups, forms or modals. It waits
  for the closed fence ("Drawing page…" while streaming) and mounts the iframe
  when the block is within 400px of the viewport.
- Theme: `--polyth-bg/-fg/-muted/-accent/-border/-font/-radius` and
  `color-scheme` come from the host tokens (`--bg`, `--text`, `--muted`,
  `--accent`, `--border`, `--ui-font-family`, `--radius-card`), plus a minimal
  base the page can override. Changes to the root `class`/`data-theme`/`style`
  coalesce to one read per animation frame, and only an actual theme change is
  posted into the running page, which restyles without reloading.
- Messages use `{channel:"polyth-page-v1", kind}` and are accepted only when
  `event.source` is one of this block's frames. The bridge posts `ready` for
  every document it starts; a frame load not announced within 400ms is a
  foreign document (the page followed a link, a meta refresh or set
  `location`), so the frame is remounted on its own document with a notice,
  and after three such resets it is no longer mounted. This is a UX guard — the
  sandbox and the policy are the boundary; one navigation request can still
  leave the frame before it is reset. `height` is clamped to
  80–1200px (the page scrolls beyond). `send` comes from
  `window.polyth.send(text)` (trimmed string, up to 500 characters; bursts
  closer than 300ms are dropped, a newer one replaces the pending one). It never
  sends: the frame shows `Send: “…”` with Send and Dismiss, and only the click
  sends through `host.conversation.send` (a draft insert when there is no session
  or the send is refused).
- Only an agent's answer in the conversation runs at once
  (`MarkdownFenceContext.conversation`). The same fence anywhere else — a
  project Markdown file, an issue or pull request body, a user prompt — is
  someone else's code: the block shows Run page and mounts nothing until the
  click (View source and Download work before it).
- Frame tools: Full screen, Download .html, View source. Full screen uses the
  Fullscreen API on the block's own `<section>` when it is available
  (`document.fullscreenEnabled`), so the **same iframe keeps running** and the
  page keeps its state; the expand button toggles (Escape exits natively, and
  the button label follows the real fullscreen state). In full screen the
  iframe fills the viewport and the page's height messages are ignored. Where
  the API is missing (for example iPhone Safari) the host falls back to the
  previous host `Dialog`, which mounts a second iframe — that copy restarts the
  page.
- Turning off the Chat blocks package turns `page` off with `ui`: the fence
  registration is withdrawn and the host's plain code frame returns.

Copy is shipped in all shell locales (ar, bg, de, en, es, fr, it, pl, pt-BR, pt, uk, zh-CN); other locales fall back to English.
