import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const descriptor = (
  value: Omit<AgentCapabilityDescriptor, "owner" | "revision">,
): AgentCapabilityDescriptor => ({ ...value, owner: "fixture", revision: `rev-${value.id}` } as AgentCapabilityDescriptor);

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
  async applyBehavior(text) { behavior.push(text); return text.length; },
  configAuthority: () => ({ kind: "writable", targetId: "fixture" }),
} as unknown as BackendConfigApplier);

const secrets = { mcpSecrets: () => ({}) };

test("OpenCode privately projects project instructions and context without touching user config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-opencode-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = contextAt(root);
  const behavior: string[] = [];
  const provisioner = createOpenCodeProvisioner(applier(behavior));
  const desired: AgentCapabilityDescriptor[] = [
    descriptor({ id: "fixture.global", kind: "instruction", scope: "deployment", text: "Global behavior" }),
    descriptor({ id: "fixture.project-instruction", kind: "instruction", scope: "project", projectId: context.projectId, text: "Project instruction" }),
    descriptor({ id: "fixture.project-context", kind: "context", scope: "project", projectId: context.projectId, title: "Project facts", text: "Project context" }),
    descriptor({ id: "fixture.session-instruction", kind: "instruction", scope: "session", text: "Session only" }),
  ];
  const plan = planHarnessCapabilities("opencode", desired, await provisioner.support(context), context);
  const result = await provisioner.apply(context, plan, secrets);

  assert.deepEqual(behavior, ["Global behavior"]);
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.global")?.status, "applied");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.project-instruction")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.project-context")?.status, "pending");
  assert.equal(result.records.find((row) => row.capabilityId === "fixture.session-instruction")?.status, "unsupported");

  const overlay = peekOpenCodeLaunchOverlay(context);
  assert.ok(overlay);
  const config = JSON.parse(overlay.configContent) as { instructions?: string[] };
  assert.equal(config.instructions?.length, 2);
  assert.ok(config.instructions?.every((path) => path.startsWith(root) && existsSync(path)));
  assert.match(readFileSync(config.instructions![0]!, "utf8"), /Project instruction/);
  assert.match(readFileSync(config.instructions![1]!, "utf8"), /Project facts[\s\S]*Project context/);
  assert.deepEqual(new Set(overlay.capabilityIds), new Set(["fixture.project-instruction", "fixture.project-context"]));
});

test("OpenCode launch overlay preserves user instructions while adding private Polyth sources", () => {
  const overlay = {
    configContent: JSON.stringify({ instructions: ["/private/polyth-context.md"], mcp: { polyth: { type: "local" } } }),
    env: {},
    desiredRevision: "revision-a",
    capabilityIds: ["fixture.context"],
  };
  const env = applyOpenCodeLaunchOverlay({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      instructions: ["CONTRIBUTING.md", "CONTRIBUTING.md"],
      mcp: { user: { type: "local", command: ["user"] } },
      plugin: ["user-plugin"],
    }),
  }, overlay);
  const merged = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    instructions: string[];
    mcp: Record<string, unknown>;
    plugin: string[];
  };
  assert.deepEqual(merged.instructions, ["CONTRIBUTING.md", "/private/polyth-context.md"]);
  assert.deepEqual(Object.keys(merged.mcp).sort(), ["polyth", "user"]);
  assert.deepEqual(merged.plugin, ["user-plugin"]);
});

test("OpenCode context scope is explicit: project and wider are supported, session is not", async () => {
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
      assert.equal(planHarnessCapabilities("opencode", [capability], support, context).items[0]?.mode, "config");
    }
    const session = descriptor({ id: "fixture.context-session", kind: "context", scope: "session", title: "session", text: "session" });
    assert.equal(planHarnessCapabilities("opencode", [session], support, context).items[0]?.mode, "unsupported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
