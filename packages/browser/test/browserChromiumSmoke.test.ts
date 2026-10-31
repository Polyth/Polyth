import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrowserService,
  createChromiumDriver,
  createBrowserArtifactStore,
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

test("real Chromium isolates session storage and captures exact scrolled element, area and text context", { skip: !gated }, async () => {
  const executable = await findChromiumExecutable();
  assert.ok(executable, "Chromium executable must be available");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="margin:0;font:16px monospace">
      <button id="write" onclick="localStorage.setItem('fixture','one');document.cookie='fixture=one';">Write</button>
      <button id="read" onclick="document.querySelector('output').textContent=(localStorage.getItem('fixture')||'empty')+' | '+document.cookie">Read</button><output></output>
      <div style="height:900px"></div><main style="height:1000px">
        <h2 id="label" style="margin:0">Upgrade plan</h2>
        <button id="target" aria-labelledby="label" style="height:40px;width:140px">Upgrade</button>
        <div><button class="duplicate">First</button><button class="duplicate">Second</button></div>
        <p id="quote" style="margin:0;line-height:30px">A precise quoted fragment for the agent</p>
      </main></body></html>`);
  });
  const origin = await listen(server);
  const directory = await mkdtemp(join(tmpdir(), "polyth-browser-context-smoke-"));
  const artifacts = createBrowserArtifactStore(directory);
  const service = createBrowserService({ driver: createChromiumDriver(executable), allowedOrigins: () => [origin] });
  try {
    const first = await service.create({ projectId: "smoke", sessionId: "one", url: origin, viewport: { width: 600, height: 400 } });
    const second = await service.create({ projectId: "smoke", sessionId: "two", url: origin, viewport: { width: 600, height: 400 } });
    await service.action(first.id, { kind: "click", target: { selector: "#write" } }, "user");
    await service.action(second.id, { kind: "click", target: { selector: "#read" } }, "user");
    assert.match((await service.observe(second.id)).text, /empty \|/);
    assert.doesNotMatch((await service.observe(second.id)).text, /fixture=one/);
    await service.action(first.id, { kind: "scroll", y: 850 }, "user");
    const inspected = await service.action(first.id, { kind: "inspect", selector: "#target" }, "user");
    const rect = (inspected.result?.rect ?? inspected.result?.bounds) as { x: number; y: number; width: number; height: number };
    assert.ok(rect && rect.y >= 0 && rect.y < 400, "fixture target must be visible after scrolling");
    const point = { x: rect.x + 20, y: rect.y + 20 };
    const element = await service.captureContext(first.id, { type: "element", id: "real-element", expectedRevision: service.get(first.id)!.revision, point }, artifacts);
    assert.equal(element.element?.selector, "#target");
    assert.equal(element.element?.name, "Upgrade plan");
    assert.deepEqual(element.point, point);
    assert.ok((element.element?.documentBounds?.y ?? 0) > (element.element?.bounds?.y ?? 0) + 800);
    assert.ok(element.crop && (await artifacts.read(element.crop.id))!.size > 100);
    const area = await service.captureContext(first.id, { type: "area", id: "real-area", expectedRevision: service.get(first.id)!.revision,
      region: { x: 0, y: Math.max(0, rect.y - 35) / 400, width: 0.9, height: 0.35 } }, artifacts);
    assert.ok(area.intersecting?.some((el) => el.name === "Second" && el.selector?.includes("nth-of-type")), "area hits must carry a unique selector for repeated elements");
    const quoteInspection = await service.action(first.id, { kind: "inspect", selector: "#quote" }, "user");
    const quoteRect = (quoteInspection.result?.rect ?? quoteInspection.result?.bounds) as { x: number; y: number };
    const text = await service.captureContext(first.id, { type: "text", id: "real-text", expectedRevision: service.get(first.id)!.revision,
      start: { x: 250, y: quoteRect.y + 15 }, end: { x: 10, y: quoteRect.y + 15 }, includeScreenshot: true }, artifacts);
    assert.match(text.quote ?? "", /precise quoted/);
    assert.equal(text.element?.selector, "#quote");
    assert.ok(text.region && text.crop, "text range must retain location and image evidence");
    await assert.rejects(service.captureContext(first.id, { type: "element", id: "stale", expectedRevision: first.revision, point }, artifacts), /page changed/i);
  } finally {
    await service.closeAll(); await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
