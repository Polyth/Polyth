import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { discoverServerPackages } from "@polyth/plugins";
import { desktopServerPackages } from "../src/serverPackages.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packagesDir = join(repositoryRoot, "packages");

test("desktop bundles every discovered server package with its canonical descriptor", async () => {
  const expected = (await discoverServerPackages(packagesDir))
    .map(({ id, descriptor }) => ({ id, descriptor }));

  assert.deepEqual(
    desktopServerPackages
      .map(({ id, descriptor }) => ({ id, descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    expected,
  );
  assert.ok(desktopServerPackages.every(({ factory }) => typeof factory === "function"));
});
