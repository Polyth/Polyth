// Pure share-page parsing: page text in, normalized messages out. No I/O.
//
// A ChatGPT share page streams its loader data through React Router's
// turbo-stream: `window.__reactRouterContext.streamController.enqueue("…")`
// calls whose string literals, joined, hold one flat JSON array. In it a plain
// object `{"_<k>": <v>}` maps the key `values[k]` to the value `values[v]`,
// arrays hold indices into the same array and negative numbers encode
// null/undefined/NaN/±Infinity. Shared values make the graph cyclic, so this
// reader looks up only the fields it needs and never resolves it deeply.
import { shareChatError } from "./errors.ts";

export type SharedChatRole = "user" | "assistant";

export interface SharedChatMessage {
  id: string;
  role: SharedChatRole;
  /** Unix milliseconds; null when the page gave no time for the message. */
  createdAt: number | null;
  text: string;
}

export interface SharedChat {
  /** Adapter id of the host the page came from. */
  host: string;
  title: string | null;
  /** Chronological, deduplicated user and assistant messages; never empty. */
  messages: SharedChatMessage[];
}

/** One supported share host. Add an adapter only after verifying its page
 *  format against a live share; a host is never assumed from its name. */
export interface ShareChatAdapter {
  id: string;
  /** Lower-case hostnames this adapter reads, including redirect targets. */
  hosts: readonly string[];
  /** Canonical share URL for a URL on one of `hosts`, or null for a non-share path. */
  canonicalUrl(url: URL): string | null;
  parse(page: string): SharedChat;
}

const ENQUEUE = "streamController.enqueue(";
const TITLE_LIMIT = 300;
/** Copies of one streamed answer land within a few seconds of each other. */
const PARTIAL_COPY_WINDOW_MS = 9_000;
/** Server-side placeholders that are not conversation content. */
const PLACEHOLDERS = new Set([
  "Original custom instructions no longer available",
  "The output of this plugin was redacted.",
]);
/** ChatGPT inline markers: `\ue200<kind>\ue202<arg>…\ue201`. */
const INLINE_MARKER = /([ \t]*)\ue200([A-Za-z_]+)((?:\ue202[^\ue200\ue201\ue202]*)*)\ue201/g;

const unsupported = (message: string): Error => shareChatError("unsupported-page", message);

/** Decodes one quoted JavaScript string literal (JSON-compatible in practice). */
function decodeJsString(literal: string): string {
  if (literal.startsWith("\"")) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      // Fall through: the literal uses a JavaScript-only escape.
    }
  }
  const body = literal.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|[\s\S])|"/g, (match, escape: string | undefined) => {
    if (escape === undefined) return "\\\"";
    if (escape[0] === "x") return `\\u00${escape.slice(1)}`;
    if (escape === "'") return "'";
    if (escape === "\n") return "";
    if (escape === "v") return "\\u000b";
    return match;
  });
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    throw unsupported("the shared chat data could not be decoded");
  }
}

/** String arguments of every `streamController.enqueue(...)` call, in page order.
 *  A linear scan, so multi-megabyte literals cannot exhaust a regex engine. */
export function extractStreamChunks(html: string): string[] {
  const chunks: string[] = [];
  let from = 0;
  for (;;) {
    const call = html.indexOf(ENQUEUE, from);
    if (call < 0) return chunks;
    let start = call + ENQUEUE.length;
    while (start < html.length && /\s/.test(html[start]!)) start += 1;
    const quote = html[start];
    if (quote !== "\"" && quote !== "'") {
      from = start;
      continue;
    }
    let end = start + 1;
    while (end < html.length && html[end] !== quote) end += html[end] === "\\" ? 2 : 1;
    if (end >= html.length) return chunks;
    chunks.push(decodeJsString(html.slice(start, end + 1)));
    from = end + 1;
  }
}

/** The flat turbo-stream value array. Deferred `P<id>:[…]` lines append to it,
 *  as the turbo-stream decoder does, so their indices stay valid. */
export function decodeTurboStream(payload: string): unknown[] {
  const lines = payload.split("\n");
  const head = lines.findIndex((line) => line.trim());
  if (head < 0) throw unsupported("the shared chat data is empty");
  let values: unknown;
  try {
    values = JSON.parse(lines[head]!);
  } catch {
    throw unsupported("the shared chat data could not be decoded");
  }
  if (!Array.isArray(values) || !values.length) throw unsupported("the shared chat data has an unknown shape");
  for (const line of lines.slice(head + 1)) {
    const deferred = /^P\d+:/.exec(line);
    if (!deferred) continue;
    let items: unknown;
    try {
      items = JSON.parse(line.slice(deferred[0].length));
    } catch {
      continue;
    }
    if (Array.isArray(items)) for (const item of items) values.push(item);
  }
  return values;
}

/** Index-addressed view of a turbo-stream array; dict lookups are memoized. */
class FlatGraph {
  readonly #values: unknown[];
  readonly #dicts = new Map<number, Map<string, number> | null>();

  constructor(values: unknown[]) {
    this.#values = values;
  }

  get size(): number {
    return this.#values.length;
  }

  value(index: number | undefined): unknown {
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= this.#values.length) return undefined;
    return this.#values[index];
  }

  string(index: number | undefined): string | undefined {
    const value = this.value(index);
    return typeof value === "string" ? value : undefined;
  }

  number(index: number | undefined): number | undefined {
    const value = this.value(index);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  /** Index list of a plain array. A string head marks a typed value (Date, Promise…). */
  list(index: number | undefined): number[] | undefined {
    const value = this.value(index);
    if (!Array.isArray(value) || typeof value[0] === "string") return undefined;
    return value.filter((item): item is number => typeof item === "number");
  }

  dict(index: number | undefined): Map<string, number> | undefined {
    if (index === undefined) return undefined;
    const cached = this.#dicts.get(index);
    if (cached !== undefined) return cached ?? undefined;
    const value = this.value(index);
    let dict: Map<string, number> | null = null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      dict = new Map();
      for (const [key, target] of Object.entries(value)) {
        const name = /^_(\d+)$/.exec(key) ? this.string(Number(key.slice(1))) : undefined;
        if (name === undefined || typeof target !== "number") {
          dict = null;
          break;
        }
        dict.set(name, target);
      }
    }
    this.#dicts.set(index, dict);
    return dict ?? undefined;
  }
}

/** Strips ChatGPT citation and navigation markers; an entity marker keeps its display name. */
export function cleanMessageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INLINE_MARKER, (_match, space: string, kind: string, args: string) => {
      if (kind !== "entity") return "";
      try {
        const value: unknown = JSON.parse(args.split("\ue202")[1] ?? "");
        if (Array.isArray(value) && typeof value[1] === "string") return `${space}${value[1]}`;
      } catch {
        // Unknown entity payload: drop the marker.
      }
      return "";
    })
    .replace(/[\ue200-\ue2ff]/g, "")
    .trim();
}

/** A message as read from the page; `order` is its position in page data. */
export interface RawMessage extends SharedChatMessage {
  order: number;
}

function readMessage(graph: FlatGraph, node: Map<string, number>, order: number): RawMessage | null {
  const role = graph.string(graph.dict(node.get("author"))?.get("role"));
  if (role !== "user" && role !== "assistant") return null;
  // `metadata.is_visually_hidden_from_conversation` also marks real final
  // answers, so it is not a filter; partial copies go in normalizeMessages.
  // Tool calls address a recipient other than "all"; reasoning uses the analysis channel.
  const recipient = graph.string(node.get("recipient"));
  if (recipient !== undefined && recipient !== "all") return null;
  if (graph.string(node.get("channel")) === "analysis") return null;
  const content = graph.dict(node.get("content"));
  const type = graph.string(content?.get("content_type"));
  if (type !== "text" && type !== "multimodal_text") return null;
  const parts: string[] = [];
  for (const part of graph.list(content?.get("parts")) ?? []) {
    const text = graph.string(part);
    if (text !== undefined) parts.push(text);
    else if (/image/.test(graph.string(graph.dict(part)?.get("content_type")) ?? "")) parts.push("[image]");
  }
  const text = cleanMessageText(parts.join("\n"));
  if (!text || PLACEHOLDERS.has(text)) return null;
  const seconds = graph.number(node.get("create_time"));
  return {
    id: graph.string(node.get("id")) ?? `#${order}`,
    role,
    createdAt: seconds !== undefined && seconds > 0 ? Math.round(seconds * 1_000) : null,
    text,
    order,
  };
}

/** Orders and deduplicates raw messages. Pages repeat each message (mapping and
 *  linear views) and may keep partial streaming copies of an answer. */
export function normalizeMessages(raw: readonly RawMessage[]): SharedChatMessage[] {
  const byId = new Map<string, RawMessage>();
  for (const message of raw) {
    const known = byId.get(message.id);
    if (!known) byId.set(message.id, message);
    else if (message.text.length > known.text.length) byId.set(message.id, { ...message, order: known.order });
  }
  // A message without a time sorts right after the one before it in page order.
  let previous = 0;
  const timed = [...byId.values()]
    .sort((left, right) => left.order - right.order)
    .map((message) => {
      if (message.createdAt !== null) previous = message.createdAt;
      return { message, at: message.createdAt ?? previous };
    })
    .sort((left, right) => left.at - right.at || left.message.order - right.message.order);

  const seen = new Set<string>();
  const unique = timed.filter(({ message, at }) => {
    const key = `${message.role}\n${Math.round(at / 1_000)}\n${message.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const kept = unique.filter(({ message, at }, index) => {
    if (message.createdAt === null) return true;
    for (const step of [-1, 1]) {
      for (let other = index + step; other >= 0 && other < unique.length; other += step) {
        const candidate = unique[other]!;
        if (Math.abs(candidate.at - at) > PARTIAL_COPY_WINDOW_MS) break;
        if (candidate.message.role === message.role
          && candidate.message.createdAt !== null
          && candidate.message.text.length > message.text.length
          && candidate.message.text.includes(message.text)) return false;
      }
    }
    return true;
  });
  return kept.map(({ message: { order: _order, ...message } }) => message);
}

function readTitle(graph: FlatGraph): string | null {
  for (let index = 0; index < graph.size; index += 1) {
    const dict = graph.dict(index);
    if (!dict?.has("title") || !(dict.has("linear_conversation") || dict.has("mapping"))) continue;
    const title = graph.string(dict.get("title"))?.replace(/\s+/g, " ").trim();
    if (title) return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
  }
  return null;
}

/** The reason a share page gives instead of a conversation (deleted, private…). */
function readServerError(graph: FlatGraph): string | null {
  for (let index = 0; index < graph.size; index += 1) {
    const response = graph.dict(graph.dict(index)?.get("serverResponse"));
    if (!response || graph.string(response.get("type")) !== "error") continue;
    const reason = (graph.string(response.get("error")) ?? graph.string(response.get("toastMessage")) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return reason || "unknown error";
  }
  return null;
}

/** Parses a ChatGPT share page, or its already-extracted turbo-stream payload. */
export function parseChatGptSharePage(page: string): SharedChat {
  const chunks = extractStreamChunks(page);
  let payload: string;
  if (chunks.length) payload = chunks.join("");
  else if (page.trimStart().startsWith("[")) payload = page;
  else throw unsupported("the page has no shared-conversation data; it may not be a ChatGPT share page, or its layout changed");

  const graph = new FlatGraph(decodeTurboStream(payload));
  const raw: RawMessage[] = [];
  let nodes = 0;
  for (let index = 0; index < graph.size; index += 1) {
    const value = graph.value(index);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const node = graph.dict(index);
    if (!node?.has("author") || !node.has("content")) continue;
    nodes += 1;
    const message = readMessage(graph, node, index);
    if (message) raw.push(message);
  }
  if (!nodes) {
    const reason = readServerError(graph);
    if (reason !== null) throw shareChatError("share-unavailable", `the shared chat is unavailable; the page says: ${reason}`);
    throw unsupported("the page data has no conversation messages; its layout may have changed");
  }
  const messages = normalizeMessages(raw);
  if (!messages.length) throw unsupported("the shared chat has no readable user or assistant messages");
  return { host: "chatgpt", title: readTitle(graph), messages };
}

const CHATGPT_SHARE_PATH = /^\/share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export const chatGptShareAdapter: ShareChatAdapter = {
  id: "chatgpt",
  hosts: ["chatgpt.com", "chat.openai.com"],
  canonicalUrl(url) {
    const id = CHATGPT_SHARE_PATH.exec(url.pathname)?.[1];
    return id ? `https://chatgpt.com/share/${id.toLowerCase()}` : null;
  },
  parse: parseChatGptSharePage,
};

/** Verified hosts only. */
export const SHARE_CHAT_ADAPTERS: readonly ShareChatAdapter[] = [chatGptShareAdapter];

/** Validates a user-supplied share link and picks its adapter. */
export function resolveShareUrl(
  raw: unknown,
  adapters: readonly ShareChatAdapter[] = SHARE_CHAT_ADAPTERS,
): { url: string; adapter: ShareChatAdapter } {
  if (typeof raw !== "string" || !raw.trim()) throw shareChatError("invalid-input", "url is required");
  if (raw.length > 4_096) throw shareChatError("invalid-input", "url must be at most 4096 characters");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw shareChatError("not-a-share-url", "url must be an absolute share link such as https://chatgpt.com/share/<id>");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw shareChatError("not-a-share-url", "url must use https");
  }
  if (url.username || url.password) throw shareChatError("not-a-share-url", "URLs with embedded credentials are not allowed");
  const host = url.hostname.toLowerCase();
  const adapter = adapters.find((candidate) => candidate.hosts.includes(host));
  if (!adapter) {
    const known = adapters.flatMap((candidate) => candidate.hosts).join(", ");
    throw shareChatError("unsupported-host", `${host} is not a supported share host (supported: ${known})`);
  }
  const canonical = adapter.canonicalUrl(url);
  if (!canonical) {
    throw shareChatError("not-a-share-url", `not a public share link; expected https://${adapter.hosts[0]}/share/<id>`);
  }
  return { url: canonical, adapter };
}

/** Parses page text with the adapter for its host (ChatGPT by default). */
export function parseSharedChatPage(page: string, adapter: ShareChatAdapter = chatGptShareAdapter): SharedChat {
  return adapter.parse(page);
}
