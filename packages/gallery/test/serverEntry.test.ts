import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectService, RouteRequest, SessionService } from "@polyth/contracts";
import { galleryRoutes, listGalleryImages, type GalleryFileEntry, type GalleryFileService } from "../src/routes.ts";

function fakeFiles(entries: Record<string, GalleryFileEntry[]>): GalleryFileService {
  return {
    async tree(_root, opts) {
      const dir = opts?.path ?? "";
      return entries[dir] ?? [];
    },
  };
}

const file = (path: string, size = 100): GalleryFileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  dir: false,
  size,
});

const dir = (path: string): GalleryFileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  dir: true,
});

const files = fakeFiles({
  "": [dir("outputs"), file("readme.md", 10)],
  outputs: [file("outputs/frame_2.png", 200), file("outputs/frame_1.jpg", 150), file("outputs/notes.txt", 5), dir("outputs/raw")],
  "outputs/raw": [file("outputs/raw/hero.webp", 300)],
  node_modules: [file("node_modules/big.png", 999)],
});

test("listGalleryImages lists only images and immediate subfolders", async () => {
  const listing = await listGalleryImages(files, { root: "/repo", path: "", recursive: false });
  assert.equal(listing.path, "");
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.folders.map((entry) => entry.path), ["outputs"]);
  // readme.md is not an image, so a non-recursive root listing has none.
  assert.deepEqual(listing.images, []);
});

test("listGalleryImages recurses, sorts naturally, and skips heavy directories", async () => {
  const listing = await listGalleryImages(files, { root: "/repo", path: "", recursive: true, limit: 100 });
  assert.deepEqual(listing.images.map((entry) => entry.path), [
    "outputs/frame_1.jpg",
    "outputs/frame_2.png",
    "outputs/raw/hero.webp",
  ]);
  assert.equal(listing.truncated, false);
  assert.equal(listing.images.some((entry) => entry.path.includes("node_modules")), false);
});

test("listGalleryImages reports truncation at the bound", async () => {
  const listing = await listGalleryImages(files, { root: "/repo", path: "outputs", recursive: true, limit: 1 });
  assert.equal(listing.images.length, 1);
  assert.equal(listing.truncated, true);
});

const makeRequest = (query: string, projects: Partial<ProjectService>, sessions: Partial<SessionService>) => {
  let status = 0;
  let payload: unknown;
  const handler = galleryRoutes({
    files,
    projects: projects as ProjectService,
    sessions: sessions as SessionService,
  });
  const invoke = async () => {
    const handled = await handler({
      path: "/api/gallery/images",
      method: "GET",
      url: new URL(`https://polyth.test/api/gallery/images?${query}`),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };
  return invoke();
};

test("gallery route returns images for a project scoped to the Space", async () => {
  const projects = {
    get: async (id: string) => (id === "proj_owner" ? { id, path: "/repo", name: "repo" } : undefined),
  } as unknown as ProjectService;
  const sessions = { snapshot: async () => ({ projectId: "proj_owner" }) } as unknown as SessionService;
  const result = await makeRequest("projectId=proj_owner&path=outputs&recursive=false", projects, sessions);
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  const listing = result.payload as { images: Array<{ path: string }> };
  assert.deepEqual(listing.images.map((entry) => entry.path), ["outputs/frame_1.jpg", "outputs/frame_2.png"]);
});

test("gallery route refuses a project the Space cannot see", async () => {
  const projects = { get: async () => undefined } as unknown as ProjectService;
  const sessions = { snapshot: async () => ({ projectId: "proj_owner" }) } as unknown as SessionService;
  const result = await makeRequest("projectId=proj_foreign", projects, sessions);
  assert.equal(result.status, 400);
  assert.equal((result.payload as { error: string }).error, "not-found");
});

test("gallery route rejects an escaping folder path", async () => {
  const projects = {
    get: async (id: string) => ({ id, path: "/repo", name: "repo" }),
  } as unknown as ProjectService;
  const sessions = { snapshot: async () => ({ projectId: "proj_owner" }) } as unknown as SessionService;
  const result = await makeRequest("projectId=proj_owner&path=..%2Fsecrets", projects, sessions);
  assert.equal(result.status, 400);
  assert.equal((result.payload as { error: string }).error, "invalid-input");
});

test("gallery route requires a project id", async () => {
  const result = await makeRequest("", {} as ProjectService, {} as SessionService);
  assert.equal(result.status, 400);
  assert.equal((result.payload as { error: string }).error, "invalid-input");
});

const invokeRoute = async (
  route: ReturnType<typeof galleryRoutes>,
  query: string,
): Promise<{ status: number; payload: unknown }> => {
  let status = 0;
  let payload: unknown;
  await route({
    path: "/api/gallery/images",
    method: "GET",
    url: new URL(`https://polyth.test/api/gallery/images?${query}`),
    json: (code: number, body: unknown) => { status = code; payload = body; },
  } as unknown as RouteRequest);
  return { status, payload };
};

test("gallery route reads a session worktree root and rejects a missing worktree", async () => {
  const roots: string[] = [];
  const recordingFiles: GalleryFileService = {
    async tree(root) {
      roots.push(root);
      return [];
    },
  };
  const projects = {
    get: async (id: string) => ({ id, path: "/repo", name: "repo" }),
  } as unknown as ProjectService;
  const ready = {
    snapshot: async () => ({ projectId: "p", worktreePath: "/worktree", worktreeState: "ready" }),
  } as unknown as SessionService;
  const ok = await invokeRoute(
    galleryRoutes({ files: recordingFiles, projects, sessions: ready }),
    "projectId=p&sessionId=s&path=outputs",
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(roots, ["/worktree"]);

  const missing = {
    snapshot: async () => ({ projectId: "p", worktreePath: "/gone", worktreeState: "missing" }),
  } as unknown as SessionService;
  const gone = await invokeRoute(
    galleryRoutes({ files: recordingFiles, projects, sessions: missing }),
    "projectId=p&sessionId=s",
  );
  assert.equal(gone.status, 400);
  assert.equal((gone.payload as { error: string }).error, "not-found");
});
