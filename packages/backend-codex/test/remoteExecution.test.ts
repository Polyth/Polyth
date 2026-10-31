import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext, RemoteHost } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { connectCodex, createCodexProvider } from "../src/serverEntry.ts";

// The fake host runs the remote command line locally: enter the workspace,
// exec argv. A fixture named `codex` answers the App Server handshake.
const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-codex-remote-")));
const bin = join(root, "bin");
const workspace = join(root, "remote-workspace");
mkdirSync(bin);
mkdirSync(workspace);
const server = join(root, "app-server.mjs");
writeFileSync(server, `
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("codex-cli 9.8.7"); process.exit(0); }
const log = (entry) => appendFileSync("codex-log.jsonl", JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME ?? null });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    log({ method: message.method });
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`);
writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`);
chmodSync(join(bin, "codex"), 0o755);

const remote: RemoteHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand: (argv, opts) => ({
    command: "sh",
    args: ["-c", `PATH="${bin}:$PATH"; cd "$0" 2>/dev/null || cd "$HOME"; exec "$@"`, opts?.cwd ?? "", ...argv],
  }),
};
const project = { id: "p", path: workspace, name: "remote", spaceId: "s", createdAt: 0, remote: { kind: "ssh", connectionId: "conn-1" } };
const projects = { get: async (id: string) => (id === "p" ? project : undefined) };
const host = {
  projects,
  forSpace: () => ({ projects }),
  services: { get: () => ({ host: () => remote }) },
  spaceStorage: () => ({ path: (relative: string) => join(root, "storage", relative) }),
} as unknown as ServerPackageHost;
const context: HarnessContext = { space: { spaceId: "s" } as HarnessContext["space"], spaceId: "s", projectId: "p", cwd: workspace, remote: true };

test("the default Codex harness declares remote conversations; extra accounts do not", async () => {
  assert.equal(createCodexProvider(host).descriptor.remoteHost?.sessions, true);
  const account = createCodexProvider(host, { harnessId: "codex-work", name: "Work", dir: join(root, "work") } as never);
  assert.equal(account.descriptor.remoteHost?.sessions, undefined);
  assert.equal((await account.probe(context)).installed, false);
});

test("a remote project probes Codex on its host", async () => {
  const probe = await createCodexProvider(host).probe(context);
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "9.8.7");
});

test("the Codex App Server runs on the host in the project path without a local CODEX_HOME", async () => {
  const rpc = await connectCodex(context, undefined, undefined, remote as never);
  await rpc.close();
  const [launch, ...calls] = readFileSync(join(workspace, "codex-log.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(launch, { argv: ["app-server"], cwd: workspace, home: null });
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "initialized"]);
});
