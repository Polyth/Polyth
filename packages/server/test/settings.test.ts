// WP9: behavior instructions (atomic + revisioned + apply rollback) and the
// MCP config service (secret non-disclosure, duplicate names, apply rollback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behaviorRevision, createBehaviorService, favoriteSubagentRoutingSection } from "../src/behavior.ts";
import { createClientSettings } from "../src/clientSettings.ts";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "../src/mcp.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-set-"));

test("client settings: opaque blob round-trips with a monotonic revision", () => {
  const file = join(tmp(), "client-settings.json");
  const svc = createClientSettings({ file });

  const empty = svc.get();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.settings, {});

  const one = svc.put({ product: { density: "compact" }, ui: { fontSize: "l" } });
  assert.equal(one.revision, 1);
  assert.deepEqual(one.settings, { product: { density: "compact" }, ui: { fontSize: "l" } });

  const two = svc.put({ product: { density: "balanced" } });
  assert.equal(two.revision, 2);
  assert.equal(svc.get().revision, 2);

  // A fresh service instance recovers the last accepted state from disk.
  const reopened = createClientSettings({ file });
  assert.equal(reopened.get().revision, 2);
  assert.deepEqual(reopened.get().settings, { product: { density: "balanced" } });
});

test("client settings: non-objects and oversized payloads are rejected", () => {
  const svc = createClientSettings({ file: join(tmp(), "client-settings.json") });
  for (const bad of [null, "string", 42, ["a"], true]) {
    assert.throws(() => svc.put(bad), (e: Error & { code?: string }) => e.code === "invalid-input");
  }
  assert.throws(
    () => svc.put({ blob: "x".repeat(256 * 1024 + 1) }),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
  // A rejected write never bumps the revision.
  assert.equal(svc.get().revision, 0);
});

test("behavior: get/put round-trip with revision, conflict on stale write", async () => {
  const svc = createBehaviorService({ file: join(tmp(), "behavior.md") });
  const empty = await svc.get();
  assert.equal(empty.text, "");
  assert.equal(empty.revision, behaviorRevision(""));

  const one = await svc.put("Be brief.\n", empty.revision);
  assert.equal(one.text, "Be brief.\n");
  assert.notEqual(one.revision, empty.revision);

  // Writing with the outdated revision is a conflict, content is preserved.
  await assert.rejects(
    () => svc.put("Other text", empty.revision),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
  assert.equal((await svc.get()).text, "Be brief.\n");

  // current() exposes revision+digest for the instructions-applied event.
  const cur = await svc.current();
  assert.equal(cur!.revision, one.revision);
  assert.equal(cur!.digest.length, 64);
});

test("behavior: size limit enforced; failed backend apply rolls the file back", async () => {
  const file = join(tmp(), "behavior.md");
  let failApply = false;
  const svc = createBehaviorService({
    file,
    applier: {
      behaviorPath: () => "/nowhere/AGENTS.md",
      applyBehavior: async (text) => {
        if (failApply) throw new Error("backend rejected config");
        return text.length;
      },
    },
  });

  const base = await svc.get();
  await assert.rejects(() => svc.put("x".repeat(256 * 1024 + 1), base.revision), /256 KiB/);

  const good = await svc.put("keep me\n", base.revision);
  failApply = true;
  await assert.rejects(() => svc.put("lose me\n", good.revision), /rolled back/);
  // Canonical copy still matches what the backend actually runs with.
  assert.equal(readFileSync(file, "utf8"), "keep me\n");
  assert.equal((await svc.get()).revision, good.revision);
});

test("behavior: favorite subagent policy is enabled by default, applied, and rolled back on failure", async () => {
  const dir = tmp();
  const applied: string[] = [];
  let fail = false;
  const svc = createBehaviorService({
    file: join(dir, "behavior.md"),
    policyFile: join(dir, "behavior-policy.json"),
    applier: {
      behaviorPath: () => "/nowhere/AGENTS.md",
      applyBehavior: async (text) => {
        if (fail) throw new Error("nope");
        applied.push(text);
        return text.length;
      },
    },
  });

  assert.deepEqual(await svc.subagentPolicy(), { enabled: true });
  await svc.refresh();
  assert.match(applied.at(-1)!, /Never spawn a subagent that merely inherits/);
  assert.ok(applied.at(-1)!.includes(favoriteSubagentRoutingSection));

  assert.deepEqual(await svc.putSubagentPolicy(false), { enabled: false });
  assert.doesNotMatch(applied.at(-1)!, /Favorite subagent routing/);

  fail = true;
  await assert.rejects(() => svc.putSubagentPolicy(true), /rolled back/);
  assert.deepEqual(await svc.subagentPolicy(), { enabled: false });
});

test("mcp: CRUD with revisions; secrets stored but never returned", async () => {
  const dir = tmp();
  const svc = createMcpConfigService({ file: join(dir, "mcp.json") });

  const created = await svc.create({
    name: "context-db",
    transport: { kind: "stdio", command: "ctx-server", args: ["--stdio"], envKeys: ["CTX_TOKEN"] },
    secrets: { CTX_TOKEN: "super-secret-value" },
  });
  assert.equal(created.revision, 1);
  assert.equal(created.status, "starting");
  // DTO carries key names only.
  assert.deepEqual((created.transport as { envKeys: string[] }).envKeys, ["CTX_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(svc.list()), /super-secret-value/);
  // and the structure file on disk holds no secret values either
  assert.doesNotMatch(readFileSync(join(dir, "mcp.json"), "utf8"), /super-secret-value/);

  // duplicate name rejected
  await assert.rejects(
    () => svc.create({ name: "context-db", transport: { kind: "http", url: "https://x.example", headersSecretRefs: [] } }),
    /already exists/,
  );

  // stale revision → conflict; fresh revision works
  await assert.rejects(() => svc.update(created.id, { enabled: false }, 99), /changed since/);
  const off = await svc.update(created.id, { enabled: false }, 1);
  assert.equal(off.status, "disabled");
  assert.equal(off.revision, 2);

  assert.equal(await svc.remove(created.id), true);
  assert.equal(await svc.remove(created.id), false);
});

test("mcp: transport validation refuses shell metacharacters and bad URLs", async () => {
  const svc = createMcpConfigService({ file: join(tmp(), "mcp.json") });
  await assert.rejects(
    () => svc.create({ name: "evil", transport: { kind: "stdio", command: "rm -rf / ; echo", args: [], envKeys: [] } }),
    /bare executable/,
  );
  await assert.rejects(
    () => svc.create({ name: "bad-url", transport: { kind: "http", url: "ftp://host", headersSecretRefs: [] } }),
    /http\(s\)/,
  );
});

test("mcp: failed backend apply rolls the stored list back", async () => {
  const dir = tmp();
  let fail = false;
  const applied: string[][] = [];
  const svc = createMcpConfigService({
    file: join(dir, "mcp.json"),
    applier: {
      applyMcp: async (entries) => {
        if (fail) throw new Error("backend config invalid");
        applied.push(entries.map((e) => e.name));
      },
    },
  });

  await svc.create({ name: "alpha", transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } });
  assert.deepEqual(applied.at(-1), ["alpha"]);

  fail = true;
  await assert.rejects(
    () => svc.create({ name: "beta", transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } }),
    /rolled back/,
  );
  assert.deepEqual(svc.list().map((s) => s.name), ["alpha"], "failed create rolled back");
  // secrets passed to the applier resolve env keys to values, proving the
  // seam works without those values ever reaching a DTO
  fail = false;
  const b = await svc.create({
    name: "gamma",
    transport: { kind: "stdio", command: "srv", args: [], envKeys: ["KEY"] },
    secrets: { KEY: "v" },
  });
  assert.ok(b.id);
  assert.deepEqual(applied.at(-1), ["alpha", "gamma"]);
});

test("mcp: seed parser maps opencode.json entries to creatable inputs", () => {
  const entries = mcpEntriesFromBackendConfig({
    theme: "dark",
    mcp: {
      ctx: { type: "local", command: ["ctx-server", "--stdio"], enabled: true, environment: { API_KEY: "secret-v" } },
      web: { type: "remote", url: "https://x.example/mcp", enabled: false, headers: { Authorization: "Bearer t" } },
      broken: { type: "local", command: [] },
      junk: "nope",
    },
  });
  assert.equal(entries.length, 2, "unparseable entries are skipped");
  const ctx = entries.find((e) => e.name === "ctx")!;
  assert.deepEqual(ctx.transport, { kind: "stdio", command: "ctx-server", args: ["--stdio"], envKeys: ["API_KEY"] });
  assert.deepEqual(ctx.secrets, { API_KEY: "secret-v" });
  assert.equal(ctx.enabled, true);
  const web = entries.find((e) => e.name === "web")!;
  assert.deepEqual(web.transport, { kind: "http", url: "https://x.example/mcp", headersSecretRefs: ["Authorization"] });
  assert.equal(web.enabled, false);
  assert.deepEqual(mcpEntriesFromBackendConfig({}), []);
});

test("mcp: seeded entries never expose secret values through the DTO", async () => {
  const svc = createMcpConfigService({ file: join(tmp(), "mcp.json") });
  for (const entry of mcpEntriesFromBackendConfig({
    mcp: { ctx: { type: "local", command: ["ctx"], environment: { API_KEY: "super-secret" } } },
  })) {
    await svc.create(entry);
  }
  const dto = svc.list()[0]!;
  assert.equal(JSON.stringify(dto).includes("super-secret"), false, "secret value never serialized");
  assert.deepEqual((dto.transport as { envKeys: string[] }).envKeys, ["API_KEY"], "only the key name is visible");
});

test("mcp: disabled servers are removed from the applied config entirely (F10)", async () => {
  const applied: string[][] = [];
  const svc = createMcpConfigService({
    file: join(tmp(), "mcp.json"),
    applier: { applyMcp: async (entries) => { applied.push(entries.map((e) => e.name)); } },
  });

  const a = await svc.create({ name: "alpha", transport: { kind: "http", url: "https://a.example", headersSecretRefs: [] } });
  await svc.create({ name: "beta", transport: { kind: "http", url: "https://b.example", headersSecretRefs: [] } });
  assert.deepEqual(applied.at(-1), ["alpha", "beta"]);

  // disabling drops the entry from what the backend sees — not enabled:false
  await svc.update(a.id, { enabled: false }, a.revision);
  assert.deepEqual(applied.at(-1), ["beta"]);
  // …but it stays in the stored list for the UI
  assert.deepEqual(svc.list().map((s) => `${s.name}:${s.enabled}`), ["alpha:false", "beta:true"]);

  const off = svc.list().find((s) => s.name === "alpha")!;
  await svc.update(off.id, { enabled: true }, off.revision);
  assert.deepEqual(applied.at(-1), ["alpha", "beta"]);
});

test("mcp: stdio test reports command reachability honestly", async () => {
  const svc = createMcpConfigService({ file: join(tmp(), "mcp.json") });
  const there = await svc.create({ name: "node-echo", transport: { kind: "stdio", command: "node", args: [], envKeys: [] } });
  const gone = await svc.create({ name: "ghost", transport: { kind: "stdio", command: "definitely-not-a-real-binary-xyz", args: [], envKeys: [] } });

  const ok = await svc.test(there.id);
  assert.equal(ok.ok, true);
  const bad = await svc.test(gone.id);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not found/);
  const row = svc.list().find((s) => s.id === gone.id)!;
  assert.equal(row.status, "error");
});
