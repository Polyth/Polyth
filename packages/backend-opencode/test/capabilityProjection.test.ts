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

const applier = (behavior: string[]): BackendConfigApplier => ({
  async applyBehavior(text: string) { behavior.push(text); return text.length; },
  configAuthority: () => ({ kind: "writable", targetId: "fixture" }),
} as unknown as BackendConfigApplier);

const secrets = { mcpSecrets: () => ({}) };

test("OpenCode projects instructions/context as text and discovers skills natively", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-opencode-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = contextAt(root);
  const behavior: string[] = [];
  const provisioner = createOpenCodeProvisioner(applier(behavior));
  const desired: AgentCapabilityDescriptor[] = [
    descriptor({ id: "fixture.global", kind: "instruction", scope: "deployment", text: "Global behavior" }),
    descriptor({ id: "fixture.project-instruction", kind: "instruction", scope: "project", projectId: context.projectId, text: "Project instruction" }),
    descriptor({
      id: "fixture.skill",
      kind: "skill",
      scope: "project",
      projectId: context.projectId,
      name: "review",
      title: "Review",
      description: "Review a patch.",
      instructions: "Check invariants before changing code.",
    }),
    descriptor({ id: "fixture.project-context", kind: "context", scope: "project", projectId: context.projectId, title: "Project facts", text: "Project context" }),
    descriptor({ id: "fixture.session-instruction", kind: "instruction", scope: "session", text: "Session only" }),
  ];
  const plan = planHarnessCapabilities("opencode", desired, await provisioner.support(context), context);
  const result = await provisioner.apply(context, plan, secrets);

  assert.deepEqual(behavior, [], "canonical behavior must not leak into global OpenCode config");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.global")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.project-instruction")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.skill")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.skill")?.mode, "filesystem");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.project-context")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.session-instruction")?.status, "unsupported");

  const overlay = peekOpenCodeLaunchOverlay(context);
  assert.ok(overlay);
  assert.equal(overlay.configContent, "");
  assert.deepEqual(overlay.capabilityIds, ["fixture.skill"]);
  assert.ok(overlay.configPath);
  assert.ok(overlay.prompt);
  assert.deepEqual(
    new Set(overlay.prompt.capabilityIds),
    new Set(["fixture.global", "fixture.project-instruction", "fixture.project-context"]),
  );
  assert.match(overlay.prompt.text, /Global behavior/);
  assert.match(overlay.prompt.text, /Project instruction/);
  assert.doesNotMatch(overlay.prompt.text, /Check invariants before changing code/);
  assert.match(overlay.prompt.text, /## Context: Project facts[\s\S]*Project context/);
  assert.doesNotMatch(overlay.prompt.text, /Session only/);
});

test("OpenCode projects package-owned MCP descriptors from the canonical plan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-opencode-package-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = contextAt(root);
  const provisioner = createOpenCodeProvisioner(applier([]));
  const capability = descriptor({
    id: "fixture.package-mcp",
    kind: "mcp-server",
    scope: "project",
    projectId: context.projectId,
    name: "package-helper",
    enabled: true,
    transport: { kind: "stdio", command: "package-helper", args: ["--stdio"], envKeys: [] },
  });
  const plan = planHarnessCapabilities("opencode", [capability], await provisioner.support(context), context);
  const result = await provisioner.apply(context, plan, secrets);

  assert.equal(result.records[0]?.status, "pending");
  const overlay = peekOpenCodeLaunchOverlay(context);
  assert.ok(overlay);
  assert.ok(overlay.capabilityIds.includes("fixture.package-mcp"));
  assert.equal(overlay.prompt, undefined);
  const config = JSON.parse(overlay.configContent) as { mcp?: Record<string, { type?: string; command?: string[] }> };
  assert.deepEqual(config.mcp?.["package-helper"], {
    type: "local",
    command: ["package-helper", "--stdio"],
    enabled: true,
  });
});

test("OpenCode launch overlay leaves user text config untouched", () => {
  const overlay = {
    configContent: JSON.stringify({ mcp: { polyth: { type: "local" } } }),
    env: {},
    desiredRevision: "revision-a",
    capabilityIds: ["fixture.mcp"],
    prompt: { text: "Private Polyth context", capabilityIds: ["fixture.context"] },
  };
  const env = applyOpenCodeLaunchOverlay({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      instructions: ["CONTRIBUTING.md"],
      skills: { paths: ["/user/skills"] },
      mcp: { user: { type: "local", command: ["user"] } },
      plugin: ["user-plugin"],
    }),
  }, overlay);
  const merged = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    instructions: string[];
    skills: unknown;
    mcp: Record<string, unknown>;
    plugin: string[];
  };
  assert.deepEqual(merged.instructions, ["CONTRIBUTING.md"]);
  assert.deepEqual(merged.skills, { paths: ["/user/skills"] });
  assert.deepEqual(Object.keys(merged.mcp).sort(), ["polyth", "user"]);
  assert.deepEqual(merged.plugin, ["user-plugin"]);
});

test("OpenCode portable text scope is explicit: project and wider are prompt-projected, session is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-opencode-support-"));
  try {
    const context = contextAt(root);
    const support = await createOpenCodeProvisioner(applier([])).support(context);
    for (const scope of ["deployment", "space", "project"] as const) {
      const capability = descriptor({
        id: `fixture.context-${scope}`,
        kind: "context",
        scope,
        title: scope,
        text: scope,
        ...(scope === "project" ? { projectId: context.projectId } : {}),
        ...(scope === "space" ? { spaceId: context.spaceId } : {}),
      });
      const item = planHarnessCapabilities("opencode", [capability], support, context).items[0];
      assert.equal(item?.mode, "prompt");
      assert.equal(item?.mutability, "immediate");
    }
    const skill = descriptor({
      id: "fixture.skill-support",
      kind: "skill",
      scope: "project",
      projectId: context.projectId,
      name: "review",
      title: "Review",
      description: "Review",
      instructions: "Review",
    });
    const skillItem = planHarnessCapabilities("opencode", [skill], support, context).items[0];
    assert.equal(skillItem?.mode, "filesystem");
    assert.equal(skillItem?.mutability, "requires-restart");

    const session = descriptor({ id: "fixture.context-session", kind: "context", scope: "session", title: "session", text: "session" });
    assert.equal(planHarnessCapabilities("opencode", [session], support, context).items[0]?.mode, "unsupported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
