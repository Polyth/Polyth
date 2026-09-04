import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal, RequestIngress, RouteRequest } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { createHttpHandler } from "../src/http.ts";
import { settingsRoutes } from "../src/routes/settings.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-local-admin-"));

function fakeReq(opts: {
  url?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: opts.remoteAddress });
  const req = new IncomingMessage(socket);
  req.url = opts.url ?? "/api/health";
  req.method = "GET";
  req.headers = opts.headers ?? {};
  return req;
}

test("auth disabled plus spoofed forwarding headers still uses the socket address", async () => {
  const auth = createAuthService({ file: join(tmp(), "off.json") });
  const handler = createHttpHandler({
    sessions: { list: async () => [] } as never,
    projects: { list: async () => [] } as never,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: tmp(),
    version: "test",
    auth,
  });

  const loopback = await new Promise<{ status: number }>((resolve) => {
    const req = fakeReq({ remoteAddress: "127.0.0.1", url: "/api/health" });
    const res = new ServerResponse(req);
    res.end = ((chunk?: unknown) => {
      resolve({ status: res.statusCode });
      return res;
    }) as ServerResponse["end"];
    void handler(req, res, {
      kind: "public-http", listenerId: "public", loopback: true, secure: false,
    });
  });
  assert.equal(loopback.status, 200);

  const spoofed = await new Promise<{ status: number }>((resolve) => {
    const req = fakeReq({
      remoteAddress: "203.0.113.9",
      url: "/api/health",
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
        "x-polyth-internal-token": "nope",
      },
    });
    const res = new ServerResponse(req);
    res.end = ((chunk?: unknown) => {
      resolve({ status: res.statusCode });
      return res;
    }) as ServerResponse["end"];
    void handler(req, res, {
      kind: "public-http", listenerId: "public", loopback: false, secure: false,
    });
  });
  assert.equal(spoofed.status, 401);
});

test("system info is denied to a non-loopback unauthenticated caller", async () => {
  const routes = settingsRoutes({
    behavior: {
      get: async () => ({ text: "", revision: "0" }),
      put: async () => ({ text: "", revision: "0" }),
      subagentPolicy: async () => ({ enabled: true }),
      putSubagentPolicy: async () => ({ enabled: true }),
      current: async () => null,
    } as never,
    mcp: { list: () => [] } as never,
    systemInfo: (local) => ({
      version: "test",
      applicationUrl: "http://127.0.0.1:1",
      tunnelUrl: null,
      dataDirLabel: local ? "/secret-data" : "Polyth data directory",
      capabilities: [],
    }),
  });

  const invoke = async (principal: AuthPrincipal, ingress: RequestIngress) => {
    let code = 0;
    let body: { dataDirLabel?: string } | undefined;
    const rc: RouteRequest = {
      req: {} as never,
      res: {} as never,
      url: new URL("http://polyth.test/api/system/info"),
      path: "/api/system/info",
      method: "GET",
      ingress,
      principal,
      requireCapability() {},
      body: async () => ({}),
      json(nextCode, nextBody) {
        code = nextCode;
        body = nextBody as { dataDirLabel?: string };
      },
    };
    try {
      await routes(rc);
      return { code, body };
    } catch (error) {
      return { error: error as Error & { code?: string } };
    }
  };

  const denied = await invoke({ kind: "anonymous" }, {
    kind: "public-http", listenerId: "public", loopback: false, secure: false,
  });
  assert.equal("error" in denied, true);
  if ("error" in denied) assert.equal(denied.error.code, "unauthorized");

  const local = await invoke({ kind: "local-user", trustedLoopback: true }, {
    kind: "public-http", listenerId: "public", loopback: true, secure: false,
  });
  assert.equal(local.code, 200);
  assert.equal(local.body?.dataDirLabel, "/secret-data");

  const remoteSession = await invoke(
    { kind: "ui-session", sessionId: "s", rememberedDeviceId: "s" },
    { kind: "public-http", listenerId: "public", loopback: false, secure: false },
  );
  assert.equal(remoteSession.code, 200);
  assert.equal(remoteSession.body?.dataDirLabel, "Polyth data directory");
});
