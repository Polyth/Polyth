// Workspace file access for Google tools. Downloads land in a fixed
// `.polyth/downloads/google/` directory with a fresh name (never an
// agent-chosen path, never an overwrite); uploads and email attachments read
// one regular file that resolves inside the session's project directory.
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { googleError } from "./http.ts";

const DOWNLOAD_DIRS = [".polyth", ".polyth/downloads", ".polyth/downloads/google"];

// Credentials and repository internals never leave the machine through a
// Google upload or attachment, whatever the agent was asked to do.
const SENSITIVE_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".polyth", ".config"]);
const SENSITIVE_NAMES = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;

const isSensitivePath = (inside: string): boolean => {
  const parts = inside.split(sep);
  const downloads = parts.slice(0, 3).join("/") === ".polyth/downloads/google";
  return parts.some((part) => SENSITIVE_SEGMENTS.has(part.toLowerCase())) && !downloads
    || SENSITIVE_NAMES.test(parts.at(-1) ?? "");
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".html": "text/html", ".htm": "text/html", ".json": "application/json", ".xml": "application/xml",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf", ".ics": "text/calendar",
};

export const mimeTypeForName = (name: string): string =>
  MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Text-like content that can be returned to an agent inline. */
export const isTextMime = (mimeType: string): boolean =>
  /^text\//i.test(mimeType) || /^application\/(json|xml|csv|x-ndjson|javascript)\b/i.test(mimeType) || /\+(json|xml)\b/i.test(mimeType);

export function safeFileName(name: string, fallback = "download"): string {
  const clean = basename(String(name ?? "").replace(/[\\/]/g, "_"))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

/** Save bytes under `.polyth/downloads/google/` and return the project-relative path. */
export async function saveDownload(cwd: string, name: string, data: Uint8Array): Promise<{ path: string; bytes: number }> {
  if (!cwd || !isAbsolute(cwd)) return googleError("invalid-request", "Downloads need a session with a project directory.");
  const root = await realpath(cwd);
  for (const part of DOWNLOAD_DIRS) {
    const dir = resolve(root, part);
    try { await mkdir(dir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // A project-controlled symlink must never redirect a download outside the workspace.
    if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) {
      return googleError("permission-denied", "The download directory must stay inside the project.");
    }
  }
  // Downloaded mail and documents stay out of the project's version control.
  await writeFile(resolve(root, DOWNLOAD_DIRS.at(-1)!, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const fileName = `${randomBytes(4).toString("hex")}-${safeFileName(name)}`;
  const absolute = resolve(root, DOWNLOAD_DIRS.at(-1)!, fileName);
  await writeFile(absolute, data, { flag: "wx", mode: 0o600 });
  return { path: relative(root, absolute).split(sep).join("/"), bytes: data.byteLength };
}

/** Read one project file for upload or attachment. */
export async function readWorkspaceFile(cwd: string, path: string, maxBytes: number): Promise<{ name: string; mimeType: string; data: Uint8Array }> {
  if (!cwd || !isAbsolute(cwd)) return googleError("invalid-request", "Reading project files needs a session with a project directory.");
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) return googleError("invalid-request", "A project-relative file path is required.");
  const root = await realpath(cwd);
  let target: string;
  try {
    target = await realpath(resolve(root, path));
  } catch {
    return googleError("not-found", `File not found in the project: ${path}`);
  }
  const inside = relative(root, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return googleError("permission-denied", `Only files inside the project can be sent: ${path}`);
  }
  if (isSensitivePath(inside)) {
    return googleError("permission-denied", `${path} looks like a credential or repository-internal file and cannot be sent to Google.`);
  }
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return googleError("invalid-request", `Not a regular file: ${path}`);
    if (stat.size > maxBytes) {
      return googleError("too-large", `${path} is ${Math.ceil(stat.size / 1024 / 1024)} MiB; the limit is ${Math.floor(maxBytes / 1024 / 1024)} MiB.`);
    }
    const data = new Uint8Array(await handle.readFile());
    const name = basename(target);
    return { name, mimeType: mimeTypeForName(name), data };
  } finally {
    await handle.close();
  }
}
