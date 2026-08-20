// Drag-and-drop helpers: the polyth path mime carries tree→composer drags;
// desktop-file drops upload through the binary API and become attachment pills.
import { api } from "./api.ts";
import { attachProjectFile, attachUpload } from "./attachments.ts";

export const PATH_MIME = "application/x-polyth-path";

interface DataLike {
  setData(type: string, value: string): void;
  getData(type: string): string;
}

export function setDragPath(dt: DataLike, path: string): void {
  dt.setData(PATH_MIME, path);
  dt.setData("text/plain", `@${path}`);
}

export function getDragPath(dt: DataLike): string | null {
  return dt.getData(PATH_MIME) || null;
}

/** What a dragover carries: a tree path, desktop files, or nothing we accept. */
export function dragKind(dt: { types: readonly string[] }): "path" | "files" | null {
  if (dt.types.includes(PATH_MIME)) return "path";
  if (dt.types.includes("Files")) return "files";
  return null;
}

/** Upload dropped desktop files into `dir` ("" = project root); returns their rel paths. */
export async function uploadFiles(
  projectId: string,
  dir: string,
  files: Iterable<File>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    const rel = dir ? `${dir}/${f.name}` : f.name;
    await api.filesUpload(projectId, rel, new Uint8Array(await f.arrayBuffer()));
    paths.push(rel);
  }
  return paths;
}

/** Drop onto the session: tree drags become pills directly; desktop files
 *  upload into _inbox/ first, then attach. Failures are reported per-file. */
export async function dropIntoSession(
  dt: DataTransfer,
  projectId: string,
  sessionId: string | null,
  onError?: (reason: string) => void,
): Promise<void> {
  const p = getDragPath(dt);
  if (p) {
    const r = await attachProjectFile(projectId, sessionId, p);
    if (!r.ok) onError?.(r.reason);
    return;
  }
  for (const f of Array.from(dt.files)) {
    const r = await attachUpload(projectId, sessionId, f);
    if (!r.ok) onError?.(r.reason);
  }
}
