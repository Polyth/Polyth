// Pure MIME helpers for Gmail: wire-body extraction, header decoding and RFC 5322
// composition. No network, no filesystem.

import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import { googleError } from "./http.ts";

export interface GmailHeader { name: string; value: string }

/** Gmail REST `MessagePart`. */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface MimeAddress { name?: string; email: string }

export interface MimeAttachment {
  partId: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface ComposeMime {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; mimeType: string; data: Uint8Array }>;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

const MAX_DEPTH = 32;

// ── base64url ────────────────────────────────────────────────────────────────

export function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** Unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array | string): string {
  return (typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes)).toString("base64url");
}

// ── text decoding ────────────────────────────────────────────────────────────

export function decodeText(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "utf-8").trim().replace(/^["']|["']$/g, "") || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ── RFC 2047 ────────────────────────────────────────────────────────────────

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function decodeQ(payload: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i]!;
    if (ch === "_") bytes.push(0x20);
    else if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(payload.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(payload.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

export function decodeHeaderWords(value: string): string {
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  return joined.replace(ENCODED_WORD, (_match, charset: string, encoding: string, payload: string) => {
    const bytes = encoding.toLowerCase() === "b" ? decodeBase64Url(payload) : decodeQ(payload);
    return decodeText(bytes, charset.split("*")[0]);
  });
}

const needsEncoding = (text: string): boolean => /[^\x20-\x7e]/.test(text) || text.length > 900;

/** `=?UTF-8?B?…?=` words of at most 75 chars, split on code point boundaries, folded with CRLF + space. */
export function encodeHeaderWords(text: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
    chunk = [];
  };
  for (const char of text) {
    const bytes = Buffer.from(char, "utf8");
    if (chunk.length + bytes.length > 45) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join("\r\n ");
}

const headerText = (value: string): string => needsEncoding(value) ? encodeHeaderWords(value) : value;

// ── HTML entities and text ──────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", bull: "•", middot: "·", euro: "€",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", zwnj: "", zwj: "", shy: "",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote",
  "section", "article", "header", "footer", "pre", "hr", "dt", "dd",
]);
const SKIPPED_TAGS = new Set(["script", "style", "head", "title"]);

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  const links: Array<{ href: string | undefined; start: number }> = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i).replace(/\s+/g, " "); break; }
    if (lt > i) out += html.slice(i, lt).replace(/\s+/g, " ");
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) { out += html.slice(lt).replace(/\s+/g, " "); break; }
    const tag = html.slice(lt + 1, gt);
    i = gt + 1;
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.toLowerCase();
    const closing = tag.trimStart().startsWith("/");
    if (!closing && SKIPPED_TAGS.has(name) && !tag.endsWith("/")) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) { i = html.length; break; }
      const close = html.indexOf(">", end);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (name === "a") {
      if (!closing) links.push({ href: attributeValue(tag, "href"), start: out.length });
      else {
        const link = links.pop();
        const href = link?.href ? decodeHtmlEntities(link.href).trim() : undefined;
        if (link && href && /^(https?:|mailto:)/i.test(href)) {
          const label = out.slice(link.start).trim();
          if (label && label !== href && label !== href.replace(/^mailto:/i, "")) out += ` (${href})`;
        }
      }
      continue;
    }
    if (name === "br") out += "\n";
    else if (BLOCK_TAGS.has(name)) out += out.endsWith("\n") || !out ? "" : "\n";
    else if (name === "td" || name === "th") out += " ";
  }
  return decodeHtmlEntities(out)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── headers ─────────────────────────────────────────────────────────────────

export function getHeader(headers: readonly GmailHeader[] | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === wanted)?.value;
}

const partHeader = (part: GmailMessagePart, name: string): string | undefined => getHeader(part.headers, name);

function charsetOf(part: GmailMessagePart): string | undefined {
  const type = partHeader(part, "content-type");
  return type ? /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] : undefined;
}

const dispositionOf = (part: GmailMessagePart): string =>
  (partHeader(part, "content-disposition") ?? "").trim().toLowerCase();

function isAttachmentPart(part: GmailMessagePart): boolean {
  return Boolean(part.filename?.trim()) || dispositionOf(part).startsWith("attachment");
}

// ── addresses ───────────────────────────────────────────────────────────────

const ADDR_CHARS = "[^\\s<>@\",;:()\\[\\]\\\\]+";
const EMAIL = new RegExp(`^${ADDR_CHARS}@${ADDR_CHARS}$`);

function parseMailbox(piece: string): MimeAddress | undefined {
  const text = piece.trim();
  if (!text) return undefined;
  const lt = text.lastIndexOf("<");
  const gt = lt >= 0 ? text.indexOf(">", lt) : -1;
  if (lt >= 0 && gt > lt) {
    const email = text.slice(lt + 1, gt).trim();
    if (!EMAIL.test(email)) return undefined;
    let name = text.slice(0, lt).trim();
    if (name.length >= 2 && name.startsWith("\"") && name.endsWith("\"")) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    name = decodeHeaderWords(name).trim();
    return name ? { name, email } : { email };
  }
  return EMAIL.test(text) ? { email: text } : undefined;
}

export function parseAddressList(header: string): MimeAddress[] {
  const result: MimeAddress[] = [];
  let buffer = "";
  let quoted = false;
  let angle = false;
  let comment = 0;
  const flush = () => {
    const parsed = parseMailbox(buffer);
    if (parsed) result.push(parsed);
    buffer = "";
  };
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i]!;
    if (comment > 0) {
      if (ch === "(") comment += 1;
      else if (ch === ")") comment -= 1;
      continue;
    }
    if (quoted) {
      buffer += ch;
      if (ch === "\\" && i + 1 < header.length) { buffer += header[i + 1]!; i += 1; }
      else if (ch === "\"") quoted = false;
      continue;
    }
    if (ch === "\"" && !angle) { quoted = true; buffer += ch; continue; }
    if (ch === "<") angle = true;
    else if (ch === ">") angle = false;
    if (angle) { buffer += ch; continue; }
    if (ch === "(") comment = 1;
    else if (ch === ",") flush();
    // A group (`Team: a@b, c@d;`) contributes its members, not its label.
    else if (ch === ";") flush();
    else if (ch === ":") buffer = "";
    else buffer += ch;
  }
  flush();
  return result;
}

// ── body extraction ─────────────────────────────────────────────────────────

interface Piece { text: string; html: boolean }

function partText(part: GmailMessagePart): string | undefined {
  const data = part.body?.data;
  if (!data) return undefined;
  return decodeText(decodeBase64Url(data), charsetOf(part)).replace(/\r\n?/g, "\n");
}

function render(part: GmailMessagePart | undefined, depth: number): Piece[] {
  if (!part || depth > MAX_DEPTH || isAttachmentPart(part)) return [];
  const mime = (part.mimeType ?? "").toLowerCase();
  if (part.parts?.length || mime.startsWith("multipart/")) {
    const children = (part.parts ?? []).map((child) => render(child, depth + 1));
    if (mime === "multipart/alternative") {
      const plain = children.find((pieces) => pieces.length > 0 && pieces.every((piece) => !piece.html));
      if (plain) return plain;
      for (let i = children.length - 1; i >= 0; i -= 1) if (children[i]!.length) return children[i]!;
      return [];
    }
    return children.flat();
  }
  const text = partText(part);
  if (text === undefined) return [];
  if (mime === "text/plain") return [{ text, html: false }];
  if (mime === "text/html") return [{ text, html: true }];
  return [];
}

const clipChars = (text: string, max: number): string => {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

export function extractBody(
  payload: GmailMessagePart,
  opts: { maxChars: number },
): { body: string; format: "text" | "html-converted" | "none"; truncated: boolean } {
  let pieces: Piece[] = [];
  try {
    pieces = render(payload, 0);
  } catch {
    pieces = [];
  }
  const parts = pieces.map((piece) => piece.html ? htmlToText(piece.text) : piece.text.trim()).filter(Boolean);
  if (!parts.length) return { body: "", format: "none", truncated: false };
  const full = parts.join("\n\n");
  const max = Math.max(0, Math.trunc(opts.maxChars));
  const truncated = full.length > max;
  return {
    body: truncated ? clipChars(full, max) : full,
    format: pieces.some((piece) => piece.html) ? "html-converted" : "text",
    truncated,
  };
}

// ── attachments ─────────────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf", "application/zip": ".zip", "application/json": ".json", "application/gzip": ".gz",
  "application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
  "image/heic": ".heic", "text/calendar": ".ics", "text/csv": ".csv", "message/rfc822": ".eml",
  "audio/mpeg": ".mp3", "video/mp4": ".mp4",
};

export function collectAttachments(payload: GmailMessagePart): MimeAttachment[] {
  const found: MimeAttachment[] = [];
  const walk = (part: GmailMessagePart | undefined, parentMime: string, path: string, depth: number) => {
    if (!part || depth > MAX_DEPTH) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename?.trim() ?? "";
    const disposition = dispositionOf(part);
    const isMultipart = mime.startsWith("multipart/");
    const isTextBody = mime.startsWith("text/") && !filename && !disposition.startsWith("attachment");
    const candidate = !isMultipart && !isTextBody
      && (Boolean(filename) || Boolean(part.body?.attachmentId) || disposition.startsWith("attachment"));
    const partId = part.partId ?? path;
    if (candidate) {
      const contentId = partHeader(part, "content-id")?.trim().replace(/^<|>$/g, "");
      const inline = !disposition.startsWith("attachment")
        && (disposition.startsWith("inline") || Boolean(contentId && parentMime === "multipart/related"));
      found.push({
        partId,
        ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
        filename: filename || `attachment-${partId}${EXTENSIONS[mime] ?? ""}`,
        mimeType: mime || "application/octet-stream",
        size: part.body?.size ?? 0,
        inline,
        ...(contentId ? { contentId } : {}),
      });
    }
    if (mime === "message/rfc822" && candidate) return;
    (part.parts ?? []).forEach((child, index) => walk(child, mime, `${partId}.${index}`, depth + 1));
  };
  try {
    walk(payload, "", "0", 0);
  } catch {
    return found;
  }
  return found;
}

// ── composition ─────────────────────────────────────────────────────────────

const clip = (text: string, max = 80): string => text.length > max ? `${text.slice(0, max)}…` : text;

function noLineBreaks(label: string, value: string): string {
  if (/[\r\n\0]/.test(value)) return googleError("invalid-request", `${label} must not contain line breaks.`);
  return value;
}

function validateAddress(address: MimeAddress, source: string): MimeAddress {
  const at = address.email.lastIndexOf("@");
  const local = address.email.slice(0, at);
  const domain = domainToASCII(address.email.slice(at + 1));
  if (at < 1 || !domain || /[^\x21-\x7e]/.test(local) || !EMAIL.test(`${local}@${domain}`)) {
    return googleError("invalid-request", `"${clip(source)}" is not a valid email address.`);
  }
  return { ...address, email: `${local}@${domain}` };
}

/** `Name <a@b>` with the name quoted or RFC 2047-encoded as needed. */
export function formatAddress(address: MimeAddress): string {
  const email = validateAddress(address, address.email).email;
  const name = address.name?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!name) return email;
  if (/[^\x20-\x7e]/.test(name)) return `${encodeHeaderWords(name)} <${email}>`;
  if (/[()<>@,;:\\".[\]]/.test(name)) return `"${name.replace(/[\\"]/g, "\\$&")}" <${email}>`;
  return `${name} <${email}>`;
}

function recipients(label: string, values: string[] | undefined): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    noLineBreaks(label, value);
    const parsed = parseAddressList(value);
    if (!parsed.length) return googleError("invalid-request", `"${clip(value)}" is not a valid email address.`);
    for (const address of parsed) result.push(formatAddress(validateAddress(address, value)));
  }
  return result;
}

const wrap76 = (bytes: Uint8Array): string => {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join("\r\n");
};

interface MimePart { headers: string[]; body: string }

const boundary = (): string => `----polyth-${randomBytes(12).toString("hex")}`;

function textPart(subtype: "plain" | "html", text: string): MimePart {
  return {
    headers: [`Content-Type: text/${subtype}; charset="UTF-8"`, "Content-Transfer-Encoding: base64"],
    body: wrap76(Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8")),
  };
}

function multipart(subtype: "alternative" | "mixed", children: MimePart[]): MimePart {
  const mark = boundary();
  const body = children.map((child) => `--${mark}\r\n${child.headers.join("\r\n")}\r\n\r\n${child.body}\r\n`).join("");
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${mark}"`], body: `${body}--${mark}--\r\n` };
}

function percentEncode(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function attachmentPart(file: { filename: string; mimeType: string; data: Uint8Array }): MimePart {
  noLineBreaks("Attachment filename", file.filename);
  noLineBreaks("Attachment type", file.mimeType);
  const mime = file.mimeType.trim() || "application/octet-stream";
  if (!/^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/.test(mime)) {
    return googleError("invalid-request", `"${clip(mime)}" is not a valid attachment content type.`);
  }
  const filename = file.filename.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || "attachment";
  const plain = /^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const params = (key: string) => plain
    ? `${key}="${filename}"`
    : `${key}="${fallback}"; ${key}*=UTF-8''${percentEncode(filename)}`;
  return {
    headers: [
      `Content-Type: ${mime}; ${params("name")}`,
      `Content-Disposition: attachment; ${params("filename")}`,
      "Content-Transfer-Encoding: base64",
    ],
    body: wrap76(file.data),
  };
}

function messageIdValue(value: string | undefined): string {
  if (!value?.trim()) return `<${randomBytes(16).toString("hex")}@polyth.local>`;
  noLineBreaks("Message-ID", value);
  const trimmed = value.trim();
  const id = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed.replace(/^<|>$/g, "")}>`;
  if (/[\s,;]/.test(id)) return googleError("invalid-request", "Message-ID must be a single identifier.");
  return id;
}

export function composeMessage(input: ComposeMime): { raw: string; messageId: string } {
  const messageId = messageIdValue(input.messageId);
  const headers: string[] = [];
  if (input.from) {
    noLineBreaks("From", input.from);
    headers.push(`From: ${recipients("From", [input.from]).join(", ")}`);
  }
  for (const [label, list] of [["To", input.to], ["Cc", input.cc], ["Bcc", input.bcc]] as const) {
    const formatted = recipients(label, list);
    if (formatted.length) headers.push(`${label}: ${formatted.join(",\r\n ")}`);
  }
  noLineBreaks("Subject", input.subject);
  headers.push(`Subject: ${headerText(input.subject)}`);
  headers.push(`Message-ID: ${messageId}`);
  if (input.inReplyTo) {
    noLineBreaks("In-Reply-To", input.inReplyTo);
    headers.push(`In-Reply-To: ${input.inReplyTo.trim()}`);
  }
  if (input.references) {
    noLineBreaks("References", input.references);
    headers.push(`References: ${input.references.trim().split(/\s+/).join("\r\n ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const plain = textPart("plain", input.text);
  const content = input.html !== undefined ? multipart("alternative", [plain, textPart("html", input.html)]) : plain;
  const top = input.attachments?.length
    ? multipart("mixed", [content, ...input.attachments.map(attachmentPart)])
    : content;
  const raw = `${[...headers, ...top.headers].join("\r\n")}\r\n\r\n${top.body}`;
  return { raw, messageId };
}
