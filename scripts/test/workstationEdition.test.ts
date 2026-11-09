// The workstation edition (docs/security/workstation-edition.md) ships only
// packages that opt in through `polyth.editions`. The security page lists them;
// this keeps that list equal to the manifests, so adding a package to the
// edition is always a visible, reviewed change.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const doc = join(root, "docs", "security", "workstation-edition.md");

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  polyth?: { serverEntry?: string; editions?: unknown };
}

const manifests = new Map(readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
  .map((entry) => [entry.name, JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) as Manifest]));
const byName = new Map([...manifests].map(([id, manifest]) => [manifest.name ?? `@polyth/${id}`, id]));
const inWorkstation = (manifest: Manifest | undefined): boolean =>
  Array.isArray(manifest?.polyth?.editions) && manifest.polyth.editions.includes("workstation");
const workstation = [...manifests].filter(([, manifest]) => inWorkstation(manifest)).map(([id]) => id).sort();

test("the security page lists exactly the packages that opt into the workstation edition", () => {
  const text = readFileSync(doc, "utf8");
  const block = /<!-- workstation-packages:start -->\n([\s\S]*?)<!-- workstation-packages:end -->/.exec(text)?.[1];
  assert.ok(block, "docs/security/workstation-edition.md lost its package list markers");
  const listed = block.split("\n").map((line) => /^- (\S+)$/.exec(line.trim())?.[1]).filter((id): id is string => !!id);
  assert.deepEqual(listed, workstation);
});

test("only packages with a server entry opt in", () => {
  for (const id of workstation) assert.ok(manifests.get(id)?.polyth?.serverEntry, `${id} lists an edition but has no polyth.serverEntry`);
});

test("a workstation package depends on no feature package outside the edition", () => {
  const offenders: string[] = [];
  for (const id of workstation) {
    const manifest = manifests.get(id)!;
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      const target = byName.get(dependency);
      if (!target) continue;
      const targetManifest = manifests.get(target);
      if (targetManifest?.polyth?.serverEntry && !inWorkstation(targetManifest)) offenders.push(`${id} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, []);
});
