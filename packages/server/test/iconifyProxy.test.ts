import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "../src/http.ts";
import { iconifyRoutes, type IconifyFetch } from "../src/routes/iconify.ts";
import { CORE_LOCAL_ONLY_PREFIXES, CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";
import { fakeSpaceContext } from "./support/spaces.ts";

function request(path: string, fetchImpl: IconifyFetch) {
  let status = 0;
  let headers: Record<string, string | number | string[] | undefined> = {};
  let payload = "";
  const route = iconifyRoutes(fetchImpl);
  const req = {
    req: { socket: { remoteAddress: "127.0.0.1" } },
    res: {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
      end(body: string) { payload = body; },
    },
    url: new URL(path, "http://polyth"),
    path: path.split("?")[0]!,
    method: "GET",
    space: fakeSpaceContext(),
    body: async () => ({}),
    json(code: number, body: unknown) {
      status = code;
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    },
  } as unknown as RouteRequest;
  return {
    async run() {
      assert.equal(await route(req), true);
      status = status || req.res.statusCode;
      return { status, headers, payload };
    },
  };
}

const okFetch: IconifyFetch = async (url) => new Response(JSON.stringify({ icons: ["ph:folder"] }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("iconify search proxies allowlisted libraries only", async () => {
  let seen = "";
  const fetchImpl: IconifyFetch = async (url) => {
    seen = String(url);
    return okFetch(url);
  };
  const result = await request("/api/iconify/search?query=folder&prefix=ph", fetchImpl).run();
  assert.equal(result.status, 200);
  assert.match(seen, /^https:\/\/api\.iconify\.design\/search\?/);
  assert.match(seen, /prefix=ph/);
});

test("iconify search rejects unsupported prefix", async () => {
  const result = await request("/api/iconify/search?query=folder&prefix=mdi", okFetch).run();
  assert.equal(result.status, 400);
  assert.match(result.payload, /unsupported icon library/);
});

test("iconify batch rejects invalid icon names", async () => {
  const result = await request("/api/iconify/ph.json?icons=../secret", okFetch).run();
  assert.equal(result.status, 400);
  assert.match(result.payload, /invalid icon name/);
});

test("iconify svg rejects invalid icon names", async () => {
  const result = await request("/api/iconify/ph/not%20valid.svg", okFetch).run();
  assert.equal(result.status, 400);
  assert.match(result.payload, /invalid icon/);
});

test("iconify svg proxies validated prefix and icon", async () => {
  let seen = "";
  const fetchImpl: IconifyFetch = async (url) => {
    seen = String(url);
    return new Response("<svg></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  };
  const result = await request("/api/iconify/ph/folder.svg", fetchImpl).run();
  assert.equal(result.status, 200);
  assert.equal(seen, "https://api.iconify.design/ph/folder.svg");
  assert.equal(result.headers["content-type"], "image/svg+xml");
});

test("iconify denies non-allowlisted upstream host injection", async () => {
  let called = 0;
  const fetchImpl: IconifyFetch = async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  };
  const result = await request("/api/iconify/search?query=evil&prefixes=hugeicons,https://evil.test", fetchImpl).run();
  assert.equal(result.status, 400);
  assert.equal(called, 0);
});

test("iconify search requires a query and ignores non-GET", async () => {
  const missing = await request("/api/iconify/search", okFetch).run();
  assert.equal(missing.status, 400);

  const route = iconifyRoutes(okFetch);
  const post = {
    req: { socket: { remoteAddress: "127.0.0.1" } },
    res: { statusCode: 200, setHeader() {}, end() {} },
    url: new URL("/api/iconify/search?query=folder", "http://polyth"),
    path: "/api/iconify/search",
    method: "POST",
    space: fakeSpaceContext(),
    body: async () => ({}),
    json() {},
  } as unknown as RouteRequest;
  assert.equal(await route(post), false);
});

test("iconify rejects unknown routes, prefixes, and open URL paths", async () => {
  let called = 0;
  const fetchImpl: IconifyFetch = async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  };
  const unknown = await request("/api/iconify/open?url=https://evil.test", fetchImpl).run();
  assert.equal(unknown.status, 404);
  const foreignSvg = await request("/api/iconify/mdi/folder.svg", fetchImpl).run();
  assert.equal(foreignSvg.status, 400);
  const emptyBatch = await request("/api/iconify/ph.json", fetchImpl).run();
  assert.equal(emptyBatch.status, 400);
  assert.equal(called, 0);
});

test("iconify batch proxies allowlisted icon names", async () => {
  let seen = "";
  const fetchImpl: IconifyFetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ icons: { folder: { body: "<path/>" } } }), { status: 200 });
  };
  const result = await request("/api/iconify/ph.json?icons=folder,house", fetchImpl).run();
  assert.equal(result.status, 200);
  assert.equal(seen, "https://api.iconify.design/ph.json?icons=folder%2Chouse");
});

test("iconify proxy stays local-only for paired devices", () => {
  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/api/iconify"));
  assert.equal(CORE_REMOTE_ACCESS.http.some((rule) => rule.path.startsWith("/api/iconify")), false);
});
