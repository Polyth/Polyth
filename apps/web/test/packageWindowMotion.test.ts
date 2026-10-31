// Desktop package window motion, measured in a real browser (skipped without
// one). A window comes out of its launcher rail and goes back into it. These
// tests freeze the real CSS animations at exact progress points and assert
// what keeps that smooth: the floating window moves on compositor-only
// properties, from the rail's side and without overshoot; docked content is
// laid out once instead of on every frame; every part of a window runs on one
// clock; and reduced motion switches all of it off.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const WIDE = { width: 1680, height: 1000 };
/** Inside the 961–1400px band, where the launcher cluster docks and undocks. */
const BAND = { width: 1200, height: 900 };
const RAIL_W = 480;
/** What the compositor animates without the main thread. */
const COMPOSITED = new Set(["transform", "opacity"]);
const FLOATING = "rail rail-workspace rail-dynamic";

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";
let exitHoldMs = 0;

before(async () => {
  if (!CHROME) return;
  const [tokens, styles, content, stack, rail] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/styles.css"),
    read("../src/moduleContent.css"),
    read("../src/stackNavigation.css"),
    read("../src/components/ContextRail.tsx"),
  ]);
  // styles.css @imports tokens/fonts by URL; inline the tokens instead.
  css = [tokens, styles.replace(/@import[^;]+;/g, ""), content, stack].join("\n");
  exitHoldMs = Number(rail.match(/const PANE_EXIT_FALLBACK_MS = (\d+);/)?.[1]);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // Motion stays ON: this suite measures the animations themselves.
  page = await browser.newPage({ viewport: WIDE });
});

after(async () => {
  await browser?.close();
});

interface Shell {
  pane: string;
  exiting?: boolean;
  dir?: "ltr" | "rtl";
  /** Where the person moved a floating window. */
  at?: { x: number; y: number };
  app?: string;
  split?: boolean;
  viewport?: { width: number; height: number };
}

/** ContextRail's DOM: Chat, then the rail host with the window and its launcher strip. */
async function load({ pane, exiting = false, dir = "ltr", at = { x: 0, y: 0 }, app = "app", split = false, viewport = WIDE }: Shell) {
  assert.ok(page);
  await page.setViewportSize(viewport);
  const motion = exiting ? "exiting" : "open";
  await page.setContent(`
    <style>${css}</style>
    <style>html, body { margin: 0; }</style>
    <div class="${app}"${split ? ' data-workspace-focus="true" data-workspace-split="true"' : ""}>
      <div class="app-shell">
        <main class="workspace"></main>
        <aside class="railbar${exiting ? "" : " railbar-open"}${pane.split(" ").includes("rail-dynamic") ? " railbar-dynamic" : ""}" data-rail-motion="${motion}" id="host">
          <div class="${pane}${exiting ? " rail-exiting" : ""}" id="pkg" data-rail-motion="${motion}"
            style="--rail-w: ${RAIL_W}px; --package-window-h: 600px; --package-window-x: ${at.x}px; --package-window-y: ${at.y}px">
            <section class="module-view module-view--rail" id="content"><div class="module-view-body">Package</div></section>
          </div>
          <div class="rail-icon-col plugin-strip customize-zone" id="strip">
            <div class="rail-icon-scroll"><button class="rail-icon strip-btn active" aria-label="Git">G</button></div>
          </div>
        </aside>
      </div>
    </div>`);
  await page.evaluate((direction) => {
    document.documentElement.dir = direction;
    // Re-mapping logical borders starts transitions; land them as if the
    // document had loaded in this direction.
    for (const transition of document.getAnimations()) {
      if (transition instanceof CSSTransition) transition.finish();
    }
  }, dir);
}

interface Motion { name: string; duration: number; easing: string; fill: string; properties: string[] }

/** Every CSS animation running on the element `selector` matches. */
const motionsOf = (selector: string): Promise<Motion[]> => page!.evaluate((sel) => {
  const el = document.querySelector(sel)!;
  return document.getAnimations()
    .filter((animation) => animation instanceof CSSAnimation && (animation.effect as KeyframeEffect | null)?.target === el)
    .map((animation) => {
      const effect = animation.effect as KeyframeEffect;
      const frames = effect.getKeyframes();
      const properties = new Set<string>();
      for (const frame of frames) {
        for (const key of Object.keys(frame)) {
          if (!["offset", "computedOffset", "easing", "composite"].includes(key)) properties.add(key);
        }
      }
      return {
        name: (animation as CSSAnimation).animationName,
        duration: Number(effect.getComputedTiming().duration),
        easing: String(frames[0]?.easing ?? ""),
        fill: String(effect.getComputedTiming().fill),
        properties: [...properties],
      };
    });
}, selector);

/** Pause every animation on `selector` at `fraction` of its own duration. */
async function freeze(selector: string, fraction: number) {
  await page!.evaluate(([sel, f]) => {
    const el = document.querySelector(sel as string)!;
    // Keep the element's animations: one frozen at its end without a forwards
    // fill leaves document.getAnimations(), and later freezes still need it.
    const held = ((window as unknown as { heldAnimations?: WeakMap<Element, Animation[]> }).heldAnimations ??= new WeakMap());
    let animations = held.get(el);
    if (!animations) {
      animations = document.getAnimations()
        .filter((animation) => animation instanceof CSSAnimation && (animation.effect as KeyframeEffect | null)?.target === el);
      held.set(el, animations);
    }
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * Number(f);
    }
  }, [selector, fraction] as const);
}

const placement = (selector: string) => page!.evaluate((sel) => {
  const el = document.querySelector(sel)!;
  const r = el.getBoundingClientRect();
  const matrix = new DOMMatrix(getComputedStyle(el).transform);
  return {
    left: r.left, right: r.right, top: r.top, width: r.width,
    opacity: Number(getComputedStyle(el).opacity),
    scaleX: matrix.a, scaleY: matrix.d, translateX: matrix.m41,
  };
}, selector);

const token = (name: string) => page!.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const millis = (value: string) => (value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000);
const curve = (value: string) => value.replace(/\s+/g, "");

/** Which side of the window its launcher strip is on: 1 = inline-end in LTR (right). */
async function stripSide(): Promise<number> {
  const [pkg, strip] = [await placement("#pkg"), await placement("#strip")];
  return Math.sign((strip.left + strip.right) / 2 - (pkg.left + pkg.right) / 2);
}

test("a floating window glides out of its launcher rail on compositor-only properties", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load({ pane: FLOATING });
  const [open, ...others] = await motionsOf("#pkg");
  assert.equal(others.length, 0);
  assert.equal(open?.name, "rail-window-open-dynamic");
  assert.equal(open.duration, millis(await token("--motion-window")), "it runs on the window clock");
  assert.equal(curve(open.easing), curve(await token("--motion-window-ease")));
  assert.deepEqual(open.properties.filter((property) => !COMPOSITED.has(property)), [],
    "transform and opacity only: the compositor keeps it at frame rate while the package mounts");
  assert.deepEqual(await motionsOf("#content"), [], "frame, glass and content arrive as one piece");
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-strip-seam", open.duration]],
    "the launcher seam settles on the same clock");
  const hostDurations: string = await page.evaluate(() => getComputedStyle(document.querySelector("#host")!).transitionDuration);
  for (const duration of hostDurations.split(",")) {
    assert.equal(Math.round(millis(duration.trim())), open.duration, "the rail host squares its corners off in step");
  }

  const travel = Number.parseFloat(await token("--motion-window-travel"));
  await freeze("#pkg", 1);
  const rest = await placement("#pkg");
  assert.equal(await stripSide(), 1, "the launcher strip sits at the window's inline end");
  const offsets: number[] = [];
  for (const fraction of [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1]) {
    await freeze("#pkg", fraction);
    const now = await placement("#pkg");
    offsets.push(now.left - rest.left);
    assert.equal(Math.round(now.top - rest.top), 0, "it moves along the rail's axis only");
    assert.equal(Math.round(now.width), Math.round(rest.width), "at its full size the whole way: nothing re-lays out");
  }
  assert.equal(Math.round(offsets[0]!), travel, "it starts the travel back toward the rail");
  for (let index = 1; index < offsets.length; index++) {
    assert.ok(offsets[index]! <= offsets[index - 1]! + 0.01, `it only ever moves toward its place: ${offsets.join(", ")}`);
    assert.ok(offsets[index]! >= -0.01, "it never overshoots its place");
  }
  assert.ok(offsets[3]! < travel / 2, "a long ease-out: most of the way out in the first fifth, then it settles");
  assert.equal(Math.round(offsets.at(-1)!), 0);

  await freeze("#pkg", 0);
  assert.equal((await placement("#pkg")).opacity, 0, "it fades up out of the rail");
  await freeze("#pkg", 0.5);
  assert.equal((await placement("#pkg")).opacity, 1, "fully there well before it settles");

  // Early on part of the window is still inside the rail, under the strip.
  await freeze("#pkg", 0.05);
  const early = await page.evaluate(() => {
    const strip = document.querySelector("#strip")!.getBoundingClientRect();
    const pkg = document.querySelector("#pkg")!.getBoundingClientRect();
    const hit = document.elementFromPoint(strip.left + strip.width / 2, pkg.top + pkg.height / 2);
    return { overlap: pkg.right - strip.left, topmost: hit?.closest("#strip, #pkg")?.id ?? null };
  });
  assert.ok(early.overlap > 1, "the window starts partly inside the rail");
  assert.equal(early.topmost, "strip", "…where the launcher strip covers it");
});

test("closing takes the same path back into the rail, quicker and accelerating, inside the host's hold", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load({ pane: FLOATING, exiting: true });
  const [exit, ...others] = await motionsOf("#pkg");
  assert.equal(others.length, 0);
  assert.equal(exit?.name, "rail-window-exit-dynamic");
  assert.equal(exit.duration, millis(await token("--motion-window-exit")));
  assert.equal(curve(exit.easing), curve(await token("--motion-window-exit-ease")));
  assert.ok(exit.duration < millis(await token("--motion-window")), "leaving is quicker than arriving");
  assert.ok(exit.duration + 34 <= exitHoldMs, "ContextRail's fallback never cuts the exit short");
  assert.equal(exit.fill, "both", "it holds its end state until the host unmounts it");
  assert.deepEqual(exit.properties.filter((property) => !COMPOSITED.has(property)), []);
  assert.deepEqual(await motionsOf("#content"), []);
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-seam-out", exit.duration]]);

  const travel = Number.parseFloat(await token("--motion-window-travel"));
  await freeze("#pkg", 0);
  const rest = await placement("#pkg");
  assert.equal(rest.opacity, 1);
  await freeze("#pkg", 0.25);
  const quarter = await placement("#pkg");
  await freeze("#pkg", 1);
  const end = await placement("#pkg");
  assert.ok(quarter.left - rest.left > 0, "it starts moving at once");
  assert.ok(quarter.left - rest.left < travel / 4, "…and accelerates away rather than jumping");
  assert.equal(Math.round(end.left - rest.left), travel, "it ends back inside the rail");
  assert.equal(end.opacity, 0);
});

test("a window the person moved glides from where it rests", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load({ pane: FLOATING });
  await freeze("#pkg", 1);
  const home = await placement("#pkg");
  await load({ pane: FLOATING, at: { x: -240, y: 36 } });
  const travel = Number.parseFloat(await token("--motion-window-travel"));
  await freeze("#pkg", 1);
  const rest = await placement("#pkg");
  assert.equal(Math.round(rest.left - home.left), -240);
  assert.equal(Math.round(rest.top - home.top), 36);
  await freeze("#pkg", 0);
  const start = await placement("#pkg");
  assert.equal(Math.round(start.left - rest.left), travel);
  assert.equal(Math.round(start.top - rest.top), 0);
});

test("the travel follows the launcher rail into right-to-left layouts", { skip: !CHROME }, async () => {
  assert.ok(page);
  const travel = await (async () => { await load({ pane: FLOATING }); return Number.parseFloat(await token("--motion-window-travel")); })();
  for (const dir of ["ltr", "rtl"] as const) {
    for (const exiting of [false, true]) {
      await load({ pane: FLOATING, dir, exiting });
      await freeze("#pkg", exiting ? 0 : 1);
      const rest = await placement("#pkg");
      const side = await stripSide();
      assert.equal(side, dir === "ltr" ? 1 : -1, `${dir}: the strip sits at the inline end`);
      await freeze("#pkg", exiting ? 1 : 0);
      const away = await placement("#pkg");
      assert.equal(Math.round(away.left - rest.left), side * travel, `${dir} ${exiting ? "exit" : "entry"}: the far end of the travel is inside the rail`);
    }
  }
});

test("a docked window grows out of the seam while its content keeps its final width", { skip: !CHROME }, async () => {
  assert.ok(page);
  // A contextual panel docks inside the rail host.
  await load({ pane: "rail" });
  const [frame] = await motionsOf("#pkg");
  const [content] = await motionsOf("#content");
  const windowMs = millis(await token("--motion-window"));
  assert.equal(frame?.name, "rail-window-open-inline");
  assert.equal(frame.duration, windowMs);
  assert.equal(content?.name, "rail-window-content-in");
  assert.equal(content.duration, windowMs, "frame and content share one clock");
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-seam-in", windowMs]]);
  const samples: { frame: number; content: number; opacity: number }[] = [];
  for (const fraction of [0.1, 0.5, 1]) {
    await freeze("#pkg", fraction);
    await freeze("#content", fraction);
    const [pkg, body] = [await placement("#pkg"), await placement("#content")];
    samples.push({ frame: pkg.width, content: body.width, opacity: body.opacity });
  }
  assert.ok(samples[0]!.frame < samples[1]!.frame && samples[1]!.frame < samples[2]!.frame, "the frame grows");
  for (const sample of samples) {
    assert.equal(Math.round(sample.content), RAIL_W, "content is laid out once at its final width, never per frame");
  }
  assert.ok(samples[0]!.opacity > 0.5, "content shows from the first stretch: no empty frame slides out first");
  assert.equal(await stripSide(), 1);

  await load({ pane: "rail", exiting: true });
  const exitMs = millis(await token("--motion-window-exit"));
  assert.deepEqual((await motionsOf("#pkg")).map((motion) => [motion.name, motion.duration]), [["rail-window-exit-inline", exitMs]]);
  assert.deepEqual((await motionsOf("#content")).map((motion) => [motion.name, motion.duration]), [["rail-window-content-out", exitMs]]);
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-seam-out", exitMs]]);
  await freeze("#pkg", 0.5);
  await freeze("#content", 0.5);
  assert.equal(Math.round((await placement("#content")).width), RAIL_W, "it leaves at its final width too");
});

test("the desktop layer fades over a short travel, without scaling its text", { skip: !CHROME }, async () => {
  assert.ok(page);
  const travel = await (async () => { await load({ pane: FLOATING }); return Number.parseFloat(await token("--motion-window-travel")); })();
  for (const exiting of [false, true]) {
    await load({ pane: "rail rail-workspace rail-fullscreen", exiting });
    const [motion] = await motionsOf("#pkg");
    assert.equal(motion?.name, exiting ? "rail-window-exit-layer" : "rail-window-open-layer");
    assert.equal(motion.duration, millis(await token(exiting ? "--motion-window-exit" : "--motion-window")));
    assert.deepEqual(motion.properties.filter((property) => !COMPOSITED.has(property)), []);
    await freeze("#pkg", exiting ? 1 : 0);
    const far = await placement("#pkg");
    assert.equal(far.scaleX, 1, "no scale: text stays crisp while it moves");
    assert.equal(far.scaleY, 1);
    assert.equal(Math.round(far.translateX), travel / 4, "it travels a quarter of a window's distance from the rail");
    assert.equal(far.opacity, 0);
  }
});

test("in the tablet band the launcher cluster docks and undocks on the window clock", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load({ pane: "rail", viewport: BAND });
  const windowMs = millis(await token("--motion-window"));
  assert.deepEqual((await motionsOf("#host")).map((motion) => [motion.name, motion.duration]), [["rail-host-dock", windowMs]]);
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-strip-dock", windowMs]]);
  await load({ pane: "rail", viewport: BAND, exiting: true });
  const exitMs = millis(await token("--motion-window-exit"));
  assert.deepEqual((await motionsOf("#host")).map((motion) => [motion.name, motion.duration]), [["rail-host-undock", exitMs]]);
  assert.deepEqual((await motionsOf("#strip")).map((motion) => [motion.name, motion.duration]), [["rail-strip-undock", exitMs]]);
});

test("a focused split brings the work surface in from its launcher rail", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const swapped of [false, true]) {
    for (const dir of ["ltr", "rtl"] as const) {
      const app = `app workspace-focus-mode${swapped ? " workspace-focus-swap" : ""}`;
      await load({ pane: "rail rail-workspace rail-pinned", app, split: true, dir });
      const [motion] = await motionsOf("#pkg");
      assert.equal(motion?.name, "focused-split-enter");
      assert.equal(motion.duration, millis(await token("--motion-window")));
      await freeze("#pkg", 1);
      const side = await stripSide();
      await freeze("#pkg", 0);
      const start = (await placement("#pkg")).translateX;
      assert.equal(Math.abs(Math.round(start)), 8);
      assert.equal(Math.sign(start), side, `${swapped ? "exchanged" : "beside Chat"}, ${dir}: it starts displaced toward its rail`);
    }
  }
});

test("reduced motion and the in-app switches stop every part of the window", { skip: !CHROME }, async () => {
  assert.ok(page);
  try {
    for (const mode of ["prefers-reduced-motion", "reduce-animations", "desktop-low-resource"] as const) {
      for (const pane of [FLOATING, "rail", "rail rail-workspace rail-fullscreen"]) {
        for (const exiting of [false, true]) {
          await page.emulateMedia({ reducedMotion: mode === "prefers-reduced-motion" ? "reduce" : "no-preference" });
          await load({ pane, exiting });
          await page.evaluate((which) => {
            if (which === "reduce-animations") document.documentElement.dataset.reduceAnimations = "true";
            if (which === "desktop-low-resource") document.body.dataset.desktopLowResource = "true";
          }, mode);
          const running: string[] = await page.evaluate(() => document.getAnimations().map((animation) => (animation as CSSAnimation).animationName));
          assert.deepEqual(running, [], `${mode}: ${pane}${exiting ? " (closing)" : ""} does not animate`);
          const name: string = await page.evaluate(() => getComputedStyle(document.querySelector("#pkg")!).animationName);
          assert.equal(name, "none", "ContextRail reads this to release the exit at once");
        }
      }
    }
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});
