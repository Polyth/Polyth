import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  checkUrl,
  createProfileChromiumDriver,
  resetProfileChromiumLocks,
  webSocketUrlAsHttp,
  type UrlPolicyOptions,
} from "../src/index.ts";
import type { NavigationKind, ProfilePageEvent } from "../src/profileDriver.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";
const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const chrome = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome";
const HOST_RULES = "--host-resolver-rules=MAP polyth.test 127.0.0.1, MAP *.polyth.test 127.0.0.1";
const publicDns = async (host: string): Promise<string[]> => {
  if (host === "private.example") return ["10.0.0.2"];
  return ["93.184.216.34"];
};

test("webSocketUrlAsHttp maps ws/wss onto the HTTP policy surface", () => {
  assert.equal(webSocketUrlAsHttp("ws://127.0.0.1:8123/chat"), "http://127.0.0.1:8123/chat");
  assert.equal(webSocketUrlAsHttp("wss://api.example.com/v1"), "https://api.example.com/v1");
});

type Recorded = { url: string; method: string; cookie?: string; body?: string };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function click(page: { mouse(input: { kind: "click"; x: number; y: number }): Promise<void> }, y: number): Promise<void> {
  await page.mouse({ kind: "click", x: 60, y });
}

function cookieOf(req: IncomingMessage): string | undefined {
  return typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
}

function policyGuard(policy: UrlPolicyOptions) {
  return async (url: string, kind: NavigationKind = "top-level") => {
    const decision = await checkUrl(url, {
      ...policy,
      resolve: policy.resolve ?? publicDns,
      purpose: kind === "top-level" ? "top-level" : "subresource",
    });
    if (decision.ok) return;
    throw err(decision.code, decision.reason);
  };
}

function openOpts(
  profileId: string,
  userDataDir: string,
  policy: UrlPolicyOptions,
): Parameters<NonNullable<Awaited<ReturnType<typeof createProfileChromiumDriver>>>["openProfile"]>[0] {
  return {
    profileId,
    userDataDir,
    viewport: { width: 800, height: 600 },
    colorScheme: "no-preference",
    guardNavigation: policyGuard(policy),
    chromiumArgs: [HOST_RULES],
    listedOrigins: [...(policy.allowedOrigins ?? []), ...((policy.approvedOrigins ?? new Set<string>()))],
  };
}

function listen(server: Server, hostname: string): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve(`http://${hostname}:${port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => { server.close(() => done()); });
}

function startPrivateCounter(): Promise<{ origin: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "/");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("private");
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    requests,
    close: () => closeServer(server),
  }));
}

function startAuthFixture(hostname = "127.0.0.1"): Promise<{
  origin: string;
  records: Recorded[];
  close(): Promise<void>;
}> {
  const records: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      const cookie = cookieOf(req);
      records.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        cookie,
        body: Buffer.concat(chunks).toString(),
      });
      const hasSession = Boolean(cookie?.includes("session=abc123"));
      if (url === "/login") {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Set-Cookie": "session=abc123; Path=/; SameSite=Lax",
        });
        res.end("<!DOCTYPE html><html><body>login</body></html>");
        return;
      }
      if (url === "/protected-api" || url === "/protected-image" || url === "/protected-frame") {
        if (!hasSession) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("missing-session");
          return;
        }
        if (url === "/protected-image") {
          res.writeHead(200, { "Content-Type": "image/gif" });
          res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
          return;
        }
        res.writeHead(200, { "Content-Type": url === "/protected-api" ? "application/json" : "text/html" });
        res.end(url === "/protected-api" ? `{"ok":true}` : "<!DOCTYPE html><html><body>frame</body></html>");
        return;
      }
      if (url === "/app") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>
          <img src="/protected-image" width="1" height="1">
          <iframe src="/protected-frame" style="width:20px;height:20px"></iframe>
          <script>fetch("/protected-api").catch(() => {});</script>
        </body></html>`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return listen(server, hostname).then((origin) => ({
    origin,
    records,
    close: () => closeServer(server),
  }));
}

function startCookieApiFixture(): Promise<{
  origin: string;
  records: Recorded[];
  close(): Promise<void>;
}> {
  const records: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      records.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        cookie: cookieOf(req),
        body: Buffer.concat(chunks).toString(),
      });
      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>
          <script>
            fetch("/set-api").then(() => fetch("/ready", { method: "POST", body: "set" })).catch(() => {});
          </script>
        </body></html>`);
        return;
      }
      if (url === "/set-api") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "sid=from-api; Path=/; SameSite=Lax",
        });
        res.end(`{"ok":true}`);
        return;
      }
      if (url === "/ready" || url === "/echo") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(cookieOf(req) ?? "");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    records,
    close: () => closeServer(server),
  }));
}

function startCrossOriginPair(): Promise<{
  originA: string;
  originB: string;
  recordsB: Recorded[];
  close(): Promise<void>;
}> {
  const recordsB: Recorded[] = [];
  let originA = "";
  let originB = "";
  const serverA = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body>
      <img src=${JSON.stringify(originB + "/pixel")} width="1" height="1">
      <iframe src=${JSON.stringify(originB + "/frame")} style="width:20px;height:20px"></iframe>
      <script>
        fetch(${JSON.stringify(originB + "/api")}, { credentials: "include" }).catch(() => {});
      </script>
    </body></html>`);
  });
  const serverB = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    recordsB.push({
      url: req.url ?? "/",
      method: req.method ?? "GET",
      cookie: cookieOf(req),
    });
    const origin = originA;
    if (url === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "session=abc123; Path=/; SameSite=Lax",
      });
      res.end("<!DOCTYPE html><html><body>b-login</body></html>");
      return;
    }
    if (url === "/api") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      });
      res.end(`{"ok":true}`);
      return;
    }
    if (url === "/pixel") {
      res.writeHead(200, { "Content-Type": "image/gif" });
      res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
      return;
    }
    if (url === "/frame") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body>frame-b</body></html>");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return Promise.all([listen(serverA, "site-a.polyth.test"), listen(serverB, "site-b.polyth.test")]).then(([a, b]) => {
    originA = a;
    originB = b;
    return {
      originA,
      originB,
      recordsB,
      close: async () => {
        await closeServer(serverA);
        await closeServer(serverB);
      },
    };
  });
}

function startStreamFixture(gapMs: number, chunks = 3): Promise<{
  origin: string;
  progress: Array<{ at: number; text: string }>;
  sseProgress: Array<{ at: number; data: string }>;
  streamStartedAt: { value: number };
  close(): Promise<void>;
}> {
  const progress: Array<{ at: number; text: string }> = [];
  const sseProgress: Array<{ at: number; data: string }> = [];
  const streamStartedAt = { value: 0 };
  const readJson = (req: IncomingMessage, res: ServerResponse, sink: Array<Record<string, unknown>>): void => {
    const chunksIn: Buffer[] = [];
    req.on("data", (chunk) => chunksIn.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        sink.push(JSON.parse(Buffer.concat(chunksIn).toString()) as { at: number; text: string });
      } catch { /* ignore */ }
      res.writeHead(204);
      res.end();
    });
  };
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/progress") {
      readJson(req, res, progress);
      return;
    }
    if (url === "/sse-progress") {
      readJson(req, res, sseProgress);
      return;
    }
    if (url === "/stream") {
      streamStartedAt.value = Date.now();
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      let i = 0;
      const tick = (): void => {
        i += 1;
        res.write(`chunk-${i};`);
        if (i >= chunks) {
          res.end();
          return;
        }
        setTimeout(tick, gapMs);
      };
      tick();
      return;
    }
    if (url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let i = 0;
      const tick = (): void => {
        i += 1;
        res.write(`data: sse-${i}\n\n`);
        if (i >= chunks) {
          res.end();
          return;
        }
        setTimeout(tick, gapMs);
      };
      tick();
      return;
    }
    if (url === "/stream-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <script>
          (async () => {
            const t0 = Date.now();
            try {
              const res = await fetch("/stream");
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = dec.decode(value);
                fetch("/progress", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ at: Date.now() - t0, text }),
                }).catch(() => {});
              }
            } catch (e) {
              fetch("/progress", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ at: Date.now() - t0, text: "error:" + String(e) }),
              }).catch(() => {});
            }
          })();
        </script>
      </body></html>`);
      return;
    }
    if (url === "/sse-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <script>
          const t0 = Date.now();
          const es = new EventSource("/sse");
          es.onmessage = (e) => {
            fetch("/sse-progress", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ at: Date.now() - t0, data: e.data }),
            }).catch(() => {});
          };
          es.onerror = () => { es.close(); };
        </script>
      </body></html>`);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    progress,
    sseProgress,
    streamStartedAt,
    close: () => closeServer(server),
  }));
}

function startWsFixture(): Promise<{
  origin: string;
  wsUrl: string;
  accepted: { count: number };
  messages: string[];
  close(): Promise<void>;
}> {
  const accepted = { count: 0 };
  const messages: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    accepted.count += 1;
    socket.on("message", (data) => { messages.push(String(data)); });
    socket.send("hello");
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    wsUrl: origin.replace(/^http/, "ws") + "/ws",
    accepted,
    messages,
    close: () => new Promise((done) => {
      wss.close();
      server.close(() => done());
    }),
  }));
}

function startPublicWsPair(): Promise<{
  pageOrigin: string;
  wsUrl: string;
  accepted: { count: number };
  messages: string[];
  close(): Promise<void>;
}> {
  const accepted = { count: 0 };
  const messages: string[] = [];
  let wsUrl = "";
  const pageServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body>
      <script>
        const ws = new WebSocket(${JSON.stringify(wsUrl)});
        ws.onopen = () => ws.send("from-page");
        ws.onerror = () => {};
      </script>
    </body></html>`);
  });
  const wsHttp = createServer();
  const wss = new WebSocketServer({ server: wsHttp });
  wss.on("connection", (socket: WebSocket) => {
    accepted.count += 1;
    socket.on("message", (data) => { messages.push(String(data)); });
  });
  return Promise.all([
    listen(pageServer, "site.polyth.test"),
    listen(wsHttp, "ws.polyth.test"),
  ]).then(([pageOrigin, wsOrigin]) => {
    wsUrl = wsOrigin.replace(/^http/, "ws") + "/socket";
    return {
      pageOrigin,
      wsUrl,
      accepted,
      messages,
      close: async () => {
        wss.close();
        await closeServer(pageServer);
        await closeServer(wsHttp);
      },
    };
  });
}

function startServiceWorkerFixture(privateUrl: string): Promise<{
  origin: string;
  swResults: string[];
  close(): Promise<void>;
}> {
  const swResults: string[] = [];
  const swJs = `self.addEventListener("install", (event) => {
    event.waitUntil(fetch(${JSON.stringify(privateUrl)}).catch(() => {}));
  });
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const url = event.request.url;
    if (url.includes("private-sw")) {
      event.respondWith(fetch(${JSON.stringify(privateUrl)}).catch(() => new Response("blocked")));
    }
  });`;
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/sw.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Service-Worker-Allowed": "/",
      });
      res.end(swJs);
      return;
    }
    if (url === "/sw-result") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        swResults.push(Buffer.concat(chunks).toString());
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body>
      <script>
        navigator.serviceWorker.register("/sw.js").then((reg) => {
          const real = Boolean(reg && typeof reg.update === "function");
          fetch("/sw-result", { method: "POST", body: real ? "registered" : "blocked:overridden" }).catch(() => {});
          if (real) fetch("/private-sw").catch(() => {});
        }).catch((e) => {
          fetch("/sw-result", { method: "POST", body: "blocked:" + String(e && e.message ? e.message : e) }).catch(() => {});
        });
      </script>
    </body></html>`);
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    swResults,
    close: () => closeServer(server),
  }));
}

function startRedirectFixture(privateOrigin: string): Promise<{
  origin: string;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push(req.url ?? "/");
    if (url === "/to-private") {
      res.writeHead(302, { Location: `${privateOrigin}/secret` });
      res.end();
      return;
    }
    if (url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <img src="/to-private" width="1" height="1">
        <iframe src="/to-private" style="width:20px;height:20px"></iframe>
        <script>
          fetch("/to-private").catch(() => {});
        </script>
      </body></html>`);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    requests,
    close: () => closeServer(server),
  }));
}

test("real chromium authenticated subresources send the browser session cookie", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const site = await startAuthFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-auth-sub-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-auth-sub", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/login`);
    await page.goto(`${site.origin}/app`);
    await sleep(800);
    const api = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/protected-api");
    const image = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/protected-image");
    const frame = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/protected-frame");
    assert.ok(api, "fetch must reach the protected API");
    assert.match(api.cookie ?? "", /session=abc123/, "fetch receives browser cookie");
    assert.ok(image, "image must reach the protected endpoint");
    assert.match(image.cookie ?? "", /session=abc123/, "image receives browser cookie");
    assert.ok(frame, "iframe must reach the protected endpoint");
    assert.match(frame.cookie ?? "", /session=abc123/, "iframe receives browser cookie");
    await context.close();
  } finally {
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium cross-origin public subresources keep cookies under browser control", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const pair = await startCrossOriginPair();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-cors-cookie-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-cors-cookie", userDataDir, {
      allowedOrigins: [pair.originA, pair.originB],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${pair.originB}/login`);
    await page.goto(`${pair.originA}/`);
    await sleep(800);
    const frame = pair.recordsB.find((row) => (row.url.split("?")[0] ?? "") === "/frame");
    const pixel = pair.recordsB.find((row) => (row.url.split("?")[0] ?? "") === "/pixel");
    const api = pair.recordsB.find((row) => (row.url.split("?")[0] ?? "") === "/api");
    assert.ok(frame, "origin B iframe must load");
    assert.ok(pixel, "origin B image must load");
    assert.ok(api, "origin B fetch must load");
    assert.match(frame.cookie ?? "", /session=abc123/, "same-site iframe cookie stays browser-controlled");
    assert.match(pixel.cookie ?? "", /session=abc123/, "same-site image cookie stays browser-controlled");
    await context.close();
  } finally {
    await pair.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium Set-Cookie from a subresource updates the Chromium cookie jar", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const site = await startCookieApiFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-set-cookie-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-set-cookie", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/`);
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      if (site.records.some((row) => (row.url.split("?")[0] ?? "") === "/ready")) break;
      await sleep(50);
    }
    await page.goto(`${site.origin}/echo`);
    const echo = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/echo");
    assert.ok(echo, "top-level echo must run after the API Set-Cookie");
    assert.match(echo.cookie ?? "", /sid=from-api/, "Chromium cookie jar must contain the subresource Set-Cookie");
    await context.close();
  } finally {
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium streaming fetch is delivered progressively and survives past 10s", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const site = await startStreamFixture(4_000, 4);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-stream-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-stream", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/stream-page`);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (site.progress.length >= 4) break;
      await sleep(200);
    }
    assert.equal(site.progress.filter((row) => row.text.startsWith("error:")).length, 0, "stream must not fail");
    assert.ok(site.progress.length >= 4, "Chromium must receive all stream chunks");
    const first = site.progress[0]!;
    const last = site.progress[site.progress.length - 1]!;
    assert.ok(first.at < 2_000, "first chunk must arrive before the full body is buffered");
    assert.ok(last.at - first.at >= 10_000, "later chunks must arrive progressively across more than 10s");
    assert.ok(!/error:/.test(site.progress.map((row) => row.text).join("")), "no proxy timeout on a >10s stream");
    await context.close();
  } finally {
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium EventSource receives SSE chunks progressively", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const site = await startStreamFixture(400, 3);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-sse-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-sse", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/sse-page`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (site.sseProgress.length >= 3) break;
      await sleep(50);
    }
    assert.ok(site.sseProgress.length >= 3, "EventSource must receive all events");
    const first = site.sseProgress[0]!;
    const last = site.sseProgress[site.sseProgress.length - 1]!;
    assert.ok(last.at - first.at >= 250, "SSE events must arrive progressively");
    await context.close();
  } finally {
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium fetch/image/iframe redirect to private never contacts the private hop", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startPrivateCounter();
  const allowed = await startRedirectFixture(privateTarget.origin);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-redir-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  let context: Awaited<ReturnType<NonNullable<typeof driver>["openProfile"]>> | undefined;
  try {
    context = await driver!.openProfile(openOpts("net-redir", userDataDir, {
      allowedOrigins: [allowed.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/page`);
    await sleep(800);
    assert.ok(allowed.requests.some((url) => (url.split("?")[0] ?? "") === "/to-private"));
    assert.equal(privateTarget.requests.length, 0, "redirect hop must not contact the private server");
    assert.equal(events.filter((ev) => ev.kind === "approval-required").length, 0);
  } finally {
    await context?.close().catch(() => {});
    await privateTarget.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium top-level 302 to private never contacts the private hop", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startPrivateCounter();
  const allowed = await startRedirectFixture(privateTarget.origin);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-top-302-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  let context: Awaited<ReturnType<NonNullable<typeof driver>["openProfile"]>> | undefined;
  try {
    context = await driver!.openProfile(openOpts("net-top-302", userDataDir, {
      allowedOrigins: [allowed.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${allowed.origin}/to-private`).catch(() => {});
    await sleep(500);
    assert.ok(allowed.requests.some((url) => (url.split("?")[0] ?? "") === "/to-private"));
    assert.equal(privateTarget.requests.length, 0, "top-level redirect hop must not contact the private server");
  } finally {
    await context?.close().catch(() => {});
    await privateTarget.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium Chat Workspace service worker cannot bypass private-network policy", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startPrivateCounter();
  const site = await startServiceWorkerFixture(`${privateTarget.origin}/secret`);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-sw-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-sw", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/`);
    await sleep(1_200);
    assert.equal(privateTarget.requests.length, 0, "service worker must not contact the private server");
    assert.ok(
      site.swResults.some((row) => row.startsWith("blocked:")),
      "service worker must not take control of Chat Workspace traffic",
    );
    await context.close();
  } finally {
    await privateTarget.close();
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function startWsAttemptPage(wsUrl: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body>
      <script>
        try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) {}
      </script>
    </body></html>`);
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    close: () => closeServer(server),
  }));
}

test("real chromium private WebSocket from an external profile is not accepted", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateWs = await startWsFixture();
  const allowed = await startWsAttemptPage(privateWs.wsUrl);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-ws-priv-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-ws-priv", userDataDir, {
      allowedOrigins: [allowed.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${allowed.origin}/`);
    await sleep(800);
    assert.equal(privateWs.accepted.count, 0, "private WS server acceptedConnections must stay 0");
    await context.close();
  } finally {
    await privateWs.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium public WebSocket remains a live Chromium connection", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const pair = await startPublicWsPair();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-ws-pub-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-ws-pub", userDataDir, {
      allowedOrigins: [pair.pageOrigin, pair.wsUrl.replace(/^ws/, "http").replace(/\/socket$/, "")],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${pair.pageOrigin}/`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (pair.accepted.count >= 1 && pair.messages.includes("from-page")) break;
      await sleep(50);
    }
    assert.equal(pair.accepted.count, 1, "public WebSocket must connect");
    assert.ok(pair.messages.includes("from-page"), "Chromium must own the public WebSocket traffic");
    await context.close();
  } finally {
    await pair.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function startHttpAndWsPage(otherWsUrl: string): Promise<{
  origin: string;
  accepted: { count: number };
  close(): Promise<void>;
}> {
  const accepted = { count: 0 };
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/own-open") {
      res.writeHead(204);
      res.end();
      return;
    }
    const ownWs = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body>
      <script>
        window.addEventListener("load", () => {
          setTimeout(() => {
            try {
              const own = new WebSocket(${JSON.stringify(ownWs)});
              own.onopen = () => fetch("/own-open", { method: "POST" }).catch(() => {});
            } catch (e) {}
            try { new WebSocket(${JSON.stringify(otherWsUrl)}); } catch (e) {}
          }, 50);
        });
      </script>
    </body></html>`);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", () => { accepted.count += 1; });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    accepted,
    close: () => new Promise((done) => {
      wss.close();
      server.close(() => done());
    }),
  }));
}

test("real chromium custom local origin may use its own WebSocket but not another loopback port", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const otherWs = await startWsFixture();
  const custom = await startHttpAndWsPage(otherWs.wsUrl);
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-ws-custom-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("net-ws-custom", userDataDir, {
      allowedOrigins: [custom.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${custom.origin}/`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (custom.accepted.count >= 1) break;
      await sleep(50);
    }
    await sleep(400);
    assert.ok(custom.accepted.count >= 1, "explicit custom local origin may use its own WebSocket");
    assert.equal(otherWs.accepted.count, 0, "another loopback port must not accept a WebSocket");
    await context.close();
  } finally {
    await otherWs.close();
    await custom.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function startOpenerSite(unapprovedOrigin: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/a") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <button id="open-popup" style="position:absolute;left:0;top:0;width:180px;height:40px">popup</button>
        <button id="open-bounce" style="position:absolute;left:0;top:50px;width:180px;height:40px">bounce</button>
        <script>
          document.getElementById("open-popup").addEventListener("click", () => {
            window.open("/popup", "oauth", "width=480,height=360");
          });
          document.getElementById("open-bounce").addEventListener("click", () => {
            window.open("/bounce", "bounce", "width=480,height=360");
          });
        </script>
      </body></html>`);
      return;
    }
    if (url === "/popup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body><h1 id='popup'>popup</h1></body></html>");
      return;
    }
    if (url === "/bounce") {
      res.writeHead(302, { Location: `${unapprovedOrigin}/secret` });
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    close: () => closeServer(server),
  }));
}

function startTabBSite(): Promise<{
  origin: string;
  records: Recorded[];
  wsAccepted: { count: number };
  close(): Promise<void>;
}> {
  const records: Recorded[] = [];
  const wsAccepted = { count: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      records.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        cookie: cookieOf(req),
        body: Buffer.concat(chunks).toString(),
      });
      if (url === "/b") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body><h1 id='tab-b'>B</h1></body></html>");
        return;
      }
      if (url === "/set") {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Set-Cookie": "session=abc123; Path=/; SameSite=Lax",
        });
        res.end("<!DOCTYPE html><html><body>set</body></html>");
        return;
      }
      if (url === "/submit") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>
          <form method="POST" action="/form">
            <input name="q" value="hello">
          </form>
          <script>document.forms[0].submit();</script>
        </body></html>`);
        return;
      }
      if (url === "/form") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body>posted</body></html>");
        return;
      }
      if (url === "/own-open") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url === "/ws-page") {
        const port = (server.address() as { port: number }).port;
        const ownWs = `ws://127.0.0.1:${port}/ws`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>
          <script>
            window.addEventListener("load", () => {
              setTimeout(() => {
                try {
                  const own = new WebSocket(${JSON.stringify(ownWs)});
                  own.onopen = () => fetch("/own-open", { method: "POST" }).catch(() => {});
                } catch (e) {}
              }, 50);
            });
          </script>
        </body></html>`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", () => { wsAccepted.count += 1; });
  return listen(server, "127.0.0.1").then((origin) => ({
    origin,
    records,
    wsAccepted,
    close: () => new Promise((done) => {
      wss.close();
      server.close(() => done());
    }),
  }));
}

test("real chromium resident tab stays native while an unrelated popup is open", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const unapproved = await startPrivateCounter();
  const siteA = await startOpenerSite(unapproved.origin);
  const siteB = await startTabBSite();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-net-popup-class-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  let context: Awaited<ReturnType<NonNullable<typeof driver>["openProfile"]>> | undefined;
  try {
    context = await driver!.openProfile(openOpts("net-popup-class", userDataDir, {
      allowedOrigins: [siteA.origin, siteB.origin],
      privateNetwork: "explicit-only",
    }));
    const tabA = await context.newPage("tab-a");
    const tabB = await context.newPage("tab-b");
    const eventsA: ProfilePageEvent[] = [];
    tabA.onEvent((ev) => { eventsA.push(ev); });

    await tabA.goto(`${siteA.origin}/a`);
    await tabB.goto(`${siteB.origin}/b`);
    assert.ok(
      siteB.records.some((row) => (row.url.split("?")[0] ?? "") === "/b" && row.method === "GET"),
      "tab B first GET must reach the server",
    );

    await click(tabA, 20);
    const popupDeadline = Date.now() + 4_000;
    while (Date.now() < popupDeadline) {
      if (eventsA.some((ev) => ev.kind === "popup-opened")) break;
      await sleep(50);
    }
    assert.ok(eventsA.some((ev) => ev.kind === "popup-opened"), "tab A popup must stay open");

    await tabB.goto(`${siteB.origin}/set`);
    await tabB.goto(`${siteB.origin}/submit`);
    const postDeadline = Date.now() + 3_000;
    while (Date.now() < postDeadline) {
      if (siteB.records.some((row) => (row.url.split("?")[0] ?? "") === "/form" && row.method === "POST")) break;
      await sleep(50);
    }
    const form = siteB.records.find((row) => (row.url.split("?")[0] ?? "") === "/form" && row.method === "POST");
    assert.ok(form, "tab B POST form navigation must reach the server while the popup is open");
    assert.match(form.body ?? "", /q=hello/, "POST body must be preserved on the resident tab");
    assert.match(form.cookie ?? "", /session=abc123/, "browser cookie jar must be used for the resident tab POST");

    await tabB.goto(`${siteB.origin}/ws-page`);
    const wsDeadline = Date.now() + 5_000;
    while (Date.now() < wsDeadline) {
      if (siteB.wsAccepted.count >= 1) break;
      await sleep(50);
    }
    assert.ok(
      siteB.wsAccepted.count >= 1,
      "resident tab same-origin WebSocket must stay Chromium-owned while an unrelated popup is open",
    );
    assert.equal(eventsA.filter((ev) => ev.kind === "popup-closed").length, 0, "the unrelated popup must remain open");

    const beforeBounce = unapproved.requests.length;
    await click(tabA, 70);
    await sleep(500);
    assert.equal(
      unapproved.requests.length,
      beforeBounce,
      "initial popup redirect to an unlisted private origin must not contact the network",
    );
  } finally {
    await context?.close().catch(() => {});
    await siteA.close();
    await siteB.close();
    await unapproved.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
