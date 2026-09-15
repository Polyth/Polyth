import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentCapabilityDescriptor, HarnessContext } from "@polyth/contracts";
import { planHarnessCapabilities } from "@polyth/harness-runtime";
import {
  applyOpenCodeLaunchOverlay,
  createOpenCodeProvisioner,
  peekOpenCodeLaunchOverlay,
} from "../src/provisioner.ts";
import type { BackendConfigApplier } from "../src/config.ts";

type DescriptorInput = {
  [K in AgentCapabilityDescriptor["kind"]]: Omit<Extract<AgentCapabilityDescriptor, { kind: K }>, "owner" | "revision">;
}[AgentCapabilityDescriptor["kind"]];

const descriptor = (value: DescriptorInput): AgentCapabilityDescriptor => ({
  ...value,
  owner: "fixture",
  revision: `rev-${value.id}`,
} as AgentCapabilityDescriptor);

const contextAt = (storageDir: string): HarnessContext => ({
  spaceId: "space-a",
  projectId: "project-a",
  cwd: join(storageDir, "workspace"),
  space: {
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  },
});

const applier = (): BackendConfigApplier => ({
  async applyBehavior(text: string) { return text.length; },
  configAuthority: () => ({ kind: "writable", targetId: "fixture" }),
} as unknown as BackendConfigApplier);

test("OpenCode presents Polyth capabilities through the scoped MCP bridge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-opencode-native-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = contextAt(root);
  const provisioner = createOpenCodeProvisioner(applier());

  const control = descriptor({
    id: "fixture.polyth-control",
    kind: "tool",
    scope: "project",
    projectId: context.projectId,
    name: "polyth",
    description: "Control canonical Polyth sessions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["session.list", "session.create"] },
        parameters: { type: "object" },
      },
    },
    trust: "device",
    mutating: true,
  });
  const browser = descriptor({
    id: "fixture.polyth-browser",
    kind: "tool",
    scope: "project",
    projectId: context.projectId,
    name: "polyth_browser",
    description: "Drive the controlled browser.",
    inputSchema: { type: "object", properties: { action: { type: "string" } } },
    trust: "device",
    mutating: true,
  });
  const bridge: AgentCapabilityDescriptor = {
    id: "polyth.agent-tools",
    kind: "mcp-server",
    owner: "polyth",
    scope: "project",
    projectId: context.projectId,
    revision: "bridge-r1",
    name: "polyth-agent-tools",
    enabled: true,
    transport: {
      kind: "stdio",
      command: "node",
      args: ["agentToolsMcp.mjs"],
      envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN"],
    },
  };

  const plan = planHarnessCapabilities(
    "opencode",
    [control, browser, bridge],
    await provisioner.support(context),
    context,
  );
  const result = await provisioner.apply(context, plan, {
    mcpSecrets: (id) => id === "polyth.agent-tools"
      ? {
          POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:4400/internal/agent-tools",
          POLYTH_AGENT_TOOLS_TOKEN: "native-secret-token",
        }
      : {},
  });

  assert.equal(result.records.find((row) => row.capabilityId === control.id)?.status, "pending");
  assert.match(result.records.find((row) => row.capabilityId === control.id)?.reason ?? "", /scoped Polyth MCP capability bridge/);

  const overlay = peekOpenCodeLaunchOverlay(context);
  assert.ok(overlay);
  const config = JSON.parse(overlay.configContent) as {
    mcp?: Record<string, { enabled?: boolean; environment?: Record<string, string> }>;
  };
  assert.equal(config.mcp?.["polyth-agent-tools"]?.enabled, true);
  assert.doesNotMatch(JSON.stringify(config), /native-secret-token/);

  const launched = applyOpenCodeLaunchOverlay({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["user-plugin"] }),
  }, overlay);
  const merged = JSON.parse(launched.OPENCODE_CONFIG_CONTENT ?? "{}") as { plugin?: string[] };
  assert.deepEqual(merged.plugin, ["user-plugin"]);
  assert.equal(launched.POLYTH_AGENT_TOOLS_TOKEN, undefined);
});
