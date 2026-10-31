import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";

const temporary = (): string => mkdtempSync(join(tmpdir(), "polyth-recap-data-"));

/** The minimal host recap needs to register; it touches nothing while idle. */
function registrationHost(root: string): ServerPackageHost {
  return {
    pluginId: "recap",
    storageDir: root,
    store: {
      projection: async () => undefined,
      events: async () => [],
      latestSeq: async () => 0,
    },
    runtimes: { forProject: async () => ({}) },
    smallModel: () => undefined,
    smallModelComplete: async () => ({ text: "" }),
    services: { require: () => { throw new Error("unexpected service require during registration"); } },
  } as unknown as ServerPackageHost;
}

async function getSettings(routes: RouteHandler): Promise<{ idleSeconds: number }> {
  let body: unknown;
  const handled = await routes({
    path: "/api/settings/assist",
    method: "GET",
    json: (_status: number, value: unknown) => { body = value; },
  } as never);
  assert.equal(handled, true);
  return body as { idleSeconds: number };
}

async function putSettings(routes: RouteHandler, idleSeconds: number): Promise<{ idleSeconds: number }> {
  let body: unknown;
  const handled = await routes({
    path: "/api/settings/assist",
    method: "PUT",
    body: async () => ({ idleSeconds }),
    json: (_status: number, value: unknown) => { body = value; },
  } as never);
  assert.equal(handled, true);
  return body as { idleSeconds: number };
}

test("a legacy assist.json in the shared data root is adopted and read back", async () => {
  const root = temporary();
  try {
    writeFileSync(join(root, "assist.json"), JSON.stringify({ idleSeconds: 45 }));
    const pkg = registerPackage(registrationHost(root));

    const packageFile = join(root, "packages", "recap", "assist.json");
    assert.equal(existsSync(packageFile), true, "the legacy file moved into the package directory");
    assert.equal(existsSync(join(root, "assist.json")), false, "the legacy file left the shared root");
    assert.equal((await getSettings(pkg.routes!)).idleSeconds, 45, "the moved preference is read back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh install writes assist.json only under the package directory", async () => {
  const root = temporary();
  try {
    const pkg = registerPackage(registrationHost(root));
    assert.deepEqual(await putSettings(pkg.routes!, 60), { idleSeconds: 60, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: false });

    assert.deepEqual(readdirSync(root), ["packages"], "nothing is written to the shared root");
    assert.equal(existsSync(join(root, "packages", "recap", "assist.json")), true);
    assert.equal(existsSync(join(root, "assist.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
