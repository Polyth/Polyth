// Pure Markdown parser (WP4): DOM-free block+inline AST shared by chat and
// file preview. Tolerates streaming/incomplete input (unterminated fences,
// dangling emphasis) by degrading to literal text — it never throws.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "math"; tex: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "para"; inline: Inline[] }
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "hr" }
  | { kind: "mathBlock"; tex: string };

// ------------------------------------------------------------------- inline

const INLINE_RE = /(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\))|(`[^`]+`)|(\$\$[^$]+\$\$)|((?<![\\$\w])\$(?!\s)[^$\n]*?[^\s$\\]\$(?!\w))|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(~~[^~]+~~)|(https?:\/\/[^\s<>")\]]+)/g;

/** Parse inline Markdown. Escaped \$ stays literal; unmatched markers stay text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (t) out.push({ kind: "text", text: t.replace(/\\\$/g, "$") });
  };
  let m: RegExpExecArray | null;
  // Fresh regex per call: recursion into child spans must not clobber the
  // in-flight lastIndex of the outer scan.
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const s = m[0];
    if (m[1]) {
      // image: ![alt](src "title")
      const im = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(s);
      if (im) out.push({ kind: "image", alt: im[1] ?? "", src: im[2] ?? "" });
      else pushText(s);
    } else if (m[2]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(s);
      if (lm) out.push({ kind: "link", href: lm[2] ?? "", children: parseInline(lm[1] ?? "") });
      else pushText(s);
    } else if (m[3]) {
      out.push({ kind: "code", text: s.slice(1, -1) });
    } else if (m[4]) {
      out.push({ kind: "math", tex: s.slice(2, -2) });
    } else if (m[5]) {
      out.push({ kind: "math", tex: s.slice(1, -1) });
    } else if (m[6]) {
      out.push({ kind: "strong", children: [{ kind: "em", children: parseInline(s.slice(3, -3)) }] });
    } else if (m[7]) {
      out.push({ kind: "strong", children: parseInline(s.slice(2, -2)) });
    } else if (m[8]) {
      out.push({ kind: "em", children: parseInline(s.slice(1, -1)) });
    } else if (m[9]) {
      out.push({ kind: "strike", children: parseInline(s.slice(2, -2)) });
    } else if (m[10]) {
      out.push({ kind: "link", href: s, children: [{ kind: "text", text: s }] });
    }
  }
  pushText(text.slice(last));
  return out;
}

// -------------------------------------------------------------------- blocks

const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_RE = /^\s*[-*+]\s+(.+)$/;
const OL_RE = /^\s*\d+[.)]\s+(.+)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const FENCE_RE = /^(```+|~~~+)\s*(\S*)\s*$/;

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "para", inline: parseInline(para.join("\n")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote) {
      out.push({ kind: "quote", blocks: parseMarkdown(quote.join("\n")) });
      quote = null;
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const marker = fence[1]![0]!;
      const lang = fence[2] ?? "";
      const buf: string[] = [];
      let closed = false;
      for (i += 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (new RegExp(`^${marker === "~" ? "~~~+" : "\`\`\`+"}\\s*$`).test(l)) { closed = true; break; }
        buf.push(l);
      }
      out.push({ kind: "code", lang, text: buf.join("\n"), closed });
      continue;
    }
    // display math block: $$ ... $$ on their own lines
    if (/^\s*\$\$\s*$/.test(line)) {
      flushAll();
      const buf: string[] = [];
      for (i += 1; i < lines.length; i++) {
        if (/^\s*\$\$\s*$/.test(lines[i]!)) break;
        buf.push(lines[i]!);
      }
      out.push({ kind: "mathBlock", tex: buf.join("\n") });
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flushPara(); flushList();
      quote = quote ?? [];
      quote.push(line.replace(/^\s*>\s?/, ""));
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
    // table: header row followed by separator row
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      flushAll();
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      for (; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== ""; i++) {
        rows.push(splitRow(lines[i]!).map(parseInline));
      }
      i -= 1;
      out.push({ kind: "table", header, rows });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara(); flushQuote();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((ul?.[1] ?? ol?.[1])!);
      continue;
    }
    if (line.trim() === "") { flushAll(); continue; }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return out;
}

/** All image destinations in one document, deduped in order (gallery source). */
export function collectImages(blocks: Block[]): Array<{ src: string; alt: string }> {
  const seen = new Set<string>();
  const out: Array<{ src: string; alt: string }> = [];
  const walkInline = (inl: Inline[]) => {
    for (const n of inl) {
      if (n.kind === "image") {
        if (!seen.has(n.src)) { seen.add(n.src); out.push({ src: n.src, alt: n.alt }); }
      } else if ("children" in n) walkInline(n.children);
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.kind === "para" || b.kind === "heading") walkInline(b.inline);
      else if (b.kind === "list") b.items.forEach(walkInline);
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "table") { b.header.forEach(walkInline); b.rows.forEach((r) => r.forEach(walkInline)); }
    }
  };
  walk(blocks);
  return out;
}
