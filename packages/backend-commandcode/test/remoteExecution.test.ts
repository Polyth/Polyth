import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessContext, RemoteHost } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { readRemoteFile, remoteHarnessLaunch, writeRemoteFile, type RemoteProcessHost } from "@polyth/harness-runtime/remote-host";
import { COMMANDCODE_REQUIRED_FLAGS } from "../src/discovery.ts";
import { createCommandCodeRpc } from "../src/rpc.ts";
import { createCommandCodeProvider } from "../src/serverEntry.ts";

// The fake host runs the remote command line locally with its own HOME, the
// way sshd would: enter the workspace, apply env, exec argv.
const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-cc-remote-")));
const bin = join(root, "bin");
const home = join(root, "remote-home");
const workspace = join(root, "remote-workspace");
for (const dir of [bin, home, workspace]) mkdirSync(dir);
const cli = join(root, "command-code.mjs");
writeFileSync(cli, `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("command-code 2.3.4"); process.exit(0); }
if (args.includes("--help")) { console.log(${JSON.stringify(COMMANDCODE_REQUIRED_FLAGS.join("\n"))}); process.exit(0); }
if (args[0] === "status") { console.log(JSON.stringify({ authenticated: true, email: "dev@host", cwd: process.cwd() })); process.exit(0); }
if (args.includes("--list-models")) { console.log("anthropic/claude-sonnet-5-5\\nopenai/gpt-6"); process.exit(0); }
process.exit(2);
`);
writeFileSync(join(bin, "command-code"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
chmodSync(join(bin, "command-code"), 0o755);

const launches: Array<readonly string[]> = [];
const remote: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand(argv, opts) {
    launches.push(argv);
    const env = Object.entries(opts?.env ?? {}).map(([name, value]) => `${name}=${value}`);
    return {
      command: "sh",
      args: ["-c", `HOME="${home}"; export HOME; PATH="${bin}:${dirname(process.execPath)}:$PATH"; cd "$0" 2>/dev/null || cd "$HOME"; exec env "$@"`, opts?.cwd ?? "", ...env, ...argv],
    };
  },
};
const project = { id: "p", path: workspace, name: "remote", spaceId: "s", createdAt: 0, remote: { kind: "ssh", connectionId: "conn-1" } };
const projects = { get: async (id: string) => (id === "p" ? project : undefined) };
const host = {
  pluginId: "backend-commandcode",
  projects,
  forSpace: () => ({ projects }),
  services: { get: () => ({ host: () => remote as RemoteHost }) },
  spaceStorage: () => ({
    path: (relative: string) => join(root, "local", relative),
    packageDir: () => join(root, "local", "package"),
  }),
} as unknown as ServerPackageHost;
const context: HarnessContext = { space: { spaceId: "s" } as HarnessContext["space"], spaceId: "s", projectId: "p", cwd: workspace, sessionId: "canonical", remote: true };

test("the default Command Code harness declares remote conversations; extra accounts do not", async () => {
  assert.equal(createCommandCodeProvider(host).descriptor.remoteHost?.sessions, true);
  const account = createCommandCodeProvider(host, { harnessId: "commandcode-work", name: "Work", dir: join(root, "work") } as never);
  assert.equal(account.descriptor.remoteHost?.sessions, undefined);
  assert.equal((await account.probe(context)).installed, false);
});

test("a remote project probes and discovers Command Code on its host", async () => {
  const provider = createCommandCodeProvider(host);
  const probe = await provider.probe(context);
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "2.3.4");
  const discovery = await provider.discover!(context);
  assert.equal(discovery.state, "ready");
  assert.deepEqual(discovery.catalog?.models?.map((model) => model.modelID), ["anthropic/claude-sonnet-5-5", "openai/gpt-6"]);
});

test("a remote Command Code runtime runs its worker on the host beside a private bridge", async () => {
  launches.length = 0;
  const runtime = await createCommandCodeProvider(host).createRuntime(context);
  try {
    const worker = launches.find((argv) => argv[0] === "node");
    assert.ok(worker, "the worker is launched on the host");
    const workerPath = worker[1]!;
    assert.ok(workerPath.startsWith(join(home, ".local/share/polyth/runtimes/commandcode/generated/")));
    const bridgePath = join(dirname(workerPath), "polyth-commandcode-bridge.ts");
    assert.equal(statSync(workerPath).mode & 0o777, 0o600);
    assert.equal(statSync(bridgePath).mode & 0o777, 0o600);
    assert.equal(runtime.completeSmallModel, undefined);
    assert.deepEqual((await runtime.models()).map((model) => model.modelID), ["anthropic/claude-sonnet-5-5", "openai/gpt-6"]);
  } finally {
    await runtime.dispose();
  }
});

test("the remote worker answers over the SSH pipes", async () => {
  const runtime = await createCommandCodeProvider(host).createRuntime({ ...context, sessionId: "second" });
  await runtime.dispose();
  const worker = launches.findLast((argv) => argv[0] === "node")!;
  const rpc = await createCommandCodeRpc({
    workerPath: worker[1]!,
    command: "command-code",
    bridgePath: join(dirname(worker[1]!), "polyth-commandcode-bridge.ts"),
    cwd: workspace,
    launch: remoteHarnessLaunch(remote, ["node", worker[1]!], {
      cwd: workspace,
      env: { POLYTH_COMMANDCODE_BIN: "command-code", POLYTH_COMMANDCODE_BRIDGE_PATH: join(dirname(worker[1]!), "polyth-commandcode-bridge.ts") },
    }),
  });
  try {
    assert.deepEqual(await rpc.request({ type: "ping" }, 10_000), { ok: true });
  } finally {
    await rpc.close();
  }
});

test("binding receipts round-trip through the host's filesystem", async () => {
  const file = join(home, "nested", "binding.json");
  assert.equal(await readRemoteFile(remote, file), undefined);
  await writeRemoteFile(remote, file, '{"version":1}');
  assert.equal(readFileSync(file, "utf8"), '{"version":1}');
  assert.equal(await readRemoteFile(remote, file), '{"version":1}');
  await writeRemoteFile(remote, file, "replaced", { ifAbsent: true });
  assert.equal(await readRemoteFile(remote, file), '{"version":1}');
});
