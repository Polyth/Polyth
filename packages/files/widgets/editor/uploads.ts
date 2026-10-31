// Moving bytes in and out of the workspace from Files. Uploads (drop or
// picker): the server writes bytes as-is and would replace an existing file
// silently, so every name is checked first and replacing needs a yes.
// Downloads: single files through /api/files/raw, folders as a streamed zip.
import { api, type FileEntry } from "@polyth/session/web-api";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

/** Uploads travel base64 inside JSON: stay well under the 25 MiB body limit. */
export const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

export interface UploadOutcome {
  uploaded: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
}

export interface UploadRequest {
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  /** Repository-relative folder; "" is the repository root. */
  dir: string;
  files: readonly File[];
  /** Asked once with every name that already exists; false keeps those files. */
  confirmReplace: (names: readonly string[]) => Promise<boolean>;
  onProgress?: (done: number, total: number) => void;
  /** Localized per-file failure messages. */
  reasons: { tooLarge: string; isFolder: string; invalidName: string };
}

type FilesApi = Pick<typeof api, "filesStatOptional" | "filesUpload">;

export const joinPath = (dir: string, name: string): string => dir ? `${dir}/${name}` : name;

/** A single path segment a browser can hand us as a file name. */
export const validUploadName = (name: string): boolean =>
  name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);

export async function uploadIntoFolder(request: UploadRequest, files: FilesApi = api): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { uploaded: [], skipped: [], failed: [] };
  const sessionId = request.sessionId ?? undefined;
  const candidates: File[] = [];
  for (const file of request.files) {
    if (!validUploadName(file.name)) outcome.failed.push({ name: file.name, reason: request.reasons.invalidName });
    else if (file.size > MAX_UPLOAD_BYTES) outcome.failed.push({ name: file.name, reason: request.reasons.tooLarge });
    else candidates.push(file);
  }
  const existing = new Set<string>();
  for (const file of candidates) {
    const stat = await files.filesStatOptional(request.projectId, joinPath(request.dir, file.name), sessionId, request.repositoryId).catch(() => null);
    if (stat?.kind === "dir") outcome.failed.push({ name: file.name, reason: request.reasons.isFolder });
    else if (stat) existing.add(file.name);
  }
  const replace = existing.size > 0 ? await request.confirmReplace([...existing]) : false;
  const queue = candidates.filter((file) => !outcome.failed.some((entry) => entry.name === file.name));
  let done = 0;
  request.onProgress?.(done, queue.length);
  for (const file of queue) {
    if (existing.has(file.name) && !replace) {
      outcome.skipped.push(file.name);
    } else {
      const path = joinPath(request.dir, file.name);
      try {
        await files.filesUpload(request.projectId, path, new Uint8Array(await file.arrayBuffer()), sessionId, request.repositoryId);
        outcome.uploaded.push(path);
      } catch (error) {
        outcome.failed.push({ name: file.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    done += 1;
    request.onProgress?.(done, queue.length);
  }
  return outcome;
}

/** A same-origin link that saves the file instead of rendering it. */
export function downloadUrl(projectId: string, path: string, sessionId: string | null, repositoryId: string | undefined): string {
  return `${api.filesRawUrl(projectId, path, sessionId ?? undefined, repositoryId)}&download=1`;
}

export interface ArchiveScope {
  projectId: string;
  sessionId: string | null;
  repositoryId: string | undefined;
  /** Folder to pack ("" = repository root). */
  dir: string;
  hidden: boolean;
  skipIgnored: boolean;
}

export type ArchiveRefusal = "empty" | "too-many" | "too-large" | "file-too-large";

export interface ArchiveCheck {
  name: string;
  files: number;
  bytes: number;
  refusal: { reason: ArchiveRefusal; path?: string } | null;
}

function scopeQuery(scope: ArchiveScope): URLSearchParams {
  return new URLSearchParams({
    projectId: scope.projectId,
    ...(scope.dir ? { path: scope.dir } : {}),
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.repositoryId ? { repositoryId: scope.repositoryId } : {}),
    ...(scope.hidden ? { hidden: "true" } : {}),
    ...(scope.skipIgnored ? { ignored: "skip" } : {}),
  });
}

/** The streamed .zip of a folder (what the tree currently shows of it). */
export const archiveUrl = (scope: ArchiveScope): string => `/api/files/archive?${scopeQuery(scope)}`;

/** Ask first: a navigation download cannot show the server's refusal. */
export async function checkArchive(scope: ArchiveScope, fetcher: typeof fetch = fetch): Promise<ArchiveCheck> {
  const response = await fetcher(`/api/files/archive?${scopeQuery(scope)}&check=1`);
  const body = await response.json().catch(() => null) as ArchiveCheck & { error?: string } | null;
  if (!response.ok || !body) throw new Error(body?.error ?? tr("filetree.errArchiveCheck", { status: response.status }));
  return body;
}

export interface FlatListing { entries: FileEntry[]; truncated: boolean }

/** Every file under a folder in one request (the flat list view). */
export async function listFiles(
  scope: Omit<ArchiveScope, "skipIgnored">,
  fetcher: typeof fetch = fetch,
): Promise<FlatListing> {
  const response = await fetcher(`/api/files/list?${scopeQuery({ ...scope, skipIgnored: false })}`);
  const body = await response.json().catch(() => null) as (FlatListing & { error?: string }) | null;
  if (!response.ok || !body || !Array.isArray(body.entries)) throw new Error(body?.error ?? tr("filetree.errFileList", { status: response.status }));
  return { entries: body.entries, truncated: body.truncated === true };
}

export function triggerDownload(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
