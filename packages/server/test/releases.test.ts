import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "../src/http.ts";
import {
  parseReleaseDownloads,
  parseReleaseRepository,
  releasesRoutes,
  type ReleasesFetch,
} from "../src/routes/releases.ts";
import { fakeSpaceContext } from "./support/spaces.ts";

function request(
  path: string,
  fetchImpl: ReleasesFetch,
  options: { repository?: string | null | (() => string | null | undefined); principalKind?: string } = {},
) {
  let status = 0;
  let payload = "";
  const route = releasesRoutes({
    fetchImpl,
    repository: options.repository === undefined ? "acme/polyth" : options.repository,
  });
  const req = {
    req: { socket: { remoteAddress: "127.0.0.1" } },
    res: {
      statusCode: 200,
      setHeader() {},
      end(body: string) { payload = body; },
    },
    url: new URL(path, "http://polyth"),
    path: path.split("?")[0]!,
    method: "GET",
    space: fakeSpaceContext(),
    principal: { kind: options.principalKind ?? "local-user" },
    body: async () => ({}),
    json(code: number, body: unknown) {
      status = code;
      payload = JSON.stringify(body);
    },
  } as unknown as RouteRequest;
  return {
    async run() {
      assert.equal(await route(req), true);
      return { status: status || req.res.statusCode, payload: JSON.parse(payload || "null") as unknown };
    },
    route,
    req,
  };
}

const releasePayload = {
  tag_name: "v0.1.86",
  html_url: "https://github.com/acme/polyth/releases/tag/v0.1.86",
  published_at: "2026-09-01T10:00:00Z",
  assets: [
    { name: "latest.yml", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/latest.yml", size: 12 },
    { name: "Polyth-0.1.86-win-x64.exe", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-win-x64.exe", size: 100 },
    { name: "Polyth-0.1.86-win-x64.exe.blockmap", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-win-x64.exe.blockmap", size: 5 },
    { name: "Polyth-0.1.86-mac-arm64.dmg", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-mac-arm64.dmg", size: 200 },
    { name: "Polyth-0.1.86-mac-x64.dmg", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-mac-x64.dmg", size: 201 },
    { name: "Polyth-0.1.86-linux-x86_64.AppImage", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-linux-x86_64.AppImage", size: 300 },
    { name: "Polyth-0.1.86-android.apk", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-android.apk", size: 400 },
    { name: "Polyth-0.1.86-mac-arm64.zip", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-mac-arm64.zip", size: 202 },
    { name: "Polyth-0.1.86-win-x64.exe", browser_download_url: "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-win-x64.exe", size: 100 },
  ],
};

const okFetch: ReleasesFetch = async () => new Response(JSON.stringify(releasePayload), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("releases route is disabled without a configured repository", async () => {
  let called = 0;
  const fetchImpl: ReleasesFetch = async (url) => { called += 1; return okFetch(url); };
  const result = await request("/api/system/releases", fetchImpl, { repository: null }).run();
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { enabled: false, release: null, error: null });
  assert.equal(called, 0);
});

test("releases route filters installer assets and orders platforms", async () => {
  const result = await request("/api/system/releases", okFetch).run();
  const body = result.payload as { enabled: boolean; release: { version: string; downloads: Array<Record<string, unknown>> } };
  assert.equal(body.enabled, true);
  assert.equal(body.release.version, "0.1.86");
  assert.deepEqual(
    body.release.downloads.map((download) => `${download.platform}:${download.arch ?? "-"}`),
    ["windows:x64", "macos:arm64", "macos:x64", "linux:x64", "android:-"],
  );
  assert.equal(body.release.downloads.length, 5);
  assert.equal(
    (body.release.downloads[0] as { url: string }).url,
    "https://github.com/acme/polyth/releases/download/v0.1.86/Polyth-0.1.86-win-x64.exe",
  );
});

test("releases route rejects non-GitHub asset URLs", async () => {
  const release = parseReleaseDownloads({
    tag_name: "v1.0.0",
    html_url: "https://github.com/acme/polyth/releases/tag/v1.0.0",
    assets: [{ name: "Polyth-1.0.0-win-x64.exe", browser_download_url: "https://evil.test/x.exe", size: 1 }],
  });
  assert.deepEqual(release?.downloads, []);
});

test("releases route caches the upstream lookup", async () => {
  let called = 0;
  const fetchImpl: ReleasesFetch = async (url) => { called += 1; return okFetch(url); };
  const run = request("/api/system/releases", fetchImpl);
  await run.run();
  await run.run();
  assert.equal(called, 1);
});

test("releases route surfaces upstream failures without throwing", async () => {
  const fetchImpl: ReleasesFetch = async () => new Response("nope", { status: 500 });
  const result = await request("/api/system/releases", fetchImpl).run();
  assert.equal(result.status, 200);
  const body = result.payload as { enabled: boolean; release: null; error: string };
  assert.equal(body.enabled, true);
  assert.equal(body.release, null);
  assert.match(body.error, /GitHub API/);
});

test("releases route requires authentication and ignores other routes", async () => {
  const anonymous = request("/api/system/releases", okFetch, { principalKind: "anonymous" });
  await assert.rejects(() => anonymous.route(anonymous.req), /authentication required/);

  const route = releasesRoutes({ fetchImpl: okFetch, repository: "acme/polyth" });
  const other = {
    req: { socket: { remoteAddress: "127.0.0.1" } },
    res: { statusCode: 200, setHeader() {}, end() {} },
    url: new URL("/api/other", "http://polyth"),
    path: "/api/other",
    method: "GET",
    space: fakeSpaceContext(),
    principal: { kind: "local-user" },
    body: async () => ({}),
    json() {},
  } as unknown as RouteRequest;
  assert.equal(await route(other), false);
});

test("release repository parsing rejects malformed values", () => {
  assert.deepEqual(parseReleaseRepository("acme/polyth"), { owner: "acme", repo: "polyth" });
  assert.equal(parseReleaseRepository(""), null);
  assert.equal(parseReleaseRepository("acme"), null);
  assert.equal(parseReleaseRepository("https://github.com/acme/polyth"), null);
  assert.equal(parseReleaseRepository("acme/../etc"), null);
});
