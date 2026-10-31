// Pure Markdown parser: DOM-free block+inline AST shared by chat and
// file preview. Tolerates streaming/incomplete input (unterminated fences,
// dangling emphasis) by degrading to literal text — it never throws.
import { isVideoSource } from "./sanitize.ts";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "math"; tex: string }
  | { kind: "break" };

/** One list item: its leading paragraph inline, then any further blocks the
 *  item holds (continuation paragraphs, a nested list, a code fence). */
export interface ListItem { inline: Inline[]; blocks?: Block[]; checked?: boolean }

/** A table column's GFM alignment (`:--`, `:-:`, `--:`); null = default. */
export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "para"; inline: Inline[] }
  | { kind: "code"; lang: string; text: string; closed: boolean; info?: string }
  | { kind: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][]; align?: TableAlign[] }
  | { kind: "hr" }
  | { kind: "mathBlock"; tex: string };

// ------------------------------------------------------------------- inline

// One alternative per inline construct. `_` emphasis must not touch a word
// on either side, so snake_case identifiers stay text. A bare URL may contain
// `)`; an unbalanced closing one is trimmed with trailing punctuation.
const INLINE_RE = new RegExp([
  String.raw`(?<texParen>\\\([^\n]+?\\\))`,
  String.raw`(?<escape>\\[!-/:-@[-\x60{-~])`,
  String.raw`(?<image>!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))`,
  String.raw`(?<link>\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\))`,
  String.raw`(?<code>\x60[^\x60]+\x60)`,
  String.raw`(?<displayMath>\$\$[^$]+\$\$)`,
  String.raw`(?<inlineMath>(?<![\\$\w])\$(?!\s)[^$\n]*?[^\s$\\]\$(?!\w))`,
  String.raw`(?<strongEm>\*\*\*[^*]+\*\*\*)`,
  String.raw`(?<strong>\*\*[^*]+\*\*)`,
  String.raw`(?<em>\*[^*\s][^*]*\*)`,
  String.raw`(?<strongUnder>(?<![\p{L}\p{N}_])__(?!\s)[^_]+?(?<!\s)__(?![\p{L}\p{N}_]))`,
  String.raw`(?<emUnder>(?<![\p{L}\p{N}_])_[^\s_](?:[^_]*?[^\s_])?_(?![\p{L}\p{N}_]))`,
  String.raw`(?<strike>~~[^~]+~~)`,
  String.raw`(?<lineBreak><br\s*\/?>)`,
  String.raw`(?<angleLink><https?:\/\/[^\s<>]+>)`,
  String.raw`(?<url>https?:\/\/[^\s<>"\]]+)`,
].join("|"), "gu");

/** A bare URL never ends on sentence punctuation, and keeps a closing paren
 *  only when it closes one inside the URL (`…/Foo_(bar)` vs `(see …/x)`). */
function trimAutolink(url: string): string {
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (ch !== undefined && ".,:;!?'\"*_~".includes(ch)) { end -= 1; continue; }
    if (ch === ")") {
      const body = url.slice(0, end);
      const open = body.split("(").length - 1;
      const close = body.split(")").length - 1;
      if (close > open) { end -= 1; continue; }
    }
    return url.slice(0, end);
  }
}

/** Parse inline Markdown. A backslash escape (`\*`, `\$`, `\_`) is the literal
 *  character; unmatched markers stay text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  let m: RegExpExecArray | null;
  // Fresh regex per call: recursion into child spans must not clobber the
  // in-flight lastIndex of the outer scan.
  const re = new RegExp(INLINE_RE.source, "gu");
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const s = m[0];
    const g = m.groups ?? {};
    if (g.texParen) {
      out.push({ kind: "math", tex: s.slice(2, -2) });
    } else if (g.escape) {
      pushText(s.slice(1));
    } else if (g.image) {
      // image: ![alt](src "title")
      const im = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(s);
      if (im) out.push({ kind: "image", alt: im[1] ?? "", src: im[2] ?? "" });
      else pushText(s);
    } else if (g.link) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(s);
      if (lm) out.push({ kind: "link", href: lm[2] ?? "", children: parseInline(lm[1] ?? "") });
      else pushText(s);
    } else if (g.code) {
      out.push({ kind: "code", text: s.slice(1, -1) });
    } else if (g.displayMath) {
      out.push({ kind: "math", tex: s.slice(2, -2) });
    } else if (g.inlineMath) {
      out.push({ kind: "math", tex: s.slice(1, -1) });
    } else if (g.strongEm) {
      out.push({ kind: "strong", children: [{ kind: "em", children: parseInline(s.slice(3, -3)) }] });
    } else if (g.strong || g.strongUnder) {
      out.push({ kind: "strong", children: parseInline(s.slice(2, -2)) });
    } else if (g.em || g.emUnder) {
      out.push({ kind: "em", children: parseInline(s.slice(1, -1)) });
    } else if (g.strike) {
      out.push({ kind: "strike", children: parseInline(s.slice(2, -2)) });
    } else if (g.lineBreak) {
      out.push({ kind: "break" });
    } else if (g.angleLink) {
      const href = s.slice(1, -1);
      out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
    } else if (g.url) {
      const href = trimAutolink(s);
      out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
      // The trimmed punctuation is read again as text (and may open a span).
      last = m.index + href.length;
      re.lastIndex = last;
    }
  }
  pushText(text.slice(last));
  return out;
}

// -------------------------------------------------------------------- blocks

const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
// A list item marker: bullet or `1.`/`1)` number, then whitespace and content.
const LIST_ITEM_RE = /^([ \t]*)([-*+]|(\d{1,9})[.)])([ \t]+)(\S.*)$/;
// A delimiter row: dash cells with optional alignment colons. One pipe at
// least, so a lone `---` stays a rule and a one-column table still parses.
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableSep = (line: string): boolean => line.includes("|") && TABLE_SEP_RE.test(line);
// A fence opener carries an arbitrary info string (as CommonMark allows). The
// first whitespace-delimited token is the language; any remaining tokens are
// kept as `info` so a renderer can treat a `ui steps Title` opener as the view
// line. Backticks are excluded so a prose line that wraps inline code in
// ```...``` stays a paragraph. An indented opener (a fence inside a list
// item) is a fence too; its indentation is stripped from the code lines.
const FENCE_RE = /^([ \t]*)(```+|~~~+)[ \t]*([^`]*)$/;
/** Does `line` close a fence opened by `run` (same character, at least as
 *  long)? A shorter run is code, so a ```` fence can show a ``` example. */
const closesFence = (line: string, run: string): boolean => {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === run[0] && m[1]!.length >= run.length;
};
const MATH_FENCE_RE = /^\s*\$\$\s*$/;
// ChatGPT-style display math: `\[` and `\]` on their own lines.
const TEX_OPEN_RE = /^\s*\\\[\s*$/;
const TEX_CLOSE_RE = /^\s*\\\]\s*$/;
const splitFenceInfo = (raw: string): { lang: string; info: string } => {
  const trimmed = raw.trim();
  if (trimmed === "") return { lang: "", info: "" };
  const lang = trimmed.split(/\s+/, 1)[0]!;
  return { lang, info: trimmed.slice(lang.length).trim() };
};

/** Width of the leading whitespace; a tab advances to the next 4-column stop. */
const indentWidth = (line: string): number => {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
};
/** Remove up to `width` columns of leading whitespace. */
const stripIndent = (line: string, width: number): string => {
  let col = 0;
  let k = 0;
  while (k < line.length && col < width) {
    const ch = line[k];
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
    k += 1;
  }
  return line.slice(k);
};

/** Cells of one table row. `\|` is a literal pipe inside a cell. */
const splitRow = (line: string): string[] => {
  const cells: string[] = [];
  let cell = "";
  const row = line.trim();
  for (let k = 0; k < row.length; k++) {
    const ch = row[k]!;
    if (ch === "\\" && row[k + 1] === "|") { cell += "|"; k += 1; continue; }
    if (ch === "|") { cells.push(cell); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell);
  if (row.startsWith("|")) cells.shift();
  if (row.length > 1 && row.endsWith("|") && !row.endsWith("\\|")) cells.pop();
  return cells.map((c) => c.trim());
};
const columnAlign = (cell: string): TableAlign => {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
};

interface ListMarker { indent: number; ordered: boolean; start: number; contentIndent: number; content: string }
const listMarker = (line: string): ListMarker | null => {
  const m = LIST_ITEM_RE.exec(line);
  if (!m || HR_RE.test(line)) return null;
  const indent = indentWidth(m[1]!);
  const gap = indentWidth(`${m[1]}${m[2]}${m[4]}`) - indent - m[2]!.length;
  // Content starts after the marker and its spaces; a run of 5+ spaces means
  // the content itself is indented, so the item starts one column in.
  const contentIndent = indent + m[2]!.length + (gap > 4 ? 1 : gap);
  return { indent, ordered: m[3] !== undefined, start: m[3] === undefined ? 1 : Number(m[3]), contentIndent, content: m[5]! };
};

/** An item's own lines become a document of their own. The first paragraph
 *  is the item text; anything after it (a nested list, a fence, more
 *  paragraphs) stays as blocks. `[ ]`/`[x]` opens a GFM task item. */
function buildListItem(body: string[]): ListItem {
  const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? "");
  if (task) body[0] = body[0]!.slice(task[0].length);
  const blocks = parseMarkdown(body.join("\n"));
  const checked = task ? { checked: task[1]!.toLowerCase() === "x" } : {};
  const head = blocks[0];
  if (head?.kind === "para") {
    const rest = blocks.slice(1);
    return { inline: head.inline, ...(rest.length ? { blocks: rest } : {}), ...checked };
  }
  return { inline: [], ...(blocks.length ? { blocks } : {}), ...checked };
}

/**
 * One list from `from`: consecutive items of the same kind, blank lines
 * between them included. An item owns every following line indented past its
 * marker (continuation text, a nested list, a fence; a fence it opens runs to
 * its close whatever the indentation), so a step's code block no longer
 * restarts the numbering. A line back at the marker column ends the item.
 */
function parseList(lines: string[], from: number): { block: Block; next: number } {
  const first = listMarker(lines[from]!)!;
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const marker = listMarker(lines[i]!);
    if (!marker || marker.ordered !== first.ordered) break;
    const body = [marker.content];
    const child = marker.indent + 2;
    const opener = FENCE_RE.exec(marker.content);
    let fence: string | null = opener ? opener[2]! : null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (fence) {
        body.push(stripIndent(line, marker.contentIndent));
        if (closesFence(line, fence)) fence = null;
        continue;
      }
      if (line.trim() === "") {
        let k = j + 1;
        while (k < lines.length && lines[k]!.trim() === "") k++;
        if (k < lines.length && indentWidth(lines[k]!) >= child) {
          while (j < k) { body.push(""); j++; }
          j -= 1;
          continue;
        }
        break;
      }
      if (indentWidth(line) < child) break;
      const content = stripIndent(line, marker.contentIndent);
      body.push(content);
      const open = FENCE_RE.exec(content);
      if (open) fence = open[2]!;
    }
    items.push(buildListItem(body));
    let k = j;
    while (k < lines.length && lines[k]!.trim() === "") k++;
    const next = k < lines.length ? listMarker(lines[k]!) : null;
    if (next && next.ordered === first.ordered && next.indent < child) { i = k; continue; }
    i = j;
    break;
  }
  return {
    block: { kind: "list", ordered: first.ordered, ...(first.ordered && first.start !== 1 ? { start: first.start } : {}), items },
    next: i,
  };
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let quote: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "para", inline: parseInline(para.join("\n")) });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote) {
      out.push({ kind: "quote", blocks: parseMarkdown(quote.join("\n")) });
      quote = null;
    }
  };
  const flushAll = () => { flushPara(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const indent = indentWidth(fence[1]!);
      const run = fence[2]!;
      const { lang, info } = splitFenceInfo(fence[3] ?? "");
      const buf: string[] = [];
      let closed = false;
      for (i += 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (closesFence(l, run)) { closed = true; break; }
        buf.push(stripIndent(l, indent));
      }
      out.push({ kind: "code", lang, text: buf.join("\n"), closed, ...(info ? { info } : {}) });
      continue;
    }
    // display math block: $$ ... $$ (or \[ ... \]) on their own lines
    const tex = TEX_OPEN_RE.test(line);
    if (MATH_FENCE_RE.test(line) || tex) {
      flushAll();
      const close = tex ? TEX_CLOSE_RE : MATH_FENCE_RE;
      const buf: string[] = [];
      for (i += 1; i < lines.length; i++) {
        if (close.test(lines[i]!)) break;
        buf.push(lines[i]!);
      }
      out.push({ kind: "mathBlock", tex: buf.join("\n") });
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flushPara();
      quote = quote ?? [];
      quote.push(line.replace(/^\s*>[ \t]?/, ""));
      continue;
    }
    flushQuote();
    if (HR_RE.test(line)) { flushAll(); out.push({ kind: "hr" }); continue; }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushAll();
      out.push({ kind: "heading", level: h[1]!.length, inline: parseInline(h[2]!) });
      continue;
    }
    // table: header row followed by a delimiter row. The header fixes the
    // columns; a delimiter row with a different count still makes a table.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flushAll();
      const header = splitRow(line);
      const delimiters = splitRow(lines[i + 1]!);
      const align = header.map((_, c) => columnAlign(delimiters[c] ?? ""));
      const rows: Inline[][][] = [];
      i += 2;
      for (; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== ""; i++) {
        // A row keeps the header's columns: missing cells are empty, extra
        // ones are dropped (GFM), so the grid never goes ragged.
        const cells = splitRow(lines[i]!);
        rows.push(header.map((_, c) => parseInline(cells[c] ?? "")));
      }
      i -= 1;
      out.push({ kind: "table", header: header.map(parseInline), rows, ...(align.some(Boolean) ? { align } : {}) });
      continue;
    }
    // Any item starts a list, also right under a paragraph line: in chat a
    // "Then:\n3. …" continues a numbered list far more often than prose
    // wraps onto a line that happens to start with a number.
    if (listMarker(line)) {
      flushAll();
      const { block, next } = parseList(lines, i);
      out.push(block);
      i = next - 1;
      continue;
    }
    if (line.trim() === "") { flushAll(); continue; }
    para.push(line);
  }
  flushAll();
  return out;
}

// ------------------------------------------------------------ streaming tail

const PIPE_ROW_RE = /^\s*\|/;
/** A lone partial block marker that will become something else once its line
 * finishes: `#` (heading), one or two fence ticks/tildes, one `$` of `$$`. */
const PARTIAL_MARKER_RE = /^\s*(?:#{1,6}|`{1,2}|~{1,2}|\$)\s*$/;

/**
 * The prefix of a still-streaming document that is safe to render now.
 *
 * Markdown is not prefix-stable: `| a | b |` is a paragraph until a separator
 * row arrives on the next line and turns it into a table. Rendering every
 * prefix makes such blocks flash as prose and then snap into their real shape.
 * This withholds only a trailing fragment whose block type is still undecided:
 *
 * - pipe rows that may still become a table (no complete separator yet), and
 *   the unterminated last row of a table, whose cell count is not final;
 * - an unterminated last line that is only a partial block marker.
 *
 * Text inside an unterminated code fence or `$$` block is never withheld: it
 * cannot change type. Callers render the full text once the message is final.
 */
export function holdBackStreamingTail(text: string): string {
  const lines = text.split("\n");
  // The last element is the in-progress line; "" when text ends with "\n".
  const last = lines.length - 1;
  const lastOpen = lines[last] !== "";

  // Track fence / math state exactly as parseMarkdown does, so held lines are
  // always in block context, never code or math.
  const blockContext: boolean[] = [];
  let fence: string | null = null;
  let math: RegExp | null = null;
  for (let i = 0; i <= last; i++) {
    const line = lines[i]!;
    if (fence) {
      blockContext.push(false);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (math) {
      blockContext.push(false);
      if (math.test(line)) math = null;
      continue;
    }
    const opener = FENCE_RE.exec(line);
    if (opener) { fence = opener[2]!; blockContext.push(false); continue; }
    if (MATH_FENCE_RE.test(line)) { math = MATH_FENCE_RE; blockContext.push(false); continue; }
    if (TEX_OPEN_RE.test(line)) { math = TEX_CLOSE_RE; blockContext.push(false); continue; }
    blockContext.push(true);
  }

  const cut = (at: number): string => lines.slice(0, at).join("\n");

  if (lastOpen && blockContext[last] && PARTIAL_MARKER_RE.test(lines[last]!)) return cut(last);

  // Trailing run of pipe rows in block context (the open last line included).
  const end = lastOpen ? last : last - 1;
  let start = end + 1;
  while (start - 1 >= 0 && blockContext[start - 1] && PIPE_ROW_RE.test(lines[start - 1]!)) start -= 1;
  if (start > end) return text;
  // An open row at the end of an established table (its header may have been
  // written without a leading pipe) has an unfinished cell count.
  const holdOpenRow = (): string => (lastOpen ? cut(last) : text);
  for (let j = start - 1; j >= 1 && blockContext[j] && lines[j]!.includes("|"); j--) {
    if (isTableSep(lines[j]!) && lines[j - 1]!.includes("|")) return holdOpenRow();
  }

  for (let i = start; i <= end; i++) {
    const separatorLine = i + 1;
    if (separatorLine <= end && isTableSep(lines[separatorLine]!)) {
      // Header i + separator: a table. While the separator is the open line
      // it may still grow columns; after that only an open body row waits.
      if (separatorLine === last && lastOpen) return cut(i);
      return end > separatorLine ? holdOpenRow() : text;
    }
    // No separator directly below row i. If that line has not arrived or is
    // still being written, it may yet become one: hold from row i.
    if (separatorLine > end || (separatorLine === last && lastOpen)) return cut(i);
    // Otherwise row i is settled prose; the rows after it decide for themselves.
  }
  return text;
}

// -------------------------------------------------------------- frontmatter

/** One simple `key: value` property from leading YAML-ish frontmatter. */
export interface FrontmatterProperty {
  key: string;
  value: string;
}

const FRONTMATTER_MAX_LINES = 200;
const FRONTMATTER_MAX_PROPERTIES = 50;
const FRONTMATTER_MAX_VALUE = 500;
const FM_KEY_RE = /^([^\s:#][^:]*):\s?(.*)$/;
const FM_LIST_ITEM_RE = /^\s*-\s+(.*)$/;

const stripQuotes = (raw: string): string => {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
};

/** Inline `[a, b]` (or `a, b`) lists joined with ", "; scalars unquoted. */
const parseFrontmatterValue = (raw: string): string => {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const items = v.slice(1, -1).split(",").map((item) => stripQuotes(item)).filter((item) => item !== "");
    return items.join(", ");
  }
  return stripQuotes(v);
};

/** Total length of a frontmatter value, including the "…" mark; a value over
 *  the cap is cut short by one character for the mark so the result stays
 *  within FRONTMATTER_MAX_VALUE. */
const capValue = (value: string): string =>
  value.length > FRONTMATTER_MAX_VALUE ? `${value.slice(0, FRONTMATTER_MAX_VALUE - 1)}…` : value;

/**
 * Split leading YAML-ish frontmatter from a document body. Returns null unless
 * the very first line is exactly `---` and a `---`/`...` closing fence appears
 * within the first 200 lines. Simple `key: value` lines become properties;
 * inline lists and following indented `- item` lines join with ", "; a
 * nested/indented line becomes raw text in the previous property's value. A
 * block with any other top-level line (prose between two rules) is not
 * frontmatter: null, so no text is ever dropped. `#` comment lines are skipped;
 * an empty block is stripped with no properties. Pure and never throws; caps
 * 500 characters per value (a cut value ends in "…") and 50 properties, and
 * `dropped` reports how many further properties the cap left out.
 */
export function splitFrontmatter(text: string): { properties: FrontmatterProperty[]; body: string; dropped: number } | null {
  // CRLF and bare CR are normalized so a Windows document still matches.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if ((lines[0] ?? "") !== "---") return null;
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES + 1);
  let end = -1;
  for (let i = 1; i < limit; i++) {
    const line = lines[i]!;
    if (line === "---" || line === "...") { end = i; break; }
  }
  if (end === -1) return null;
  const properties: FrontmatterProperty[] = [];
  let dropped = 0;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const listItem = FM_LIST_ITEM_RE.exec(line);
    if (listItem) {
      const item = stripQuotes(listItem[1] ?? "");
      const prev = properties.at(-1);
      if (prev && item !== "") prev.value = capValue(prev.value ? `${prev.value}, ${item}` : item);
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const kv = FM_KEY_RE.exec(line);
    // An indented line under a key is raw text of a nested map: keep it in the
    // previous value rather than inventing a key.
    if (/^\s/.test(line)) {
      const prev = properties.at(-1);
      if (!prev) return null;
      prev.value = capValue(prev.value ? `${prev.value} ${line.trim()}` : line.trim());
      continue;
    }
    if (!kv) return null;
    const key = kv[1]!.trim();
    const rawValue = kv[2] ?? "";
    if (properties.length >= FRONTMATTER_MAX_PROPERTIES) { dropped += 1; continue; }
    properties.push({ key, value: capValue(parseFrontmatterValue(rawValue)) });
  }
  return { properties, body: lines.slice(end + 1).join("\n"), dropped };
}

/** All image destinations in one document, deduped in order (gallery source). */
export function collectImages(blocks: Block[]): Array<{ src: string; alt: string }> {
  const seen = new Set<string>();
  const out: Array<{ src: string; alt: string }> = [];
  const walkInline = (inl: Inline[]) => {
    for (const n of inl) {
      if (n.kind === "image") {
        // Videos render as players, not thumbnails, so they are not gallery
        // entries; the extension check is the shared source policy.
        if (!isVideoSource(n.src) && !seen.has(n.src)) { seen.add(n.src); out.push({ src: n.src, alt: n.alt }); }
      } else if ("children" in n) walkInline(n.children);
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.kind === "para" || b.kind === "heading") walkInline(b.inline);
      else if (b.kind === "list") b.items.forEach((item) => { walkInline(item.inline); if (item.blocks) walk(item.blocks); });
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "table") { b.header.forEach(walkInline); b.rows.forEach((r) => r.forEach(walkInline)); }
    }
  };
  walk(blocks);
  return out;
}
