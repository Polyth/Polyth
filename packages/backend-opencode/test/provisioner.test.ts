import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenCodeProvisioner,
  peekOpenCodeLaunchOverlay,
  applyOpenCodeLaunchOverlay,
  polythSkillId,
} from "../src/provisioner.ts";
import type { BackendConfigApplier, McpApplyBatch } from "../src/config.ts";
import type { HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-oc-prov-"));
const spaceOf = (dir: string, id = "space"): SpaceContext => {
  mkdirSync(dir, { recursive: true });
  return {
    spaceId: id,
    spaceSlug: id,
    userId: "usr",
    role: "owner",
    deployment: "local-trusted",
    storageDir: dir,
  };
};

const plan = (name: string): HarnessProvisioningPlan => ({
  harnessId: "opencode",
  desiredRevision: "rev",
  items: [{
    capability: {
      id: `polyth.mcp.${name}`,
      kind: "mcp-server",
      owner: "polyth",
      scope: "deployment",
      revision: "1",
      name,
      enabled: true,
      transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] },
    },
    mode: "config",
    mutability: "requires-restart",
  }],
});

test("OpenCode provisioner stages MCP on a private overlay instead of applyMcp", async () => {
  let applyMcpCalls = 0;
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async (_batch: McpApplyBatch) => {
      applyMcpCalls += 1;
    },
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const secrets = { mcpSecrets: () => ({}) };
  const context = { spaceId: "space", projectId: "p", cwd: tmp() };
  await provisioner.apply(context, plan("alpha"), secrets);
  await provisioner.apply(context, plan("alpha"), secrets);
  assert.equal(applyMcpCalls, 0);
  const overlay = peekOpenCodeLaunchOverlay({ cwd: context.cwd, spaceId: "space", projectId: "p" });
  assert.ok(overlay);
  assert.match(overlay.configContent, /"alpha"/);
  await provisioner.apply(context, plan("beta"), secrets);
  const next = peekOpenCodeLaunchOverlay({ cwd: context.cwd, spaceId: "space", projectId: "p" });
  assert.match(next!.configContent, /"beta"/);
  assert.doesNotMatch(next!.configContent, /"alpha"/);
});

test("OpenCode provisioner skips applyMcp when there is no MCP or tool work", async () => {
  let applyMcpCalls = 0;
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {
      applyMcpCalls += 1;
    },
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  await provisioner.apply({ spaceId: "space", projectId: "p", cwd: tmp() }, {
    harnessId: "opencode",
    desiredRevision: "rev",
    items: [{
      capability: {
        id: "polyth.behavior",
        kind: "instruction",
        owner: "polyth",
        scope: "deployment",
        revision: "1",
        text: "Be brief.",
      },
      mode: "config",
      mutability: "immediate",
    }],
  }, { mcpSecrets: () => ({}) });
  assert.equal(applyMcpCalls, 0);
});

test("remote OpenCode stages package tools on a memory-only scoped HTTP bridge", async () => {
  const provisioner = createOpenCodeProvisioner({
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as BackendConfigApplier);
  const cwd = tmp();
  const token = "remote-scoped-token";
  const result = await provisioner.apply({
    spaceId: "space",
    projectId: "p",
    cwd,
    remote: true,
  }, {
    harnessId: "opencode",
    desiredRevision: "remote-rev",
    items: [{
      capability: {
        id: "polyth.agent-tools",
        kind: "mcp-server",
        owner: "polyth",
        scope: "project",
        revision: "bridge-r1",
        name: "polyth-agent-tools",
        enabled: true,
        transport: {
          kind: "http",
          url: "http://127.0.0.1:43123/internal/agent-tools/mcp",
          headersSecretRefs: ["Authorization"],
        },
      },
      mode: "config",
      mutability: "requires-restart",
    }, {
      capability: {
        id: "browser.polyth-browser",
        kind: "tool",
        owner: "browser",
        scope: "project",
        revision: "browser-r1",
        name: "polyth_browser",
        description: "Control the Polyth browser",
        inputSchema: { type: "object", properties: {} },
        trust: "workspace",
        mutating: true,
      },
      mode: "mcp",
      mutability: "requires-restart",
    }],
  }, {
    mcpSecrets: (id) => id === "polyth.agent-tools"
      ? { Authorization: `Bearer ${token}` }
      : {},
  });

  assert.deepEqual(result.records.map((record) => [record.capabilityId, record.status]), [
    ["polyth.agent-tools", "pending"],
    ["browser.polyth-browser", "pending"],
  ]);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: "space", projectId: "p" });
  assert.ok(overlay);
  assert.equal(overlay.configContent, "", "remote bearer must not enter persistent config content");
  assert.deepEqual(overlay.env, {});
  assert.deepEqual(overlay.capabilityIds, ["polyth.agent-tools", "browser.polyth-browser"]);
  assert.deepEqual(overlay.remoteMcp, [{
    capabilityId: "polyth.agent-tools",
    name: "polyth-agent-tools",
    url: "http://127.0.0.1:43123/internal/agent-tools/mcp",
    headers: { Authorization: `Bearer ${token}` },
  }]);
});

test("OpenCode writes Polyth-owned skills with valid V1 identifiers in Space storage", async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".opencode", "skills", "user-skill"), { recursive: true });
  writeFileSync(join(cwd, ".opencode", "skills", "user-skill", "SKILL.md"), "---\nname: user\ndescription: mine\n---\nHi\n");
  const space = spaceOf(tmp());
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const result = await provisioner.apply({ spaceId: space.spaceId, projectId: "p", cwd, space }, {
    harnessId: "opencode",
    desiredRevision: "r",
    items: [{
      capability: {
        id: "example-feature.docs",
        kind: "skill",
        owner: "example-feature",
        scope: "project",
        revision: "1",
        name: "docs",
        title: "Docs",
        description: "Write docs",
        instructions: "Be thorough.",
      },
      mode: "filesystem",
      mutability: "requires-restart",
    }],
  }, { mcpSecrets: () => ({}) });
  assert.equal(result.records[0]?.status, "pending");
  const skillId = polythSkillId("example-feature", "docs");
  assert.equal(skillId, "polyth-example-feature-docs");
  assert.equal(existsSync(join(cwd, ".opencode", "skills", "user-skill", "SKILL.md")), true);
  assert.equal(existsSync(join(cwd, ".opencode", "skills", "polyth--example-feature-docs")), false);
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  const parsed = JSON.parse(readFileSync(overlay!.configPath!, "utf8")) as { skills?: { paths?: string[] } };
  const skillRoot = parsed.skills?.paths?.[0];
  assert.ok(skillRoot);
  assert.equal(existsSync(join(skillRoot, skillId, ".polyth-owned")), true);
  const body = readFileSync(join(skillRoot, skillId, "SKILL.md"), "utf8");
  assert.match(body, /^---\nname: polyth-example-feature-docs\n/);
  assert.match(body, /polyth-owned: "true"/);
  assert.deepEqual(parsed.skills, { paths: [skillRoot] });
  assert.equal(Array.isArray((parsed as { skills?: unknown }).skills), false);
});

test("OpenCode skills stay inside Space storage and do not leak across Spaces", async () => {
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const skill = {
    capability: {
      id: "example-feature.docs",
      kind: "skill" as const,
      owner: "example-feature",
      scope: "project" as const,
      revision: "1",
      name: "docs",
      title: "Docs",
      description: "Write docs",
      instructions: "Be thorough.",
    },
    mode: "filesystem" as const,
    mutability: "requires-restart" as const,
  };
  const spaceA = spaceOf(tmp(), "a");
  const spaceB = spaceOf(tmp(), "b");
  const cwd = tmp();
  await provisioner.apply(
    { spaceId: "a", projectId: "p", cwd, space: spaceA },
    { harnessId: "opencode", desiredRevision: "r", items: [skill] },
    { mcpSecrets: () => ({}) },
  );
  await provisioner.apply(
    { spaceId: "b", projectId: "p", cwd, space: spaceB },
    { harnessId: "opencode", desiredRevision: "r", items: [] },
    { mcpSecrets: () => ({}) },
  );
  const overlayA = peekOpenCodeLaunchOverlay({ cwd, spaceId: "a", projectId: "p" });
  const rootA = (JSON.parse(readFileSync(overlayA!.configPath!, "utf8")) as { skills?: { paths?: string[] } }).skills?.paths?.[0];
  assert.ok(rootA);
  assert.equal(existsSync(join(rootA, "polyth-example-feature-docs", ".polyth-owned")), true);
  assert.equal(existsSync(join(spaceB.storageDir, "runtime", "opencode")), false);
  assert.equal(existsSync(join(cwd, ".opencode", "skills")), false);
});

test("OpenCode overlay is per project cwd, not a shared last-key", async () => {
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  const secrets = { mcpSecrets: () => ({}) };
  const cwdA = tmp();
  const cwdB = tmp();
  await provisioner.apply({ spaceId: "space", projectId: "p", cwd: cwdA }, plan("alpha"), secrets);
  await provisioner.apply({ spaceId: "space", projectId: "p", cwd: cwdB }, plan("alpha"), secrets);
  assert.ok(peekOpenCodeLaunchOverlay({ cwd: cwdA, spaceId: "space", projectId: "p" }));
  assert.ok(peekOpenCodeLaunchOverlay({ cwd: cwdB, spaceId: "space", projectId: "p" }));
});

test("generated skill names never contain consecutive hyphens", () => {
  assert.equal(polythSkillId("example-feature", "docs"), "polyth-example-feature-docs");
  assert.doesNotMatch(polythSkillId("foo--bar", "baz--qux"), /--/);
});

test("OPENCODE_CONFIG_CONTENT merge preserves user MCP, skills, and unknown keys", () => {
  const overlay = {
    configContent: JSON.stringify({
      mcp: { "polyth-server": { type: "local", command: ["true"] } },
      skills: { paths: ["/private/polyth/skills"] },
    }),
    env: {},
    desiredRevision: "r",
    capabilityIds: ["polyth.mcp.polyth-server"],
  };
  const merged = applyOpenCodeLaunchOverlay({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      mcp: { "user-server": {} },
      skills: { paths: ["/user/a"], urls: ["https://example.com/skills"] },
      provider: { anthropic: {} },
      plugin: ["oh-my-opencode"],
      agent: { build: {} },
      customFuture: 1,
    }),
  }, overlay);
  const parsed = JSON.parse(merged.OPENCODE_CONFIG_CONTENT!) as {
    mcp: Record<string, unknown>;
    skills: { paths: string[]; urls: string[] };
    provider: unknown;
    plugin: unknown;
    agent: unknown;
    customFuture: unknown;
  };
  assert.deepEqual(parsed.mcp["user-server"], {});
  assert.ok(parsed.mcp["polyth-server"]);
  assert.deepEqual(parsed.skills.paths, ["/user/a", "/private/polyth/skills"]);
  assert.deepEqual(parsed.skills.urls, ["https://example.com/skills"]);
  assert.deepEqual(parsed.provider, { anthropic: {} });
  assert.deepEqual(parsed.plugin, ["oh-my-opencode"]);
  assert.deepEqual(parsed.agent, { build: {} });
  assert.equal(parsed.customFuture, 1);
});

test("physical OpenCode release deletes private revision resources", async () => {
  const space = spaceOf(tmp());
  const cwd = tmp();
  const applier = {
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as Pick<BackendConfigApplier, "applyBehavior" | "applyMcp">;
  const provisioner = createOpenCodeProvisioner(applier as BackendConfigApplier);
  await provisioner.apply({ spaceId: space.spaceId, projectId: "p", cwd, space }, {
    harnessId: "opencode",
    desiredRevision: "rev-a",
    items: [{
      capability: {
        id: "polyth.mcp.linear",
        kind: "mcp-server",
        owner: "polyth",
        scope: "space",
        revision: "1",
        name: "linear",
        enabled: true,
        transport: { kind: "http", url: "https://linear.example", headersSecretRefs: ["Authorization"] },
      },
      mode: "config",
      mutability: "requires-restart",
    }],
  }, { mcpSecrets: () => ({ Authorization: "secret-value" }) });
  const overlay = peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" });
  const parsed = JSON.parse(overlay!.configContent) as { mcp: { linear: { headers?: Record<string, string> } } };
  const fileRef = parsed.mcp.linear.headers?.Authorization ?? "";
  const secretPath = fileRef.startsWith("{file:") ? fileRef.slice(6, -1) : "";
  assert.ok(secretPath);
  assert.equal(existsSync(secretPath), true);
  provisioner.release?.({ spaceId: space.spaceId, projectId: "p", cwd, sessionId: "sess-a", space });
  assert.ok(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }));
  assert.equal(existsSync(secretPath), true);
  provisioner.release?.({ spaceId: space.spaceId, projectId: "p", cwd, space });
  assert.equal(peekOpenCodeLaunchOverlay({ cwd, spaceId: space.spaceId, projectId: "p" }), undefined);
  assert.equal(existsSync(secretPath), false);
});


test("V2 launch overlay preserves native server options and user skill sources", () => {
  const existing = { mcp: { servers: { user: { type: "remote", url: "https://example.test", timeout: { startup: 9000 } } }, codemode: { instructions: "preserve" } }, skills: ["/user/skills"], plugins: [{ package: "user-plugin", options: { future: true } }], future: { untouched: true } };
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(existing) };
  const result = applyOpenCodeLaunchOverlay(env, { configContent: JSON.stringify({ mcp: { generated: { type: "local", command: ["node", "probe"], enabled: true } } }), env: {}, desiredRevision: "one", capabilityIds: [] }, "v2");
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(existing));
  const merged = JSON.parse(result.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(merged, { ...existing, mcp: { ...existing.mcp, servers: { ...existing.mcp.servers, generated: { type: "local", command: ["node", "probe"], disabled: false } } } });
});
