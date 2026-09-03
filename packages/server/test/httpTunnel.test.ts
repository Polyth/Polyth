import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import {
  createHttpHandler,
  createTunnelIngressServer,
  TUNNEL_INTERNAL_CONNECTION_HEADER,
  TUNNEL_INTERNAL_TOKEN_HEADER,
} from "../src/http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-http-tunnel-"));

test("polyth-link ingress is default-deny, ignores cookies, and never uses localhost optional", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    envPassword: "pw",
    localhostOptional: true,
    resolvePairedDevice: (ingress) => ingress.connectionId === "live" ? {
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: ingress.connectionId,
      transport: ingress.transport,
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    } : null,
  });
  const handler = createHttpHandler({
    sessions: { list: async () => [] } as never,
    projects: { list: async () => [] } as never,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const server = createServer((req, res) => {
    const connectionId = String(req.headers[TUNNEL_INTERNAL_CONNECTION_HEADER] ?? "live");
    void handler(req, res, { kind: "polyth-link", connectionId, transport: "direct" });
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const unknown = await fetch(`${base}/api/does-not-exist`);
    assert.equal(unknown.status, 403);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    assert.equal(login.status, 403);

    const write = await fetch(`${base}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(write.status, 403);

    const projects = await fetch(`${base}/api/projects`, {
      headers: { cookie: "polyth_auth=" + "ab".repeat(32), authorization: "Bearer x" },
    });
    assert.equal(projects.status, 200);

    const stale = await fetch(`${base}/api/projects`, {
      headers: { [TUNNEL_INTERNAL_CONNECTION_HEADER]: "stale" },
    });
    assert.equal(stale.status, 401);

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 403);
  } finally {
    server.close();
  }
});

test("tunnel unix ingress rejects missing or wrong per-boot secret", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    }),
  });
  const handler = createHttpHandler({
    sessions: { list: async () => [] } as never,
    projects: { list: async () => [] } as never,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const secret = "a".repeat(64);
  const server = createTunnelIngressServer(handler, {
    secret,
    lookup: (connectionId) => connectionId === "live"
      ? { kind: "polyth-link", connectionId, transport: "direct" }
      : null,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/api/health`);
    assert.equal(denied.status, 403);
    const wrong = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: "b".repeat(64),
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
      },
    });
    assert.equal(wrong.status, 403);
    const ok = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
      },
    });
    assert.equal(ok.status, 200);
    const stale = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "other",
      },
    });
    assert.equal(stale.status, 403);
  } finally {
    server.close();
  }
});
