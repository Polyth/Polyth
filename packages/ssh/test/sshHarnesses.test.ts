import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessDescriptor,
  HarnessRegistry,
  ProjectService,
  RemoteHost,
  SshConnectionDto,
} from "@polyth/contracts";
import { createSshService, type SshRunner } from "@polyth/ssh";
import type { RouteRequest } from "../../server/src/http.ts";
import {
  installRemoteHarness,
  listRemoteHarnesses,
  parseProbe,
  probeScript,
  remoteHarnessTargets,
  versionFrom,
  type RemoteHarnessTarget,
} from "../src/harnesses.ts";
import { sshRoutes } from "../src/serverEntry.ts";
import { connectionSummary, harnessStatus, nextHarnessConfig } from "../widgets/ssh/sshUi.ts";

const tempService = (runner: SshRunner = async () => ({ code: 0, stdout: "", stderr: "" })) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-ssh-harness-"));
  const file = join(dir, "ssh.json");
  return { file, ssh: createSshService({ file, socketDir: join(dir, "sock"), runner }) };
};

const descriptor = (over: Partial<HarnessDescriptor> & { id: string }): HarnessDescriptor => ({
  name: over.id, integration: "test", priority: 0, ...over,
});

const fakeRegistry = (entries: Array<{ descriptor: HarnessDescriptor; enabled?: boolean }>): HarnessRegistry => ({
  register: () => ({ dispose() {} }),
  providers: () => entries.map((entry) => ({ descriptor: entry.descriptor }) as never),
  get: (id) => {
    const entry = entries.find((item) => item.descriptor.id === id);
    return entry ? ({ descriptor: entry.descriptor } as never) : undefined;
  },
  probe: async () => [],
  resolve: async () => { throw new Error("unused"); },
  roster: async () => entries.map((entry) => ({
    identity: { id: entry.descriptor.id, name: entry.descriptor.name, integration: entry.descriptor.integration },
    policy: { enabled: entry.enabled ?? true, priority: entry.descriptor.priority, autoSelect: true },
  })),
  snapshots: async () => [],
  invalidate: () => {},
});

const context = { spaceId: "s", projectId: "__default__", cwd: "/", remote: true };

const fakeHost = (reply: (command: string) => { code: number; stdout: string; stderr?: string }) => {
  const commands: string[] = [];
  const host: RemoteHost = {
    label: "dev@box",
    exec: async (command) => {
      commands.push(command);
      const result = reply(command);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" };
    },
    start: async () => { throw new Error("unused"); },
    forward: async () => { throw new Error("unused"); },
  };
  return { host, commands };
};

const connection = (over: Partial<SshConnectionDto> = {}): SshConnectionDto => ({
  id: "c1", name: "Box", host: "box", authMode: "agent", createdAt: 1, ...over,
});

const opencode: RemoteHarnessTarget = {
  harnessId: "opencode", name: "OpenCode", binary: "opencode",
  installCommand: "curl -fsSL https://opencode.ai/v2/install | bash", sessions: true, localConfig: true,
};
const claude: RemoteHarnessTarget = {
  harnessId: "claude", name: "Claude Code", binary: "claude",
  installCommand: "curl -fsSL https://claude.ai/install.sh | bash", sessions: false, localConfig: false,
};

test("connections store only `remote` configuration exceptions and persist them", () => {
  const { ssh, file } = tempService();
  const created = ssh.create({ host: "box", harnessConfig: { opencode: "remote", claude: "local" } });
  assert.deepEqual(created.harnessConfig, { opencode: "remote" });
  const renamed = ssh.update(created.id, { name: "Renamed" });
  assert.deepEqual(renamed.harnessConfig, { opencode: "remote" }, "omitted harnessConfig keeps the stored one");
  const reopened = createSshService({ file, socketDir: join(file, "..", "sock2") });
  assert.deepEqual(reopened.get(created.id)?.harnessConfig, { opencode: "remote" });
  const cleared = ssh.update(created.id, { harnessConfig: { opencode: "local" } });
  assert.equal(cleared.harnessConfig, undefined);
});

test("connections reject malformed harness configuration", () => {
  const { ssh } = tempService();
  assert.throws(() => ssh.create({ host: "box", harnessConfig: { opencode: "server" as never } }), /local" or "remote/);
  assert.throws(() => ssh.create({ host: "box", harnessConfig: { "../x": "remote" } }), /invalid harness id/);
  assert.throws(() => ssh.create({ host: "box", harnessConfig: ["remote"] as never }), /must be an object/);
});

test("targets list enabled harness families in priority order with their declared installer", async () => {
  const registry = fakeRegistry([
    { descriptor: descriptor({ id: "claude", name: "Claude Code", priority: 20, remoteHost: { binary: "claude", installCommand: "install-claude" }, accounts: { family: "claude", endpoint: "/x" } }) },
    { descriptor: descriptor({ id: "claude-work", name: "Claude Code", priority: 21, remoteHost: { binary: "claude" }, accounts: { family: "claude", endpoint: "/x" } }) },
    { descriptor: descriptor({ id: "opencode", name: "OpenCode", priority: 0, remoteHost: { binary: "opencode", installCommand: "install-oc", sessions: true, localConfig: true } }) },
    { descriptor: descriptor({ id: "pi", priority: 70, remoteHost: { binary: "pi", installCommand: "install-pi" } }), enabled: false },
    { descriptor: descriptor({ id: "fx", priority: 40, setupUrl: "https://fx.example/docs" }) },
    { descriptor: descriptor({ id: "evil", priority: 50, remoteHost: { binary: "rm -rf /", installCommand: "x" } }) },
  ]);
  const targets = await remoteHarnessTargets(registry, context);
  assert.deepEqual(targets.map((target) => target.harnessId), ["opencode", "claude", "fx", "evil"]);
  assert.equal(targets[0]!.sessions, true);
  assert.equal(targets[0]!.localConfig, true);
  assert.equal(targets[1]!.installCommand, "install-claude");
  assert.equal(targets[2]!.binary, undefined);
  assert.equal(targets[2]!.setupUrl, "https://fx.example/docs");
  assert.equal(targets[3]!.binary, undefined, "an unsafe binary name is never probed");
  assert.equal(targets[3]!.installCommand, undefined, "nor installed");
});

test("one probe script reports every binary and parses versions", () => {
  const script = probeScript(["opencode", "claude"]);
  assert.match(script, /for B in 'opencode' 'claude'; do/);
  assert.match(script, /\$HOME\/\.local\/bin/);
  const facts = parseProbe([
    "noise",
    "POLYTH_HARNESS\topencode\t1\topencode 2.0.24",
    "POLYTH_HARNESS\tclaude\t0\t",
    "POLYTH_HARNESS\tbad name\t1\tx",
  ].join("\n"));
  assert.deepEqual(facts.get("opencode"), { installed: true, version: "2.0.24" });
  assert.deepEqual(facts.get("claude"), { installed: false });
  assert.equal(facts.size, 2);
  assert.equal(versionFrom("2.1.291 (Claude Code)"), "2.1.291");
  assert.equal(versionFrom("v0.9.1-beta.2"), "0.9.1-beta.2");
  assert.equal(versionFrom(""), undefined);
});

test("listing without a probe never reaches the host", async () => {
  const { host, commands } = fakeHost(() => ({ code: 0, stdout: "" }));
  const result = await listRemoteHarnesses({
    connection: connection({ harnessConfig: { opencode: "remote" } }), host, targets: [opencode, claude], probe: false,
  });
  assert.equal(commands.length, 0);
  assert.equal(result.checkedAt, undefined);
  assert.deepEqual(result.items.map((item) => [item.harnessId, item.installed, item.configSource]), [
    ["opencode", "unknown", "remote"],
    ["claude", "unknown", "local"],
  ]);
  assert.equal(result.items[0]!.installCommand, opencode.installCommand);
});

test("a probe reports install state; an unreachable host stays unknown with a reason", async () => {
  const live = fakeHost(() => ({
    code: 0,
    stdout: "POLYTH_HARNESS\topencode\t1\t2.0.24\nPOLYTH_HARNESS\tclaude\t0\t\n",
  }));
  const result = await listRemoteHarnesses({ connection: connection(), host: live.host, targets: [opencode, claude], probe: true, now: () => 9 });
  assert.equal(live.commands.length, 1, "one round trip for every harness");
  assert.equal(result.checkedAt, 9);
  assert.deepEqual(result.items.map((item) => [item.installed, item.version]), [[true, "2.0.24"], [false, undefined]]);

  const down = fakeHost(() => ({ code: 255, stdout: "", stderr: "ssh: connect to host box port 22: No route to host" }));
  const failed = await listRemoteHarnesses({ connection: connection(), host: down.host, targets: [opencode], probe: true });
  assert.match(failed.message ?? "", /No route to host/);
  assert.equal(failed.checkedAt, undefined);
  assert.equal(failed.items[0]!.installed, "unknown");
});

test("install runs the declared command, proves the binary and reports the version", async () => {
  const { host, commands } = fakeHost((command) => command.includes("POLYTH_INSTALL")
    ? { code: 0, stdout: "installed\n" }
    : { code: 0, stdout: "POLYTH_HARNESS\tclaude\t1\t2.1.291 (Claude Code)\n" });
  const result = await installRemoteHarness({ connection: connection(), host, target: claude });
  assert.equal(result.installed, true);
  assert.equal(result.version, "2.1.291");
  assert.match(commands[0]!, /\( curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash \) <\/dev\/null 2>&1/);
  assert.match(commands[0]!, /command -v 'claude'/);
});

test("install failures explain themselves; a harness without an installer refuses", async () => {
  const failing = fakeHost(() => ({ code: 127, stdout: "bash: npm: command not found\nPOLYTH_INSTALL_EXIT=127\n" }));
  await assert.rejects(
    installRemoteHarness({ connection: connection(), host: failing.host, target: claude }),
    (error: Error & { code?: string }) => error.code === "unavailable" && /npm: command not found/.test(error.message) && !/POLYTH_INSTALL_EXIT/.test(error.message),
  );
  const offPath = fakeHost(() => ({ code: 79, stdout: "POLYTH_INSTALL_NOT_ON_PATH\n" }));
  await assert.rejects(
    installRemoteHarness({ connection: connection(), host: offPath.host, target: claude }),
    /"claude" is not on the PATH/,
  );
  const manual = fakeHost(() => ({ code: 0, stdout: "" }));
  await assert.rejects(
    installRemoteHarness({ connection: connection(), host: manual.host, target: { harnessId: "fx", name: "fx", sessions: false, localConfig: false } }),
    (error: Error & { code?: string }) => error.code === "unsupported",
  );
  assert.equal(manual.commands.length, 0);
});

test("harness routes list, probe and install only enabled harnesses, one install at a time", async () => {
  let installs = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner: SshRunner = async (args) => {
    const command = args.at(-1)!;
    if (command.includes("POLYTH_INSTALL")) {
      installs += 1;
      await gate;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.includes("POLYTH_HARNESS")) {
      return { code: 0, stdout: `POLYTH_HARNESS\topencode\t${installs ? 1 : 0}\t${installs ? "2.0.24" : ""}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const { ssh } = tempService(runner);
  const conn = ssh.create({ host: "box" });
  const registry = fakeRegistry([
    { descriptor: descriptor({ id: "opencode", name: "OpenCode", remoteHost: { binary: "opencode", installCommand: "install-oc", sessions: true } }) },
    { descriptor: descriptor({ id: "pi", remoteHost: { binary: "pi", installCommand: "install-pi" } }), enabled: false },
  ]);
  const routes = sshRoutes({ ssh, projects: { list: async () => [] } as unknown as ProjectService, harnesses: () => registry });
  const call = async (method: string, path: string) => {
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    try {
      await routes({
        url, path: url.pathname, method, space: { spaceId: "s" }, principal: { kind: "local-user" },
        body: async () => ({}), json: (_code: number, value: unknown) => { payload = value; },
      } as unknown as RouteRequest);
      return { payload, error: undefined as (Error & { code?: string }) | undefined };
    } catch (error) {
      return { payload: undefined, error: error as Error & { code?: string } };
    }
  };

  const probed = await call("GET", `/api/ssh/connections/${conn.id}/harnesses?probe=1`);
  assert.deepEqual((probed.payload as { items: Array<{ harnessId: string; installed: unknown }> }).items
    .map((item) => [item.harnessId, item.installed]), [["opencode", false]]);

  const disabled = await call("POST", `/api/ssh/connections/${conn.id}/harnesses/pi/install`);
  assert.equal(disabled.error?.code, "not-found");
  const unknownConn = await call("GET", "/api/ssh/connections/nope/harnesses");
  assert.equal(unknownConn.error?.code, "not-found");

  const first = call("POST", `/api/ssh/connections/${conn.id}/harnesses/opencode/install`);
  const second = call("POST", `/api/ssh/connections/${conn.id}/harnesses/opencode/install`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(installs, 1, "a concurrent request joins the running install");
  assert.equal((a.payload as { installed: boolean }).installed, true);
  assert.deepEqual(a.payload, b.payload);
});

test("UI helpers: status text, stored exceptions and the row summary", () => {
  assert.equal(harnessStatus({ installed: true, version: "2.0.24" }).tone, "ok");
  assert.match(harnessStatus({ installed: true, version: "2.0.24" }).text, /2\.0\.24/);
  assert.equal(harnessStatus({ installed: false }).tone, "muted", "not installed is not an error");
  assert.equal(harnessStatus({ installed: "unknown" }).tone, "muted");
  assert.deepEqual(nextHarnessConfig(undefined, "opencode", "remote"), { opencode: "remote" });
  assert.deepEqual(nextHarnessConfig({ opencode: "remote", pi: "remote" }, "opencode", "local"), { pi: "remote" });
  assert.deepEqual(connectionSummary({ authMode: "agent" }, 0), ["SSH agent"]);
  assert.deepEqual(connectionSummary({ authMode: "identity-file" }, 2), ["Key file", "2 projects"]);
});
