import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectService, SessionProjection, SessionService } from "@polyth/contracts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { terminalRoutes } from "../src/serverEntry.ts";
import type { TerminalService } from "../src/index.ts";

function harness(session?: SessionProjection, spaceRoot = "/space", repositoryPaths = { primary: "/repo", api: "/api" }) {
  const creates: Array<Record<string, unknown>> = [];
  const terminals = {
    onExit: () => ({ dispose() {} }),
    create: async (input: Record<string, unknown>) => { creates.push(input); return { id: "term-1" }; },
    get: () => undefined,
    list: () => [],
  } as unknown as TerminalService;
  const routes = terminalRoutes({
    projects: {
      get: async (id: string) => id === "p1" ? {
        id, name: "Project", path: repositoryPaths.primary,
        repositories: [
          { id: "primary", alias: "Project", path: repositoryPaths.primary },
          { id: "api", alias: "API", path: repositoryPaths.api },
        ],
        primaryRepositoryId: "primary",
      } : undefined,
    } as unknown as ProjectService,
    sessions: { snapshot: async () => session } as unknown as SessionService,
    terminals,
    spaceStorage: () => ({ root: spaceRoot, packageDir: (id: string) => join(spaceRoot, id), path: (relative: string) => join(spaceRoot, relative) }),
  });
  return { creates, routes };
}

test("Terminal resolves an explicit repository checkout", async () => {
  const h = harness();
  let payload: unknown;
  await h.routes({
    req: {}, res: {}, space: { userId: "u1" }, url: new URL("http://x/api/terminals"), path: "/api/terminals", method: "POST",
    body: async () => ({ projectId: "p1", repositoryId: "api", cmd: "true" }), json: (_status: number, data: unknown) => { payload = data; },
  } as never);
  assert.deepEqual(h.creates[0], { projectId: "p1", cwd: "/api", cmd: "true", repositoryId: "api" });
  assert.deepEqual(payload, { terminalId: "term-1" });
});

test("Terminal rejects excluded repository context and preserves legacy cwd", async () => {
  const isolated: SessionProjection = {
    id: "s1", projectId: "p1", title: "Session", status: "idle", createdAt: 1, updatedAt: 1,
    worktreePath: "/checkout",
    workspace: { repositories: [{ repositoryId: "primary", path: "/checkout" }] },
  };
  const h = harness(isolated);
  await assert.rejects(() => h.routes({
    req: {}, res: {}, space: { userId: "u1" }, url: new URL("http://x/api/terminals"), path: "/api/terminals", method: "POST",
    body: async () => ({ projectId: "p1", sessionId: "s1", repositoryId: "api" }), json: () => {},
  } as never), { code: "not-found" });
  const legacy = harness();
  await legacy.routes({
    req: {}, res: {}, space: { userId: "u1" }, url: new URL("http://x/api/terminals"), path: "/api/terminals", method: "POST",
    body: async () => ({ projectId: "p1", repositoryId: "primary", cmd: "true" }), json: () => {},
  } as never);
  assert.equal(legacy.creates[0]?.cwd, "/repo");
});

test("Terminal defaults multi-repository projects to a Space-private composite workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-route-"));
  mkdirSync(join(root, "app")); mkdirSync(join(root, "api")); mkdirSync(join(root, "space"));
  const h = harness(undefined, join(root, "space"), { primary: join(root, "app"), api: join(root, "api") });
  await h.routes({ req: {}, res: {}, space: { userId: "u1" }, url: new URL("http://x/api/terminals"), path: "/api/terminals", method: "POST", body: async () => ({ projectId: "p1" }), json: () => {} } as never);
  assert.equal((h.creates[0]?.workspace as { kind?: string } | undefined)?.kind, "composite");
  assert.equal((h.creates[0]?.cwd as string).startsWith(join(root, "space")), true);
  rmSync(root, { recursive: true, force: true });
});
