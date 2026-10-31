import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { createPackageResidue, personPackageResidueRoots } from "../src/packageResidue.ts";
import { packageRoutes } from "../src/routes/packages.ts";
import type { PackageRegistry } from "../src/packages.ts";

test("residue lists and purges only data of package ids nobody installs", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-residue-"));
  try {
    const shared = join(root, "packages");
    const space = join(root, "spaces", "one", "packages");
    const outside = join(root, "outside");
    for (const dir of [join(shared, "ssh"), join(shared, "gone"), join(space, "gone"), join(space, "git"), outside]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(shared, "gone", "a.json"), "12345");
    writeFileSync(join(space, "gone", "b.json"), "123");
    writeFileSync(join(outside, "keep.txt"), "keep");
    // A link planted inside residue must be removed, never followed.
    symlinkSync(outside, join(space, "gone", "link"));
    // A top-level link named like a package is never collected.
    symlinkSync(outside, join(shared, "linked"));

    const installed = new Set(["ssh", "git"]);
    const residue = createPackageResidue({
      roots: () => [{ spaceId: null, dir: shared }, { spaceId: "spc-1", dir: space }],
      installedIds: () => installed,
    });

    const listed = residue.list();
    assert.deepEqual(listed.map((entry) => entry.id), ["gone"]);
    assert.equal(listed[0]!.bytes >= 8, true);
    assert.deepEqual(listed[0]!.locations.map((location) => location.spaceId), [null, "spc-1"]);
    assert.equal(JSON.stringify(listed).includes(root), false, "server paths stay internal");

    assert.throws(() => residue.purge("ssh"), (error: Error & { code?: string }) => error.code === "conflict");
    assert.throws(() => residue.purge("../x"), (error: Error & { code?: string }) => error.code === "invalid-input");
    assert.equal(residue.purge("missing"), null);

    assert.equal(residue.purge("gone")?.id, "gone");
    assert.equal(existsSync(join(shared, "gone")), false);
    assert.equal(existsSync(join(space, "gone")), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.equal(existsSync(join(shared, "ssh")), true);
    assert.deepEqual(residue.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed package id in the residue route is invalid input, not a server error", async () => {
  let purged = 0;
  const route = packageRoutes({} as PackageRegistry, {
    list: () => [],
    purge: () => { purged += 1; return null; },
  });
  const owner = {
    spaceId: "spc_test", spaceSlug: "test", userId: "usr_owner", role: "owner",
    deployment: "local-trusted", storageDir: tmpdir(), instanceOwner: true,
  } as SpaceContext;
  const request = (path: string): RouteRequest => ({
    req: {} as never,
    res: {} as never,
    url: new URL(`http://polyth.test${path}`),
    path,
    method: "DELETE",
    ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: true },
    principal: { kind: "ui-session", sessionId: "ses_test", rememberedDeviceId: "dev_test" },
    space: owner,
    requireCapability() {},
    body: async () => ({}),
    json() {},
  } as RouteRequest);
  await assert.rejects(
    () => route(request("/api/packages/residue/%E0%A4%A")),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  assert.equal(purged, 0, "nothing is purged for an undecodable id");
  await assert.rejects(
    () => route(request("/api/packages/residue/gone")),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  assert.equal(purged, 1);
});

test("a person's own data and secrets of a removed package are residue too", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-residue-people-"));
  try {
    const people = join(root, "people");
    for (const dir of [join(people, "usr_1", "packages", "gone"), join(people, "usr_1", "vault", "gone"),
      join(people, "usr_2", "packages", "git"), join(root, "elsewhere", "packages", "gone")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(people, "usr_1", "packages", "gone", "accounts.json"), "{}");
    writeFileSync(join(people, "usr_1", "vault", "gone", "secrets.bin"), "secret");
    // A person entry that is a link is never walked.
    symlinkSync(join(root, "elsewhere"), join(people, "usr_link"));

    const residue = createPackageResidue({
      roots: () => personPackageResidueRoots(people),
      installedIds: () => new Set(["git"]),
    });
    const [gone, ...rest] = residue.list();
    assert.equal(rest.length, 0);
    assert.equal(gone!.id, "gone");
    assert.deepEqual(gone!.locations.map((location) => location.spaceId), [null, null]);
    assert.equal(residue.purge("gone")?.id, "gone");
    assert.equal(existsSync(join(people, "usr_1", "packages", "gone")), false);
    assert.equal(existsSync(join(people, "usr_1", "vault", "gone")), false);
    assert.equal(existsSync(join(root, "elsewhere", "packages", "gone")), true, "a linked tree is untouched");
    assert.deepEqual(personPackageResidueRoots(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
