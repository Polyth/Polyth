// The launcher column never changes when a package window opens, pins, fills
// the workspace or leaves — in every interface style and window layout.
// Measured in a real browser against the real cascade (skipped without one):
// a launcher that moves by a pixel, or a window whose top edge sits a pixel
// off the rail's, is exactly what the eye catches as a jerk or a crooked line.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";
import { SHELL_LOOKS } from "../src/uiPrefs.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
/** Wide enough for the full-height strip (the app-shell container is over 1400px). */
const WIDE = { width: 1680, height: 1000 };
/** Inside the 961–1400px band, where the launchers idle as a floating cluster. */
const BAND = { width: 1200, height: 900 };
const RAIL_W = 480;

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";

before(async () => {
  if (!CHROME) return;
  // main.tsx's order for the sheets that shape the shell.
  const sheets = await Promise.all([
    "../src/tokens.css", "../src/styles.css", "../src/moduleContent.css", "../src/stackNavigation.css",
    "../src/fluentTheme.css", "../src/macosTheme.css", "../src/liquidGlassTheme.css",
    "../src/shellLayout.css", "../src/shellLooks.css",
  ].map(read));
  css = sheets.map((sheet) => sheet.replace(/@import[^;]+;/g, "")).join("\n");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: WIDE });
});

after(async () => {
  await browser?.close();
});

type State = "idle" | "floating" | "docked" | "layer" | "leaving" | "bottom" | "narrow";
interface Shape {
  look: string;
  layout: "classic" | "columns" | "bare";
  floating: boolean;
  borderless?: boolean;
  mirror?: boolean;
  /** The desktop app, with its window controls on this side. */
  desktop?: "left" | "right";
  /** --corner-radius-scale: 1.8 is the default Corner rounding, 2.7 the most. */
  scale?: number;
}

const PANE: Record<Exclude<State, "idle">, string> = {
  floating: "rail rail-workspace rail-dynamic",
  docked: "rail rail-workspace rail-pinned",
  layer: "rail rail-workspace rail-fullscreen",
  leaving: "rail rail-workspace rail-dynamic rail-exiting",
  bottom: "rail rail-workspace rail-pinned rail-dock-bottom",
  narrow: "rail rail-workspace rail-pinned rail-pinned-narrow",
};

/** ContextRail's DOM in one state, every animation landed on its last frame.
 *  The cascade is parsed once; each reading swaps the shell under it. */
let ready = false;
async function load(shape: Shape, state: State, at: "end" | "start" = "end", viewport = WIDE) {
  assert.ok(page);
  if (!ready) {
    await page.setContent(`<style>${css}</style><style>html, body { margin: 0; }</style><div id="root"></div>`);
    ready = true;
  }
  await page.setViewportSize(viewport);
  const open = state !== "idle" && state !== "leaving";
  const motion = state === "idle" ? "idle" : state === "leaving" ? "exiting" : "open";
  const dynamic = state === "floating" || state === "leaving";
  const pane = state === "idle" ? "" : `
          <div class="${PANE[state]}" id="pkg" data-rail-motion="${motion}"
            style="--rail-w: ${RAIL_W}px; --package-window-x: 0px; --package-window-y: 0px">
            <section class="module-view module-view--rail"><div class="module-view-body">Package</div></section>
          </div>`;
  const shell = `
    <div class="app"${shape.mirror ? ' data-shell-mirror="true"' : ""}>
      <div class="app-shell"${shape.mirror ? ' dir="rtl"' : ""}>
        <main class="workspace"${shape.mirror ? ' dir="ltr"' : ""}></main>
        <aside class="railbar${open ? " railbar-open" : ""}${dynamic ? " railbar-dynamic" : ""}${state === "bottom" ? " railbar-dock-bottom" : ""}${state === "narrow" ? " railbar-pinned-narrow" : ""}" data-rail-motion="${motion}" id="host">${pane}
          <div class="rail-icon-col plugin-strip customize-zone" id="strip">
            <div class="rail-icon-scroll">
              <button class="rail-icon strip-btn${open ? " active" : ""}" id="first" aria-label="Git">G</button>
              <button class="rail-icon strip-btn" id="second" aria-label="Files">F</button>
            </div>
          </div>
        </aside>
      </div>
    </div>`;
  return page.evaluate(({ shell, look, layout, floating, borderless, desktop, at, scale }) => {
    const body = document.body;
    body.dataset.shellLook = look;
    body.dataset.shellLayout = layout;
    body.dataset.shellFloating = String(floating);
    body.dataset.hideBorders = String(borderless);
    body.classList.toggle("desktop-app", desktop !== null);
    if (desktop !== null) body.dataset.desktopCaption = desktop;
    else delete body.dataset.desktopCaption;
    body.style.setProperty("--corner-radius-scale", String(scale));
    document.getElementById("root")!.innerHTML = shell;
    // Land every entry and exit on its last frame (the settled layout), or
    // hold it on its first (what the eye sees the moment a window opens).
    void body.offsetWidth;
    for (const animation of document.getAnimations()) {
      if (at === "end") animation.finish();
      else { animation.pause(); animation.currentTime = 0; }
    }
    const box = (id: string) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const host = document.getElementById("host")!;
    const strip = document.getElementById("strip")!;
    const hostStyle = getComputedStyle(host);
    const stripStyle = getComputedStyle(strip);
    return {
      host: box("host")!, strip: box("strip")!, first: box("first")!, second: box("second")!, pane: box("pkg"),
      radii: [hostStyle.borderTopLeftRadius, hostStyle.borderTopRightRadius, hostStyle.borderBottomRightRadius, hostStyle.borderBottomLeftRadius].map(Number.parseFloat),
      frame: {
        widths: [hostStyle.borderTopWidth, hostStyle.borderRightWidth, hostStyle.borderBottomWidth, hostStyle.borderLeftWidth].join(" "),
        colors: [hostStyle.borderTopColor, hostStyle.borderRightColor, hostStyle.borderBottomColor, hostStyle.borderLeftColor].join(" "),
        fill: `${hostStyle.backgroundColor} ${hostStyle.backgroundImage}`,
        shadow: hostStyle.boxShadow,
        padding: [hostStyle.paddingTop, hostStyle.paddingBottom].join(" "),
        filter: hostStyle.backdropFilter,
      },
      stripPaint: {
        widths: [stripStyle.borderTopWidth, stripStyle.borderRightWidth, stripStyle.borderBottomWidth, stripStyle.borderLeftWidth].join(" "),
        fill: `${stripStyle.backgroundColor} ${stripStyle.backgroundImage}`,
        filter: stripStyle.backdropFilter,
        shadow: stripStyle.boxShadow,
      },
    };
  }, { shell, look: shape.look, layout: shape.layout, floating: shape.floating, borderless: shape.borderless ?? true, desktop: shape.desktop ?? null, at, scale: shape.scale ?? 1 });
}

const SHAPES: Shape[] = [];
for (const look of SHELL_LOOKS) {
  SHAPES.push({ look, layout: "classic", floating: false });
  for (const layout of ["columns", "bare"] as const) {
    for (const floating of [false, true]) SHAPES.push({ look, layout, floating });
  }
}
// The owner-facing defaults again with borders drawn, and a mirrored shell.
for (const look of SHELL_LOOKS) {
  SHAPES.push({ look, layout: "bare", floating: true, borderless: false });
  SHAPES.push({ look, layout: "bare", floating: true, mirror: true });
}
// The desktop app steps the workspace down for its caption band, on either side.
for (const desktop of ["left", "right"] as const) {
  for (const layout of ["columns", "bare"] as const) {
    for (const look of ["standard", "obsidian"]) SHAPES.push({ look, layout, floating: true, desktop });
  }
}
const name = (shape: Shape) => `${shape.look}/${shape.layout}${shape.floating ? "/floating" : ""}${shape.borderless === false ? "/borders" : ""}${shape.mirror ? "/mirror" : ""}${shape.desktop ? `/desktop-${shape.desktop}` : ""}`;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
const sameBox = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) =>
  near(a.left, b.left) && near(a.top, b.top) && near(a.right, b.right) && near(a.bottom, b.bottom);

test("no launcher moves when a window opens, pins, docks below, fills the workspace or leaves", { skip: !CHROME }, async () => {
  const moved: string[] = [];
  for (const shape of SHAPES) {
    const idle = await load(shape, "idle");
    for (const state of ["floating", "leaving", "docked", "layer", "bottom", "narrow"] as const) {
      const now = await load(shape, state);
      for (const launcher of ["first", "second"] as const) {
        if (!sameBox(idle[launcher], now[launcher])) {
          moved.push(`${name(shape)} ${state}: ${launcher} ${JSON.stringify(idle[launcher])} -> ${JSON.stringify(now[launcher])}`);
        }
      }
    }
  }
  assert.deepEqual(moved, []);
});

test("a floating window's top and bottom edges are the launcher column's own", { skip: !CHROME }, async () => {
  const crooked: string[] = [];
  for (const shape of SHAPES) {
    const open = await load(shape, "floating");
    assert.ok(open.pane, name(shape));
    if (!near(open.pane.top, open.host.top) || !near(open.pane.bottom, open.host.bottom)) {
      crooked.push(`${name(shape)}: window ${open.pane.top}..${open.pane.bottom}, column ${open.host.top}..${open.host.bottom}`);
    }
    // And it meets the strip without a gap or an overlap.
    const seam = shape.mirror ? open.pane.left - open.strip.right : open.strip.left - open.pane.right;
    if (!near(seam, 0)) crooked.push(`${name(shape)}: ${seam}px between window and strip`);
  }
  assert.deepEqual(crooked, []);
});

test("the launcher host keeps its box under a floating window, and an interface style keeps its whole frame", { skip: !CHROME }, async () => {
  const changed: string[] = [];
  for (const shape of SHAPES) {
    // Air and Obsidian grow their classic island into the column on purpose.
    const island = shape.layout === "classic" && (shape.look === "air" || shape.look === "obsidian");
    const idle = await load(shape, "idle");
    const open = await load(shape, "floating");
    if (!island && !sameBox(idle.host, open.host)) changed.push(`${name(shape)}: host box ${JSON.stringify(idle.host)} -> ${JSON.stringify(open.host)}`);
    if (idle.frame.widths !== open.frame.widths) changed.push(`${name(shape)}: border widths ${idle.frame.widths} -> ${open.frame.widths}`);
    if (idle.frame.padding !== open.frame.padding) changed.push(`${name(shape)}: padding ${idle.frame.padding} -> ${open.frame.padding}`);
    if (shape.look === "standard") continue;
    // The base shell hands its glass to the strip; a look keeps fill, edge
    // and shadow on the host and never filters it.
    for (const key of ["colors", "fill", "shadow"] as const) {
      if (idle.frame[key] !== open.frame[key]) changed.push(`${name(shape)}: host ${key} ${idle.frame[key]} -> ${open.frame[key]}`);
    }
    for (const [state, reading] of [["idle", idle], ["floating", open]] as const) {
      if (reading.frame.filter !== "none") changed.push(`${name(shape)} ${state}: the host filters (${reading.frame.filter})`);
      if (reading.stripPaint.widths !== "0px 0px 0px 0px") changed.push(`${name(shape)} ${state}: the strip has borders (${reading.stripPaint.widths})`);
    }
    for (const key of ["fill", "filter", "shadow"] as const) {
      if (idle.stripPaint[key] !== open.stripPaint[key]) changed.push(`${name(shape)}: strip ${key} ${idle.stripPaint[key]} -> ${open.stripPaint[key]}`);
    }
  }
  assert.deepEqual(changed, []);
});

test("in the tablet band the cluster's morph starts and ends on the idle cluster", { skip: !CHROME }, async () => {
  // There the launchers do move: the cluster grows into the column and back
  // (styles.css, rail-host-dock). What may not happen is a step: the first
  // frame of the arrival and the last frame of the departure are the idle
  // cluster, whatever margins an interface style gives its island.
  const stepped: string[] = [];
  for (const shape of SHAPES) {
    if (shape.desktop) continue;
    const idle = await load(shape, "idle", "end", BAND);
    const arriving = await load(shape, "floating", "start", BAND);
    const gone = await load(shape, "leaving", "end", BAND);
    for (const [moment, reading] of [["first frame of the arrival", arriving], ["last frame of the departure", gone]] as const) {
      const off = Math.max(
        Math.abs(reading.first.left - idle.first.left), Math.abs(reading.first.top - idle.first.top),
        Math.abs(reading.second.left - idle.second.left), Math.abs(reading.second.top - idle.second.top),
      );
      if (off > 0.5) stepped.push(`${name(shape)} ${moment}: launcher ${JSON.stringify(idle.first)} -> ${JSON.stringify(reading.first)}`);
    }
  }
  assert.deepEqual(stepped, []);
});

test("the column's corners never round past half its width, so squaring two leaves the others alone", { skip: !CHROME }, async () => {
  // The browser scales all four radii down together once two that share a
  // side add up to more than it. With the idle column rounded past half its
  // width, squaring the corners a window attaches to let the far ones spring
  // out to twice their size, from the default Corner rounding up.
  const sprung: string[] = [];
  for (const shape of SHAPES) {
    if (shape.desktop || shape.borderless === false) continue;
    for (const scale of [1.8, 2.7]) {
      const at = { ...shape, scale };
      const idle = await load(at, "idle");
      const open = await load(at, "floating");
      const width = idle.host.right - idle.host.left;
      const [topStart, topEnd, bottomEnd, bottomStart] = shape.mirror
        ? [idle.radii[1]!, idle.radii[0]!, idle.radii[3]!, idle.radii[2]!]
        : idle.radii as [number, number, number, number];
      if (topStart + topEnd > width + 0.01 || bottomStart + bottomEnd > width + 0.01) {
        sprung.push(`${name(shape)} at scale ${scale}: idle corners ${idle.radii.join("/")} on a ${width}px column`);
      }
      const far = shape.mirror ? [0, 3] : [1, 2];
      for (const corner of far) {
        if (!near(idle.radii[corner]!, open.radii[corner]!)) {
          sprung.push(`${name(shape)} at scale ${scale}: far corner ${idle.radii[corner]} -> ${open.radii[corner]}`);
        }
      }
    }
  }
  assert.deepEqual(sprung, []);
});

test("the island bar stands beside a floating window, never under it, and nothing spills out of it", { skip: !CHROME }, async () => {
  // Header publishes how far a window overlays the workspace's edge
  // (--shell-bar-reserve-right). The capsule padded both sides by that
  // reserve to stay centred: under a wide window the two paddings outgrew
  // the bar and pushed the whole capsule beneath the window.
  const STRIP = 52;
  const island = (reserve: number) => page!.evaluate((reserve) => {
    document.body.dataset.shellBar = "island";
    document.querySelector(".app")!.insertAdjacentHTML("afterbegin", `
      <header class="header header-chat" id="bar" data-shell-bar="island" data-top-rail-surface="floating"
        style="--shell-bar-left: 340px; --shell-bar-right: 0px; --shell-bar-reserve-left: 0px; --shell-bar-reserve-right: ${reserve}px; transition: none">
        <div class="shell-island ui-glass-island" id="island">
          <div class="header-left-cluster" id="lead">
            <div class="workspace-mode-switch-zone customize-zone">
              <div class="workspace-mode-switch" id="tabs"><button class="active">Chat</button><button>Canvas</button><button>Tasks</button></div>
            </div>
            <nav class="view-switcher customize-zone"><div class="view-switcher-pill">
              <button class="view-icon">a</button><button class="view-icon">b</button><button class="view-icon">c</button>
            </div></nav>
          </div>
          <div class="desktop-session-status" id="title"><div class="desktop-session-status-row">
            <button class="desktop-session-status-trigger"><span class="desktop-session-status-copy"><span>A session title long enough to want room</span></span></button>
          </div></div>
          <span class="header-spacer"></span>
          <div class="header-trailing-cluster" id="trail">
            <button class="ui-icon-btn" style="width: 32px">s</button><button class="ui-icon-btn" style="width: 32px">g</button>
            <button class="ui-icon-btn" style="width: 32px">n</button><button class="ui-icon-btn" style="width: 32px">u</button>
          </div>
        </div>
      </header>`);
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return { left: r.left, right: r.right };
    };
    return {
      bar: box("bar"), island: box("island"), lead: box("lead"), tabs: box("tabs"), title: box("title"), trail: box("trail"),
      clip: getComputedStyle(document.getElementById("island")!).overflowX,
    };
  }, reserve);
  const wrong: string[] = [];
  for (const look of SHELL_LOOKS) {
    for (const floating of [false, true]) {
      const shape: Shape = { look, layout: "columns", floating };
      // The window leaves the bar 720px, 440px, then 240px and 80px beside
      // it at this width: the last two are less than a title and the actions
      // need, so there the capsule only has to hold what it cannot show.
      for (const reserve of [STRIP, 620, 900, 1100, 1260]) {
        await load(shape, "idle");
        const at = await island(reserve);
        const label = `${name(shape)} reserve ${reserve}`;
        const end = at.bar.right - reserve;
        if (at.island.right > end + 0.5) wrong.push(`${label}: the capsule ends at ${at.island.right}, the window starts at ${end}`);
        if (at.island.left < at.bar.left - 0.5) wrong.push(`${label}: the capsule starts at ${at.island.left}, before the bar at ${at.bar.left}`);
        if (reserve === STRIP && Math.abs((at.island.left + at.island.right) - (at.bar.left + at.bar.right)) > 1) {
          wrong.push(`${label}: the capsule ${JSON.stringify(at.island)} is not centred on the workspace ${JSON.stringify(at.bar)}`);
        }
        if (at.clip !== "clip") wrong.push(`${label}: the capsule does not clip what it cannot show (${at.clip})`);
        if (reserve > 900) continue;
        if (at.lead.left < at.island.left - 0.5 || at.trail.right > at.island.right + 0.5) {
          wrong.push(`${label}: content ${at.lead.left}..${at.trail.right} leaves the capsule ${at.island.left}..${at.island.right}`);
        }
        if (at.tabs.right > at.lead.right + 0.5 || at.lead.right > at.title.left + 0.5 || at.title.right > at.trail.left + 0.5) {
          wrong.push(`${label}: tabs ..${at.tabs.right}, tools ..${at.lead.right}, title ${at.title.left}..${at.title.right}, actions ${at.trail.left}.. overlap`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});
