import test from "node:test";
import assert from "node:assert/strict";
import {
  browserReachableHttpOrigin,
  createServerApplicationSurface,
} from "../src/applicationSurface.ts";

test("controlled Browser self-origin is live and requires strict UI authentication", () => {
  let port: number | null = null;
  let authRequired = false;
  const surface = createServerApplicationSurface({
    localTrustedDeployment: true,
    hostname: "0.0.0.0",
    listeningPort: () => port,
    authenticationRequired: () => authRequired,
    localhostAuthOptional: false,
  });

  assert.equal(surface.controlledBrowserLoginOrigin(), null, "not exposed before listener/auth readiness");
  port = 4400;
  assert.equal(surface.controlledBrowserLoginOrigin(), null, "auth-off loopback must not inherit owner authority");
  authRequired = true;
  assert.equal(surface.controlledBrowserLoginOrigin(), "http://127.0.0.1:4400");
  authRequired = false;
  assert.equal(surface.controlledBrowserLoginOrigin(), null, "an existing Browser rechecks live auth state");

  const bypassed = createServerApplicationSurface({
    localTrustedDeployment: true,
    hostname: "127.0.0.1",
    listeningPort: () => 4400,
    authenticationRequired: () => true,
    localhostAuthOptional: true,
  });
  assert.equal(bypassed.controlledBrowserLoginOrigin(), null, "localhost bypass is ambient authority");

  const hosted = createServerApplicationSurface({
    localTrustedDeployment: false,
    hostname: "127.0.0.1",
    listeningPort: () => 4400,
    authenticationRequired: () => true,
    localhostAuthOptional: false,
  });
  assert.equal(hosted.controlledBrowserLoginOrigin(), null, "hosted tenants get no loopback login primitive");
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
