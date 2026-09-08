import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

test("real chromium blocks popup and tab navigation before the unapproved origin is contacted", { skip: !gated, timeout: 60_000 }, async () => {
  resetProfileChromiumLocks();
  const unapproved = await startFixture({
    "/": "<!DOCTYPE html><html><body><h1 id='unapproved'>unapproved</h1></body></html>",
    "/secret": "<!DOCTYPE html><html><body>secret</body></html>",
    "/tab": "<!DOCTYPE html><html><body>tab</body></html>",
  });
  const allowed = await startFixture({
    "/parent": `<!DOCTYPE html><html><body>
      <button id="open-unapproved" style="position:absolute;left:0;top:0;width:180px;height:40px">unapproved</button>
      <button id="open-oauth" style="position:absolute;left:0;top:50px;width:180px;height:40px">oauth</button>
      <button id="open-bounce" style="position:absolute;left:0;top:100px;width:180px;height:40px">bounce</button>
      <script>
        document.getElementById("open-unapproved").addEventListener("click", () => {
          window.open(${JSON.stringify(unapproved.origin + "/")}, "unapproved", "width=480,height=360");
        });
        document.getElementById("open-oauth").addEventListener("click", () => {
          window.open("/oauth", "oauth", "width=480,height=360");
        });
        document.getElementById("open-bounce").addEventListener("click", () => {
          window.open("/bounce", "bounce", "width=480,height=360");
        });
      </script>
    </body></html>`,
    "/oauth": "<!DOCTYPE html><html><body><h1 id='oauth'>oauth</h1></body></html>",
    "/bounce": { redirect: `${unapproved.origin}/secret` },
  });

  const once = new Set<string>();
  const always = new Set<string>();
  const guard = async (url: string) => {
    const origin = new URL(url).origin;
    if (origin === allowed.origin) return;
    if (once.has(origin) || always.has(origin)) return;
    throw err("approval-required", `needs approval: ${origin}`);
  };

  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-popup-guard-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");

  const open = async () => driver!.openProfile({
    profileId: "popup-guard",
    userDataDir,
    viewport: { width: 800, height: 600 },
    colorScheme: "no-preference",
    guardNavigation: guard,
  });

  try {
    const context = await open();
    const page = await context.newPage("tab-1");
    const events: ProfilePageEvent[] = [];
    page.onEvent((ev) => { events.push(ev); });

    await page.goto(`${allowed.origin}/parent`);

    const beforeTab = unapproved.requests.length;
    await page.goto(`${unapproved.origin}/tab`).catch(() => {});
    await sleep(400);
    assert.equal(unapproved.requests.length, beforeTab, "unapproved tab navigation must not reach the network");
    assert.ok(events.some((ev) => ev.kind === "approval-required" && ev.origin === unapproved.origin));

    once.add(unapproved.origin);
    await page.goto(`${allowed.origin}/parent`);
    await page.goto(`${unapproved.origin}/tab?once=1`);
    await sleep(400);
    assert.ok(
      unapproved.requests.some((url) => url.startsWith("/tab")),
      "allow once must permit the next tab navigation",
    );

    await page.goto(`${allowed.origin}/parent`);
    once.delete(unapproved.origin);
    const afterOnce = unapproved.requests.length;
    await click(page, 20);
    await sleep(400);
    assert.equal(unapproved.requests.length, afterOnce, "unapproved popup must not send its first request");
    assert.ok(events.some((ev) => ev.kind === "approval-required"));

    const opened = events.filter((ev) => ev.kind === "popup-opened").at(-1)?.popupId;
    if (opened && page.closePopup) await page.closePopup(opened).catch(() => {});

    once.add(unapproved.origin);
    await click(page, 20);
    await sleep(400);
    assert.ok(
      unapproved.requests.some((url) => url === "/" || url === "/?"),
      "approved popup retry must reach the unapproved origin",
    );

    const openedAllowed = events.filter((ev) => ev.kind === "popup-opened").at(-1)?.popupId;
    if (openedAllowed && page.closePopup) await page.closePopup(openedAllowed).catch(() => {});

    const beforeOauth = unapproved.requests.length;
    await click(page, 70);
    await sleep(500);
    assert.equal(unapproved.requests.length, beforeOauth, "allowed oauth popup must not contact unapproved origin");
    assert.ok(events.some((ev) => ev.kind === "popup-opened"));

    const beforeBounce = unapproved.requests.length;
    once.delete(unapproved.origin);
    await click(page, 120);
    await sleep(500);
    assert.equal(unapproved.requests.length, beforeBounce, "popup redirect to unapproved origin must be blocked before network");
    assert.ok(
      events.some((ev) => ev.kind === "approval-required" && ev.origin === unapproved.origin),
      "redirect block must request approval for the unapproved origin, not the parent",
    );

    await context.close();
    resetProfileChromiumLocks();
    once.clear();
    const restarted = await open();
    const restartedPage = await restarted.newPage("tab-2");
    const restartEvents: ProfilePageEvent[] = [];
    restartedPage.onEvent((ev) => { restartEvents.push(ev); });
    await restartedPage.goto(`${allowed.origin}/parent`);
    const beforeRestart = unapproved.requests.length;
    await click(restartedPage, 20);
    await sleep(400);
    assert.equal(unapproved.requests.length, beforeRestart, "allow once must not persist across profile recreate");
    assert.ok(restartEvents.some((ev) => ev.kind === "approval-required"));

    always.add(unapproved.origin);
    await click(restartedPage, 20);
    await sleep(400);
    assert.ok(unapproved.requests.length > beforeRestart, "always-allow must permit popup navigation");

    await restarted.close();
  } finally {
    await unapproved.close();
    await allowed.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
