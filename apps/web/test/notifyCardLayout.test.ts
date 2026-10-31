// Geometry contract for the transient notification card, in a real browser
// with the real stylesheets. The card is a two-track grid (glyph, text) inside
// one padded box, with the close pinned in the corner rather than owning a
// column. Reported breakages: an asymmetric box (12px of padding on the left
// against 8px on the right); text sitting low against the glyph; and a dead
// rail down the right, where a close column the card's full height stopped
// the body and the action row ~36px short of the edge while the buttons
// hugged the left. So: the glyph and the X's painted stroke sit the same
// distance from their own card edge; a title with a body starts on the
// glyph's top edge and a title alone centres on it; only the title steps
// around the close, and the body and the actions run to the content's right
// edge. The card's own box is transform-scaled by the entry animation (scale:
// 0.95), so this test reads the resting layout with animations off; measuring
// a mount-time frame would report every dimension 5% small. The update notice
// (webUpdateNotice.ts) is the reference payload: a title, a body and two
// labelled actions.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { chromium, type Browser } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: NotificationStack } = await import("../src/notify/NotificationStack.tsx");
const store = await import("../src/notify/store.ts");

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const css = ["tokens.css", "styles.css", "moduleContent.css", "notify/notify.css"]
  .map((name) => read(`../src/${name}`)).join("\n");

/** The card as webUpdateNotice.ts publishes it, plus a body-less kind and an
 *  undismissible one (no close track) so every grid shape is covered. */
async function cardMarkup(payload: Parameters<typeof store.notify>[0]): Promise<string> {
  store.resetNotifications();
  await act(async () => { store.notify(payload); });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(NotificationStack)); });
    return container.innerHTML;
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    store.resetNotifications();
  }
}

const UPDATE = {
  id: "host.web-update",
  kind: "update" as const,
  title: "Polyth has been updated",
  body: "Reload to use the new version.",
  duration: "sticky" as const,
  actions: [
    { label: "Reload", primary: true, run: () => {} },
    { label: "Later", run: () => {} },
  ],
};

interface Geometry {
  glyphGap: number; closeGap: number | null;
  glyphLeftInset: number; actionsLeftInset: number; closeRightInset: number;
  titleLeft: number; actionsRight: number; contentRight: number;
  titleRight: number; closeLeft: number;
  firstLineCentreY: number;
  glyphTop: number; titleTop: number; closeTop: number | null;
  /** The close X's painted stroke, not its 24px box: the box carries empty
   *  padding the eye does not read as an inset. Measured from the card's own
   *  edge, the same datum as glyphGap. */
  closeInkTop: number | null; closeInkGap: number | null;
  closeInkLeft: number | null; closeInkWidth: number | null;
  cardWidth: number;
  overflowX: boolean; cardOverflowX: boolean;
  glyphOuter: number; trackGlyph: number; middleTrack: number; trackClose: number | null; closeWidth: number | null;
  /** What a finger can actually reach inside the card's clip, around the
   *  close: the --tap floor applies to this, not to the control's box. */
  hitWidth: number | null; hitHeight: number | null;
  titleWidth: number; gap: number;
  /** Vertical centres, for a title alone beside the glyph. */
  glyphCentreY: number; lineCentreY: number; closeInkCentreY: number | null;
  /** Right edges against the content box's right edge (0 = flush). */
  bodyRight: number | null; lastActionRight: number | null;
  /** The title's text box (inside its padding) against the close's box. */
  titleTextRight: number; closeBoxLeft: number | null;
}

let browser: Browser | null = null;
before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  });
});
after(async () => { await browser?.close(); });

/** Lay the real markup out in Chromium and read its box model. */
async function measureInBrowser(markup: string, width: number, touch = false): Promise<Geometry> {
  assert.ok(browser);
  const context = await browser.newContext({ hasTouch: touch });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
      <style>${css}</style>
      <style>html, body { margin: 0; }
        /* Read the resting layout: the entry spring starts at scale(0.95). */
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .notify-stack { position: static !important; block-size: auto !important; height: auto !important; }
        .notify-card { position: static !important; transform: none !important; height: auto !important; }
        .notify-card[data-folded] { display: none !important; }</style></head>
      <body>${markup}</body></html>`);
    return await page.evaluate((): Geometry => {
      const card = document.querySelector<HTMLElement>(".notify-card:not([data-folded])")!;
      const inner = card.querySelector<HTMLElement>(".notify-card-inner")!;
      const ics = getComputedStyle(inner);
      const px = (value: string) => parseFloat(value) || 0;
      const cardBox = card.getBoundingClientRect();
      const innerBox = inner.getBoundingClientRect();
      const contentLeft = innerBox.left + px(ics.borderLeftWidth) + px(ics.paddingLeft);
      const contentRight = innerBox.right - px(ics.borderRightWidth) - px(ics.paddingRight);
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const glyph = card.querySelector<HTMLElement>(".notify-glyph")!;
      const glyphBox = glyph.getBoundingClientRect();
      const titleBox = card.querySelector<HTMLElement>(".notify-title")!.getBoundingClientRect();
      const close = card.querySelector<HTMLElement>(".notify-close");
      const closeBox = box(close);
      const closeSvg = close?.querySelector<SVGSVGElement>("svg") ?? null;
      // A lucide glyph paints less than its box: the stroke's own bounds are
      // what a person sees sitting on the card's corner.
      const closeInk = (() => {
        if (!closeSvg) return null;
        const svgBox = closeSvg.getBoundingClientRect();
        const bbox = closeSvg.getBBox();
        const viewBox = closeSvg.viewBox.baseVal;
        const sx = svgBox.width / viewBox.width;
        const sy = svgBox.height / viewBox.height;
        const stroke = parseFloat(getComputedStyle(closeSvg).strokeWidth) || 0;
        const half = (stroke * Math.min(sx, sy)) / 2;
        return {
          top: svgBox.top + (bbox.y - viewBox.y) * sy - half,
          left: svgBox.left + (bbox.x - viewBox.x) * sx - half,
          width: bbox.width * sx + 2 * half,
          height: bbox.height * sy + 2 * half,
        };
      })();
      const actions = box(card.querySelector<HTMLElement>(".notify-actions"));
      const body = box(card.querySelector<HTMLElement>(".notify-body"));
      const actionButtons = [...card.querySelectorAll<HTMLElement>(".notify-actions .notify-action")];
      const lastAction = actionButtons.length ? Math.max(...actionButtons.map((el) => el.getBoundingClientRect().right)) : null;
      const titleEl = card.querySelector<HTMLElement>(".notify-title")!;
      const titleLine = (() => {
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        return range.getClientRects()[0] ?? titleBox;
      })();
      const tracks = ics.gridTemplateColumns.split(" ").map((value) => px(value));
      return {
        glyphGap: +(glyphBox.left - cardBox.left).toFixed(2),
        closeGap: closeBox ? +(cardBox.right - closeBox.right).toFixed(2) : null,
        glyphLeftInset: +(glyphBox.left - contentLeft).toFixed(2),
        actionsLeftInset: actions ? +(actions.left - contentLeft).toFixed(2) : 0,
        closeRightInset: closeBox ? +(contentRight - closeBox.right).toFixed(2) : 0,
        titleLeft: +(titleBox.left - contentLeft).toFixed(2),
        actionsRight: actions ? +(actions.right - contentRight).toFixed(2) : 0,
        contentRight,
        titleRight: +(contentRight - titleBox.right).toFixed(2),
        closeLeft: closeBox ? +(closeBox.left - contentLeft).toFixed(2) : 0,
        glyphTop: +glyphBox.top.toFixed(2),
        titleTop: +titleBox.top.toFixed(2),
        closeTop: closeBox ? +closeBox.top.toFixed(2) : null,
        closeInkTop: closeInk ? +closeInk.top.toFixed(2) : null,
        closeInkGap: closeInk ? +(cardBox.right - (closeInk.left + closeInk.width)).toFixed(2) : null,
        closeInkLeft: closeInk ? +(closeInk.left - contentLeft).toFixed(2) : null,
        closeInkWidth: closeInk ? +closeInk.width.toFixed(2) : null,
        cardWidth: +cardBox.width.toFixed(2),
        // A wrapped title's box centre is the whole block's; its first line is
        // the one that shares the glyph's top edge.
        firstLineCentreY: +(() => {
          const title = card.querySelector<HTMLElement>(".notify-title")!;
          const range = document.createRange();
          range.selectNodeContents(title);
          const line = range.getClientRects()[0];
          if (!line) return titleBox.top;
          return line.top;
        })().toFixed(2),
        overflowX: inner.scrollWidth > inner.clientWidth,
        cardOverflowX: card.scrollWidth > card.clientWidth,
        // The reachable hit area: sample the card's corner and ask what sits
        // under each point, so the card's rounded clip is accounted for.
        hitWidth: (() => {
          if (!close) return null;
          let min = Infinity, max = -Infinity;
          for (let x = cardBox.right - 60; x <= cardBox.right + 1; x += 1) {
            const el = document.elementFromPoint(x, closeBox!.top + closeBox!.height / 2);
            if (!el || !(el === close || close.contains(el))) continue;
            min = Math.min(min, x); max = Math.max(max, x);
          }
          return max >= min ? +(max - min + 1).toFixed(1) : 0;
        })(),
        hitHeight: (() => {
          if (!close) return null;
          let min = Infinity, max = -Infinity;
          for (let y = cardBox.top - 1; y <= cardBox.top + 60; y += 1) {
            const el = document.elementFromPoint(closeBox!.left + closeBox!.width / 2, y);
            if (!el || !(el === close || close.contains(el))) continue;
            min = Math.min(min, y); max = Math.max(max, y);
          }
          return max >= min ? +(max - min + 1).toFixed(1) : 0;
        })(),
        glyphOuter: +glyphBox.width.toFixed(2),
        titleWidth: +titleBox.width.toFixed(2),
        glyphCentreY: +(glyphBox.top + glyphBox.height / 2).toFixed(2),
        lineCentreY: +(titleLine.top + titleLine.height / 2).toFixed(2),
        closeInkCentreY: closeInk ? +(closeInk.top + closeInk.height / 2).toFixed(2) : null,
        bodyRight: body ? +(body.right - contentRight).toFixed(2) : null,
        lastActionRight: lastAction === null ? null : +(lastAction - contentRight).toFixed(2),
        titleTextRight: +(titleBox.right - px(getComputedStyle(titleEl).paddingRight)).toFixed(2),
        closeBoxLeft: closeBox ? +closeBox.left.toFixed(2) : null,
        middleTrack: tracks.length === 3 ? tracks[1]! : 0,
        gap: px(ics.columnGap),
        trackGlyph: tracks[0] ?? 0,
        trackClose: tracks.length === 3 ? tracks[2]! : null,
        closeWidth: closeBox ? +closeBox.width.toFixed(2) : null,
      };
    });
  } finally {
    await page.close();
    await context.close();
  }
}

const CASES = [
  { name: "update notice", payload: UPDATE, closes: true, hasBody: true },
  { name: "body-less success", payload: { id: "ok", kind: "success" as const, title: "Copied", duration: 5000 }, closes: true, hasBody: false },
  { name: "undismissible progress", payload: { id: "run", kind: "progress" as const, title: "Running", dismissible: false, duration: "sticky" as const }, closes: false, hasBody: false },
  { name: "long translated title", payload: { ...UPDATE, id: "long", title: "Політ було оновлено — перезавантажте, щоб перейти на нову версію" }, closes: true, hasBody: true },
];

for (const testCase of CASES) {
  test(`the card's box is symmetric, narrow, top-aligned and filled to its right edge: ${testCase.name}`, { skip: !CHROME }, async () => {
    const markup = await cardMarkup(testCase.payload);
    for (const width of [1280, 900, 640, 380]) {
      const geometry = await measureInBrowser(markup, width);
      const label = `${testCase.name} @${width}`;
      assert.equal(geometry.overflowX, false, `${label}: the inner box never overflows horizontally`);
      assert.equal(geometry.cardOverflowX, false, `${label}: the card never overflows horizontally`);
      assert.equal(geometry.glyphLeftInset, 0, `${label}: the glyph starts at the content box`);
      // Two tracks: the text column starts after the glyph track and one gap,
      // and the close never takes a column of its own.
      assert.equal(geometry.trackClose, null, `${label}: the close is not a grid track`);
      assert.equal(geometry.glyphLeftInset + geometry.trackGlyph + geometry.gap, geometry.titleLeft, `${label}: the title starts after the glyph track`);
      if (geometry.actionsLeftInset > 0) {
        assert.equal(geometry.actionsLeftInset, geometry.titleLeft, `${label}: the action row aligns with the title`);
      }
      // No dead rail: what sits under the title runs to the content's right
      // edge, so the right inset mirrors the glyph's inset on the left.
      if (geometry.bodyRight !== null) {
        assert.ok(Math.abs(geometry.bodyRight) <= 0.5, `${label}: the body reaches the content's right edge (${geometry.bodyRight}px)`);
      }
      if (geometry.lastActionRight !== null) {
        assert.ok(Math.abs(geometry.lastActionRight) <= 0.5, `${label}: the action row ends on the content's right edge (${geometry.lastActionRight}px)`);
      }
      if (testCase.closes) {
        // What the eye reads as the corner inset is the X's painted stroke, not
        // the 24px control box: a lucide X paints ~57% of its box, so the box
        // is pulled out of its own empty padding. Measured to the ink, the
        // glyph and the close sit the same distance from their own card edge.
        assert.ok(geometry.closeInkTop !== null && geometry.closeInkGap !== null && geometry.closeInkCentreY !== null);
        assert.ok(Math.abs(geometry.closeInkGap - geometry.glyphGap) <= 0.5,
          `${label}: card edges are even to the ink (glyph ${geometry.glyphGap}px, ink ${geometry.closeInkGap}px)`);
        if (testCase.hasBody) {
          assert.ok(Math.abs(geometry.closeInkTop - geometry.glyphTop) <= 0.5,
            `${label}: the X's stroke starts on the glyph's top edge (glyph ${geometry.glyphTop}px, ink ${geometry.closeInkTop}px)`);
        } else {
          assert.ok(Math.abs(geometry.closeInkCentreY - geometry.glyphCentreY) <= 0.5,
            `${label}: beside a title alone the X centres on the glyph (glyph ${geometry.glyphCentreY}px, ink ${geometry.closeInkCentreY}px)`);
        }
        assert.ok(geometry.closeInkLeft !== null && geometry.closeInkWidth !== null);
        assert.ok(geometry.closeInkLeft + geometry.closeInkWidth <= geometry.contentRight + 20,
          `${label}: the X's stroke stays inside the card (inks ends at ${(geometry.closeInkLeft + geometry.closeInkWidth).toFixed(1)}px)`);
        // Only the title steps around the close.
        assert.ok(geometry.closeBoxLeft !== null && geometry.titleTextRight <= geometry.closeBoxLeft + 0.5,
          `${label}: the title's text stops before the close (text ${geometry.titleTextRight}px, close ${geometry.closeBoxLeft}px)`);
      } else {
        assert.equal(geometry.closeGap, null, `${label}: an undismissible card has no close`);
      }
      if (testCase.hasBody) {
        // The text was reported sitting low: with a body, the title's line box
        // starts on the glyph's top edge, so the first line of text sits
        // against the top of the icon rather than around its centre.
        assert.ok(Math.abs(geometry.titleTop - geometry.glyphTop) <= 0.5,
          `${label}: the title's line box starts on the glyph's top edge (glyph ${geometry.glyphTop}px, line ${geometry.titleTop}px)`);
        assert.ok(geometry.firstLineCentreY - geometry.glyphTop >= 0 && geometry.firstLineCentreY - geometry.glyphTop <= 3,
          `${label}: the title's first line sits just under the glyph's top edge (glyph ${geometry.glyphTop}px, line ${geometry.firstLineCentreY}px)`);
      } else {
        // A title alone is one line beside a taller glyph: it centres on it
        // instead of riding its top edge.
        assert.ok(Math.abs(geometry.lineCentreY - geometry.glyphCentreY) <= 1,
          `${label}: a title alone centres on the glyph (glyph ${geometry.glyphCentreY}px, line ${geometry.lineCentreY}px)`);
      }
      assert.ok(geometry.cardWidth <= 340,
        `${label}: the card stays narrow (${geometry.cardWidth}px)`);
      // The glyph fills its own track: a grid track wider than the glyph would
      // shift the text column and leave a visible gap next to the circle.
      assert.ok(Math.abs(geometry.trackGlyph - geometry.glyphOuter) <= 0.5,
        `${label}: the glyph track (${geometry.trackGlyph}px) matches the glyph (${geometry.glyphOuter}px)`);
    }
  });
}

test("on a touch pointer the close keeps its look, gains a --tap hit area and stays off the edge", { skip: !CHROME }, async () => {
  const markup = await cardMarkup(UPDATE);
  for (const width of [1280, 380]) {
    const geometry = await measureInBrowser(markup, width, true);
    const label = `touch @${width}`;
    assert.equal(geometry.closeWidth, 24, `${label}: the close icon keeps its 24px look`);
    // The --tap floor is about what a finger can reach: the invisible hit area
    // is anchored to the control's outer corner, so the card's clip does not
    // eat it.
    assert.ok(geometry.hitWidth !== null && geometry.hitWidth >= 44,
      `${label}: the reachable hit area spans --tap horizontally (${geometry.hitWidth}px)`);
    assert.ok(geometry.hitHeight !== null && geometry.hitHeight >= 44,
      `${label}: the reachable hit area spans --tap vertically (${geometry.hitHeight}px)`);
    assert.ok(Math.abs(geometry.closeInkGap! - geometry.glyphGap) <= 0.5,
      `${label}: the ink stays even with the glyph edge (glyph ${geometry.glyphGap}px, ink ${geometry.closeInkGap}px)`);
    assert.ok(Math.abs(geometry.closeInkTop! - geometry.glyphTop) <= 0.5,
      `${label}: the X's stroke still starts on the glyph's top edge (glyph ${geometry.glyphTop}px, ink ${geometry.closeInkTop}px)`);
    assert.equal(geometry.overflowX, false, `${label}: the inner box still does not overflow`);
  }
});
