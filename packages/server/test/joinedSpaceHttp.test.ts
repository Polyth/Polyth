// A joined Space (another Polyth server's, through Polyth Link) open in this
// server's page: requests that follow the Space go to the Link service, the
// person's own things stay here in their own Space, and everything else is
// refused rather than answered from this server.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { JoinedSpace, JoinedSpacesService } from "@polyth/plugins";
import { createHttpHandler, createPublicHttpServer } from "../src/http.ts";
import { spaceRoutes } from "../src/routes/spaces.ts";
import { spaceCookieHeader } from "../src/spaces.ts";
import { joinedSpaceRoute } from "../src/joinedSpaceRouting.ts";
import { CORE_REMOTE_ACCESS } from "../src/remotePolicy.ts";
import { testTenancy } from "./support/spaces.ts";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOINED = "rmt_0123456789abcdef01234567";
const FOREIGN = "rmt_fedcba9876543210fedcba98";

async function withServer(
  fn: (base: string, seen: { forwarded: Array<{ userId: string; id: string; method: string; path: string; cookie?: string }>; localSpace: string[]; ownSpace: string }) => Promise<void>,
  opts: { service?: boolean; serverName?: string } = {},
): Promise<void> {
  const tenancy = await testTenancy();
  const owner = tenancy.gateway.store.users()[0]!;
  const joined: JoinedSpace = {
    id: JOINED, name: "Team", role: "member", memberCount: 3,
    serverLabel: "Studio", connectionId: "conn-1", online: true,
  };
  const seen = { forwarded: [] as Array<{ userId: string; id: string; method: string; path: string; cookie?: string }>, localSpace: [] as string[], ownSpace: tenancy.defaultContext.spaceId };
  const service: JoinedSpacesService = {
    list: (userId) => userId === owner.id ? [joined] : [],
    get: (userId, id) => userId === owner.id && id === JOINED ? joined : undefined,
    async forwardHttp(userId, id, input) {
      seen.forwarded.push({ userId, id, method: input.method, path: input.path, cookie: input.req.headers.cookie });
      input.res.writeHead(200, { "content-type": "application/json" });
      input.res.end(JSON.stringify({ from: "other-server" }));
    },
    async forwardUpgrade() { /* not exercised over HTTP */ },
    ...(opts.serverName !== undefined ? { serverName: () => opts.serverName! } : {}),
  };
  const webDist = tempDir(join(tmpdir(), "polyth-joined-space-"));
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    joinedSpaces: () => opts.service === false ? undefined : service,
    routes: [
      spaceRoutes({
        store: tenancy.gateway.store,
        resolver: tenancy.gateway.resolver,
        audit: tenancy.gateway.audit,
        setActiveSpaceCookie: (rc, spaceId) => rc.res.setHeader("set-cookie", spaceCookieHeader({ name: tenancy.gateway.cookieName, spaceId, secure: false })),
        joinedSpaces: () => opts.service === false ? undefined : service,
        joinedSpaceCookie: (rc) => /polyth_space=(rmt_[0-9a-f]{24})/.exec(rc.req.headers.cookie ?? "")?.[1] ?? null,
      }),
      async (request) => {
        if (request.path === "/api/settings/client" && request.method === "GET") {
          seen.localSpace.push(request.space.spaceId);
          request.json(200, { local: true });
          return true;
        }
        return false;
      },
    ],
  });
  const server = createPublicHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const cookie = (id: string) => ({ cookie: `polyth_space=${id}; polyth_session=secret-session` });

test("routing: the person's own things stay, this computer's secrets are refused, the rest goes to the other server", () => {
  const policies = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  assert.equal(joinedSpaceRoute("GET", "/api/settings/client", policies), "local");
  assert.equal(joinedSpaceRoute("GET", "/api/spaces", policies), "local");
  assert.equal(joinedSpaceRoute("POST", "/api/auth/login", policies), "local");
  assert.equal(joinedSpaceRoute("GET", "/api/projects", policies), "forward");
  assert.equal(joinedSpaceRoute("GET", "/api/mcp/servers", policies), "unavailable");
  // The other server decides what the device may reach (its own table, or
  // the person's rights for a device with full access).
  assert.equal(joinedSpaceRoute("GET", "/api/settings/behavior", policies), "forward");
  assert.equal(joinedSpaceRoute("POST", "/api/sessions/s1/person-messages", policies), "forward");
  assert.equal(joinedSpaceRoute("GET", "/api/harnesses/roster", policies), "forward");
  for (const secret of ["/api/secure-safe/items", "/api/credential-vault", "/api/ssh/connections", "/api/providers/custom", "/api/mcp"]) {
    assert.equal(joinedSpaceRoute("POST", secret, policies), "unavailable", `${secret} never leaves this computer`);
  }
  assert.equal(joinedSpaceRoute("GET", "/api/spacesX", policies), "forward", "a prefix is a path segment, not a string");
  assert.equal(joinedSpaceRoute("GET", "/api/mcpX", policies), "forward");
  // The page's own package code never comes from the other server.
  assert.equal(joinedSpaceRoute("GET", "/api/package-assets/wait/web/index.js", [
    ...policies,
    { owner: "pkg", policy: { routeScopes: ["pkg"], http: [{ methods: ["GET"], path: "/api/package-assets/*", capability: "core.sessions.read", mutation: false }] } as never },
  ]), "local");
  assert.equal(joinedSpaceRoute("GET", "/api/plugins", policies), "local");
});

test("a joined Space's requests go to the Link service; local ones resolve in the person's own Space", async () => {
  await withServer(async (base, seen) => {
    const forwarded = await fetch(`${base}/api/projects?iconRefs=1`, { headers: cookie(JOINED) });
    assert.equal(forwarded.status, 200);
    assert.deepEqual(await forwarded.json(), { from: "other-server" });
    assert.equal(seen.forwarded.length, 1);
    assert.equal(seen.forwarded[0]!.path, "/api/projects?iconRefs=1");
    assert.equal(seen.forwarded[0]!.id, JOINED);

    const local = await fetch(`${base}/api/settings/client`, { headers: cookie(JOINED) });
    assert.deepEqual(await local.json(), { local: true });
    assert.deepEqual(seen.localSpace, [seen.ownSpace], "personal preferences resolve in the person's own Space");

    const refused = await fetch(`${base}/api/mcp/servers`, { headers: cookie(JOINED) });
    assert.equal(refused.status, 404);
    assert.equal((await refused.json() as { error: string }).error, "not-available");

    const byHeader = await fetch(`${base}/api/projects`, { headers: { "x-polyth-space": JOINED } });
    assert.equal(byHeader.status, 200);
    assert.equal(seen.forwarded.length, 2);
  });
});

test("an id that is not this person's joined Space, or no Link service, answers like a missing Space", async () => {
  await withServer(async (base, seen) => {
    const foreign = await fetch(`${base}/api/projects`, { headers: { "x-polyth-space": FOREIGN } });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json() as { error: string }).error, "not-found");
    assert.equal(seen.forwarded.length, 0);
  });
  await withServer(async (base, seen) => {
    const none = await fetch(`${base}/api/projects`, { headers: { "x-polyth-space": JOINED } });
    assert.equal(none.status, 404);
    assert.equal(seen.forwarded.length, 0);
  }, { service: false });
});

test("beside joined Spaces the Space list names this server, only with the name its owner chose", async () => {
  await withServer(async (base) => {
    const state = await (await fetch(`${base}/api/spaces`)).json() as { joined?: unknown[]; serverName?: string };
    assert.equal(state.joined?.length, 1);
    assert.equal(state.serverName, "Home box");
  }, { serverName: "  Home box " });
  for (const serverName of ["", undefined]) {
    await withServer(async (base) => {
      const state = await (await fetch(`${base}/api/spaces`)).json() as { serverName?: string };
      assert.equal("serverName" in state, false, "no chosen name: the switcher says \"This server\"");
    }, serverName === undefined ? {} : { serverName });
  }
});

test("the Space list carries the person's joined Spaces, and activating one sets only the cookie", async () => {
  await withServer(async (base, seen) => {
    const listed = await fetch(`${base}/api/spaces`);
    const state = await listed.json() as { joined?: Array<{ id: string }>; activeSpaceId: string };
    assert.deepEqual(state.joined?.map((space) => space.id), [JOINED]);
    assert.equal(state.activeSpaceId, seen.ownSpace);

    const activated = await fetch(`${base}/api/spaces/${JOINED}/activate`, { method: "POST" });
    assert.equal(activated.status, 200);
    assert.match(activated.headers.get("set-cookie") ?? "", new RegExp(`polyth_space=${JOINED}`));
    assert.equal((await activated.json() as { activeSpaceId: string }).activeSpaceId, JOINED);

    const inJoined = await fetch(`${base}/api/spaces`, { headers: cookie(JOINED) });
    assert.equal((await inJoined.json() as { activeSpaceId: string }).activeSpaceId, JOINED);

    const unknown = await fetch(`${base}/api/spaces/${FOREIGN}/activate`, { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.equal(seen.forwarded.length, 0, "the Space list never leaves this server");
  });
});

test("an explicit own-Space header beats a joined cookie, and a stale joined cookie falls back to the own Space", async () => {
  await withServer(async (base, seen) => {
    const own = await fetch(`${base}/api/settings/client`, { headers: { ...cookie(JOINED), "x-polyth-space": seen.ownSpace } });
    assert.equal(own.status, 200);
    const ownProjects = await fetch(`${base}/api/projects`, { headers: { ...cookie(JOINED), "x-polyth-space": seen.ownSpace } });
    assert.equal(ownProjects.status, 200);
    assert.equal(seen.forwarded.length, 0, "the header named this server's Space");

    // FOREIGN stands for a server the person has left: the cookie remains.
    const stale = await fetch(`${base}/api/projects`, { headers: cookie(FOREIGN) });
    assert.equal(stale.status, 200, "a stale joined cookie is ignored like any stale Space cookie");
    assert.ok(Array.isArray(await stale.json()));
    const staleMcp = await fetch(`${base}/api/spaces`, { headers: cookie(FOREIGN) });
    assert.equal((await staleMcp.json() as { activeSpaceId: string }).activeSpaceId, seen.ownSpace);
    assert.equal(seen.forwarded.length, 0);
  });
});
