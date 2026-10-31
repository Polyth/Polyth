import test from "node:test";
import assert from "node:assert/strict";
import { uniquePackageLaunchers } from "../src/packageLaunchers.ts";

test("each package has one ordered rail entry, preferring its canonical home", () => {
  const entries = [
    { id: "context" },
    { id: "markets.overview", ownerPackageId: "markets" },
    { id: "git", ownerPackageId: "git" },
    { id: "markets", ownerPackageId: "markets" },
    { id: "markets.portfolio", ownerPackageId: "markets" },
    { id: "git.history", ownerPackageId: "git" },
    { id: "events", ownerPackageId: "host" },
    { id: "session", ownerPackageId: "host" },
  ];
  assert.deepEqual(uniquePackageLaunchers(entries, (entry) => entry).map((entry) => entry.id),
    ["context", "git", "markets", "events", "session"]);
});

test("a package with no canonical home keeps its first entry; missing owners stay distinct", () => {
  const entries = [
    { id: "alpha.first", ownerPackageId: "alpha" },
    { id: "alpha.second", ownerPackageId: "alpha" },
    { id: "one" }, { id: "two" },
  ];
  assert.deepEqual(uniquePackageLaunchers(entries, (entry) => entry), [entries[0], entries[2], entries[3]]);
});
