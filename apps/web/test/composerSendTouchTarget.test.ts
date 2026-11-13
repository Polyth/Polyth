// A tap on the phone's Send sends wherever in its touch box it lands.
//
// Send is a 36px disc inside a 44px touch box (`::after`, `--hit-min`), and
// touch Send is admitted on pointerup. Judging the release against the disc
// alone left the outer ring of the box dead: the browser gave the press to
// Send, Send showed it, and nothing was sent — about 40% of the target. This
// drives the REAL Composer with real touches (CDP), because a synthetic
// pointer event neither hit-tests the `::after` box nor follows a moving finger.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";
import { releaseSends, SEND_TAP_SLOP_PX } from "../src/composer/sendRelease.ts";

const disc = { left: 100, top: 100, right: 136, bottom: 136, width: 36, height: 36 };

test("a release sends unless the finger left Send", () => {
  const still = { x: 140, y: 118 }; // on the touch box's ring, 4px past the disc
  assert.equal(releaseSends({ down: still, up: still, rect: disc, overControl: true }), true,
    "a still tap on the ring of the touch box sends");
  assert.equal(releaseSends({ down: still, up: still, rect: disc, overControl: false }), true,
    "a still tap the browser gave to Send sends even past its hit-tested box");
  assert.equal(releaseSends({ down: { x: 118, y: 118 }, up: { x: 139, y: 118 }, rect: disc, overControl: true }), true,
    "a finger that moved but lifted over Send's touch box sends");
  assert.equal(releaseSends({ down: { x: 118, y: 118 }, up: { x: 134, y: 118 }, rect: disc, overControl: null }), true,
    "without hit-testing the drawn box still counts");
  assert.equal(releaseSends({ down: { x: 118, y: 118 }, up: { x: 70, y: 118 }, rect: disc, overControl: false }), false,
    "a finger that slid off Send changed its mind");
  assert.equal(releaseSends({ down: { x: 118, y: 118 }, up: { x: 118, y: 60 }, rect: disc, overControl: null }), false,
    "and one that slid off cannot send for want of a hit test");
  const edge = { x: 118 + SEND_TAP_SLOP_PX + 1, y: 118 };
  assert.equal(releaseSends({ down: { x: 118, y: 118 }, up: { x: edge.x + 30, y: edge.y }, rect: disc, overControl: false }), false,
    "travel past the tap slop is judged by where the finger lifted");
  assert.equal(releaseSends({ down: null, up: { x: 500, y: 500 }, rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, overControl: null }), true,
    "a control without layout treats a release as a tap");
});

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This touch test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://composer-send-touch.test";

let browser: Browser | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;

async function fixture(): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/composer-send-touch-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import Composer from "./components/Composer.tsx";
    import { api } from "@polyth/session/web-api";
    import { activateProject, applyProjectUpsert, setModels, startNewSession } from "./store.ts";
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0000000", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    applyProjectUpsert({ id: "polyth", path: "/projects/polyth", name: "Polyth", createdAt: 0, defaults: { isolation: "workspace" } });
    activateProject("polyth");
    setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus 5.5", connected: true }]);
    startNewSession("polyth", { draft: "" });
    createRoot(document.querySelector(".conversation-composer-dock")).render(createElement(Composer));
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "composer-send-touch-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/composer-send-touch-js",
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>${css}</style>
    <script>
      // Sending a new chat's first message creates its session: that request is the send.
      window.__sends = 0;
      window.fetch = async (url, init) => {
        if (init && init.method === "POST" && String(url).endsWith("/api/sessions")) window.__sends += 1;
        return new Response("{}", { status: 404 });
      };
    </script></head>
    <body><div id="root"><div class="app"><div class="focus-conversation">
      <div class="timeline-wrap"><div class="timeline"><div class="msg assistant"><div class="bubble">Hello</div></div></div></div>
      <div class="conversation-composer-dock"></div>
    </div></div></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
}

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const html = await fixture();
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
});

after(async () => {
  await browser?.close();
});

type Probe = { __sends: number };
type Press = { dx: number; dy: number; slide?: { dx: number; dy: number } };

/** A fresh composer holding a draft; returns Send's drawn disc. */
async function draft(text: string): Promise<{ x: number; y: number; size: number }> {
  assert.ok(page);
  await page.goto(`${ORIGIN}/`);
  const editor = page.locator(".composer textarea[data-composer-input]");
  await editor.waitFor();
  await editor.focus();
  for (const [index, line] of text.split("\n").entries()) {
    if (index) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
  // The row engages into the card: measure Send where it comes to rest.
  await page.waitForTimeout(350);
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState !== "finished") animation.finish(); });
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>(".mobile-composer-primary button.send")!;
    if (send.disabled) throw new Error("Send is disabled with a draft in the field");
    const rect = send.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: rect.width };
  });
}

/** One real finger: down, an optional slide, up. Returns how many sends it made. */
async function press(text: string, { dx, dy, slide }: Press): Promise<{ sends: number; overSend: boolean; size: number }> {
  assert.ok(page && cdp);
  const send = await draft(text);
  const x = send.x + dx;
  const y = send.y + dy;
  const overSend = await page.evaluate(([x, y]) => {
    const under = document.elementFromPoint(x!, y!);
    return Boolean(under?.closest(".mobile-composer-primary button.send"));
  }, [x, y]);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(60);
  if (slide) {
    const steps = Math.max(1, Math.ceil(Math.hypot(slide.dx, slide.dy) / 4));
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x + (slide.dx * step) / steps, y: y + (slide.dy * step) / steps }],
      });
      await page.waitForTimeout(16);
    }
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Past the click the browser dispatches after the touch: it must not send again.
  await page.waitForTimeout(400);
  return { sends: await page.evaluate(() => (window as unknown as Probe).__sends), overSend, size: send.size };
}

test("a tap anywhere in Send's touch box sends exactly once", { skip: !CHROME }, async () => {
  // The centre, then the ring between the disc's edge (18px) and the touch box's (22px).
  for (const [dx, dy] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20], [14, 14]] as const) {
    const result = await press("hello", { dx, dy });
    assert.ok(result.size < 44, `the disc is smaller than its touch box (${result.size}px)`);
    assert.equal(result.overSend, true, `(${dx}, ${dy}) from the centre is inside Send's touch box`);
    assert.equal(result.sends, 1, `a tap at (${dx}, ${dy}) from Send's centre sends once (sent ${result.sends})`);
  }
});

test("the draft's length does not change what a tap on Send does", { skip: !CHROME }, async () => {
  for (const text of ["one", "one\ntwo\nthree\nfour\nfive"]) {
    const result = await press(text, { dx: 19, dy: 0 });
    assert.equal(result.sends, 1, `a tap on the ring sends a ${text.split("\n").length}-line draft (sent ${result.sends})`);
  }
});

test("a finger that settles on Send's ring still sends; one that leaves Send does not", { skip: !CHROME }, async () => {
  const settled = await press("hello", { dx: 12, dy: 0, slide: { dx: 7, dy: 0 } });
  assert.equal(settled.sends, 1, `pressed on the disc, lifted on the ring: sends (sent ${settled.sends})`);
  const left = await press("hello", { dx: 0, dy: 0, slide: { dx: -90, dy: -60 } });
  assert.equal(left.sends, 0, `a finger dragged away from Send does not send (sent ${left.sends})`);
});
