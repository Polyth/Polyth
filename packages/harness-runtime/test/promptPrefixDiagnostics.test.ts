import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCapabilityDescriptor, HarnessContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "../src/capabilities.ts";
import { promptPrefixDiagnostics } from "../src/promptPrefixDiagnostics.ts";

const context: HarnessContext = {
  spaceId: "space-a",
  projectId: "project-a",
  sessionId: "session-a",
  cwd: "/work/project-a",
};

const instruction = (
  owner: string,
  name: string,
  text: string,
): AgentCapabilityDescriptor => ({
  id: `${owner}.${name}`,
  kind: "instruction",
  owner,
  scope: "project",
  projectId: "project-a",
  revision: "declared-v1",
  title: name,
  text,
});

function resolved(order: Array<[string, AgentCapabilityDescriptor]>, ctx = context) {
  const registry = createCapabilityContributionRegistry();
  for (const [owner, descriptor] of order) registry.register(owner, { descriptor });
  return registry.resolve(ctx);
}

test("prompt prefix identity is stable across registration ordering and registry restart", () => {
  const alpha = instruction("alpha", "policy", "Use the project policy.");
  const beta = instruction("beta", "review", "Review before editing.");

  const first = promptPrefixDiagnostics(resolved([["beta", beta], ["alpha", alpha]]));
  const second = promptPrefixDiagnostics(resolved([["alpha", alpha], ["beta", beta]]));

  assert.equal(first.identity, second.identity);
  assert.equal(first.bundleRevision, second.bundleRevision);
  assert.deepEqual(first.contributors.map((item) => item.id), ["alpha.policy", "beta.review"]);
  assert.equal(first.contributorCount, 2);
  assert.equal(first.coverage, "polyth-capability-prefix");
});

test("semantic capability changes rotate prefix identity even without declared revision bump", () => {
  const before = promptPrefixDiagnostics(resolved([
    ["alpha", instruction("alpha", "policy", "Use policy A.")],
  ]));
  const after = promptPrefixDiagnostics(resolved([
    ["alpha", instruction("alpha", "policy", "Use policy B.")],
  ]));

  assert.notEqual(before.contributors[0]?.revision, after.contributors[0]?.revision);
  assert.notEqual(before.bundleRevision, after.bundleRevision);
  assert.notEqual(before.identity, after.identity);
});

test("volatile session and cwd metadata do not perturb a project prefix", () => {
  const descriptor = instruction("alpha", "policy", "Use the stable project policy.");
  const one = promptPrefixDiagnostics(resolved([["alpha", descriptor]], context));
  const two = promptPrefixDiagnostics(resolved([["alpha", descriptor]], {
    ...context,
    sessionId: "session-b",
    cwd: "/different/worktree/path",
  }));

  assert.equal(one.identity, two.identity);
  assert.equal(one.bundleRevision, two.bundleRevision);
});

test("diagnostics expose contributor identity/revisions but never prompt content", () => {
  const secretLookingText = "Never surface this instruction body: token=abc123";
  const result = promptPrefixDiagnostics(resolved([
    ["alpha", instruction("alpha", "policy", secretLookingText)],
  ]));
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /Never surface/);
  assert.doesNotMatch(serialized, /abc123/);
  assert.deepEqual(Object.keys(result.contributors[0]!).sort(), [
    "id", "kind", "owner", "revision", "scope",
  ]);
});
