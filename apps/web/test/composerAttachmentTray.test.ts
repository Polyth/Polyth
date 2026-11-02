// The attachment tray on the REAL Composer in a new chat: the next message's
// files are a row of the card between the model line and the editor, and the
// card grows to hold them — and shrinks when the last one goes — on one
// continuous edge. The editor and Send never move; the model line and the
// project row ride the card's rising top edge (composer/attachmentTray.ts,
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
    import { addAttachment, clearAttachments, removeAttachment } from "./attachments.ts";
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
  __tray: { add(ref: unknown): void; remove(id: string): void; clear(): void };
  __scrub: Animation[];
};

async function open(initial: unknown[] = [], options: { reducedMotion?: "reduce" } = {}): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
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

test("removing the last file closes the row over it; a send takes the files at once", { skip: !CHROME }, async () => {
  const page = await open([TSX]);
  const full = await sample(page);
  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), PDF);
  await page.evaluate(() => (window as unknown as Probe).__tray.remove("pdf"));
  assert.equal(await page.locator(".composer-tray[data-motion]").count(), 0, "a file that is not the last leaves the row open");

  const steps = await scrub(page, () => page.locator(".attachment-pill .att-remove").click({ force: true }), 200);
  assert.equal(steps[0]!.motion, "close");
  const closed = await sample(page);
  assert.equal(await page.locator(".composer-tray").count(), 0, "the row is gone once it has closed");
  assertEdge(steps, full.height, closed.height, "closing");

  await page.evaluate((ref) => (window as unknown as Probe).__tray.add(ref), TSX);
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
  await page.waitForFunction(() => !document.querySelector(".composer-tray[data-motion]"));
  await page.evaluate(() => (window as unknown as Probe).__tray.clear());
  assert.equal(await page.locator(".composer-tray").count(), 0, "files a send takes leave with it, without a closing row");
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
  await page.waitForFunction(() => !document.querySelector(".composer-tray"));
  assert.ok(Math.abs((await sample(page)).height - empty.height) <= 0.5, "and closed on the next");
  await page.close();
});
