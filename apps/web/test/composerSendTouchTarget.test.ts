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
      // A new chat's first message creates its session with the first turn:
      // that request is the send. A kept draft creates the session alone.
      window.__sends = 0;
      window.__drafts = 0;
      window.__sentBody = "";
      window.fetch = async (url, init) => {
        if (init && init.method === "POST" && String(url).endsWith("/api/sessions")) {
          if (String(init.body ?? "").includes('"firstTurn"')) {
            window.__sends += 1;
            window.__sentBody = String(init.body);
          } else window.__drafts += 1;
        }
        return new Response("{}", { status: 404 });
      };
      // What became of a touch on Send once the page's own handlers had run:
      // whether it was withheld from the platform, and whether a click followed.
      window.__touchStarts = [];
      window.__sendClicks = 0;
      window.addEventListener("touchstart", (event) => {
        if (event.target.closest?.("button.send")) window.__touchStarts.push(event.defaultPrevented);
      });
      window.addEventListener("click", (event) => {
        if (event.target.closest?.("button.send")) window.__sendClicks += 1;
      }, true);
      // A heavy page: the main thread stays busy right after Send's own
      // pointerdown handler, so the lift waits in the queue behind it.
      window.__busyAfterDown = 0;
      window.addEventListener("pointerdown", () => {
        const ms = window.__busyAfterDown;
        if (!ms) return;
        const start = performance.now();
        while (performance.now() - start < ms) { /* busy */ }
      });
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

type Probe = {
  __sends: number;
  __drafts: number;
  __busyAfterDown: number;
  __sentBody: string;
  __touchStarts: boolean[];
  __sendClicks: number;
};
type PressOutcome = "send" | "draft" | "nothing";
type Press = {
  dx?: number;
  dy?: number;
  holdMs?: number;
  slide?: { dx: number; dy: number };
  drift?: { dx: number; dy: number };
  /** Keep the page busy this long right after Send's pointerdown. */
  busyMs?: number;
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
  { dx = 0, dy = 0, holdMs, slide, drift, busyMs = 0 }: Press = {},
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

  await page.evaluate((ms) => { (window as unknown as Probe).__busyAfterDown = ms; }, busyMs);
  const started = Date.now();
  if (busyMs) {
    // A digitizer stamps each touch when it happens. CDP runs Input commands
    // one at a time, so without explicit stamps a lift sent while the page is
    // busy would be stamped only once the busy press was acknowledged.
    const pressed = cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }], timestamp: started / 1000 });
    await page.waitForTimeout(duration);
    const lifted = cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: (started + duration) / 1000 });
    await Promise.all([pressed, lifted]);
    await page.waitForTimeout(400);
    return result(send.size, overSend);
  }
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
  return result(send.size, overSend);
}

/** What the press did, read from the requests it made. */
async function result(size: number, overSend: boolean): Promise<PressResult> {
  assert.ok(page);
  const probe = await page.evaluate(() => {
    const { __sends: sends, __drafts: drafts } = window as unknown as Probe;
    (window as unknown as Probe).__busyAfterDown = 0;
    return { sends, drafts };
  });
  const outcome: PressOutcome = probe.drafts >= 1 ? "draft" : probe.sends >= 1 ? "send" : "nothing";
  return { sends: probe.sends, outcome, parked: probe.drafts >= 1, overSend, size };
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

// The lift of a quick tap can wait in the queue behind a busy page (a turn
// streaming in, a long render). Timed by when the handler ran, or by a timer
// that kept the draft while the finger was still down, the tap measured as a
// full hold: Send made a draft instead of sending or starting the chat.
test("touch on Send: a quick tap (60 ms) on a page busy for 700 ms still sends", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 60, busyMs: 700 });
  assert.equal(result.outcome, "send", "the tap's own stamps say 60 ms: it sends");
  assert.equal(result.sends, 1, `it sends once (sent ${result.sends})`);
});

test("touch on Send: a full hold (800 ms) on a page busy for 700 ms keeps a draft", { skip: !CHROME }, async () => {
  const result = await press("hello", { holdMs: 800, busyMs: 700 });
  assert.equal(result.outcome, "draft", "a hold that lasted keeps the draft however busy the page was");
  assert.equal(result.sends, 0, "and sends nothing");
});

// A touch that begins on Send is the page's. Left to the platform, iOS takes a
// tap within 66px of a word the keyboard is still composing for the text even
// when it lands outside the field (WebKit `isNearMarkedText`), and Send sits
// one row under the end of the message. Only a cancelled `touchstart` withholds
// a touch from the platform's own gestures; cancelling `pointerdown` does not.
test("a touch on Send is withheld from the platform's own gestures and sends without a click", { skip: !CHROME }, async () => {
  const result = await press("hello");
  assert.equal(result.sends, 1, `the release sends once (sent ${result.sends})`);
  assert.ok(page);
  const probe = await page.evaluate(() => {
    const { __touchStarts: touchStarts, __sendClicks: clicks } = window as unknown as Probe;
    return { touchStarts, clicks };
  });
  assert.deepEqual(probe.touchStarts, [true], "Send cancelled its touchstart");
  assert.equal(probe.clicks, 0, "no click follows a touch the page took, so none is left to consume");
});

// The word under the finger must not still be marked when the platform decides
// what the tap was: the composer keeps its editor focused through a tap on its
// controls, so nothing else would end the composition before the release.
test("a finger landing on Send commits the word the keyboard is still composing", { skip: !CHROME }, async () => {
  assert.ok(page && cdp);
  await page.goto(`${ORIGIN}/`);
  const editor = page.locator(".composer textarea[data-composer-input]");
  await editor.waitFor();
  await editor.focus();
  await page.keyboard.type("hello ");
  await cdp.send("Input.imeSetComposition", { text: "world", selectionStart: 5, selectionEnd: 5 });
  await page.waitForTimeout(350);
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState !== "finished") animation.finish(); });
  await page.waitForTimeout(50);
  const composing = () => page!.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
    return { open: field.classList.contains("is-composing"), value: field.value, focused: document.activeElement === field };
  });
  assert.deepEqual(await composing(), { open: true, value: "hello world", focused: true }, "the last word is still being composed");
  const send = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(".mobile-composer-primary button.send")!;
    if (button.disabled) throw new Error("Send is disabled over a composing draft");
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [send] });
  await page.waitForTimeout(40);
  assert.deepEqual(await composing(), { open: false, value: "hello world", focused: true },
    "the word is committed while the finger is still down, and the field keeps focus");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  const sent = await page.evaluate(() => {
    const { __sends: sends, __sentBody: body } = window as unknown as Probe;
    return { sends, body };
  });
  assert.equal(sent.sends, 1, `the release sends once (sent ${sent.sends})`);
  assert.ok(sent.body.includes("hello world"), "the sent message carries the composed word");
});
