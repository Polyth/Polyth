import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext, RemoteHost } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createAcpProvider, type RegisteredAcpProfile } from "../src/profile.ts";

// A stand-in for the SSH host: `processCommand` returns a local `sh` line that
// does what the remote shell would — enter the workspace and exec argv.
const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-acp-remote-")));
const bin = join(root, "bin");
const workspace = join(root, "remote-workspace");
const agent = join(root, "agent.mjs");
writeFileSync(agent, `
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("fake-acp 1.2.3"); process.exit(0); }
const log = (entry) => appendFileSync("agent-log.jsonl", JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2), cwd: process.cwd(), secret: process.env.POLYTH_REMOTE_TEST_SECRET ?? null });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    log({ method: message.method });
    if (message.id === undefined) continue;
    const result = message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} }
      : message.method === "session/new" ? { sessionId: "native-1" } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`);
mkdirSync(bin);
mkdirSync(workspace);
writeFileSync(join(bin, "fake-acp"), `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`);
chmodSync(join(bin, "fake-acp"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const commands: Array<readonly string[]> = [];
const remote: RemoteHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand(argv, opts) {
    commands.push(argv);
    return { command: "sh", args: ["-c", 'cd "$0" 2>/dev/null || cd "$HOME"; exec "$@"', opts?.cwd ?? "", ...argv] };
  },
};

const project = { id: "p", path: workspace, name: "remote", spaceId: "s", createdAt: 0, remote: { kind: "ssh", connectionId: "conn-1" } };
const projects = { get: async (id: string) => (id === "p" ? project : undefined) };
const host = {
  projects,
  forSpace: () => ({ projects }),
  services: { get: () => ({ host: (id: string) => { assert.equal(id, "conn-1"); return remote; } }) },
  spaceStorage: () => ({ path: (relative: string) => join(root, "storage", relative) }),
} as unknown as ServerPackageHost;

const space = { spaceId: "s" } as HarnessContext["space"];
const remoteContext: HarnessContext = { space, spaceId: "s", projectId: "p", cwd: workspace, sessionId: "canonical", remote: true };

const profile = (over: Partial<RegisteredAcpProfile["descriptor"]> = {}): RegisteredAcpProfile => ({
  descriptor: { id: "fake", name: "Fake", integration: "ACP v1", priority: 1, remoteHost: { binary: "fake-acp" }, ...over },
  command: "local-binary-must-not-run",
  args: ["acp"],
  env: { ...process.env, POLYTH_REMOTE_TEST_SECRET: "local-only" },
  probe: async () => { throw new Error("the local probe must not run for a remote project"); },
});

const agentLog = () => readFileSync(join(workspace, "agent-log.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

test("an ACP harness with a remote binary declares remote conversations", () => {
  const provider = createAcpProvider(host, profile());
  assert.equal(provider.descriptor.remoteHost?.sessions, true);
  const local = createAcpProvider(host, profile({ remoteHost: undefined }));
  assert.equal(local.descriptor.remoteHost?.sessions, undefined);
});

test("a remote project probes the harness binary on its host, not locally", async () => {
  const provider = createAcpProvider(host, profile());
  const probe = await provider.probe(remoteContext);
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "1.2.3");
  const missing = await createAcpProvider(host, profile({ id: "missing", remoteHost: { binary: "no-such-acp-binary" } }))
    .probe(remoteContext);
  assert.equal(missing.installed, false);
  assert.match(missing.message ?? "", /Install no-such-acp-binary on dev@remote/);
});

test("a remote project's ACP runtime runs on the host in the project path with no local env", async () => {
  commands.length = 0;
  const provider = createAcpProvider(host, profile());
  const runtime = await provider.createRuntime(remoteContext);
  try {
    assert.deepEqual(commands.at(-1), ["fake-acp", "acp"]);
    const [launch, ...calls] = agentLog();
    assert.deepEqual(launch, { argv: ["acp"], cwd: workspace, secret: null });
    assert.ok(calls.some((entry) => entry.method === "initialize"));
  } finally {
    await runtime.dispose();
  }
  const release = await provider.releaseExecution!(remoteContext, {
    canonicalSessionId: "canonical", backendSessionId: "native-1", authorityId: "a", generation: 1,
    continuity: "generation-only", location: { directory: workspace },
  } as never, "op-1");
  assert.equal(release.kind, "rejected");
});

test("an extra account of a multi-account ACP harness stays local", async () => {
  const provider = createAcpProvider(host, profile({
    id: "fake-work",
    accounts: { family: "fake", endpoint: "/api/backend-fake/accounts" },
  }));
  assert.equal(provider.descriptor.remoteHost?.sessions, undefined);
  const probe = await provider.probe(remoteContext);
  assert.equal(probe.installed, false);
  await assert.rejects(provider.createRuntime(remoteContext), /runs on this machine only/i);
});
