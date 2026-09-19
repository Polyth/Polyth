import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessContext, HarnessProvisioningPlan } from "@polyth/contracts";
import { acpOverlays, createAcpProvisioner } from "../../backend-acp/src/provisioner.ts";

const context: HarnessContext = {
  spaceId: "space-a",
  projectId: "project-a",
  cwd: "/project/a",
  sessionId: "session-a",
};

const plan: HarnessProvisioningPlan = {
  harnessId: "gemini",
  desiredRevision: "bundle-a",
  items: [
    {
      capability: {
        id: "polyth.behavior",
        kind: "instruction",
        owner: "polyth",
        scope: "session",
        revision: "i1",
        title: "Polyth behavior",
        text: "Follow the canonical Polyth project instructions.",
      },
      mode: "prompt",
      mutability: "session-create",
    },
    {
      capability: {
        id: "fixture.review",
        kind: "skill",
        owner: "fixture",
        scope: "project",
        revision: "s1",
        name: "review",
        title: "Review",
        description: "Review the current changes.",
        instructions: "Inspect the diff and report concrete issues.",
      },
      mode: "prompt",
      mutability: "session-create",
    },
    {
      capability: {
        id: "fixture.context",
        kind: "context",
        owner: "fixture",
        scope: "session",
        revision: "c1",
        title: "Task context",
        text: "The canonical task context lives here.",
      },
      mode: "prompt",
      mutability: "session-create",
    },
    {
      capability: {
        id: "polyth.agent-tools",
        kind: "mcp-server",
        owner: "polyth",
        scope: "session",
        revision: "m1",
        name: "polyth-agent-tools",
        enabled: true,
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: ["agentToolsMcp.mjs"],
          envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN"],
        },
      },
      mode: "native",
      mutability: "session-create",
    },
  ],
};

test("Gemini stages Polyth prompts, skills, context and agent-tools MCP together", async () => {
  const provisioner = createAcpProvisioner("gemini", true);
  const result = await provisioner.apply(context, plan, {
    mcpSecrets(id) {
      return id === "polyth.agent-tools"
        ? {
            POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:4400/internal/agent-tools",
            POLYTH_AGENT_TOOLS_TOKEN: "opaque-test-token",
          }
        : {};
    },
  });
  const overlay = acpOverlays.peek(context, "gemini");
  assert.ok(overlay);

  assert.match(overlay.value.prompt?.text ?? "", /canonical Polyth project instructions/);
  assert.match(overlay.value.prompt?.text ?? "", /## Skill: Review/);
  assert.match(overlay.value.prompt?.text ?? "", /Inspect the diff/);
  assert.match(overlay.value.prompt?.text ?? "", /## Context: Task context/);
  assert.doesNotMatch(overlay.value.prompt?.text ?? "", /opaque-test-token|internal\/agent-tools/);

  assert.deepEqual(overlay.value.mcpServers, [{
    name: "polyth-agent-tools",
    command: process.execPath,
    args: ["agentToolsMcp.mjs"],
    env: [
      { name: "POLYTH_AGENT_TOOLS_URL", value: "http://127.0.0.1:4400/internal/agent-tools" },
      { name: "POLYTH_AGENT_TOOLS_TOKEN", value: "opaque-test-token" },
    ],
  }]);
  assert.ok(result.records.every((record) => record.status === "pending"));
  provisioner.release?.(context);
});
