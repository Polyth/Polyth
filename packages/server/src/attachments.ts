// F2: attachment sanitation for /api/sessions/:id/message. Pure shape checks
// live here (testable without IO); existence checks stay in the session
// service where the project root is known.
import type { AttachmentRef } from "@polyth/contracts";

export const MAX_ATTACHMENTS = 16;
const NAME_MAX = 200;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const URL_MAX = 2048;

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

/** Same relative-path rule the files package enforces: no absolute paths,
 *  drive letters, `..` segments, or NUL bytes. */
export function isSafeRelPath(rel: unknown): rel is string {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return false;
  if (rel.includes("\0")) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) return false;
  return !rel.split(/[/\\]/).some((seg) => seg === "..");
}

/**
 * Validate and rebuild the attachment list from an untrusted request body.
 * Only known fields survive; the presentational URL for project-file kinds is
 * recomputed server-side so the durable log never stores a caller-supplied
 * URL for a file attachment. Throws typed `invalid-input` errors.
 */
export function sanitizeAttachments(
  input: unknown,
  opts: { maxBytes: number; projectId: string },
): AttachmentRef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw invalid("attachments must be an array");
  if (input.length > MAX_ATTACHMENTS) throw invalid(`too many attachments (max ${MAX_ATTACHMENTS})`);
  const out: AttachmentRef[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw invalid("attachment must be an object");
    }
    const a = raw as Record<string, unknown>;
    const id = typeof a.id === "string" && a.id.trim() && a.id.length <= 100 ? a.id : undefined;
    if (!id) throw invalid("attachment id required");
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!name || name.length > NAME_MAX) throw invalid(`attachment name required (≤${NAME_MAX} chars)`);
    const mime = typeof a.mime === "string" && MIME_RE.test(a.mime) && a.mime.length <= 100 ? a.mime : undefined;
    if (!mime) throw invalid(`attachment mime invalid: ${name}`);
    const size = Number(a.size);
    if (!Number.isSafeInteger(size) || size < 0) throw invalid(`attachment size invalid: ${name}`);
    if (size > opts.maxBytes) throw invalid(`attachment too large (max ${opts.maxBytes} bytes): ${name}`);
    const kind = a.kind === undefined ? "file" : a.kind;
    if (kind !== "file" && kind !== "image" && kind !== "range" && kind !== "url") {
      throw invalid(`attachment kind invalid: ${name}`);
    }

    if (kind === "url") {
      // Link-only attachment: the URL is text the model sees; nothing on the
      // server side ever fetches it (browser-package origin policy applies).
      const url = typeof a.url === "string" ? a.url : "";
      if (!url || url.length > URL_MAX) throw invalid(`attachment url required: ${name}`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw invalid(`attachment url invalid: ${name}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw invalid(`attachment url must be http(s): ${name}`);
      }
      out.push({ id, name, mime, size, kind: "url", url });
      continue;
    }

    if (!isSafeRelPath(a.path)) throw invalid(`attachment path invalid: ${name}`);
    const path = a.path;
    let range: [number, number] | undefined;
    if (kind === "range") {
      const r = a.range;
      if (!Array.isArray(r) || r.length !== 2) throw invalid(`attachment range required: ${name}`);
      const start = Number(r[0]);
      const end = Number(r[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 10_000_000) {
        throw invalid(`attachment range invalid: ${name}`);
      }
      range = [start, end];
    }
    out.push({
      id, name, mime, size, kind, path,
      // presentational only; recomputed so the log never stores foreign URLs
      url: `/api/files/raw?projectId=${encodeURIComponent(opts.projectId)}&path=${encodeURIComponent(path)}`,
      ...(range ? { range } : {}),
    });
  }
  return out;
}
