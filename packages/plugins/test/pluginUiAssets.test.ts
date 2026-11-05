import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RouteRequest } from "@polyth/contracts";
import { pluginAssetRoutes } from "../src/pluginAssetRoutes.ts";

const ID = "test.ui-assets";
const root = mkdtempSync(join(tmpdir(), "polyth-ui-assets-"));
after(() => rmSync(root, { recursive: true, force: true }));

let installs = 0;
/** A fresh install dir per test, so one test's cache never serves another's. */
const install = (): { installDir: string; route: ReturnType<typeof pluginAssetRoutes> } => {
  const installDir = join(root, `install-${installs++}`);
  mkdirSync(join(installDir, ".polyth", "ui"), { recursive: true });
  const route = pluginAssetRoutes({
    plugins: { has: (id) => id === ID, installDir: () => installDir },
  });
  return { installDir, route };
};

const sha256 = (contents: Buffer): string => createHash("sha256").update(contents).digest("hex");

const bundleFile = (installDir: string, integrity: string): string =>
  join(installDir, ".polyth", "ui", `ui-${integrity}.mjs`);

const writeBundle = (installDir: string, contents: Buffer): string => {
  const integrity = sha256(contents);
  writeFileSync(bundleFile(installDir, integrity), contents);
  return integrity;
};

/** Compressible, with non-ASCII text, like a real minified UTF-8 bundle. */
const LARGE = Buffer.from(
  `export const modules = {};\nexport const label = ${JSON.stringify("Wohnzimmer – Küche 21 °C · ".repeat(400))};\n`,
  "utf8",
);
/** Too small for gzip to pay for its own header. */
const TINY = Buffer.from("export const modules = {};\n", "utf8");

async function get(
  route: ReturnType<typeof pluginAssetRoutes>,
  integrity: string,
  acceptEncoding?: string,
  id = ID,
): Promise<{ status: number; headers: Record<string, string | number>; body: Buffer }> {
  let status = 0;
  let headers: Record<string, string | number> = {};
  let body: Buffer | undefined;
  const path = `/api/plugins/${id}/ui/${integrity}.mjs`;
  const handled = await route({
    req: { headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding } },
    res: {
      writeHead: (code: number, next: Record<string, string | number>) => { status = code; headers = next; },
      end: (payload: Buffer) => { body = payload; },
    },
    url: new URL(`http://x${path}`),
    path,
    method: "GET",
    body: async () => ({}),
    json: () => {},
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  assert.ok(body, "the route must write a body");
  return { status, headers, body };
}

const assertPlain = (
  response: Awaited<ReturnType<typeof get>>,
  contents: Buffer,
  label: string,
): void => {
  assert.equal(response.status, 200, label);
  assert.equal(response.headers["content-encoding"], undefined, label);
  assert.equal(response.headers.vary, "accept-encoding", label);
  assert.equal(response.headers["content-length"], contents.length, label);
  assert.equal(response.body.equals(contents), true, label);
};

test("a UI bundle is served gzip-encoded, as UTF-8, to a client that accepts gzip", async () => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, LARGE);
  const response = await get(route, integrity, "gzip, deflate, br");

  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, {
    "content-type": "application/javascript; charset=utf-8",
    "content-length": response.body.length,
    "cache-control": "public, max-age=31536000, immutable",
    vary: "accept-encoding",
    "content-encoding": "gzip",
  });
  assert.ok(response.body.length < LARGE.length / 4, "the compressed body is much smaller");
  assert.equal(gunzipSync(response.body).equals(LARGE), true);
});

test("Accept-Encoding weights decide between the gzip and plain representations", async () => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, LARGE);
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ["", false],
    ["identity", false],
    ["br, zstd", false],
    ["gzip;q=0", false],
    ["gzip; q=0.000", false],
    ["*;q=0", false],
    ["gzip;q=0, *", false],
    ["gzip;q=nonsense", false],
    ["gzip", true],
    ["deflate, GZIP;q=0.5", true],
    ["x-gzip", true],
    ["*", true],
    ["br, *;q=0.1", true],
  ];
  // Plain requests interleave with gzip ones, so each is decided on its own
  // header and not by whichever representation is cached.
  for (const [header, gzip] of cases) {
    const response = await get(route, integrity, header);
    const label = `accept-encoding: ${header ?? "(absent)"}`;
    if (gzip) {
      assert.equal(response.headers["content-encoding"], "gzip", label);
      assert.equal(response.headers.vary, "accept-encoding", label);
      assert.equal(gunzipSync(response.body).equals(LARGE), true, label);
    } else {
      assertPlain(response, LARGE, label);
    }
  }
});

test("a bundle gzip cannot shrink is served plain even to a gzip client", async () => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, TINY);
  assertPlain(await get(route, integrity, "gzip"), TINY, "first request");
  assertPlain(await get(route, integrity, "gzip"), TINY, "cached request");
  assertPlain(await get(route, integrity), TINY, "plain client");
});

test("a verified bundle is not re-read or re-hashed while its file is unchanged", async (t) => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, LARGE);
  const file = bundleFile(installDir, integrity);
  const reads = mock.method(fsPromises, "readFile");
  // The route imports `readFile` by name; this re-points that binding.
  syncBuiltinESMExports();
  t.after(() => {
    reads.mock.restore();
    syncBuiltinESMExports();
  });
  const readsOfBundle = () => reads.mock.calls.filter((call) => call.arguments[0] === file).length;

  const first = await get(route, integrity, "gzip");
  assert.equal(readsOfBundle(), 1);
  for (let i = 0; i < 5; i += 1) {
    const again = await get(route, integrity, "gzip");
    assert.equal(again.body.equals(first.body), true);
  }
  assert.equal(readsOfBundle(), 1, "cached gzip responses come from memory");

  // A plain client is rare; its bytes are read and verified on each request
  // instead of keeping a second, uncompressed copy in memory.
  assertPlain(await get(route, integrity), LARGE, "plain fallback");
  assert.equal(readsOfBundle(), 2);
  assert.equal((await get(route, integrity, "gzip")).headers["content-encoding"], "gzip");
  assert.equal(readsOfBundle(), 2, "the compressed copy survives a plain request");
});

test("a bundle rewritten on disk is re-verified instead of served from memory", async () => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, LARGE);
  const file = bundleFile(installDir, integrity);
  assert.equal((await get(route, integrity, "gzip")).status, 200);

  // Rewritten in place (same inode). The size change keeps this independent
  // of how coarse the file system's timestamps are.
  writeFileSync(file, Buffer.concat([LARGE, Buffer.from("export const extra = 1;\n")]));
  await assert.rejects(() => get(route, integrity, "gzip"), /not found/i);
  await assert.rejects(() => get(route, integrity), /not found/i);

  writeFileSync(file, LARGE);
  const restored = await get(route, integrity, "gzip");
  assert.equal(gunzipSync(restored.body).equals(LARGE), true);
});

test("a removed bundle or a foreign package is never served from memory", async () => {
  const { installDir, route } = install();
  const integrity = writeBundle(installDir, LARGE);
  assert.equal((await get(route, integrity, "gzip")).status, 200);
  await assert.rejects(() => get(route, integrity, "gzip", "test.other"), /not found/i);

  unlinkSync(bundleFile(installDir, integrity));
  await assert.rejects(() => get(route, integrity, "gzip"), /not found/i);
});

test("a file whose bytes do not match its integrity name is refused", async () => {
  const { installDir, route } = install();
  const integrity = sha256(LARGE);
  writeFileSync(bundleFile(installDir, integrity), TINY);
  await assert.rejects(() => get(route, integrity, "gzip"), /not found/i);
  await assert.rejects(() => get(route, integrity), /not found/i);
  await assert.rejects(() => get(route, "c".repeat(64), "gzip"), /not found/i);
});
