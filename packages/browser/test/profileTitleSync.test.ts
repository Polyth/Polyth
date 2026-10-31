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

function startTitleFixture(): Promise<{ origin: string; close(): Promise<void> }> {
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/title") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>placeholder</title></head><body>
          <script>
            window.addEventListener("load", () => { document.title = "Loaded Title"; });
          </script>
        </body></html>`);
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

test("real chromium refreshes title after load before persisting navigation", { skip: !gated }, async () => {
  resetProfileChromiumLocks();
  const fixture = await startTitleFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), "polyth-chrome-title-"));
  const driver = await createProfileChromiumDriver(process.env.POLYTH_CHROMIUM_PATH ?? "/usr/local/bin/google-chrome");
  assert.ok(driver, "chromium driver must be available");
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "real-title-profile";
  await registry.openProfile({
    profileId,
    userDataDir,
    allowedOrigins: [fixture.origin],
  });
  const tabId = newChatTabId();
  registry.registerTab("space:proj", tabId, profileId);

  const tab = await registry.ensureLive(tabId, `${fixture.origin}/title`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const page = registry.getPage(tabId);
  assert.ok(page);
  assert.equal(page.current().title, "Loaded Title");
  assert.equal(tab.title, "Loaded Title");

  await registry.closeAll();
  await fixture.close();
  rmSync(userDataDir, { recursive: true, force: true });
});
