import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext, RemoteHost } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createPiProvider } from "../src/serverEntry.ts";
import { readLocalPiConfig } from "../src/remoteConfig.ts";

// The fake host runs the remote command line locally with its own HOME: enter
// the workspace, exec argv. A fixture named `pi` answers the RPC mode
// handshake and reports models when the host or its agent dir has some.
const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-pi-remote-")));
const bin = join(root, "bin");
const workspace = join(root, "remote-workspace");
mkdirSync(bin);
mkdirSync(workspace);
const agent = join(root, "pi.mjs");
writeFileSync(agent, `
import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("0.85.2"); process.exit(0); }
if (process.argv.includes("--list-models")) {
  const configured = process.env.PI_CODING_AGENT_DIR
    ? existsSync(process.env.PI_CODING_AGENT_DIR + "/auth.json")
    : existsSync(process.env.HOME + "/host-models");
  console.log(configured ? "provider  model\\nopencode  kimi" : "No models available. Use /login to log into a provider");
  process.exit(0);
}
const log = (entry) => appendFileSync("pi-log.jsonl", JSON.stringify(entry) + "\\n");
log({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    log({ command: message.type });
    if (message.id) process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: {} }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`);
writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`);
chmodSync(join(bin, "pi"), 0o755);

const commands: Array<readonly string[]> = [];
/** A fake host whose HOME is its own directory; `models` gives it a Pi login. */
const fakeHost = (label: string, models: boolean): { remote: RemoteHost; home: string } => {
  const home = join(root, "homes", label);
  mkdirSync(home, { recursive: true });
  if (models) writeFileSync(join(home, "host-models"), "");
  return {
    home,
    remote: {
      label,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      start: async () => { throw new Error("unused"); },
      forward: async () => { throw new Error("unused"); },
      processCommand(argv, opts) {
        commands.push(argv);
        const env = Object.entries(opts?.env ?? {}).map(([name, value]) => `${name}=${value}`);
        return { command: "env", args: ["-u", "PI_CODING_AGENT_DIR", `HOME=${home}`, `PATH=${bin}:${process.env.PATH}`, ...env, "sh", "-c", `cd "$0" 2>/dev/null || cd "$HOME"; exec "$@"`, opts?.cwd ?? "", ...argv] };
      },
    },
  };
};
const project = { id: "p", path: workspace, name: "remote", spaceId: "s", createdAt: 0, remote: { kind: "ssh", connectionId: "conn-1" } };
const projects = { get: async (id: string) => (id === "p" ? project : undefined) };
const hostFor = (remote: RemoteHost, harnessConfig?: Record<string, string>) => ({
  pluginId: "backend-pi",
  projects,
  forSpace: () => ({ projects }),
  services: { get: () => ({ host: () => remote, get: (id: string) => (id === "conn-1" ? { harnessConfig } : undefined) }) },
  spaceStorage: () => ({
    path: (relative: string) => join(root, "storage", relative),
    packageDir: () => join(root, "storage", "package"),
  }),
} as unknown as ServerPackageHost);
const host = hostFor(fakeHost("dev@remote", true).remote);

// This machine's Pi configuration: API keys, an OAuth login, settings with a
// local package path and a model catalog.
const localAgentDir = join(root, "local-agent");
mkdirSync(localAgentDir);
writeFileSync(join(localAgentDir, "auth.json"), JSON.stringify({
  opencode: { type: "api_key", key: "local-key" },
  anthropic: { type: "oauth", refresh: "local-refresh", access: "local-access", expires: 0 },
}));
writeFileSync(join(localAgentDir, "settings.json"), JSON.stringify({
  defaultProvider: "opencode",
  defaultModel: "kimi",
  theme: "dark",
  sessionDir: "/local/sessions",
  packages: ["npm:pi-commandcode-provider", "../local-extension", { source: "git:github.com/example/tools" }],
}));
writeFileSync(join(localAgentDir, "models-store.json"), JSON.stringify({ opencode: { models: [] } }));
process.env.PI_CODING_AGENT_DIR = localAgentDir;

const launchLog = async () => {
  const log = join(workspace, "pi-log.jsonl");
  for (let attempt = 0; attempt < 100 && !existsSync(log); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  const [launch] = readFileSync(log, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  rmSync(log);
  return launch;
};
const context: HarnessContext = { space: { spaceId: "s" } as HarnessContext["space"], spaceId: "s", projectId: "p", cwd: workspace, sessionId: "canonical", remote: true };

test("the default Pi harness declares remote conversations and local configuration; extra accounts do not", async () => {
  assert.equal(createPiProvider(host).descriptor.remoteHost?.sessions, true);
  assert.equal(createPiProvider(host).descriptor.remoteHost?.localConfig, true);
  const account = createPiProvider(host, { harnessId: "pi-work", name: "Work", dir: join(root, "work") } as never);
  assert.equal(account.descriptor.remoteHost?.sessions, undefined);
  assert.equal((await account.probe(context)).installed, false);
  await assert.rejects(account.createRuntime(context), /run on this machine only/);
});

test("a remote project probes Pi on its host", async () => {
  const probe = await createPiProvider(host).probe(context);
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "0.85.2");
});

test("Pi RPC runs on the host in the project path with the host's own configuration", async () => {
  const provider = createPiProvider(host);
  const runtime = await provider.createRuntime(context);
  try {
    assert.deepEqual(commands.at(-1), ["pi", "--mode", "rpc"]);
    assert.deepEqual(await launchLog(), { argv: ["--mode", "rpc"], cwd: workspace, agentDir: null, sessionDir: null });
    assert.equal(runtime.completeSmallModel, undefined);
  } finally {
    await runtime.dispose();
  }
  const release = await provider.releaseExecution!(context, {} as never, "op-1");
  assert.equal(release.kind, "rejected");
});

test("a host with no Pi models runs on this machine's projected Pi configuration", async () => {
  const { remote, home } = fakeHost("fresh@remote", false);
  const runtime = await createPiProvider(hostFor(remote)).createRuntime(context);
  const projected = join(home, ".local", "share", "polyth", "runtimes", "pi", "agent");
  try {
    assert.deepEqual(await launchLog(), {
      argv: ["--mode", "rpc"],
      cwd: workspace,
      agentDir: projected,
      sessionDir: join(home, ".pi", "agent", "sessions"),
    });
  } finally {
    await runtime.dispose();
  }
  // Only API keys cross; the OAuth login stays on this machine.
  assert.deepEqual(JSON.parse(readFileSync(join(projected, "auth.json"), "utf8")), { opencode: { type: "api_key", key: "local-key" } });
  assert.equal(statSync(join(projected, "auth.json")).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(projected, "settings.json"), "utf8")), {
    defaultProvider: "opencode",
    defaultModel: "kimi",
    packages: ["npm:pi-commandcode-provider", { source: "git:github.com/example/tools" }],
  });
  assert.equal(existsSync(join(projected, "models-store.json")), true);
  assert.equal(existsSync(join(projected, "models.json")), false);
});

test("a host with no Pi models keeps its own configuration when this machine has none either", async () => {
  const empty = join(root, "empty-agent");
  mkdirSync(empty);
  writeFileSync(join(empty, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "r" } }));
  assert.equal((await readLocalPiConfig(empty)).usable, false);
  process.env.PI_CODING_AGENT_DIR = empty;
  try {
    const { remote, home } = fakeHost("bare@remote", false);
    const runtime = await createPiProvider(hostFor(remote)).createRuntime(context);
    try {
      assert.deepEqual(await launchLog(), { argv: ["--mode", "rpc"], cwd: workspace, agentDir: null, sessionDir: null });
    } finally {
      await runtime.dispose();
    }
    assert.equal(existsSync(join(home, ".local")), false);
  } finally {
    process.env.PI_CODING_AGENT_DIR = localAgentDir;
  }
});

test("a connection set to the server's own Pi configuration never receives this machine's", async () => {
  const { remote, home } = fakeHost("own@remote", false);
  const runtime = await createPiProvider(hostFor(remote, { pi: "remote" })).createRuntime(context);
  try {
    assert.deepEqual(await launchLog(), { argv: ["--mode", "rpc"], cwd: workspace, agentDir: null, sessionDir: null });
  } finally {
    await runtime.dispose();
  }
  assert.equal(existsSync(join(home, ".local")), false);
});
