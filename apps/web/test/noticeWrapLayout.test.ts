// Geometry contract for the shared Notice row, in a real browser with the real
// stylesheets. A consumer may give the actions a full row on a phone (the
// harness sign-in recovery above the composer does: `width: 100%`); the row
// must then wrap the actions under the copy. Reported breakage: without the
// wrap the copy, whose flex basis is 0, was squeezed to 0px, the heading
// folded one character per line, and the notice grew ~2,000px tall above the
// phone composer, leaving the conversation no height to show or scroll.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

register("./tsxHooks.mjs", import.meta.url);
const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Button, Notice } = await import("../src/components/ui/index.ts");

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const css = ["tokens.css", "styles.css"].map((name) => read(`../src/${name}`)).join("\n");

const notice = renderToStaticMarkup(createElement(Notice, {
  tone: "warning",
  role: "alert",
  heading: "Sign in to Claude Code to continue",
  actions: createElement(Fragment, null,
    createElement(Button, { size: "sm" }, "Sign in"),
    createElement(Button, { size: "sm", variant: "ghost" }, "I’ve signed in")),
}, "Your conversation is safe. Sign in again, then Polyth will verify this harness and continue the recovery flow."));

interface Geometry {
  copyWidth: number; copyBottom: number;
  actionsTop: number; actionsWidth: number;
  noticeWidth: number; noticeHeight: number;
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

/** Lay the notice out in a column of `width` px; `fullRow` applies the
 *  consumer rule that gives the actions their own full-width row. */
async function measure(width: number, fullRow: boolean): Promise<Geometry> {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
      <style>${css}</style>
      <style>html, body { margin: 0; }
        .probe { width: ${width}px; }
        .probe.full-row .ui-notice-actions { margin-left: 0; width: 100%; }</style></head>
      <body><div class="probe${fullRow ? " full-row" : ""}">${notice}</div></body></html>`);
    return await page.evaluate((): Geometry => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const copy = rect(".ui-notice-copy");
      const actions = rect(".ui-notice-actions");
      const box = rect(".ui-notice");
      return {
        copyWidth: copy.width, copyBottom: copy.bottom,
        actionsTop: actions.top, actionsWidth: actions.width,
        noticeWidth: box.width, noticeHeight: box.height,
      };
    });
  } finally {
    await page.close();
  }
}

test("full-row actions wrap under the copy instead of squeezing it to nothing", { skip: !CHROME }, async () => {
  const phone = await measure(342, true);
  assert.ok(phone.copyWidth > 200, `copy keeps a readable measure (${phone.copyWidth}px of ${phone.noticeWidth}px)`);
  assert.ok(phone.actionsTop >= phone.copyBottom, "the actions start below the copy");
  assert.ok(phone.noticeHeight < 300, `the notice stays a short card (${phone.noticeHeight}px tall)`);
});

test("actions that fit stay on the copy's row", { skip: !CHROME }, async () => {
  const wide = await measure(652, false);
  assert.ok(wide.actionsTop < wide.copyBottom, "the actions share the copy's row");
  assert.ok(wide.copyWidth + wide.actionsWidth < wide.noticeWidth, "copy and actions sit side by side");
});
