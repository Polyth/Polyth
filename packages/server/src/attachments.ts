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
    if (kind !== "file" && kind !== "image" && kind !== "range" && kind !== "url" && kind !== "browser-context") {
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

    if (kind === "browser-context") {
      const ctx = sanitizeBrowserContext(a.browserContext, opts.projectId);
      out.push({
        id,
        name,
        mime,
        size: 0,
        kind: "browser-context",
        browserContext: ctx,
        url: ctx.crop
          ? `/api/browser/artifacts?id=${encodeURIComponent(ctx.crop.id)}`
          : ctx.screenshot
            ? `/api/browser/artifacts?id=${encodeURIComponent(ctx.screenshot.id)}`
            : undefined,
      });
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

function sanitizeBounds(raw: unknown): import("@polyth/contracts").BrowserContextBounds | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return undefined;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
}

function sanitizeElement(raw: unknown): import("@polyth/contracts").BrowserContextElementSummary | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const selector = typeof e.selector === "string" ? e.selector.slice(0, 300) : undefined;
  const tag = typeof e.tag === "string" ? e.tag.slice(0, 40) : undefined;
  if (!selector && !tag) return undefined;
  const attributes = e.attributes && typeof e.attributes === "object" && !Array.isArray(e.attributes)
    ? Object.fromEntries(
      Object.entries(e.attributes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .slice(0, 12)
        .map(([k, v]) => [k.slice(0, 80), v.slice(0, 200)]),
    )
    : undefined;
  const bounds = sanitizeBounds(e.bounds);
  return {
    ...(selector ? { selector } : {}),
    ...(tag ? { tag } : {}),
    ...(typeof e.role === "string" ? { role: e.role.slice(0, 80) } : {}),
    ...(typeof e.name === "string" ? { name: e.name.slice(0, 300) } : {}),
    ...(typeof e.text === "string" ? { text: e.text.slice(0, 500) } : {}),
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

function sanitizeRegion(raw: unknown): import("@polyth/contracts").BrowserContextRegion | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const normalizedRaw = r.normalized && typeof r.normalized === "object" && !Array.isArray(r.normalized)
    ? r.normalized as Record<string, unknown>
    : null;
  const pixels = sanitizeBounds(r.pixels);
  if (!normalizedRaw || !pixels) return undefined;
  const x = Number(normalizedRaw.x);
  const y = Number(normalizedRaw.y);
  const width = Number(normalizedRaw.width);
  const height = Number(normalizedRaw.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return undefined;
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  return {
    normalized: {
      x: clamp01(x),
      y: clamp01(y),
      width: clamp01(width),
      height: clamp01(height),
    },
    pixels,
  };
}

function sanitizeBrowserContext(raw: unknown, projectId: string): import("@polyth/contracts").BrowserContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("browser context required");
  }
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" && c.id.trim() && c.id.length <= 100 ? c.id : undefined;
  if (!id) throw invalid("browser context id required");
  const type = c.type;
  if (type !== "page" && type !== "element" && type !== "area" && type !== "text") {
    throw invalid("browser context type invalid");
  }
  const browserSessionId = typeof c.browserSessionId === "string" ? c.browserSessionId : "";
  if (!browserSessionId || browserSessionId.length > 100) throw invalid("browser session id required");
  const url = typeof c.url === "string" ? c.url.trim() : "";
  if (!url || url.length > URL_MAX) throw invalid("browser context url required");
  const title = typeof c.title === "string" ? c.title.slice(0, 500) : "";
  const frameRevision = Number(c.frameRevision);
  if (!Number.isSafeInteger(frameRevision) || frameRevision < 0) throw invalid("browser frame revision invalid");
  const viewportRaw = c.viewport && typeof c.viewport === "object" && !Array.isArray(c.viewport)
    ? c.viewport as Record<string, unknown>
    : null;
  const width = Number(viewportRaw?.width);
  const height = Number(viewportRaw?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw invalid("browser viewport invalid");
  }
  const capturedAt = typeof c.capturedAt === "string" && c.capturedAt ? c.capturedAt : new Date(0).toISOString();
  const artifact = (value: unknown) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw invalid("browser artifact invalid");
    const a = value as Record<string, unknown>;
    const artId = typeof a.id === "string" ? a.id : "";
    const mime = typeof a.mime === "string" ? a.mime : "";
    const size = Number(a.size);
    if (!artId || artId.length > 120 || !MIME_RE.test(mime) || !Number.isSafeInteger(size) || size < 0) {
      throw invalid("browser artifact invalid");
    }
    return { id: artId, mime, size };
  };
  const region = sanitizeRegion(c.region);
  const element = sanitizeElement(c.element);
  const intersecting = Array.isArray(c.intersecting)
    ? c.intersecting.slice(0, 12).map(sanitizeElement).filter((el): el is NonNullable<typeof el> => el !== undefined)
    : undefined;
  return {
    id,
    type,
    browserSessionId,
    projectId,
    ...(typeof c.sessionId === "string" && c.sessionId ? { sessionId: c.sessionId } : {}),
    frameRevision,
    url,
    title,
    viewport: { width, height },
    capturedAt,
    ...(typeof c.note === "string" && c.note.trim() ? { note: c.note.trim().slice(0, 2_000) } : {}),
    ...(typeof c.quote === "string" && c.quote.trim() ? { quote: c.quote.trim().slice(0, 4_000) } : {}),
    ...(typeof c.textSummary === "string" && c.textSummary
      ? { textSummary: c.textSummary.slice(0, 6_000) }
      : {}),
    ...(typeof c.accessibilitySummary === "string" && c.accessibilitySummary
      ? { accessibilitySummary: c.accessibilitySummary.slice(0, 2_000) }
      : {}),
    ...(typeof c.contentHash === "string" ? { contentHash: c.contentHash.slice(0, 64) } : {}),
    ...(region ? { region } : {}),
    ...(element ? { element } : {}),
    ...(intersecting && intersecting.length ? { intersecting } : {}),
    ...(artifact(c.screenshot) ? { screenshot: artifact(c.screenshot) } : {}),
    ...(artifact(c.crop) ? { crop: artifact(c.crop) } : {}),
  };
}
