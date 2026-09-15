import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  browserReachableHttpOrigin,
  createServerApplicationSurface,
} from "../src/applicationSurface.ts";

test("controlled Browser self-origin follows listener lifetime and strict UI authentication", async () => {
  const listener = createServer((_request, response) => response.end("ok"));
  let authRequired = false;
  const surface = createServerApplicationSurface({
    localTrustedDeployment: true,
    hostname: "0.0.0.0",
    listener: () => listener,
    authenticationRequired: () => authRequired,
    localhostAuthOptional: false,
  });

  assert.equal(surface.controlledBrowserLoginOrigin(), null, "not exposed before listener/auth readiness");
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(surface.controlledBrowserLoginOrigin(), null, "auth-off loopback must not inherit owner authority");
  authRequired = true;
  assert.equal(surface.controlledBrowserLoginOrigin(), `http://127.0.0.1:${address.port}`);
  authRequired = false;
  assert.equal(surface.controlledBrowserLoginOrigin(), null, "an existing Browser rechecks live auth state");
  authRequired = true;

  const closed = once(listener, "close");
  listener.close();
  assert.equal(surface.controlledBrowserLoginOrigin(), null, "listener close revokes the origin before port reuse");
  await closed;

  const live = createServer((_request, response) => response.end("ok"));
  live.listen(0, "127.0.0.1");
  await once(live, "listening");
  const bypassed = createServerApplicationSurface({
    localTrustedDeployment: true,
    hostname: "127.0.0.1",
    listener: () => live,
    authenticationRequired: () => true,
    localhostAuthOptional: true,
  });
  assert.equal(bypassed.controlledBrowserLoginOrigin(), null, "localhost bypass is ambient authority");

  const hosted = createServerApplicationSurface({
    localTrustedDeployment: false,
    hostname: "127.0.0.1",
    listener: () => live,
    authenticationRequired: () => true,
    localhostAuthOptional: false,
  });
  assert.equal(hosted.controlledBrowserLoginOrigin(), null, "hosted tenants get no loopback login primitive");
  const liveClosed = once(live, "close");
  live.close();
  await liveClosed;
});

test("browser-reachable listener origins normalize wildcards and IPv6 exactly", () => {
  assert.equal(browserReachableHttpOrigin(undefined, 4400), "http://127.0.0.1:4400");
  assert.equal(browserReachableHttpOrigin("0.0.0.0", 4400), "http://127.0.0.1:4400");
  assert.equal(browserReachableHttpOrigin("::", 4400), "http://[::1]:4400");
  assert.equal(browserReachableHttpOrigin("::1", 4400), "http://[::1]:4400");
  assert.equal(browserReachableHttpOrigin("localhost", 4400), "http://localhost:4400");
  assert.equal(browserReachableHttpOrigin("127.0.0.1", 0), null);
  assert.equal(browserReachableHttpOrigin("bad host", 4400), null);
});
