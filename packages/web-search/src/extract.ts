// Readable-page extraction for `web_fetch`: a small tolerant HTML tree builder
// plus a Markdown renderer. It keeps the main content (article/main when the
// page marks one), drops chrome (scripts, navigation, cookie banners, forms)
// and resolves links against the final page URL so an agent can follow them.
// Deliberately dependency-free; it is a reader, not a conforming HTML parser.

import { decodeHtmlEntities } from "./results.ts";

interface ElementNode {
  tag: string;
  attrs: string;
  children: Node[];
}
type Node = ElementNode | string;

export interface ExtractedPage {
  title: string | null;
  description: string | null;
  markdown: string;
  /** Little readable text but script-driven markup: a browser would render more. */
  likelyNeedsJavaScript: boolean;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp"]);
const DROP = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "embed", "head",
  "form", "input", "select", "option", "button", "textarea", "label", "dialog", "audio", "video", "picture", "map",
]);
/** Always chrome, wherever they sit. */
const CHROME = new Set(["nav", "aside"]);
const CHROME_ROLES = new Set(["navigation", "complementary", "contentinfo", "search", "dialog", "alertdialog", "menu", "menubar"]);
const NOISE_CLASS = /(?:^|[\s_-])(cookie|consent|gdpr|newsletter|advert|advertisement|adsbygoogle|share-buttons|social-share|skip-link|visually-hidden|sr-only)(?:$|[\s_-])/i;
const BLOCK = new Set([
  "address", "article", "body", "center", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "header", "hgroup", "html", "main", "section", "summary", "p",
]);
/** Opening one of these implicitly closes an open element of the same group. */
const AUTO_CLOSE: Readonly<Record<string, ReadonlySet<string>>> = {
  p: new Set(["p"]),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr", "td", "th"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  option: new Set(["option"]),
};
const BLOCK_CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "pre", "section", "table", "ul",
]);
/** Parsing work is bounded; larger documents are cut before tree building. */
const MAX_HTML_CHARS = 3_000_000;
const MAX_DEPTH = 256;
/** Structural indentation survives whitespace collapsing until the very end. */
const INDENT = "\u0001";

export function attribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  if (!match) return null;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

const hasAttribute = (attrs: string, name: string): boolean =>
  new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(attrs);

// Character classes of the tokenizer. `isSpace` is exactly JavaScript's `\s`, which
// the attribute regexes above also use.
const isSpace = (code: number): boolean =>
  code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680
  || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
  || code === 0x205f || code === 0x3000 || code === 0xfeff;
const isAsciiLetter = (code: number): boolean => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
const isWordChar = (code: number): boolean =>
  isAsciiLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f;
const isTagNameChar = (code: number): boolean => isWordChar(code) || code === 0x3a || code === 0x2d;
/** Anything but whitespace, quotes, `>`, `/` and `=`. */
const isAttributeNameChar = (code: number): boolean =>
  !isSpace(code) && code !== 0x22 && code !== 0x27 && code !== 0x3e && code !== 0x2f && code !== 0x3d;

/** `source` holds lower-case ASCII `name` at `at`, ignoring ASCII case only. */
const asciiCaseEquals = (source: string, at: number, name: string): boolean => {
  for (let index = 0; index < name.length; index += 1) {
    const code = source.charCodeAt(at + index);
    if ((code >= 0x41 && code <= 0x5a ? code | 0x20 : code) !== name.charCodeAt(index)) return false;
  }
  return true;
};

// Opening-tag scanner states: `<name` is followed by `( attr( = value)?)* /? >`.
const AFTER_VALUE = 0; // after the tag name or a quoted value: whitespace, "/" or ">"
const SPACE = 1; // whitespace that may start another attribute
const NAME = 2; // inside an attribute name
const NAME_SPACE = 3; // whitespace after an attribute name, where "=" may still follow
const EQUALS = 4; // after "=", before the value
const UNQUOTED = 5; // inside an unquoted value; "/" belongs to the value
const SLASH = 6; // "/" that must close the tag

const LIST_SCOPE: ReadonlySet<string> = new Set(["ul", "ol"]);
const TABLE_SCOPE: ReadonlySet<string> = new Set(["table"]);
const DL_SCOPE: ReadonlySet<string> = new Set(["dl"]);
const P_GROUP: ReadonlySet<string> = new Set(["p"]);

/**
 * Builds the element tree in one linear pass. Markup that does not form a complete tag
 * is text, as `<` followed by the rest. A failed tag is looked at only once: the opening
 * tag scanner is deterministic, so a (position, state) pair a failed scan went through
 * fails again for any later `<` that reaches it (`<div <div <div …` without a `>`).
 */
export function parseHtml(html: string): ElementNode {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const length = source.length;
  const root: ElementNode = { tag: "#root", attrs: "", children: [] };
  const stack: ElementNode[] = [root];
  const current = () => stack[stack.length - 1]!;
  const closeTo = (index: number) => { stack.length = Math.max(1, index); };
  const findOpen = (matches: (tag: string) => boolean, stopAt?: ReadonlySet<string>): number => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const tag = stack[index]!.tag;
      if (matches(tag)) return index;
      if (stopAt?.has(tag)) return -1;
    }
    return -1;
  };

  // The next ">" at or after `from`; callers ask with growing `from`, so one search serves many.
  let gtFrom = 0;
  let gtAt = -2;
  const nextGt = (from: number): number => {
    if (gtAt === -1 && from >= gtFrom) return -1;
    if (gtAt < from || from < gtFrom) gtAt = source.indexOf(">", from);
    gtFrom = from;
    return gtAt;
  };

  // One bit per scanner state for every position a failed opening-tag scan went through.
  let doomed: Uint8Array | null = null;
  let attrsEnd = 0;
  let selfClose = false;
  /** End of the opening tag whose attributes start at `from`, or -1. */
  const scanAttributes = (from: number, mark: boolean): number => {
    let state = AFTER_VALUE;
    attrsEnd = from;
    for (let pos = from; ; pos += 1) {
      if (doomed) {
        const bit = 1 << state;
        if (doomed[pos]! & bit) return -1;
        if (mark) doomed[pos] = doomed[pos]! | bit;
      }
      if (pos >= length) return -1;
      const code = source.charCodeAt(pos);
      switch (state) {
        case EQUALS:
          if (isSpace(code)) break;
          if (code === 0x3e) return -1;
          if (code === 0x22 || code === 0x27) {
            const close = source.indexOf(code === 0x22 ? "\"" : "'", pos + 1);
            if (close === -1) return -1;
            pos = close;
            attrsEnd = close + 1;
            state = AFTER_VALUE;
            break;
          }
          attrsEnd = pos + 1;
          state = UNQUOTED;
          break;
        case UNQUOTED:
          if (code === 0x3e) { selfClose = false; return pos + 1; }
          if (isSpace(code)) state = SPACE;
          else attrsEnd = pos + 1;
          break;
        case SLASH:
          if (code === 0x3e) { selfClose = true; return pos + 1; }
          return -1;
        default: {
          if (code === 0x3e) { selfClose = false; return pos + 1; }
          if (code === 0x2f) { state = SLASH; break; }
          const afterName = state === NAME || state === NAME_SPACE;
          if (isSpace(code)) { state = afterName ? NAME_SPACE : SPACE; break; }
          if (code === 0x3d && afterName) { state = EQUALS; break; }
          if (state !== AFTER_VALUE && isAttributeNameChar(code)) { attrsEnd = pos + 1; state = NAME; break; }
          return -1;
        }
      }
    }
  };

  const openElement = (tag: string, attrs: string, end: number): number => {
    const group = AUTO_CLOSE[tag];
    if (group) {
      const boundary = tag === "li" ? LIST_SCOPE : tag === "tr" || tag === "td" || tag === "th" ? TABLE_SCOPE : tag === "dt" || tag === "dd" ? DL_SCOPE : undefined;
      const index = findOpen((open) => group.has(open), boundary);
      if (index > 0) closeTo(index);
    }
    if (BLOCK_CLOSES_P.has(tag)) {
      const index = findOpen((open) => P_GROUP.has(open));
      if (index > 0) closeTo(index);
    }
    const node: ElementNode = { tag, attrs, children: [] };
    current().children.push(node);
    if (VOID.has(tag) || selfClose) return end;
    if (RAW_TEXT.has(tag)) {
      // Raw text runs to the first `</tag` (any case, then a non-word character) that a ">" follows.
      let rawEnd = length;
      let resume = length;
      for (let at = source.indexOf("</", end); at !== -1; at = source.indexOf("</", at + 2)) {
        const after = at + 2 + tag.length;
        if (after > length || !asciiCaseEquals(source, at + 2, tag)) continue;
        if (after < length && isWordChar(source.charCodeAt(after))) continue;
        const close = nextGt(after);
        if (close !== -1) { rawEnd = at; resume = close + 1; }
        break;
      }
      node.children.push(source.slice(end, rawEnd));
      return resume;
    }
    if (stack.length < MAX_DEPTH) stack.push(node);
    return end;
  };

  /** End of the markup at `start` (a "<") after handling it, or -1 when it is text. */
  const markup = (start: number): number => {
    const next = source.charCodeAt(start + 1);
    if (next === 0x21) { // "!"
      if (source.startsWith("<!--", start)) {
        const end = source.indexOf("-->", start + 4);
        return end === -1 ? length : end + 3;
      }
      if (source.startsWith("<![CDATA[", start)) {
        const end = source.indexOf("]]>", start + 9);
        return end === -1 ? length : end + 3;
      }
      const end = nextGt(start + 2);
      return end === -1 ? -1 : end + 1;
    }
    if (next === 0x3f) { // "?"
      const end = nextGt(start + 2);
      return end === -1 ? -1 : end + 1;
    }
    if (next === 0x2f) { // "/"
      if (!isAsciiLetter(source.charCodeAt(start + 2))) return -1;
      let pos = start + 3;
      while (pos < length && isTagNameChar(source.charCodeAt(pos))) pos += 1;
      const nameEnd = pos;
      while (pos < length && isSpace(source.charCodeAt(pos))) pos += 1;
      if (source.charCodeAt(pos) !== 0x3e) return -1;
      const tag = source.slice(start + 2, nameEnd).toLowerCase();
      const index = findOpen((open) => open === tag, tag === "li" ? LIST_SCOPE : tag === "td" || tag === "th" || tag === "tr" ? TABLE_SCOPE : undefined);
      if (index > 0) closeTo(index);
      return pos + 1;
    }
    if (!isAsciiLetter(next)) return -1;
    let nameEnd = start + 2;
    while (nameEnd < length && isTagNameChar(source.charCodeAt(nameEnd))) nameEnd += 1;
    const end = scanAttributes(nameEnd, false);
    if (end === -1) {
      doomed ??= new Uint8Array(length + 1);
      scanAttributes(nameEnd, true);
      return -1;
    }
    return openElement(source.slice(start + 1, nameEnd).toLowerCase(), source.slice(nameEnd, attrsEnd), end);
  };

  let pos = 0;
  while (pos < length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      current().children.push(source.slice(pos));
      break;
    }
    if (lt > pos) current().children.push(source.slice(pos, lt));
    const end = markup(lt);
    if (end === -1) {
      current().children.push("<");
      pos = lt + 1;
    } else {
      pos = end;
    }
  }
  return root;
}

const elements = (node: ElementNode): ElementNode[] => node.children.filter((child): child is ElementNode => typeof child !== "string");

function find(node: ElementNode, predicate: (element: ElementNode) => boolean, out: ElementNode[] = []): ElementNode[] {
  for (const child of elements(node)) {
    if (predicate(child)) out.push(child);
    find(child, predicate, out);
  }
  return out;
}

function contains(node: ElementNode, predicate: (element: ElementNode) => boolean): boolean {
  for (const child of elements(node)) {
    if (predicate(child) || contains(child, predicate)) return true;
  }
  return false;
}

function textOf(node: Node): string {
  if (typeof node === "string") return node;
  if (DROP.has(node.tag)) return "";
  return node.children.map(textOf).join(" ");
}

const plain = (value: string): string => decodeHtmlEntities(value).replace(/\s+/g, " ").trim();

function isHidden(node: ElementNode, keepChrome: boolean): boolean {
  if (DROP.has(node.tag) || CHROME.has(node.tag)) return true;
  if (!keepChrome && node.tag === "footer") return true;
  const attrs = node.attrs;
  if (!attrs) return false;
  if (hasAttribute(attrs, "hidden") || attribute(attrs, "aria-hidden") === "true") return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribute(attrs, "style") ?? "")) return true;
  const role = attribute(attrs, "role")?.toLowerCase();
  if (role && CHROME_ROLES.has(role)) return true;
  if (!keepChrome && role === "banner") return true;
  const label = `${attribute(attrs, "class") ?? ""} ${attribute(attrs, "id") ?? ""}`;
  return NOISE_CLASS.test(label);
}

function resolveUrl(raw: string | null, base: URL): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.startsWith("#")) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface RenderContext {
  base: URL;
  /** Root is the whole body: page-level header/nav/footer are chrome. */
  keepChrome: boolean;
  listDepth: number;
  pre: string[];
}

const block = (value: string): string => {
  const trimmed = value.trim();
  return trimmed ? `\n\n${trimmed}\n\n` : "";
};

const indentLines = (value: string, prefix: string): string =>
  value.split("\n").map((line, index) => (index === 0 || !line.trim() ? line : `${prefix}${line}`)).join("\n");

function renderChildren(node: ElementNode, context: RenderContext): string {
  return node.children.map((child) => render(child, context)).join("");
}

function preText(node: Node): string {
  if (typeof node === "string") return decodeHtmlEntities(node);
  if (node.tag === "br") return "\n";
  if (DROP.has(node.tag)) return "";
  return node.children.map(preText).join("");
}

function renderTable(node: ElementNode, context: RenderContext): string {
  if (contains(node, (element) => element.tag === "table")) return block(renderChildren(node, context));
  const rows = find(node, (element) => element.tag === "tr").map((row) =>
    elements(row)
      .filter((cell) => cell.tag === "td" || cell.tag === "th")
      .map((cell) => render(cell, { ...context, listDepth: 0 }).replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim()));
  const width = Math.max(0, ...rows.map((row) => row.length));
  const filled = rows.filter((row) => row.some(Boolean));
  if (width === 0 || filled.length === 0) return "";
  if (width === 1) return block(filled.map((row) => row[0]).join("\n\n"));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  const [head, ...body] = filled;
  return block([line(head!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n"));
}

function render(node: Node, context: RenderContext): string {
  if (typeof node === "string") return decodeHtmlEntities(node.replace(/[\s\u0000\u0001]+/g, " ")).replace(/[\u0000\u0001]/g, " ");
  if (isHidden(node, context.keepChrome)) return "";
  const tag = node.tag;
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const text = renderChildren(node, context).replace(/\s+/g, " ").trim();
      return text ? block(`${"#".repeat(Number(tag[1]))} ${text}`) : "";
    }
    case "a": {
      // Alternate-language versions are a site switcher, not content.
      if (hasAttribute(node.attrs, "hreflang")) return "";
      const text = renderChildren(node, context).replace(/\s+/g, " ").trim();
      const rawHref = attribute(node.attrs, "href")?.trim() ?? "";
      // Heading permalinks ("#", "¶", "§") only repeat the heading.
      if (rawHref.startsWith("#") && /^[#¶§🔗]?$/u.test(text)) return "";
      const href = resolveUrl(rawHref, context.base);
      if (!text) return "";
      return href ? `[${text}](${href})` : text;
    }
    case "img": {
      const alt = plain(attribute(node.attrs, "alt") ?? "");
      const src = resolveUrl(attribute(node.attrs, "src"), context.base);
      return alt && src && !src.startsWith("mailto:") ? `![${alt}](${src})` : "";
    }
    case "strong": case "b": {
      const text = renderChildren(node, context).trim();
      return text ? ` **${text}** ` : "";
    }
    case "em": case "i": {
      const text = renderChildren(node, context).trim();
      return text ? ` *${text}* ` : "";
    }
    case "code": {
      const text = preText(node).replace(/\s+/g, " ").trim();
      return text ? ` \`${text}\` ` : "";
    }
    case "pre": {
      const code = elements(node).find((child) => child.tag === "code");
      const className = `${attribute(node.attrs, "class") ?? ""} ${code ? attribute(code.attrs, "class") ?? "" : ""}`;
      const language = className.match(/(?:lang(?:uage)?-)([\w+#.-]+)/i)?.[1] ?? "";
      const text = preText(node).replace(/^\n+|\s+$/g, "");
      if (!text) return "";
      const fence = text.includes("```") ? "~~~~" : "```";
      context.pre.push(`${fence}${language}\n${text}\n${fence}`);
      return `\n\n\u0000${context.pre.length - 1}\u0000\n\n`;
    }
    case "blockquote": {
      const inner = renderChildren(node, context).trim();
      return inner ? block(inner.split("\n").map((line) => `> ${line}`).join("\n")) : "";
    }
    case "ul": case "ol": {
      const ordered = tag === "ol";
      let index = Number.parseInt(attribute(node.attrs, "start") ?? "1", 10);
      if (!Number.isFinite(index)) index = 1;
      const items = elements(node).filter((child) => child.tag === "li" && !isHidden(child, context.keepChrome));
      const nested = { ...context, listDepth: context.listDepth + 1 };
      const lines = items.map((item) => {
        const marker = ordered ? `${index++}. ` : "- ";
        const inner = renderChildren(item, nested).replace(/\n{3,}/g, "\n\n").trim();
        return inner ? `${marker}${indentLines(inner, INDENT.repeat(marker.length))}` : "";
      }).filter(Boolean);
      if (!lines.length) return "";
      const list = lines.join("\n");
      return context.listDepth > 0 ? `\n${list}\n` : block(list);
    }
    case "li":
      return block(`- ${renderChildren(node, context).trim()}`);
    case "table":
      return renderTable(node, context);
    case "dt": {
      const text = renderChildren(node, context).replace(/\s+/g, " ").trim();
      return text ? block(`**${text}**`) : "";
    }
    case "td": case "th":
      return ` ${renderChildren(node, context)} `;
    default:
      if (BLOCK.has(tag) || tag === "tr" || tag === "tbody" || tag === "thead" || tag === "caption") {
        return block(renderChildren(node, context));
      }
      return renderChildren(node, context);
  }
}

function finish(markdown: string, pre: readonly string[]): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").replace(/^ +| +$/g, "").replace(/ +([,.;:!?)])/g, "$1"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0001/g, " ")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => pre[Number(index)] ?? "")
    .trim();
}

function chooseRoot(body: ElementNode): { root: ElementNode; keepChrome: boolean } {
  const length = (node: ElementNode) => plain(textOf(node)).length;
  const bodyLength = length(body);
  const articles = find(body, (node) => node.tag === "article").map((node) => ({ node, size: length(node) }));
  articles.sort((left, right) => right.size - left.size);
  const mains = find(body, (node) => node.tag === "main" || attribute(node.attrs, "role")?.toLowerCase() === "main")
    .map((node) => ({ node, size: length(node) }));
  mains.sort((left, right) => right.size - left.size);
  // One dominant article is the reading content; many small ones (a feed) are not.
  const article = articles[0];
  if (article && article.size >= 400 && article.size >= bodyLength * 0.25 && (articles.length === 1 || article.size >= 2 * (articles[1]?.size ?? 0))) {
    return { root: article.node, keepChrome: true };
  }
  const main = mains[0];
  if (main && main.size >= 200) return { root: main.node, keepChrome: true };
  return { root: body, keepChrome: false };
}

export function extractReadablePage(html: string, pageUrl: string): ExtractedPage {
  const tree = parseHtml(html);
  const base = (() => {
    const declared = attribute(find(tree, (node) => node.tag === "base")[0]?.attrs ?? "", "href");
    try {
      return new URL(declared ?? pageUrl, pageUrl);
    } catch {
      return new URL(pageUrl);
    }
  })();
  const metas = find(tree, (node) => node.tag === "meta");
  const meta = (name: string): string | null => {
    for (const node of metas) {
      const key = (attribute(node.attrs, "name") ?? attribute(node.attrs, "property") ?? "").toLowerCase();
      if (key === name) {
        const content = plain(attribute(node.attrs, "content") ?? "");
        if (content) return content.slice(0, 1_000);
      }
    }
    return null;
  };
  const titleNode = find(tree, (node) => node.tag === "title")[0];
  const title = (titleNode ? plain(textOf(titleNode)) : "") || meta("og:title") || null;
  const description = meta("description") ?? meta("og:description");

  const body = find(tree, (node) => node.tag === "body")[0] ?? tree;
  const { root, keepChrome } = chooseRoot(body);
  const context: RenderContext = { base, keepChrome, listDepth: 0, pre: [] };
  const markdown = finish(render(root === body ? { ...root, tag: "div" } : root, context), context.pre);

  const scripts = find(tree, (node) => node.tag === "script").length;
  const noscript = find(tree, (node) => node.tag === "noscript").map((node) => textOf(node)).join(" ");
  const likelyNeedsJavaScript = markdown.length < 300
    && (scripts >= 3 || /enable javascript|requires javascript|javascript (?:is )?(?:disabled|required)/i.test(noscript)
      || find(body, (node) => /^(?:root|app|__next|__nuxt)$/i.test(attribute(node.attrs, "id") ?? "")).length > 0);
  return { title: title ? title.slice(0, 500) : null, description, markdown, likelyNeedsJavaScript };
}
