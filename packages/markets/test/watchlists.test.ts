import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceStorage } from "@polyth/contracts";
import { DEFAULT_WATCHLISTS, loadWatchlists, parseWatchlists, saveWatchlists } from "../src/watchlists.ts";

async function storage(): Promise<SpaceStorage> {
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-watchlists-"));
  return {
    root,
    packageDir(packageId) {
      assert.equal(packageId, "markets");
      return join(root, "packages", packageId);
    },
    path(relative) {
      return join(root, relative);
    },
  };
}

test("missing watchlists return an independent default document", async () => {
  const store = await storage();
  const first = await loadWatchlists(store);
  first.items[0]!.symbols.push("NVDA");
  const second = await loadWatchlists(store);
  assert.deepEqual(second, DEFAULT_WATCHLISTS);
});

test("watchlists normalize symbols and reject invalid documents", () => {
  const parsed = parseWatchlists({
    version: 1,
    activeId: "tech",
    items: [{ id: "tech", name: " Tech ", symbols: [" nvda ", "NVDA", "aapl"] }],
  });
  assert.deepEqual(parsed.items[0], { id: "tech", name: "Tech", symbols: ["NVDA", "AAPL"] });
  assert.throws(() => parseWatchlists({ version: 1, activeId: "missing", items: [{ id: "main", name: "Main", symbols: [] }] }), /does not exist/);
  assert.throws(() => parseWatchlists({ version: 1, activeId: "main", items: [{ id: "main", name: "Main", symbols: ["../../etc/passwd"] }] }), /invalid market symbol/);
});

test("watchlists persist a validated document atomically", async () => {
  const store = await storage();
  const saved = await saveWatchlists(store, {
    version: 1,
    activeId: "main",
    items: [{ id: "main", name: "Main", symbols: ["SPY", "NVDA"] }],
  });
  assert.deepEqual(await loadWatchlists(store), saved);
  const raw = await readFile(join(store.root, "packages", "markets", "watchlists.json"), "utf8");
  assert.match(raw, /"NVDA"/);
});
