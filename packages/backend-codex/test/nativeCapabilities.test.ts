import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { createStdioRpc, type RpcPeer } from "@polyth/harness-runtime";
import { codexOverlays, createCodexProvisioner } from "../src/provisioner.ts";

const enabled = process.env.POLYTH_NATIVE_CAPABILITY_TESTS === "1";
const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), "polyth-codex-native-"));
const contextAt = (storageDir: string, spaceId: string, cwd: string): HarnessContext => {
  mkdirSync(storageDir, { recursive: true });
  const space: SpaceContext = {
    spaceId,
    spaceSlug: spaceId,
    userId: "native-test",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
  return { spaceId, projectId: "project", sessionId: `session-${spaceId}`, cwd, space };
};
const skillPlan: HarnessProvisioningPlan = {
  harnessId: "codex",
  desiredRevision: "native-conformance-r1",
  items: [{
    capability: {
      id: "native-test.polyth-native-probe",
      kind: "skill",
      owner: "native-test",
      scope: "session",
      revision: "skill-r1",
      name: "polyth-native-probe",
      title: "Polyth native probe",
      description: "Model-free native skill discovery probe",
      instructions: "This skill exists only for native protocol conformance.",
    },
    mode: "native",
    mutability: "session-create",
  }],
};

test("Codex App Server discovers isolated skill roots and directly invokes a deterministic MCP tool", {
  skip: enabled ? false : "set POLYTH_NATIVE_CAPABILITY_TESTS=1 to run native process conformance",
  timeout: 30_000,
}, async () => {
  const base = temporaryDirectory();
  const cwd = join(base, "workspace");
  const codexHome = join(base, "codex-home");
  mkdirSync(cwd);
  mkdirSync(codexHome);
  const contextA = contextAt(join(base, "space-a"), "space-a", cwd);
  const contextB = contextAt(join(base, "space-b"), "space-b", cwd);
  const provisioner = createCodexProvisioner();
  let rpc: RpcPeer | undefined;
  try {
    await provisioner.apply(contextA, skillPlan, { mcpSecrets: () => ({}) });
    await provisioner.apply(contextB, skillPlan, { mcpSecrets: () => ({}) });
    const skillA = codexOverlays.peek(contextA, "codex")!.value.nativeSkills!;
    const skillB = codexOverlays.peek(contextB, "codex")!.value.nativeSkills!;
    assert.notEqual(skillA.root, skillB.root);

    const fixture = join(base, "mcp-fixture.mjs");
    writeFileSync(fixture, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "polyth-native-fixture", version: "1.0.0" },
  };
  if (request.method === "tools/list") result = { tools: [{
    name: "ping",
    description: "Return pong",
    inputSchema: { type: "object", additionalProperties: false },
  }] };
  if (request.method === "tools/call") result = {
    content: [{ type: "text", text: "pong" }],
    isError: false,
  };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`, { mode: 0o600 });
    rpc = await createStdioRpc({
      command: process.env.POLYTH_CODEX_BIN ?? "codex",
      args: ["app-server"],
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    await rpc.request("initialize", {
      clientInfo: { name: "polyth-native-test", title: "Polyth native test", version: "0.1.0" },
    });
    rpc.notify("initialized", {});
    const listSkills = async (root: string | undefined) => {
      await rpc.request("skills/extraRoots/set", { extraRoots: root ? [root] : [] });
      return rpc.request<{
        data: Array<{ skills: Array<{ name: string; path: string; enabled: boolean }>; errors: unknown[] }>;
      }>("skills/list", { cwds: [cwd], forceReload: true });
    };
    const added = await listSkills(skillA.root);
    assert.ok(added.data[0]?.skills.some((skill) =>
      skill.name === "polyth-native-probe"
      && skill.path === skillA.skills[0]!.path
      && skill.enabled));
    assert.deepEqual(added.data[0]?.errors, []);

    const removed = await listSkills(undefined);
    assert.equal(removed.data[0]?.skills.some((skill) => skill.path === skillA.skills[0]!.path), false);

    const isolated = await listSkills(skillB.root);
    assert.ok(isolated.data[0]?.skills.some((skill) => skill.path === skillB.skills[0]!.path));
    assert.equal(isolated.data[0]?.skills.some((skill) => skill.path === skillA.skills[0]!.path), false);

    const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: {
          "polyth-native-fixture": { command: process.execPath, args: [fixture] },
        },
      },
    });
    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await rpc.request<{
        data: Array<{ name: string; runtimeStatus?: string | null; tools: Record<string, { name: string }> }>;
      }>("mcpServerStatus/list", { threadId: started.thread.id, detail: "toolsAndAuthOnly" });
      const fixtureStatus = status.data.find((server) => server.name === "polyth-native-fixture");
      if (fixtureStatus?.runtimeStatus === "connected"
        && Object.values(fixtureStatus.tools).some((tool) => tool.name === "ping")) {
        connected = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.equal(connected, true);
    const called = await rpc.request<{ content: Array<{ type?: string; text?: string }>; isError?: boolean | null }>(
      "mcpServer/tool/call",
      { threadId: started.thread.id, server: "polyth-native-fixture", tool: "ping", arguments: {} },
    );
    assert.notEqual(called.isError, true);
    assert.ok(called.content.some((item) => item.type === "text" && item.text === "pong"));
  } finally {
    await rpc?.close().catch(() => {});
    try { provisioner.release?.(contextA); } catch { /* continue cleaning test-owned paths */ }
    try { provisioner.release?.(contextB); } catch { /* continue cleaning test-owned paths */ }
    rmSync(base, { recursive: true, force: true });
  }
});
