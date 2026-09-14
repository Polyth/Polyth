import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { commandCodeOverlays, createCommandCodeProvisioner } from "../src/provisioner.ts";

const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), "polyth-commandcode-capability-"));
const spaceAt = (storageDir: string, spaceId = "space"): SpaceContext => {
  mkdirSync(storageDir, { recursive: true });
  return {
    spaceId,
    spaceSlug: spaceId,
    userId: "user",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
};
const contextAt = (storageDir: string, spaceId = "space"): HarnessContext => ({
  spaceId,
  projectId: "project",
  sessionId: "session",
  cwd: temporaryDirectory(),
  space: spaceAt(storageDir, spaceId),
});
const noSecrets = { mcpSecrets: () => ({}) };

const plan = (
  revision: string,
  skillBody = "Follow repository evidence.",
  skillDescription = "Review a change",
): HarnessProvisioningPlan => ({
  harnessId: "commandcode",
  desiredRevision: revision,
  items: [
    {
      capability: {
        id: "polyth.behavior",
        kind: "instruction",
        owner: "polyth",
        scope: "session",
        revision: `instruction-${revision}`,
        text: "Keep changes focused.",
      },
      mode: "prompt",
      mutability: "immediate",
    },
    {
      capability: {
        id: "example.context",
        kind: "context",
        owner: "example",
        scope: "project",
        revision: `context-${revision}`,
        title: "Project facts",
        text: "The project uses pnpm.",
      },
      mode: "prompt",
      mutability: "immediate",
    },
    {
      capability: {
        id: "example.review",
        kind: "skill",
        owner: "example",
        scope: "project",
        revision: `skill-${revision}`,
        name: "review",
        title: "Review",
        description: skillDescription,
        instructions: skillBody,
      },
      mode: "native",
      mutability: "immediate",
    },
    {
      capability: {
        id: "polyth.mcp.example",
        kind: "mcp-server",
        owner: "polyth",
        scope: "project",
        revision: `mcp-${revision}`,
        name: "example",
        enabled: true,
        transport: { kind: "stdio", command: "example-mcp", args: [], envKeys: [] },
      },
      mode: "unsupported",
      mutability: "immutable",
    },
  ],
});

const nativeToolPlan = (): HarnessProvisioningPlan => ({
  harnessId: "commandcode",
  desiredRevision: "tools-r1",
  items: [
    {
      capability: {
        id: "example.review-tool",
        kind: "tool",
        owner: "example",
        scope: "session",
        revision: "tool-r1",
        name: "review_project",
        description: "Review the project",
        inputSchema: {
          type: "object",
          properties: { focus: { type: "string" } },
          required: [],
        },
        trust: "pure",
        mutating: false,
      },
      mode: "mcp",
      mutability: "immediate",
    },
    {
      capability: {
        id: "polyth.agent-tools",
        kind: "mcp-server",
        owner: "polyth",
        scope: "session",
        revision: "agent-tools-r1",
        name: "polyth-agent-tools",
        enabled: true,
        transport: {
          kind: "stdio",
          command: "/usr/bin/node",
          args: ["/private/agentToolsMcp.mjs"],
          envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN", "ELECTRON_RUN_AS_NODE"],
        },
      },
      mode: "unsupported",
      mutability: "immutable",
    },
  ],
});

test("Command Code provisions transient prompt/context and native skills without mutating MCP config", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  const support = await provisioner.support(context);
  assert.deepEqual(support.kinds.instruction?.modes, ["prompt"]);
  assert.deepEqual(support.kinds.context?.modes, ["prompt"]);
  assert.deepEqual(support.kinds.skill?.modes, ["native"]);
  assert.deepEqual(support.kinds.tool?.modes, ["mcp"]);
  assert.deepEqual(support.kinds["mcp-server"]?.modes, ["unsupported"]);
  assert.equal(support.kinds["mcp-server"]?.configScope, "session");

  const result = await provisioner.apply(context, plan("r1"), noSecrets);
  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.promptModFile);
  assert.ok(overlay.skillRoot);
  assert.deepEqual(overlay.promptCapabilityIds.sort(), ["example.context", "polyth.behavior"]);
  assert.deepEqual(overlay.skillCapabilityIds, ["example.review"]);
  assert.deepEqual(overlay.toolCapabilityIds, []);

  const promptFile = join(dirname(overlay.promptModFile), "system-prompt.txt");
  const prompt = readFileSync(promptFile, "utf8");
  const promptMod = readFileSync(overlay.promptModFile, "utf8");
  assert.match(promptMod, /appendSystemPrompt/);
  assert.match(prompt, /Keep changes focused\./);
  assert.match(prompt, /## Context: Project facts/);
  assert.match(prompt, /The project uses pnpm\./);
  assert.doesNotMatch(prompt, /Follow repository evidence\./);

  const skill = readFileSync(join(overlay.skillRoot, "review", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: "review"\n/);
  assert.match(skill, /Follow repository evidence\./);
  assert.ok(overlay.promptModFile.startsWith(`${storage}/runtime/commandcode/`));
  assert.ok(overlay.skillRoot.startsWith(`${storage}/runtime/commandcode/`));

  assert.equal(result.records.find((row) => row.capabilityId === "polyth.behavior")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "example.context")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "example.review")?.status, "pending");
  const mcp = result.records.find((row) => row.capabilityId === "polyth.mcp.example");
  assert.equal(mcp?.status, "unsupported");
  assert.match(mcp?.reason ?? "", /will not mutate vendor MCP files/);

  provisioner.release?.(context);
  assert.equal(existsSync(promptFile), false);
  assert.equal(commandCodeOverlays.peek(context, "commandcode"), undefined);
});

test("Command Code stages native addTool schemas while keeping bridge secrets memory-only", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  const secrets = {
    mcpSecrets(serverId: string) {
      return serverId === "polyth.agent-tools"
        ? {
            POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
            POLYTH_AGENT_TOOLS_TOKEN: "opaque-secret-token",
            ELECTRON_RUN_AS_NODE: "1",
          }
        : {};
    },
  };
  const result = await provisioner.apply(context, nativeToolPlan(), secrets);
  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.toolModFile);
  assert.deepEqual(overlay.toolCapabilityIds, ["example.review-tool"]);
  assert.deepEqual(overlay.toolNames, { "example.review-tool": "review_project" });
  assert.deepEqual(overlay.toolBridge, {
    command: "/usr/bin/node",
    args: ["/private/agentToolsMcp.mjs"],
    env: {
      POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
      POLYTH_AGENT_TOOLS_TOKEN: "opaque-secret-token",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  const toolMod = readFileSync(overlay.toolModFile, "utf8");
  assert.match(toolMod, /cmd\.addTool/);
  assert.match(toolMod, /method: "tools\/call"/);
  assert.match(toolMod, /fd: 3/);
  assert.match(toolMod, /fd: 4/);
  assert.match(toolMod, /review_project/);
  assert.doesNotMatch(toolMod, /127\.0\.0\.1:7777/);
  assert.doesNotMatch(toolMod, /opaque-secret-token/);
  assert.equal(result.records.find((row) => row.capabilityId === "example.review-tool")?.status, "pending");
  assert.equal(result.records.some((row) => row.capabilityId === "polyth.agent-tools"), false);

  provisioner.release?.(context);
  assert.equal(existsSync(toolMod), false);
});

test("Command Code rejects skill descriptions outside the documented native limit", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  const result = await provisioner.apply(
    context,
    plan("long-description", "Follow evidence.", "x".repeat(1025)),
    noSecrets,
  );
  const skill = result.records.find((row) => row.capabilityId === "example.review");
  assert.equal(skill?.status, "failed");
  assert.match(skill?.reason ?? "", /exceeds 1024 characters/);
  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.deepEqual(overlay?.skillCapabilityIds, []);
  provisioner.release?.(context);
});

test("Command Code capability revisions are immutable", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  await provisioner.apply(context, plan("same", "First body."), noSecrets);
  const overlay = commandCodeOverlays.peek(context, "commandcode")!.value;
  const skillPath = join(overlay.skillRoot!, "review", "SKILL.md");

  const changed = await provisioner.apply(context, plan("same", "Changed without a revision."), noSecrets);
  assert.equal(changed.records.find((row) => row.capabilityId === "example.review")?.status, "failed");
  assert.match(readFileSync(skillPath, "utf8"), /First body\./);
});

test("Command Code refuses a symlinked package capability root", async () => {
  const storage = temporaryDirectory();
  const outside = temporaryDirectory();
  mkdirSync(join(storage, "runtime"), { recursive: true });
  symlinkSync(outside, join(storage, "runtime", "commandcode"));
  const context = contextAt(storage);

  await assert.rejects(
    createCommandCodeProvisioner().apply(context, plan("r1"), noSecrets),
    /non-directory component/,
  );
  assert.equal(commandCodeOverlays.peek(context, "commandcode"), undefined);
  assert.equal(existsSync(join(outside, "capabilities")), false);
});
