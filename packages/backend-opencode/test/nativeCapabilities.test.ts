import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessCapabilityApplicationReceipt, HarnessContext, HarnessProvisioningPlan } from "@polyth/contracts";
import { createOpenCodeProvisioner, peekOpenCodeLaunchOverlay, applyOpenCodeLaunchOverlay } from "../src/provisioner.ts";
import { verifyOpenCodeCapabilities } from "../src/capabilityDelivery.ts";
import type { BackendConfigApplier } from "../src/config.ts";

const provisioner = () => createOpenCodeProvisioner({} as BackendConfigApplier);
const contextAt = (root: string, spaceId = "a"): HarnessContext => {
  const storageDir = join(root, spaceId);
  mkdirSync(storageDir, { recursive: true });
  return { spaceId, projectId: "project", cwd: root, space: {
    spaceId, spaceSlug: spaceId, storageDir, userId: "user", role: "owner", deployment: "local-trusted",
  } };
};
const plan = (revision = "one"): HarnessProvisioningPlan => ({
  harnessId: "opencode", desiredRevision: revision,
  items: [{ capability: {
    id: "fixture.probe", owner: "fixture", kind: "skill", scope: "project", revision,
    name: "probe", title: "Probe", description: "Native discovery probe", instructions: "Return a deterministic probe.",
  }, mode: "filesystem", mutability: "requires-restart" }],
});
const secrets = { mcpSecrets: () => ({}) };

test("OpenCode native readback separates discovery, connection and invocation", async () => {
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const overlay = { configContent: "", env: {}, desiredRevision: "r", capabilityIds: ["skill", "mcp"],
    skills: [{ capabilityId: "skill", name: "probe", path: "/private/probe/SKILL.md" }], mcpNames: { mcp: "probe" } };
  const target = { spaceId: "a", projectId: "p", cwd: "/work", harnessId: "opencode", authorityId: "authority", generation: 4 };
  await verifyOpenCodeCapabilities(overlay, target, async (path) => path === "/skill"
    ? [{ name: "probe", location: "/foreign/probe/SKILL.md" }] : { probe: { status: "connected" } }, (receipt) => receipts.push(receipt));
  assert.equal(receipts[0]?.outcome, "failed", "same name from another Space is not discovery");
  assert.equal(receipts[1]?.evidence?.stage, "connected");
  assert.equal(receipts[1]?.target.generation, 4);
  assert.ok(receipts.every((receipt) => receipt.evidence?.stage !== "invocable"));
  receipts.length = 0;
  await verifyOpenCodeCapabilities(overlay, target, async () => { throw new Error("unavailable"); }, (receipt) => receipts.push(receipt));
  assert.ok(receipts.every((receipt) => receipt.outcome === "unverifiable"));
});

test("OpenCode private revisions reject symlinks and remain leased until release", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-oc-private-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = contextAt(root);
  const provider = provisioner();
  await provider.apply(context, plan(), secrets);
  const first = peekOpenCodeLaunchOverlay(context)!;
  const customEnv = { OPENCODE_CONFIG: join(root, "user-config.json") };
  assert.throws(() => applyOpenCodeLaunchOverlay(customEnv, first), /cannot be relocated safely/);
  assert.equal(customEnv.OPENCODE_CONFIG, join(root, "user-config.json"));
  const before = readFileSync(first.skills![0]!.path, "utf8");
  const conflicting = plan();
  const changed = conflicting.items[0]!.capability;
  if (changed.kind === "skill") changed.instructions = "Changed without changing the revision";
  const conflict = await provider.apply(context, conflicting, secrets);
  assert.equal(conflict.records[0]?.status, "failed");
  assert.equal(readFileSync(first.skills![0]!.path, "utf8"), before);
  const second = { ...plan("two"), items: [], keepRevisions: ["one", "two"] };
  await provider.apply(context, second, secrets);
  assert.ok(readFileSync(first.skills![0]!.path, "utf8"));
  assert.deepEqual(peekOpenCodeLaunchOverlay(context)?.skills, []);
  provider.release?.(context);
  rmSync(join(context.space!.storageDir, "runtime"), { recursive: true, force: true });
  const foreign = contextAt(root, "foreign");
  symlinkSync(foreign.space!.storageDir, join(context.space!.storageDir, "runtime"));
  const result = await provider.apply(context, plan("three"), secrets).catch(() => undefined);
  assert.ok(!result || result.records[0]?.status === "failed");
  assert.throws(() => readFileSync(join(foreign.space!.storageDir, "opencode")), { code: "ENOENT" });
});

test("OpenCode process discovers/removes private skills and connects fixture MCP without a model", {
  skip: process.env.POLYTH_NATIVE_CAPABILITY_TESTS !== "1",
  timeout: 90_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-oc-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = provisioner();
  const context = contextAt(root);
  const binary = process.env.POLYTH_OPENCODE_TEST_BINARY || "opencode";
  const fixture = join(import.meta.dirname, "fixtures", "capabilityMcp.mjs");
  const desired = plan();
  desired.items.push({ capability: {
    id: "fixture.mcp", owner: "fixture", kind: "mcp-server", scope: "project", revision: "one",
    name: "native-probe", enabled: true,
    transport: { kind: "stdio", command: process.execPath, args: [fixture], envKeys: [] },
  }, mode: "config", mutability: "requires-restart" });
  await provider.apply(context, desired, secrets);
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" };
  delete baseEnv.OPENCODE_CONFIG;
  delete baseEnv.OPENCODE_CONFIG_CONTENT;
  delete baseEnv.OPENCODE_CONFIG_DIR;
  const list = (ctx: HarnessContext) => {
    const overlay = peekOpenCodeLaunchOverlay(ctx)!;
    const result = JSON.parse(execFileSync(binary, ["debug", "skill"], {
      cwd: root, env: applyOpenCodeLaunchOverlay(baseEnv, overlay), encoding: "utf8", timeout: 25_000,
    }));
    return result as Array<{ name: string; location: string }>;
  };
  const overlay = peekOpenCodeLaunchOverlay(context)!;
  const skill = overlay.skills![0]!;
  assert.ok(list(context).some((row) => row.name === skill.name && row.location === skill.path));
  const other = contextAt(root, "b");
  await provider.apply(other, { ...plan(), items: [] }, secrets);
  assert.ok(!list(other).some((row) => row.name === skill.name));
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root, env: applyOpenCodeLaunchOverlay(baseEnv, overlay), stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode listen timeout")), 25_000);
      let output = "";
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      child.stdout!.on("data", read); child.stderr!.on("data", read);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("OpenCode exited before listening")); });
    });
    const receipts: HarnessCapabilityApplicationReceipt[] = [];
    await verifyOpenCodeCapabilities(overlay, { spaceId: "a", projectId: "project", cwd: root, harnessId: "opencode" },
      async (path) => {
        const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(15_000) });
        assert.equal(response.ok, true);
        return response.json();
      }, (receipt) => receipts.push(receipt));
    assert.equal(receipts.find((receipt) => receipt.capabilityIds.includes("fixture.probe"))?.evidence?.stage, "discovered");
    assert.equal(receipts.find((receipt) => receipt.capabilityIds.includes("fixture.mcp"))?.evidence?.stage, "connected");
  } finally {
    const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await closed;
  }
  await provider.apply(context, { ...plan("removed"), items: [], keepRevisions: ["one", "removed"] }, secrets);
  assert.ok(!list(context).some((row) => row.name === skill.name));
});
