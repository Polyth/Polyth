// The phone composer's resting row grows into the engaged card while the iOS
// keyboard slides up (composerMorph.ts, mobileViewport.ts). Device capture,
// build 17: right before the slide ended the card was ~10px taller than where
// it settled — the morph had measured its end with the resting row's editor
// height, and the model row (`flex: 1 1 auto`) absorbed the difference, so the
// air above and below the model visibly changed and snapped back at the end.
//
// Real cascade (main.css) + the real morph and viewport modules in Chromium,
// on a small phone whose keyboard band turns short mid-morph. The probe's
// editor sizes itself only after the morph has measured (a passive effect, as
// the Composer's auto-grow used to), so the morph has to land on the settled
// height by itself. A long draft (composer already engaged) must not resize
// the card when the plugin's deferred WebView resize lands after the slide.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const CHROME = await findChromiumExecutable();
const KEYBOARD = 301;
const SLIDE_MS = 500;

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

const PROBE = `
import { createElement as h, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerMorph } from "./composerMorph.ts";
import { setNativeKeyboardInset, setNativeKeyboardMotion, startMobileViewport, useViewportMetrics } from "./mobileViewport.ts";

const draft = window.__draft ?? "";

function Composer() {
  const root = useRef(null);
  const input = useRef(null);
  // A draft keeps the composer engaged, as in the Composer.
  const [focused, setFocused] = useState(Boolean(draft));
  const band = useViewportMetrics().height;
  // Sized only after the morph has measured, like the old editor auto-grow.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = (el.scrollHeight + 2) + "px";
  }, [focused, band]);
  useComposerMorph(root, focused, true);
  const state = focused ? "composer-expanded composer-input-active" : "composer-collapsed";
  // The Composer publishes the band the keyboard leaves on its own root
  // (the long-draft editor cap; mobileViewport.css).
  return h("div", { ref: root, style: band > 0 ? { "--composer-band": band + "px" } : undefined, className: "composer composer-chat composer-simple composer-focus-light composer-mobile composer-mobile-grid " + state },
    h("div", { className: "session-context-bar" },
      h("span", { className: "picker context-selector context-selector-project" }, h("button", { className: "chip picker-chip" }, "Polyth"))),
    h("div", { className: "ui-glass-dock ui-glass-dock--strong composer-card" },
      h("div", { className: "composer-config composer-config-row" },
        h("span", { className: "picker picker-model model-picker" },
          h("button", { className: "config-chip model-picker-trigger" }, h("span", { className: "model-trigger-name" }, "Opus 5.5"))),
        h("button", { className: "ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm mobile-composer-edit", "aria-label": "Edit" })),
      h("div", { className: "composer-input" },
        h("textarea", { ref: input, className: "composer-editor", rows: 3, defaultValue: draft, placeholder: "Message Polyth…", onFocus: () => setFocused(true) })),
      h("div", { className: "composer-rail mobile-composer-rail", "data-resting": focused ? undefined : "true", style: { "--mobile-rail-lanes": 5 } },
        h("div", { className: "mobile-composer-launchers" },
          h("div", { className: "mobile-composer-cell", "data-resting": "add" },
            h("div", { className: "mobile-composer-launcher" }, h("button", { className: "ui-icon-btn" }, "+"))),
          h("div", { className: "mobile-composer-cell", "data-resting": "quick" },
            h("div", { className: "mobile-composer-launcher" }, h("button", { className: "ui-icon-btn" }, "M")))),
        h("div", { className: "mobile-composer-primary" },
          h("span", { className: "composer-primary" }, h("button", { className: "send", "aria-label": "Send", disabled: true }, ">"))))));
}

startMobileViewport();
createRoot(document.getElementById("root")).render(
  h("div", { className: "app mode-chat view-session" },
    h("div", { className: "app-shell" },
      h("div", { className: "workspace" },
        h("main", { className: "main" },
          h("div", { className: "stage stage-new" },
            h("div", { className: "hero" },
              h("div", { className: "hero-body" }, h("h2", null, "Let’s have some fun")),
              h("div", { className: "hero-dock" }, h(Composer)))))))));
window.__probe = { setNativeKeyboardInset, setNativeKeyboardMotion };
`;

async function fixture(draft = ""): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../../../apps/web/src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/composer-morph-keyboard-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const probe = (await build({
    stdin: { contents: PROBE, resolveDir: fileURLToPath(new URL("../../../apps/web/src/", import.meta.url)), loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0]!.text;
  // A home indicator below the resting dock, as on the phone.
  return `<!doctype html><html style="--safe-area-inset-bottom: 34px"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>${css}</style></head>
    <body><div id="root"></div><script>window.__draft = ${JSON.stringify(draft)};</script><script>${probe}</script></body></html>`;
}

type Probe = {
  setNativeKeyboardInset(height: number, options?: { followKeyboard?: boolean }): void;
  setNativeKeyboardMotion(motion: { durationMs: number; animationDurationMs: number; sentAt: number;
    spring: { mass: number; stiffness: number; damping: number; initialVelocity: number } }): void;
};

test("the engaging card lands on its settled height while the keyboard re-bands the shell, the model line keeping its distance to the editor", { skip: !CHROME }, async () => {
  assert.ok(page);
  const html = await fixture();
  await page.route("http://composer-morph.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://composer-morph.test/");
  await page.waitForTimeout(150);

  const run = await page.evaluate(async ({ KEYBOARD, SLIDE_MS }) => {
    const probe = (window as unknown as { __probe: Probe }).__probe;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const composer = document.querySelector<HTMLElement>(".composer")!;
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const name = document.querySelector<HTMLElement>(".model-trigger-name")!;
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const sample = () => ({
      card: card.getBoundingClientRect().height,
      bottom: card.getBoundingClientRect().bottom,
      // Model line to editor row: the air the device capture showed changing.
      // The row, not the editor: its placeholder rises out of the resting row
      // on a transform while the row opens (composerMorph.ts glideEditor).
      modelToEditor: editor.closest(".composer-input")!.getBoundingClientRect().top - name.getBoundingClientRect().bottom,
      composerPadding: parseFloat(getComputedStyle(composer).paddingBottom),
    });
    const resting = sample();
    // Focus engages the composer; the keyboard's report and inset follow.
    editor.focus();
    await Promise.resolve();
    const spring = { mass: 1, stiffness: 400, damping: 40, initialVelocity: 0 };
    probe.setNativeKeyboardMotion({ durationMs: 250, animationDurationMs: SLIDE_MS, sentAt: Date.now(), spring });
    probe.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    const band = document.body.dataset.band;
    // The page renders as it would on the phone: late sizes reach the morph,
    // which re-aims on the frame after its rows report them.
    for (let rendered = 0; rendered < 3; rendered++) await frame();
    const riders = document.getAnimations().filter((animation) => animation.playState !== "finished");
    for (const animation of riders) animation.pause();
    const steps: ReturnType<typeof sample>[] = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of riders) animation.currentTime = Math.min(step * (SLIDE_MS / 10), SLIDE_MS - 1);
      steps.push(sample());
    }
    for (const animation of riders) animation.finish();
    await frame();
    await frame();
    const morphRiders = riders.filter((a) => a.id === "keyboard-ride");
    const target = (a: Animation) => (a.effect as KeyframeEffect | null)?.target;
    return {
      resting, band, steps, settled: sample(), morph: composer.getAttribute("data-composer-morph"),
      morphs: morphRiders.filter((a) => target(a) === card).length,
      modelFades: morphRiders.filter((a) => target(a) === card.querySelector(".composer-config")).length,
      rides: riders.filter((a) => a.id === "keyboard-ride-transform").length,
    };
  }, { KEYBOARD, SLIDE_MS });

  assert.equal(run.band, "short", "the keyboard leaves this phone a short band, re-banding the composer mid-morph");
  assert.equal(run.morphs, 1, "engaging morphs the card");
  assert.equal(run.modelFades, 1, "the model line fades in on the morph's clock, re-timed with it");
  assert.equal(run.morph, null);
  const { settled } = run;
  for (const [step, at] of run.steps.entries()) {
    assert.ok(at.card <= settled.card + 0.5,
      `step ${step}: the card never grows past where it settles (${at.card.toFixed(1)} > ${settled.card.toFixed(1)})`);
    assert.ok(Math.abs(at.modelToEditor - settled.modelToEditor) <= 0.5,
      `step ${step}: the model line keeps its settled distance to the editor (${at.modelToEditor.toFixed(1)} vs ${settled.modelToEditor.toFixed(1)})`);
  }
  const last = run.steps.at(-1)!;
  assert.ok(Math.abs(last.card - settled.card) <= 0.5,
    `the morph ends on the settled card, no snap afterwards (${last.card.toFixed(1)} → ${settled.card.toFixed(1)})`);
  // The composer's own keyboard gap switches with the keyboard state at once;
  // the dock's compositor ride starts from where the card rested, so the
  // switch never shows (keyboardRide.ts).
  assert.ok(Math.abs(run.steps[0]!.bottom - run.resting.bottom) <= 0.5,
    `the card does not jump as the keyboard sets off (${run.resting.bottom.toFixed(1)} → ${run.steps[0]!.bottom.toFixed(1)})`);
  assert.ok(run.rides >= 1, "the dock rides the keyboard on a transform animation");
  assert.equal(settled.composerPadding, 4, "the open keyboard keeps the composer's 4px optical gap");
});

test("a long draft's editor takes its keyboard size with the slide, not when the deferred WebView resize lands", { skip: !CHROME }, async () => {
  assert.ok(page);
  const draft = Array.from({ length: 10 }, (_, index) => `Line ${index + 1} of a draft longer than the cap`).join("\n");
  const html = await fixture(draft);
  await page.route("http://composer-draft.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://composer-draft.test/");
  await page.waitForTimeout(150);

  const slide = await page.evaluate(async ({ KEYBOARD, SLIDE_MS }) => {
    const probe = (window as unknown as { __probe: Probe }).__probe;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const card = document.querySelector<HTMLElement>(".composer-card")!;
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const engaged = document.querySelector(".composer")!.classList.contains("composer-expanded");
    const closed = editor.getBoundingClientRect().height;
    editor.focus();
    await Promise.resolve();
    const spring = { mass: 1, stiffness: 400, damping: 40, initialVelocity: 0 };
    probe.setNativeKeyboardMotion({ durationMs: 250, animationDurationMs: SLIDE_MS, sentAt: Date.now(), spring });
    probe.setNativeKeyboardInset(KEYBOARD, { followKeyboard: true });
    for (let rendered = 0; rendered < 3; rendered++) await frame();
    const riders = document.getAnimations().filter((animation) => animation.playState !== "finished");
    for (const animation of riders) animation.pause();
    const editorHeights: number[] = [];
    for (let step = 0; step <= 10; step++) {
      for (const animation of riders) animation.currentTime = Math.min(step * (SLIDE_MS / 10), SLIDE_MS - 1);
      editorHeights.push(editor.getBoundingClientRect().height);
    }
    for (const animation of riders) animation.finish();
    await frame();
    return { engaged, closed, editorHeights, card: card.getBoundingClientRect().height, editor: editor.getBoundingClientRect().height };
  }, { KEYBOARD, SLIDE_MS });

  // The plugin resizes the WebView to end at the keyboard after the slide;
  // the WebView then no longer reaches the home indicator.
  await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-bottom", "0px"));
  await page.setViewportSize({ width: 375, height: 667 - KEYBOARD });
  await page.waitForTimeout(120);
  const resized = await page.evaluate(() => ({
    card: document.querySelector(".composer-card")!.getBoundingClientRect().height,
    editor: document.querySelector("textarea")!.getBoundingClientRect().height,
  }));
  await page.setViewportSize({ width: 375, height: 667 });

  assert.ok(slide.engaged, "a draft keeps the composer engaged");
  const [first, ...rest] = slide.editorHeights;
  assert.ok(Math.abs(first! - slide.closed) <= 0.5, `the editor starts the slide at its keyboard-closed cap (${slide.closed} → ${first})`);
  assert.ok(slide.editor < slide.closed - 20, `the open keyboard caps the editor lower (${slide.closed} → ${slide.editor})`);
  for (const [index, height] of rest.entries()) {
    assert.ok(height <= slide.editorHeights[index]! + 0.5, `the cap eases down with the slide (step ${index + 1}: ${height})`);
  }
  assert.ok(slide.editorHeights[5]! < slide.closed - 1 && slide.editorHeights[5]! > slide.editor + 1,
    `mid-slide the editor is between its two caps (${slide.editorHeights[5]})`);
  assert.ok(Math.abs(resized.card - slide.card) <= 0.5,
    `the deferred WebView resize does not resize the card (${slide.card} → ${resized.card})`);
  assert.ok(Math.abs(resized.editor - slide.editor) <= 0.5,
    `nor the editor (${slide.editor} → ${resized.editor})`);
});
