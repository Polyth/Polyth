import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Project, ProjectService, ResumeTurnOptions, SessionService, UserTurnInput } from "@polyth/contracts";
import { createHttpServer, type RouteHandler } from "../src/http.ts";
import { assertGitRelativePath, gitRoutes } from "../../git/src/serverEntry.ts";
import { terminalRoutes } from "../../terminal/src/serverEntry.ts";
import { testTenancy } from "./support/spaces.ts";
import { readErrorDiagnostics } from "@polyth/contracts";

const tenancy = await testTenancy();

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
  if (path === "/api/probe/epoch") {
    throw Object.assign(
      new Error("runtime epoch requires proof of the destroyed binding"),
      { code: "epoch-proof-required" },
    );
  }
  if (path === "/api/probe/draft-conflict") {
    throw Object.assign(
      new Error("draft changed on another client"),
      { code: "draft-conflict" },
    );
  }
  if (path === "/api/probe/native") {
    throw Object.assign(
      new Error("Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)"),
      { code: "native-failure" },
    );
  }
  if (path === "/api/probe/runtime-rejected") {
    throw Object.assign(
      new Error("Codex rejected the request: failed to load configuration: invalid transport in `mcp_servers.x`"),
      { code: "runtime-rejected", mutationOutcome: "rejected", retryability: "never" },
    );
  }
  if (path === "/api/probe/memory-required") {
    throw Object.assign(new Error("memory is required before this turn can run"), { code: "memory-required" });
  }
  if (path === "/api/probe/enoent") {
    throw Object.assign(new Error("no such file or directory, lstat '/path/to/missing'"), { code: "ENOENT" });
  }
  if (path === "/api/probe/variant") {
    throw Object.assign(
      new Error("Haiku 4.5 does not offer a thinking level."),
      { code: "invalid-variant", mutationOutcome: "rejected", retryability: "never" },
    );
  }
  if (path === "/api/probe/git") {
    throw Object.assign(
      new Error("Updates were rejected because the remote contains work that you do not have locally"),
      { code: "git-failed", cause: "hint: fetch first" },
    );
  }
  return false;
};

const DIAGNOSTIC_KEYS = ["code", "component", "operation", "requestId", "retryability", "recovery", "mutationOutcome"] as const;

/** Every error response carries additive diagnostics (packages/contracts
 *  errorDiagnostics). The historic envelope (error/message/field) must stay
 *  exact around them, and the request id must match the response header. */
async function errorEnvelope(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  const diagnostics = readErrorDiagnostics(body);
  assert.equal(typeof diagnostics.component, "string", "error bodies carry a diagnostic component");
  assert.equal(diagnostics.requestId, response.headers.get("x-request-id"), "diagnostics carry the request id header");
  for (const key of DIAGNOSTIC_KEYS) delete body[key];
  return body;
}

async function start() {
  let gitDiffCalls = 0;
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
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-input-validation-")),
    version: "test",
    routes: [
      probeRoutes,
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

test("browser message submissions validate and forward the staged harness route", async () => {
  let received: UserTurnInput | undefined;
  const sessions = {
    list: async () => [],
    sync: async () => [],
    send: async (_sessionId: string, input: UserTurnInput) => {
      received = input;
      return { turnId: "turn-1" };
    },
  } as unknown as SessionService;
  const scoped = await testTenancy({ sessions: () => sessions });
  scoped.sessionOwners.own("s1", scoped.defaultContext.spaceId);
  const server = createHttpServer({
    sessions,
    spaces: scoped.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-message-route-")),
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const accepted = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      body: JSON.stringify({
        text: "run there",
        harness: { mode: "pinned", harnessId: "codex" },
      }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(received?.harness, { mode: "pinned", harnessId: "codex" });

    received = undefined;
    const invalid = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      body: JSON.stringify({
        text: "must not run",
        harness: { mode: "pinned", harnessId: "../escape" },
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(received, undefined);
  } finally {
    server.close();
  }
});

test("rate-limit resume validates and forwards its model plus harness route", async () => {
  let received: ResumeTurnOptions | undefined;
  const sessions = {
    resumeNow: async (_sessionId: string, options?: ResumeTurnOptions) => {
      received = options;
      return { turnId: "turn-1" };
    },
  } as unknown as SessionService;
  const scoped = await testTenancy({ sessions: () => sessions });
  scoped.sessionOwners.own("s1", scoped.defaultContext.spaceId);
  const server = createHttpServer({
    sessions,
    spaces: scoped.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-resume-route-")),
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const accepted = await fetch(`${base}/api/sessions/s1/resume/now`, {
      method: "POST",
      body: JSON.stringify({
        harness: { mode: "pinned", harnessId: "codex" },
        model: { providerID: "openai", modelID: "gpt-5.5-codex", variant: "high" },
      }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(received, {
      harness: { mode: "pinned", harnessId: "codex" },
      model: { providerID: "openai", modelID: "gpt-5.5-codex", variant: "high" },
    });

    received = undefined;
    const invalidModel = await fetch(`${base}/api/sessions/s1/resume/now`, {
      method: "POST",
      body: JSON.stringify({ model: { providerID: "", modelID: "gpt-5" } }),
    });
    assert.equal(invalidModel.status, 400);
    assert.equal(received, undefined);

    const invalidHarness = await fetch(`${base}/api/sessions/s1/resume/now`, {
      method: "POST",
      body: JSON.stringify({ harness: { mode: "pinned", harnessId: "../escape" } }),
    });
    assert.equal(invalidHarness.status, 400);
    assert.equal(received, undefined);
  } finally {
    server.close();
  }
});

test("invalid paths are sanitized 400s and internal faults alone use sanitized 500s", async () => {
  const app = await start();
  try {
    const invalid = await fetch(`${app.base}/api/probe/path`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await errorEnvelope(invalid), {
      error: "invalid-path",
      message: "The requested path is invalid.",
    });

    const enoent = await fetch(`${app.base}/api/probe/enoent`);
    assert.equal(enoent.status, 404);
    assert.deepEqual(await errorEnvelope(enoent), {
      error: "not-found",
      message: "no such file or directory, lstat '/path/to/missing'",
    });

    const internal = await fetch(`${app.base}/api/probe/internal`);
    assert.equal(internal.status, 500);
    assert.deepEqual(await errorEnvelope(internal), {
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
    assert.deepEqual(await errorEnvelope(response), {
      error: "unavailable",
      message: "opencode is not installed on dev@remote — install it there first",
    });
  } finally {
    app.server.close();
  }
});

test("failed git subprocesses are 422s that keep the git error, not masked 500s", async () => {
  const app = await start();
  try {
    // Source Control "Sync" (pull + push) must show the real git failure —
    // "Updates were rejected…" — instead of "An internal server error occurred."
    const response = await fetch(`${app.base}/api/probe/git`);
    assert.equal(response.status, 422);
    assert.deepEqual(await errorEnvelope(response), {
      error: "git-failed",
      message: "Updates were rejected because the remote contains work that you do not have locally",
    });
  } finally {
    app.server.close();
  }
});

test("a harness bridge refusal is a 502 that keeps the provider reason, not a masked 500", async () => {
  const app = await start();
  try {
    // "Reconnect" on the in-chat harness recovery card must show why the
    // provider said no, not "An internal server error occurred."
    const response = await fetch(`${app.base}/api/probe/native`);
    assert.equal(response.status, 502);
    assert.deepEqual(await errorEnvelope(response), {
      error: "native-failure",
      message: "Polyth agent-tools bridge failed to connect (Codex status: authenticationRequired)",
    });
  } finally {
    app.server.close();
  }
});

test("a runtime that rejected a mutation is a 502 with its reason, not a masked 500", async () => {
  const app = await start();
  try {
    // Creating a Codex session whose thread/start Codex refused must say why,
    // not "An internal server error occurred."
    const response = await fetch(`${app.base}/api/probe/runtime-rejected`, { method: "POST" });
    assert.equal(response.status, 502);
    const body = await response.json() as { error: string; message: string; component: string; mutationOutcome: string };
    assert.equal(body.error, "runtime-rejected");
    assert.equal(body.message, "Codex rejected the request: failed to load configuration: invalid transport in `mcp_servers.x`");
    assert.equal(body.component, "provider");
    assert.equal(body.mutationOutcome, "rejected");
  } finally {
    app.server.close();
  }
});

test("a thinking level the runtime does not offer is a 422 with its reason, not a masked 500", async () => {
  const app = await start();
  try {
    // Creating a Claude session with an effort level the CLI's own catalog
    // lacks must tell the user which selection to change, not "An internal
    // server error occurred." (the live symptom of a stale adapter catalog).
    const response = await fetch(`${app.base}/api/probe/variant`, { method: "POST" });
    assert.equal(response.status, 422);
    const body = await response.json() as { error: string; message: string; component: string; mutationOutcome: string };
    assert.equal(body.error, "invalid-variant");
    assert.equal(body.message, "Haiku 4.5 does not offer a thinking level.");
    assert.equal(body.component, "validation");
    assert.equal(body.mutationOutcome, "rejected");
  } finally {
    app.server.close();
  }
});

test("admission dependency failures are retryable 503s, not masked 500s", async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/probe/memory-required`);
    assert.equal(response.status, 503);
    assert.deepEqual(await errorEnvelope(response), {
      error: "memory-required",
      message: "memory is required before this turn can run",
    });
  } finally {
    app.server.close();
  }
});

test("runtime recovery and draft conflicts remain actionable instead of becoming internal errors", async () => {
  const app = await start();
  try {
    const response = await fetch(`${app.base}/api/probe/epoch`);
    assert.equal(response.status, 409);
    assert.deepEqual(await errorEnvelope(response), {
      error: "epoch-proof-required",
      message: "runtime epoch requires proof of the destroyed binding",
    });

    const draft = await fetch(`${app.base}/api/probe/draft-conflict`);
    assert.equal(draft.status, 409);
    assert.deepEqual(await errorEnvelope(draft), {
      error: "draft-conflict",
      message: "draft changed on another client",
    });
  } finally {
    app.server.close();
  }
});

test("unknown terminals are 404", async () => {
  const app = await start();
  try {
    const terminal = await fetch(`${app.base}/api/terminals/missing`, {
      method: "POST",
      body: JSON.stringify({ data: "echo nope\n" }),
    });
    assert.equal(terminal.status, 404);
    assert.deepEqual(await errorEnvelope(terminal), {
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
    assert.deepEqual(await errorEnvelope(response), {
      error: "invalid-path",
      message: "The requested path is invalid.",
    });
    assert.equal(app.gitDiffCalls, 0);
  } finally {
    app.server.close();
  }
});
