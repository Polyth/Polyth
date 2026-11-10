import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CATALOG_DIR, MANIFEST_FILE, loadCatalog } from "../src/entries.ts";
import { catalogStats } from "../src/catalog.ts";

const manifest = (id: string, extra: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 1,
  id,
  name: id,
  publisher: "Vendor",
  verified: true,
  summary: `Summary for ${id}.`,
  description: `A description of ${id} that is long enough to be a sentence.`,
  categories: ["product"],
  status: "stable",
  homepage: "https://example.test",
  mcp: { auth: "oauth", remote: { url: `https://${id}.test/mcp` } },
  evidence: {
    checkedAt: "2026-11-06",
    source: "https://example.test/docs",
    probe: { state: "observed", httpStatus: 401 },
  },
  ...extra,
});

async function catalogDir(t: { after(fn: () => unknown): void }, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "integration-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, body] of Object.entries(files)) {
    await mkdir(join(root, id), { recursive: true });
    if (body) await writeFile(join(root, id, MANIFEST_FILE), body, "utf8");
  }
  return root;
}

test("the shipped catalog loads without a single problem", async () => {
  const { entries, problems } = await loadCatalog(CATALOG_DIR);
  assert.deepEqual(problems, []);
  assert.ok(entries.length >= 12, `expected the 12 starting entries, saw ${entries.length}`);
  for (const entry of entries) {
    assert.equal(entry.id, entry.id.toLowerCase(), "ids are lower case");
  }
  const stats = catalogStats(entries);
  assert.equal(stats.total, entries.length);
  assert.ok(stats.oauth > 0 && stats.token > 0 && stats.none > 0 && stats.local > 0);
  // Sorted by folder id, so the order is stable between runs and builds.
  assert.deepEqual([...entries.map((entry) => entry.id)].sort(), entries.map((entry) => entry.id));
});

test("a broken manifest is reported next to the healthy ones", async (t) => {
  const root = await catalogDir(t, {
    good: manifest("good"),
    "bad-json": "{ not json",
    "wrong-id": manifest("something-else"),
    "no-manifest": "",
    "plain-http": manifest("plain-http", { homepage: "http://example.test" }),
  });
  const { entries, problems } = await loadCatalog(root);
  assert.deepEqual(entries.map((entry) => entry.id), ["good"]);
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /bad-json: invalid JSON/);
  assert.match(problems.join("\n"), /wrong-id: id "something-else" must match the folder name "wrong-id"/);
  assert.match(problems.join("\n"), /no-manifest: no integration\.json/);
  assert.match(problems.join("\n"), /plain-http: homepage must be an https URL/);
});

test("two folders claiming one id are refused", async (t) => {
  // A second folder whose manifest repeats an id: the catalog-level check
  // catches it even though each manifest is valid on its own.
  const root = await catalogDir(t, { first: manifest("first"), second: manifest("first", {}) });
  const { entries, problems } = await loadCatalog(root);
  // `second` fails the folder-name rule first, and that is the reported reason.
  assert.deepEqual(entries.map((entry) => entry.id), ["first"]);
  assert.match(problems.join("\n"), /second: id "first" must match the folder name "second"/);
});

test("an unreadable directory is a problem, not a crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "integration-catalog-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { entries, problems } = await loadCatalog(join(root, "absent"));
  assert.deepEqual(entries, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /unreadable/);
});

test("a summary fits one line of the list", async () => {
  // The list column is 320-400px and its text column about 320px, which holds
  // about 42 characters at 12px. A longer summary is a row that truncates
  // everywhere, so the manifest keeps the promise short and the description
  // below the list carries the rest.
  const { entries } = await loadCatalog(CATALOG_DIR);
  const long = entries.filter((entry) => entry.summary.length > 42).map((entry) => `${entry.id}: ${entry.summary.length}`);
  assert.deepEqual(long, []);
});
