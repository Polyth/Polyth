// Managed browser capture artifacts live under the Polyth data dir — never in
// the user's project worktree / git status.
// Draft captures are TTL/cap pruned and deletable. Once a message send commits
// them, they stay until explicitly unused by history — rewind/fork chips must
// not delete evidence that still belongs to a sent message.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContextArtifactRef } from "@polyth/contracts";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

export const BROWSER_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_ARTIFACT_MAX_FILES = 200;
const ARTIFACT_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.(jpg|jpeg|png|webp|bin)$/;
const EXTS = ["jpg", "jpeg", "png", "webp", "bin"] as const;

export interface BrowserArtifactStore {
  dir: string;
  write(data: Uint8Array, mime: string, preferredId?: string): Promise<BrowserContextArtifactRef>;
  read(id: string): Promise<{ data: Uint8Array; mime: string; size: number; localPath: string } | null>;
  resolve(id: string): Promise<BrowserContextArtifactRef | null>;
  /** Delete a draft capture. Committed/message-owned files are left in place. */
  remove(id: string): Promise<boolean>;
  /** Promote draft captures to durable message-owned storage. */
  commit(ids: ReadonlyArray<string>): Promise<void>;
}

const extForMime = (mime: string): string => {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
};

const mimeForExt = (ext: string): string => {
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
};

export function createBrowserArtifactStore(dir: string, opts?: {
  ttlMs?: number;
  maxFiles?: number;
}): BrowserArtifactStore {
  const ttlMs = opts?.ttlMs ?? BROWSER_ARTIFACT_TTL_MS;
  const maxFiles = opts?.maxFiles ?? BROWSER_ARTIFACT_MAX_FILES;
  const draftDir = join(dir, "draft");
  const committedDir = join(dir, "committed");

  const ensure = async () => {
    await mkdir(dir, { recursive: true });
    await mkdir(draftDir, { recursive: true });
    await mkdir(committedDir, { recursive: true });
  };

  const draftPath = (id: string, mime: string): string =>
    join(draftDir, `${id}.${extForMime(mime)}`);

  const findExisting = async (id: string): Promise<{ path: string; ext: string; area: "draft" | "committed" } | null> => {
    for (const ext of EXTS) {
      const draft = join(draftDir, `${id}.${ext}`);
      try {
        const info = await stat(draft);
        if (info.isFile()) return { path: draft, ext, area: "draft" };
      } catch { /* try committed */ }
    }
    for (const ext of EXTS) {
      const committed = join(committedDir, `${id}.${ext}`);
      try {
        const info = await stat(committed);
        if (info.isFile()) return { path: committed, ext, area: "committed" };
      } catch { /* try legacy root */ }
    }
    for (const ext of EXTS) {
      const legacy = join(dir, `${id}.${ext}`);
      try {
        const info = await stat(legacy);
        if (info.isFile()) return { path: legacy, ext, area: "committed" };
      } catch { /* try next */ }
    }
    return null;
  };

  const pruneDrafts = async () => {
    let names: string[];
    try {
      names = await readdir(draftDir);
    } catch {
      return;
    }
    const files: Array<{ path: string; mtime: number }> = [];
    for (const name of names) {
      if (!ARTIFACT_FILE_RE.test(name)) continue;
      const full = join(draftDir, name);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        files.push({ path: full, mtime: info.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    const cutoff = Date.now() - ttlMs;
    const stale = files.filter((file) => file.mtime < cutoff);
    const remaining = files.filter((file) => file.mtime >= cutoff);
    const overflow = remaining.length > maxFiles
      ? remaining.slice(0, remaining.length - maxFiles)
      : [];
    for (const file of [...stale, ...overflow]) {
      await unlink(file.path).catch(() => undefined);
    }
  };

  return {
    dir,
    async write(data, mime, preferredId) {
      await ensure();
      const id = preferredId && ID_RE.test(preferredId) ? preferredId : randomUUID();
      const localPath = draftPath(id, mime);
      await writeFile(localPath, data);
      await pruneDrafts().catch(() => undefined);
      return { id, mime, size: data.byteLength, localPath };
    },
    async read(id) {
      if (!ID_RE.test(id)) return null;
      await ensure();
      const found = await findExisting(id);
      if (!found) return null;
      const data = await readFile(found.path);
      return { data, mime: mimeForExt(found.ext), size: data.byteLength, localPath: found.path };
    },
    async resolve(id) {
      const found = await this.read(id);
      if (!found) return null;
      return { id, mime: found.mime, size: found.size, localPath: found.localPath };
    },
    async remove(id) {
      if (!ID_RE.test(id)) return false;
      await ensure();
      let removed = false;
      for (const ext of EXTS) {
        try {
          await unlink(join(draftDir, `${id}.${ext}`));
          removed = true;
        } catch {
          // absent draft is fine — committed files are intentionally retained
        }
      }
      return removed;
    },
    async commit(ids) {
      await ensure();
      for (const id of ids) {
        if (!ID_RE.test(id)) continue;
        for (const ext of EXTS) {
          const from = join(draftDir, `${id}.${ext}`);
          const to = join(committedDir, `${id}.${ext}`);
          try {
            await rename(from, to);
          } catch {
            // already committed, missing, or never a draft
          }
        }
      }
    },
  };
}

export function contentHashFor(parts: Array<string | undefined>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part ?? "");
  return hash.digest("hex").slice(0, 24);
}

export function isBrowserArtifactId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}
