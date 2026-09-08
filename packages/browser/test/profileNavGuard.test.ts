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
} from "../src/index.ts";
import type { ProfilePageEvent } from "../src/profileDriver.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";
const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

type Fixture = {
  origin: string;
  requests: string[];
  close(): Promise<void>;
};

function startFixture(pages: Record<string, string | { redirect: string }>): Promise<Fixture> {
  const requests: string[] = [];
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      requests.push(req.url ?? "/");
      const page = pages[url] ?? pages["*"];
      if (page && typeof page === "object") {
        res.writeHead(302, { Location: page.redirect });
        res.end();
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
        origin: `http://127.0.0.1:${port}`,
        requests,
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

test("real chromium nested iframe does not raise top-level origin approval", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const nested = await startFixture({
    "/frame": "<!DOCTYPE html><html><body><h1 id='frame'>iframe</h1></body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <iframe src=${JSON.stringify(nested.origin + "/frame")} style="position:absolute;left:0;top:80px;width:200px;height:80px"></iframe>
    </body></html>`,
  });
  const guard = async (url: string, kind = "top-level") => {
    const origin = new URL(url).origin;
    if (origin === allowed.origin) return;
    if (kind === "nested") return;
    throw err("approval-required", `needs approval: ${origin}`);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-iframe-guard-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile({
      profileId: "iframe-guard",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/parent`);
    await sleep(500);
    assert.ok(nested.requests.some((url) => url.startsWith("/frame")), "nested iframe must still load");
    assert.equal(
      events.filter((ev) => ev.kind === "approval-required").length,
      0,
      "iframe navigation must not raise top-level approval",
    );
    await context.close();
  } finally {
    await nested.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium approval-required is owned by the initiating tab", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const unapproved = await startFixture({
    "/": "<!DOCTYPE html><html><body><h1>unapproved</h1></body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <button id="open" style="position:absolute;left:0;top:0;width:180px;height:40px">open</button>
      <script>
        document.getElementById("open").addEventListener("click", () => {
          window.open(${JSON.stringify(unapproved.origin + "/")}, "unapproved", "width=480,height=360");
        });
      </script>
    </body></html>`,
  });
  const guard = async (url: string) => {
    const origin = new URL(url).origin;
    if (origin === allowed.origin) return;
    throw err("approval-required", `needs approval: ${origin}`);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-tab-owner-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  let context: Awaited<ReturnType<NonNullable<typeof driver>["openProfile"]>> | undefined;
  try {
    context = await driver!.openProfile({
      profileId: "tab-owner",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const tabA = await context.newPage("tab-a");
    const tabB = await context.newPage("tab-b");
    const eventsA: ProfilePageEvent[] = [];
    const eventsB: ProfilePageEvent[] = [];
    tabA.onEvent((ev) => { eventsA.push(ev); });
    tabB.onEvent((ev) => { eventsB.push(ev); });
    await tabA.goto(`${allowed.origin}/parent`);
    await tabB.goto(`${allowed.origin}/parent`);
    const before = unapproved.requests.length;
    await click(tabB, 20);
    await sleep(500);
    assert.equal(unapproved.requests.length, before, "unapproved popup must not hit the network");
    assert.equal(eventsA.filter((ev) => ev.kind === "approval-required").length, 0);
    assert.ok(eventsB.some((ev) => ev.kind === "approval-required" && ev.origin === unapproved.origin));
    await context.close();
  } finally {
    await context?.close().catch(() => {});
    await unapproved.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium explicit-only policy blocks private popup and hostname targets", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateTarget = await startFixture({
    "/": "<!DOCTYPE html><html><body>private</body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <button id="open-private" style="position:absolute;left:0;top:0;width:180px;height:40px">private</button>
      <button id="open-meta" style="position:absolute;left:0;top:50px;width:180px;height:40px">meta</button>
      <button id="open-host" style="position:absolute;left:0;top:100px;width:180px;height:40px">host</button>
      <script>
        document.getElementById("open-private").addEventListener("click", () => {
          window.open(${JSON.stringify(privateTarget.origin + "/")}, "private", "width=480,height=360");
        });
        document.getElementById("open-meta").addEventListener("click", () => {
          window.open("http://169.254.169.254/", "meta", "width=480,height=360");
        });
        document.getElementById("open-host").addEventListener("click", () => {
          window.open("http://private.example/", "host", "width=480,height=360");
        });
      </script>
    </body></html>`,
  });
  const policy = {
    allowedOrigins: [allowed.origin],
    approvedOrigins: new Set<string>(),
    privateNetwork: "explicit-only" as const,
    resolve: async (host: string) => host === "private.example" ? ["10.0.0.2"] : ["93.184.216.34"],
  };
  const guard = async (url: string, kind = "top-level") => {
    const decision = await checkUrl(url, policy);
    if (decision.ok) return;
    if (kind === "nested" && decision.code === "approval-required") return;
    throw err(decision.code, decision.reason);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-privnet-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile({
      profileId: "privnet",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const page = await context.newPage("tab-1");
    await page.goto(`${allowed.origin}/parent`);
    const before = privateTarget.requests.length;
    await click(page, 20);
    await sleep(400);
    assert.equal(privateTarget.requests.length, before, "unlisted private popup must not be contacted");
    await click(page, 70);
    await sleep(300);
    await click(page, 120);
    await sleep(300);
    await context.close();
  } finally {
    await privateTarget.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium nested iframe to unlisted private is aborted without approval UX", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const privateFrame = await startFixture({
    "/frame": "<!DOCTYPE html><html><body>secret</body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <iframe src=${JSON.stringify(privateFrame.origin + "/frame")} style="width:200px;height:80px"></iframe>
    </body></html>`,
  });
  const policy = {
    allowedOrigins: [allowed.origin],
    privateNetwork: "explicit-only" as const,
  };
  const guard = async (url: string, kind = "top-level") => {
    const decision = await checkUrl(url, policy);
    if (decision.ok) return;
    if (kind === "nested" && decision.code === "approval-required") return;
    throw err(decision.code, decision.reason);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-iframe-ssrf-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile({
      profileId: "iframe-ssrf",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });
    await page.goto(`${allowed.origin}/parent`);
    await sleep(500);
    assert.equal(privateFrame.requests.length, 0, "unlisted private iframe must not be fetched");
    assert.equal(events.filter((ev) => ev.kind === "approval-required").length, 0);
    await context.close();
  } finally {
    await privateFrame.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("real chromium explicit custom local origin still navigates", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const custom = await startFixture({
    "/": "<!DOCTYPE html><html><body><h1 id='home'>custom</h1></body></html>",
  });
  const policy = {
    allowedOrigins: [custom.origin],
    privateNetwork: "explicit-only" as const,
  };
  const guard = async (url: string, kind = "top-level") => {
    const decision = await checkUrl(url, policy);
    if (decision.ok) return;
    if (kind === "nested" && decision.code === "approval-required") return;
    throw err(decision.code, decision.reason);
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-custom-local-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  try {
    const context = await driver!.openProfile({
      profileId: "custom-local",
      userDataDir,
      viewport: { width: 800, height: 600 },
      colorScheme: "no-preference",
      guardNavigation: guard,
    });
    const page = await context.newPage("tab-1");
    const nav = await page.goto(`${custom.origin}/`);
    await sleep(200);
    assert.ok(custom.requests.some((url) => url === "/" || url.startsWith("/?")));
    assert.equal(new URL(nav.url).origin, custom.origin);
    await context.close();
  } finally {
    await custom.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
