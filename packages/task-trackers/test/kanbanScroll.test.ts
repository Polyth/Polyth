// Wheel-scroll geometry for the kanban board, in a real browser with the real
// stylesheets. Reported breakage: the wheel over a card, an empty column or
// the pane's inner edge did nothing; only the pane's bare edge scrolled.
// Cause: the pane kept its height but the board only had `min-height: 100%`,
// so the grid row stayed content-sized, every column grew to its cards, the
// card list never overflowed, and `overscroll-behavior: contain` on that
// non-scrolling list swallowed the wheel before the pane saw it.
// Contract: in a fixed-height pane each column's own cards scroll under a
// fixed title and nothing else moves; on a package page the window body
// scrolls wherever the pointer is.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { findChromium } from "../../../apps/web/test/chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { KanbanBoard } = await import("../widgets/kanban.tsx");

const css = [
  "../../../apps/web/src/tokens.css",
  "../../../apps/web/src/styles.css",
  "../widgets/styles.css",
].map((path) => readFileSync(resolve(import.meta.dirname, path), "utf8")).join("\n");

const COLUMNS = [
  { id: "c1", name: "To do 3", category: "todo", statusIds: ["todo"] },
  { id: "c2", name: "Doing", category: "in_progress", statusIds: ["doing"] },
  { id: "c3", name: "Done", category: "done", statusIds: ["done"] },
] as never;

const card = (id: string, statusId: string) => ({
  provider: "trello",
  id,
  key: id,
  title: `Card ${id}`,
  url: "",
  status: { id: statusId, name: statusId, category: "todo" },
  board: { id: "board", name: "Board" },
  assignees: [],
  labels: [],
});

/** A crowded first column, an empty second one and a short last one: the
 *  three places the wheel was reported dead. */
const lanes = COLUMNS.map((column: { id: string; name: string; category: string; statusIds: string[] }, index: number) => ({
  id: column.id,
  name: column.name,
  category: column.category,
  column,
  tasks: index === 0
    ? Array.from({ length: 30 }, (_, i) => card(`t${i}`, "todo"))
    : index === 1 ? [] : Array.from({ length: 3 }, (_, i) => card(`d${i}`, "done")),
}));

const board = renderToStaticMarkup(createElement(KanbanBoard, {
  label: "Board",
  provider: "trello",
  lanes,
  columns: { columns: COLUMNS, editable: true, removal: "delete" } as never,
  canWrite: true,
  canMove: true,
  totalOf: () => 0,
  renderCard: (task: { id: string }) => createElement("article", { className: "tt-task-card" }, task.id),
  onMove: () => {},
  onCreate: async () => true,
  onRename: async () => true,
  onReorder: () => {},
  onRemove: () => {},
} as never));

let browser: Browser | null = null;
before(async () => {
  if (!CHROME) return;
  browser = await import("playwright-core").then(({ chromium }) => chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  }));
});
after(async () => { await browser?.close(); });

interface Shell {
  page: Page;
  /** The element that scrolls vertically: the board pane, or a page's body. */
  scroller: string;
}

/** The board in a board pane (`fixed`) or on a package page that grows with
 *  its content (`page`). */
async function open(kind: "fixed" | "page", width: number, height: number): Promise<Shell> {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: width + 40, height: height + 40 } });
  await page.route("**/*", (route) => route.abort());
  const shell = kind === "page"
    ? `<div class="tt-page"><div class="tt-page-panel"><div class="tt-page-scroll"><div class="tt-board">${board}</div></div></div></div>`
    : `<div class="probe"><div class="tt-board"><div class="tt-board-content"><main class="tt-task-surface">${board}</main></div></div></div>`;
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}
    html, body { margin: 0; height: 100%; }
    .probe { display: flex; width: ${width}px; height: ${height}px; padding: 12px; }
    .tt-page { width: ${width}px; height: ${height}px; }
  </style></head><body>${shell}</body></html>`);
  await page.waitForTimeout(150);
  return { page, scroller: kind === "page" ? ".tt-page-scroll" : ".tt-task-surface" };
}

interface Geometry {
  scrollerTop: number; scrollerClient: number; scrollerScroll: number;
  cards: { client: number; scroll: number; top: number }[];
  headerTop: number;
}

const measure = (page: Page, scroller: string): Promise<Geometry> => page.evaluate((selector) => {
  const pane = document.querySelector(selector) as HTMLElement;
  return {
    scrollerTop: pane.scrollTop,
    scrollerClient: pane.clientHeight,
    scrollerScroll: pane.scrollHeight,
    cards: [...document.querySelectorAll(".tt-column")].map((column) => {
      const list = column.querySelector(".tt-column-cards") as HTMLElement;
      return {
        client: list.clientHeight,
        scroll: list.scrollHeight,
        top: Math.round(list.getBoundingClientRect().top),
      };
    }),
    headerTop: Math.round(document.querySelector(".tt-column > header")!.getBoundingClientRect().top),
  };
}, scroller);

/** One wheel notch over the centre-top of `selector`; returns the scroll
 *  positions it produced. */
async function wheelOver(page: Page, selector: string, deltaY = 300) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} is laid out`);
  await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const pane = (document.querySelector(".tt-page-scroll") ?? document.querySelector(".tt-task-surface")) as HTMLElement;
    return {
      pane: pane.scrollTop,
      cards: [...document.querySelectorAll(".tt-column-cards")].map((list) => (list as HTMLElement).scrollTop),
    };
  });
}

test("over a card, the wheel scrolls that column's cards and nothing else", { skip: !CHROME }, async () => {
  const { page, scroller } = await open("fixed", 1200, 720);
  try {
    const before = await measure(page, scroller);
    assert.equal(before.scrollerScroll, before.scrollerClient, "the fixed pane has no vertical overflow");
    assert.ok(before.cards[0]!.scroll > before.cards[0]!.client + 200,
      `the crowded column's cards overflow its lane (${before.cards[0]!.scroll}px of ${before.cards[0]!.client}px)`);
    assert.ok(before.cards[0]!.client + before.cards[0]!.top <= before.scrollerClient + before.scrollerTop,
      "the card list ends inside the pane");

    const after = await wheelOver(page, ".tt-card-drag");
    assert.ok(after.cards[0]! > 100, `the column's cards scrolled (${after.cards[0]}px)`);
    assert.deepEqual(after.cards.slice(1), [0, 0], "no other column moved");
    assert.equal(after.pane, 0, "the pane itself stayed put");
    const now = await measure(page, scroller);
    assert.equal(now.headerTop, before.headerTop, "the column title stayed fixed at the top");
  } finally {
    await page.close();
  }
});

test("over an empty column, the wheel leaves the board where it is", { skip: !CHROME }, async () => {
  const { page, scroller } = await open("fixed", 1200, 720);
  try {
    const before = await measure(page, scroller);
    const after = await wheelOver(page, ".tt-column:nth-of-type(2) .tt-column-cards");
    assert.equal(after.pane, 0, "the pane did not jump");
    assert.deepEqual(after.cards, [0, 0, 0], "no column scrolled on its own");
    assert.equal(before.scrollerScroll, before.scrollerClient, "and there is nothing to scroll: the empty lane is not the scroller");
  } finally {
    await page.close();
  }
});

test("a phone-height board still scrolls one column at a time", { skip: !CHROME }, async () => {
  const { page, scroller } = await open("fixed", 480, 640);
  try {
    const before = await measure(page, scroller);
    assert.equal(before.scrollerScroll, before.scrollerClient, "the narrow pane has no vertical overflow");
    const after = await wheelOver(page, ".tt-card-drag");
    assert.ok(after.cards[0]! > 100, `the column's cards scrolled (${after.cards[0]}px)`);
    assert.equal(after.pane, 0, "the pane stayed put");
  } finally {
    await page.close();
  }
});

test("on a package page the wheel scrolls the window body over a column", { skip: !CHROME }, async () => {
  const { page, scroller } = await open("page", 1000, 800);
  try {
    const before = await measure(page, scroller);
    assert.ok(before.scrollerScroll > before.scrollerClient + 200,
      `the page has content below the fold (${before.scrollerScroll}px of ${before.scrollerClient}px)`);
    const overCard = await wheelOver(page, ".tt-card-drag");
    assert.ok(overCard.pane > 100, `the page scrolled over a card (${overCard.pane}px)`);
    await page.evaluate((selector) => { (document.querySelector(selector) as HTMLElement).scrollTop = 0; }, scroller);
    const overEmpty = await wheelOver(page, ".tt-column:nth-of-type(2) .tt-column-cards");
    assert.ok(overEmpty.pane > 100, `the page scrolled over an empty column (${overEmpty.pane}px)`);
  } finally {
    await page.close();
  }
});
