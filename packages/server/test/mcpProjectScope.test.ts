import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import { createMcpConfigService } from "../src/mcp.ts";

const root = () => mkdtempSync(join(tmpdir(), "polyth-mcp-project-"));
const space = (base: string, id: string, userId: string, role: SpaceContext["role"] = "owner"): SpaceContext => {
  const storageDir = join(base, "spaces", id);
  mkdirSync(storageDir, { recursive: true });
  return {
    spaceId: id,
    spaceSlug: id,
    userId,
    role,
    deployment: "server-trusted",
    storageDir,
  };
};

const code = (error: unknown): string | undefined =>
  error && typeof error === "object" ? (error as { code?: string }).code : undefined;

const http = (url: string, secret = "TOKEN") => ({
  kind: "http" as const,
  url,
  headersSecretRefs: [secret],
});

test("project MCP resolution is isolated, deterministic, persistent, and cleanup-safe", async () => {
  const dataDir = root();
  const a = space(dataDir, "space-a", "user-a");
  const b = space(dataDir, "space-b", "user-b");
  const owners = new Map([
    ["project-a", "space-a"],
    ["project-b", "space-a"],
    ["project-foreign", "space-b"],
  ]);
  const service = () => createMcpConfigService({
    dataDir,
    deployment: "server-trusted",
    assertProject(ctx, projectId) {
      if (owners.get(projectId) !== ctx.spaceId) {
        throw Object.assign(new Error("project not found"), { code: "not-found" });
      }
    },
  });
  const mcp = service();

  await mcp.create(a, {
    name: "shared",
    transport: http("https://space.example"),
    secrets: { TOKEN: "space-secret" },
  });
  await mcp.create(a, {
    name: "a-only",
    transport: http("https://a-only.example"),
    secrets: { TOKEN: "a-only-secret" },
  }, "project-a");
  await mcp.create(a, {
    name: "b-only",
    transport: http("https://b-only.example"),
    secrets: { TOKEN: "b-only-secret" },
  }, "project-b");
  await mcp.create(a, {
    name: "db",
    transport: http("https://db-a.example"),
    secrets: { TOKEN: "db-a-secret" },
  }, "project-a");
  await mcp.create(a, {
    name: "db",
    transport: http("https://db-b.example"),
    secrets: { TOKEN: "db-b-secret" },
  }, "project-b");
  await mcp.create(a, {
    name: "shared",
    transport: http("https://project-a.example"),
    secrets: { TOKEN: "project-a-secret" },
  }, "project-a");

  const rowsA = mcp.list(a, "project-a");
  const rowsB = mcp.list(a, "project-b");
  assert.deepEqual(rowsA.map((row) => row.name), ["a-only", "db", "shared"]);
  assert.deepEqual(rowsB.map((row) => row.name), ["b-only", "db", "shared"]);
  assert.equal((rowsA.find((row) => row.name === "db")?.transport as { url?: string }).url, "https://db-a.example");
  assert.equal((rowsB.find((row) => row.name === "db")?.transport as { url?: string }).url, "https://db-b.example");
  assert.equal((rowsA.find((row) => row.name === "shared")?.transport as { url?: string }).url, "https://project-a.example");
  assert.equal((rowsB.find((row) => row.name === "shared")?.transport as { url?: string }).url, "https://space.example");
  assert.equal(rowsA.find((row) => row.name === "shared")?.scope, "project");
  assert.equal(rowsB.find((row) => row.name === "shared")?.scope, "space");
  assert.doesNotMatch(JSON.stringify(rowsA), /project-a-secret|db-a-secret|space-secret/);

  const snapA = mcp.projection(a, "project-a");
  const sharedA = snapA.servers.find((row) => row.name === "shared")!;
  const dbA = snapA.servers.find((row) => row.name === "db")!;
  assert.deepEqual(snapA.secretsFor(sharedA.id), { TOKEN: "project-a-secret" });
  assert.deepEqual(snapA.secretsFor(dbA.id), { TOKEN: "db-a-secret" });
  assert.equal(snapA.servers.some((row) => row.name === "b-only"), false);

  const projectShared = rowsA.find((row) => row.name === "shared")!;
  assert.equal(await mcp.remove(a, projectShared.id, "project-a"), true);
  assert.equal(
    (mcp.list(a, "project-a").find((row) => row.name === "shared")?.transport as { url?: string }).url,
    "https://space.example",
    "removing a project override must reveal the inherited Space MCP",
  );

  const projectDbA = mcp.list(a, "project-a").find((row) => row.name === "db")!;
  assert.equal(await mcp.remove(a, projectDbA.id, "project-a"), true);
  assert.equal(mcp.list(a, "project-a").some((row) => row.name === "db"), false);
  assert.equal(
    (mcp.list(a, "project-b").find((row) => row.name === "db")?.transport as { url?: string }).url,
    "https://db-b.example",
    "uninstall in A must not mutate B",
  );

  const reloaded = service();
  assert.deepEqual(reloaded.list(a, "project-a").map((row) => row.name), ["a-only", "shared"]);
  assert.deepEqual(reloaded.list(a, "project-b").map((row) => row.name), ["b-only", "db", "shared"]);

  assert.throws(() => reloaded.list(a, "project-foreign"), (error) => code(error) === "not-found");
  await assert.rejects(
    () => reloaded.create(a, { name: "foreign", transport: http("https://foreign.example") }, "project-foreign"),
    (error) => code(error) === "not-found",
  );
  assert.deepEqual(reloaded.list(b), [], "another user's Space must not see Space A installations");

  reloaded.removeProject(a, "project-a");
  assert.deepEqual(reloaded.list(a, "project-a").map((row) => row.name), ["shared"]);
  assert.deepEqual(reloaded.list(a, "project-b").map((row) => row.name), ["b-only", "db", "shared"]);
  assert.deepEqual(reloaded.list(a).map((row) => row.name), ["shared"]);
});

test("MCP scope writes enforce Space roles", async () => {
  const dataDir = root();
  const owners = new Map([["project-a", "space-a"]]);
  const make = (role: SpaceContext["role"]) => space(dataDir, "space-a", `user-${role}`, role);
  const mcp = createMcpConfigService({
    dataDir,
    deployment: "server-trusted",
    assertProject(ctx, projectId) {
      if (owners.get(projectId) !== ctx.spaceId) throw Object.assign(new Error("project not found"), { code: "not-found" });
    },
  });

  await assert.rejects(
    () => mcp.create(make("viewer"), { name: "nope", transport: http("https://nope.example") }, "project-a"),
    (error) => code(error) === "forbidden",
  );
  await assert.rejects(
    () => mcp.create(make("member"), { name: "space-admin", transport: http("https://space.example") }),
    (error) => code(error) === "forbidden",
  );
  await mcp.create(make("member"), { name: "project-ok", transport: http("https://project.example") }, "project-a");
  assert.deepEqual(mcp.list(make("member"), "project-a").map((row) => row.name), ["project-ok"]);
});
