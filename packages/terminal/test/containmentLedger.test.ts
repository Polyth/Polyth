import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalContainmentLedger } from "../src/containmentLedger.ts";
import type { ProcessContainmentBoundary } from "@polyth/harness-runtime/process-authority";
import type { SpaceStorage } from "@polyth/contracts";

const storage = (root: string): SpaceStorage => ({
  root,
  packageDir: (id) => join(root, "packages", id),
  path: (relative) => join(root, relative),
});

const boundary = (closed: string[]): ProcessContainmentBoundary => ({
  launch: (command, args) => ({ command, args: [...args] }),
  launcherExited: () => {},
  close: async () => { closed.push("closed"); },
});

test("ledger persists metadata before returning an injected boundary and releases matching roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-ledger-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const closed: string[] = [];
  const released: string[] = [];
  const space = storage(root);
  const ledger = createTerminalContainmentLedger({
    storageForProject: async () => space,
    storages: async () => [space, space],
    boundaryFactory: () => boundary(closed),
    releaseRecord: async (file) => { released.push(file); },
  });
  const handle = await ledger.create({ id: "terminal-1", projectId: "p", cwd: "/space/repo", workspaceRoots: ["/space/repo/secondary"] });
  assert.ok(handle);
  const recordDir = join(root, "packages", "terminal", "executions");
  const records = (await import("node:fs/promises")).readdir(recordDir);
  assert.equal((await records).filter((name) => name.endsWith(".json")).length, 1);
  await ledger.releaseByCwd("/space");
  assert.deepEqual(closed, ["closed"]);
  assert.equal(released.length, 0, "live boundaries close through their verified handle");
  await handle!.close();
  handle!.launcherExited();
  await handle!.close();
  assert.deepEqual(closed, ["closed"], "late exit notifications and repeated closes cannot recreate authority files");
  assert.deepEqual(await (await import("node:fs/promises")).readdir(recordDir), []);
});

test("unsupported boundaries remain pending and malformed records fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-ledger-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const space = storage(root);
  const ledger = createTerminalContainmentLedger({
    storageForProject: async () => space,
    storages: async () => [space],
    boundaryFactory: () => undefined,
    releaseRecord: async () => { throw new Error("must not release unsupported authority"); },
  });
  assert.equal(await ledger.create({ id: "terminal-2", projectId: "p", cwd: "/space/repo" }), undefined);
  const recordDir = join(root, "packages", "terminal", "executions");
  const record = (await import("node:fs/promises")).readdir(recordDir);
  const json = (await record).find((name) => name.endsWith(".json"));
  assert.ok(json);
  await assert.rejects(() => ledger.releaseAll(), { code: "outcome-unknown" });
  await writeFile(join(recordDir, json!), "{}", "utf8");
  await assert.rejects(() => ledger.releaseAll(), (error: unknown) => (error as { code?: string }).code === "outcome-unknown");
  assert.equal(await readFile(join(recordDir, json!), "utf8"), "{}");
});

test("a fresh ledger recovers only its Space records and preserves unmatched tenants", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-ledger-"));
  const foreignRoot = await mkdtemp(join(tmpdir(), "polyth-ledger-foreign-"));
  test.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(foreignRoot, { recursive: true, force: true }),
  ]));
  const space = storage(root);
  const executionDir = join(root, "packages", "terminal", "executions");
  const foreignDir = join(foreignRoot, "packages", "terminal", "executions");
  const id = "11111111-1111-4111-8111-111111111111";
  const authority = join(executionDir, `${id}.authority`);
  await (await import("node:fs/promises")).mkdir(executionDir, { recursive: true });
  await (await import("node:fs/promises")).mkdir(foreignDir, { recursive: true });
  await writeFile(authority, "authority", "utf8");
  await writeFile(join(executionDir, `${id}.json`), JSON.stringify({ version: 1, id, terminalId: "t", projectId: "p", cwd: "/space/repo", workspaceRoots: [], authorityFile: authority }), "utf8");
  await writeFile(join(foreignDir, `${id}.json`), JSON.stringify({ version: 1, id, terminalId: "foreign", projectId: "p", cwd: "/space/repo", workspaceRoots: [], authorityFile: join(foreignDir, `${id}.authority`) }), "utf8");
  await writeFile(join(foreignDir, `${id}.authority`), "authority", "utf8");
  const released: string[] = [];
  const ledger = createTerminalContainmentLedger({
    storageForProject: async () => space,
    storages: async () => [space],
    boundaryFactory: () => undefined,
    releaseRecord: async (file) => { released.push(file); },
  });
  await ledger.releaseByCwd("/space");
  assert.deepEqual(released, [authority]);
  await assert.rejects(() => readFile(join(executionDir, `${id}.json`)));
  assert.equal(await readFile(join(foreignDir, `${id}.json`), "utf8").then(() => true), true);
});
