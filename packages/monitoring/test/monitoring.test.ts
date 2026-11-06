import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentCapabilityContribution, Project, RouteRequest, SpaceContext, SpaceStorage, ToolExecutionContext } from "@polyth/contracts";
import { createServerServiceRegistry, discoverServerPackages, serverServiceKey, SESSION_PURPOSES, type ServerPackageHost } from "@polyth/plugins";
import { boundedTail, discoverHostLogs, groupProcesses, journalArgs, journalCommand, localHostLogTail, localLogTail, localMetrics, localProcesses, LOG_BYTES, parseProcStat, parsePressureLine, parseRemoteFile, parseRemoteHostLogs, parseRemoteMetrics, parseRemoteProcesses, parseServices, processLabel, realMounts, REMOTE_METRICS_COMMAND, REMOTE_PROCESSES_COMMAND, remoteFileCommand, serviceCommand } from "../src/collect.ts";
import { diskPercent, HISTORY_RANGES, worstDisk } from "../src/contracts.ts";
import { createHistorySampler, historyStore, machineIdOf } from "../src/history.ts";
import { defaultPolicy, failure, parsePolicy, policyStore } from "../src/policy.ts";
import { createMonitoringService, monitoringRoutes } from "../src/service.ts";
import registerPackage from "../src/serverEntry.ts";

const fixtures = resolve(import.meta.dirname, "../../../.scratch/monitoring/tests");
mkdirSync(fixtures, { recursive: true });
const directory = (t: test.TestContext) => {
  const root = mkdtempSync(join(fixtures, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const storage = (root: string): SpaceStorage => ({ root,
  packageDir(id) { const dir = join(root, "packages", id); mkdirSync(dir, { recursive: true }); return dir; },
  path: (rel) => join(root, rel),
});
const remoteSample = "Linux\nweb-1\n4\n0.20 0.10 0.05 1/100 40\n8192000\n4096000\n86460.2\n";
const context: ToolExecutionContext = { spaceId: "one", sessionId: "session-one", projectId: "remote-one", cwd: "/project" };
function fixture(t: test.TestContext) {
  const root = directory(t);
  const one: SpaceContext = { spaceId: "one", spaceSlug: "one", userId: "owner", role: "owner", deployment: "local-trusted", storageDir: join(root, "one") };
  const two: SpaceContext = { ...one, spaceId: "two", spaceSlug: "two", storageDir: join(root, "two") };
  const local: Project = { id: "local-one", spaceId: "one", name: "Local", path: root } as Project;
  const remote: Project = { id: "remote-one", spaceId: "one", name: "SSH", path: "/project", remote: { kind: "ssh", connectionId: "ssh-one" } } as Project;
  const foreign: Project = { ...remote, id: "remote-two", spaceId: "two", remote: { kind: "ssh", connectionId: "ssh-two" } };
  const projects = [local, remote, foreign];
  const calls: Array<{ id: string; command: string }> = [];
  let runner = async (_id: string, command: string) => ({ code: 0, stdout: command === REMOTE_METRICS_COMMAND ? remoteSample : command.startsWith("journalctl") ? "2026-10-01 Started\n" : "active\n", stderr: "" });
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("ssh"), { exec: async (id: string, command: string) => { calls.push({ id, command }); return runner(id, command); } });
  const host = {
    pluginId: "monitoring", deployment: "local-trusted", services,
    projects: { list: async () => projects },
    spaceStorage: (space: SpaceContext) => storage(space.storageDir),
    systemSpaceContext: (id: string) => id === "one" ? one : id === "two" ? two : (() => { throw failure("not-found", "Space not found"); })(),
    forSpace: (space: SpaceContext) => ({
      projects: { get: async (id: string) => projects.find((p) => p.id === id && p.spaceId === space.spaceId), list: async () => projects.filter((p) => p.spaceId === space.spaceId) },
      sessions: { snapshot: async (id: string) => { if (id === "session-one" && space.spaceId === "one") return { spaceId: "one", projectId: "remote-one" }; throw failure("not-found", "Session not found"); } },
    }),
  } as unknown as ServerPackageHost;
  const service = createMonitoringService(host); service.enable();
  const grant = async (operations = { metrics: true, services: true, logs: true }) => service.putPolicy(one, remote.id, {
    ...defaultPolicy(), agentAccess: operations, serviceUnits: ["nginx.service"],
  }, (await service.policy(one, remote.id)).revision);
  return { root, one, two, local, remote, foreign, host, service, calls, grant, run: (fn: typeof runner) => { runner = fn; } };
}

test("policy defaults deny every agent operation; malformed permissions and injected sources are rejected", () => {
  assert.deepEqual(defaultPolicy().agentAccess, { metrics: false, services: false, logs: false, processes: false });
  for (const patch of [
    { agentAccess: { metrics: "true", services: false, logs: false } },
    { serviceUnits: ["nginx.service'; reboot; '"] }, { serviceUnits: ["--help.service"] },
    { logPaths: ["../outside.log"] }, { logPaths: ["/etc/shadow"] }, { logPaths: [".git/private.log"] },
    { logPaths: ["/var/log/../../etc/shadow"] }, { logPaths: ["/proc/self/environ.log"] }, { logPaths: ["/var/log/x'; reboot; '.log"] },
    { logPaths: ["journal:$(reboot).service"] }, { logPaths: ["journalctl"] }, { logPaths: Array.from({ length: 25 }, (_, i) => `app-${i}.log`) },
    { logPaths: ["logs\\private.log"] }, { logPaths: ["config.env"] }, { logPaths: ["logs/a\u0000.log"] },
    { memoryWarningPercent: NaN }, { loadWarningRatio: Infinity }, { diskWarningPercent: NaN }, { diskWarningPercent: 0 }, { diskWarningPercent: 101 },
    { agentAccess: { metrics: false, services: false, logs: false, processes: "yes" } },
  ]) assert.throws(() => parsePolicy({ ...defaultPolicy(), ...patch }, 1), { code: "invalid-input" });
  const hostWide = ["journal", "kernel", "journal:nginx.service", "/var/log/syslog", "/var/log/nginx/access.log", "/home/app/.pm2/logs/api.log", "logs/app.log"];
  assert.deepEqual(parsePolicy({ ...defaultPolicy(), logPaths: hostWide }, 1).logPaths, hostWide);
});

test("a policy written before these fields keeps denying processes and defaults its disk limit", () => {
  const { diskWarningPercent: _disk, ...older } = defaultPolicy();
  const parsed = parsePolicy({ ...older, agentAccess: { metrics: true, services: false, logs: false } }, 1);
  assert.equal(parsed.agentAccess.processes, false);
  assert.equal(parsed.diskWarningPercent, 90);
});

test("a writer that predates the disk limit cannot reset one that was set", async (t) => {
  const f = fixture(t);
  const saved = await f.service.putPolicy(f.one, f.remote.id, { ...defaultPolicy(), diskWarningPercent: 75 }, 0);
  const { diskWarningPercent: _disk, ...older } = saved;
  assert.equal((await f.service.putPolicy(f.one, f.remote.id, older, saved.revision)).diskWarningPercent, 75);
});

test("policy storage survives reopening, detects conflicts and isolates a known-valid foreign project", async (t) => {
  const f = fixture(t);
  const saved = await f.grant();
  assert.equal(saved.revision, 1);
  assert.deepEqual(policyStore(storage(f.one.storageDir)).get(f.remote.id), saved);
  assert.equal(policyStore(storage(f.two.storageDir)).get(f.remote.id).revision, 0);
  await assert.rejects(f.service.putPolicy(f.one, f.remote.id, saved, 0), { code: "conflict" });
  await assert.rejects(f.service.policy(f.one, f.foreign.id), { code: "not-found" });
  await assert.rejects(f.service.putPolicy(f.one, f.foreign.id, saved, 0), { code: "not-found" });
  const files = readFileSync(join(f.one.storageDir, "packages/monitoring/policies.json"), "utf8");
  assert.equal(files.includes(f.foreign.id), false);
});

test("corrupt policy fails closed instead of granting a fallback", (t) => {
  const root = directory(t); const store = policyStore(storage(root));
  writeFileSync(join(root, "packages/monitoring/policies.json"), JSON.stringify({ project: { revision: 1, agentAccess: { metrics: true } } }));
  assert.throws(() => store.get("project"), { code: "invalid-input" });
});

test("host inventory and remote probes resolve the current Space before unscoped SSH", async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.service.hosts(f.one)).map((h) => h.projectId), [f.local.id, f.remote.id]);
  await assert.rejects(f.service.snapshot(f.one, f.foreign.id), { code: "not-found" });
  await assert.rejects(f.service.logs(f.one, f.foreign.id, "journal:nginx.service"), { code: "not-found" });
  assert.equal(f.calls.length, 0);
  const result = await f.service.snapshot(f.one, f.remote.id);
  assert.equal(result.metrics.hostname, "web-1"); assert.equal(result.metrics.cpuCount, 4);
  assert.deepEqual(f.calls.map((call) => call.id), ["ssh-one"]);
});

test("sandboxed deployments enumerate unsupported hosts but never run probes", async (t) => {
  const f = fixture(t); f.host.deployment = "multi-tenant-sandboxed";
  assert.equal((await f.service.hosts(f.one))[0]!.supported, false);
  await assert.rejects(f.service.snapshot(f.one, f.remote.id), { code: "forbidden" });
  assert.equal(f.calls.length, 0);
});

test("agents can inspect policy but cannot probe without operation-specific grants", async (t) => {
  const f = fixture(t);
  const policy = await f.service.agentRead({ action: "policy" }, context) as { readOnly: boolean };
  assert.equal(policy.readOnly, true);
  for (const action of ["metrics", "services", "logs"]) await assert.rejects(f.service.agentRead({ action, source: "journal:nginx.service" }, context), { code: "forbidden" });
  assert.equal(f.calls.length, 0);
  await f.grant({ metrics: true, services: false, logs: false });
  const result = await f.service.agentRead({ action: "metrics", connectionId: "ssh-two", projectId: "remote-two" }, context) as Record<string, unknown>;
  assert.ok(result.metrics); assert.equal(Object.hasOwn(result, "services"), false);
  assert.deepEqual(f.calls.map((call) => call.id), ["ssh-one"]);
  await assert.rejects(f.service.agentRead({ action: "services" }, context), { code: "forbidden" });
  await assert.rejects(f.service.agentRead({ action: "restart" }, context), { code: "invalid-input" });
});

test("wrong-Space canonical sessions and mismatched projects cannot authorize agents", async (t) => {
  const f = fixture(t); await f.grant();
  await assert.rejects(f.service.agentRead({ action: "metrics" }, { ...context, spaceId: "two" }), { code: "not-found" });
  await assert.rejects(f.service.agentRead({ action: "metrics" }, { ...context, projectId: "remote-two" }), { code: "not-found" });
  await assert.rejects(f.service.agentRead({ action: "metrics" }, { ...context, spaceId: undefined }), { code: "forbidden" });
  assert.equal(f.calls.length, 0);
});

test("revoking permission while a probe runs suppresses its result", async (t) => {
  const f = fixture(t); await f.grant();
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.run(async () => { started(); await waiting; return { code: 0, stdout: remoteSample, stderr: "" }; });
  const result = f.service.agentRead({ action: "metrics" }, context);
  await entered; await f.grant({ metrics: false, services: false, logs: false }); release();
  await assert.rejects(result, { code: "forbidden" });
});

test("disable/re-enable fences an older in-flight probe", async (t) => {
  const f = fixture(t);
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.run(async () => { started(); await waiting; return { code: 0, stdout: remoteSample, stderr: "" }; });
  const result = f.service.snapshot(f.one, f.remote.id);
  await entered; f.service.disable(); f.service.enable(); release();
  await assert.rejects(result, { code: "unavailable" });
});

test("cancelled agent calls do not initiate SSH", async (t) => {
  const f = fixture(t); await f.grant();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.agentRead({ action: "metrics" }, { ...context, signal: controller.signal }));
  assert.equal(f.calls.length, 0);
});

test("failed remote diagnostics are not retried and do not expose raw stderr", async (t) => {
  const f = fixture(t);
  f.run(async () => ({ code: 1, stdout: "", stderr: "private diagnostic detail" }));
  await assert.rejects(f.service.snapshot(f.one, f.remote.id), (cause: unknown) => cause instanceof Error && !cause.message.includes("private"));
  assert.equal(f.calls.length, 1);
});

test("approved services and journals work; unapproved logs fail before execution", async (t) => {
  const f = fixture(t); await f.grant();
  const status = await f.service.snapshot(f.one, f.remote.id);
  assert.deepEqual(status.services, [{ unit: "nginx.service", state: "active" }]);
  const log = await f.service.agentRead({ action: "logs", source: "journal:nginx.service" }, context) as { content: string };
  assert.equal(log.content, "2026-10-01 Started\n");
  const count = f.calls.length;
  await assert.rejects(f.service.logs(f.one, f.remote.id, "journal:sshd.service"), { code: "forbidden" });
  await assert.rejects(f.service.logs(f.one, f.remote.id, "/etc/private.log"), { code: "forbidden" });
  assert.equal(f.calls.length, count);
});

test("UI policy writes require a human administrator; internal/paired callers cannot self-grant", async (t) => {
  const f = fixture(t); const routes = monitoringRoutes(f.service);
  const request = (principal: RouteRequest["principal"], role: SpaceContext["role"] = "owner") => ({
    path: "/api/monitoring/policy", method: "PUT", url: new URL("http://test/api/monitoring/policy?projectId=remote-one"),
    space: { ...f.one, role }, principal, ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: false },
    body: async () => ({ policy: defaultPolicy(), expectedRevision: 0 }), json: () => {},
  }) as unknown as RouteRequest;
  await assert.rejects(routes(request({ kind: "internal-service", serviceId: "agent" })), { code: "forbidden" });
  await assert.rejects(routes(request({ kind: "paired-device", grants: [] } as unknown as RouteRequest["principal"])), { code: "forbidden" });
  await assert.rejects(routes(request({ kind: "anonymous" })), { code: "unauthorized" });
  await assert.rejects(routes(request({ kind: "ui-session" } as RouteRequest["principal"], "member")), { code: "forbidden" });
  assert.equal(await routes(request({ kind: "ui-session" } as RouteRequest["principal"])), true);
  assert.equal((await f.service.policy(f.one, f.remote.id)).revision, 1);
});

test("file tails are bounded, handle append/truncation/rotation and reject escaping symlinks", { skip: process.platform !== "linux" }, async (t) => {
  const root = directory(t); const project = join(root, "project"); mkdirSync(project);
  const log = join(project, "app.log");
  writeFileSync(log, Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n") + "\n");
  const first = await localLogTail(project, "app.log");
  assert.equal(first.content.startsWith("line-100\n"), true); assert.equal(first.truncated, true);
  writeFileSync(log, "new\n"); assert.equal((await localLogTail(project, "app.log")).content, "new\n");
  rmSync(log); writeFileSync(log, "rotated\n"); assert.equal((await localLogTail(project, "app.log")).content, "rotated\n");
  writeFileSync(join(root, "outside.log"), "outside data"); symlinkSync(join(root, "outside.log"), join(project, "escape.log"));
  await assert.rejects(localLogTail(project, "escape.log"), { code: "forbidden" });
  symlinkSync(root, join(project, "outside")); await assert.rejects(localLogTail(project, "outside/outside.log"), { code: "forbidden" });
  await assert.rejects(localLogTail(project, "../outside.log"), { code: "invalid-input" });
  mkdirSync(join(project, "dir.log")); await assert.rejects(localLogTail(project, "dir.log"), { code: "invalid-input" });
});

test("log discovery suggests only approvable project files and never follows symlinks", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t); const root = f.root;
  mkdirSync(join(root, "logs/deep/deeper/deepest"), { recursive: true }); mkdirSync(join(root, ".git")); mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  for (const file of ["app.log", "logs/worker.log", "logs/deep/old.log", "logs/deep/deeper/deepest/too-deep.log", ".git/hidden.log", "node_modules/pkg/dep.log", "logs/.dot.log", "logs/notes.txt"]) writeFileSync(join(root, file), "x\n");
  writeFileSync(join(root, "..", "outside-discovery.log"), "outside"); t.after(() => rmSync(join(root, "..", "outside-discovery.log"), { force: true }));
  symlinkSync(join(root, "..", "outside-discovery.log"), join(root, "escape.log")); symlinkSync(join(root, ".."), join(root, "parent"));
  const items = await f.service.logCandidates(f.one, f.local.id);
  const projectItems = items.filter((item) => item.kind === "project");
  assert.deepEqual(projectItems.map((item) => item.path).sort(), ["app.log", "logs/deep/old.log", "logs/worker.log"]);
  assert.deepEqual(items.filter((item) => item.kind === "journal").map((item) => item.path), ["journal", "kernel"]);
  for (const item of items) assert.doesNotThrow(() => parsePolicy({ ...defaultPolicy(), logPaths: [item.path] }, 1));
  await assert.rejects(f.service.logCandidates(f.one, f.foreign.id), { code: "not-found" });
  assert.equal(f.calls.length, 0);
  f.run(async () => ({ code: 0, stdout: "120 1760000000.5 /var/log/syslog\n5 1760000001 /var/log/nginx/error.log\n9 1 /var/log/syslog.1\n9 1 /var/log/wtmp\n", stderr: "" }));
  const remote = await f.service.logCandidates(f.one, f.remote.id);
  assert.deepEqual(remote.map((item) => item.path), ["journal", "kernel", "/var/log/nginx/error.log", "/var/log/syslog"]);
  assert.deepEqual(f.calls.map((call) => call.id), ["ssh-one"]);
  let body: unknown;
  const handled = await monitoringRoutes(f.service)({ path: "/api/monitoring/log-candidates", method: "GET", space: f.one,
    url: new URL(`http://test/api/monitoring/log-candidates?projectId=${f.local.id}`), json: (_status: number, value: unknown) => { body = value; } } as unknown as RouteRequest);
  assert.equal(handled, true); assert.equal((body as { items: Array<{ kind: string }> }).items.filter((item) => item.kind === "project").length, 3);
});

test("process names on the server need the instance owner; on an SSH host they are the Space's", async (t) => {
  const f = fixture(t);
  const grant = (project: string, instanceOwner: boolean, processes = true) => async () => f.service.putPolicy(f.one, project, {
    ...await f.service.policy(f.one, project), agentAccess: { metrics: true, services: false, logs: false, processes },
  }, (await f.service.policy(f.one, project)).revision, { instanceOwner });
  await assert.rejects(grant(f.local.id, false)(), { code: "forbidden" });
  await grant(f.remote.id, false)();
  await grant(f.local.id, true)();
  // A Space admin may keep or remove the grant the owner made.
  await grant(f.local.id, false)();
  await grant(f.local.id, false, false)();
  assert.equal((await f.service.policy(f.one, f.local.id)).agentAccess.processes, false);
  // What the browser may read follows the same line.
  const hosts = (instanceOwner: boolean) => f.service.hosts(f.one, { instanceOwner });
  assert.equal((await hosts(true)).find((item) => item.projectId === f.remote.id)!.processesAvailable, true);
  assert.equal((await hosts(false)).find((item) => item.projectId === f.remote.id)!.processesAvailable, true);
  assert.equal((await hosts(false)).find((item) => item.projectId === f.local.id)!.processesAvailable, false);
  await assert.rejects(f.service.processes(f.one, f.local.id, { instanceOwner: false }), { code: "forbidden" });
  await assert.rejects(f.service.processes(f.one, f.foreign.id, { instanceOwner: true }), { code: "not-found" });
});

test("agents read process names only with their own grant, and history with the metrics grant", async (t) => {
  const f = fixture(t);
  f.run(async (_id, command) => ({ code: 0, stderr: "", stdout: command === REMOTE_PROCESSES_COMMAND
    ? "100\n4096\n7 100 2560 nginx\n#second\n7 300 2560 nginx\n" : command === REMOTE_METRICS_COMMAND ? remoteSample : "" }));
  await assert.rejects(f.service.agentRead({ action: "processes" }, context), { code: "forbidden" });
  await assert.rejects(f.service.agentRead({ action: "history" }, context), { code: "forbidden" });
  assert.equal(f.calls.length, 0);
  await f.grant({ metrics: true, services: false, logs: false });
  await assert.rejects(f.service.agentRead({ action: "processes" }, context), { code: "forbidden" }, "Host metrics does not imply process names");
  await f.service.agentRead({ action: "metrics" }, context);
  const history = await f.service.agentRead({ action: "history", range: "24h" }, context) as { range: string; points: unknown[] };
  assert.equal(history.range, "24h");
  await assert.rejects(f.service.agentRead({ action: "history", range: "1y" }, context), { code: "invalid-input" });
  await f.grant({ metrics: true, services: false, logs: false, processes: true } as never);
  const result = await f.service.agentRead({ action: "processes" }, context) as { groups: Array<{ name: string; cpus: number; memory: number }> };
  assert.deepEqual(result.groups, [{ name: "nginx", count: 1, cpus: 1, memory: 2560 * 4096 }]);
  assert.equal(JSON.stringify(result).includes("cmdline"), false);
});

test("viewers of one machine share a process sample, Spaces and machines never do", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  f.run(async () => { await waiting; return { code: 0, stderr: "", stdout: "100\n4096\n#second\n" }; });
  const first = f.service.processes(f.one, f.remote.id, { instanceOwner: false });
  const second = f.service.processes(f.one, f.remote.id, { instanceOwner: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  release();
  await Promise.all([first, second]);
  await f.service.processes(f.one, f.remote.id, { instanceOwner: false });
  assert.equal(f.calls.length, 2, "a finished sample is not reused");
});

test("a disk over its limit warns, and load warns on the 5-minute average rather than one busy minute", async (t) => {
  const f = fixture(t);
  const sample = (load: string, disk: string) => `Linux\nweb-1\n4\n${load} 1/100 40\n8192000\n4096000\n86460.2\n#pressure\ncpu some avg10=1.00 avg60=59.33 avg300=2.00 total=1\nio some avg10=0.00 avg60=0.99 avg300=0.00 total=1\nmemory some avg10=0.00 avg60=0.04 avg300=0.00 total=1\n#disks\nFilesystem 1024-blocks Used Available Capacity Mounted on\n${disk}\n`;
  const spike = sample("20.00 1.00 1.00", "/dev/sda1 1000 500 500 50% /");
  f.run(async (_id, command) => ({ code: 0, stderr: "", stdout: command === REMOTE_METRICS_COMMAND ? spike : "active\n" }));
  assert.deepEqual((await f.service.snapshot(f.one, f.remote.id)).warnings, [], "one busy minute alone is no warning");
  const sustained = sample("1.00 9.00 9.00", "/dev/sda1 1000 910 90 91% /\n/dev/sdb1 1000 500 500 50% /data");
  f.run(async (_id, command) => ({ code: 0, stderr: "", stdout: command === REMOTE_METRICS_COMMAND ? sustained : "active\n" }));
  const result = await f.service.snapshot(f.one, f.remote.id);
  assert.deepEqual(result.warnings, ["load", "disk"]);
  assert.deepEqual(result.metrics.disks?.map((disk) => [disk.mount, diskPercent(disk)]), [["/", 91], ["/data", 50]]);
  assert.deepEqual(result.metrics.pressure, { cpu: 59.33, io: 0.99, memory: 0.04 });
});

test("readings build a history per machine; a foreign project and an unknown range are refused", async (t) => {
  const f = fixture(t);
  await f.service.snapshot(f.one, f.remote.id);
  const history = await f.service.history(f.one, f.remote.id, "1h");
  assert.equal(history.stepMs, HISTORY_RANGES["1h"].stepMs);
  assert.equal(history.points.length, 1);
  await assert.rejects(f.service.history(f.one, f.remote.id, "1y"), { code: "invalid-input" });
  await assert.rejects(f.service.history(f.one, f.foreign.id, "1h"), { code: "not-found" });
  assert.equal((await f.service.history(f.one, f.local.id, "1h")).points.length, 0, "another machine has its own history");
  // Space two has no reading of this connection, even under the same project id.
  f.service.disable();
  const stored = readFileSync(join(f.one.storageDir, "packages/monitoring/history.json"), "utf8");
  assert.equal(stored.includes("ssh-one"), false, "the connection id is not written down");
  assert.ok(stored.includes(machineIdOf(f.remote)));
});

test("only the instance owner newly approves the Polyth server's own host sources", async (t) => {
  const f = fixture(t);
  const put = (patch: Partial<ReturnType<typeof defaultPolicy>>, project = f.local.id, instanceOwner = false) => async () =>
    f.service.putPolicy(f.one, project, { ...(await f.service.policy(f.one, project)), ...patch }, (await f.service.policy(f.one, project)).revision, { instanceOwner });
  for (const patch of [{ logPaths: ["journal"] }, { logPaths: ["kernel"] }, { logPaths: ["/var/log/syslog"] }, { serviceUnits: ["nginx.service"] }]) {
    await assert.rejects(put(patch)(), { code: "forbidden" });
  }
  // Project files stay Space-admin; an SSH host belongs to the Space.
  await put({ logPaths: ["app.log"] })();
  await put({ logPaths: ["journal", "/var/log/syslog"], serviceUnits: ["nginx.service"] }, f.remote.id)();
  // The owner approves; a Space admin may then keep or remove the entry.
  await put({ logPaths: ["app.log", "journal"] }, f.local.id, true)();
  await put({ logPaths: ["journal", "app.log"], memoryWarningPercent: 90 })();
  await put({ logPaths: ["app.log"] })();
  assert.deepEqual((await f.service.policy(f.one, f.local.id)).logPaths, ["app.log"]);
  // The route passes the caller's canonical instance-owner marker.
  const route = (instanceOwner: boolean) => async () => monitoringRoutes(f.service)({ path: "/api/monitoring/policy", method: "PUT",
    space: { ...f.one, instanceOwner }, principal: { kind: "ui-session", sessionId: "ui", rememberedDeviceId: "d" }, ingress: { kind: "public-http", listenerId: "public", loopback: false, secure: true },
    url: new URL(`http://test/api/monitoring/policy?projectId=${f.local.id}`),
    body: async () => ({ policy: { ...(await f.service.policy(f.one, f.local.id)), logPaths: ["app.log", "kernel"] }, expectedRevision: (await f.service.policy(f.one, f.local.id)).revision }),
    json: () => {} } as unknown as RouteRequest);
  await assert.rejects(route(false)(), { code: "forbidden" });
  assert.equal(await route(true)(), true);
});

test("bounded tails do not split a leading UTF-8 code point and honor line/byte caps", () => {
  const result = boundedTail("ї".repeat(LOG_BYTES), "app.log");
  assert.equal(result.content.includes("�"), false); assert.ok(Buffer.byteLength(result.content) <= LOG_BYTES);
  assert.equal(result.truncated, true);
  const lines = boundedTail(Array.from({ length: 250 }, (_, i) => `${i}`).join("\n"), "app.log");
  assert.equal(lines.content.split("\n").length, 200);
});

test("remote parsers reject malformed/non-Linux metrics and command builders reject injection", () => {
  assert.equal(parseRemoteMetrics(remoteSample).memoryAvailable, 4096000 * 1024);
  for (const sample of ["Darwin\n" + remoteSample, remoteSample.replace("4\n", "NaN\n"), remoteSample.replace("8192000", "0"), "Linux\n"]) assert.throws(() => parseRemoteMetrics(sample), { code: "unsupported" });
  assert.throws(() => serviceCommand(["nginx.service; reboot"]), { code: "invalid-input" });
  assert.throws(() => journalCommand("$(reboot).service"), { code: "invalid-input" });
  assert.deepEqual(parseServices(["one.service", "two.service"], "active\nbad\n"), [{ unit: "one.service", state: "active" }, { unit: "two.service", state: "unknown" }]);
});

test("package discovery, lifecycle and partial registration failure clean up capabilities", async (t) => {
  const f = fixture(t);
  const discovered = await discoverServerPackages(resolve(import.meta.dirname, "../.."));
  const entry = discovered.find((pkg) => pkg.id === "monitoring"); assert.ok(entry); assert.equal(entry.packageName, "@polyth/monitoring");
  const contributions = new Map<string, AgentCapabilityContribution>(); let purpose = false;
  f.host.services.provide(serverServiceKey("harness.capabilities"), { register: (_owner: string, contribution: AgentCapabilityContribution) => {
    assert.equal(contributions.has(contribution.descriptor.id), false); contributions.set(contribution.descriptor.id, contribution);
    return { dispose: () => { contributions.delete(contribution.descriptor.id); } };
  } });
  f.host.services.provide(SESSION_PURPOSES, { register: () => { purpose = true; return { dispose: () => { purpose = false; } }; } });
  const pkg = registerPackage(f.host);
  assert.deepEqual(pkg.remoteAccess, { routeScopes: ["monitoring"], http: [] });
  await pkg.onEnable!(); assert.equal(contributions.size, 2); assert.equal(purpose, true);
  const tool = contributions.get("monitoring.monitoring_read")!.descriptor as unknown as { inputSchema: { properties: { action: { enum: string[] } } }; mutating: boolean };
  assert.deepEqual(tool.inputSchema.properties.action.enum, ["policy", "metrics", "history", "processes", "services", "logs"]);
  assert.equal(tool.mutating, false);
  await pkg.onDisable!(); assert.equal(contributions.size, 0); assert.equal(purpose, false);
  await pkg.onEnable!(); assert.equal(contributions.size, 2); await pkg.onDisable!();
  const broken = fixture(t); let cleaned = false;
  broken.host.services.provide(SESSION_PURPOSES, { register: () => ({ dispose: () => { cleaned = true; } }) });
  broken.host.services.provide(serverServiceKey("harness.capabilities"), { register: () => { throw new Error("registration failed"); } });
  const failed = registerPackage(broken.host); await assert.rejects(async () => failed.onEnable!(), /registration failed/); assert.equal(cleaned, true);
});

test("host-wide sources: approved journals and host files on SSH, unapproved ones fail before execution", async (t) => {
  const f = fixture(t);
  const revision = (await f.service.policy(f.one, f.remote.id)).revision;
  await f.service.putPolicy(f.one, f.remote.id, { ...defaultPolicy(), agentAccess: { metrics: false, services: false, logs: true },
    logPaths: ["journal", "kernel", "/var/log/syslog"] }, revision);
  f.run(async (_id, command) => ({ code: 0, stderr: "", stdout: command.startsWith("journalctl") ? `${command}\n`
    : command.startsWith("f=$(readlink") ? `/var/log/syslog\n${LOG_BYTES + 10}\npartial line\nkept\n` : "" }));
  const journal = await f.service.agentRead({ action: "logs", source: "journal" }, context) as { content: string };
  assert.equal(journal.content.includes("--unit"), false); assert.equal(journal.content.includes("--dmesg"), false);
  assert.match((await f.service.logs(f.one, f.remote.id, "kernel")).content, /--dmesg/);
  const file = await f.service.logs(f.one, f.remote.id, "/var/log/syslog");
  assert.equal(file.content, "kept\n"); assert.equal(file.truncated, true);
  const count = f.calls.length;
  for (const source of ["/var/log/auth.log", "journal:sshd.service", "/etc/shadow"]) await assert.rejects(f.service.logs(f.one, f.remote.id, source), { code: "forbidden" });
  assert.equal(f.calls.length, count);
  // A symlink resolving outside approvable host logs is refused after resolution.
  f.run(async () => ({ code: 0, stderr: "", stdout: "/etc/shadow\n10\nroot:x\n" }));
  await assert.rejects(f.service.logs(f.one, f.remote.id, "/var/log/syslog"), { code: "forbidden" });
});

test("host command builders quote validated input and refuse injection", () => {
  assert.deepEqual(journalArgs("journal:nginx.service").slice(-2), ["--unit", "nginx.service"]);
  assert.ok(journalArgs("kernel").includes("--dmesg"));
  assert.throws(() => journalArgs("journal:$(reboot).service"), { code: "invalid-input" });
  assert.throws(() => remoteFileCommand("/var/log/a'b.log"), { code: "invalid-input" });
  assert.match(remoteFileCommand("/var/log/syslog"), /readlink -f -- '\/var\/log\/syslog'/);
  assert.throws(() => parseRemoteFile("/var/log/syslog", "garbage"), { code: "unavailable" });
  assert.deepEqual(parseRemoteHostLogs("1 2 /var/log/../etc/shadow\n3 4 /var/log/journal/x/system.journal\n"), []);
});

test("local host file tails reject symlinks resolving outside approvable host logs", { skip: process.platform !== "linux" }, async (t) => {
  const root = directory(t);
  writeFileSync(join(root, "secret.txt"), "secret"); symlinkSync(join(root, "secret.txt"), join(root, "trap.log"));
  await assert.rejects(localHostLogTail(join(root, "trap.log")), { code: "forbidden" });
  writeFileSync(join(root, "real.log"), "hello\n");
  assert.equal((await localHostLogTail(join(root, "real.log"))).content, "hello\n");
  await assert.rejects(localHostLogTail("/etc/shadow"), { code: "invalid-input" });
  for (const item of await discoverHostLogs(root)) assert.equal(item.kind, "host");
  assert.deepEqual((await discoverHostLogs(root)).map((item) => item.path), [join(root, "real.log")]);
});

test("remote metrics read their optional sections and survive a host without them", () => {
  const plain = parseRemoteMetrics(remoteSample);
  assert.equal(plain.disks, undefined); assert.equal(plain.pressure, undefined);
  const output = `${remoteSample}#pressure\ncpu \nio \nmemory \n#disks\nFilesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 800 200 80% /\ntmpfs 1000 1 999 1% /run\n/dev/loop3 10 10 0 100% /snap/core/1\n/dev/sda15 100 90 10 90% /boot/efi\n`;
  const parsed = parseRemoteMetrics(output);
  assert.equal(parsed.pressure, undefined, "a kernel without pressure stats");
  assert.deepEqual(parsed.disks, [{ mount: "/", size: 1000 * 1024, used: 800 * 1024, available: 200 * 1024 }], "a container's overlay root is all it has");
  const spaced = parseRemoteMetrics(`${remoteSample}#disks\n/dev/sdb1 1000 500 500 50% /mnt/my disk\n/dev/sdb1 1000 500 500 50% /mnt/bind/again\n`);
  assert.deepEqual(spaced.disks?.map((disk) => disk.mount), ["/mnt/my disk"], "one device, its shortest mount");
});

test("disk percent matches df and never gains a point from float error", () => {
  assert.equal(diskPercent({ used: 41, available: 4.3 }), 91);
  assert.equal(diskPercent({ used: 90, available: 10 }), 90);
  assert.equal(diskPercent({ used: 0, available: 0 }), 0);
  assert.equal(worstDisk({ disks: [{ mount: "/a", size: 1, used: 1, available: 9 }, { mount: "/b", size: 1, used: 9, available: 1 }] })?.mount, "/b");
  assert.equal(worstDisk({}), undefined);
  assert.deepEqual(realMounts("/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0\noverlay /var/lib/docker/overlay2/x overlay rw 0 0\n/dev/loop1 /snap/x squashfs ro 0 0\n/dev/sda15 /boot/efi vfat rw 0 0\nrclone: /mnt/drive fuse.rclone rw 0 0\n"), ["/", "/mnt/my disk"]);
  assert.equal(parsePressureLine("some avg10=0.65 avg60=0.99 avg300=2.54 total=1\nfull avg10=0.00 avg60=0.09 avg300=0.62 total=1\n"), 0.99);
  assert.equal(parsePressureLine("cpu some avg10=1 avg60=52.5 avg300=1 total=1"), 52.5);
  assert.equal(parsePressureLine(""), undefined);
});

test("process stat lines parse a name holding spaces and parentheses; groups keep names only", () => {
  const stat = (pid: number, name: string, ticks: number, pages: number) => `${pid} (${name}) S 1 1 1 0 -1 4194560 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 1 1 ${pages} 1 1 1 1`;
  assert.deepEqual(parseProcStat(stat(9, "tmux: server (x) y", 42, 7)), { pid: 9, ticks: 42, pages: 7, name: "tmux: server (x) y" });
  assert.equal(parseProcStat("garbage"), undefined);
  const before = [{ pid: 1, ticks: 100, pages: 10, name: "node" }, { pid: 2, ticks: 100, pages: 10, name: "node" }, { pid: 3, ticks: 500, pages: 0, name: "kworker/0:1" }, { pid: 4, ticks: 900, pages: 5, name: "gone" }];
  const after = [{ pid: 1, ticks: 300, pages: 10, name: "node" }, { pid: 2, ticks: 200, pages: 10, name: "node" }, { pid: 3, ticks: 501, pages: 0, name: "kworker/0:1" }, { pid: 5, ticks: 7, pages: 5, name: "2.1.318" }, { pid: 6, ticks: 1, pages: 2, name: "chrome_crashpad" }];
  assert.deepEqual(groupProcesses(before, after, 2, 100, 4096), [
    { name: "Node", count: 2, cpus: 1.5, memory: 20 * 4096 },
    { name: "Claude Code", count: 1, cpus: 0, memory: 5 * 4096 },
    { name: "Chromium", count: 1, cpus: 0, memory: 2 * 4096 },
  ], "a quiet kernel is left out; a new process has no earlier sample to compare");
  assert.equal(processLabel("bad\u0000name\n"), "badname");
  assert.equal(processLabel(""), "Unknown");
  assert.throws(() => parseRemoteProcesses("nonsense"), { code: "unsupported" });
  assert.deepEqual(parseRemoteProcesses("100\n4096\n7 100 2560 two words\n#second\n7 300 2560 two words\n"), [{ name: "two words", count: 1, cpus: 1, memory: 2560 * 4096 }]);
  assert.equal(/cmdline|environ/.test(REMOTE_PROCESSES_COMMAND), false, "the probe never reads a command line");
});

test("local readings report this host's disks, and process names by group", { skip: process.platform !== "linux" }, async () => {
  const metrics = await localMetrics();
  assert.ok((metrics.disks?.length ?? 0) > 0);
  for (const disk of metrics.disks!) assert.ok(disk.size > 0 && disk.mount.startsWith("/"));
  const groups = await localProcesses(50);
  assert.ok(groups.length > 0 && groups.length <= 8);
  for (const group of groups) assert.ok(group.count > 0 && group.cpus >= 0 && group.memory >= 0 && group.name.length <= 40);
});

test("history keeps the highest reading per step, drops old points and survives a damaged file", (t) => {
  const root = directory(t); const space = storage(root);
  const metrics = (load: number) => ({ hostname: "h", platform: "linux", cpuCount: 2, load: [load, load, load] as [number, number, number], memoryTotal: 100, memoryAvailable: 40, uptimeSeconds: 1, disks: [{ mount: "/", size: 100, used: 91, available: 9 }] });
  const store = historyStore(space);
  const base = 1_000 * 60 * 60 * 24;
  store.record("local", metrics(2), base);
  store.record("local", metrics(6), base + 10_000);
  store.record("local", metrics(4), base + 20_000);
  store.record("local", metrics(8), base + 61_000);
  assert.deepEqual(store.read("local", "1h", base + 61_000).points, [[base, 3, 60, 91], [base + 60_000, 4, 60, 91]], "per CPU, highest in each minute");
  assert.equal(store.read("local", "24h", base + 61_000).points.length, 1, "the same minutes are one step of the day chart");
  const later = base + 2 * 60 * 60_000;
  store.record("local", metrics(2), later);
  assert.equal(store.read("local", "1h", later).points.length, 1, "older than the range is gone");
  assert.equal(store.read("ssh-0123456789abcdef", "1h", later).points.length, 0);
  store.flush(later);
  const reopened = historyStore(space);
  assert.equal(reopened.read("local", "1h", later).points.length, 1);
  assert.equal(reopened.read("local", "7d", later).points.length, 2);
  const path = join(root, "packages/monitoring/history.json");
  writeFileSync(path, "{ not json");
  const warnings: unknown[] = []; const warn = console.warn; console.warn = (...args) => { warnings.push(args); };
  t.after(() => { console.warn = warn; });
  assert.equal(historyStore(space).read("local", "1h", later).points.length, 0, "a damaged file is an empty chart");
  assert.equal(warnings.length, 1);
  writeFileSync(path, JSON.stringify({ v: 1, machines: { "../evil": { "1h": [[1, 1, 1, 1]] }, __proto__x: {}, local: { "1h": [[later, "x", 1, 1], [later, 1, 1, null]] } } }));
  assert.deepEqual(historyStore(space).read("local", "1h", later).points, [[later, 1, 1, null]], "only valid machines and points load");
});

test("the sampler reads the server once a minute for each Space with a local project, and never dials SSH", async (t) => {
  const recorded: string[] = []; let reads = 0;
  const projects = [{ id: "a", spaceId: "one" }, { id: "b", spaceId: "one" }, { id: "c", spaceId: "two" }, { id: "d", spaceId: "three", remote: { kind: "ssh", connectionId: "x" } }];
  const sampler = createHistorySampler({ projects: { list: async () => projects } } as never, (spaceId) => recorded.push(spaceId),
    async () => { reads += 1; return {} as never; });
  await sampler.tick();
  assert.deepEqual(recorded, ["one", "two"]);
  assert.equal(reads, 1, "one reading, however many Spaces");
  const quiet = createHistorySampler({ projects: { list: async () => [projects[3]!] } } as never, () => assert.fail("nothing to record"), async () => assert.fail("nothing to read"));
  await quiet.tick();
  t.after(() => { sampler.stop(); quiet.stop(); });
});
