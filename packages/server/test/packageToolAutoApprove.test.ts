import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapabilityDescriptor } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { authorizePackageToolAfterPermissions } from "../src/agentTools.ts";

const browserTool = {
  id: "browser.polyth-browser",
  kind: "tool",
  owner: "browser",
  scope: "project",
  revision: "1",
  name: "polyth_browser",
  description: "browser",
  inputSchema: { type: "object", properties: {} },
  trust: "device",
  mutating: true,
} as Extract<AgentCapabilityDescriptor, { kind: "tool" }>;

const grant = {
  spaceId: "space-a",
  projectId: "project-a",
  cwd: "/workspace/a",
  sessionId: "session-a",
};

test("package-tool authorization keeps deny ahead of auto-approve", async () => {
  let prompted = false;
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "deny",
    contribution: { autoApprove: async () => true },
    requestPermission: async () => {
      prompted = true;
      return "allow";
    },
  }), "deny");
  assert.equal(prompted, false);
});

test("package-tool authorization uses explicit allow before auto-approve", async () => {
  let autoApproved = false;
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "allow",
    contribution: {
      autoApprove: async () => {
        autoApproved = true;
        return true;
      },
    },
  }), "allow");
  assert.equal(autoApproved, false);
});

test("package-tool auto-approve ON skips the permission prompt", async () => {
  let prompted = false;
  const storage = createSpaceStorage(mkdtempSync(join(tmpdir(), "auto-approve-on-")));
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "ask",
    storage,
    contribution: { autoApprove: async () => true },
    requestPermission: async () => {
      prompted = true;
      return "allow";
    },
  }), "allow");
  assert.equal(prompted, false);
});

test("package-tool auto-approve OFF falls through to the permission prompt", async () => {
  let prompted = false;
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "ask",
    contribution: { autoApprove: async () => false },
    requestPermission: async () => {
      prompted = true;
      return "allow";
    },
  }), "allow");
  assert.equal(prompted, true);
});

test("package-tool without autoApprove still asks", async () => {
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "ask",
  }), "permission-required");
});

test("package-tool auto-approve failure fails closed to ask", async () => {
  assert.equal(await authorizePackageToolAfterPermissions({
    tool: browserTool,
    grant,
    permissionVerdict: "ask",
    contribution: {
      autoApprove: async () => {
        throw new Error("storage unavailable");
      },
    },
  }), "permission-required");
});
