import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
// The iOS keyboard's slide as the CSS token states it.
const KEYBOARD_EASE = "cubic-bezier(0.38, 0.7, 0.125, 1)";
const KEYBOARD = 336;

test("the composer rides the native keyboard on the compositor; the frame never transitions", async () => {
  const [tokens, viewportCss, styles, viewportTs, bridge, bootstrap] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/mobileViewport.css"),
    read("../src/styles.css"),
    read("../src/mobileViewport.ts"),
    read("../../mobile/src/nativeBridge.ts"),
    read("../src/bootstrap.tsx"),
  ]);
  // The native app's frame is its WebView's dynamic viewport; a browser's never is.
  assert.match(bootstrap, /startMobileViewport\(\{ nativeFrame: isNativeMobile\(\) \}\);/);
  assert.match(tokens, /--motion-keyboard: 250ms;/);
  assert.match(tokens, /--motion-keyboard-ease: cubic-bezier\(0\.38, 0\.7, 0\.125, 1\);/);
  // Easing html/body/#root heights re-laid and restyled the whole app every
  // frame of the slide; the move marker on <html> restyled every element twice.
  assert.doesNotMatch(viewportCss, /data-keyboard-motion/);
  assert.doesNotMatch(viewportCss, /transition(-property)?:[^;]*(?<![-\w])(height|padding-bottom)\b/);
  assert.doesNotMatch(viewportTs, /dataset\.keyboardMotion/);
  assert.match(viewportTs, /from "\.\/keyboardRide\.ts"/);
  // Rules on <html>/<body> that react to the body's keyboard state restyle
  // every element; the chain's lower edge is published, not derived.
  assert.doesNotMatch(viewportCss + styles, /:has\(body\[data-keyboard/);
  assert.doesNotMatch(viewportCss, /body:not\(\.desktop-app\)\[data-keyboard="open"\](,|\s*\{)[^}]*height/);
  // Restoring a switched-off entrance replayed it on every keyboard close.
  const openDock = viewportCss.match(/body\[data-keyboard="open"\] \.conversation-composer-dock \{[^}]*\}/)?.[0] ?? "";
  assert.match(openDock, /animation-duration: 0s;/);
  assert.doesNotMatch(openDock, /animation-name/);
  // Resting row ⇄ engaged card keeps its content at the bottom edge, both ways…
  assert.match(styles, /\.composer-mobile\[data-composer-morph\] \.composer-card \{ overflow: clip; justify-content: flex-end; \}/);
  // …and its rows keep their settled size while the top edge moves over them.
  assert.match(styles, /\.composer-mobile\[data-composer-morph\] \.composer-card > \* \{\s*flex-grow: 0;\s*flex-shrink: 0;\s*\}/);
  // Only the iOS plugin defers its WebView resize until after the slide.
  assert.match(bridge, /const followKeyboard = Capacitor\.getPlatform\(\) === "ios";/);
  assert.match(bridge, /callbacks\.setKeyboardInset\(keyboardHeight, \{ followKeyboard \}\)/);
  assert.match(bridge, /callbacks\.setKeyboardInset\(0, \{ followKeyboard \}\)/);
});

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

async function fixture(): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/native-keyboard-motion-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const viewport = (await build({
    stdin: {
      contents: 'import { setNativeKeyboardInset, setNativeKeyboardMotion, startMobileViewport } from "./mobileViewport.ts"; import { springEasing } from "./keyboardMotion.ts"; window.__viewport = { setNativeKeyboardInset, setNativeKeyboardMotion, startMobileViewport, springEasing };',
      resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
      loader: "ts",
    },
    bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent",
  })).outputFiles[0]!.text;
  const glyph = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor"/></svg>';
  // Long enough to scroll: the reader at the tail follows the composer up.
  const messages = Array.from({ length: 40 }, (_, index) =>
    `<div class="msg assistant"><div class="bubble">Message ${index + 1}</div></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>${css}</style>
    <style>#keyboard { position: fixed; inset: auto 0 0; height: ${KEYBOARD}px; transform: translate3d(0, 100%, 0);
        transition: transform 250ms ${KEYBOARD_EASE}; }</style></head>
    <body><div id="root"><div class="app"><div class="focus-conversation">
      <div class="timeline-wrap"><div class="timeline">${messages}</div></div>
      <div class="conversation-composer-dock">
        <div class="composer composer-simple composer-chat composer-focus-light composer-mobile composer-expanded">
          <div class="composer-card glass-dock">
            <div class="composer-config composer-config-row"></div>
            <div class="composer-input"><textarea class="composer-editor" rows="1"></textarea></div>
            <div class="composer-rail"><span class="composer-leading-zone"></span><span class="composer-execution"></span>
              <div class="composer-actions"><span class="composer-primary"><button class="send" aria-label="Send">${glyph}</button></span></div></div>
          </div>
        </div>
      </div>
    </div></div></div><div id="keyboard"></div><script>${viewport}</script>
    <script>
      // Timeline's follow, as in the app: a reader at the tail stays there
      // when the scrollport resizes (delivered before keyboardRide's observer).
      const timeline = document.querySelector(".timeline");
      let following = true;
      timeline.addEventListener("scroll", () => { following = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 2; });
      new ResizeObserver(() => { if (following) timeline.scrollTop = timeline.scrollHeight; }).observe(timeline);
    </script></body></html>`;
}

type ViewportProbe = {
  setNativeKeyboardInset(height: number, options?: { followKeyboard?: boolean }): void;
  setNativeKeyboardMotion(motion: {
    durationMs: number; animationDurationMs: number; sentAt: number;
    spring: { mass: number; stiffness: number; damping: number; initialVelocity: number };
  }): void;
  springEasing(spring: { mass: number; stiffness: number; damping: number; initialVelocity: number }, durationMs: number): string;
  startMobileViewport(options?: { nativeFrame?: boolean }): void;
};

/** `nativeFrame`: the page runs as the native app does, its frame the
 *  WebView's own dynamic viewport (the viewport resize stands for the
 *  plugin's WebView resize). Without it, the pixel frame a browser or a
 *  native shell whose dvh does not follow its WebView publishes. */
async function open(name: string, nativeFrame = false): Promise<Page> {
  assert.ok(page);
  const html = await fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`http://${name}.test/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://${name}.test/`);
  await page.evaluate((nativeFrame) => {
    (window as unknown as { __viewport: ViewportProbe }).__viewport.startMobileViewport({ nativeFrame });
    const timeline = document.querySelector<HTMLElement>(".timeline")!;
    timeline.scrollTop = timeline.scrollHeight;
    for (const animation of document.getAnimations()) animation.finish();
  }, nativeFrame);
  return page;
}

/** Record every write to <html> from now on: each restyles every element. */
async function watchRootWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const writes: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) writes.push(`${record.attributeName}: ${document.documentElement.getAttribute(record.attributeName!)}`);
    }).observe(document.documentElement, { attributes: true });
    (window as unknown as { __rootWrites: string[] }).__rootWrites = writes;
  });
}

const rootWrites = (page: Page) => page.evaluate(() => (window as unknown as { __rootWrites: string[] }).__rootWrites);

test("an iOS keyboard carries the composer up on the compositor, and the frame commits only once it has landed", { skip: !CHROME }, async () => {
  const page = await open("keyboard");
  // keyboardWillShow while the composer holds focus: the keyboard starts its
  // slide while the WebView keeps its full height until the plugin resizes it.
  const ride = await page.evaluate(async (KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const keyboard = document.getElementById("keyboard")!;
    const lastRow = document.querySelector<HTMLElement>(".timeline > :last-child")!;
    const root = document.getElementById("root")!;
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    const rowToCard = card.getBoundingClientRect().top - lastRow.getBoundingClientRect().bottom;
    keyboard.style.transform = "translate3d(0, 0, 0)";
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const animations = document.getAnimations();
    const rides = animations.filter((animation) => animation.id === "keyboard-ride-transform")
      .map((animation) => ((animation.effect as KeyframeEffect).target as Element).className);
    for (const animation of animations) animation.pause();
    const rows: Array<{ gap: number; glue: number; root: number }> = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of animations) animation.currentTime = step * 25;
      rows.push({
        gap: Math.round(keyboard.getBoundingClientRect().top - card.getBoundingClientRect().bottom),
        glue: Math.round(card.getBoundingClientRect().top - lastRow.getBoundingClientRect().bottom - rowToCard),
        root: root.getBoundingClientRect().height,
      });
    }
    for (const animation of animations) animation.finish();
    return { rows, rides, keyboard: document.body.dataset.keyboard, frame: document.documentElement.dataset.keyboardFrame };
  }, KEYBOARD);
  assert.deepEqual(ride.rides.sort(), ["conversation-composer-dock", "timeline-wrap"], "the dock and the transcript ride");
  assert.equal(ride.keyboard, "open", "the cheap keyboard state follows the keyboard at once");
  assert.equal(ride.frame, "closed", "the expensive frame waits for the landing");
  for (const [step, row] of ride.rows.entries()) {
    assert.equal(row.root, 844, `at ${step * 25}ms the frame has not moved (nothing re-lays out under the ride)`);
    assert.ok(row.gap >= 0 && row.gap <= 12, `at ${step * 25}ms the composer sits just above the keyboard (gap ${row.gap}px)`);
    assert.ok(Math.abs(row.glue) <= 1, `at ${step * 25}ms the tail stays glued above the composer (${row.glue}px)`);
  }

  // The plugin's deferred resize lands after the slide: that is the commit,
  // and nothing moves — on any frame, not only once it has settled. The
  // editor still holds focus, and the frame shrinks: publish()'s Safari
  // settle gate used to hold that commit two frames while the residual
  // glide had already started from the old layout (a ~290px jump).
  const before = await page.evaluate(() => {
    const card = document.querySelector(".composer-card")!;
    const frames: number[] = [];
    const sample = () => {
      frames.push(card.getBoundingClientRect().bottom);
      if (frames.length < 24) requestAnimationFrame(sample);
    };
    window.addEventListener("resize", () => requestAnimationFrame(sample), { once: true });
    (window as unknown as { __landing: number[] }).__landing = frames;
    return {
      card: card.getBoundingClientRect().bottom,
      row: document.querySelector(".timeline > :last-child")!.getBoundingClientRect().bottom,
    };
  });
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    card: document.querySelector(".composer-card")!.getBoundingClientRect().bottom,
    row: document.querySelector(".timeline > :last-child")!.getBoundingClientRect().bottom,
    root: document.getElementById("root")!.getBoundingClientRect().height,
    frame: document.documentElement.dataset.keyboardFrame,
    rides: document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform").length,
    landing: (window as unknown as { __landing: number[] }).__landing,
  }));
  assert.ok(after.landing.length >= 10, `the landing was sampled (${after.landing.length} frames)`);
  for (const [index, bottom] of after.landing.entries()) {
    assert.ok(Math.abs(bottom - before.card) <= 1, `frame ${index} after the resize keeps the composer in place (${before.card} → ${bottom})`);
  }
  assert.equal(after.frame, "open");
  assert.equal(after.root, 844 - KEYBOARD, "the frame takes the keyboard's edge on landing");
  assert.equal(after.rides, 0, "no transform is left once the layout holds the riders");
  assert.ok(Math.abs(after.card - before.card) <= 1, `the commit does not move the composer (${before.card} → ${after.card})`);
  assert.ok(Math.abs(after.row - before.row) <= 1, `nor the transcript's tail (${before.row} → ${after.row})`);
});

test("a closing keyboard commits the frame at once and the composer glides down after that restyle", { skip: !CHROME }, async () => {
  const page = await open("keyboard-close");
  await page.evaluate((KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
  }, KEYBOARD);
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(400);
  const glide = await page.evaluate(async (KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const root = document.getElementById("root")!;
    const open = card.getBoundingClientRect().bottom;
    (document.activeElement as HTMLElement).blur();
    viewport.setNativeKeyboardInset(0, { followKeyboard: true });
    // Same task, before any frame: the frame is the closed layout already,
    // and the composer is held where it was.
    const held = { root: root.getBoundingClientRect().height, card: card.getBoundingClientRect().bottom };
    const ride = document.getAnimations().find((animation) => animation.id === "keyboard-ride-transform"
      && (animation.effect as KeyframeEffect).target === card.closest(".conversation-composer-dock"));
    // Timed from the frame after this commit, never advanced into its stall.
    const unadvanced = !ride || Number(ride.currentTime ?? 0) === 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const playing = ride?.playState;
    ride?.pause();
    const rows: number[] = [];
    for (let step = 0; step <= 10; step++) {
      if (ride) ride.currentTime = step * 25;
      rows.push(card.getBoundingClientRect().bottom);
    }
    ride?.finish();
    return { open, held, unadvanced, playing, rows, closed: card.getBoundingClientRect().bottom, frame: document.documentElement.dataset.keyboardFrame, keyboard: KEYBOARD };
  }, KEYBOARD);
  assert.equal(glide.frame, "closed");
  assert.equal(glide.held.root, 844, "the closed frame is projected before the WebView grows back");
  assert.ok(Math.abs(glide.held.card - glide.open) <= 1, `the composer is held where it was (${glide.open} → ${glide.held.card})`);
  assert.ok(glide.unadvanced, "the glide is not advanced into the commit's restyle");
  assert.equal(glide.playing, "running", "and sets off on the next frame");
  assert.ok(Math.abs(glide.rows[0]! - glide.open) <= 1, "the glide starts at the open position");
  for (let step = 1; step < glide.rows.length; step++) {
    assert.ok(glide.rows[step]! >= glide.rows[step - 1]! - 0.5, `the composer only moves down (step ${step})`);
  }
  assert.ok(Math.abs(glide.rows.at(-1)! - glide.closed) <= 1, "and lands on the closed layout");
  assert.ok(glide.closed - glide.open > KEYBOARD - 40, "the closed composer sits at the bottom again");
});

// A composer that slid over a transcript that kept its place relied on the
// two layers' paint order, and iOS WebKit painted the transcript over the
// composer (device report 2026-11-02: an older chat scrolled up from its end).
// The transcript column now ends at the composer on every frame, both ways.
test("a transcript away from its tail keeps its place while its column ends at the riding composer", { skip: !CHROME }, async () => {
  const page = await open("keyboard-away");
  type Sample = { overlap: number; row: number };
  // How far the transcript column reaches under the composer, and where one
  // of the reader's rows is.
  await page.evaluate(() => {
    (window as unknown as { __sample: () => Sample }).__sample = () => {
      const wrap = document.querySelector(".timeline-wrap")!;
      const dock = document.querySelector(".conversation-composer-dock")!;
      const row = document.querySelectorAll(".timeline > .msg")[30]!;
      return {
        overlap: Math.round(wrap.getBoundingClientRect().bottom - dock.getBoundingClientRect().top),
        row: Math.round(row.getBoundingClientRect().top),
      };
    };
  });
  const opening = await page.evaluate(async (KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const sample = (window as unknown as { __sample: () => Sample }).__sample;
    const timeline = document.querySelector<HTMLElement>(".timeline")!;
    timeline.scrollTop -= 300;
    timeline.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = sample();
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    document.getElementById("keyboard")!.style.transform = "translate3d(0, 0, 0)";
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    const steps: Sample[] = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of animations) animation.currentTime = step * 25;
      steps.push(sample());
    }
    for (const animation of animations) animation.finish();
    // Every frame of the landing: the finished rides still hold the rows.
    const landing: Sample[] = [];
    const next = () => {
      landing.push(sample());
      if (landing.length < 12) requestAnimationFrame(next);
    };
    window.addEventListener("resize", next, { once: true });
    (window as unknown as { __landing: Sample[] }).__landing = landing;
    return { before, steps };
  }, KEYBOARD);
  for (const [step, at] of opening.steps.entries()) {
    assert.ok(at.overlap <= 0, `at ${step * 25}ms the transcript column ends at the composer (${at.overlap}px under it)`);
    assert.equal(at.row, opening.before.row, `at ${step * 25}ms the reader's rows keep their place`);
  }

  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(600);
  const landing = await page.evaluate(() => (window as unknown as { __landing: Sample[] }).__landing);
  assert.ok(landing.length >= 10, `the landing was sampled (${landing.length} frames)`);
  for (const [index, at] of landing.entries()) {
    assert.ok(at.overlap <= 0, `landing, frame ${index}: the transcript column ends at the composer (${at.overlap}px under it)`);
    assert.equal(at.row, opening.before.row, `landing, frame ${index}: the reader's rows keep their place`);
  }
  const closing = await page.evaluate(() => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const sample = (window as unknown as { __sample: () => Sample }).__sample;
    const landed = sample();
    const rides = document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform").length;
    (document.activeElement as HTMLElement).blur();
    viewport.setNativeKeyboardInset(0, { followKeyboard: true });
    const animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    const steps: Sample[] = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of animations) animation.currentTime = step * 25;
      steps.push(sample());
    }
    for (const animation of animations) animation.finish();
    return { landed, rides, steps };
  });
  assert.equal(closing.landed.row, opening.before.row, "the landing does not move the reader's rows");
  assert.ok(closing.landed.overlap <= 0);
  assert.equal(closing.rides, 0, "no transform is left once the layout holds the riders");
  for (const [step, at] of closing.steps.entries()) {
    assert.ok(at.overlap <= 0, `closing, at ${step * 25}ms the transcript column ends at the composer (${at.overlap}px under it)`);
    assert.equal(at.row, opening.before.row, `closing, at ${step * 25}ms the reader's rows keep their place`);
  }
});

test("a reported keyboard slide re-times the ride to the keyboard's real spring and catches up a late report", { skip: !CHROME }, async () => {
  const page = await open("keyboard-spring");
  // A keyboard slower than the 250 ms token, on a critically damped spring,
  // whose report reaches the page 40 ms after the keyboard set off — and
  // after the keyboard event that already started the ride on the token.
  const gaps = await page.evaluate(async (KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const spring = { mass: 1, stiffness: 200, damping: 2 * Math.sqrt(200), initialVelocity: 0 };
    const LAG = 40;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const keyboard = document.getElementById("keyboard")!;
    keyboard.style.transition = "none";
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    const slide = keyboard.animate(
      [{ transform: "translate3d(0, 100%, 0)" }, { transform: "translate3d(0, 0, 0)" }],
      { duration: 500, easing: viewport.springEasing(spring, 500), fill: "forwards" },
    );
    const sentAt = Date.now() - LAG;
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    viewport.setNativeKeyboardMotion({ durationMs: 250, animationDurationMs: 500, sentAt, spring });
    // Where the keyboard is now, on the same clock the report was stamped with.
    const keyboardAt = Date.now() - sentAt;
    const riders = document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform");
    // Where each ride is on the clock its start time is set on, against the
    // keyboard's real elapsed time (currentTime would lag by the last frame).
    const offsets = riders.map((animation) => (performance.now() - Number(animation.startTime)) - keyboardAt);
    for (const animation of [slide, ...riders]) animation.pause();
    const durations = riders.map((animation) => Number((animation.effect as KeyframeEffect).getTiming().duration));
    const rows: number[] = [];
    for (let step = 0; step <= 10; step++) {
      slide.currentTime = keyboardAt + step * 45;
      riders.forEach((animation, index) => { animation.currentTime = keyboardAt + offsets[index]! + step * 45; });
      rows.push(Math.round(keyboard.getBoundingClientRect().top - card.getBoundingClientRect().bottom));
    }
    for (const animation of [slide, ...riders]) animation.finish();
    return { rows, riders: riders.length, offsets, durations };
  }, KEYBOARD);
  assert.ok(gaps.riders > 0, "the docks ride the keyboard");
  for (const duration of gaps.durations) assert.equal(duration, 500, "the ride takes the keyboard's real length");
  for (const offset of gaps.offsets) assert.ok(Math.abs(offset) < 20, `riders caught up with the keyboard (${offset}ms behind real time)`);
  for (const [step, gap] of gaps.rows.entries()) {
    assert.ok(gap >= 0 && gap <= 14, `at ${step * 45}ms after the report the composer sits just above the keyboard (gap ${gap}px)`);
  }
});

test("a keyboard serving a field outside the docks takes the frame at once", { skip: !CHROME }, async () => {
  const page = await open("keyboard-field");
  const state = await page.evaluate((KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    return {
      frame: document.documentElement.dataset.keyboardFrame,
      root: document.getElementById("root")!.getBoundingClientRect().height,
      rides: document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform").length,
    };
  }, KEYBOARD);
  assert.equal(state.frame, "open", "a Settings or navigator field gets its band without waiting");
  assert.equal(state.root, 844 - KEYBOARD);
  assert.equal(state.rides, 0);
});

test("on the native app's dynamic frame a docked composer rides, lands with the WebView resize and glides down again with no write to <html>", { skip: !CHROME }, async () => {
  const page = await open("keyboard-dynamic", true);
  const initial = await page.evaluate(() => ({
    frame: document.documentElement.dataset.keyboardFrame,
    bottom: document.documentElement.style.getPropertyValue("--layer-frame-bottom"),
  }));
  assert.deepEqual(initial, { frame: "native", bottom: "100dvh" }, "the frame is the WebView's own viewport");
  await watchRootWrites(page);
  // keyboardWillShow: the ride runs on a frame that is still the full WebView.
  const ride = await page.evaluate(async (KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const keyboard = document.getElementById("keyboard")!;
    const root = document.getElementById("root")!;
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    keyboard.style.transform = "translate3d(0, 0, 0)";
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    const rows: Array<{ gap: number; root: number }> = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of animations) animation.currentTime = step * 25;
      rows.push({ gap: Math.round(keyboard.getBoundingClientRect().top - card.getBoundingClientRect().bottom), root: root.getBoundingClientRect().height });
    }
    for (const animation of animations) animation.finish();
    return { rows, keyboard: document.body.dataset.keyboard };
  }, KEYBOARD);
  assert.equal(ride.keyboard, "open");
  for (const [step, row] of ride.rows.entries()) {
    assert.equal(row.root, 844, `at ${step * 25}ms the WebView, and with it the frame, has not moved`);
    assert.ok(row.gap >= 0 && row.gap <= 12, `at ${step * 25}ms the composer sits just above the keyboard (gap ${row.gap}px)`);
  }

  // The WebView resize moves the dynamic frame by itself, before this page's
  // resize handler runs: the ride must come off on that same frame.
  const before = await page.evaluate(() => {
    const card = document.querySelector(".composer-card")!;
    const frames: number[] = [];
    const sample = () => {
      frames.push(card.getBoundingClientRect().bottom);
      if (frames.length < 24) requestAnimationFrame(sample);
    };
    window.addEventListener("resize", () => sample(), { once: true });
    (window as unknown as { __landing: number[] }).__landing = frames;
    return { card: card.getBoundingClientRect().bottom, row: document.querySelector(".timeline > :last-child")!.getBoundingClientRect().bottom };
  });
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(600);
  const landed = await page.evaluate(() => ({
    card: document.querySelector(".composer-card")!.getBoundingClientRect().bottom,
    row: document.querySelector(".timeline > :last-child")!.getBoundingClientRect().bottom,
    root: document.getElementById("root")!.getBoundingClientRect().height,
    rides: document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform").length,
    landing: (window as unknown as { __landing: number[] }).__landing,
  }));
  assert.ok(landed.landing.length >= 10, `the landing was sampled (${landed.landing.length} frames)`);
  for (const [index, bottom] of landed.landing.entries()) {
    assert.ok(Math.abs(bottom - before.card) <= 1, `frame ${index} of the landing keeps the composer in place (${before.card} → ${bottom})`);
  }
  assert.equal(landed.root, 844 - KEYBOARD, "the frame is the resized WebView");
  assert.equal(landed.rides, 0, "no transform is left once the layout holds the riders");
  assert.ok(Math.abs(landed.row - before.row) <= 1, `the transcript's tail stays put (${before.row} → ${landed.row})`);

  // keyboardWillHide: nothing is committed; the composer sets off with the
  // keyboard while the WebView still has the keyboard's size.
  const held = await page.evaluate((KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const open = card.getBoundingClientRect().bottom;
    (document.activeElement as HTMLElement).blur();
    viewport.setNativeKeyboardInset(0, { followKeyboard: true });
    const ride = document.getAnimations().find((animation) => animation.id === "keyboard-ride-transform"
      && (animation.effect as KeyframeEffect).target === card.closest(".conversation-composer-dock"));
    ride?.pause();
    if (ride) ride.currentTime = 0;
    (window as unknown as { __closing?: Animation }).__closing = ride;
    const frames: number[] = [];
    const sample = () => {
      frames.push(card.getBoundingClientRect().bottom);
      if (frames.length < 12) requestAnimationFrame(sample);
    };
    window.addEventListener("resize", () => sample(), { once: true });
    (window as unknown as { __growth: number[] }).__growth = frames;
    return {
      open,
      card: card.getBoundingClientRect().bottom,
      root: document.getElementById("root")!.getBoundingClientRect().height,
      ride: !!ride,
      keyboard: document.body.dataset.keyboard,
      to: ride ? Number(/translate3d\(0px?,\s*(-?[\d.]+)px/.exec(String((ride.effect as KeyframeEffect).getKeyframes().at(-1)!.transform))?.[1]) : NaN,
      expected: KEYBOARD,
    };
  }, KEYBOARD);
  assert.equal(held.keyboard, "closed");
  assert.ok(held.ride, "the dock rides the closing keyboard");
  assert.equal(held.root, 844 - KEYBOARD, "no closed frame is projected over the WebView");
  assert.ok(Math.abs(held.card - held.open) <= 1, `the composer starts where it was (${held.open} → ${held.card})`);
  assert.ok(Math.abs(held.to - held.expected) <= 1, `toward where the grown WebView will put it (${held.to}px)`);

  // The plugin grows the WebView back: the layout takes that move over from the ride.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const glide = await page.evaluate(async () => {
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const ride = (window as unknown as { __closing?: Animation }).__closing!;
    const growth = (window as unknown as { __growth: number[] }).__growth;
    const rows: number[] = [];
    for (let step = 0; step <= 10; step++) {
      ride.currentTime = step * 25;
      rows.push(card.getBoundingClientRect().bottom);
    }
    ride.finish();
    // The finish event is delivered with the next frame.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      growth,
      rows,
      closed: card.getBoundingClientRect().bottom,
      root: document.getElementById("root")!.getBoundingClientRect().height,
      rides: document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform").length,
    };
  });
  assert.ok(glide.growth.length >= 6, `the growth was sampled (${glide.growth.length} frames)`);
  for (const [index, bottom] of glide.growth.entries()) {
    assert.ok(Math.abs(bottom - held.open) <= 1, `frame ${index} after the WebView grew keeps the composer where the ride had it (${held.open} → ${bottom})`);
  }
  assert.equal(glide.root, 844);
  assert.ok(Math.abs(glide.rows[0]! - held.open) <= 1, "the glide starts at the open position");
  for (let step = 1; step < glide.rows.length; step++) {
    assert.ok(glide.rows[step]! >= glide.rows[step - 1]! - 0.5, `the composer only moves down (step ${step})`);
  }
  assert.ok(Math.abs(glide.rows.at(-1)! - glide.closed) <= 1, "and lands on the closed layout");
  assert.ok(glide.closed - held.open > KEYBOARD - 40, "the closed composer sits at the bottom again");
  assert.equal(glide.rides, 0, "nothing is left holding the dock");
  assert.deepEqual(await rootWrites(page), [], "the whole move wrote nothing to <html>");
});

// The WebView resizes under the dynamic frame mid-ride: the column it shortens
// or grows must keep ending at the composer, and the rows must not move for it.
for (const away of [true, false]) {
  test(`on the native app's dynamic frame a transcript ${away ? "away from" : "at"} its tail ${away ? "keeps its place" : "follows the composer"} while its column ends at the composer across the WebView resizes`, { skip: !CHROME }, async () => {
    const page = await open(away ? "keyboard-dynamic-away" : "keyboard-dynamic-tail", true);
    type Sample = { overlap: number; row: number; card: number };
    await page.evaluate(() => {
      (window as unknown as { __sample: () => Sample }).__sample = () => {
        const wrap = document.querySelector(".timeline-wrap")!;
        const dock = document.querySelector(".conversation-composer-dock")!;
        return {
          overlap: Math.round(wrap.getBoundingClientRect().bottom - dock.getBoundingClientRect().top),
          row: Math.round(document.querySelectorAll(".timeline > .msg")[30]!.getBoundingClientRect().top),
          card: Math.round(document.querySelector(".composer-card")!.getBoundingClientRect().top),
        };
      };
      // Every frame from the WebView resize on, sampled after the viewport's own handler.
      (window as unknown as { __watchResize: () => Sample[] }).__watchResize = () => {
        const sample = (window as unknown as { __sample: () => Sample }).__sample;
        const frames: Sample[] = [];
        const next = () => {
          frames.push(sample());
          if (frames.length < 12) requestAnimationFrame(next);
        };
        window.addEventListener("resize", next, { once: true });
        return frames;
      };
    });
    const before = await page.evaluate(async (away) => {
      if (away) {
        const timeline = document.querySelector<HTMLElement>(".timeline")!;
        timeline.scrollTop -= 300;
        timeline.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return (window as unknown as { __sample: () => Sample }).__sample();
    }, away);
    const check = (at: Sample, label: string) => {
      assert.ok(at.overlap <= 0, `${label} the transcript column ends at the composer (${at.overlap}px under it)`);
      if (away) assert.equal(at.row, before.row, `${label} the reader's rows keep their place`);
      else assert.ok(Math.abs(at.card - at.row - (before.card - before.row)) <= 1, `${label} the rows follow the composer (${before.card - before.row} → ${at.card - at.row})`);
    };

    const opening = await page.evaluate(async (KEYBOARD) => {
      const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
      const sample = (window as unknown as { __sample: () => Sample }).__sample;
      const rides = () => document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform");
      document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
      document.getElementById("keyboard")!.style.transform = "translate3d(0, 0, 0)";
      viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const animations = rides();
      for (const animation of animations) animation.pause();
      const steps: Sample[] = [];
      for (let step = 0; step <= 10; step++) {
        for (const animation of animations) animation.currentTime = step * 25;
        steps.push(sample());
      }
      for (const animation of animations) animation.finish();
      (window as unknown as { __landing: Sample[] }).__landing = (window as unknown as { __watchResize: () => Sample[] }).__watchResize();
      return steps;
    }, KEYBOARD);
    for (const [step, at] of opening.entries()) check(at, `opening, at ${step * 25}ms`);

    await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
    await page.waitForTimeout(600);
    const landing = await page.evaluate(() => (window as unknown as { __landing: Sample[] }).__landing);
    assert.ok(landing.length >= 10, `the landing was sampled (${landing.length} frames)`);
    for (const [index, at] of landing.entries()) check(at, `landing, frame ${index}`);

    // keyboardWillHide on the WebView that still has the keyboard's size; the
    // rides are held at their start, where the plugin's resize finds them.
    const held = await page.evaluate(() => {
      const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
      const rides = () => document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform");
      (document.activeElement as HTMLElement).blur();
      viewport.setNativeKeyboardInset(0, { followKeyboard: true });
      for (const animation of rides()) {
        animation.pause();
        animation.currentTime = 0;
      }
      (window as unknown as { __growth: Sample[] }).__growth = (window as unknown as { __watchResize: () => Sample[] }).__watchResize();
      return (window as unknown as { __sample: () => Sample }).__sample();
    });
    check(held, "closing, before the WebView grows,");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const closing = await page.evaluate(async () => {
      const sample = (window as unknown as { __sample: () => Sample }).__sample;
      const rides = () => document.getAnimations().filter((animation) => animation.id === "keyboard-ride-transform");
      const animations = rides();
      for (const animation of animations) animation.pause();
      const steps: Sample[] = [];
      for (let step = 0; step <= 10; step++) {
        for (const animation of animations) animation.currentTime = step * 25;
        steps.push(sample());
      }
      for (const animation of animations) animation.finish();
      // The finish events are delivered with the next frame.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        growth: (window as unknown as { __growth: Sample[] }).__growth,
        steps,
        closed: sample(),
        left: rides().length,
        root: document.getElementById("root")!.getBoundingClientRect().height,
      };
    });
    assert.equal(closing.root, 844);
    assert.ok(closing.growth.length >= 6, `the growth was sampled (${closing.growth.length} frames)`);
    for (const [index, at] of closing.growth.entries()) check(at, `growth, frame ${index}`);
    for (const [step, at] of closing.steps.entries()) check(at, `closing, at ${step * 25}ms`);
    check(closing.closed, "closed,");
    assert.ok(closing.closed.card - held.card > KEYBOARD - 40, "the closed composer sits at the bottom again");
    assert.equal(closing.left, 0, "nothing is left riding once the layout holds the riders");
  });
}

test("on the native app's dynamic frame a field's keyboard projects its band, hands it back to the WebView on landing, and closes without a write", { skip: !CHROME }, async () => {
  const page = await open("keyboard-dynamic-field", true);
  const opened = await page.evaluate((KEYBOARD) => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    viewport.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    return {
      frame: document.documentElement.dataset.keyboardFrame,
      root: document.getElementById("root")!.getBoundingClientRect().height,
    };
  }, KEYBOARD);
  assert.deepEqual(opened, { frame: "open", root: 844 - KEYBOARD }, "the field gets its band before the deferred resize");
  await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
  await page.waitForTimeout(100);
  const landed = await page.evaluate(() => ({
    frame: document.documentElement.dataset.keyboardFrame,
    bottom: document.documentElement.style.getPropertyValue("--layer-frame-bottom"),
    root: document.getElementById("root")!.getBoundingClientRect().height,
  }));
  assert.deepEqual(landed, { frame: "native", bottom: "100dvh", root: 844 - KEYBOARD }, "the landed keyboard hands the frame back to the WebView");
  await watchRootWrites(page);
  const closing = await page.evaluate(() => {
    const viewport = (window as unknown as { __viewport: ViewportProbe }).__viewport;
    (document.activeElement as HTMLElement).blur();
    viewport.setNativeKeyboardInset(0, { followKeyboard: true });
    return { keyboard: document.body.dataset.keyboard, root: document.getElementById("root")!.getBoundingClientRect().height };
  });
  assert.deepEqual(closing, { keyboard: "closed", root: 844 - KEYBOARD }, "the frame waits for the WebView, not a projection");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.getElementById("root")!.getBoundingClientRect().height), 844);
  assert.deepEqual(await rootWrites(page), [], "closing restyled nothing through <html>");
});
