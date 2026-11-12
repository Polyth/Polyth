// The attachment tray on the REAL Composer in a new chat: the next message's
// files are a row of the card between the model line and the editor, and the
// card grows to hold them — and shrinks once the row holds nothing — on one
// continuous edge. The editor and Send never move; the model line and the
// project row ride the card's rising top edge. A removed file keeps its place
// for a moment as a restore slot (composer/attachmentTray.ts,
// composerAdaptive.css "Attachment tray").
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
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://composer-attachment-tray.test";

const TSX = { id: "tsx", name: "AttachmentPills.tsx", mime: "text/plain", size: 5_210, kind: "file", path: "apps/web/src/components/AttachmentPills.tsx" };
const PDF = { id: "pdf", name: "composer-spec.pdf", mime: "application/pdf", size: 2_480_000, kind: "file", path: "_inbox/composer-spec.pdf" };
const PICTURE = {
  id: "png", name: "screen.png", mime: "image/svg+xml", size: 18_200, kind: "image", path: "_inbox/screen.png",
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#345"/></svg>')}`,
};
const LOG = { id: "log", name: "server.log", mime: "text/plain", size: 912, kind: "file", path: "_inbox/server.log" };
/** How long a slot offers (ATTACHMENT_RESTORE_MS), and a little more. */
const OFFER_OVER_MS = 8_100;

let browser: Browser | null = null;
let html = "";

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  html = await fixture();
});

after(async () => {
  await browser?.close();
});

async function fixture(): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/composer-attachment-tray-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import Composer from "./components/Composer.tsx";
    import { api } from "@polyth/session/web-api";
    import { activateProject, applyProjectUpsert, setModels, startNewSession } from "./store.ts";
    import { addAttachment, clearAttachments, pendingAttachments, removeAttachment } from "./attachments.ts";
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0000000", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    applyProjectUpsert({ id: "polyth", path: "/projects/polyth", name: "Polyth", createdAt: 0, defaults: { isolation: "workspace" } });
    activateProject("polyth");
    setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus 5.5", connected: true }]);
    startNewSession("polyth", { draft: "Why do attachments get lost?" });
    for (const ref of window.__initial ?? []) addAttachment(null, ref);
    window.__tray = {
      add: (ref) => addAttachment(null, ref),
      remove: (id) => removeAttachment(null, id),
      clear: () => clearAttachments(null),
      ids: () => pendingAttachments(null).map((ref) => ref.id),
    };
    createRoot(document.querySelector(".hero-dock")).render(createElement(Composer));
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "composer-attachment-tray-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/composer-attachment-tray-js",
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${css}</style>
    <script>
      window.fetch = async (input) => String(input).includes("/api/prompt-history")
        ? new Response('{"items":[]}', { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 });
      window.__initial = JSON.parse(decodeURIComponent(location.hash.slice(1) || "%5B%5D"));
    </script></head>
    <body><div id="root"><div class="app"><div class="app-shell"><main class="main">
      <div class="stage stage-new"><div class="hero">
        <div class="hero-body"><h2>What are we working on?</h2></div>
        <div class="hero-dock"></div>
      </div></div>
    </main></div></div></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script>
    </body></html>`;
}

type Probe = {
  __tray: { add(ref: unknown): void; remove(id: string): void; clear(): void; ids(): string[] };
  __scrub: Animation[];
};

async function open(initial: unknown[] = [], options: { reducedMotion?: "reduce"; outsideCaret?: boolean } = {}): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  // The page's timers run on a clock the test can move past a slot's offer.
  await page.clock.install();
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  // Chromium paints its own caret; iOS WebKit, which draws it above the page,
  // is the engine that supports -webkit-touch-callout. Every selection change
  // the editor reports is counted: that is what makes WebKit measure again.
  await page.addInitScript((outsideCaret) => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((property: string, value?: string) => property === "-webkit-touch-callout" ? outsideCaret
      : value === undefined ? supports(property) : supports(property, value)) as typeof CSS.supports;
    const probe = window as unknown as { __selectionChanges: number };
    probe.__selectionChanges = 0;
    document.addEventListener("selectionchange", () => { probe.__selectionChanges += 1; }, true);
  }, options.outsideCaret ?? false);
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${ORIGIN}/#${encodeURIComponent(JSON.stringify(initial))}`);
  await page.waitForSelector(".composer-card .composer-editor");
  await page.waitForTimeout(250);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  return page;
}

type Sample = { card: number; height: number; model: number; editor: number; send: number; bar: number; motion: string | null; pill: number };

const sample = (page: Page) => page.evaluate((): Sample => {
  const top = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().top * 10) / 10;
  const card = document.querySelector(".composer-card")!.getBoundingClientRect();
  return {
    card: Math.round(card.top * 10) / 10,
    height: Math.round(card.height * 10) / 10,
    model: top(".composer-config-row"),
    editor: top(".composer-editor"),
    send: top(".composer-primary"),
    bar: Math.round(document.querySelector(".session-context-bar")!.getBoundingClientRect().bottom * 10) / 10,
    motion: document.querySelector<HTMLElement>(".composer-tray")?.dataset.motion ?? null,
    pill: Number(getComputedStyle(document.querySelector(".composer-tray .attachment-pill") ?? document.body).opacity),
  };
});

type Slot = { id: string; removed: boolean; left: number; width: number };

/** The row's cards and restore slots, in order. */
const row = (page: Page) => page.evaluate((): Slot[] => [...document.querySelectorAll<HTMLElement>(".composer-tray .attachment-pill")].map((card) => {
  const box = card.getBoundingClientRect();
  return { id: card.dataset.attachment ?? "", removed: card.classList.contains("att-removed"), left: Math.round(box.left * 10) / 10, width: Math.round(box.width * 10) / 10 };
}));

const order = (slots: Slot[]) => slots.map((slot) => (slot.removed ? `(${slot.id})` : slot.id));

const remove = (page: Page, id: string) => page.locator(`.attachment-pill[data-attachment="${id}"] .att-remove`).click({ force: true });

/** Past the moment a click on a slot still counts as the removal's own double click. */
const pastSlip = (page: Page) => page.waitForTimeout(450);

/** The pointer leaves the row, and its slots' time passes. */
async function offerEnds(page: Page) {
  await page.mouse.move(8, 8);
  await page.clock.runFor(OFFER_OVER_MS);
}

/** Freeze the animations a change started inside the composer on one clock
 *  and step them; finish them after. */
async function scrub(page: Page, change: () => Promise<unknown>, end: number): Promise<Sample[]> {
  await page.evaluate(() => { (window as unknown as { __before: Set<Animation> }).__before = new Set(document.getAnimations()); });
  await change();
  await page.waitForFunction(() => {
    const before = (window as unknown as { __before: Set<Animation> }).__before;
    return document.getAnimations().some((animation) => !before.has(animation));
  });
  await page.evaluate(() => {
    const probe = window as unknown as Probe & { __before: Set<Animation> };
    const root = document.querySelector(".composer")!;
    probe.__scrub = document.getAnimations().filter((animation) => !probe.__before.has(animation)
      && root.contains((animation.effect as KeyframeEffect | null)?.target ?? null));
    for (const animation of probe.__scrub) { animation.pause(); animation.currentTime = 0; }
  });
  const steps: Sample[] = [];
  for (let time = 0; time < end; time += 20) {
    await page.evaluate((time) => {
      for (const animation of (window as unknown as Probe).__scrub) animation.currentTime = time;
    }, time);
    steps.push(await sample(page));
  }
  await page.evaluate(() => { for (const animation of (window as unknown as Probe).__scrub) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  return steps;
}

/** The card's height travels from `from` to `to` without a jump or a reversal,
 *  while the editor and Send stay put and the model line and the project row
 *  ride the top edge. */
function assertEdge(steps: Sample[], from: number, to: number, what: string) {
  const first = steps[0]!;
  assert.ok(Math.abs(first.height - from) <= 1, `${what}: the first frame is the card it had (${first.height} vs ${from})`);
  const total = Math.abs(to - from);
  assert.ok(total >= 40, `${what}: the card changes by a whole row (${total}px)`);
  for (const [index, step] of steps.entries()) {
    assert.ok(Math.abs(step.editor - first.editor) <= 0.5, `${what}: the editor never moves (step ${index}: ${step.editor} vs ${first.editor})`);
    assert.ok(Math.abs(step.send - first.send) <= 0.5, `${what}: Send never moves (step ${index})`);
    assert.ok(Math.abs((step.model - step.card) - (first.model - first.card)) <= 0.5, `${what}: the model line rides the top edge (step ${index})`);
    assert.ok(Math.abs((step.card - step.bar) - (first.card - first.bar)) <= 0.5, `${what}: the project row follows the edge (step ${index})`);
    if (!index) continue;
    const previous = steps[index - 1]!;
    const toward = Math.abs(to - step.height) <= Math.abs(to - previous.height) + 0.5;
    assert.ok(toward, `${what}: the card only travels toward ${to} (step ${index}: ${previous.height} → ${step.height})`);
    assert.ok(Math.abs(step.height - previous.height) <= total * 0.4 + 1, `${what}: no jump (step ${index})`);
  }
}

test("the first file opens a row of the card that the card grows to hold", { skip: !CHROME }, async () => {
  const page = await open();
  assert.equal(await page.locator(".composer-tray").count(), 0, "no tray without files");
  const empty = await sample(page);

  const steps = await scrub(page, () => page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX), 260);
  const settled = await sample(page);
  assert.equal(steps[0]!.motion, "open");
  assert.equal(settled.motion, null, "the tray settles once its animation ends");
  assert.ok(settled.height - empty.height >= 40, `the card holds the row (${empty.height} → ${settled.height})`);
  assertEdge(steps, empty.height, settled.height, "opening");

  const order = await page.evaluate(() => [...document.querySelector(".composer-card")!.children]
    .map((child) => child.className.split(" ")[0])
    .filter((name) => ["composer-config", "composer-tray", "composer-input"].includes(name!)));
  assert.deepEqual(order, ["composer-config", "composer-tray", "composer-input"], "files sit between the model line and the editor");
  assert.equal(await page.locator(".composer > .attachment-pills").count(), 0, "nothing is left above the project row");

  // The card surfaces once the edge has nearly cleared it, never cut by it.
  for (const step of steps) {
    if (step.height - empty.height < (settled.height - empty.height) * 0.6) {
      assert.ok(step.pill < 0.05, `the card stays hidden while the edge still clips it (${step.height}px, opacity ${step.pill})`);
    }
  }
  assert.ok(steps.some((step) => step.pill > 0.5), "and surfaces while the row opens");
  await page.close();
});

test("a file card names its type with its extension, and a later file enters on its own", { skip: !CHROME }, async () => {
  const page = await open([TSX]);
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "a composer that mounts with files does not animate");
  assert.equal((await page.locator(".attachment-pill .att-type").textContent())?.trim(), "TSX");
  assert.doesNotMatch(await page.locator(".attachment-pill .att-meta").textContent() ?? "", /TSX/, "the type is not repeated in the meta line");
  const height = (await sample(page)).height;
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), PDF);
  await page.waitForSelector(".attachment-pill.att-fresh");
  assert.equal(await page.locator(".attachment-pill.att-fresh").count(), 1, "only the new card enters");
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "an open row does not open again");
  assert.ok(Math.abs((await sample(page)).height - height) <= 0.5, "a second file keeps the card's height");
  await page.close();
});

test("the remove control sits in its card's top corner, clear of the middle", { skip: !CHROME }, async () => {
  const page = await open([PICTURE, TSX]);
  for (const id of ["png", "tsx"]) {
    const card = page.locator(`.attachment-pill[data-attachment="${id}"]`);
    await card.hover();
    const box = await card.evaluate((element) => {
      const own = element.getBoundingClientRect();
      const control = element.querySelector(".att-remove")!.getBoundingClientRect();
      return { top: control.top - own.top, end: own.right - control.right, bottom: control.bottom - own.top, start: control.left - own.left, height: own.height, width: own.width };
    });
    assert.ok(box.top >= 0 && box.top <= 2 && box.end >= 0 && box.end <= 2, `${id}: the control is in the card's top-end corner (${box.top}, ${box.end})`);
    assert.ok(box.bottom <= box.height / 2 && box.start >= box.width / 2, `${id}: and stays out of the card's middle`);
  }
  // A click on the middle of a picture opens it, not the control.
  const hit = await page.locator('.attachment-pill[data-attachment="png"]').evaluate((element) => {
    const own = element.getBoundingClientRect();
    return document.elementFromPoint(own.left + own.width / 2, own.top + own.height / 2)?.closest("button")?.className;
  });
  assert.equal(hit, "attachment-open");
  await page.close();
});

test("a removed file keeps its place as a restore slot and goes back where it was", { skip: !CHROME }, async () => {
  const page = await open([PICTURE, TSX, PDF, LOG]);
  const before = await row(page);
  assert.deepEqual(order(before), ["png", "tsx", "pdf", "log"]);

  await remove(page, "tsx");
  const slotted = await row(page);
  assert.deepEqual(order(slotted), ["png", "(tsx)", "pdf", "log"], "the file's slot stays where its card was");
  assert.deepEqual(await page.evaluate(() => (window as unknown as Probe).__tray.ids()), ["png", "pdf", "log"], "the draft no longer holds it");
  for (const [index, slot] of slotted.entries()) {
    assert.ok(Math.abs(slot.left - before[index]!.left) <= 0.5 && Math.abs(slot.width - before[index]!.width) <= 0.5,
      `nothing moves under the pointer (${slot.id}: ${slot.left}/${slot.width} vs ${before[index]!.left}/${before[index]!.width})`);
  }
  const restore = page.locator('.attachment-pill[data-attachment="tsx"] .att-restore');
  assert.match(await restore.getAttribute("aria-label") ?? "", /AttachmentPills\.tsx/, "the slot names the file it puts back");

  // The second click of a double click on remove lands on the slot: it is not a restore.
  await restore.click();
  assert.deepEqual(order(await row(page)), ["png", "(tsx)", "pdf", "log"], "a slip's second click does not undo it");

  // Slots keep their places among each other, and each file returns to its own.
  await remove(page, "png");
  await remove(page, "log");
  assert.deepEqual(order(await row(page)), ["(png)", "(tsx)", "pdf", "(log)"]);
  await pastSlip(page);
  await page.locator('.attachment-pill[data-attachment="log"] .att-restore').click();
  assert.deepEqual(order(await row(page)), ["(png)", "(tsx)", "pdf", "log"]);
  await restore.click();
  assert.deepEqual(order(await row(page)), ["(png)", "tsx", "pdf", "log"]);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Probe).__tray.ids()), ["tsx", "pdf", "log"], "the draft holds the files in the row's order");
  await page.locator('.attachment-pill[data-attachment="png"] .att-restore').click();
  const restored = await row(page);
  assert.deepEqual(order(restored), ["png", "tsx", "pdf", "log"]);
  assert.deepEqual(restored.map((slot) => slot.left), before.map((slot) => slot.left), "and the row is as it was");
  assert.equal(await page.locator(".attachment-pill.att-fresh").count(), 0, "a file that came back does not enter again");
  await page.close();
});

test("a slot nobody takes leaves on its own, but not from under the pointer or the keyboard", { skip: !CHROME }, async () => {
  const page = await open([TSX, PDF, LOG]);
  const height = (await sample(page)).height;
  await remove(page, "pdf");
  await pastSlip(page);

  // The pointer still rests on the row: the slot waits.
  await page.clock.runFor(OFFER_OVER_MS);
  assert.deepEqual(order(await row(page)), ["tsx", "(pdf)", "log"], "a row under the pointer keeps its slot");

  await offerEnds(page);
  await page.waitForFunction(() => !document.querySelector(".composer-tray .att-removed"));
  assert.deepEqual(order(await row(page)), ["tsx", "log"]);
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "the row stays open for its files");
  assert.ok(Math.abs((await sample(page)).height - height) <= 0.5, "and the card keeps its height");

  // The keyboard: remove moves focus to the slot's restore button, which
  // holds the slot, and restoring hands focus back to the card.
  await page.locator('.attachment-pill[data-attachment="tsx"] .attachment-open').focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "att-remove");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "att-restore", "focus follows the card into its slot");
  await offerEnds(page);
  assert.deepEqual(order(await row(page)), ["(tsx)", "log"], "a slot the keyboard is on stays");
  await page.keyboard.press("Enter");
  assert.deepEqual(order(await row(page)), ["tsx", "log"]);
  assert.equal(await page.evaluate(() => document.activeElement?.className), "attachment-open", "and back to the card");
  await page.close();
});

test("the last file's slot holds the row open, then the row closes over it; a send takes the files at once", { skip: !CHROME }, async () => {
  const page = await open([TSX]);
  const full = await sample(page);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), PDF);
  await page.evaluate(() => (window as unknown as Probe).__tray.remove("pdf"));
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "a file that is not the last leaves the row open");
  assert.equal(await page.locator(".composer-tray .att-removed").count(), 0, "a file the draft dropped by itself leaves no slot");

  await remove(page, "tsx");
  assert.deepEqual(order(await row(page)), ["(tsx)"]);
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "the row waits with the slot");
  assert.ok(Math.abs((await sample(page)).height - full.height) <= 0.5, "and the card keeps its height");

  // Restored: the row never moved.
  await pastSlip(page);
  await page.locator(".att-restore").click();
  assert.deepEqual(order(await row(page)), ["tsx"]);
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "a restored file does not open the row again");

  await remove(page, "tsx");
  const steps = await scrub(page, () => offerEnds(page), 200);
  assert.equal(steps[0]!.motion, "close");
  const closed = await sample(page);
  assert.equal(await page.locator(".composer-tray").count(), 0, "the row is gone once it has closed");
  assertEdge(steps, full.height, closed.height, "closing");

  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), PDF);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  await remove(page, "pdf");
  assert.deepEqual(order(await row(page)), ["tsx", "(pdf)"]);
  await page.evaluate(() => (window as unknown as Probe).__tray.clear());
  assert.equal(await page.locator(".composer-tray").count(), 0, "files a send takes leave with it, slots included, without a closing row");
  await page.close();
});

type Caret = { changes: number; start: number; end: number; value: string; focused: boolean };

const caret = (page: Page) => page.evaluate(async (): Promise<Caret> => {
  // Two frames: the refresh waits one, selectionchange is a task after it.
  for (let index = 0; index < 2; index += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const editor = document.querySelector<HTMLTextAreaElement>(".composer-editor[data-composer-input]")!;
  const probe = window as unknown as { __selectionChanges: number };
  const changes = probe.__selectionChanges;
  probe.__selectionChanges = 0;
  return { changes, start: editor.selectionStart, end: editor.selectionEnd, value: editor.value, focused: document.activeElement === editor };
});

test("on iOS the focused editor's caret is measured again once the row has opened or closed", { skip: !CHROME }, async () => {
  const page = await open([], { outsideCaret: true });
  const editor = page.locator(".composer-editor[data-composer-input]");
  await editor.focus();
  await editor.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(4, 4));
  const draft = await caret(page);
  assert.equal(draft.focused, true);

  // The row is still opening: the caret is left alone until it stops.
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.waitForSelector(".composer-tray[data-motion=open]");
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.pause(); });
  assert.equal((await caret(page)).changes, 0, "nothing is reported while the row moves");
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  const opened = await caret(page);
  assert.ok(opened.changes >= 1, "the opened row has the platform measure the caret again");
  assert.deepEqual(opened, { changes: opened.changes, start: 4, end: 4, value: draft.value, focused: true },
    "and the caret, the text and the focus are where they were");

  // An empty draft has no other caret place: its value steps and comes back.
  await editor.evaluate((field: HTMLTextAreaElement) => field.select());
  await page.keyboard.press("Backspace");
  assert.equal((await caret(page)).value, "");
  await page.locator(".attachment-pill .att-remove").click({ force: true });
  await offerEnds(page);
  await page.waitForSelector(".composer-tray[data-motion=close]");
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.pause(); });
  await editor.focus();
  await caret(page); // the remove tap's own focus moves are not the row's
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray"));
  const closed = await caret(page);
  assert.ok(closed.changes >= 1, "the closed row has the platform measure the caret again");
  assert.deepEqual(closed, { changes: closed.changes, start: 0, end: 0, value: "", focused: true }, "the empty draft stays empty");

  // An editor without focus shows no caret: nothing is touched.
  await editor.evaluate((field: HTMLTextAreaElement) => field.blur());
  await caret(page);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  assert.equal((await caret(page)).changes, 0, "an unfocused editor is left alone");
  await page.close();
});

test("an engine that paints its own caret is left alone when the row opens", { skip: !CHROME }, async () => {
  const page = await open();
  const editor = page.locator(".composer-editor[data-composer-input]");
  await editor.focus();
  await editor.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(4, 4));
  await caret(page);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  const settled = await caret(page);
  assert.equal(settled.changes, 0, "no selection step where the page paints the caret");
  assert.deepEqual([settled.start, settled.end, settled.focused], [4, 4, true]);
  await page.close();
});

test("reduced motion opens and closes the row at once", { skip: !CHROME }, async () => {
  const page = await open([], { reducedMotion: "reduce" });
  const empty = await sample(page);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.waitForSelector(".composer-tray");
  const opened = await sample(page);
  assert.equal(opened.motion, null);
  assert.ok(opened.height - empty.height >= 40, "the row is open on the first frame");
  await page.locator(".attachment-pill .att-remove").click({ force: true });
  assert.equal(await page.locator(".composer-tray .att-removed").count(), 1, "the removed file leaves its slot");
  await offerEnds(page);
  await page.waitForFunction(() => !document.querySelector(".composer-tray"));
  assert.ok(Math.abs((await sample(page)).height - empty.height) <= 0.5, "and closed at once when the slot's time is up");
  await page.close();
});
