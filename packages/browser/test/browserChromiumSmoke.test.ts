import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  createBrowserService,
  createChromiumDriver,
  findChromiumExecutable,
  type BrowserFrame,
} from "../src/index.ts";

const gated = process.env.POLYTH_REAL_CHROMIUM === "1";

const listen = (server: Server): Promise<string> => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve(`http://127.0.0.1:${address.port}`);
  });
});

test("real controlled Chromium streams animated DOM frames and pauses hidden viewers", { skip: !gated }, async () => {
  const executable = await findChromiumExecutable();
  assert.ok(executable, "Chromium executable must be available");
  const blockedRequests: string[] = [];
  const blockedServer = createServer((req, res) => {
    blockedRequests.push(req.url ?? "/");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("should not be reached");
  });
  const blockedOrigin = await listen(blockedServer);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/redirect" || path === "/redirect-subresource" || path === "/iframe-redirect") {
      res.writeHead(302, { Location: `${blockedOrigin}/redirected` });
      res.end();
      return;
    }
    if (path === "/ws-redirect") {
      res.writeHead(302, { Location: `${blockedOrigin.replace("http:", "ws:")}/socket` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body>
      <button id="target">target</button><output id="counter">0</output>
      <script>
        let n=0;setInterval(()=>{document.querySelector('#counter').textContent=String(++n)},50);
        fetch(${JSON.stringify(`${blockedOrigin}/fetch`)}).catch(()=>{});
        fetch('/redirect-subresource').catch(()=>{});
        const frame=document.createElement('iframe');frame.src=${JSON.stringify(`${blockedOrigin}/frame`)};document.body.append(frame);
        const redirectedFrame=document.createElement('iframe');redirectedFrame.src='/iframe-redirect';document.body.append(redirectedFrame);
        try { new WebSocket(${JSON.stringify(blockedOrigin.replace("http:", "ws:") + "/socket")}); } catch {}
        try { new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws-redirect'); } catch {}
      </script>
    </body></html>`);
  });
  const origin = await listen(server);
  const driver = createChromiumDriver(executable);
  const service = createBrowserService({
    driver,
    allowedOrigins: () => [origin],
    privateNetwork: "explicit-only",
  });
  const frames: BrowserFrame[] = [];
  const events: Array<{ kind: string; targetRect?: unknown; url?: string; message?: string }> = [];
  const frameSubscription = service.onFrame((frame) => frames.push(frame));
  const eventSubscription = service.onEvent((event) => events.push(event));
  try {
    const session = await service.create({ projectId: "smoke", url: `${origin}/` });
    service.setViewerVisible(session.id, true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.ok(frames.length >= 2, `expected animated screencast frames, got ${frames.length}`);
    assert.ok(frames.every((frame, index) => index === 0 || frame.revision > frames[index - 1]!.revision));
    assert.equal(blockedRequests.length, 0, "private fetch/iframe/WebSocket must be denied before network egress");
    assert.ok(events.filter((event) => event.kind === "network" || event.kind === "network-blocked").length >= 2);
    assert.ok(events.some((event) => event.kind === "network" && event.url?.endsWith("/redirected")), "iframe/fetch redirect hops must be surfaced as blocked network events");
    await service.action(session.id, { kind: "click", target: { selector: "#target" } }, "agent");
    assert.ok(events.some((event) => event.kind === "action" && event.targetRect));

    service.setViewerVisible(session.id, false);
    const hiddenCount = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(frames.length, hiddenCount, "hidden viewer must stop screencast delivery");
    await assert.rejects(
      () => service.navigate(session.id, `${origin}/redirect`, "user"),
      (error: Error & { code?: string }) => error.code === "blocked-private",
    );
  } catch (error) {
    console.error("controlled Chromium smoke failure", error);
    throw error;
  } finally {
    frameSubscription.dispose();
    eventSubscription.dispose();
    await service.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => blockedServer.close(() => resolve()));
  }
});
