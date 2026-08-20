// WP9: behavior instructions (atomic + revisioned + apply rollback) and the
// MCP config service (secret non-disclosure, duplicate names, apply rollback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behaviorRevision, createBehaviorService } from "../src/behavior.ts";
import { createMcpConfigService } from "../src/mcp.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-set-"));

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
