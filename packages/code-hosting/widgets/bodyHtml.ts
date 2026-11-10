// GitHub and GitLab bodies are Markdown plus literal HTML: Dependabot's
// release notes are `<details>`/`<p>`/`<blockquote>`/`<ul>` blocks, templates
// add `<details>` sections, `<img>` badges and `<br>`. The shared Markdown
// renderer treats raw HTML as text, so such a body showed a wall of tags
// (`<details>`, `<summary>Release notes</summary>`, `<a href=…>`).
//
// This module turns the HTML subset the providers themselves render into the
// Markdown the shared renderer understands, and splits a body on `<details>`
// blocks so the view can keep them collapsible. It only ever produces text:
// no HTML string reaches the DOM, so nothing here can inject markup. Tags it
// does not know are dropped (as a browser would), code spans and fenced
// blocks are left verbatim, and link/image targets go through the same URL
// policy as Markdown links.

export type HostingBodySegment =
  | { kind: "markdown"; text: string }
  | { kind: "details"; summary: string; open: boolean; segments: HostingBodySegment[] };

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const DETAILS_RE = /<(\/?)details\b[^>]*>/gi;
const SUMMARY_RE = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "wbr", "meta", "link", "col", "area", "base", "embed", "track"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\u00b7",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", times: "\u00d7",
  rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!match) return null;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Same policy as Markdown links/images: http(s), mailto, `#anchor`,
 *  protocol-relative-free relative paths. Everything else is dropped. */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.startsWith("//")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!scheme) return url;
  const name = scheme[1]!.toLowerCase();
  return name === "http" || name === "https" || name === "mailto" ? url : null;
}

/** Text content of an HTML fragment: tags dropped, entities decoded,
 *  whitespace collapsed. Used for `<summary>` labels. */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

interface CodeMask {
  mask: (text: string) => string;
  restore: (text: string) => string;
}

/** Replace code (fenced blocks and inline spans) with placeholders so tag
 *  conversion cannot rewrite examples that live inside code. */
export function createCodeMask(): CodeMask {
  const saved: string[] = [];
  const keep = (text: string) => {
    const token = `\u0000${saved.length}\u0000`;
    saved.push(text);
    return token;
  };
  return {
    mask(text: string) {
      return text
        .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, body: string) => keep(`\n\n\`\`\`\n${htmlToPlainText(body.replace(/<[^>]*>/g, ""))}\n\`\`\`\n\n`))
        .replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)/g, (block) => keep(block))
        .replace(/(`+)[\s\S]*?\1/g, (span) => keep(span));
    },
    restore(text: string) {
      return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => saved[Number(index)] ?? "");
    },
  };
}

/** Convert the HTML a hosting provider renders (Dependabot notes, PR-template
 *  `<details>`/`<img>`/`<a>` markup) into Markdown. A string without any tag is
 *  returned untouched, so plain Markdown keeps its exact bytes. */
export function htmlToMarkdown(source: string): string {
  if (!source || !source.includes("<")) return source;
  const code = createCodeMask();
  const masked = code.mask(source).replace(/<!--[\s\S]*?-->/g, "");
  let out = "";
  let inHtml = 0;
  let converted = false;
  const links: Array<string | null> = [];

  const blockBreak = () => { out += "\n\n"; };
  const lineBreak = () => { out += "\n"; };
  /** Text inside an HTML block has insignificant whitespace; Markdown text
   *  between the blocks keeps its own bytes. */
  const emitText = (raw: string) => {
    if (!raw) return;
    const decoded = decodeHtmlEntities(raw);
    out += inHtml > 0 ? decoded.replace(/\s+/g, " ") : decoded;
  };

  const handleTag = (closing: boolean, name: string, attrs: string) => {
    if (!VOID_TAGS.has(name)) inHtml = Math.max(0, inHtml + (closing ? -1 : 1));
    switch (name) {
      case "br": lineBreak(); break;
      case "hr": blockBreak(); out += "---"; blockBreak(); break;
      case "img": {
        const src = safeUrl(attribute(attrs, "src") ?? "");
        if (src !== null) out += `![${htmlToPlainText(attribute(attrs, "alt") ?? "")}](${src})`;
        break;
      }
      case "a": {
        if (closing) {
          const href = links.pop() ?? null;
          if (href !== null) out += `](${href})`;
        } else {
          const href = safeUrl(attribute(attrs, "href") ?? "");
          links.push(href);
          if (href !== null) out += "[";
        }
        break;
      }
      case "strong": case "b": out += "**"; break;
      case "em": case "i": out += "*"; break;
      case "code": case "kbd": case "samp": case "tt": out += "`"; break;
      case "del": case "s": case "strike": out += "~~"; break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        if (closing) blockBreak();
        else { blockBreak(); out += `${"#".repeat(Number(name[1]))} `; }
        break;
      case "li": if (!closing) { lineBreak(); out += "- "; } break;
      case "td": case "th": out += " | "; break;
      case "p": case "div": case "section": case "article": case "main": case "aside":
      case "header": case "footer": case "nav": case "figure": case "figcaption":
      case "dl": case "dt": case "dd": case "ul": case "ol": case "table":
      case "thead": case "tbody": case "tfoot": case "tr":
      case "blockquote": case "details": case "summary": case "pre":
        blockBreak();
        break;
      default: break;
    }
  };

  const re = new RegExp(TAG_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked))) {
    const attrs = match[3] ?? "";
    // `<https://…>` and `<user@host>` only look like tags; keep them literal.
    if (attrs !== "" && !/^[\s/]/.test(attrs)) continue;
    emitText(masked.slice(last, match.index));
    last = match.index + match[0].length;
    converted = true;
    handleTag(match[1] === "/", (match[2] ?? "").toLowerCase(), attrs);
  }
  let tidied: string;
  if (!converted) {
    // No tags: HTML comments may still have been removed, everything else is
    // Markdown that must keep its bytes.
    tidied = masked;
  } else {
    emitText(masked.slice(last));
    tidied = out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }
  return code.restore(tidied);
}

/** Character ranges covered by fenced code blocks, so a `<details>` example
 *  inside a fence stays code instead of becoming a section. */
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!open && marker) open = { char: marker[0]!, length: marker.length, start: lineStart };
    else if (open && marker && marker[0] === open.char && marker.length >= open.length) {
      ranges.push([open.start, lineStart + line.length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

function inFence(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => position >= start && position < end);
}

/** The `</details>` that closes the block opened just before `from`. */
function detailsClose(text: string, from: number, fences: Array<[number, number]>): { start: number; end: number } | null {
  const re = new RegExp(DETAILS_RE.source, "gi");
  re.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (inFence(match.index, fences)) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/** Split a provider body into Markdown runs and `<details>` sections. An
 *  unterminated `<details>` (a streamed or truncated body) stays Markdown, so
 *  the view never loses text. */
export function parseHostingBody(text: string): HostingBodySegment[] {
  if (!text) return [];
  const fences = fencedRanges(text);
  const segments: HostingBodySegment[] = [];
  let markdown = "";
  const flush = () => {
    if (!markdown) return;
    const converted = htmlToMarkdown(markdown).replace(/\n+$/, "");
    if (converted.trim()) segments.push({ kind: "markdown", text: converted });
    markdown = "";
  };

  const open = new RegExp(DETAILS_RE.source, "gi");
  let pos = 0;
  let scanFrom = 0;
  while (scanFrom < text.length) {
    open.lastIndex = scanFrom;
    const match = open.exec(text);
    if (!match) break;
    scanFrom = match.index + match[0].length;
    if (match[1] === "/" || inFence(match.index, fences)) continue;
    const close = detailsClose(text, open.lastIndex, fences);
    if (!close) break;
    markdown += text.slice(pos, match.index);
    flush();
    const inner = text.slice(open.lastIndex, close.start);
    const summary = SUMMARY_RE.exec(inner);
    const body = summary ? inner.slice(summary[0].length) : inner;
    segments.push({
      kind: "details",
      summary: summary ? htmlToPlainText(summary[1] ?? "") : "",
      open: /\sopen(?=[\s/>]|$)/i.test(match[0]),
      segments: parseHostingBody(body),
    });
    pos = close.end;
    scanFrom = pos;
  }
  markdown += text.slice(pos);
  flush();
  return segments;
}
