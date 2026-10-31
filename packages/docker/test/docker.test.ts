import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ProjectToolScope } from "@polyth/terminal/tool-types";
import { dockerCommand, dockerSnapshot, parseDockerContainers } from "../src/service.ts";
import registerPackage, { dockerRoutes } from "../src/serverEntry.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/docker-terraform");
test("Docker inspects only containers bearing this Compose path, with a narrow DTO", async (t) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "docker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "compose.yaml"), "services: {}\n");
  await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
  const scope = { projectId: "p1", repositoryId: "r1", root, alias: "App", repositories: [] } as ProjectToolScope;
  const calls: string[][] = [];
  const snapshot = await dockerSnapshot(scope, async (_command, args) => {
    calls.push(args);
    if (args.includes("--services")) return { stdout: "web\ndatabase\n", exitCode: 0 };
    if (args[0] === "ps") return { stdout: JSON.stringify({ ID: "abc", Names: "app-web", Image: "app:local", State: "running", Status: "Up", Ports: "127.0.0.1:3000->3000/tcp", Labels: "com.docker.compose.service=web,password=should-not-leak", Env: ["SECRET=private"] }) + "\n", exitCode: 0 };
    return { stdout: "Docker installed", exitCode: 0 };
  });
  assert.deepEqual(snapshot.services, ["web", "database"]);
  assert.equal(snapshot.containers[0]?.service, "web");
  const ps = calls.find((args) => args[0] === "ps")!;
  assert.ok(ps.includes(`label=com.docker.compose.project.working_dir=${root}`));
  assert.ok(ps.includes(`label=com.docker.compose.project.config_files=${join(root, "compose.yaml")}`));
  assert.equal(JSON.stringify(snapshot).includes("should-not-leak"), false);
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  const preview = await dockerCommand(scope, { file: "compose.yaml", action: "stop" });
  assert.ok(preview.cmd.endsWith("'stop'"));
  assert.equal(preview.cwd, root);
  assert.equal(calls.some((args) => args.includes("stop")), false, "preparation does not execute the command");
  await assert.rejects(dockerCommand(scope, { file: "../compose.yaml", action: "up" }), { code: "not-found" });
  await assert.rejects(dockerCommand(scope, { file: "compose.yaml", action: "prune" as never }), { code: "invalid-input" });
});

test("Docker handles CLI and engine outages without displaying raw stderr/config", async (t) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "docker-outage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "compose.yml"), "services: {}\n");
  const scope = { projectId: "p1", repositoryId: "r1", root, alias: "App", repositories: [] } as ProjectToolScope;
  const missing = await dockerSnapshot(scope, async () => { throw new Error("SECRET=bad"); });
  assert.equal(missing.cli.available, false);
  assert.equal(JSON.stringify(missing).includes("SECRET"), false);
  const outage = await dockerSnapshot(scope, async (_command, args) => ({ stdout: args[0] === "ps" ? "" : "installed", exitCode: args[0] === "ps" ? 1 : 0 }));
  assert.match(outage.runtimeMessage!, /Engine is unavailable/);
  assert.deepEqual(parseDockerContainers(""), []);
});

async function call(route: RouteHandler, path: string, method = "GET", body: object = {}) {
  let output: unknown;
  await route({ path: path.split("?")[0], method, url: new URL(`http://test${path}`), space: { spaceId: "own" }, body: async () => body, json: (_status: number, data: unknown) => { output = data; } } as never);
  return output;
}
test("Docker routes refuse foreign-Space IDs and stay local-only", async () => {
  let runs = 0;
  const host = { deployment: "local-trusted", forSpace: () => ({ projects: { get: async () => undefined } }), projects: { get: async () => ({ id: "foreign", path: "/foreign" }) } } as unknown as ServerPackageHost;
  const routes = dockerRoutes(host, async () => { runs++; return { stdout: "", exitCode: 0 }; });
  await assert.rejects(call(routes, "/api/docker/workspace?projectId=foreign"), { code: "not-found" });
  await assert.rejects(call(routes, "/api/docker/command", "POST", { projectId: "foreign", file: "compose.yaml", action: "up" }), { code: "not-found" });
  assert.equal(runs, 0);
  const pkg = registerPackage(host);
  assert.deepEqual(pkg.remoteAccess, { routeScopes: ["docker"], http: [] });
  await pkg.onEnable!(); await pkg.onDisable!(); await pkg.onEnable!(); await pkg.onDisable!();
});
