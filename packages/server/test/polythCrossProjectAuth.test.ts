import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentCapabilityDescriptor, JsonObject } from "@polyth/contracts";
import { createPermissionService } from "@polyth/permissions";
import { polythSessionAuthorizationSubjects } from "../src/agentTools.ts";

const descriptor: Extract<AgentCapabilityDescriptor, { kind: "tool" }> = {
  id: "harness-runtime.polyth-control",
  kind: "tool",
  owner: "harness-runtime",
  scope: "project",
  projectId: "p1",
  revision: "r1",
  name: "polyth",
  description: "Control Polyth sessions",
  inputSchema: { type: "object" },
  trust: "device",
  mutating: true,
};

const input = (action: string, projectId?: string): JsonObject => ({
  action,
  parameters: projectId ? { projectId } : {},
});

const assertImplicitLocal = (action: string) => {
  const current = polythSessionAuthorizationSubjects(descriptor, { projectId: "p1" }, input(action));
  assert.equal(current.length, 1, `${action} must not create an approval subject in the caller project`);
  assert.equal(current[0]?.id, descriptor.id);
  assert.equal(current[0]?.trust, "pure");
  assert.equal(current[0]?.mutating, false);

  const explicitCurrent = polythSessionAuthorizationSubjects(descriptor, { projectId: "p1" }, input(action, "p1"));
  assert.deepEqual(explicitCurrent, current);
};

test("all same-project Polyth orchestration actions are implicit, including mutations and debug", () => {
  for (const action of [
    "project.list",
    "session.list",
    "session.create",
    "session.get",
    "session.messages",
    "session.debug",
    "session.send",
    "session.cancel",
    "session.archive",
    "session.restore",
    "session.fork",
    "session.switchHarness",
  ]) {
    assertImplicitLocal(action);
  }
});

test("external project grants persist per source-target pair instead of restricting local orchestration", () => {
  for (const action of ["session.list", "session.create", "session.debug", "session.send", "session.switchHarness"]) {
    const external = polythSessionAuthorizationSubjects(descriptor, { projectId: "p1" }, input(action, "p2"));
    assert.equal(external.length, 2, `${action} must gate an explicit external target`);
    assert.equal(external[0]?.id, descriptor.id, "base deny guard remains first");
    assert.equal(external[0]?.trust, "pure");
    assert.equal(external[0]?.mutating, false);
    assert.equal(external[1]?.trust, "device");
    assert.equal(external[1]?.mutating, true);
    assert.match(external[1]?.name ?? "", /p2/);
  }

  const externalP2 = polythSessionAuthorizationSubjects(descriptor, { projectId: "p1" }, input("session.create", "p2"));
  const externalP3 = polythSessionAuthorizationSubjects(descriptor, { projectId: "p1" }, input("session.create", "p3"));
  assert.notEqual(externalP2[1]?.id, externalP3[1]?.id, "different targets get different persistent permission subjects");

  const permissions = createPermissionService(mkdtempSync(join(tmpdir(), "polyth-cross-project-auth-")));
  const targetP2 = externalP2[1]!;
  const targetP3 = externalP3[1]!;
  assert.equal(permissions.evaluate("package-tool", [targetP2.id], "p1", "session-a"), "ask");

  // Equivalent to choosing "Always allow" with project scope in the existing
  // permission UI: every agent/session in source project p1 may keep using this
  // exact target project without another orchestration approval.
  permissions.addRule({
    permission: "package-tool",
    pattern: targetP2.id,
    action: "allow",
    scope: "project",
    projectId: "p1",
  });
  assert.equal(permissions.evaluate("package-tool", [targetP2.id], "p1", "session-b"), "allow");
  assert.equal(permissions.evaluate("package-tool", [targetP2.id], "p1", "session-c"), "allow");
  assert.equal(permissions.evaluate("package-tool", [targetP3.id], "p1", "session-b"), "ask");
  assert.equal(permissions.evaluate("package-tool", [targetP2.id], "p9", "session-b"), "ask");
});
