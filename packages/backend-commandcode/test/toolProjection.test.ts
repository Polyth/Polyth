import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { commandCodeOverlays, createCommandCodeProvisioner } from "../src/provisioner.ts";

const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), "polyth-commandcode-tools-"));

const contextAt = (storageDir: string): HarnessContext => {
  mkdirSync(storageDir, { recursive: true });
  const space: SpaceContext = {
    spaceId: "space",
    spaceSlug: "space",
    userId: "user",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
  return {
    spaceId: "space",
    projectId: "project",
    sessionId: "session",
    cwd: temporaryDirectory(),
    space,
  };
};

const plan: HarnessProvisioningPlan = {
  harnessId: "commandcode",
  desiredRevision: "tool-boundary-r1",
  items: [
    {
      capability: {
        id: "example.inspect",
        kind: "tool",
        owner: "example",
        scope: "session",
        revision: "inspect-r1",
        name: "inspect_project",
        description: "Inspect project state without mutation",
        inputSchema: { type: "object", properties: {} },
        trust: "pure",
        mutating: false,
      },
      mode: "mcp",
      mutability: "immediate",
    },
    {
      capability: {
        id: "example.modify",
        kind: "tool",
        owner: "example",
        scope: "session",
        revision: "modify-r1",
        name: "modify_project",
        description: "Modify project state",
        inputSchema: { type: "object", properties: {} },
        trust: "workspace",
        mutating: true,
      },
      mode: "mcp",
      mutability: "immediate",
    },
  ],
};

const secrets = {
  mcpSecrets(serverId: string) {
    return serverId === "polyth.agent-tools"
      ? {
          POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
          POLYTH_AGENT_TOOLS_TOKEN: "opaque-secret-token",
        }
      : {};
  },
};

const instruction = (revision: string): HarnessProvisioningPlan["items"][number] => ({
  capability: {
    id: "example.instructions",
    kind: "instruction",
    owner: "example",
    scope: "session",
    revision,
    text: "Keep the session usable.",
  },
  mode: "prompt",
  mutability: "immediate",
});

const readOnlyTool = (id: string, index: number): HarnessProvisioningPlan["items"][number] => ({
  capability: {
    id,
    kind: "tool",
    owner: "example",
    scope: "session",
    revision: `tool-${index}`,
    name: `inspect_${index}`,
    description: "Inspect without mutation",
    inputSchema: { type: "object", properties: {} },
    trust: "pure",
    mutating: false,
  },
  mode: "mcp",
  mutability: "immediate",
});

test("Command Code exposes read-only and mutating package tools through Polyth's scoped permission bridge", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();

  const result = await provisioner.apply(context, plan, secrets);
  const readOnly = result.records.find((row) => row.capabilityId === "example.inspect");
  const mutating = result.records.find((row) => row.capabilityId === "example.modify");
  assert.equal(readOnly?.status, "pending");
  assert.equal(mutating?.status, "pending");

  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.toolModFile);
  assert.deepEqual(overlay.toolCapabilityIds, ["example.inspect", "example.modify"]);
  assert.deepEqual(overlay.toolBridge?.capabilityIds, ["example.inspect", "example.modify"]);
  assert.equal(overlay.toolBridge?.url, "http://127.0.0.1:7777/internal/agent-tools");
  assert.equal(overlay.toolBridge?.token, "opaque-secret-token");

  const mod = readFileSync(overlay.toolModFile, "utf8");
  assert.match(mod, /inspect_project/);
  assert.match(mod, /example\.inspect/);
  assert.match(mod, /modify_project/);
  assert.match(mod, /example\.modify/);
  assert.match(mod, /readOnly: true/);
  assert.match(mod, /bridgeClosed/);
  assert.match(mod, /Polyth tool bridge returned malformed response/);
  assert.doesNotMatch(mod, /127\.0\.0\.1:7777|opaque-secret-token/);

  const modPath = overlay.toolModFile;
  provisioner.release?.(context);
  assert.equal(commandCodeOverlays.peek(context, "commandcode"), undefined);
  assert.equal(existsSync(modPath), false);
});

test("tool bridge capacity overflow fails tools without dropping prompt projection", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  const tools = Array.from({ length: 257 }, (_, index) => readOnlyTool(`example.tool-${index}`, index));
  const overflowPlan: HarnessProvisioningPlan = {
    harnessId: "commandcode",
    desiredRevision: "overflow-r1",
    items: [instruction("instructions-overflow"), ...tools],
  };

  const result = await provisioner.apply(context, overflowPlan, secrets);
  const toolRecords = result.records.filter((row) => row.kind === "tool");
  assert.equal(toolRecords.length, 257);
  assert.ok(toolRecords.every((row) => row.status === "failed"));
  assert.ok(toolRecords.every((row) => /at most 256 projected tools/.test(row.reason ?? "")));
  assert.equal(result.records.find((row) => row.capabilityId === "example.instructions")?.status, "pending");

  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.promptModFile);
  assert.equal(overlay.toolModFile, undefined);
  assert.deepEqual(overlay.toolCapabilityIds, []);
  provisioner.release?.(context);
});

test("oversized tool capability id fails locally without dropping prompt projection", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();
  const oversizedId = `example.${"x".repeat(505)}`;
  assert.equal(oversizedId.length, 513);
  const oversizedPlan: HarnessProvisioningPlan = {
    harnessId: "commandcode",
    desiredRevision: "oversized-id-r1",
    items: [instruction("instructions-oversized"), readOnlyTool(oversizedId, 1)],
  };

  const result = await provisioner.apply(context, oversizedPlan, secrets);
  const toolRecord = result.records.find((row) => row.capabilityId === oversizedId);
  assert.equal(toolRecord?.status, "failed");
  assert.match(toolRecord?.reason ?? "", /exceeds 512 characters/);
  assert.equal(result.records.find((row) => row.capabilityId === "example.instructions")?.status, "pending");

  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.promptModFile);
  assert.equal(overlay.toolModFile, undefined);
  assert.deepEqual(overlay.toolCapabilityIds, []);
  provisioner.release?.(context);
});

test("Command Code advertises the scoped AgentTool grant seam for all package tools", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const support = await createCommandCodeProvisioner().support(context);
  assert.deepEqual(support.kinds.tool?.modes, ["mcp"]);
  assert.equal(support.kinds.tool?.configScope, "session");
  assert.equal(support.kinds["mcp-server"]?.modes[0], "unsupported");
});
