import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstallLedger } from "../src/installLedger.ts";

const record = (serverId: string, entryId = "linear") => ({
  entryId,
  serverId,
  scope: "project" as const,
  projectId: "p1",
  at: 1_700_000_000_000,
});

async function dir(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "integration-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "integration-catalog");
}

test("a missing ledger is empty, not an error", (t) => {
  const ledger = createInstallLedger("/tmp/does-not-exist-integration-catalog");
  assert.deepEqual(ledger.list(), []);
  assert.deepEqual(ledger.forEntry("linear"), []);
});

test("no directory means in-memory nothing, and writes are refused", () => {
  const ledger = createInstallLedger(undefined);
  ledger.add(record("srv-1"));
  assert.deepEqual(ledger.list(), []);
});

test("add replaces the same server and writes the file", async (t) => {
  const path = await dir(t);
  const ledger = createInstallLedger(path);
  ledger.add(record("srv-1"));
  ledger.add({ ...record("srv-1"), at: 2 });
  ledger.add(record("srv-2", "github"));
  const written = JSON.parse(await readFile(join(path, "installs.json"), "utf8")) as { version: number; installs: unknown[] };
  assert.equal(written.version, 1);
  assert.equal(written.installs.length, 2);
  assert.deepEqual(ledger.forEntry("linear").map((row) => row.serverId), ["srv-1"]);
  assert.equal(ledger.forEntry("linear")[0]!.at, 2);
});

test("forget drops exactly one server", async (t) => {
  const path = await dir(t);
  const ledger = createInstallLedger(path);
  ledger.add(record("srv-1"));
  ledger.add(record("srv-2"));
  ledger.forget("srv-1");
  assert.deepEqual(ledger.list().map((row) => row.serverId), ["srv-2"]);
});

test("a corrupt or foreign ledger reads as empty instead of breaking the page", async (t) => {
  const path = await dir(t);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "installs.json"), "{ not json", "utf8");
  assert.deepEqual(createInstallLedger(path).list(), []);

  await writeFile(join(path, "installs.json"), JSON.stringify({ version: 1, installs: [{ nope: true }] }), "utf8");
  assert.deepEqual(createInstallLedger(path).list(), []);
});
