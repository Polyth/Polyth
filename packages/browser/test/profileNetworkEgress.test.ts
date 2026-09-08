import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUrl,
  createProfileChromiumDriver,
  resetProfileChromiumLocks,
  type UrlPolicyOptions,
} from "../src/index.ts";
import type { NavigationKind, ProfilePageEvent } from "../src/profileDriver.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";
const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const chrome = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome";
const HOST_RULES = "--host-resolver-rules=MAP *.polyth.test 127.0.0.1";
const publicDns = async (host: string): Promise<string[]> => {
  if (host === "private.example") return ["10.0.0.2"];
  return ["93.184.216.34"];
};

type Fixture = {
  origin: string;
  requests: string[];
  close(): Promise<void>;
};

type Recorded = { url: string; method: string; cookie?: string; body?: string };

function startFixture(
  pages: Record<string, string | { redirect: string } | { png: true }>,
  hostname = "127.0.0.1",
): Promise<Fixture> {
  const requests: string[] = [];
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      requests.push(req.url ?? "/");
      const page = pages[url] ?? pages["*"];
      if (page && typeof page === "object" && "redirect" in page) {
        res.writeHead(302, { Location: page.redirect });
        res.end();
        return;
      }
      if (page && typeof page === "object" && "png" in page) {
        res.writeHead(200, { "Content-Type": "image/gif" });
        res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
        return;
      }
      if (typeof page === "string") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://${hostname}:${port}`,
        requests,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

function startStatefulFixture(): Promise<{
  origin: string;
  records: Recorded[];
  close(): Promise<void>;
}> {
  const records: Recorded[] = [];
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const url = (req.url ?? "/").split("?")[0] ?? "/";
        records.push({
          url: req.url ?? "/",
          method: req.method ?? "GET",
          cookie: typeof req.headers.cookie === "string" ? req.headers.cookie : undefined,
          body: Buffer.concat(chunks).toString(),
        });
        if (url === "/set") {
          res.writeHead(200, {
            "Content-Type": "text/html",
            "Set-Cookie": "sid=abc123; Path=/",
          });
          res.end("<!DOCTYPE html><html><body>set</body></html>");
          return;
        }
        if (url === "/echo") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(req.headers.cookie ?? "");
          return;
        }
        if (url === "/form") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<!DOCTYPE html><html><body>ok</body></html>`);
          return;
        }
        if (url === "/rel") {
          res.writeHead(302, { Location: "/echo" });
          res.end();
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
        res.statusCode = 404;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        records,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function click(page: { mouse(input: { kind: "click"; x: number; y: number }): Promise<void> }, y: number): Promise<void> {
  await page.mouse({ kind: "click", x: 60, y });
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

test("real chromium fetch and image to unlisted private never leave the box", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startFixture({
    "/secret": "secret",
    "/pixel": { png: true },
  });
  const allowed = await startFixture({
    "/page": `<!DOCTYPE html><html><body>
      <img src=${JSON.stringify(privateTarget.origin + "/pixel")} width="1" height="1">
      <script>
        fetch(${JSON.stringify(privateTarget.origin + "/secret")}).catch(() => {});
        navigator.sendBeacon(${JSON.stringify(privateTarget.origin + "/secret")}, "x");
      </script>
    </body></html>`,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-fetch-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-fetch", userDataDir, {
      allowedOrigins: [allowed.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/page`);
    await sleep(700);
    assert.equal(privateTarget.requests.length, 0, "fetch/image/beacon must not contact the private server");
    assert.equal(events.filter((ev) => ev.kind === "approval-required").length, 0);
    await context.close();
  } finally {
    await privateTarget.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium nested public iframe 302 to private never contacts the private hop", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startFixture({
    "/secret": "secret",
  });
  const publicFrame = await startFixture({
    "/frame": { redirect: `${privateTarget.origin}/secret` },
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <iframe src=${JSON.stringify(publicFrame.origin + "/frame")} style="width:200px;height:80px"></iframe>
    </body></html>`,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-nested-302-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-nested-302", userDataDir, {
      allowedOrigins: [allowed.origin, publicFrame.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/parent`);
    await sleep(700);
    assert.ok(publicFrame.requests.some((url) => url.startsWith("/frame")), "public nested frame must be fetched");
    assert.equal(privateTarget.requests.length, 0, "redirect hop must not contact the private server");
    assert.equal(
      events.filter((ev) => ev.kind === "approval-required").length,
      0,
      "nested public origin must not raise top-level approval",
    );
    await context.close();
  } finally {
    await privateTarget.close();
    await publicFrame.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium public nested iframe, fetch, and image still load", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const extra = await startFixture({
    "/api": `{"ok":true}`,
    "/pixel": { png: true },
    "/frame": "<!DOCTYPE html><html><body><h1>frame</h1></body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <iframe src=${JSON.stringify(extra.origin + "/frame")} style="width:200px;height:80px"></iframe>
      <img src=${JSON.stringify(extra.origin + "/pixel")} width="1" height="1">
      <script>fetch(${JSON.stringify(extra.origin + "/api")}).catch(() => {});</script>
    </body></html>`,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-public-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-public", userDataDir, {
      allowedOrigins: [allowed.origin, extra.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/parent`);
    await sleep(700);
    assert.ok(extra.requests.some((url) => url.startsWith("/frame")), "nested iframe must load");
    assert.ok(extra.requests.some((url) => url.startsWith("/pixel")), "image must load");
    assert.ok(extra.requests.some((url) => url.startsWith("/api")), "fetch must load");
    assert.equal(events.filter((ev) => ev.kind === "approval-required").length, 0);
    await context.close();
  } finally {
    await extra.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium explicit custom local origin can fetch itself but not other private hosts", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const otherPrivate = await startFixture({
    "/x": "nope",
  });
  const custom = await startFixture({
    "/": `<!DOCTYPE html><html><body>
      <script>
        fetch("/ok").catch(() => {});
        fetch(${JSON.stringify(otherPrivate.origin + "/x")}).catch(() => {});
      </script>
    </body></html>`,
    "/ok": `{"ok":true}`,
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-custom-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-custom", userDataDir, {
      allowedOrigins: [custom.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${custom.origin}/`);
    await sleep(700);
    assert.ok(custom.requests.some((url) => url === "/" || url.startsWith("/?") || url.startsWith("/ok")));
    assert.equal(otherPrivate.requests.length, 0, "unlisted private origin must not be contacted");
    await context.close();
  } finally {
    await otherPrivate.close();
    await custom.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium two simultaneous blocked popups keep distinct owners", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const originX = await startFixture({ "/": "<!DOCTYPE html><html><body>x</body></html>" });
  const originY = await startFixture({ "/": "<!DOCTYPE html><html><body>y</body></html>" });
  const allowed = await startFixture({
    "/a": `<!DOCTYPE html><html><body>
      <button id="open" style="position:absolute;left:0;top:0;width:180px;height:40px">open</button>
      <script>
        document.getElementById("open").addEventListener("click", () => {
          window.open(${JSON.stringify(originX.origin + "/")}, "x", "width=480,height=360");
        });
      </script>
    </body></html>`,
    "/b": `<!DOCTYPE html><html><body>
      <button id="open" style="position:absolute;left:0;top:0;width:180px;height:40px">open</button>
      <script>
        document.getElementById("open").addEventListener("click", () => {
          window.open(${JSON.stringify(originY.origin + "/")}, "y", "width=480,height=360");
        });
      </script>
    </body></html>`,
  });
  const guard = async (url: string, kind: NavigationKind = "top-level") => {
    const origin = new URL(url).origin;
    if (origin === allowed.origin) return;
    if (kind !== "top-level") {
      const decision = await checkUrl(url, {
        allowedOrigins: [allowed.origin],
        privateNetwork: "explicit-only",
        purpose: "subresource",
      });
      if (decision.ok) return;
      throw err(decision.code, decision.reason);
    }
    throw err("approval-required", `needs approval: ${origin}`);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-two-popups-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  let context: Awaited<ReturnType<NonNullable<typeof driver>["openProfile"]>> | undefined;
  try {
    context = await driver!.openProfile({
      profileId: "egress-two-popups",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const tabA = await context.newPage("tab-a");
    const eventsA: ProfilePageEvent[] = [];
    tabA.onEvent((ev) => { eventsA.push(ev); });
    await tabA.goto(`${allowed.origin}/a`);
    await sleep(300);
    const tabB = await context.newPage("tab-b");
    const eventsB: ProfilePageEvent[] = [];
    tabB.onEvent((ev) => { eventsB.push(ev); });
    await tabB.goto(`${allowed.origin}/b`);
    await sleep(300);
    await click(tabA, 20);
    const firstDeadline = Date.now() + 5_000;
    while (Date.now() < firstDeadline) {
      if (eventsA.some((ev) => ev.kind === "approval-required" && ev.origin === originX.origin)) break;
      await sleep(50);
    }
    await click(tabB, 20);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (
        eventsA.some((ev) => ev.kind === "approval-required" && ev.origin === originX.origin)
        && eventsB.some((ev) => ev.kind === "approval-required" && ev.origin === originY.origin)
      ) break;
      await sleep(50);
    }
    assert.equal(originX.requests.length, 0, "popup X must not hit the network");
    assert.equal(originY.requests.length, 0, "popup Y must not hit the network");
    assert.equal(eventsA.filter((ev) => ev.kind === "approval-required").length, 1);
    assert.equal(eventsB.filter((ev) => ev.kind === "approval-required").length, 1);
    assert.ok(eventsA.some((ev) => ev.kind === "approval-required" && ev.origin === originX.origin));
    assert.ok(eventsB.some((ev) => ev.kind === "approval-required" && ev.origin === originY.origin));
    assert.equal(eventsA.filter((ev) => ev.kind === "approval-required" && ev.origin === originY.origin).length, 0);
    assert.equal(eventsB.filter((ev) => ev.kind === "approval-required" && ev.origin === originX.origin).length, 0);
    await context.close();
  } finally {
    await context?.close().catch(() => {});
    await originX.close();
    await originY.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium fetch/fulfill preserves cookies, POST, and relative redirects", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const site = await startStatefulFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-cookies-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-cookies", userDataDir, {
      allowedOrigins: [site.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${site.origin}/set`);
    await page.goto(`${site.origin}/echo`);
    const echo = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/echo");
    assert.ok(echo, "echo request must reach the server");
    assert.match(echo.cookie ?? "", /sid=abc123/);
    await page.goto(`${site.origin}/submit`);
    await sleep(500);
    const form = site.records.find((row) => (row.url.split("?")[0] ?? "") === "/form" && row.method === "POST");
    assert.ok(form, "POST form navigation must reach the server");
    assert.match(form.body ?? "", /q=hello/);
    assert.match(form.cookie ?? "", /sid=abc123/);
    await page.goto(`${site.origin}/rel`);
    await sleep(400);
    assert.ok(site.records.some((row) => (row.url.split("?")[0] ?? "") === "/rel"));
    assert.ok(site.records.filter((row) => (row.url.split("?")[0] ?? "") === "/echo").length >= 2, "relative Location must be followed");
    await context.close();
  } finally {
    await site.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium rejects unsafe schemes before Playwright navigation", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const allowed = await startFixture({
    "/": "<!DOCTYPE html><html><body>ok</body></html>",
  });
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-egress-schemes-"));
  const driver = await createProfileChromiumDriver(chrome);
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile(openOpts("egress-schemes", userDataDir, {
      allowedOrigins: [allowed.origin],
      privateNetwork: "explicit-only",
    }));
    const page = await context.newPage("tab-1");
    await page.goto(`${allowed.origin}/`);
    for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      await assert.rejects(
        () => page.goto(raw),
        (error: Error & { code?: string }) => error.code === "blocked-scheme",
        raw,
      );
    }
    await context.close();
  } finally {
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
