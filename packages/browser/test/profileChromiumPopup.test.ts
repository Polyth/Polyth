import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProfileChromiumDriver,
  createProfileRegistry,
  newChatTabId,
  resetProfileChromiumLocks,
} from "../src/index.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";

function startPopupFixture(): Promise<{ origin: string; close(): Promise<void> }> {
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/" || req.url === "/parent") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>
          <button id="open">Open popup</button>
          <script>
            document.getElementById("open").addEventListener("click", () => {
              window.open("/popup", "polyth-popup", "width=480,height=360");
            });
          </script>
        </body></html>`);
        return;
      }
      if (req.url === "/popup") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!DOCTYPE html><html><body><h1 id='popup'>popup</h1></body></html>");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

async function openPopup(page: { mouse(input: { kind: "click"; x: number; y: number }): Promise<void> }): Promise<void> {
  await page.mouse({ kind: "click", x: 60, y: 20 });
}

test("real chromium popup survives hibernate restore and parent cleanup", { skip: !gated }, async () => {
  resetProfileChromiumLocks();
  const fixture = await startPopupFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-chrome-popup-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "real-popup-profile";
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: [fixture.origin],
  });
  const tabId = newChatTabId();
  registry.registerTab("space:proj", tabId, profileId);

  const events: string[] = [];
  const popupFrames: string[] = [];
  registry.onEvent((ev) => {
    if (ev.tabId !== tabId) return;
    events.push(`${ev.kind}:${ev.popupId ?? ""}`);
  });
  registry.onFrame((frame) => {
    if (frame.tabId !== tabId || !frame.popupId) return;
    popupFrames.push(frame.popupId);
  });

  await registry.ensureLive(tabId, `${fixture.origin}/parent`);
  const page = registry.getPage(tabId);
  assert.ok(page);

  await openPopup(page);
  await new Promise((r) => setTimeout(r, 800));
  const firstPopupId = events.find((entry) => entry.startsWith("popup-opened:"))?.split(":")[1];
  assert.ok(firstPopupId, "expected popup-opened after first open");
  assert.ok(popupFrames.includes(firstPopupId), "expected popup screencast frames");

  await registry.closePopup(tabId, firstPopupId);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    events.filter((entry) => entry === `popup-closed:${firstPopupId}`).length,
    1,
    "programmatic close must emit popup-closed exactly once",
  );

  await registry.hibernateTab(tabId);
  assert.equal(registry.getTab(tabId)?.hibernated, true);
  await registry.restoreTab(tabId, `${fixture.origin}/parent`);
  assert.equal(registry.getTab(tabId)?.hibernated, false);
  const restoredPage = registry.getPage(tabId);
  assert.ok(restoredPage);

  await openPopup(restoredPage);
  await new Promise((r) => setTimeout(r, 800));
  const secondPopupId = events.filter((entry) => entry.startsWith("popup-opened:")).at(-1)?.split(":")[1];
  assert.ok(secondPopupId, "expected popup-opened after restore");
  assert.notEqual(secondPopupId, firstPopupId);
  assert.ok(popupFrames.includes(secondPopupId), "expected popup frames after restore");

  await registry.popupInput(tabId, secondPopupId, { inputType: "mouse", kind: "click", x: 40, y: 40, button: "left" });
  await new Promise((r) => setTimeout(r, 200));

  await openPopup(restoredPage);
  await new Promise((r) => setTimeout(r, 500));
  const activePopupId = events.filter((entry) => entry.startsWith("popup-opened:")).at(-1)?.split(":")[1];
  assert.ok(activePopupId);
  await registry.hibernateTab(tabId);
  assert.equal(
    events.filter((entry) => entry === `popup-closed:${activePopupId}`).length,
    1,
    "hibernate must emit popup-closed exactly once",
  );

  await registry.restoreTab(tabId, `${fixture.origin}/parent`);
  const pageAfterHibernate = registry.getPage(tabId);
  assert.ok(pageAfterHibernate);
  await openPopup(pageAfterHibernate);
  await new Promise((r) => setTimeout(r, 800));
  const thirdPopupId = events.filter((entry) => entry.startsWith("popup-opened:")).at(-1)?.split(":")[1];
  assert.ok(thirdPopupId, "popup should work after hibernate with prior active popup");

  await registry.releaseTabPage(tabId);
  assert.equal(registry.getPage(tabId), null);

  await registry.closeAll();
  await fixture.close();
  rmSync(userDataDir, { recursive: true, force: true });
});
