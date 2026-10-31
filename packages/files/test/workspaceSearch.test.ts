import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectService, RouteRequest, SessionService } from "@polyth/contracts";
import { createFileService } from "../src/index.ts";
import { FILES_REMOTE_ACCESS, workspaceRoutes } from "../src/serverEntry.ts";

test("workspace content search route scopes project and session roots", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "polyth-workspace-search-"));
  const sessionRoot = await mkdtemp(path.join(tmpdir(), "polyth-workspace-search-session-"));
  try {
    await writeFile(path.join(projectRoot, "project.txt"), "needle");
    await writeFile(path.join(sessionRoot, "worktree.txt"), "before\nneedle\nafter");
    const projects = {
      get: async (id: string) => id === "p1" ? { id, path: projectRoot, name: "repo" } : undefined,
    } as unknown as ProjectService;
    const sessions = {
      snapshot: async () => ({ projectId: "p1", worktreePath: sessionRoot, worktreeState: "ready" }),
    } as unknown as SessionService;
    const route = workspaceRoutes({ projects, sessions, files: createFileService() });
    let payload: unknown;
    const handled = await route({
      path: "/api/files/search-content",
      method: "GET",
      url: new URL("https://polyth.test/api/files/search-content?projectId=p1&sessionId=s1&q=needle"),
      json: (_code: number, body: unknown) => { payload = body; },
    } as unknown as RouteRequest);
    assert.equal(handled, true);
    assert.deepEqual(payload, { hits: [{ path: "worktree.txt", line: 2, column: 1, preview: "needle" }], truncated: false });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("workspace content search is advertised as a read-only files route", () => {
  const rule = FILES_REMOTE_ACCESS.http.find((entry) => entry.path === "/api/files/search-content");
  assert.deepEqual(rule && { methods: rule.methods, capability: rule.capability, mutation: rule.mutation }, {
    methods: ["GET"],
    capability: "files.read",
    mutation: false,
  });
});

test("workspace content search selects only a validated repository checkout", async () => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), "polyth-workspace-search-first-"));
  const secondRoot = await mkdtemp(path.join(tmpdir(), "polyth-workspace-search-second-"));
  try {
    await writeFile(path.join(secondRoot, "other.txt"), "needle");
    const projects = {
      get: async (id: string) => id === "p1" ? {
        id,
        path: firstRoot,
        name: "repo",
        repositories: [
          { id: "first", alias: "first", path: firstRoot },
          { id: "second", alias: "second", path: secondRoot },
        ],
        primaryRepositoryId: "first",
      } : undefined,
    } as unknown as ProjectService;
    const sessions = {
      snapshot: async () => ({
        id: "s1",
        projectId: "p1",
        workspace: { repositories: [{ repositoryId: "second", path: secondRoot }] },
      }),
    } as unknown as SessionService;
    const route = workspaceRoutes({ projects, sessions, files: createFileService() });
    let payload: unknown;
    await route({
      path: "/api/files/search-content",
      method: "GET",
      url: new URL("https://polyth.test/api/files/search-content?projectId=p1&sessionId=s1&repositoryId=second&q=needle"),
      json: (_code: number, body: unknown) => { payload = body; },
    } as unknown as RouteRequest);
    assert.deepEqual(payload, { hits: [{ path: "other.txt", line: 1, column: 1, preview: "needle" }], truncated: false });
    await assert.rejects(
      route({
        path: "/api/files/search-content",
        method: "GET",
        url: new URL("https://polyth.test/api/files/search-content?projectId=p1&sessionId=s1&repositoryId=first&q=needle"),
        json: () => {},
      } as unknown as RouteRequest),
      (err: { code?: string }) => err.code === "not-found",
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("_inbox keeps omitted and explicit primary uploads on project staging root", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "polyth-inbox-project-"));
  const primaryRoot = await mkdtemp(path.join(tmpdir(), "polyth-inbox-primary-"));
  const secondaryRoot = await mkdtemp(path.join(tmpdir(), "polyth-inbox-secondary-"));
  try {
    const projects = {
      get: async (id: string) => id === "p1" ? {
        id,
        path: projectRoot,
        name: "repo",
        repositories: [
          { id: "primary", alias: "repo", path: projectRoot },
          { id: "secondary", alias: "secondary", path: secondaryRoot },
        ],
        primaryRepositoryId: "primary",
      } : undefined,
    } as unknown as ProjectService;
    const sessions = {
      snapshot: async () => ({
        id: "s1",
        projectId: "p1",
        worktreePath: primaryRoot,
        workspace: {
          repositories: [
            { repositoryId: "primary", path: primaryRoot },
            { repositoryId: "secondary", path: secondaryRoot },
          ],
        },
      }),
    } as unknown as SessionService;
    const route = workspaceRoutes({ projects, sessions, files: createFileService() });
    const upload = async (pathName: string, content: string, repositoryId?: string) => {
      await route({
        path: "/api/files/upload",
        method: "POST",
        body: async () => ({
          projectId: "p1",
          sessionId: "s1",
          path: pathName,
          base64: Buffer.from(content).toString("base64"),
          ...(repositoryId ? { repositoryId } : {}),
        }),
        json: () => {},
      } as unknown as RouteRequest);
    };
    await upload("_inbox/omitted.txt", "omitted");
    await upload("_inbox/primary.txt", "primary", "primary");
    await upload("_inbox/secondary.txt", "secondary", "secondary");
    assert.equal(await readFile(path.join(projectRoot, "_inbox/omitted.txt"), "utf8"), "omitted");
    assert.equal(await readFile(path.join(projectRoot, "_inbox/primary.txt"), "utf8"), "primary");
    await assert.rejects(() => readFile(path.join(primaryRoot, "_inbox/primary.txt")));
    assert.equal(await readFile(path.join(secondaryRoot, "_inbox/secondary.txt"), "utf8"), "secondary");
  } finally {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(primaryRoot, { recursive: true, force: true }),
      rm(secondaryRoot, { recursive: true, force: true }),
    ]);
  }
});
