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

test("Command Code exposes only non-mutating package tools through native addTool", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCommandCodeProvisioner();

  const result = await provisioner.apply(context, plan, secrets);
  const readOnly = result.records.find((row) => row.capabilityId === "example.inspect");
  const mutating = result.records.find((row) => row.capabilityId === "example.modify");
  assert.equal(readOnly?.status, "pending");
  assert.equal(mutating?.status, "unsupported");
  assert.match(mutating?.reason ?? "", /dont-ask|permission delegation/i);

  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.toolModFile);
  assert.deepEqual(overlay.toolCapabilityIds, ["example.inspect"]);
  assert.deepEqual(overlay.toolBridge?.capabilityIds, ["example.inspect"]);
  assert.equal(overlay.toolBridge?.url, "http://127.0.0.1:7777/internal/agent-tools");
  assert.equal(overlay.toolBridge?.token, "opaque-secret-token");

  const mod = readFileSync(overlay.toolModFile, "utf8");
  assert.match(mod, /inspect_project/);
  assert.match(mod, /example\.inspect/);
  assert.match(mod, /readOnly: true/);
  assert.match(mod, /bridgeClosed/);
  assert.match(mod, /Polyth tool bridge returned malformed response/);
  assert.doesNotMatch(mod, /modify_project|example\.modify/);
  assert.doesNotMatch(mod, /127\.0\.0\.1:7777|opaque-secret-token/);

  const modPath = overlay.toolModFile;
  provisioner.release?.(context);
  assert.equal(commandCodeOverlays.peek(context, "commandcode"), undefined);
  assert.equal(existsSync(modPath), false);
});

test("Command Code advertises the scoped AgentTool grant seam but rejects mutating projection in apply", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const support = await createCommandCodeProvisioner().support(context);
  assert.deepEqual(support.kinds.tool?.modes, ["mcp"]);
  assert.equal(support.kinds.tool?.configScope, "session");
  assert.equal(support.kinds["mcp-server"]?.modes[0], "unsupported");
});
