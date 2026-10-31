// Google Drive v3 over the shared GoogleClient: search, read/export, upload,
// folder organization and sharing. Every call opts into shared drives and asks
// for an explicit `fields` mask, because Drive returns only id/name/mimeType
// by default.

import { randomBytes } from "node:crypto";
import { GoogleError, googleError } from "./http.ts";
import type { GoogleClient } from "./http.ts";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_UPLOAD_ORIGIN = "https://www.googleapis.com";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const APPS_PREFIX = "application/vnd.google-apps.";
const SHORTCUT_MIME = `${APPS_PREFIX}shortcut`;

const DEFAULT_READ_BYTES = 10 * 1024 * 1024;
const MULTIPART_LIMIT = 5 * 1024 * 1024;
const UPLOAD_LIMIT = 100 * 1024 * 1024;
const MAX_PERMISSION_PAGES = 50;

export type DriveFileKind =
  | "folder" | "document" | "spreadsheet" | "presentation" | "drawing"
  | "form" | "shortcut" | "google-other" | "file";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  kind: DriveFileKind;
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  owners?: Array<{ name?: string; email?: string }>;
  webViewLink?: string;
  trashed: boolean;
  starred: boolean;
  shared: boolean;
  driveId?: string;
  shortcutTargetId?: string;
  shortcutTargetMimeType?: string;
  canEdit?: boolean;
  canDownload?: boolean;
  canTrash?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  /** Export aliases accepted by `readContent` for Google Workspace files. */
  exportFormats?: string[];
}

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  expirationTime?: string;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
  incompleteSearch: boolean;
}

export interface DriveSearchInput {
  text?: string;
  name?: string;
  mimeType?: string;
  folderId?: string;
  sharedWithMe?: boolean;
  starred?: boolean;
  includeTrashed?: boolean;
  modifiedAfter?: string;
  query?: string;
  driveId?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  signal?: AbortSignal;
}

export interface DriveListInput {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  includeTrashed?: boolean;
  signal?: AbortSignal;
}

export interface DriveReadInput {
  fileId: string;
  format?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface DriveContent {
  file: DriveFile;
  mimeType: string;
  data: Uint8Array;
  exported: boolean;
  format?: string;
}

export interface DriveUploadInput {
  /** Required unless `fileId` is set. */
  name?: string;
  data: Uint8Array;
  mimeType: string;
  parentId?: string;
  description?: string;
  convertTo?: "document" | "spreadsheet" | "presentation";
  /** Replace the content of an existing file instead of creating one. */
  fileId?: string;
  signal?: AbortSignal;
}

export type DriveShareRole = "reader" | "commenter" | "writer" | "fileOrganizer" | "organizer";
export type DriveShareType = "user" | "group" | "domain" | "anyone";

export interface DriveShareInput {
  fileId: string;
  role: DriveShareRole;
  type: DriveShareType;
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
  emailMessage?: string;
  allowFileDiscovery?: boolean;
}

const FILE_FIELDS = [
  "id", "name", "mimeType", "size", "createdTime", "modifiedTime", "parents",
  "owners(displayName,emailAddress)", "webViewLink", "trashed", "starred", "shared", "driveId",
  "shortcutDetails(targetId,targetMimeType)",
  "capabilities(canEdit,canDownload,canTrash,canDelete,canShare)",
].join(",");
const LIST_FIELDS = `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`;
const PERMISSION_FIELDS = "id,type,role,emailAddress,domain,displayName,expirationTime,deleted";

// Export targets per Workspace kind, keyed by alias (see Drive "export formats").
const EXPORTS: Record<string, Record<string, string>> = {
  document: {
    markdown: "text/markdown",
    text: "text/plain",
    html: "text/html",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text",
    rtf: "application/rtf",
    epub: "application/epub+zip",
  },
  spreadsheet: {
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ods: "application/x-vnd.oasis.opendocument.spreadsheet",
  },
  presentation: {
    text: "text/plain",
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odp: "application/vnd.oasis.opendocument.presentation",
  },
  drawing: {
    png: "image/png",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  },
};
const ALIAS_SYNONYMS: Record<string, string> = { txt: "text", md: "markdown", jpg: "jpeg" };
// Spreadsheet CSV/TSV export covers the first sheet only.
const DEFAULT_EXPORT: Record<string, string> = {
  document: "markdown",
  spreadsheet: "csv",
  presentation: "text",
  drawing: "png",
};

const EXTENSIONS: Record<string, string> = {
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/rtf": ".rtf",
  "application/epub+zip": ".epub",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/x-vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
};

const ORDER_KEYS = new Set([
  "createdTime", "folder", "modifiedByMeTime", "modifiedTime", "name", "name_natural",
  "quotaBytesUsed", "recency", "sharedWithMeTime", "starred", "viewedByMeTime",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;
const DOMAIN_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const SHARE_ROLES = new Set(["reader", "commenter", "writer", "fileOrganizer", "organizer"]);
const SHARE_TYPES = new Set(["user", "group", "domain", "anyone"]);

const sig = (signal?: AbortSignal): { signal?: AbortSignal } => signal ? { signal } : {};

function checkId(value: unknown, label: string): string {
  if (typeof value !== "string" || !(value === "root" || ID_PATTERN.test(value))) {
    return googleError("invalid-request", `${label} is not a valid Drive id.`);
  }
  return value;
}

function checkName(value: unknown, label = "name"): string {
  if (typeof value !== "string" || !value.trim()) return googleError("invalid-request", `The Drive ${label} must not be empty.`);
  if (value.length > 255) return googleError("invalid-request", `The Drive ${label} must be at most 255 characters.`);
  if (/[\r\n]/.test(value)) return googleError("invalid-request", `The Drive ${label} must not contain line breaks.`);
  return value;
}

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function kindOf(mimeType: string): DriveFileKind {
  if (mimeType === DRIVE_FOLDER_MIME) return "folder";
  if (mimeType === SHORTCUT_MIME) return "shortcut";
  if (!mimeType.startsWith(APPS_PREFIX)) return "file";
  switch (mimeType.slice(APPS_PREFIX.length)) {
    case "document": return "document";
    case "spreadsheet": return "spreadsheet";
    case "presentation": return "presentation";
    case "drawing": return "drawing";
    case "form": return "form";
    default: return "google-other";
  }
}

interface RawFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  webViewLink?: string;
  trashed?: boolean;
  starred?: boolean;
  shared?: boolean;
  driveId?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  capabilities?: Record<string, boolean | undefined>;
}

function normalizeFile(raw: RawFile): DriveFile {
  const mimeType = raw.mimeType ?? "application/octet-stream";
  const kind = kindOf(mimeType);
  const size = raw.size === undefined ? undefined : Number(raw.size);
  const owners = (raw.owners ?? []).map((owner) => ({
    ...(owner.displayName ? { name: owner.displayName } : {}),
    ...(owner.emailAddress ? { email: owner.emailAddress } : {}),
  }));
  const caps = raw.capabilities ?? {};
  const exportAliases = EXPORTS[kind] ? Object.keys(EXPORTS[kind]!) : undefined;
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    mimeType,
    kind,
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
    ...(raw.createdTime ? { createdTime: raw.createdTime } : {}),
    ...(raw.modifiedTime ? { modifiedTime: raw.modifiedTime } : {}),
    ...(raw.parents?.length ? { parents: [...raw.parents] } : {}),
    ...(owners.length ? { owners } : {}),
    ...(raw.webViewLink ? { webViewLink: raw.webViewLink } : {}),
    trashed: raw.trashed === true,
    starred: raw.starred === true,
    shared: raw.shared === true,
    ...(raw.driveId ? { driveId: raw.driveId } : {}),
    ...(raw.shortcutDetails?.targetId ? { shortcutTargetId: raw.shortcutDetails.targetId } : {}),
    ...(raw.shortcutDetails?.targetMimeType ? { shortcutTargetMimeType: raw.shortcutDetails.targetMimeType } : {}),
    ...(typeof caps.canEdit === "boolean" ? { canEdit: caps.canEdit } : {}),
    ...(typeof caps.canDownload === "boolean" ? { canDownload: caps.canDownload } : {}),
    ...(typeof caps.canTrash === "boolean" ? { canTrash: caps.canTrash } : {}),
    ...(typeof caps.canDelete === "boolean" ? { canDelete: caps.canDelete } : {}),
    ...(typeof caps.canShare === "boolean" ? { canShare: caps.canShare } : {}),
    ...(exportAliases ? { exportFormats: exportAliases } : {}),
  };
}

function normalizePermission(raw: Record<string, unknown>): DrivePermission {
  const text = (key: string): string | undefined => typeof raw[key] === "string" && raw[key] ? raw[key] as string : undefined;
  return {
    id: text("id") ?? "",
    type: text("type") ?? "",
    role: text("role") ?? "",
    ...(text("emailAddress") ? { emailAddress: text("emailAddress")! } : {}),
    ...(text("domain") ? { domain: text("domain")! } : {}),
    ...(text("displayName") ? { displayName: text("displayName")! } : {}),
    ...(text("expirationTime") ? { expirationTime: text("expirationTime")! } : {}),
  };
}

/** A safe local filename for a downloaded or exported file. */
export function defaultFilenameFor(file: DriveFile, mimeType: string): string {
  let base = file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  if (!base || /^\.+$/.test(base)) base = "download";
  if (!EXPORTS[file.kind]) return base;
  const ext = EXTENSIONS[mimeType];
  if (!ext || base.toLowerCase().endsWith(ext)) return base;
  return `${base}${ext}`;
}

function resolveExport(kind: string, format: string | undefined): { alias: string; mimeType: string } {
  const table = EXPORTS[kind]!;
  const requested = format?.trim();
  if (!requested) {
    const alias = DEFAULT_EXPORT[kind]!;
    return { alias, mimeType: table[alias]! };
  }
  const lowered = requested.toLowerCase();
  const alias = ALIAS_SYNONYMS[lowered] ?? lowered;
  if (table[alias]) return { alias, mimeType: table[alias]! };
  const byMime = Object.entries(table).find(([, mime]) => mime === lowered);
  if (byMime) return { alias: byMime[0], mimeType: byMime[1] };
  return googleError(
    "invalid-request",
    `A Google ${kind} cannot be exported as "${requested}". Allowed formats: ${Object.keys(table).join(", ")}.`,
  );
}

function clampPageSize(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : 50;
  return Math.min(200, Math.max(1, n));
}

function validateOrderBy(orderBy: string): string {
  const parts = orderBy.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return googleError("invalid-request", "orderBy must not be empty.");
  for (const part of parts) {
    const match = /^([A-Za-z_]+)(?: desc)?$/.exec(part);
    if (!match || !ORDER_KEYS.has(match[1]!)) {
      return googleError("invalid-request", `Unsupported orderBy "${part}". Keys: ${[...ORDER_KEYS].join(", ")} (append " desc" to reverse).`);
    }
  }
  return parts.join(",");
}

function buildSearchQuery(input: DriveSearchInput): string {
  const terms: string[] = [];
  if (input.text) terms.push(`fullText contains ${quote(input.text)}`);
  if (input.name) terms.push(`name contains ${quote(input.name)}`);
  if (input.mimeType) terms.push(`mimeType = ${quote(input.mimeType)}`);
  if (input.folderId) terms.push(`${quote(checkId(input.folderId, "folderId"))} in parents`);
  if (input.sharedWithMe) terms.push("sharedWithMe = true");
  if (input.starred) terms.push("starred = true");
  if (input.modifiedAfter) {
    if (!RFC3339_PATTERN.test(input.modifiedAfter) || Number.isNaN(Date.parse(input.modifiedAfter))) {
      return googleError("invalid-request", "modifiedAfter must be an RFC 3339 timestamp such as 2026-01-31T00:00:00Z.");
    }
    terms.push(`modifiedTime > ${quote(input.modifiedAfter)}`);
  }
  if (!input.includeTrashed) terms.push("trashed = false");
  if (input.query?.trim()) terms.push(`(${input.query.trim()})`);
  return terms.join(" and ");
}

function multipartBody(metadata: unknown, data: Uint8Array, contentType: string): { body: Uint8Array; contentType: string } {
  let boundary = `polyth_${randomBytes(16).toString("hex")}`;
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  while (buffer.includes(boundary)) boundary = `polyth_${randomBytes(16).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { body: Buffer.concat([head, buffer, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

export function createDriveService(client: GoogleClient) {
  const fileUrl = (id: string, suffix = ""): string => `${DRIVE_BASE}/files/${id}${suffix}`;

  async function listFiles(query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<DriveFileList> {
    const response = await client.json<{ files?: RawFile[]; nextPageToken?: string; incompleteSearch?: boolean }>({
      url: `${DRIVE_BASE}/files`,
      query: { ...query, supportsAllDrives: true, includeItemsFromAllDrives: true, fields: LIST_FIELDS },
      ...sig(signal),
    });
    return {
      files: (response?.files ?? []).map(normalizeFile),
      ...(response?.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
      incompleteSearch: response?.incompleteSearch === true,
    };
  }

  async function get(fileId: string, opts: { signal?: AbortSignal } = {}): Promise<DriveFile> {
    const id = checkId(fileId, "fileId");
    const raw = await client.json<RawFile>({
      url: fileUrl(id),
      query: { supportsAllDrives: true, fields: FILE_FIELDS },
      ...sig(opts.signal),
    });
    return normalizeFile(raw ?? {});
  }

  async function search(input: DriveSearchInput = {}): Promise<DriveFileList> {
    const driveId = input.driveId ? checkId(input.driveId, "driveId") : undefined;
    return listFiles({
      q: buildSearchQuery(input),
      corpora: driveId ? "drive" : "allDrives",
      driveId,
      pageSize: clampPageSize(input.pageSize),
      pageToken: input.pageToken,
      orderBy: input.orderBy ? validateOrderBy(input.orderBy) : undefined,
    }, input.signal);
  }

  async function list(input: DriveListInput = {}): Promise<DriveFileList> {
    const folderId = checkId(input.folderId ?? "root", "folderId");
    const terms = [`${quote(folderId)} in parents`];
    if (!input.includeTrashed) terms.push("trashed = false");
    return listFiles({
      q: terms.join(" and "),
      corpora: "user",
      pageSize: clampPageSize(input.pageSize),
      pageToken: input.pageToken,
      orderBy: "folder,name_natural",
    }, input.signal);
  }

  async function readContent(input: DriveReadInput): Promise<DriveContent> {
    const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
    let file = await get(input.fileId, sig(input.signal));
    if (file.kind === "shortcut") {
      if (!file.shortcutTargetId) return googleError("invalid-request", "This Drive shortcut has no target to read.");
      file = await get(file.shortcutTargetId, sig(input.signal));
      if (file.kind === "shortcut") return googleError("invalid-request", "This Drive shortcut points to another shortcut; read the final target directly.");
    }
    if (file.kind === "folder" || file.kind === "form" || file.kind === "google-other") {
      return googleError("invalid-request", `"${file.name}" is a Google ${file.kind === "google-other" ? "app file" : file.kind} (${file.mimeType}) and cannot be downloaded.`);
    }
    const exportKind = EXPORTS[file.kind] ? file.kind : undefined;
    try {
      if (exportKind) {
        const target = resolveExport(exportKind, input.format);
        const response = await client.raw({
          url: fileUrl(file.id, "/export"),
          query: { mimeType: target.mimeType, supportsAllDrives: true },
          maxBytes,
          ...sig(input.signal),
        });
        return { file, mimeType: target.mimeType, data: response.body, exported: true, format: target.alias };
      }
      if (input.format?.trim()) {
        return googleError("invalid-request", `"${file.name}" is a binary file; format conversion applies only to Google Docs, Sheets, Slides and Drawings.`);
      }
      if (file.size !== undefined && file.size > maxBytes) {
        return googleError("too-large", `"${file.name}" is ${file.size} bytes, larger than the ${maxBytes}-byte read limit.`);
      }
      const response = await client.raw({
        url: fileUrl(file.id),
        query: { alt: "media", supportsAllDrives: true },
        maxBytes,
        ...sig(input.signal),
      });
      return { file, mimeType: file.mimeType, data: response.body, exported: false };
    } catch (error) {
      throw mapDownloadError(error, file);
    }
  }

  function mapDownloadError(error: unknown, file: DriveFile): unknown {
    if (!(error instanceof GoogleError)) return error;
    if (error.reason === "exportSizeLimitExceeded") {
      return new GoogleError("too-large", `"${file.name}" is too large to export: Google limits exported content to 10 MB. Try another format or download it from Drive.`, { status: error.status ?? 403, reason: error.reason });
    }
    if (error.reason === "fileNotDownloadable" || error.reason === "cannotDownloadAbusiveFile") {
      const why = error.reason === "cannotDownloadAbusiveFile"
        ? "Google flagged it as malware or abuse"
        : "its owner restricted downloads or Google does not allow downloading this file";
      return new GoogleError("permission-denied", `"${file.name}" cannot be downloaded: ${why}.`, { status: error.status ?? 403, reason: error.reason });
    }
    return error;
  }

  async function upload(input: DriveUploadInput): Promise<DriveFile> {
    const replacing = input.fileId !== undefined;
    const fileId = replacing ? checkId(input.fileId, "fileId") : undefined;
    if (!replacing || input.name !== undefined) checkName(input.name);
    if (!(input.data instanceof Uint8Array)) return googleError("invalid-request", "Upload data must be bytes.");
    if (input.data.byteLength > UPLOAD_LIMIT) {
      return googleError("too-large", `Uploads are limited to ${UPLOAD_LIMIT / 1024 / 1024} MiB; this file is ${input.data.byteLength} bytes.`);
    }
    if (typeof input.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) {
      return googleError("invalid-request", "Upload mimeType must look like type/subtype.");
    }
    if (input.description !== undefined && typeof input.description !== "string") return googleError("invalid-request", "description must be text.");
    const metadata: Record<string, unknown> = {};
    if (input.name !== undefined) metadata.name = input.name;
    if (input.description !== undefined) metadata.description = input.description;
    if (!replacing) {
      metadata.mimeType = input.convertTo ? `${APPS_PREFIX}${input.convertTo}` : input.mimeType;
      if (input.convertTo && !EXPORTS[input.convertTo]) return googleError("invalid-request", "convertTo must be document, spreadsheet or presentation.");
      if (input.parentId) metadata.parents = [checkId(input.parentId, "parentId")];
    }
    const method = replacing ? "PATCH" : "POST";
    const url = replacing ? `${UPLOAD_BASE}/files/${fileId}` : `${UPLOAD_BASE}/files`;
    const common = { supportsAllDrives: true, fields: FILE_FIELDS };

    if (input.data.byteLength <= MULTIPART_LIMIT) {
      const { body, contentType } = multipartBody(metadata, input.data, input.mimeType);
      const raw = await client.json<RawFile>({ method, url, query: { ...common, uploadType: "multipart" }, body, contentType, ...sig(input.signal) });
      return normalizeFile(raw ?? {});
    }

    const start = await client.raw({
      method,
      url,
      query: { ...common, uploadType: "resumable" },
      json: metadata,
      headers: {
        "x-upload-content-type": input.mimeType,
        "x-upload-content-length": String(input.data.byteLength),
      },
      ...sig(input.signal),
    });
    const location = start.headers.get("location") ?? "";
    let session: URL | undefined;
    try { session = new URL(location); } catch { session = undefined; }
    if (!session || session.origin !== GOOGLE_UPLOAD_ORIGIN) {
      return googleError("invalid-state", "Google did not return a usable upload session; nothing was uploaded.");
    }
    const done = await client.raw({
      method: "PUT",
      url: session.toString(),
      body: input.data,
      contentType: input.mimeType,
      timeoutMs: 10 * 60_000,
      ...sig(input.signal),
    });
    if (done.status !== 200 && done.status !== 201) {
      return googleError("mutation-outcome-unknown", `Google answered the upload with status ${done.status}; the file may be incomplete. Check Drive before retrying.`, { status: done.status });
    }
    try {
      return normalizeFile(JSON.parse(new TextDecoder().decode(done.body)) as RawFile);
    } catch {
      return googleError("mutation-outcome-unknown", "Google accepted the upload but returned an unreadable response. Check Drive before retrying.");
    }
  }

  async function patchFile(id: string, json: unknown, query: Record<string, string | number | boolean> = {}, signal?: AbortSignal): Promise<DriveFile> {
    const raw = await client.json<RawFile>({
      method: "PATCH",
      url: fileUrl(id),
      query: { ...query, supportsAllDrives: true, fields: FILE_FIELDS },
      json,
      ...sig(signal),
    });
    return normalizeFile(raw ?? {});
  }

  async function createFolder(input: { name: string; parentId?: string; signal?: AbortSignal }): Promise<DriveFile> {
    const name = checkName(input.name);
    const parents = input.parentId ? [checkId(input.parentId, "parentId")] : undefined;
    const raw = await client.json<RawFile>({
      method: "POST",
      url: `${DRIVE_BASE}/files`,
      query: { supportsAllDrives: true, fields: FILE_FIELDS },
      json: { name, mimeType: DRIVE_FOLDER_MIME, ...(parents ? { parents } : {}) },
      ...sig(input.signal),
    });
    return normalizeFile(raw ?? {});
  }

  async function move(input: { fileId: string; folderId: string; signal?: AbortSignal }): Promise<DriveFile> {
    const id = checkId(input.fileId, "fileId");
    const target = checkId(input.folderId, "folderId");
    const current = await get(id, sig(input.signal));
    const remove = (current.parents ?? []).filter((parent) => parent !== target);
    return patchFile(id, {}, { addParents: target, ...(remove.length ? { removeParents: remove.join(",") } : {}) }, input.signal);
  }

  async function copy(input: { fileId: string; name?: string; parentId?: string; signal?: AbortSignal }): Promise<DriveFile> {
    const id = checkId(input.fileId, "fileId");
    const name = input.name !== undefined ? checkName(input.name) : undefined;
    const parents = input.parentId ? [checkId(input.parentId, "parentId")] : undefined;
    const source = await get(id, sig(input.signal));
    if (source.kind === "folder") return googleError("invalid-request", "Drive cannot copy folders; create a folder and copy its files instead.");
    const raw = await client.json<RawFile>({
      method: "POST",
      url: fileUrl(id, "/copy"),
      query: { supportsAllDrives: true, fields: FILE_FIELDS },
      json: { ...(name ? { name } : {}), ...(parents ? { parents } : {}) },
      ...sig(input.signal),
    });
    return normalizeFile(raw ?? {});
  }

  async function rename(input: { fileId: string; name: string; signal?: AbortSignal }): Promise<DriveFile> {
    return patchFile(checkId(input.fileId, "fileId"), { name: checkName(input.name) }, {}, input.signal);
  }

  async function trash(input: { fileId: string; restore?: boolean; signal?: AbortSignal }): Promise<DriveFile> {
    return patchFile(checkId(input.fileId, "fileId"), { trashed: input.restore !== true }, {}, input.signal);
  }

  async function deletePermanently(fileId: string, opts: { signal?: AbortSignal } = {}): Promise<{ deleted: true }> {
    await client.raw({ method: "DELETE", url: fileUrl(checkId(fileId, "fileId")), query: { supportsAllDrives: true }, ...sig(opts.signal) });
    return { deleted: true };
  }

  async function listPermissions(fileId: string, opts: { signal?: AbortSignal } = {}): Promise<DrivePermission[]> {
    const id = checkId(fileId, "fileId");
    const out: DrivePermission[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
      const response = await client.json<{ permissions?: Array<Record<string, unknown>>; nextPageToken?: string }>({
        url: fileUrl(id, "/permissions"),
        query: {
          supportsAllDrives: true,
          pageSize: 100,
          pageToken,
          fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
        },
        ...sig(opts.signal),
      });
      for (const permission of response?.permissions ?? []) {
        if (permission.deleted === true) continue;
        out.push(normalizePermission(permission));
      }
      pageToken = response?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  async function share(input: DriveShareInput & { signal?: AbortSignal }): Promise<DrivePermission> {
    const id = checkId(input.fileId, "fileId");
    // Ownership transfer is deliberately not offered: only the listed roles are accepted.
    if (!SHARE_ROLES.has(input.role)) {
      return googleError("invalid-request", `Unsupported role "${String(input.role)}". Use reader, commenter, writer, fileOrganizer or organizer; ownership cannot be transferred.`);
    }
    if (!SHARE_TYPES.has(input.type)) return googleError("invalid-request", `Unsupported permission type "${String(input.type)}".`);
    const body: Record<string, unknown> = { role: input.role, type: input.type };
    const person = input.type === "user" || input.type === "group";
    if (person) {
      if (typeof input.emailAddress !== "string" || !EMAIL_PATTERN.test(input.emailAddress)) {
        return googleError("invalid-request", `Sharing with a ${input.type} needs a valid emailAddress.`);
      }
      body.emailAddress = input.emailAddress;
    } else if (input.type === "domain") {
      if (typeof input.domain !== "string" || !DOMAIN_PATTERN.test(input.domain)) {
        return googleError("invalid-request", "Sharing with a domain needs a valid domain such as example.com.");
      }
      body.domain = input.domain;
    }
    if (input.allowFileDiscovery !== undefined && (input.type === "domain" || input.type === "anyone")) {
      body.allowFileDiscovery = input.allowFileDiscovery;
    }
    const notify = person ? input.sendNotificationEmail !== false : false;
    if (input.emailMessage !== undefined) {
      if (!person || !notify) return googleError("invalid-request", "emailMessage can only be sent to a user or group with sendNotificationEmail on.");
      if (typeof input.emailMessage !== "string" || input.emailMessage.length > 2000) return googleError("invalid-request", "emailMessage must be text of at most 2000 characters.");
    }
    const raw = await client.json<Record<string, unknown>>({
      method: "POST",
      url: fileUrl(id, "/permissions"),
      query: {
        supportsAllDrives: true,
        fields: PERMISSION_FIELDS,
        ...(person ? { sendNotificationEmail: notify } : {}),
        ...(input.emailMessage !== undefined ? { emailMessage: input.emailMessage } : {}),
      },
      json: body,
      ...sig(input.signal),
    });
    return normalizePermission(raw ?? {});
  }

  async function unshare(input: { fileId: string; permissionId: string; signal?: AbortSignal }): Promise<{ removed: true }> {
    const id = checkId(input.fileId, "fileId");
    if (typeof input.permissionId !== "string" || !ID_PATTERN.test(input.permissionId)) {
      return googleError("invalid-request", "permissionId is not a valid Drive permission id.");
    }
    await client.raw({
      method: "DELETE",
      url: fileUrl(id, `/permissions/${input.permissionId}`),
      query: { supportsAllDrives: true },
      ...sig(input.signal),
    });
    return { removed: true };
  }

  return { search, list, get, readContent, upload, createFolder, move, copy, rename, trash, deletePermanently, listPermissions, share, unshare };
}

export type DriveService = ReturnType<typeof createDriveService>;
