// What a transcript selection holds, read while it is still alive: its words, the
// same passage as Markdown so its links survive, and which message it starts in.
// A package action gets this copy, because a tap can collapse the selection
// before the click lands.
export interface SelectionSnapshot {
  text: string;
  markdown: string;
  /** The message the selection starts in; null outside any message. */
  eventSeq: number | null;
  messageRole: "user" | "assistant" | null;
}

const HEADING = /^H([1-6])$/;
const SKIPPED = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT"]);

function inlineCode(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  return `${fence}${text}${fence}`;
}

function convert(node: Node, depth: number): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1 && node.nodeType !== 11) return "";
  const element = node.nodeType === 1 ? node as Element : null;
  const tag = element?.tagName.toUpperCase() ?? "";
  // Chrome inside a message (a code block's copy button), never its content.
  if (SKIPPED.has(tag) || element?.getAttribute("aria-hidden") === "true") return "";
  const inner = () => Array.from(node.childNodes).map((child) => convert(child, depth)).join("");
  switch (tag) {
    case "A": {
      const href = element!.getAttribute("href");
      const text = inner().trim();
      return href && /^https?:/i.test(href) ? `[${text || href}](${href})` : text;
    }
    case "STRONG":
    case "B": return `**${inner()}**`;
    case "EM":
    case "I": return `*${inner()}*`;
    case "CODE": return inlineCode(element!.textContent ?? "");
    case "PRE": {
      const code = (element!.querySelector("code") ?? element!).textContent ?? "";
      return `\n\`\`\`\n${code.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    }
    case "BR": return "\n";
    case "P": return `${inner().trim()}\n\n`;
    case "BLOCKQUOTE": return `${inner().trim().split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
    case "UL":
    case "OL": {
      const items = Array.from(element!.children).filter((child) => child.tagName.toUpperCase() === "LI");
      const start = Number(element!.getAttribute("start")) || 1;
      const lines = items.map((item, index) => {
        const marker = tag === "OL" ? `${start + index}. ` : "- ";
        const body = Array.from(item.childNodes).map((child) => convert(child, depth + 1)).join("").trim();
        return `${"  ".repeat(depth)}${marker}${body}`;
      });
      return `${lines.join("\n")}\n${depth === 0 ? "\n" : ""}`;
    }
    default: {
      const heading = HEADING.exec(tag);
      if (heading) return `${"#".repeat(Number(heading[1]))} ${inner().trim()}\n\n`;
      return inner();
    }
  }
}

export function fragmentToMarkdown(fragment: Node): string {
  return convert(fragment, 0).replace(/\n{3,}/g, "\n\n").trim();
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

export function snapshotSelection(range: Range, text: string): SelectionSnapshot {
  const message = elementOf(range.startContainer)?.closest<HTMLElement>("[data-message-seq]") ?? null;
  const seq = Number(message?.dataset.messageSeq);
  const role = message?.classList.contains("assistant") ? "assistant" : message?.classList.contains("user") ? "user" : null;
  return {
    text,
    markdown: fragmentToMarkdown(range.cloneContents()) || text,
    eventSeq: Number.isSafeInteger(seq) && seq > 0 ? seq : null,
    messageRole: role,
  };
}
