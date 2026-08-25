import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Project, ProjectService } from "@polyth/contracts";
import { createGoalService } from "@polyth/goals";
import { createHttpServer, type RouteHandler } from "../src/http.ts";
import { goalRoutes } from "../src/routes/goals.ts";
import { assertGitRelativePath, gitRoutes } from "../src/routes/git.ts";
import { terminalRoutes } from "../src/routes/terminal.ts";

const project: Project = { id: "p1", path: "/workspace/project", name: "project", createdAt: 1 };
const projects: ProjectService = {
  list: async () => [project],
  get: async (id) => id === project.id ? project : undefined,
  add: async () => project,
  create: async () => project,
  remove: async () => {},
};

const probeRoutes: RouteHandler = async ({ path, body, json }) => {
  if (path === "/api/probe/body") {
    json(200, await body());
    return true;
  }
  if (path === "/api/probe/path") {
    throw Object.assign(new Error("/workspace/private/repository escaped"), { code: "invalid-path" });
  }
  if (path === "/api/probe/internal") {
    throw new Error("database password and /workspace/private leaked");
  }
  if (path === "/api/probe/unavailable") {
    throw Object.assign(
      new Error("opencode is not installed on dev@remote — install it there first"),
      { code: "unavailable" },
    );
  }
  return false;
};

async function start() {
  let gitDiffCalls = 0;
  const goals = createGoalService({
    append: async () => {},
    send: async () => {},
    complete: async () => '{"verdict":"done"}',
  });
  const terminals = {
    get: () => undefined,
    write: () => { throw new Error("unknown terminal write must never run"); },
    onExit: () => ({ dispose() {} }),
  };
  const git = {
    diff: async () => {
      gitDiffCalls++;
      return { path: null, diff: "" };
    },
  };
  const server = createHttpServer({
    sessions: {} as never,
    projects,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-input-validation-")),
    version: "test",
    routes: [
      probeRoutes,
      goalRoutes(goals),
      terminalRoutes({ projects, sessions: {} as never, terminals: terminals as never }),
      gitRoutes({
        projects,
        sessions: {} as never,
        git: git as never,
        commitMessage: async () => "",
      }),
    ],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    get gitDiffCalls() { return gitDiffCalls; },
  };
}

test("malformed and non-object JSON are typed 400 responses", async () => {
  const app = await start();
  try {
    for (const raw of ["{broken", "[]", "null"]) {
      const response = await fetch(`${app.base}/api/probe/body`, { method: "POST", body: raw });
      assert.equal(response.status, 400);
      const result = await response.json() as { error: string; message: string };
      assert.equal(result.error, "invalid-json");
      assert.match(result.message, /valid JSON|JSON object/);
    }
  } finally {
    app.server.close();
  }
});

test("invalid paths are sanitized 400s and internal faults alone use sanitized 500s", async () => {
  const app = await start();
  try {
    const invalid = await fetch(`${app.base}/api/probe/path`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: "invalid-path",
      message: "The requested path is invalid.",
    });

    const internal = await fetch(`${app.base}/api/probe/internal`);
    assert.equal(internal.status, 500);
    assert.deepEqual(await internal.json(), {
      error: "internal",
      message: "An internal server error occurred.",
    });
  } finally {
    app.server.close();
  }
});

test("unavailable dependencies are honest 503s that keep their actionable message", async () => {
  const app = await start();
  try {
    // A remote-runtime failure (e.g. opencode missing on the SSH host) must
    // never surface as a masked 500 — the user needs the install guidance.
    const response = await fetch(`${app.base}/api/probe/unavailable`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "unavailable",
      message: "opencode is not installed on dev@remote — install it there first",
    });
  } finally {
    app.server.close();
  }
});

test("goal limit errors are 400 responses with a field and unknown terminals are 404", async () => {
  const app = await start();
  try {
    const goal = await fetch(`${app.base}/api/sessions/s1/goal`, {
      method: "POST",
      body: JSON.stringify({ objective: "ship", maxContinuations: -2 }),
    });
    assert.equal(goal.status, 400);
    assert.deepEqual(await goal.json(), {
      error: "invalid-input",
      message: "maxContinuations must be a finite positive integer",
      field: "maxContinuations",
    });

    const terminal = await fetch(`${app.base}/api/terminals/missing`, {
      method: "POST",
      body: JSON.stringify({ data: "echo nope\n" }),
    });
    assert.equal(terminal.status, 404);
    assert.deepEqual(await terminal.json(), {
      error: "not-found",
      message: "unknown terminal",
    });
  } finally {
    app.server.close();
  }
});

test("Git traversal is rejected before the Git service sees the path", async () => {
  assert.throws(
    () => assertGitRelativePath("../../secret"),
    (error: Error & { code?: string }) => error.code === "invalid-path",
  );
  assert.equal(assertGitRelativePath("src/../README.md"), "src/../README.md");

  const app = await start();
  try {
    const response = await fetch(
      `${app.base}/api/git/diff?projectId=p1&path=${encodeURIComponent("../../secret")}`,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "invalid-path",
      message: "The requested path is invalid.",
    });
    assert.equal(app.gitDiffCalls, 0);
  } finally {
    app.server.close();
  }
});
