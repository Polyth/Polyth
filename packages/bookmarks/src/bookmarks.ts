// The bookmark model: pure rules shared by the server and the browser. A
// bookmark is a person's own copy of something from a chat (or a free note),
// never part of the chat's history, so nothing here is model-visible.

export const BOOKMARKS_PACKAGE_ID = "bookmarks";

export const BOOKMARK_KINDS = ["answer", "section", "fragment", "note"] as const;
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number];

export const BOOKMARK_LIMITS = {
  titleChars: 200,
  noteChars: 20_000,
  quoteChars: 2_000,
  bodyBytes: 512 * 1024,
  /** Per person in one Space. */
  count: 5_000,
  linksPerBookmark: 200,
  exportBytes: 32 * 1024 * 1024,
} as const;

export interface BookmarkLink {
  url: string;
  /** The link's own text, or its compact host and path. */
  label: string;
}

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  projectId: string;
  /** Absent on a project's own note. */
  sessionId?: string;
  /** The message; absent on any note. */
  eventSeq?: number;
  /** The chat's title when last seen, kept for a chat that is gone. */
  chatTitle?: string;
  /** Whether the chat was the person's own: only then a bookmark outlives it. */
  ownChat?: boolean;
  title: string;
  /** The person's own words beside the saved text. */
  note?: string;
  /** The selected words of a fragment, to find them again in the message. */
  quote?: string;
  links: BookmarkLink[];
  /** The person changed the saved text or title. */
  edited: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

/** "open": the place can be shown. "deleted": the chat is gone, the copy stays.
 *  "none": a free note has no chat. */
export type BookmarkChatState = "open" | "deleted" | "none";

export interface BookmarkView extends Bookmark {
  chat: BookmarkChatState;
}

export interface BookmarkDocument {
  version: 1;
  revision: number;
  bookmarks: Bookmark[];
}

export interface BookmarkInput {
  kind: BookmarkKind;
  sessionId?: string;
  projectId?: string;
  eventSeq?: number;
  title: string;
  body: string;
  note?: string;
  quote?: string;
  createdAt?: number;
}

export interface BookmarkPatch {
  title?: string;
  body?: string;
  note?: string;
}

export const emptyBookmarkDocument = (): BookmarkDocument => ({ version: 1, revision: 0, bookmarks: [] });

export const invalidInput = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
export const notFound = (message = "Bookmark not found"): Error => Object.assign(new Error(message), { code: "not-found" });
export const conflict = (message: string): Error => Object.assign(new Error(message), { code: "conflict" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isBookmarkId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text);

const stripInlineMarks = (line: string): string => line
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/[*_`~]+/g, "")
  .replace(/\s+/g, " ")
  .trim();

/** Prose lines of Markdown: fenced code never names a bookmark or holds a link. */
function proseLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) { fence = opener; continue; }
    lines.push(line);
  }
  return lines;
}

/** A name for saved text: its first heading, else its first line. */
export function deriveBookmarkTitle(markdown: string, max = 120): string {
  const lines = proseLines(markdown);
  const heading = lines.map((line) => /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]).find(Boolean);
  const first = heading ?? lines.find((line) => line.trim() !== "") ?? "";
  const plain = stripInlineMarks(first.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>+\s*)+/, ""));
  return clip(plain, max);
}

/** The part of saved text under one heading, up to the next heading of the same
 *  or a higher level. Null when the text has no such heading. */
export function extractBookmarkSection(markdown: string, heading: string): string | null {
  const wanted = stripInlineMarks(heading).toLocaleLowerCase();
  if (!wanted) return null;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) { fence = opener; continue; }
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    if (start >= 0 && match[1]!.length <= level) return lines.slice(start, index).join("\n").trim();
    if (start < 0 && stripInlineMarks(match[2]!).toLocaleLowerCase() === wanted) {
      start = index;
      level = match[1]!.length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

const MARKDOWN_LINK = /\[((?:[^\]\\]|\\.)*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gi;
const BARE_URL = /https?:\/\/[^\s<>"'`\\^{}|[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>*_]/;

function trimBareUrl(raw: string): string {
  let url = raw;
  while (url && TRAILING_PUNCTUATION.test(url.slice(-1))) {
    // Keep a ")" that closes a "(" inside the URL, as on Wikipedia.
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

function compactUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return clip(`${url.host.replace(/^www\./, "")}${path}`, 80);
}

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Every http(s) link of saved text, in reading order, once each. Code keeps
 *  its literal text out of the list, as it stays unlinked in a rendered chat. */
export function extractBookmarkLinks(markdown: string, max: number = BOOKMARK_LIMITS.linksPerBookmark): BookmarkLink[] {
  const found: BookmarkLink[] = [];
  const seen = new Set<string>();
  const add = (raw: string, label: string) => {
    const url = httpUrl(raw);
    if (!url || seen.has(url.href) || found.length >= max) return;
    seen.add(url.href);
    found.push({ url: url.href, label: clip(stripInlineMarks(label), 120) || compactUrl(url) });
  };
  for (const line of proseLines(markdown)) {
    const text = line.replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length));
    const spans: Array<{ at: number; end: number; url: string; label: string }> = [];
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      spans.push({ at: match.index, end: match.index + match[0].length, url: match[2]!, label: match[1]! });
    }
    for (const match of text.matchAll(BARE_URL)) {
      if (spans.some((span) => match.index >= span.at && match.index < span.end)) continue;
      const url = trimBareUrl(match[0]);
      spans.push({ at: match.index, end: match.index + url.length, url, label: "" });
    }
    for (const span of spans.sort((left, right) => left.at - right.at)) add(span.url, span.label);
  }
  return found;
}

function requireText(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalidInput(`${name} must be text`);
  return value;
}

function checkBody(body: string): string {
  if (new TextEncoder().encode(body).length > BOOKMARK_LIMITS.bodyBytes) throw invalidInput("This text is too long for a bookmark");
  return body;
}

function checkNote(value: unknown): string {
  const note = requireText(value, "note");
  if (note.length > BOOKMARK_LIMITS.noteChars) throw invalidInput("This note is too long");
  return note;
}

function checkTitle(value: unknown): string {
  const title = requireText(value, "title").replace(/\s+/g, " ").trim();
  if (title.length > BOOKMARK_LIMITS.titleChars) throw invalidInput("This title is too long");
  return title;
}

export function parseBookmarkInput(raw: unknown): BookmarkInput {
  if (!isRecord(raw)) throw invalidInput("Invalid bookmark");
  const kind = raw.kind as BookmarkKind;
  if (!BOOKMARK_KINDS.includes(kind)) throw invalidInput("Unknown bookmark kind");
  const body = checkBody(requireText(raw.body, "body"));
  const note = checkNote(raw.note);
  const quote = requireText(raw.quote, "quote");
  if (quote.length > BOOKMARK_LIMITS.quoteChars) throw invalidInput("This selection is too long to find again");
  const title = checkTitle(raw.title) || deriveBookmarkTitle(body) || deriveBookmarkTitle(note);
  if (!title) throw invalidInput("A bookmark needs some text");
  const createdAt = isTime(raw.createdAt) ? { createdAt: raw.createdAt } : {};
  const extras = {
    ...(note ? { note } : {}),
    ...(quote ? { quote } : {}),
    ...createdAt,
  };
  if (kind === "note") {
    // A note belongs to a chat's list, or to the project beside its chats.
    if (typeof raw.sessionId === "string" && raw.sessionId) return { kind, sessionId: raw.sessionId, title, body, ...extras };
    if (typeof raw.projectId !== "string" || !raw.projectId) throw invalidInput("Name the project for this note");
    return { kind, projectId: raw.projectId, title, body, ...extras };
  }
  if (typeof raw.sessionId !== "string" || !raw.sessionId) throw invalidInput("Name the chat for this bookmark");
  if (!isSeq(raw.eventSeq)) throw invalidInput("Name the message for this bookmark");
  return { kind, sessionId: raw.sessionId, eventSeq: raw.eventSeq, title, body, ...extras };
}

export function parseBookmarkPatch(raw: unknown): BookmarkPatch {
  if (!isRecord(raw)) throw invalidInput("Invalid change");
  const patch: BookmarkPatch = {};
  if (raw.title !== undefined) {
    const title = checkTitle(raw.title);
    if (!title) throw invalidInput("A bookmark needs a title");
    patch.title = title;
  }
  if (raw.body !== undefined) patch.body = checkBody(requireText(raw.body, "body"));
  if (raw.note !== undefined) patch.note = checkNote(raw.note);
  return patch;
}

function parseLinks(value: unknown): BookmarkLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => isRecord(link) && typeof link.url === "string" && httpUrl(link.url)
    ? [{ url: link.url, label: typeof link.label === "string" ? link.label : link.url }]
    : []);
}

function parseStored(value: unknown): Bookmark | null {
  if (!isRecord(value) || !isBookmarkId(value.id) || !BOOKMARK_KINDS.includes(value.kind as BookmarkKind)) return null;
  if (typeof value.projectId !== "string" || !value.projectId || typeof value.title !== "string") return null;
  const hasChat = typeof value.sessionId === "string" && value.sessionId !== "";
  const hasPlace = hasChat && isSeq(value.eventSeq);
  if (value.kind !== "note" && !hasPlace) return null;
  return {
    id: value.id,
    kind: value.kind as BookmarkKind,
    projectId: value.projectId,
    ...(hasChat ? { sessionId: value.sessionId as string } : {}),
    ...(hasPlace ? { eventSeq: value.eventSeq as number } : {}),
    ...(typeof value.chatTitle === "string" ? { chatTitle: value.chatTitle } : {}),
    ...(hasChat ? { ownChat: value.ownChat !== false } : {}),
    title: value.title,
    ...(typeof value.note === "string" && value.note ? { note: value.note } : {}),
    ...(typeof value.quote === "string" && value.quote ? { quote: value.quote } : {}),
    links: parseLinks(value.links),
    edited: value.edited === true,
    createdAt: isTime(value.createdAt) ? value.createdAt : 0,
    updatedAt: isTime(value.updatedAt) ? value.updatedAt : 0,
    revision: isSeq(value.revision) ? value.revision : 1,
  };
}

/** A damaged entry drops out; the rest of a person's bookmarks stay readable. */
export function parseBookmarkDocument(value: unknown): BookmarkDocument {
  if (!isRecord(value)) return emptyBookmarkDocument();
  return {
    version: 1,
    revision: isTime(value.revision) ? value.revision : 0,
    bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks.flatMap((entry) => parseStored(entry) ?? []) : [],
  };
}

/** Chat order inside one chat with its notes after, newest first between chats,
 *  a project's own notes last. */
export function compareBookmarks(left: Bookmark, right: Bookmark): number {
  if (left.sessionId && left.sessionId === right.sessionId) {
    if (left.eventSeq === undefined || right.eventSeq === undefined) {
      if (left.eventSeq !== right.eventSeq) return left.eventSeq === undefined ? 1 : -1;
      return left.createdAt - right.createdAt;
    }
    return left.eventSeq - right.eventSeq || left.createdAt - right.createdAt;
  }
  if (Boolean(left.sessionId) !== Boolean(right.sessionId)) return left.sessionId ? -1 : 1;
  return right.createdAt - left.createdAt;
}

const slug = (text: string): string => text
  .normalize("NFKD")
  .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
  .replace(/^-+|-+$/g, "")
  .toLowerCase()
  .slice(0, 48)
  .replace(/-+$/, "");

export function bookmarkExportFileName(name: string, at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  const part = slug(name);
  return part ? `bookmarks-${part}-${day}.md` : `bookmarks-${day}.md`;
}

/** Quotes the person's note so it reads apart from the saved text. */
const quoted = (text: string): string => text.trim().split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");

const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** One Markdown file: a heading per chat, a heading per bookmark. The language
 *  of the words around the saved text is left out: this runs on the server and
 *  the file is the person's own text. */
export function bookmarksMarkdown(input: {
  title: string;
  items: ReadonlyArray<{ bookmark: Bookmark; body: string }>;
}): string {
  const sections: string[] = [`# ${input.title}`];
  let chat: string | null = null;
  for (const { bookmark, body } of [...input.items].sort((left, right) => compareBookmarks(left.bookmark, right.bookmark))) {
    const key = bookmark.sessionId ?? "";
    if (bookmark.sessionId && key !== chat) sections.push(`## ${bookmark.chatTitle?.trim() || bookmark.sessionId}`);
    chat = key;
    const parts = [`### ${bookmark.title}`, `*${stamp(bookmark.createdAt)} UTC*`];
    if (bookmark.note) parts.push(quoted(bookmark.note));
    if (body.trim()) parts.push(body.trim());
    sections.push(parts.join("\n\n"));
  }
  return `${sections.join("\n\n")}\n`;
}
