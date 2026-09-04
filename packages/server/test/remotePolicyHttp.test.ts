import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY, type RemoteAccessPolicy } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { contentLengthOf, createHttpHandler } from "../src/http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-remote-http-"));

const FILES_WRITE: RemoteAccessPolicy = {
  routeScopes: ["files"],
  http: [{
    methods: ["POST"],
    path: "/api/files/write",
    capability: REMOTE_CAPABILITY.filesWrite,
    mutation: true,
    maxBodyBytes: 16,
  }],
};

function listen(handler: ReturnType<typeof createHttpHandler>) {
  return createServer((req, res) => {
    void handler(req, res, { kind: "polyth-link", connectionId: "live", transport: "direct" });
  });
}

function rawRequest(port: number, opts: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: opts.path,
      method: opts.method ?? "GET",
      headers: opts.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function withServer(
  grants: string[],
  fn: (base: string, executed: { count: number }) => Promise<void>,
): Promise<void> {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const executed = { count: 0 };
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants,
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
    remotePolicies: () => [{ owner: "files", policy: FILES_WRITE }],
    routes: [async (request) => {
      if (request.path === "/api/files/write" && request.method === "POST") {
        executed.count += 1;
        const body = await request.body();
        request.json(200, { ok: true, body });
        return true;
      }
      return false;
    }],
  });
  const server = listen(handler);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, executed);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("paired request body exactly at the rule limit is accepted; one extra byte is 413 and does not run the handler", async () => {
  const atLimit = "{\"a\":\"12345678\"}";
  assert.equal(Buffer.byteLength(atLimit), 16);
  const over = "{\"a\":\"123456789\"}";
  assert.equal(Buffer.byteLength(over), 17);

  await withServer([...GRANT_PROFILE_PRESETS.developer], async (base, executed) => {
    const ok = await fetch(`${base}/api/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: atLimit,
    });
    assert.equal(ok.status, 200);
    assert.equal(executed.count, 1);

    const tooBig = await fetch(`${base}/api/files/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: over,
    });
    assert.equal(tooBig.status, 413);
    const payload = await tooBig.json() as { error: string };
    assert.equal(payload.error, "payload-too-large");
    assert.equal(executed.count, 1);
  });
});

test("chunked body above the rule limit is rejected without executing the handler", async () => {
  await withServer([...GRANT_PROFILE_PRESETS.developer], async (base, executed) => {
    const result = await rawRequest(Number(new URL(base).port), {
      path: "/api/files/write",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      body: "{\"a\":\"123456789\"}",
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.body).error, "payload-too-large");
    assert.equal(executed.count, 0);
  });
});

test("malformed encoded paired paths are rejected as invalid-path", async () => {
  await withServer([...GRANT_PROFILE_PRESETS.observe], async (base) => {
    const port = Number(new URL(base).port);
    for (const path of ["/api/health/%2e%2e", "/api/sessions/%2f", "/api/health/%00", "/api/health/%zz", "/api/health/%2"]) {
      const result = await rawRequest(port, { path });
      assert.equal(result.status, 400, path);
      assert.equal(JSON.parse(result.body).error, "invalid-path", path);
    }
  });
});

test("contentLengthOf rejects invalid, negative, and conflicting Content-Length headers", () => {
  assert.throws(
    () => contentLengthOf({ headers: { "content-length": "nope" } } as never),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  assert.throws(
    () => contentLengthOf({ headers: { "content-length": "-1" } } as never),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  assert.throws(
    () => contentLengthOf({ headers: { "content-length": ["7", "8"] } } as never),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  assert.equal(contentLengthOf({ headers: { "content-length": "16" } } as never), 16);
  assert.equal(contentLengthOf({ headers: {} } as never), undefined);
});

test("unknown paired routes stay default-deny even with every grant", async () => {
  await withServer([...GRANT_PROFILE_PRESETS["full-remote"]], async (base) => {
    const response = await fetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 403);
  });
});
