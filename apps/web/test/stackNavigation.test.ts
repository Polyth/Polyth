// Phone layer stack motion, measured in a real browser (skipped without one).
// The Workspace and a package window are two full-screen layers; Back must
// feel like peeling the top one off a stack. These tests freeze the actual CSS
// animations at exact progress points and assert the geometry that makes that
// true: the right layer is on top, travel is direction-aware, and the pair
// never leaves a gap that would show Chat.
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
const WIDTH = 390;
const HEIGHT = 720;

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";

before(async () => {
  if (!CHROME) return;
  const [tokens, styles, stack, premium] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/styles.css"),
    read("../src/stackNavigation.css"),
    read("../src/workspacePanelPremium.css"),
  ]);
  // styles.css @imports tokens/fonts by URL; inline the tokens instead.
  css = [tokens, styles.replace(/@import[^;]+;/g, ""), premium, stack].join("\n");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // Motion stays ON: this suite measures the animations themselves.
  page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

/** A package window (host + layer), the session float, and the Workspace sheet. */
function fixture(options: { dir?: "ltr" | "rtl"; pane?: string; workspaceStack?: string; workspaceClosing?: boolean; withPackage?: boolean } = {}): string {
  const { pane = "rail rail-workspace rail-fullscreen", workspaceStack = "enter", workspaceClosing = false, withPackage = true } = options;
  return `
    <style>${css}</style>
    <style>html, body { margin: 0; }</style>
    <div class="app">
      <div class="mobile-session-floats"><button class="float" style="position:absolute;left:8px;top:8px;width:60px;height:44px">Menu</button></div>
      ${withPackage ? `<aside class="railbar railbar-open" data-rail-motion="open">
        <div class="${pane}" id="pkg"><section class="module-view module-view--rail"><div class="module-view-body"></div></section></div>
      </aside>` : ""}
    </div>
    <div class="sheet-backdrop${workspaceClosing ? " is-closing" : ""}" data-stack="${workspaceStack}" id="ws">
      <div class="sheet sheet-tall mobile-tools-sheet workspace-panel-sheet${workspaceClosing ? " is-closing" : ""}" id="wsPanel">
        <button id="edit" style="position:absolute;left:10px;top:10px;width:60px;height:40px">Edit</button>
        <div class="sheet-body">Workspace</div>
      </div>
    </div>`;
}

async function load(html: string, dir: "ltr" | "rtl" = "ltr") {
  assert.ok(page);
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.setContent(html);
  await page.evaluate((direction) => { document.documentElement.dir = direction; }, dir);
}

/** Pause every animation named `name` on `selector` (or its pseudo-elements) at `fraction` of its duration. */
async function freeze(selector: string, name: string, fraction: number) {
  assert.ok(page);
  await page.evaluate(([sel, animName, f]) => {
    const el = document.querySelector(sel as string)!;
    // document-level so pseudo-element animations (the dim veil) are included;
    // their effect target is the originating element.
    for (const animation of document.getAnimations()) {
      if ((animation as CSSAnimation).animationName !== animName) continue;
      if ((animation.effect as KeyframeEffect | null)?.target !== el) continue;
      animation.pause();
      const timing = animation.effect!.getComputedTiming();
      animation.currentTime = Number(timing.duration) * Number(f);
    }
  }, [selector, name, fraction] as const);
}

const rectOf = (selector: string) => page!.evaluate((sel) => {
  const r = document.querySelector(sel)!.getBoundingClientRect();
  return { left: r.left, right: r.right, width: r.width };
}, selector);

test("package windows travel with the shared stack grammar, not the desktop window motion", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const [label, pane] of [
    ["workspace pane", "rail rail-workspace rail-fullscreen"],
    ["contextual panel", "panel-sheet"],
  ] as const) {
    await load(fixture({ pane, withPackage: true, workspaceStack: "covered" }));
    const entering: { name: string; duration: string; ease: string; fill: string } = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#pkg")!);
      return { name: cs.animationName, duration: cs.animationDuration, ease: cs.animationTimingFunction, fill: cs.animationFillMode };
    });
    assert.equal(entering.name, "stack-in", `${label} enters through stack-in`);
    assert.equal(entering.duration, "0.3s", `${label} takes the --motion-stack duration`);
    assert.match(entering.ease, /cubic-bezier\(0\.32, 0\.72, 0, 1\)/, `${label} uses the shared stack curve`);

    await page.evaluate(() => document.querySelector("#pkg")!.classList.add("rail-exiting"));
    const leaving: { name: string; duration: string; fill: string } = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#pkg")!);
      return { name: cs.animationName, duration: cs.animationDuration, fill: cs.animationFillMode };
    });
    assert.equal(leaving.name, "stack-out", `${label} leaves through stack-out`);
    assert.equal(leaving.duration, "0.3s");
    assert.equal(leaving.fill, "both", `${label} holds its end state until the host unmounts it`);
  }
});

test("wide shells keep their own window motion", { skip: !CHROME }, async () => {
  assert.ok(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <style>${css}</style>
    <div class="app"><aside class="railbar railbar-open" data-rail-motion="open">
      <div class="rail rail-workspace rail-fullscreen" id="pkg"><section class="module-view"></section></div>
    </aside></div>`);
  const name = await page.evaluate(() => getComputedStyle(document.querySelector("#pkg")!).animationName);
  assert.equal(name, "rail-window-open-layer", "the promoted desktop pane is not a phone layer");
});

test("the travel mirrors in right-to-left layouts", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const dir of ["ltr", "rtl"] as const) {
    await load(fixture({ withPackage: true, workspaceStack: "covered" }), dir);
    await freeze("#pkg", "stack-in", 0);
    const start: number = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#pkg")!).transform).m41);
    assert.equal(Math.round(start), dir === "ltr" ? WIDTH : -WIDTH,
      `${dir}: a package starts one screen away on the inline-end side`);
    const dirToken: string = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--stack-dir").trim());
    assert.equal(dirToken, dir === "ltr" ? "1" : "-1");

    // The covered Workspace retreats toward the inline-start side.
    await freeze("#wsPanel", "stack-cover", 1);
    const retreat: number = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#wsPanel")!).transform).m41);
    assert.ok(Math.abs(Math.abs(retreat) - WIDTH * 0.28) < 1, `${dir}: it retreats by the parallax fraction (${retreat})`);
    assert.equal(Math.sign(retreat), dir === "ltr" ? -1 : 1);
  }
});

test("layer order: session floats < Workspace < package window, and a covered Workspace swallows input", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load(fixture({ withPackage: true, workspaceStack: "covered" }));
  const z = await page.evaluate(() => ({
    floats: Number(getComputedStyle(document.querySelector(".mobile-session-floats")!).zIndex),
    workspace: Number(getComputedStyle(document.querySelector("#ws")!).zIndex),
    pkgHost: Number(getComputedStyle(document.querySelector(".railbar")!).zIndex),
    coveredPointer: getComputedStyle(document.querySelector("#ws")!).pointerEvents,
    coveredBackdropHeight: document.querySelector("#ws")!.getBoundingClientRect().height,
  }));
  assert.equal(z.floats, 102);
  assert.equal(z.workspace, 103, "the Workspace covers the session header and floats");
  assert.equal(z.pkgHost, 104, "a package window covers the Workspace it was opened from");
  // The covered layer is inert (Sheet), but its backdrop keeps catching input so
  // a tap in the strip a sliding package has not covered yet is swallowed rather
  // than falling through to the session header.
  assert.equal(z.coveredPointer, "auto", "a covered layer's backdrop swallows taps");
  assert.equal(z.coveredBackdropHeight, HEIGHT, "…across the whole screen");
});

test("Workspace phases: edge entry, retreat with a dim veil, settle, and the shared exit", { skip: !CHROME }, async () => {
  assert.ok(page);
  const probe = async (state: Parameters<typeof fixture>[0]) => {
    await load(fixture({ withPackage: false, ...state }));
    return page!.evaluate(() => {
      const panel = document.querySelector("#wsPanel")!;
      const cs = getComputedStyle(panel);
      const veil = getComputedStyle(panel, "::after");
      return { name: cs.animationName, veil: veil.animationName, veilContent: veil.content, veilPosition: veil.position };
    });
  };
  assert.deepEqual(await probe({ workspaceStack: "enter" }), { name: "stack-in", veil: "none", veilContent: '""', veilPosition: "absolute" });
  const covered = await probe({ workspaceStack: "covered" });
  assert.equal(covered.name, "stack-cover");
  assert.equal(covered.veil, "stack-dim-in", "the layer dims as it retreats");
  const revealed = await probe({ workspaceStack: "revealed" });
  assert.equal(revealed.name, "stack-uncover");
  assert.equal(revealed.veil, "stack-dim-out", "the veil lifts as it settles");
  const leaving = await probe({ workspaceStack: "covered", workspaceClosing: true });
  assert.equal(leaving.name, "stack-out", "leaving mirrors arriving, whichever phase it leaves from");
});

test("Back never exposes Chat: the two layers always cover the screen together", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const dir of ["ltr", "rtl"] as const) {
    // Push: package in, Workspace retreating.
    await load(fixture({ withPackage: true, workspaceStack: "covered" }), dir);
    // Pop: package out, Workspace settling. Rebuilt per direction below.
    for (const fraction of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
      await freeze("#pkg", "stack-in", fraction);
      await freeze("#wsPanel", "stack-cover", fraction);
      const [pkg, workspace] = [await rectOf("#pkg"), await rectOf("#wsPanel")];
      if (dir === "ltr") {
        assert.ok(workspace.right >= pkg.left - 0.5, `push ${dir} @${fraction}: no gap between the layers (${workspace.right} vs ${pkg.left})`);
        assert.ok(workspace.left <= 0.5, `push ${dir} @${fraction}: the Workspace reaches the screen edge`);
      } else {
        assert.ok(workspace.left <= pkg.right + 0.5, `push ${dir} @${fraction}: no gap between the layers`);
        assert.ok(workspace.right >= WIDTH - 0.5, `push ${dir} @${fraction}: the Workspace reaches the screen edge`);
      }
    }

    await load(fixture({ withPackage: true, workspaceStack: "revealed", pane: "rail rail-workspace rail-fullscreen rail-exiting" }), dir);
    for (const fraction of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
      await freeze("#pkg", "stack-out", fraction);
      await freeze("#wsPanel", "stack-uncover", fraction);
      const [pkg, workspace] = [await rectOf("#pkg"), await rectOf("#wsPanel")];
      if (dir === "ltr") {
        assert.ok(workspace.right >= pkg.left - 0.5, `pop ${dir} @${fraction}: Back reveals the Workspace, not Chat (${workspace.right} vs ${pkg.left})`);
      } else {
        assert.ok(workspace.left <= pkg.right + 0.5, `pop ${dir} @${fraction}: Back reveals the Workspace, not Chat`);
      }
    }
    // Settled: the Workspace is back at the origin, the package fully gone.
    const settled = await rectOf("#wsPanel");
    assert.ok(Math.abs(settled.left) < 0.5, `${dir}: the Workspace settles at the origin`);
    assert.ok(Math.abs((await rectOf("#pkg")).left) >= WIDTH - 0.5, `${dir}: the package ends one screen away`);
  }
});

test("a covered Workspace stops painting once it has retreated", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load(fixture({ withPackage: false, workspaceStack: "covered" }));
  await freeze("#wsPanel", "stack-cover", 0.5);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#wsPanel")!).visibility), "visible",
    "it stays visible for the whole retreat");
  await freeze("#wsPanel", "stack-cover", 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#wsPanel")!).visibility), "hidden",
    "…and stops painting under the opaque package afterwards");
});

test("taps never fall through the Workspace onto the session header", { skip: !CHROME }, async () => {
  assert.ok(page);
  const hit = (x: number, y: number) => page!.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px as number, py as number);
    return el ? (el.id || el.className || el.tagName).toString() : null;
  }, [x, y] as const);

  // Push: the package is arriving and the strip it has not covered yet still
  // shows the covered Workspace. A tap there is swallowed, not sent to Menu.
  await load(fixture({ withPackage: true, workspaceStack: "covered" }));
  await freeze("#pkg", "stack-in", 0.1);
  await freeze("#wsPanel", "stack-cover", 0.1);
  const pkgLeft = (await rectOf("#pkg")).left;
  assert.ok(pkgLeft > 80, `the package has only just started to cover the screen (${pkgLeft})`);
  assert.notEqual(await hit(20, 20), "float", "a tap in the exposed strip does not reach the session header");

  // Pop: for the whole settle the revealed Workspace swallows taps, so a second
  // tap on the package's Back control cannot land on Edit; afterwards it works.
  await load(fixture({ withPackage: true, workspaceStack: "revealed", pane: "rail rail-workspace rail-fullscreen rail-exiting" }));
  await freeze("#pkg", "stack-out", 1);
  await freeze("#wsPanel", "stack-uncover", 0.5);
  await freeze("#wsPanel", "stack-dim-out", 0.5);
  assert.notEqual(await hit(30, 30), "edit", "mid-settle the veil swallows the tap");
  await freeze("#wsPanel", "stack-uncover", 1);
  await freeze("#wsPanel", "stack-dim-out", 1);
  assert.equal(await hit(30, 30), "edit", "once settled the Workspace is fully interactive");
});

test("a released swipe finishes both layers together, from the finger, in the rest of the travel", { skip: !CHROME }, async () => {
  assert.ok(page);
  const durations = () => page!.evaluate(() => document.getAnimations().map((animation) => {
    const target = (animation.effect as KeyframeEffect).target as Element;
    return `${target.id}:${(animation as CSSAnimation).animationName}:${animation.effect!.getComputedTiming().duration}`;
  }).sort());
  for (const dir of ["ltr", "rtl"] as const) {
    // edgeSwipeBack.ts released the package 200px along; both layers carry on in 150ms.
    const progress = 200 / WIDTH;
    await load(fixture({ withPackage: true, workspaceStack: "revealed", pane: "rail rail-workspace rail-fullscreen rail-exiting" }), dir);
    await page.evaluate((remaining) => {
      const pkg = document.getElementById("pkg")!;
      pkg.style.setProperty("--stack-from", "200px");
      pkg.style.setProperty("--stack-out-settle", "150ms");
      const ws = document.getElementById("ws")!;
      ws.style.setProperty("--stack-uncover-from", `calc(var(--stack-dir, 1) * var(--stack-parallax, 28%) * -${remaining})`);
      ws.style.setProperty("--stack-dim-from", String(remaining));
      ws.style.setProperty("--stack-uncover-settle", "150ms");
    }, (1 - progress).toFixed(4));
    assert.deepEqual(await durations(), ["pkg:stack-out:150", "wsPanel:stack-dim-out:150", "wsPanel:stack-uncover:150"],
      `${dir}: the pair shares one shortened duration`);
    await freeze("#pkg", "stack-out", 0);
    const start = await rectOf("#pkg");
    assert.ok(Math.abs(Math.abs(start.left) - 200) < 0.5, `${dir}: the exit starts where the finger let go (${start.left})`);
    for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      await freeze("#pkg", "stack-out", fraction);
      await freeze("#wsPanel", "stack-uncover", fraction);
      const [pkg, workspace] = [await rectOf("#pkg"), await rectOf("#wsPanel")];
      if (dir === "ltr") assert.ok(workspace.right >= pkg.left - 0.5, `${dir} @${fraction}: no gap (${workspace.right} vs ${pkg.left})`);
      else assert.ok(workspace.left <= pkg.right + 0.5, `${dir} @${fraction}: no gap`);
    }

    // PhoneShellSwipes.tsx released a Workspace pulled in from Chat 120px short of home.
    await load(fixture({ withPackage: false, workspaceStack: "enter" }), dir);
    await page.evaluate(() => {
      const panel = document.getElementById("wsPanel")!;
      panel.setAttribute("data-swipe-handoff", "enter");
      panel.style.setProperty("--stack-enter-from", "120px");
      panel.style.setProperty("--stack-in-settle", "180ms");
    });
    assert.deepEqual(await durations(), ["wsPanel:stack-swipe-in:180"], `${dir}: the arrival carries on from the finger`);
    await freeze("#wsPanel", "stack-swipe-in", 0);
    const from = await rectOf("#wsPanel");
    assert.ok(Math.abs(Math.abs(from.left) - 120) < 0.5, `${dir}: it starts 120px out (${from.left})`);
    assert.equal(Math.sign(from.left), dir === "ltr" ? 1 : -1, `${dir}: on the inline-end side`);
    await freeze("#wsPanel", "stack-swipe-in", 1);
    assert.ok(Math.abs((await rectOf("#wsPanel")).left) < 0.5, `${dir}: and lands home`);
  }
  // A tap keeps the grammar's own duration.
  await load(fixture({ withPackage: false, workspaceStack: "enter" }));
  assert.deepEqual(await durations(), ["wsPanel:stack-in:300"]);
});

test("a Workspace that settled back from a package window answers the next Back swipe", { skip: !CHROME }, async () => {
  assert.ok(page);
  await load(fixture({ withPackage: false, workspaceStack: "revealed" }));
  // The settle has run its course: nothing it leaves behind may outrank the
  // inline transform the next swipe paints (a forwards fill would freeze the
  // layer under the finger until it remounts).
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
  const fill = await page.evaluate(() => getComputedStyle(document.querySelector("#wsPanel")!).animationFillMode);
  assert.notEqual(fill, "both");
  assert.notEqual(fill, "forwards");
  await page.evaluate(() => { document.querySelector<HTMLElement>("#wsPanel")!.style.transform = "translate3d(120px, 0, 0)"; });
  assert.equal((await rectOf("#wsPanel")).left, 120, "the layer follows the finger");
});
