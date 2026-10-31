// The phone composer's resting row and the keyboard ride, together, on the
// REAL Composer: a tap engages the row into a card (composerMorph.ts) while
// the dock rides the iOS keyboard on the compositor (keyboardRide.ts), the
// WebView resize commits the frame without moving it, and a tap outside rests
// it — the card shrinking with its own rows, the mirror of engaging — into a
// row again where it started. nativeKeyboardMotion.test.ts pins the
// ride on a static engaged card; this is the path a person actually takes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const KEYBOARD = 336;
const HEIGHT = 844;
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: HEIGHT }, isMobile: true, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

async function fixture(): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/composer-keyboard-morph-ride-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import Composer from "./components/Composer.tsx";
    import { api } from "@polyth/session/web-api";
    import { activateProject, applyProjectUpsert, setModels, startNewSession } from "./store.ts";
    import { setNativeKeyboardInset, startMobileViewport } from "./mobileViewport.ts";
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0000000", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    applyProjectUpsert({ id: "polyth", path: "/projects/polyth", name: "Polyth", createdAt: 0, defaults: { isolation: "workspace" } });
    activateProject("polyth");
    setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus 5.5", connected: true }]);
    startNewSession("polyth", { draft: "" });
    window.__viewport = { setNativeKeyboardInset, startMobileViewport };
    createRoot(document.querySelector(".conversation-composer-dock")).render(createElement(Composer));
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "composer-keyboard-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/composer-keyboard-morph-ride-js",
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const messages = Array.from({ length: 30 }, (_, index) =>
    `<div class="msg assistant"><div class="bubble">Message ${index + 1}</div></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>${css}</style>
    <style>#keyboard { position: fixed; inset: auto 0 0; height: ${KEYBOARD}px; transform: translate3d(0, 100%, 0);
        transition: transform 250ms cubic-bezier(0.38, 0.7, 0.125, 1); }</style>
    <script>
      window.fetch = async () => new Response("{}", { status: 404 });
      // The 700 ms landing fallback must not commit while frames are scrubbed.
      const setTimeoutNow = window.setTimeout.bind(window);
      window.__held = [];
      window.setTimeout = (callback, ms, ...args) => {
        if (window.__hold && ms >= 300) { window.__held.push(() => callback(...args)); return -1; }
        return setTimeoutNow(callback, ms, ...args);
      };
      window.__release = () => { window.__hold = false; for (const run of window.__held.splice(0)) run(); };
    </script></head>
    <body><div id="root"><div class="app"><div class="focus-conversation">
      <div class="timeline-wrap"><div class="timeline">${messages}</div></div>
      <div class="conversation-composer-dock"></div>
    </div></div></div><div id="keyboard"></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script>
    <script>
      const timeline = document.querySelector(".timeline");
      let following = true;
      timeline.addEventListener("scroll", () => { following = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2; });
      new ResizeObserver(() => { if (following) timeline.scrollTop = timeline.scrollHeight; }).observe(timeline);
    </script></body></html>`;
}

type Probe = {
  __viewport: { setNativeKeyboardInset(height: number, options?: { followKeyboard?: boolean }): void; startMobileViewport(): void };
  __hold: boolean;
  __release(): void;
  __scrub: Animation[];
};
type Point = { x: number; y: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** A control travels to `end` — never away from it, and never more than 40%
 *  of the way in one 25ms step (the presentation switch used to cover all of
 *  it in one). */
function assertTravels(steps: Sample[], control: "add" | "send" | "line", end: Point, what: string) {
  const total = distance(steps[0]![control], end);
  for (const [index, step] of steps.entries()) {
    if (!index) continue;
    const previous = steps[index - 1]![control];
    assert.ok(distance(step[control], end) <= distance(previous, end) + 0.5, `${control} ${what}, never away (step ${index})`);
    assert.ok(distance(step[control], previous) <= total * 0.4 + 1,
      `${control} ${what}, never jumps (step ${index}: ${distance(step[control], previous).toFixed(1)} of ${total.toFixed(1)}px)`);
  }
}

type Sample = {
  state: string; bottom: number; height: number; keyboard: number;
  /** Add, Send and the editor's first line (its placeholder) from the card's bottom-left corner. */
  add: { x: number; y: number }; send: { x: number; y: number }; line: { x: number; y: number };
  /** The model name from the card's top-left corner, and how visible its line is. */
  model: { x: number; y: number; opacity: number } | null;
};

const sample = (target: Page) => target.evaluate((): Sample => {
  const composer = document.querySelector(".composer")!;
  const card = document.querySelector(".composer-card")!.getBoundingClientRect();
  const name = document.querySelector(".composer-card .model-trigger-name");
  const line = document.querySelector<HTMLElement>(".composer-card .composer-config");
  const rect = name?.getBoundingClientRect();
  const round = (value: number) => Math.round(value * 10) / 10;
  const place = (selector: string) => {
    const control = document.querySelector(selector)!.getBoundingClientRect();
    return { x: round(control.left - card.left), y: round(card.bottom - control.bottom) };
  };
  return {
    add: place(".mobile-composer-cell[data-resting=add]"),
    send: place(".mobile-composer-primary"),
    line: (() => {
      const editor = document.querySelector<HTMLElement>(".composer-card .composer-editor")!;
      const box = editor.getBoundingClientRect();
      const style = getComputedStyle(editor);
      const middle = box.top + parseFloat(style.paddingTop) + (parseFloat(style.lineHeight) || 20) / 2;
      return { x: round(box.left + parseFloat(style.paddingLeft) - card.left), y: round(card.bottom - middle) };
    })(),
    state: composer.classList.contains("composer-collapsed") ? "row" : composer.classList.contains("composer-expanded") ? "card" : "?",
    bottom: round(card.bottom),
    height: round(card.height),
    keyboard: round(document.getElementById("keyboard")!.getBoundingClientRect().top),
    model: rect?.width && line
      ? { x: round(rect.left - card.left), y: round(rect.top - card.top), opacity: Number(getComputedStyle(line).opacity) }
      : null,
  };
});

/** Pause every running animation (morph, ride, the keyboard) on one clock and
 *  step it through the slide. Finished ones stay as they are: scrubbing a
 *  finished entrance replays it. A paused animation scrubbed to its end drops
 *  out of getAnimations(), so the scrubbed set itself is finished after. */
async function scrub(target: Page): Promise<Sample[]> {
  await target.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await target.evaluate(() => {
    const probe = window as unknown as Probe;
    probe.__scrub = document.getAnimations().filter((animation) => animation.playState !== "finished");
    for (const animation of probe.__scrub) animation.pause();
  });
  const steps: Sample[] = [];
  for (let time = 0; time <= 250; time += 25) {
    await target.evaluate((time) => {
      for (const animation of (window as unknown as Probe).__scrub) animation.currentTime = time;
    }, time);
    steps.push(await sample(target));
  }
  await target.evaluate(() => {
    for (const animation of new Set([...(window as unknown as Probe).__scrub, ...document.getAnimations()])) {
      if (animation.playState !== "idle") animation.finish();
    }
  });
  return steps;
}

test("the phone composer rests as a row, engages into a card that rides the keyboard, and rests again where it started", { skip: !CHROME }, async () => {
  assert.ok(page);
  const html = await fixture();
  await page.route("http://composer-keyboard.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://composer-keyboard.test/");
  await page.evaluate(() => (window as unknown as Probe).__viewport.startMobileViewport());
  await page.waitForTimeout(300);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });

  const rest = await sample(page);
  assert.equal(rest.state, "row", "a fresh phone composer rests as one row");
  assert.ok(rest.height <= 64, `the resting row is one control tall (${rest.height}px)`);
  assert.ok(HEIGHT - rest.bottom <= 12, `and sits at the bottom of the screen (${rest.bottom})`);

  // A tap: the editor takes focus and keyboardWillShow follows at once.
  await page.evaluate((KEYBOARD) => {
    const probe = window as unknown as Probe;
    probe.__hold = true;
    document.querySelector<HTMLTextAreaElement>(".composer textarea")!.focus();
    document.getElementById("keyboard")!.style.transform = "translate3d(0, 0, 0)";
    probe.__viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
  }, KEYBOARD);
  const opening = await scrub(page);
  // Add and Send leave their places in the row, not the rail's: they travel
  // there with the card (Send stands ~17px further right in the row).
  // So does the placeholder: it rises out of the row into the opening editor
  // instead of vanishing on the first frame and coming back as it opened.
  assert.deepEqual([opening[0]!.add, opening[0]!.send, opening[0]!.line], [rest.add, rest.send, rest.line],
    "the first engaged frame keeps Add, Send and the placeholder where the row had them");
  for (const control of ["add", "send", "line"] as const) assertTravels(opening, control, opening.at(-1)![control], "travels to its engaged place");
  for (const [index, step] of opening.entries()) {
    const gap = step.keyboard - step.bottom;
    assert.equal(step.state, "card", `the row engages at once (step ${index})`);
    assert.ok(gap >= 0 && gap <= 12, `at ${index * 25}ms the card rides just above the keyboard (gap ${gap}px)`);
    if (index) assert.ok(step.height >= opening[index - 1]!.height - 0.5, `the card only grows (step ${index})`);
  }
  assert.ok(opening.at(-1)!.height >= rest.height + 40, `the row became the engaged card (${rest.height} → ${opening.at(-1)!.height}px)`);
  // The model line appears where it settles and stays there: it is invisible
  // while the card is too short to hold it at the top edge, and once it shows
  // it keeps its place from the card's top-left corner. Held at the bottom
  // edge, it used to slide down ~25px against the rising edge after it came
  // into view.
  const settledModel = opening.at(-1)!.model;
  assert.ok(settledModel && settledModel.opacity === 1, "the engaged card shows its model line");
  let shown = 0;
  for (const [index, step] of opening.entries()) {
    if (!step.model || step.model.opacity < 0.02) continue;
    shown += 1;
    assert.ok(Math.abs(step.model.y - settledModel.y) <= 0.5 && Math.abs(step.model.x - settledModel.x) <= 0.5,
      `at ${index * 25}ms the visible model name keeps its place from the card's corner (${step.model.x},${step.model.y} vs ${settledModel.x},${settledModel.y})`);
  }
  assert.ok(shown >= 5, `the model line fades in during the morph, not at its end (${shown} visible steps)`);

  // The WebView takes the keyboard's size after the slide: the landing must
  // not move the card on any frame.
  const landed = opening.at(-1)!.bottom;
  await page.evaluate(() => {
    const frames: number[] = [];
    const card = document.querySelector(".composer-card")!;
    const record = () => {
      frames.push(card.getBoundingClientRect().bottom);
      if (frames.length < 20) requestAnimationFrame(record);
    };
    window.addEventListener("resize", () => requestAnimationFrame(record), { once: true });
    (window as unknown as { __landing: number[] }).__landing = frames;
    document.getElementById("keyboard")!.style.display = "none";
  });
  await page.setViewportSize({ width: 390, height: HEIGHT - KEYBOARD });
  await page.waitForTimeout(500);
  const landing = await page.evaluate(() => (window as unknown as { __landing: number[] }).__landing);
  assert.ok(landing.length >= 10, `the landing was sampled (${landing.length} frames)`);
  for (const [index, bottom] of landing.entries()) {
    assert.ok(Math.abs(bottom - landed) <= 1, `frame ${index} after the WebView resize keeps the card in place (${landed} → ${bottom})`);
  }
  await page.evaluate(() => (window as unknown as Probe).__release());

  // A tap on the transcript: the click rests the composer, the editor blurs,
  // keyboardWillHide follows and the WebView grows back.
  await page.evaluate(() => {
    const probe = window as unknown as Probe;
    probe.__hold = true;
    const keyboard = document.getElementById("keyboard")!;
    keyboard.style.transition = "none";
    keyboard.style.display = "";
    keyboard.style.transform = "translate3d(0, 0, 0)";
    keyboard.getBoundingClientRect();
    keyboard.style.transition = "";
    document.querySelector(".timeline > :nth-last-child(3) .bubble")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    keyboard.style.transform = "translate3d(0, 100%, 0)";
    probe.__viewport.setNativeKeyboardInset(0, { followKeyboard: true });
  });
  await page.setViewportSize({ width: 390, height: HEIGHT });
  // The last step is the morph's paused end, which no longer holds the card:
  // the finish event presents the row there (below, `rested`).
  const closing = (await scrub(page)).slice(0, -1);
  await page.evaluate(() => (window as unknown as Probe).__release());
  await page.waitForTimeout(300);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  const rested = await sample(page);
  assert.equal(rested.state, "row");
  assert.ok(Math.abs(rested.height - rest.height) <= 1, `the row is its resting size again (${rest.height} → ${rested.height}px)`);
  assert.ok(Math.abs(rested.bottom - rest.bottom) <= 1, `and back where it rested (${rest.bottom} → ${rested.bottom})`);
  // Resting mirrors engaging: the card keeps its own rows while it shrinks —
  // the row used to be presented on the first frame, floating in a tall
  // empty card, the model line and editor gone at once — and the model line
  // fades out where it is before the falling top edge reaches it.
  const engaged = closing[0]!;
  for (const [index, step] of closing.entries()) {
    assert.equal(step.state, "card", `the card keeps its rows while it shrinks (step ${index})`);
    if (!index) continue;
    const previous = closing[index - 1]!;
    assert.ok(step.bottom >= previous.bottom - 0.5, `the composer only moves down (step ${index})`);
    assert.ok(step.height <= previous.height + 0.5, `the card only shrinks (step ${index})`);
    if (step.model && step.model.opacity >= 0.02) {
      assert.ok(Math.abs(step.model.y - engaged.model!.y) <= 1 && step.model.x === engaged.model!.x,
        `at ${index * 25}ms the visible model name keeps its place from the card's corner (${step.model.x},${step.model.y})`);
    }
  }
  for (const control of ["add", "send", "line"] as const) assertTravels(closing, control, rested[control], "glides toward its place in the row");
  assert.ok(!closing.at(-1)!.model || closing.at(-1)!.model!.opacity < 0.02, "the model line is gone before the row is presented");
  // …so presenting the row moves neither Add, nor Send, nor the placeholder,
  // which travelled down into the row while the editor closed around it (it
  // used to be clipped away, the card left empty until the row appeared).
  const last = closing.at(-1)!;
  assert.ok(Math.abs(last.height - rested.height) <= 1, `the card has shrunk to the row before it is presented (${last.height}px)`);
  for (const control of ["add", "send", "line"] as const) {
    assert.ok(Math.abs(last[control].x - rested[control].x) <= 0.5 && Math.abs(last[control].y - rested[control].y) <= 0.5,
      `${control} is where the row has it when the row is presented (${JSON.stringify(last[control])} vs ${JSON.stringify(rested[control])})`);
  }

  // A tap back on the editor half-way through resting re-engages from where
  // the card, its controls and the model line are — the model line used to
  // blank and fade in anew. Both morphs are held still at the switch.
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")!.focus());
  await page.waitForTimeout(400);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  const holdRunning = (time: number) => page!.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      if (animation.playState !== "running") continue;
      animation.pause();
      animation.currentTime = time;
    }
  }, time);
  await page.evaluate(() => {
    document.querySelector(".timeline > :nth-last-child(3) .bubble")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await holdRunning(40);
  const cut = await sample(page);
  assert.ok(cut.model && cut.model.opacity > 0.05 && cut.model.opacity < 0.95 && cut.height < engaged.height - 5,
    `the rest is caught half-way (${cut.height}px, model ${cut.model?.opacity})`);
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")!.focus());
  await holdRunning(0);
  const resumed = await sample(page);
  assert.equal(resumed.state, "card");
  assert.ok(Math.abs(resumed.height - cut.height) <= 1, `the card re-engages from its height (${cut.height} → ${resumed.height}px)`);
  assert.ok(Math.abs(resumed.model!.opacity - cut.model.opacity) <= 0.05, `and the model line from its opacity (${cut.model.opacity} → ${resumed.model!.opacity})`);
  for (const control of ["add", "send", "line"] as const) {
    assert.ok(Math.abs(resumed[control].x - cut[control].x) <= 1 && Math.abs(resumed[control].y - cut[control].y) <= 1,
      `and ${control} from its place (${JSON.stringify(cut[control])} → ${JSON.stringify(resumed[control])})`);
  }
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
});
