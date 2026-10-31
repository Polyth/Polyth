import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ProjectRemote, ProjectService, SpaceContext } from "@polyth/contracts";
import { createSshService, type SshExecResult, type SshRunner } from "@polyth/ssh";
import type { RouteRequest } from "../../server/src/http.ts";
import { createProjectService } from "../../server/src/projects.ts";
import { sshRoutes } from "../src/serverEntry.ts";

/** Scriptable fake `ssh` binary (same routing as the package tests). */
function fakeRunner(dial: (command: string, dest: string) => SshExecResult) {
  const runner: SshRunner = async (args) => {
    const opIndex = args.indexOf("-O");
    if (opIndex >= 0) {
      const op = args[opIndex + 1]!;
      return { code: op === "check" ? 1 : 0, stdout: "", stderr: "" };
    }
    return dial(args[args.length - 1]!, args[args.length - 2]!);
  };
  return runner;
}

function fakeProjects(): ProjectService & { items: Project[] } {
  const items: Project[] = [];
  return {
    items,
    list: async () => [...items],
    get: async (id) => items.find((p) => p.id === id),
    add: async () => { throw new Error("unused"); },
    create: async () => { throw new Error("unused"); },
    remove: async (id) => { const i = items.findIndex((p) => p.id === id); if (i >= 0) items.splice(i, 1); },
    async addRemote(path: string, remote: ProjectRemote, name?: string) {
      const existing = items.find((p) => p.path === path && p.remote?.connectionId === remote.connectionId);
      if (existing) return existing;
      const project: Project = {
        id: `proj_${items.length + 1}`, path, name: name ?? path, createdAt: 1, remote,
      };
      items.push(project);
      return project;
    },
  };
}

const TEST_SPACE: SpaceContext = {
  spaceId: "space_1",
  spaceSlug: "space-1",
  userId: "user_1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/unused",
};

function harness(
  dial: (command: string, dest: string) => SshExecResult,
  options: {
    projects?: ProjectService & { items: Project[] };
    scopedProjects?: (space: SpaceContext) => Pick<ProjectService, "list" | "addRemote">;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ssh-routes-"));
  const ssh = createSshService({
    file: join(dir, "ssh.json"),
    socketDir: join(dir, "sock"),
    runner: fakeRunner(dial),
    now: () => 7_000,
  });
  const projects = options.projects ?? fakeProjects();
  const probes: string[] = [];
  const installations: string[] = [];
  const routes = sshRoutes({
    ssh, projects,
    ...(options.scopedProjects ? { scopedProjects: options.scopedProjects } : {}),
    probeRuntime: async (connectionId) => {
      probes.push(connectionId);
      return { ok: true, version: "1.18.18" };
    },
    installRuntime: async (connectionId) => { installations.push(connectionId); },
  });

  const call = async (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    caller: { space?: SpaceContext; principal?: { kind: string } } = {},
  ) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    try {
      const handled = await routes({
        req: {}, res: {}, space: caller.space ?? TEST_SPACE,
        // The pre-canonical single local user holds instance authority.
        principal: caller.principal ?? { kind: "local-user" }, url, path: url.pathname, method,
        body: async () => body,
        json: (code: number, value: unknown) => { status = code; payload = value; },
      } as unknown as RouteRequest);
      return { handled, status, payload, error: null as null | { code?: string; message: string } };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { handled: true, status: 0, payload: null, error: { code: e.code, message: e.message } };
    }
  };
  return { call, ssh, projects, probes, installations };
}

const okDial = (command: string): SshExecResult => {
  if (command.includes("$HOME")) return { code: 0, stdout: "/home/dev", stderr: "" };
  if (command.startsWith("cd -- ")) return { code: 0, stdout: "/home/dev\nprojects/\nnotes.txt\n", stderr: "" };
  if (command.startsWith("test -d")) return { code: command.includes("missing") ? 1 : 0, stdout: "", stderr: "" };
  if (command.startsWith("echo polyth-")) return { code: 0, stdout: `${command.slice(5)}\n`, stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("connection CRUD over routes never exposes secret material", async () => {
  const { call } = harness(okDial);

  const created = await call("POST", "/api/ssh/connections", {
    name: "Build box", host: "build.example", user: "dev", port: 2222,
    authMode: "identity-file", identityFile: "~/.ssh/id_ed25519",
  });
  assert.equal(created.status, 200);
  const dto = created.payload as Record<string, unknown>;
  assert.equal(dto.host, "build.example");
  assert.deepEqual(
    Object.keys(dto).sort(),
    [
      "allowedSpaceIds", "allowedUserIds", "authMode", "createdAt", "editable", "host", "id", "identityFile",
      "mine", "name", "owner", "port", "user",
    ],
  );

  // secret-looking fields are rejected with a clear message
  const rejected = await call("POST", "/api/ssh/connections", { host: "x.example", password: "hunter2" });
  assert.equal(rejected.error?.code, "invalid-input");
  assert.match(rejected.error?.message ?? "", /never stores SSH secrets/);

  const patched = await call("PATCH", `/api/ssh/connections/${dto.id}`, { name: "Renamed" });
  assert.equal((patched.payload as { name: string }).name, "Renamed");

  const list = await call("GET", "/api/ssh/connections");
  assert.equal((list.payload as { items: unknown[] }).items.length, 1);

  const removed = await call("DELETE", `/api/ssh/connections/${dto.id}`);
  assert.equal(removed.status, 200);
  const after = await call("GET", "/api/ssh/connections");
  assert.equal((after.payload as { items: unknown[] }).items.length, 0);
});

test("remote OpenCode installation is exposed as an SSH action", async () => {
  const { call, installations } = harness(okDial);
  const created = await call("POST", "/api/ssh/connections", { host: "up.example" });
  const id = (created.payload as { id: string }).id;

  const installed = await call("POST", `/api/ssh/connections/${id}/install`);
  assert.equal(installed.status, 200);
  assert.deepEqual(installed.payload, { ok: true });
  assert.deepEqual(installations, [id]);
});

test("connect/status/test lifecycle and the injected runtime probe", async () => {
  const { call, probes } = harness(okDial);
  const created = await call("POST", "/api/ssh/connections", { host: "up.example", user: "dev" });
  const id = (created.payload as { id: string }).id;

  const connected = await call("POST", `/api/ssh/connections/${id}/connect`);
  assert.equal((connected.payload as { state: string }).state, "connected");

  const tested = await call("POST", `/api/ssh/connections/${id}/test`);
  const testPayload = tested.payload as { state: string; runtime?: { ok: boolean; version?: string } };
  assert.equal(testPayload.state, "connected");
  assert.deepEqual(testPayload.runtime, { ok: true, version: "1.18.18" });
  assert.deepEqual(probes, [id]);

  const disconnected = await call("POST", `/api/ssh/connections/${id}/disconnect`);
  assert.equal((disconnected.payload as { state: string }).state, "disconnected");

  // list embeds the cached status without touching the network
  const list = await call("GET", "/api/ssh/connections");
  const item = (list.payload as { items: Array<{ status?: { state: string } }> }).items[0]!;
  assert.equal(item.status?.state, "disconnected");
});

test("test() does not probe the runtime when the connection fails", async () => {
  const { call, probes } = harness((command) => {
    if (command.startsWith("echo polyth-")) {
      return { code: 255, stdout: "", stderr: "Permission denied (publickey)." };
    }
    return okDial(command);
  });
  const created = await call("POST", "/api/ssh/connections", { host: "auth.example" });
  const id = (created.payload as { id: string }).id;
  const tested = await call("POST", `/api/ssh/connections/${id}/test`);
  const payload = tested.payload as { state: string; runtime?: unknown };
  assert.equal(payload.state, "auth-failed");
  assert.equal(payload.runtime, undefined);
  assert.deepEqual(probes, []);
});

test("browse requires a connection id and lists remote directories", async () => {
  const { call } = harness(okDial);
  const missing = await call("GET", "/api/ssh/browse");
  assert.equal(missing.error?.code, "invalid-input");

  const created = await call("POST", "/api/ssh/connections", { host: "up.example" });
  const id = (created.payload as { id: string }).id;
  const browsed = await call("GET", `/api/ssh/browse?connectionId=${id}`);
  const dto = browsed.payload as { path: string; entries: Array<{ name: string }> };
  assert.equal(dto.path, "/home/dev");
  assert.deepEqual(dto.entries.map((e) => e.name), ["projects"]);
});

test("remote project creation validates the path and binds the connection", async () => {
  const { call, projects } = harness(okDial);
  const created = await call("POST", "/api/ssh/connections", { host: "up.example", user: "dev" });
  const id = (created.payload as { id: string }).id;

  const unknownConn = await call("POST", "/api/ssh/projects", { connectionId: "nope", path: "/srv/app" });
  assert.equal(unknownConn.error?.code, "not-found");

  const missingPath = await call("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/missing" });
  assert.equal(missingPath.error?.code, "not-found");
  assert.match(missingPath.error?.message ?? "", /does not exist/);

  const createdDir = await call("POST", "/api/ssh/projects", {
    connectionId: id, path: "/srv/missing", createDirectory: true, name: "Fresh",
  });
  assert.equal(createdDir.status, 200);
  const fresh = createdDir.payload as Project;
  assert.equal(fresh.name, "Fresh");
  assert.deepEqual(fresh.remote, { kind: "ssh", connectionId: id });

  const existing = await call("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app", name: "App" });
  const project = existing.payload as Project;
  assert.equal(project.path, "/srv/app");
  assert.equal(projects.items.length, 2);

  // idempotent: same connection+path returns the same project
  const again = await call("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app" });
  assert.equal((again.payload as Project).id, project.id);
  assert.equal(projects.items.length, 2);
});

test("remote project routes stay Space-scoped instead of using the unscoped service", async () => {
  const scopes: string[] = [];
  const scopedItems: Project[] = [];
  const scoped: Pick<ProjectService, "list" | "addRemote"> = {
    list: async () => [...scopedItems],
    async addRemote(path, remote, name) {
      const project: Project = {
        id: "proj_scoped", path, name: name ?? path, createdAt: 1, remote,
      };
      scopedItems.push(project);
      return project;
    },
  };
  // A governed package host: the unscoped service refuses installation-wide
  // project creation and listing, so any route that reaches it fails.
  const unscoped = new Proxy({}, {
    get: () => () => {
      throw Object.assign(new Error("package project creation requires an explicit Space context"), { code: "unavailable" });
    },
  }) as ProjectService;
  const { call } = harness(okDial, {
    projects: unscoped as ProjectService & { items: Project[] },
    scopedProjects: (space) => {
      scopes.push(space.spaceId);
      return scoped;
    },
  });

  const created = await call("POST", "/api/ssh/connections", { host: "up.example", user: "dev" });
  const id = (created.payload as { id: string }).id;

  const result = await call("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app", name: "App" });
  assert.equal(result.error, null);
  assert.equal(result.status, 200);
  const project = result.payload as Project;
  assert.equal(project.id, "proj_scoped");
  assert.deepEqual(project.remote, { kind: "ssh", connectionId: id });
  assert.deepEqual(scopes, [TEST_SPACE.spaceId], "remote registration must resolve the caller's Space");

  // The bound-project lookup for connection deletion reads the same scoped list.
  const refused = await call("DELETE", `/api/ssh/connections/${id}`);
  assert.equal(refused.error?.code, "conflict");
  assert.match(refused.error?.message ?? "", /App/);
  assert.ok(scopes.length >= 2);
});

test("real project service registers remote projects without a local path check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-projects-"));
  const projects = createProjectService(dir);
  const remote: ProjectRemote = { kind: "ssh", connectionId: "conn_1" };

  const project = await projects.addRemote!("/home/dev/never-exists-locally", remote, "Remote app");
  assert.equal(project.name, "Remote app");
  assert.deepEqual(project.remote, remote);

  // idempotent per (connection, path); persisted across reload
  const again = await projects.addRemote!("/home/dev/never-exists-locally", remote);
  assert.equal(again.id, project.id);
  const reloaded = createProjectService(dir);
  assert.deepEqual((await reloaded.get(project.id))?.remote, remote);

  await assert.rejects(
    () => projects.addRemote!("relative/path", remote),
    (err: Error & { code?: string }) => err.code === "invalid-input",
  );
});

test("deleting a connection with bound projects is refused with conflict", async () => {
  const { call } = harness(okDial);
  const created = await call("POST", "/api/ssh/connections", { host: "up.example" });
  const id = (created.payload as { id: string }).id;
  await call("POST", "/api/ssh/projects", { connectionId: id, path: "/srv/app", name: "App" });

  const refused = await call("DELETE", `/api/ssh/connections/${id}`);
  assert.equal(refused.error?.code, "conflict");
  assert.match(refused.error?.message ?? "", /App/);

  const list = await call("GET", "/api/ssh/connections");
  assert.equal((list.payload as { items: unknown[] }).items.length, 1, "connection must survive the refused delete");
});

test("SSH connection definitions are installation-wide: only the instance owner mutates them", async () => {
  const { call, ssh, installations } = harness(okDial);
  const owner = { space: { ...TEST_SPACE, instanceOwner: true } as SpaceContext, principal: { kind: "ui-session" } };
  const member = { space: { ...TEST_SPACE, userId: "user_2", role: "admin", instanceOwner: false } as SpaceContext, principal: { kind: "ui-session" } };
  const input = { name: "Box", host: "box.example" };

  // Without harnesses.personal a member can add neither a shared nor a personal connection.
  assert.equal((await call("POST", "/api/ssh/connections", input, member)).error?.code, "forbidden");
  assert.equal((await call("POST", "/api/ssh/connections", { ...input, owner: "installation" }, member)).error?.code, "forbidden");
  assert.equal(ssh.list().length, 0);
  const created = await call("POST", "/api/ssh/connections", input, owner);
  assert.equal(created.status, 200);
  const id = (created.payload as { id: string }).id;

  // A shared connection nobody allowed the member to use does not exist for them.
  for (const [method, path] of [
    ["PATCH", `/api/ssh/connections/${id}`],
    ["POST", `/api/ssh/connections/${id}/disconnect`],
    ["POST", `/api/ssh/connections/${id}/install`],
    ["POST", `/api/ssh/connections/${id}/harnesses/opencode/install`],
    ["DELETE", `/api/ssh/connections/${id}`],
  ] as const) {
    assert.equal((await call(method, path, { name: "X" }, member)).error?.code, "not-found", `${method} ${path}`);
  }
  assert.deepEqual((await call("GET", "/api/ssh/connections", {}, member)).payload, {
    items: [], canAddShared: false, canAddPersonal: false,
  });

  // Allowed to use it, the member still cannot change it.
  assert.equal((await call("PUT", `/api/ssh/connections/${id}/access`, { allowedUserIds: ["user_2"] }, member)).error?.code, "not-found");
  assert.equal((await call("PUT", `/api/ssh/connections/${id}/access`, { allowedUserIds: ["user_2"] }, owner)).status, 200);
  assert.equal((await call("PATCH", `/api/ssh/connections/${id}`, { name: "X" }, member)).error?.code, "forbidden");
  assert.equal(ssh.get(id)?.name, "Box");
  assert.equal((await call("POST", `/api/ssh/connections/${id}/disconnect`, {}, member)).error?.code, "forbidden");
  assert.equal((await call("POST", `/api/ssh/connections/${id}/install`, {}, member)).error?.code, "forbidden");
  assert.deepEqual(installations, []);
  assert.equal((await call("POST", `/api/ssh/connections/${id}/harnesses/opencode/install`, {}, member)).error?.code, "forbidden");
  assert.equal((await call("PUT", `/api/ssh/connections/${id}/access`, { allowedUserIds: [] }, member)).error?.code, "forbidden");
  assert.equal((await call("DELETE", `/api/ssh/connections/${id}`, {}, member)).error?.code, "forbidden");
  assert.equal(ssh.list().length, 1);
  const seen = (await call("GET", "/api/ssh/connections", {}, member)).payload as { items: Array<Record<string, unknown>> };
  assert.equal(seen.items.length, 1);
  assert.equal(seen.items[0]!.mine, false);
  assert.equal("allowedUserIds" in seen.items[0]!, false, "allowlists are shown to the instance owner only");

  assert.equal((await call("PATCH", `/api/ssh/connections/${id}`, { name: "Renamed" }, owner)).status, 200);
  assert.equal((await call("POST", `/api/ssh/connections/${id}/install`, {}, owner)).status, 200);
  assert.equal((await call("DELETE", `/api/ssh/connections/${id}`, {}, owner)).status, 200);
});
