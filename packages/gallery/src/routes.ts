// Pure gallery route logic. Kept free of @polyth/plugins value imports so it
// can be unit-tested without a full workspace install; serverEntry.ts binds it
// to the package lifecycle.
import type {
  ProjectService,
  RouteHandler,
  RouteRequest,
  SessionService,
} from "@polyth/contracts";
import {
  GALLERY_MAX_IMAGES,
  imageMimeOf,
  isImagePath,
  normalizeGalleryPath,
  parentGalleryPath,
  type GalleryFolder,
  type GalleryImage,
  type GalleryListing,
} from "./shared.ts";

/** Structural subset of the files package's FileService. Typing the seam
 *  locally keeps this package free of a runtime dependency on @polyth/files. */
export interface GalleryFileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

export interface GalleryFileService {
  tree(root: string, opts?: { path?: string; hidden?: boolean }): Promise<GalleryFileEntry[]>;
}

export interface GalleryRoutesDeps {
  files: GalleryFileService;
  projects: ProjectService;
  sessions: SessionService;
}

/** Directories that never contain the user's generated images and can be
 *  enormous; skipping them keeps a recursive scan bounded and fast. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
]);

const MAX_DIRECTORIES_SCANNED = 400;
const DEFAULT_LIMIT = GALLERY_MAX_IMAGES;

const routeError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

async function rootOf(
  deps: Pick<GalleryRoutesDeps, "projects" | "sessions">,
  projectId: string,
  sessionId: string | null,
): Promise<string> {
  const project = await deps.projects.get(projectId);
  if (!project) throw routeError("not-found", "unknown project");
  if (!sessionId) return project.path;
  const session = await deps.sessions.snapshot(sessionId);
  if (session.projectId !== projectId) {
    throw routeError("invalid-input", "session does not belong to this project");
  }
  if (session.worktreeState === "missing") {
    throw routeError("not-found", "session worktree is missing");
  }
  return session.worktreePath ?? project.path;
}

export interface ListGalleryInput {
  root: string;
  /** Normalized project-relative folder. */
  path: string;
  recursive: boolean;
  limit?: number;
}

/** Breadth-first scan of one project folder, returning only image files plus
 *  the immediate subfolders needed for the in-widget picker. */
export async function listGalleryImages(
  files: GalleryFileService,
  input: ListGalleryInput,
): Promise<GalleryListing> {
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), 2000);
  const folders: GalleryFolder[] = [];
  const images: GalleryImage[] = [];
  const queue: string[] = [input.path];
  let truncated = false;
  let scanned = 0;

  while (queue.length > 0) {
    const dir = queue.shift()!;
    scanned += 1;
    if (scanned > MAX_DIRECTORIES_SCANNED) {
      truncated = true;
      break;
    }
    let entries: GalleryFileEntry[];
    try {
      entries = await files.tree(input.root, dir ? { path: dir } : undefined);
    } catch {
      // An unreadable subdirectory is skipped; the rest of the gallery stays usable.
      continue;
    }
    for (const entry of entries) {
      if (entry.dir) {
        if (dir === input.path) folders.push({ name: entry.name, path: entry.path });
        if (input.recursive && !SKIPPED_DIRECTORIES.has(entry.name)) queue.push(entry.path);
        continue;
      }
      if (!isImagePath(entry.path)) continue;
      if (images.length >= limit) {
        truncated = true;
        break;
      }
      images.push({
        name: entry.name,
        path: entry.path,
        size: entry.size ?? 0,
        mime: imageMimeOf(entry.path) ?? "application/octet-stream",
      });
    }
    if (truncated) break;
  }

  folders.sort((left, right) => left.name.localeCompare(right.name));
  images.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));

  return {
    path: input.path,
    parent: input.path ? parentGalleryPath(input.path) : null,
    folders,
    images,
    truncated,
  };
}

function respondError(rc: RouteRequest, error: unknown): void {
  const code = (error as { code?: unknown })?.code;
  const mapped = typeof code === "string" ? code : "unknown";
  const status = mapped === "not-found" || mapped === "invalid-input" ? 400 : 500;
  rc.json(status, {
    error: mapped,
    message: error instanceof Error ? error.message : "gallery request failed",
  });
}

export function galleryRoutes(deps: GalleryRoutesDeps): RouteHandler {
  return async (rc) => {
    if (rc.path !== "/api/gallery/images" || rc.method !== "GET") return false;
    const projectId = rc.url.searchParams.get("projectId") ?? "";
    if (!projectId) {
      rc.json(400, { error: "invalid-input", message: "projectId required" });
      return true;
    }
    const folder = normalizeGalleryPath(rc.url.searchParams.get("path"));
    if (folder === null) {
      rc.json(400, { error: "invalid-input", message: "folder path is not a safe project-relative path" });
      return true;
    }
    const sessionId = rc.url.searchParams.get("sessionId");
    const recursive = rc.url.searchParams.get("recursive") !== "false";
    const requestedLimit = Number(rc.url.searchParams.get("limit"));
    try {
      const root = await rootOf(deps, projectId, sessionId || null);
      const listing = await listGalleryImages(deps.files, {
        root,
        path: folder,
        recursive,
        ...(Number.isFinite(requestedLimit) && requestedLimit > 0 ? { limit: requestedLimit } : {}),
      });
      rc.json(200, listing);
    } catch (error) {
      respondError(rc, error);
    }
    return true;
  };
}
