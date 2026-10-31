import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packDirectory } from "@polyth/package-sdk/manifest";
import type { RouteHandler, RouteRequest, SessionEvent, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { managedPluginRoutes } from "../src/managedPluginRoutes.ts";
import type { ServerPackageHost } from "../src/serverPackage.ts";

function writePackage(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ui.ts"), [
    'import { connectPolyth } from "@polyth/package-sdk";',
    "await connectPolyth();",
  ].join("\n"));
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2,
    id: "com-example-upload",
    version,
    display: { name: "Upload demo", description: "Installed from an uploaded archive." },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { surfaces: [{ id: "main", title: "Upload demo" }] },
    capabilities: ["ui.render"],
  }));
}

function space(): SpaceContext {
  return {
    spaceId: "spc_upload",
    userId: "user-1",
    role: "owner",
    // Installation changes instance-wide binaries: the route requires the
    // deployment owner, not merely a Space admin.
    instanceOwner: true,
  } as unknown as SpaceContext;
}

function storageFor(root: string): SpaceStorage {
  mkdirSync(root, { recursive: true });
  return {
    root,
    packageDir(id) {
      const dir = join(root, "packages", id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path(relative) {
      if (!relative || relative.includes("\0") || relative.startsWith("/") || relative.split("/").includes("..")) {
        throw Object.assign(new Error("path escapes its space"), { code: "invalid-path" });
      }
      return join(root, ...relative.split("/"));
    },
  };
}

/** Minimal host: the install route only touches space storage and lifecycle
    authority, so the rest of the surface stays unimplemented on purpose. */
function hostFor(root: string): ServerPackageHost {
  const spaceStorage = storageFor(root);
  return {
    spaceStorage: () => spaceStorage,
    packageSpaces: () => [{ spaceId: "spc_upload", storage: spaceStorage }],
    events: { append: async (...args: unknown[]) => ({ ...(args as object[]) } as unknown as SessionEvent) },
    sessions: { events: async () => [], snapshot: async () => { throw new Error("unused"); } },
    projects: { get: async () => undefined },
  } as unknown as ServerPackageHost;
}

async function post(
  handler: RouteHandler,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const handled = await handler({
    req: {},
    res: { writeHead: () => {}, end: () => {} },
    url: new URL(`http://x${path}`),
    path,
    method: "POST",
    ingress: { kind: "public-http" },
    principal: { kind: "local-user", userId: "user-1" },
    space: space(),
    requireCapability: () => {},
    body: async () => body,
    json: (code: number, value: unknown) => { status = code; payload = value as Record<string, unknown>; },
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  return { status, payload };
}

test("an uploaded archive installs a package, then stages the next release", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-upload-"));
  try {
    const source = join(root, "src");
    writePackage(source, "1.0.0");
    const archive = await packDirectory(source);
    const registry = createPluginRegistry({ dir: join(root, "installed") });

    const installed = await registry.installArchive(archive, "upload demo.zip");
    assert.equal(installed.id, "com-example-upload");
    assert.equal(installed.version, "1.0.0");
    // The stored source records that this install cannot be refetched, so the
    // UI never offers an automatic update for it.
    assert.equal(installed.source, "upload:upload_demo.zip");
    assert.equal(installed.screenshots, undefined);

    writePackage(source, "1.1.0");
    const next = await packDirectory(source);
    const updated = await registry.installArchive(next, "upload-demo.zip");
    assert.equal(updated.version, "1.1.0");
    assert.equal(updated.previousVersion, "1.0.0");
    assert.equal(updated.update, undefined);

    // The original source is preserved: an archive install is not silently
    // re-pointed at the upload that happened to arrive later.
    assert.equal(updated.source, "upload:upload_demo.zip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uploaded archive can never become a trusted-local install", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-upload-trust-"));
  try {
    const source = join(root, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "server.ts"), "export default () => ({});\n");
    writeFileSync(join(source, "polyth-package.json"), JSON.stringify({
      manifestVersion: 2,
      id: "com-example-trusted",
      version: "1.0.0",
      display: { name: "Trusted", description: "Requires a trusted local source." },
      runtime: { kind: "trusted-local", server: "server.ts" },
    }));
    const archive = await packDirectory(source);
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    await assert.rejects(
      () => registry.installArchive(archive, "trusted.zip"),
      /trusted local source/i,
    );
    assert.equal(registry.has("com-example-trusted"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uploaded archive must be a zip and stays within the size ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-upload-reject-"));
  try {
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    await assert.rejects(() => registry.installArchive(Buffer.alloc(0), "empty.zip"), /empty/i);
    await assert.rejects(
      () => registry.installArchive(Buffer.from("not a zip at all"), "x.zip"),
      /zip|invalid/i,
    );
    await assert.rejects(
      () => registry.installArchive(Buffer.alloc(17 * 1024 * 1024), "big.zip"),
      /too large/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the install route decodes a base64 zip and refuses anything else", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-upload-route-"));
  try {
    const source = join(root, "src");
    writePackage(source, "1.0.0");
    const archive = await packDirectory(source);
    const host = hostFor(join(root, "data"));
    const registry = createPluginRegistry({ dir: join(root, "installed") });
    const routes = managedPluginRoutes(registry, host);

    const installed = await post(routes, "/api/plugins/install", {
      archive: archive.toString("base64"),
      filename: "demo.zip",
    });
    assert.equal(installed.status, 200);
    assert.equal(installed.payload.id, "com-example-upload");
    assert.equal(installed.payload.source, "upload:demo.zip");

    // The route throws and the HTTP layer maps the code, so a non-zip body is
    // rejected before any extractor sees it.
    await assert.rejects(
      () => post(routes, "/api/plugins/install", { archive: Buffer.from("not a zip").toString("base64") }),
      /not a zip/i,
    );
    await assert.rejects(
      () => post(routes, "/api/plugins/install", { archive: "!!!!" }),
      /base64/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
