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

export function parseHtml(html: string): ElementNode {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const root: ElementNode = { tag: "#root", attrs: "", children: [] };
  const stack: ElementNode[] = [root];
  const current = () => stack[stack.length - 1]!;
  const closeTo = (index: number) => { stack.length = Math.max(1, index); };
  const findOpen = (names: ReadonlySet<string>, stopAt?: ReadonlySet<string>): number => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const tag = stack[index]!.tag;
      if (names.has(tag)) return index;
      if (stopAt?.has(tag)) return -1;
    }
    return -1;
  };
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    const [text, closing, opening, attrs = "", selfClose] = match;
    if (closing) {
      const tag = closing.toLowerCase();
      const index = findOpen(new Set([tag]), tag === "li" ? new Set(["ul", "ol"]) : tag === "td" || tag === "th" || tag === "tr" ? new Set(["table"]) : undefined);
      if (index > 0) closeTo(index);
      continue;
    }
    if (opening) {
      const tag = opening.toLowerCase();
      const group = AUTO_CLOSE[tag];
      if (group) {
        const boundary = tag === "li" ? new Set(["ul", "ol"]) : tag === "tr" || tag === "td" || tag === "th" ? new Set(["table"]) : tag === "dt" || tag === "dd" ? new Set(["dl"]) : undefined;
        const index = findOpen(group, boundary);
        if (index > 0) closeTo(index);
      }
      if (BLOCK_CLOSES_P.has(tag)) {
        const index = findOpen(new Set(["p"]));
        if (index > 0) closeTo(index);
      }
      const node: ElementNode = { tag, attrs, children: [] };
      current().children.push(node);
      if (VOID.has(tag) || selfClose) continue;
      if (RAW_TEXT.has(tag)) {
        const end = new RegExp(`</${tag}\\b[^>]*>`, "gi");
        end.lastIndex = token.lastIndex;
        const found = end.exec(source);
        node.children.push(source.slice(token.lastIndex, found ? found.index : source.length));
        token.lastIndex = found ? end.lastIndex : source.length;
        continue;
      }
      if (stack.length < MAX_DEPTH) stack.push(node);
      continue;
    }
    if (text.startsWith("<!") || text.startsWith("<?")) continue;
    current().children.push(text);
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
  if (find(node, (element) => element.tag === "table").length > 0) return block(renderChildren(node, context));
  const rows = find(node, (element) => element.tag === "tr").map((row) =>
    elements(row)
      .filter((cell) => cell.tag === "td" || cell.tag === "th")
      .map((cell) => render(cell, { ...context, listDepth: 0 }).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()));
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
