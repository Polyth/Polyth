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
  targetHarnessId?: string,
): AgentCapabilityDescriptor => ({
  id: `${owner}.${name}`,
  kind: "instruction",
  owner,
  scope: "project",
  projectId: "project-a",
  revision: "declared-v1",
  title: name,
  text,
  ...(targetHarnessId ? { targetHarnessId } : {}),
} as AgentCapabilityDescriptor);

function resolved(descriptors: readonly AgentCapabilityDescriptor[], ctx = context) {
  const registry = createCapabilityContributionRegistry();
  for (const descriptor of descriptors) {
    registry.register(descriptor.owner, { descriptor });
  }
  return registry.resolve(ctx);
}

test("prompt prefix identity is stable across registration ordering and registry restart", () => {
  const alpha = instruction("alpha", "policy", "Use the project policy.");
  const beta = instruction("beta", "review", "Review before editing.");

  const first = promptPrefixDiagnostics(resolved([beta, alpha]), "codex");
  const second = promptPrefixDiagnostics(resolved([alpha, beta]), "codex");

  assert.equal(first.identity, second.identity);
  assert.equal(first.bundleRevision, second.bundleRevision);
  assert.equal(first.harnessId, "codex");
  assert.deepEqual(first.contributors.map((item) => item.id), ["alpha.policy", "beta.review"]);
  assert.equal(first.contributorCount, 2);
  assert.equal(first.coverage, "polyth-capability-prefix");
});

test("semantic capability changes rotate prefix identity even without declared revision bump", () => {
  const before = promptPrefixDiagnostics(resolved([
    instruction("alpha", "policy", "Use policy A."),
  ]), "codex");
  const after = promptPrefixDiagnostics(resolved([
    instruction("alpha", "policy", "Use policy B."),
  ]), "codex");

  assert.notEqual(before.contributors[0]?.revision, after.contributors[0]?.revision);
  assert.notEqual(before.bundleRevision, after.bundleRevision);
  assert.notEqual(before.identity, after.identity);
});

test("volatile session and cwd metadata do not perturb a project prefix", () => {
  const descriptor = instruction("alpha", "policy", "Use the stable project policy.");
  const one = promptPrefixDiagnostics(resolved([descriptor], context), "codex");
  const two = promptPrefixDiagnostics(resolved([descriptor], {
    ...context,
    sessionId: "session-b",
    cwd: "/different/worktree/path",
  }), "codex");

  assert.equal(one.identity, two.identity);
  assert.equal(one.bundleRevision, two.bundleRevision);
});

test("harness-targeted prompts rotate only the target harness prefix", () => {
  const common = instruction("alpha", "policy", "Common project policy.");
  const claudeA = instruction("harness-runtime", "system-prompt-claude", "Claude A", "claude");
  const claudeB = instruction("harness-runtime", "system-prompt-claude", "Claude B", "claude");
  const codex = instruction("harness-runtime", "system-prompt-codex", "Codex only", "codex");

  const before = resolved([common, claudeA, codex]);
  const after = resolved([common, claudeB, codex]);

  const codexBefore = promptPrefixDiagnostics(before, "codex");
  const codexAfter = promptPrefixDiagnostics(after, "codex");
  const claudeBefore = promptPrefixDiagnostics(before, "claude");
  const claudeAfter = promptPrefixDiagnostics(after, "claude");

  assert.equal(codexBefore.identity, codexAfter.identity);
  assert.equal(codexBefore.bundleRevision, codexAfter.bundleRevision);
  assert.notEqual(claudeBefore.identity, claudeAfter.identity);
  assert.deepEqual(codexBefore.contributors.map((item) => item.id), [
    "alpha.policy",
    "harness-runtime.system-prompt-codex",
  ]);
  assert.deepEqual(claudeBefore.contributors.map((item) => item.id), [
    "alpha.policy",
    "harness-runtime.system-prompt-claude",
  ]);
});

test("diagnostics expose contributor identity/revisions but never prompt content", () => {
  const secretLookingText = "Never surface this instruction body: token=abc123";
  const result = promptPrefixDiagnostics(resolved([
    instruction("alpha", "policy", secretLookingText),
  ]), "codex");
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /Never surface/);
  assert.doesNotMatch(serialized, /abc123/);
  assert.deepEqual(Object.keys(result.contributors[0]!).sort(), [
    "id", "kind", "owner", "revision", "scope",
  ]);
});
