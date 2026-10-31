import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentCapabilityContribution, Project, RouteRequest, SpaceContext, SpaceStorage, ToolExecutionContext } from "@polyth/contracts";
import { createServerServiceRegistry, discoverServerPackages, serverServiceKey, SESSION_PURPOSES, type ServerPackageHost } from "@polyth/plugins";
import { boundedTail, discoverHostLogs, journalArgs, journalCommand, localHostLogTail, localLogTail, LOG_BYTES, parseRemoteFile, parseRemoteHostLogs, parseRemoteMetrics, parseServices, REMOTE_METRICS_COMMAND, remoteFileCommand, serviceCommand } from "../src/collect.ts";
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
  assert.deepEqual(defaultPolicy().agentAccess, { metrics: false, services: false, logs: false });
  for (const patch of [
    { agentAccess: { metrics: "true", services: false, logs: false } },
    { serviceUnits: ["nginx.service'; reboot; '"] }, { serviceUnits: ["--help.service"] },
    { logPaths: ["../outside.log"] }, { logPaths: ["/etc/shadow"] }, { logPaths: [".git/private.log"] },
    { logPaths: ["/var/log/../../etc/shadow"] }, { logPaths: ["/proc/self/environ.log"] }, { logPaths: ["/var/log/x'; reboot; '.log"] },
    { logPaths: ["journal:$(reboot).service"] }, { logPaths: ["journalctl"] }, { logPaths: Array.from({ length: 25 }, (_, i) => `app-${i}.log`) },
    { logPaths: ["logs\\private.log"] }, { logPaths: ["config.env"] }, { logPaths: ["logs/a\u0000.log"] },
    { memoryWarningPercent: NaN }, { loadWarningRatio: Infinity },
  ]) assert.throws(() => parsePolicy({ ...defaultPolicy(), ...patch }, 1), { code: "invalid-input" });
  const hostWide = ["journal", "kernel", "journal:nginx.service", "/var/log/syslog", "/var/log/nginx/access.log", "/home/app/.pm2/logs/api.log", "logs/app.log"];
  assert.deepEqual(parsePolicy({ ...defaultPolicy(), logPaths: hostWide }, 1).logPaths, hostWide);
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
