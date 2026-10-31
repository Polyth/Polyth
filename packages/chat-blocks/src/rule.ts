// What models are told about ```ui fences. The always-on rule joins every
// harness's global behavior while the package is enabled, so it stays short;
// the full per-view reference is a skill the harness loads only when needed.
// Browser-safe.
import type { AgentCapabilityContribution } from "@polyth/contracts";

export const CHAT_BLOCKS_PACKAGE_ID = "chat-blocks";
export const CHAT_BLOCKS_SKILL_ID = "chat-blocks.skill";
export const CHAT_BLOCKS_SKILL_NAME = "polyth-chat-blocks";

export const CHAT_BLOCKS_RULE = [
  "## Rich results in chat",
  "",
  "When a result is a set of options, products, places, records, metrics or a plan, show it in a ```ui fence instead of a long list; keep explanations in prose. Clicks come back to you as a short message.",
  "First line: `<view> <title> · key=value`, on its own line after the opening fence (anything written after the language on the opening fence line counts as it too). Rows: `- field | field`. cards/list rows: `- image | title | subtitle | value | badge | link` (optional; image = URL or relative path, not absolute); table: first row = headers; stats: `- label | value | +delta | 3,5,4,8`; choice: `- label | detail`. Also chart, compare, form, steps, media. pick=one|many, `- [x]` preselects, `tone=success|warning|danger` colours a badge. Big data: write a JSON/JSONL/CSV project file and use `from=<path>` instead of rows. Buttons: `> Label` or `> Label = message, {sel} = selected`. Full syntax: the polyth-chat-blocks skill.",
  "```ui",
  "cards Laptops under $1000 · pick=many",
  "- https://example.com/a.jpg | Air 13 | M3, 16 GB | $999 | ★4.8 | https://example.com/a",
  "> Compare selected",
  "```",
  "A self-contained HTML mockup, diagram or interactive chart goes in a ```page fence (no network; ```ui suits lists, tables, charts); `window.polyth.send(text)` in it offers a reply.",
].join("\n");

/** The section appended to global behavior while the package is enabled. */
export function chatBlocksRuleSection(): string {
  return CHAT_BLOCKS_RULE;
}

export const CHAT_BLOCKS_REFERENCE = `Show results as interactive blocks: write a \`\`\`ui fence. Polyth renders it with its own components; the user sorts, filters and selects locally, and only a button click sends you one short message. Never put HTML, CSS or scripts in a \`\`\`ui fence; a self-contained page goes in a \`\`\`page fence (see PAGE).

FORMAT
First line: \`<view> <title> · key=value · key=value\` (options may also trail the title: \`cards Shops pick=one\`). Write it on its own line after the opening fence; if it ends up on the opening fence line (\`ui steps Plan\` after the backticks) the host still passes it as the first line.
\`- a | b | c\` one row; \`\\|\` is a literal bar; empty fields keep their position.
\`- [x] …\` preselected row. \`> Label\` button sends "Label: selected titles". \`> Label = text {sel}\` sends the text with {sel} replaced.
Any other line is a caption. A field \`tone=success|warning|danger|info|accent|neutral\` colours that row's badge. A field \`id=<key>\` (no spaces) gives a cards, list, choice or media row a stable id: clicks then name it "Title (#key)", so you need not match titles.
Limits: 200 rows, 12 fields, 6 buttons, 600 characters per field.

VIEWS
cards  \`- image | title | subtitle | value | badge | link\` — product/place cards. image and link are optional (http(s) URL or project image path). Options: pick=one|many, sort=value|-value|title, ratio=1:1|4:3|16:9.
list   same fields as cards, compact rows with a thumbnail. value is a short figure (price, size, rating) shown at the row's end; longer text there wraps under the title as a description.
table  first row = headers (or cols=a,b,c); a copied Markdown pipe table without \`- \` row markers also works. Local sort, filter, paging. sort=-Column. \`code\` in cells.
stats  \`- label | value | delta | 3,5,4,8\` KPI tiles; a delta starting with + or − sets the colour; the last field is a sparkline.
choice \`- label | detail\` — a question; Send posts "title — answer". pick=many for several answers.
chart  \`- label | n1 | n2\`; a first row of names (\`- Month | Online | Shop\`) or series=A,B names the series. type=bar|line|area|donut, unit=₴|%|ms.
compare first row \`- | Air 13 | XPS 13\` names the objects; \`- image | url | url\` adds pictures; \`- Battery ↑ | 18 h | 12 h\` rows, ↑ = higher wins, ↓ = lower wins. pick=one lets the user choose a column.
form   \`- name | Label * | type | default | extra\`; types text, textarea, number, select, toggle, date, email, url; * = required. extra: options for select (\`a, b\`), \`min..max\` for number and date (\`18..120\`, \`2026-01-01..\`), \`/regex/\` the whole value must match for text. Send stays disabled until the values are valid, then posts "title — Label: value; …".
steps  \`- done|doing|todo|fail|skip | title | detail\` — a read-only plan or progress list (not clickable; for options the user picks, use choice).
media  \`- image | caption | link\` — a gallery that opens a full-screen viewer.
An image is an http(s) URL or a path relative to your working checkout (\`.scratch/shots/a.png\`). Absolute paths (\`/home/…\`, \`/tmp/…\`) and \`..\` never render, and the file must still exist when the user opens the chat, so do not delete it after replying.

DATA FILES (saves tokens)
For more than a dozen rows, or data you already produced with a tool, write a file inside the project and reference it instead of writing rows:
\`table Vulnerabilities · from=_out/audit.json · cols=name:Package,severity,fixed:Fixed in · sort=-severity\`
\`cards Hotels · from=_out/hotels.jsonl · map=title:name,value:price,image:photo · pick=one\`
\`chart Daily visits · from=_out/visits.csv · type=line · cols=date,visits\`
Files: a JSON array (or an object holding one), JSON Lines, CSV or TSV, read up to 512 KB and 5000 rows. cols= picks and renames columns (key:Label); map= assigns roles (image, title, subtitle, value, badge, link, tone, id) when the keys differ from those names; an \`id\` key is used as the row id. Buttons still work on file rows.

PAGE
A \`\`\`page fence shows one self-contained HTML page inline (mockup, diagram, interactive chart, small tool): \`\`\`page Checkout mockup, then a full document or a body fragment. Title = the rest of the opening line, or a first line \`<!-- title: X -->\`. For a larger page write a project .html file and put \`from=_out/page.html\` after the title on the opening line (up to 512 KB; inline up to 256 KB).
It runs in a sandbox with scripts but NO network: no fetch, no external scripts, fonts, images or CDNs; inline everything (SVG, CSS, JS, data: URIs). It cannot navigate, open windows or submit forms. Colours follow the user's theme: use the CSS variables --polyth-bg, --polyth-fg, --polyth-muted, --polyth-accent, --polyth-border, --polyth-font, --polyth-radius; the body already has a themed background and font. Height follows the content (up to 1200px, then it scrolls), so do not size the page with 100vh. Links and redirects do not work: a page that navigates away is reloaded.
\`window.polyth.send("text")\` offers the user a reply (max 500 characters): the host shows it with a Send button and nothing is sent until the user clicks. Use it for "choose this variant" buttons.
Prefer a \`\`\`ui block for lists, tables and plain charts; use a page only when you need custom layout or interaction.

Lines the block cannot use (unknown options, malformed rows, too many rows) are listed under it with a hint, and the user may send that list back to you: then resend the whole block, corrected.

Keep prose for explanation and one block per decision; do not repeat the block's data in text.`;

export const chatBlocksSkill: AgentCapabilityContribution = {
  descriptor: {
    id: CHAT_BLOCKS_SKILL_ID,
    kind: "skill",
    owner: CHAT_BLOCKS_PACKAGE_ID,
    scope: "deployment",
    revision: "2",
    name: CHAT_BLOCKS_SKILL_NAME,
    title: "Polyth chat blocks",
    description: "Full ```ui fence syntax and the ```page HTML fence: cards, list, table, stats, choice, chart, compare, form, steps, media and from= data files.",
    instructions: CHAT_BLOCKS_REFERENCE,
  },
};
