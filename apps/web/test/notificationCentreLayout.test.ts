// Geometry contract for the notification centre's rows in a narrow rail panel,
// in a real browser with the real stylesheets. The rows once gave the date a
// grid column of its own: ~100px of a ~265px row went to a no-wrap date and the
// title was left a sliver that broke a word at a time. The real component is
// mounted in happy-dom and its markup is laid out by Chromium, so a markup or
// CSS change that starves the text column fails here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { chromium, type Browser } from "playwright-core";
import type { NotificationRecord } from "@polyth/contracts";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => ({}), text: async () => "{}",
});
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { setSessions } = await import("../src/store.ts");
const { createNotificationCentre } = await import("../src/notificationCentre.ts");
const { NotificationCentrePanel } = await import("../src/components/NotificationCentre.tsx");
type NotificationCentreRemote = import("../src/notificationCentre.ts").NotificationCentreRemote;

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const css = ["tokens.css", "styles.css", "moduleContent.css", "notify/notify.css"]
  .map((name) => read(`../src/${name}`)).join("\n");

const rec = (over: Partial<NotificationRecord> & { id: string; ts: number }): NotificationRecord => ({
  key: `${over.sessionId ?? "s1"}:turn:idle`, kind: "completed", sessionId: "s1", projectId: "p1",
  title: "Polyth — Твоя задача розібрати перевірити, де треба зафо…",
  body: "Твоя задача розібрати перевірити, де треба зафо… — finished",
  read: false, ...over,
});

/** The real panel's markup: a long unread title, a read one, a dead session
 *  (its note gets a line of its own) and a kind whose label is long. */
async function panelMarkup(): Promise<string> {
  setSessions("p1", [{ id: "s1", projectId: "p1", title: "Live", status: "idle", createdAt: 1, updatedAt: 2 }]);
  const items = [
    rec({ id: "a", ts: new Date(2026, 9, 15, 15, 7).getTime() }),
    rec({ id: "b", ts: new Date(2026, 9, 15, 14, 59).getTime(), read: true }),
    rec({ id: "c", ts: new Date(2026, 9, 15, 14, 40).getTime(), kind: "failed", sessionId: "s-gone", title: "Polyth — Build failed", body: "npm run build exited with code 1" }),
    rec({ id: "d", ts: new Date(2026, 9, 15, 14, 0).getTime(), kind: "subagent", title: "Polyth — Child finished", body: "" }),
  ];
  const remote: NotificationCentreRemote = {
    async list() { return { items, unread: items.filter((item) => !item.read).length }; },
    async read() { return { updated: 0, unread: 0 }; },
    async readAll() { return { updated: 0, unread: 0 }; },
    async clear() { return { cleared: 0, unread: 0 }; },
  };
  const centre = createNotificationCentre(remote);
  await centre.bootstrap();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(NotificationCentrePanel, { centre, open: async () => {} })); });
    return container.innerHTML;
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setSessions("p1", []);
  }
}

let browser: Browser | null = null;
let markup = "";

before(async () => {
  markup = await panelMarkup();
  if (!CHROME) return;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  });
});

after(async () => { await browser?.close(); });

interface Box { left: number; right: number; top: number; bottom: number; width: number }
interface RowGeometry {
  row: Box; main: Box; title: Box; meta: Box; time: Box; gone: Box | null; overflowX: boolean;
}

test("the text keeps the row in a narrow rail panel and the date rides the meta line", { skip: !CHROME }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  // The fixture must never rely on fonts, assets or services from the network.
  await page.route("**/*", (route) => route.abort());
  try {
    // 264px is the row width of a default rail panel (the reported breakage);
    // 220 is a squeezed pane, 390 a phone sheet.
    for (const dir of ["ltr", "rtl"] as const) {
      for (const width of [220, 264, 390]) {
        await page.setViewportSize({ width: width + 80, height: 900 });
        await page.setContent(`<!doctype html><html dir="${dir}" lang="en"><head><meta charset="utf-8">
          <style>${css}</style>
          <style>html, body { height: auto !important; overflow: visible !important; margin: 0; padding: 16px; }
            #frame { width: ${width + 24}px; display: flex; flex-direction: column; }</style></head>
          <body><section id="frame" class="module-view"><div class="module-view-body">
            <div class="module-view-content module-view-content--panel"><div class="rail-body">${markup}</div></div>
          </div></section></body></html>`);
        const rows = await page.evaluate((): RowGeometry[] => {
          const box = (el: Element): Box => {
            const rect = el.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
          };
          return [...document.querySelectorAll<HTMLElement>(".ntc-row")].map((row) => {
            const gone = row.querySelector(".ntc-gone");
            return {
              row: box(row),
              main: box(row.querySelector(".ntc-main")!),
              title: box(row.querySelector(".ntc-title")!),
              meta: box(row.querySelector(".ntc-meta")!),
              time: box(row.querySelector(".ntc-time")!),
              gone: gone ? box(gone) : null,
              overflowX: row.scrollWidth > row.clientWidth,
            };
          });
        });
        assert.equal(rows.length, 4);
        for (const [index, geometry] of rows.entries()) {
          const label = `${dir} ${width}px row ${index}`;
          assert.ok(Math.abs(geometry.row.width - width) <= 1, `${label}: the row fills the panel's content box (${geometry.row.width}px)`);
          // The glyph, its gap and the padding cost ~70px; the date must not add to that.
          assert.ok(geometry.main.width >= width - 80, `${label}: text column is ${geometry.main.width}px of ${width}px`);
          assert.ok(geometry.title.width / width >= 0.6, `${label}: title is ${geometry.title.width}px wide`);
          assert.equal(geometry.overflowX, false, `${label}: no horizontal overflow`);
          // The date sits inside the text column, at its inline end.
          assert.ok(geometry.time.left >= geometry.main.left - 0.5 && geometry.time.right <= geometry.main.right + 0.5,
            `${label}: the date stays inside the text column`);
          const edge = dir === "ltr"
            ? geometry.main.right - geometry.time.right
            : geometry.time.left - geometry.main.left;
          assert.ok(Math.abs(edge) <= 1, `${label}: the date ends the meta line (off by ${edge}px)`);
          assert.ok(geometry.time.top >= geometry.meta.top - 0.5 && geometry.time.bottom <= geometry.meta.bottom + 0.5,
            `${label}: the date belongs to the meta line`);
        }
        const dead = rows[2]!;
        assert.ok(dead.gone !== null && dead.gone.top >= dead.meta.bottom - 0.5,
          `${dir} ${width}px: the dead-session note is a line of its own under the meta`);
      }
    }
  } finally {
    await page.close();
  }
});
