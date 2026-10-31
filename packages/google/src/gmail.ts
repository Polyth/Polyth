// Gmail service: normalized reads and writes over the Gmail REST API. Callers
// get plain JSON (decoded text bodies, address objects, attachment metadata);
// raw MIME and base64 stay inside this module.

import { randomBytes } from "node:crypto";
import { GoogleError, googleError } from "./http.ts";
import type { GoogleClient } from "./http.ts";
import {
  collectAttachments,
  composeMessage,
  decodeBase64Url,
  decodeHeaderWords,
  decodeHtmlEntities,
  encodeBase64Url,
  extractBody,
  formatAddress,
  getHeader,
  parseAddressList,
} from "./mime.ts";
import type { GmailMessagePart, MimeAddress, MimeAttachment } from "./mime.ts";

export type { GmailMessagePart } from "./mime.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD_BASE = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const FAN_OUT = 8;
const JSON_SEND_LIMIT = 5 * 1024 * 1024;
const SEND_LIMIT = 35 * 1024 * 1024;
const DEFAULT_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const DEFAULT_BODY_CHARS = 20_000;
const MAX_HYDRATED_PARTS = 5;
const METADATA_HEADERS = ["From", "To", "Subject", "Date"];
const REPLY_HEADERS = ["Message-ID", "References", "Subject", "From", "Reply-To", "To", "Cc", "Date"];
const SYSTEM_LABELS = new Set([
  "INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

export type GmailAddress = MimeAddress;
export type GmailAttachment = Omit<MimeAttachment, "attachmentId">;

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  date: string;
  from?: GmailAddress;
  to: GmailAddress[];
  subject: string;
  snippet: string;
  labelIds: string[];
  unread: boolean;
  hasAttachments: boolean;
}

export interface GmailMessage extends GmailMessageSummary {
  cc: GmailAddress[];
  bcc: GmailAddress[];
  replyTo: GmailAddress[];
  messageIdHeader?: string;
  body: string;
  bodyFormat: "text" | "html-converted" | "none";
  bodyTruncated: boolean;
  attachments: GmailAttachment[];
}

export interface GmailThread { id: string; messages: GmailMessage[] }

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailDraft { id: string; message: GmailMessageSummary }
export interface GmailDraftRef { id: string; messageId: string; threadId: string; messageIdHeader: string }

export interface GmailFile { filename: string; mimeType: string; data: Uint8Array }

export interface ComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: GmailFile[];
}

export interface GmailSearchInput {
  query?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
  signal?: AbortSignal;
}

export interface GmailSent { id: string; threadId: string; labelIds: string[]; messageIdHeader: string }

interface WireMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface ReplyContext { to: string[]; cc: string[]; subject: string; inReplyTo?: string; references?: string; threadId: string }

const email = (address: GmailAddress): string => address.name ? `${address.name} <${address.email}>` : address.email;
// "." and ".." survive encodeURIComponent and URL normalization would turn
// them into a different API path.
const encode = (id: string): string => {
  if (typeof id !== "string" || !id || id === "." || id === "..") return googleError("invalid-request", "A Gmail id is required.");
  return encodeURIComponent(id);
};

function clampResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isNotFound = (error: unknown): boolean => error instanceof GoogleError && error.code === "not-found";

function dateOf(wire: WireMessage): string {
  const internal = Number(wire.internalDate);
  if (wire.internalDate && Number.isFinite(internal)) return new Date(internal).toISOString();
  const header = getHeader(wire.payload?.headers, "date");
  const parsed = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function list(headers: GmailMessagePart["headers"], name: string): GmailAddress[] {
  const value = getHeader(headers, name);
  return value ? parseAddressList(value) : [];
}

function summarize(wire: WireMessage): GmailMessageSummary {
  const headers = wire.payload?.headers;
  const from = list(headers, "from")[0];
  const labelIds = wire.labelIds ?? [];
  const payload = wire.payload;
  const hasAttachments = payload
    ? collectAttachments(payload).some((item) => !item.inline) || (payload.mimeType ?? "").toLowerCase() === "multipart/mixed"
    : false;
  return {
    id: wire.id,
    threadId: wire.threadId,
    date: dateOf(wire),
    ...(from ? { from } : {}),
    to: list(headers, "to"),
    subject: decodeHeaderWords(getHeader(headers, "subject") ?? ""),
    snippet: decodeHtmlEntities(wire.snippet ?? ""),
    labelIds,
    unread: labelIds.includes("UNREAD"),
    hasAttachments,
  };
}

function normalize(wire: WireMessage, maxChars: number): GmailMessage {
  const headers = wire.payload?.headers;
  const body = wire.payload ? extractBody(wire.payload, { maxChars }) : { body: "", format: "none" as const, truncated: false };
  const messageIdHeader = getHeader(headers, "message-id")?.trim();
  return {
    ...summarize(wire),
    hasAttachments: wire.payload ? collectAttachments(wire.payload).some((item) => !item.inline) : false,
    cc: list(headers, "cc"),
    bcc: list(headers, "bcc"),
    replyTo: list(headers, "reply-to"),
    ...(messageIdHeader ? { messageIdHeader } : {}),
    body: body.body,
    bodyFormat: body.format,
    bodyTruncated: body.truncated,
    attachments: wire.payload
      ? collectAttachments(wire.payload).map(({ attachmentId: _attachmentId, ...rest }) => rest)
      : [],
  };
}

function walkParts(part: GmailMessagePart | undefined, visit: (part: GmailMessagePart) => void, depth = 0): void {
  if (!part || depth > 32) return;
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit, depth + 1);
}

function findPart(payload: GmailMessagePart | undefined, partId: string): GmailMessagePart | undefined {
  let found: GmailMessagePart | undefined;
  walkParts(payload, (part) => { if (!found && part.partId === partId) found = part; });
  return found;
}

export function createGmailService(client: GoogleClient) {
  // Large text bodies arrive as an attachmentId instead of inline data.
  async function hydrateBodies(messageId: string, payload: GmailMessagePart | undefined, maxChars: number, signal?: AbortSignal): Promise<void> {
    const pending: GmailMessagePart[] = [];
    walkParts(payload, (part) => {
      const mime = (part.mimeType ?? "").toLowerCase();
      if ((mime === "text/plain" || mime === "text/html") && part.body?.attachmentId && !part.body.data && !part.filename?.trim()) pending.push(part);
    });
    const limit = Math.max(64 * 1024, maxChars * 4);
    for (const part of pending.slice(0, MAX_HYDRATED_PARTS)) {
      try {
        const loaded = await client.json<{ data?: string }>({
          url: `${BASE}/messages/${encode(messageId)}/attachments/${encode(part.body!.attachmentId!)}`,
          maxBytes: Math.ceil(limit * 4 / 3) + 4096,
          ...(signal ? { signal } : {}),
        });
        if (loaded?.data) part.body = { ...part.body, data: loaded.data };
      } catch (error) {
        if (!(error instanceof GoogleError) || (error.code !== "too-large" && error.code !== "not-found")) throw error;
      }
    }
  }

  async function readFull(id: string, maxChars: number, signal?: AbortSignal): Promise<WireMessage> {
    const wire = await client.json<WireMessage>({
      url: `${BASE}/messages/${encode(id)}`,
      query: { format: "full" },
      ...(signal ? { signal } : {}),
    });
    await hydrateBodies(wire.id, wire.payload, maxChars, signal);
    return wire;
  }

  const readMetadata = (id: string, headers: string[], signal?: AbortSignal): Promise<WireMessage> =>
    client.json<WireMessage>({
      url: `${BASE}/messages/${encode(id)}`,
      query: { format: "metadata", metadataHeaders: headers },
      ...(signal ? { signal } : {}),
    });

  async function getMessage(id: string, opts: { maxBodyChars?: number; signal?: AbortSignal } = {}): Promise<GmailMessage> {
    const maxChars = opts.maxBodyChars ?? DEFAULT_BODY_CHARS;
    return normalize(await readFull(id, maxChars, opts.signal), maxChars);
  }

  async function getThread(id: string, opts: { maxBodyChars?: number; signal?: AbortSignal } = {}): Promise<GmailThread> {
    const maxChars = opts.maxBodyChars ?? DEFAULT_BODY_CHARS;
    const wire = await client.json<{ id: string; messages?: WireMessage[] }>({
      url: `${BASE}/threads/${encode(id)}`,
      query: { format: "full" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const messages = wire.messages ?? [];
    for (const message of messages) await hydrateBodies(message.id, message.payload, maxChars, opts.signal);
    return { id: wire.id, messages: messages.map((message) => normalize(message, maxChars)) };
  }

  function listQuery(input: GmailSearchInput): Record<string, string | number | boolean | readonly string[] | undefined> {
    return {
      maxResults: clampResults(input.maxResults),
      q: input.query?.trim() || undefined,
      labelIds: input.labelIds?.length ? input.labelIds : undefined,
      pageToken: input.pageToken || undefined,
      includeSpamTrash: input.includeSpamTrash ? true : undefined,
    };
  }

  async function search(input: GmailSearchInput = {}): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string; resultSizeEstimate: number }> {
    const page = await client.json<{ messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${BASE}/messages`,
      query: listQuery(input),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const details = await mapLimit(page.messages ?? [], FAN_OUT, async (item) => {
      try {
        return summarize(await readMetadata(item.id, METADATA_HEADERS, input.signal));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
    return {
      messages: details.filter((item): item is GmailMessageSummary => item !== undefined),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: page.resultSizeEstimate ?? 0,
    };
  }

  async function listThreads(input: GmailSearchInput = {}): Promise<{
    threads: Array<{ id: string; snippet: string; messageCount: number; latest: GmailMessageSummary }>;
    nextPageToken?: string;
    resultSizeEstimate: number;
  }> {
    const page = await client.json<{ threads?: Array<{ id: string; snippet?: string }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${BASE}/threads`,
      query: listQuery(input),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const details = await mapLimit(page.threads ?? [], FAN_OUT, async (item) => {
      try {
        const thread = await client.json<{ id: string; messages?: WireMessage[] }>({
          url: `${BASE}/threads/${encode(item.id)}`,
          query: { format: "metadata", metadataHeaders: METADATA_HEADERS },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const messages = thread.messages ?? [];
        const last = messages[messages.length - 1];
        if (!last) return undefined;
        const latest = summarize(last);
        return {
          id: item.id,
          snippet: item.snippet ? decodeHtmlEntities(item.snippet) : latest.snippet,
          messageCount: messages.length,
          latest,
        };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
    return {
      threads: details.filter((item): item is NonNullable<typeof item> => item !== undefined),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: page.resultSizeEstimate ?? 0,
    };
  }

  async function loadAttachment(
    wire: WireMessage,
    partId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ filename: string; mimeType: string; size: number; data: Uint8Array }> {
    const part = wire.payload ? findPart(wire.payload, partId) : undefined;
    const meta = wire.payload ? collectAttachments(wire.payload).find((item) => item.partId === partId) : undefined;
    if (!part || !meta) return googleError("not-found", `Message ${wire.id} has no attachment with partId "${partId}".`);
    if (meta.size > maxBytes) return googleError("too-large", `Attachment "${meta.filename}" is ${meta.size} bytes, over the ${maxBytes} byte limit.`);
    let encoded = part.body?.data;
    if (!encoded) {
      if (!part.body?.attachmentId) return googleError("not-found", `Attachment "${meta.filename}" has no downloadable content.`);
      const loaded = await client.json<{ data?: string }>({
        url: `${BASE}/messages/${encode(wire.id)}/attachments/${encode(part.body.attachmentId)}`,
        maxBytes: Math.ceil(maxBytes * 4 / 3) + 4096,
        ...(signal ? { signal } : {}),
      });
      encoded = loaded?.data ?? "";
    }
    const data = decodeBase64Url(encoded);
    if (data.byteLength > maxBytes) return googleError("too-large", `Attachment "${meta.filename}" is over the ${maxBytes} byte limit.`);
    return { filename: meta.filename, mimeType: meta.mimeType, size: data.byteLength, data };
  }

  async function getAttachment(
    messageId: string,
    partId: string,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ filename: string; mimeType: string; size: number; data: Uint8Array }> {
    // attachmentId is not stable between reads, so resolve it from a fresh read.
    const wire = await client.json<WireMessage>({
      url: `${BASE}/messages/${encode(messageId)}`,
      query: { format: "full" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return loadAttachment(wire, partId, opts.maxBytes ?? DEFAULT_ATTACHMENT_LIMIT, opts.signal);
  }

  // ── labels ────────────────────────────────────────────────────────────────

  async function listLabels(): Promise<GmailLabel[]> {
    const result = await client.json<{ labels?: Array<{ id: string; name: string; type?: string; messagesTotal?: number; messagesUnread?: number }> }>({
      url: `${BASE}/labels`,
    });
    return (result.labels ?? []).map((label) => ({
      id: label.id,
      name: label.name,
      type: label.type === "system" ? "system" : "user",
      ...(label.messagesTotal !== undefined ? { messagesTotal: label.messagesTotal } : {}),
      ...(label.messagesUnread !== undefined ? { messagesUnread: label.messagesUnread } : {}),
    }));
  }

  async function createLabel(name: string): Promise<GmailLabel> {
    const trimmed = name.trim();
    if (!trimmed) return googleError("invalid-request", "A label needs a name.");
    const label = await client.json<{ id: string; name: string; type?: string }>({
      method: "POST",
      url: `${BASE}/labels`,
      json: { name: trimmed, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return { id: label.id, name: label.name, type: label.type === "system" ? "system" : "user" };
  }

  async function resolveLabels(entries: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set((entries ?? []).map((entry) => entry.trim()).filter(Boolean))];
    if (!wanted.length) return [];
    if (wanted.every((entry) => SYSTEM_LABELS.has(entry))) return wanted;
    const labels = await listLabels();
    const ids = new Set(labels.map((label) => label.id));
    const byName = new Map(labels.map((label) => [label.name.toLowerCase(), label.id]));
    const unknown: string[] = [];
    const resolved = wanted.map((entry) => {
      if (ids.has(entry)) return entry;
      const id = byName.get(entry.toLowerCase());
      if (!id) unknown.push(entry);
      return id ?? entry;
    });
    if (unknown.length) {
      return googleError("invalid-request", `Unknown Gmail label${unknown.length > 1 ? "s" : ""}: ${unknown.map((item) => `"${item}"`).join(", ")}. Use list labels to see valid names, or create the label first.`);
    }
    return [...new Set(resolved)];
  }

  async function modify(input: { messageIds?: string[]; threadId?: string; addLabels?: string[]; removeLabels?: string[] }): Promise<{ updated: number }> {
    const messageIds = [...new Set(input.messageIds ?? [])];
    if ((messageIds.length > 0) === Boolean(input.threadId)) {
      return googleError("invalid-request", "Give either messageIds or a threadId to modify, not both or neither.");
    }
    if (!input.addLabels?.length && !input.removeLabels?.length) {
      return googleError("invalid-request", "Give at least one label to add or remove.");
    }
    const addLabelIds = await resolveLabels(input.addLabels);
    const removeLabelIds = await resolveLabels(input.removeLabels);
    const body = { addLabelIds, removeLabelIds };
    if (input.threadId) {
      await client.json({ method: "POST", url: `${BASE}/threads/${encode(input.threadId)}/modify`, json: body });
      return { updated: 1 };
    }
    if (messageIds.length === 1) {
      await client.json({ method: "POST", url: `${BASE}/messages/${encode(messageIds[0]!)}/modify`, json: body });
      return { updated: 1 };
    }
    for (let i = 0; i < messageIds.length; i += 1000) {
      await client.json({ method: "POST", url: `${BASE}/messages/batchModify`, json: { ids: messageIds.slice(i, i + 1000), ...body } });
    }
    return { updated: messageIds.length };
  }

  async function setTrashed(target: { messageId?: string; threadId?: string }, action: "trash" | "untrash"): Promise<{ ok: true }> {
    if (Boolean(target.messageId) === Boolean(target.threadId)) {
      return googleError("invalid-request", "Give either a messageId or a threadId.");
    }
    const path = target.threadId ? `threads/${encode(target.threadId)}` : `messages/${encode(target.messageId!)}`;
    await client.json({ method: "POST", url: `${BASE}/${path}/${action}` });
    return { ok: true };
  }

  // ── sending ───────────────────────────────────────────────────────────────

  async function submit(
    kind: "message" | "draft",
    target: { method: "POST" | "PUT"; path: string },
    raw: string,
    threadId: string | undefined,
  ): Promise<{ id: string; threadId: string; labelIds: string[]; draftId?: string }> {
    const size = Buffer.byteLength(raw, "utf8");
    if (size > SEND_LIMIT) return googleError("too-large", `The message is ${Math.round(size / 1024 / 1024)} MiB; Gmail accepts at most 35 MiB.`);
    let response: { id: string; threadId?: string; labelIds?: string[]; message?: { id: string; threadId?: string; labelIds?: string[] } };
    if (size <= JSON_SEND_LIMIT) {
      const message = { raw: encodeBase64Url(raw), ...(threadId ? { threadId } : {}) };
      response = await client.json({
        method: target.method,
        url: `${BASE}/${target.path}`,
        json: kind === "draft" ? { message } : message,
      });
    } else if (threadId) {
      const mark = `polyth-upload-${randomBytes(8).toString("hex")}`;
      const metadata = JSON.stringify(kind === "draft" ? { message: { threadId } } : { threadId });
      response = await client.json({
        method: target.method,
        url: `${UPLOAD_BASE}/${target.path}`,
        query: { uploadType: "multipart" },
        body: `--${mark}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${mark}\r\nContent-Type: message/rfc822\r\n\r\n${raw}\r\n--${mark}--`,
        contentType: `multipart/related; boundary=${mark}`,
      });
    } else {
      response = await client.json({
        method: target.method,
        url: `${UPLOAD_BASE}/${target.path}`,
        query: { uploadType: "media" },
        body: raw,
        contentType: "message/rfc822",
      });
    }
    const message = kind === "draft" ? response.message : response;
    if (!message) return googleError("google-unavailable", "Google returned no message for the request.");
    return {
      id: message.id,
      threadId: message.threadId ?? threadId ?? "",
      labelIds: message.labelIds ?? [],
      ...(kind === "draft" ? { draftId: response.id } : {}),
    };
  }

  function requireRecipient(input: ComposeInput): void {
    if (![input.to, input.cc, input.bcc].some((entries) => entries?.length)) {
      googleError("invalid-request", "A message needs at least one recipient in to, cc or bcc.");
    }
  }

  async function sendComposed(compose: Parameters<typeof composeMessage>[0], threadId?: string): Promise<GmailSent> {
    const { raw, messageId } = composeMessage(compose);
    const sent = await submit("message", { method: "POST", path: "messages/send" }, raw, threadId);
    return { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds, messageIdHeader: messageId };
  }

  async function send(input: ComposeInput & { threadId?: string }): Promise<GmailSent> {
    requireRecipient(input);
    return sendComposed(input, input.threadId);
  }

  async function replyContext(
    messageId: string,
    options: { replyAll?: boolean; selfEmail?: string; cc?: string[] },
    signal?: AbortSignal,
  ): Promise<ReplyContext> {
    const original = await readMetadata(messageId, REPLY_HEADERS, signal);
    const headers = original.payload?.headers;
    const self = options.selfEmail?.trim().toLowerCase();
    const isSelf = (address: GmailAddress) => Boolean(self) && address.email.toLowerCase() === self;
    const from = list(headers, "from");
    const replyTo = list(headers, "reply-to");
    const origTo = list(headers, "to");
    const origCc = list(headers, "cc");
    const sentBySelf = from.length > 0 && from.every(isSelf);
    const primary = sentBySelf ? origTo : (replyTo.length ? replyTo : from);
    const seen = new Set<string>();
    const unique = (addresses: GmailAddress[]) => addresses.filter((address) => {
      const key = address.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const to = unique(primary.filter((address) => sentBySelf || !isSelf(address)));
    const others = options.replyAll ? unique([...(sentBySelf ? [] : origTo), ...origCc].filter((address) => !isSelf(address))) : [];
    const subject = decodeHeaderWords(getHeader(headers, "subject") ?? "").trim();
    const messageIdHeader = getHeader(headers, "message-id")?.trim();
    const references = getHeader(headers, "references")?.trim().split(/\s+/).filter(Boolean) ?? [];
    return {
      to: to.map(formatAddress),
      cc: [...others.map(formatAddress), ...(options.cc ?? [])],
      subject: /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`,
      ...(messageIdHeader ? { inReplyTo: messageIdHeader, references: [...references, messageIdHeader].join(" ") } : {}),
      threadId: original.threadId,
    };
  }

  type ReplyOptions = { replyAll?: boolean; selfEmail?: string };

  async function reply(input: {
    messageId: string;
    text: string;
    html?: string;
    cc?: string[];
    bcc?: string[];
    attachments?: GmailFile[];
  } & ReplyOptions): Promise<GmailSent> {
    const context = await replyContext(input.messageId, input);
    if (!context.to.length && !context.cc.length) return googleError("invalid-request", "The original message has no one to reply to.");
    return sendComposed({
      to: context.to,
      cc: context.cc,
      ...(input.bcc ? { bcc: input.bcc } : {}),
      subject: context.subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(context.inReplyTo ? { inReplyTo: context.inReplyTo } : {}),
      ...(context.references ? { references: context.references } : {}),
    }, context.threadId);
  }

  async function forward(input: {
    messageId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    text?: string;
    includeAttachments?: boolean;
  }): Promise<GmailSent> {
    const wire = await readFull(input.messageId, 200_000);
    const original = normalize(wire, 200_000);
    const subject = original.subject;
    const dateHeader = getHeader(wire.payload?.headers, "date") ?? original.date;
    const block = [
      "---------- Forwarded message ---------",
      `From: ${original.from ? email(original.from) : ""}`,
      `Date: ${dateHeader}`,
      `Subject: ${subject}`,
      `To: ${original.to.map(email).join(", ")}`,
      "",
      original.body,
    ].join("\n");
    const attachments: GmailFile[] = [];
    if (input.includeAttachments !== false && wire.payload) {
      let remaining = DEFAULT_ATTACHMENT_LIMIT;
      for (const item of collectAttachments(wire.payload).filter((entry) => !entry.inline)) {
        const file = await loadAttachment(wire, item.partId, remaining);
        remaining -= file.size;
        attachments.push({ filename: file.filename, mimeType: file.mimeType, data: file.data });
      }
    }
    return sendComposed({
      to: input.to,
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.bcc ? { bcc: input.bcc } : {}),
      subject: /^\s*fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
      text: input.text?.trim() ? `${input.text.trim()}\n\n${block}` : block,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  // ── drafts ────────────────────────────────────────────────────────────────

  async function buildDraft(input: ComposeInput & { replyToMessageId?: string } & ReplyOptions): Promise<{ raw: string; messageId: string; threadId?: string }> {
    let compose: Parameters<typeof composeMessage>[0] = input;
    let threadId: string | undefined;
    if (input.replyToMessageId) {
      const context = await replyContext(input.replyToMessageId, { ...input, cc: input.cc });
      threadId = context.threadId;
      compose = {
        ...input,
        to: input.to.length ? input.to : context.to,
        cc: context.cc,
        subject: input.subject.trim() ? input.subject : context.subject,
        ...(context.inReplyTo ? { inReplyTo: context.inReplyTo } : {}),
        ...(context.references ? { references: context.references } : {}),
      };
    }
    const { raw, messageId } = composeMessage(compose);
    return { raw, messageId, ...(threadId ? { threadId } : {}) };
  }

  async function saveDraft(method: "POST" | "PUT", path: string, input: ComposeInput & { replyToMessageId?: string } & ReplyOptions): Promise<GmailDraftRef> {
    const built = await buildDraft(input);
    const saved = await submit("draft", { method, path }, built.raw, built.threadId);
    return { id: saved.draftId ?? "", messageId: saved.id, threadId: saved.threadId, messageIdHeader: built.messageId };
  }

  const createDraft = (input: ComposeInput & { replyToMessageId?: string } & ReplyOptions): Promise<GmailDraftRef> =>
    saveDraft("POST", "drafts", input);

  const updateDraft = (id: string, input: ComposeInput & { replyToMessageId?: string } & ReplyOptions): Promise<GmailDraftRef> =>
    saveDraft("PUT", `drafts/${encode(id)}`, input);

  async function listDrafts(input: { maxResults?: number; pageToken?: string; signal?: AbortSignal } = {}): Promise<{
    drafts: GmailDraft[];
    nextPageToken?: string;
    resultSizeEstimate: number;
  }> {
    const page = await client.json<{ drafts?: Array<{ id: string; message?: { id: string } }>; nextPageToken?: string; resultSizeEstimate?: number }>({
      url: `${BASE}/drafts`,
      query: { maxResults: clampResults(input.maxResults), pageToken: input.pageToken || undefined },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const details = await mapLimit((page.drafts ?? []).filter((draft) => draft.message?.id), FAN_OUT, async (draft) => {
      try {
        return { id: draft.id, message: summarize(await readMetadata(draft.message!.id, METADATA_HEADERS, input.signal)) };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
    return {
      drafts: details.filter((item): item is GmailDraft => item !== undefined),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: page.resultSizeEstimate ?? 0,
    };
  }

  async function getDraft(id: string, opts: { maxBodyChars?: number; signal?: AbortSignal } = {}): Promise<{ id: string; message: GmailMessage }> {
    const maxChars = opts.maxBodyChars ?? DEFAULT_BODY_CHARS;
    const draft = await client.json<{ id: string; message: WireMessage }>({
      url: `${BASE}/drafts/${encode(id)}`,
      query: { format: "full" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await hydrateBodies(draft.message.id, draft.message.payload, maxChars, opts.signal);
    return { id: draft.id, message: normalize(draft.message, maxChars) };
  }

  async function sendDraft(id: string): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const sent = await client.json<{ id: string; threadId: string; labelIds?: string[] }>({
      method: "POST",
      url: `${BASE}/drafts/send`,
      json: { id },
    });
    return { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds ?? [] };
  }

  async function deleteDraft(id: string): Promise<{ ok: true }> {
    await client.json({ method: "DELETE", url: `${BASE}/drafts/${encode(id)}` });
    return { ok: true };
  }

  return {
    search,
    listThreads,
    getMessage,
    getThread,
    getAttachment,
    listLabels,
    createLabel,
    modify,
    trash: (target: { messageId?: string; threadId?: string }) => setTrashed(target, "trash"),
    untrash: (target: { messageId?: string; threadId?: string }) => setTrashed(target, "untrash"),
    send,
    reply,
    forward,
    listDrafts,
    getDraft,
    createDraft,
    updateDraft,
    sendDraft,
    deleteDraft,
  };
}

export type GmailService = ReturnType<typeof createGmailService>;
