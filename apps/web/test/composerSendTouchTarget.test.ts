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
      window.__parked = false;
      window.fetch = async (url, init) => {
        if (init && init.method === "POST" && String(url).endsWith("/api/sessions")) window.__sends += 1;
        return new Response("{}", { status: 404 });
      };
      new MutationObserver(() => {
        if (document.querySelector(".mobile-composer-primary button.send[data-parked]")) {
          window.__parked = true;
        }
      }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-parked"] });
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

type Probe = { __sends: number; __parked?: boolean };
type PressOutcome = "send" | "draft" | "nothing";
type Press = {
  dx?: number;
  dy?: number;
  holdMs?: number;
  slide?: { dx: number; dy: number };
  drift?: { dx: number; dy: number };
};
type PressResult = {
  sends: number;
  outcome: PressOutcome;
  parked: boolean;
  overSend: boolean;
  size: number;
};

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

/** One real finger: down, an optional slide or drift, up. Returns how many sends it made and the classified outcome. */
async function press(
  text: string,
  { dx = 0, dy = 0, holdMs, slide, drift }: Press = {},
): Promise<PressResult> {
  assert.ok(page && cdp);
  const send = await draft(text);
  const x = send.x + dx;
  const y = send.y + dy;
  const move = drift ?? slide;
  const endX = x + (move?.dx ?? 0);
  const endY = y + (move?.dy ?? 0);
  const duration = holdMs ?? (move ? 100 : 60);

  const overSend = await page.evaluate(([px, py]) => {
    const under = document.elementFromPoint(px!, py!);
    return Boolean(under?.closest(".mobile-composer-primary button.send"));
  }, [endX, endY]);

  const started = Date.now();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });

  if (move) {
    const steps = Math.max(1, Math.min(10, Math.ceil(Math.hypot(move.dx, move.dy) / 3)));
    const stepDelay = Math.min(30, Math.max(10, Math.floor((duration * 0.5) / steps)));
    for (let step = 1; step <= steps; step += 1) {
      await page.waitForTimeout(stepDelay);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (move.dx * step) / steps, y: y + (move.dy * step) / steps }],
      });
    }
  }

  const elapsed = Date.now() - started;
  const remaining = duration - elapsed;
  if (remaining > 0) {
    await page.waitForTimeout(remaining);
  }

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Past the click the browser dispatches after the touch: it must not send again.
  await page.waitForTimeout(400);

  const probe = await page.evaluate(() => {
    const parked = Boolean((window as unknown as Probe).__parked
      || document.querySelector(".mobile-composer-primary button.send[data-parked]"));
    const sends = (window as unknown as Probe).__sends;
    const outcome: PressOutcome = parked ? "draft" : sends >= 1 ? "send" : "nothing";
    return { sends, parked, outcome };
  });

  return {
    sends: probe.sends,
    outcome: probe.outcome,
    parked: probe.parked,
    overSend,
    size: send.size,
  };
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

test("touch on Send: quick tap (60 ms) sends", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 60 });
  assert.notEqual(result.outcome, "nothing", "quick tap must not end as nothing");
  assert.equal(result.outcome, "send", "quick tap sends");
});

// A finger rolls while it holds. With panning allowed on Send, a 20 px roll
// was taken for a scroll and the browser cancelled the press: the message was
// neither sent nor kept (measured with `touch-action: manipulation`).
test("touch on Send: hold 300 ms with a 20 px drift still over Send sends", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 300, drift: { dx: 0, dy: -20 } });
  assert.equal(result.overSend, true, "the drift ends still over Send");
  assert.notEqual(result.outcome, "nothing", "a short hold that drifted must not end as nothing");
  assert.equal(result.outcome, "send", "a short hold that drifted sends");
});

test("touch on Send: hold 300 ms with no drift sends", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 300 });
  assert.notEqual(result.outcome, "nothing", "300 ms hold without drift must not end as nothing");
  assert.equal(result.outcome, "send", "300 ms hold without drift sends");
});

test("touch on Send: hold 800 ms keeps a draft", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 800 });
  assert.notEqual(result.outcome, "nothing", "800 ms hold must not end as nothing");
  assert.equal(result.outcome, "draft", "800 ms hold keeps a draft");
});

test("touch on Send: hold 800 ms with a 20 px drift keeps a draft", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 800, drift: { dx: 0, dy: -20 } });
  assert.equal(result.overSend, true, "the drift ends still over Send");
  assert.notEqual(result.outcome, "nothing", "a full hold that drifted must not end as nothing");
  assert.equal(result.outcome, "draft", "a full hold that drifted keeps a draft");
});
