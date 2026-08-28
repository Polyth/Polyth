// P2-W3A composer/picker QA driver (manual; not part of `npm test`).
// Screenshots + interaction passes over the redesigned composer, model
// picker, agent picker, effort menu, and attachments — desktop, phone,
// and 320px, against the w3a fixture server (rich catalog, fake backend).
//
// Usage:
//   1. node apps/web/test/wave3aComposerFixtureSetup.mjs
//   2. Start the fixture server (command printed by step 1; port 4473).
//   3. node apps/web/test/wave3aComposerQa.mjs   (OUT=/dir for screenshots)
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.POLYTH_FIXTURE_URL ?? "http://127.0.0.1:4473";
const OUT = process.env.OUT ?? "/tmp/w3a-shots";
const CHROME = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });

const PERSONA = JSON.stringify({ persona: "engineer", plugins: [] });
const MODEL_PREFS = JSON.stringify({
  favorites: Array.from({ length: 60 }, (_, index) =>
    `openhub/oh-${String(index + 1).padStart(2, "0")}`),
  sort: "provider",
  recents: [],
  providerOrder: [],
  expandedProviders: [],
});
const assert = (condition, message) => {
  if (!condition) throw new Error(`QA assertion failed: ${message}`);
};
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
});

async function open(width, height, path, extra = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    hasTouch: width <= 480,
    ...extra,
  });
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, {
    "polyth.prefs": PERSONA,
    "polyth.modelPrefs": MODEL_PREFS,
    "polyth.projectSetup.v1.w3a-project": "completed",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15000 });
  await page.waitForTimeout(700);
  return { page, context };
}

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const overflow = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth);
const P = "w3a-project";

// ---- desktop: resting composer, typing, multiline ------------------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  await shot(page, "01-desktop-fresh-resting");
  const input = page.locator(".composer textarea").first();
  await input.click();
  await input.type("First line of a draft message");
  await input.press("Shift+Enter");
  await input.type("second line — multiline growth check");
  await page.waitForTimeout(200);
  await shot(page, "02-desktop-typing-multiline");
  console.log("desktop overflow while typing:", await overflow(page));

  // Model picker popover: search, keyboard nav, details.
  await page.locator(".model-picker-trigger").click();
  await page.waitForSelector(".model-pop", { timeout: 5000 });
  await shot(page, "03-desktop-modelpicker-open");
  console.log("model rows visible:", await page.locator(".model-picker-row").count());
  const search = page.locator(".model-pop-search input");
  const searchStarted = Date.now();
  await search.fill("openhub community");
  await page.waitForFunction(() => document.querySelectorAll(".model-picker-row").length === 200);
  const largeSearchMs = Date.now() - searchStarted;
  const boundedRows = await page.locator(".model-picker-row").count();
  assert(boundedRows === 200, "a 420-model match renders at the 200-row threshold");
  assert(await page.locator(".model-pop .picker-more").count() === 1, "bounded catalog explains hidden matches");
  assert(largeSearchMs < 2_000, `large catalog search completes promptly (${largeSearchMs}ms)`);
  console.log("420-model search:", largeSearchMs, "ms; mounted rows:", boundedRows);
  await search.fill("");
  // Rapidly toggle distant provider groups; closed groups must not mount rows.
  const providerHeads = page.locator(".model-provider-head:not(.static)");
  const providerHeadCount = await providerHeads.count();
  assert(providerHeadCount >= 25, "many-provider fixture is present");
  for (const index of [5, 12, 20, providerHeadCount - 1]) {
    const head = providerHeads.nth(index);
    await head.click();
    await head.click();
  }
  assert(await page.locator(".model-picker-row").count() <= 200, "provider toggles preserve the mount threshold");
  await search.type("borealis");
  await page.waitForTimeout(150);
  console.log("rows after search 'borealis':", await page.locator(".model-picker-row").count());
  await shot(page, "04-desktop-modelpicker-search");
  await search.press("ArrowDown");
  await page.waitForTimeout(100);
  await shot(page, "05-desktop-modelpicker-keyboard-active");
  // Row info → details card.
  await page.locator(".model-picker-row").first().hover();
  await page.locator(".model-picker-row .model-row-info").first().click();
  await page.waitForSelector(".model-details", { timeout: 5000 });
  await shot(page, "06-desktop-modelpicker-details");
  console.log("details rows:", await page.locator(".model-details-grid dt").count());
  await page.locator(".model-details-use").click();
  await page.waitForTimeout(300);
  console.log("picked model chip:", JSON.stringify(await page.locator(".model-trigger-name").textContent()));
  await shot(page, "07-desktop-model-picked");

  // Effort menu (Borealis Ultra has a "thinking" variant).
  const effort = page.locator(".composer-effort-chip");
  console.log("effort chip present:", await effort.count());
  if (await effort.count()) {
    await effort.click();
    await page.waitForTimeout(250);
    await shot(page, "08-desktop-effort-menu");
    await page.locator('.ui-menu [role="menuitemradio"]').last().click();
    await page.waitForTimeout(200);
    console.log("effort chip label:", JSON.stringify(await effort.textContent()));
    await page.locator(".model-picker-trigger").click();
    await page.locator(".model-pop-search input").fill("fable legacy");
    await page.locator(".model-picker-row").first().click();
    assert(await page.locator(".composer-effort-chip").count() === 0,
      "effort hides when switching to a model without variants");
    await page.locator(".model-picker-trigger").click();
    await page.locator(".model-pop-search input").fill("borealis ultra");
    await page.locator(".model-picker-row").first().click();
    assert((await page.locator(".composer-effort-chip").textContent())?.includes("Thinking"),
      "model-specific effort returns when switching back");
  }

  // Agent picker.
  await page.locator(".composer-agent-chip .picker-chip").click();
  await page.waitForTimeout(250);
  await shot(page, "09-desktop-agentpicker");
  console.log("agent options:", await page.locator(".composer-agent-chip .picker-item").count());
  await page.locator(".composer-agent-chip .picker-item").filter({ hasText: "Docs writer" }).click();
  assert((await page.locator(".composer-agent-chip .picker-chip-text").textContent())?.includes("Docs writer"),
    "agent switch updates the chip");

  // Add menu.
  await page.locator(".composer-add-trigger").click();
  await page.waitForTimeout(250);
  await shot(page, "10-desktop-add-menu");
  await page.keyboard.press("Escape");
  assert(await page.locator(".add-menu").count() === 0, "Escape deterministically closes the top overlay");
  await context.close();
}

// ---- desktop: attachments (upload, long name, remove) --------------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const longName = `${OUT}/an-extremely-long-attachment-filename-that-should-truncate-gracefully-in-the-strip-2026-08-27.png`;
  // 1x1 png
  writeFileSync(longName, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const attachmentPaths = [longName];
  for (let index = 1; index < 16; index++) {
    const path = `${OUT}/attachment-${String(index).padStart(2, "0")}.txt`;
    writeFileSync(path, `generic file attachment ${index}\n`);
    attachmentPaths.push(path);
  }
  await page.locator(".composer input[type=file]").setInputFiles(attachmentPaths);
  await page.waitForFunction(() => document.querySelectorAll(".composer .attachment-pill").length === 16);
  console.log("attachment pills:", await page.locator(".attachment-pill").count());
  const stripIsBounded = await page.locator(".composer .attachment-pills").evaluate((element) =>
    element.scrollHeight > element.clientHeight);
  assert(stripIsBounded, "pathological attachment count scrolls inside a capped strip");
  await shot(page, "11-desktop-attachments");
  await page.locator(".attachment-pill .att-remove").first().click();
  await page.waitForTimeout(300);
  console.log("pills after remove:", await page.locator(".attachment-pill").count());
  await context.close();
}

// ---- desktop: send → stop → settled against the fake backend -------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w3a-stream`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const input = page.locator(".composer textarea").first();
  await input.fill("Run the synthetic verification turn for composer QA.");
  await shot(page, "12-desktop-send-ready");
  await input.press("Enter");
  await page.waitForSelector(".composer-stop-primary, .composer-send-split", { timeout: 10000 });
  await shot(page, "13-desktop-streaming-stop");
  console.log("stop control:", await page.locator(".composer-stop-primary").count(),
    "split:", await page.locator(".composer-send-split").count());
  // Draft during stream → queue split control.
  await input.type("Queued follow-up draft");
  await page.waitForTimeout(300);
  await shot(page, "14-desktop-streaming-queue-split");
  await input.fill("");
  await page.waitForFunction(() => !document.querySelector(".composer-stop-primary"), { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot(page, "15-desktop-stream-settled");
  await context.close();
}

// ---- desktop: stream settles during a delayed abort round-trip -----------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w3a-stream`);
  await page.route(`**/api/sessions/w3a-stream/abort`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_200));
    await route.continue();
  });
  const input = page.locator(".composer textarea").first();
  await input.fill("Exercise the stop versus natural completion race.");
  await input.press("Enter");
  const stop = page.locator(".composer-stop-primary");
  await stop.waitFor({ state: "visible", timeout: 10_000 });
  await stop.click();
  await page.waitForFunction(() => !document.querySelector(".composer-stop-primary"), { timeout: 10_000 });
  await page.waitForTimeout(4_500);
  assert(await page.locator(".composer-rail .send").isVisible(),
    "late abort completion cannot replace the settled Send state");
  assert(await page.locator(".composer-stop-primary").count() === 0,
    "late abort completion cannot resurrect Stop");
  console.log("stop/send late-abort race: stable Send");
  await context.close();
}

// ---- desktop: permission banner above composer ---------------------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w3a-permission`);
  await page.waitForSelector(".perm-banner", { timeout: 15000 });
  await shot(page, "16-desktop-permission-above-composer");
  await context.close();
}

// ---- phone 390: collapsed → expanded, pickers as sheets -------------------------
{
  const { page, context } = await open(390, 844, `/p/${P}`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  await shot(page, "17-phone-collapsed");
  console.log("phone collapsed overflow:", await overflow(page));
  const input = page.locator(".composer textarea").first();
  await input.click();
  await page.waitForTimeout(400);
  await shot(page, "18-phone-expanded");
  console.log("phone expanded overflow:", await overflow(page));
  const chipBox = await page.locator(".model-picker-trigger").boundingBox();
  console.log("phone model chip size:", chipBox?.width, "x", chipBox?.height);

  // Model sheet.
  await page.locator(".model-picker-trigger").click();
  await page.waitForSelector(".sheet", { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(page, "19-phone-model-sheet");
  await page.locator(".sheet-search input").focus();
  await page.evaluate(() => {
    document.body.dataset.keyboard = "open";
    document.body.dataset.band = "short";
    document.documentElement.style.setProperty("--visual-vh", "584px");
    document.documentElement.style.setProperty("--keyboard-inset", "260px");
  });
  // Sheet details (a non-current row, so the Use action is present).
  await page.locator(".sheet-row-info").nth(1).click();
  await page.waitForSelector(".model-details", { timeout: 5000 });
  await page.locator(".model-details-use").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, "20-phone-model-details-sheet");
  const useBox = await page.locator(".model-details-use").boundingBox();
  console.log("phone details use-button height:", useBox?.height);
  assert(!!useBox && useBox.y + useBox.height <= 584, "details CTA scrolls above the simulated keyboard");
  await page.locator(".model-details-back").click();
  await page.waitForTimeout(200);
  await page.locator(".sheet-close").click();
  await page.waitForTimeout(300);
  assert(await page.locator(".model-picker-trigger").evaluate((element) => document.activeElement === element),
    "closing the model sheet restores focus to its trigger");
  await page.evaluate(() => {
    document.body.dataset.keyboard = "closed";
    document.body.dataset.band = "tall";
    document.documentElement.style.setProperty("--visual-vh", "844px");
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
  });

  // Agent sheet.
  await input.click();
  await page.waitForTimeout(200);
  await page.locator(".composer-agent-chip .picker-chip").click();
  await page.waitForTimeout(500);
  await shot(page, "21-phone-agent-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Effort sheet (pick Borealis Ultra first via search).
  await page.locator(".model-picker-trigger").click();
  await page.waitForSelector(".sheet", { timeout: 5000 });
  await page.locator(".sheet-search input").first().type("ultra");
  await page.waitForTimeout(250);
  await page.locator(".sheet-row").first().click();
  await page.waitForTimeout(400);
  const effort = page.locator(".composer-effort-chip");
  console.log("phone effort chip present:", await effort.count());
  if (await effort.count()) {
    const effortBox = await effort.boundingBox();
    console.log("phone effort chip size:", effortBox?.width, "x", effortBox?.height);
    await effort.click();
    await page.waitForTimeout(500);
    await shot(page, "22-phone-effort-sheet");
    await page.keyboard.press("Escape");
  }
  await context.close();
}

// ---- phone 390: attachments strip -----------------------------------------------
{
  const { page, context } = await open(390, 844, `/p/${P}`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  await page.locator(".composer input[type=file]").setInputFiles([
    `${OUT}/an-extremely-long-attachment-filename-that-should-truncate-gracefully-in-the-strip-2026-08-27.png`,
    `${OUT}/attachment-01.txt`,
  ]);
  await page.waitForTimeout(600);
  console.log("phone attachment overflow:", await overflow(page));
  const removeBox = await page.locator(".attachment-pill .att-remove").first().boundingBox();
  console.log("phone att-remove size:", removeBox?.width, "x", removeBox?.height);
  await shot(page, "23-phone-attachments");
  await context.close();
}

// ---- phone 390: permission banner + composer dock --------------------------------
{
  const { page, context } = await open(390, 844, `/p/${P}/s/w3a-permission`);
  await page.waitForSelector(".perm-banner", { timeout: 15000 });
  await page.waitForTimeout(400);
  console.log("phone permission overflow:", await overflow(page));
  await shot(page, "24-phone-permission-above-composer");
  // Focus the input with the banner up: composer + banner must both stay usable.
  await page.locator(".composer textarea").first().click();
  await page.waitForTimeout(400);
  await shot(page, "25-phone-permission-keyboard-focus");
  await page.locator(".composer input[type=file]").setInputFiles(
    Array.from({ length: 8 }, (_, index) => `${OUT}/attachment-${String(index + 1).padStart(2, "0")}.txt`),
  );
  await page.waitForFunction(() => document.querySelectorAll(".composer .attachment-pill").length === 8);
  await page.evaluate(() => {
    document.body.dataset.keyboard = "open";
    document.body.dataset.band = "short";
    document.documentElement.style.setProperty("--visual-vh", "390px");
    document.documentElement.style.setProperty("--visual-bottom", "390px");
    document.documentElement.style.setProperty("--keyboard-inset", "454px");
  });
  await page.waitForTimeout(300);
  const shortBand = await page.evaluate(() => {
    const composer = document.querySelector(".composer-card")?.getBoundingClientRect();
    const permission = document.querySelector(".perm-banner")?.getBoundingClientRect();
    const primary = document.querySelector(".composer-primary button")?.getBoundingClientRect();
    return {
      composerBottom: composer?.bottom ?? Infinity,
      permissionPresent: !!permission,
      primaryBottom: primary?.bottom ?? Infinity,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert(shortBand.permissionPresent, "permission remains mounted in the short-band combination");
  assert(shortBand.composerBottom <= 390 && shortBand.primaryBottom <= 390,
    "composer and primary action remain above the simulated keyboard");
  assert(!shortBand.overflow, "short band with attachments and permission has no horizontal overflow");
  await shot(page, "26-phone-short-band-attachments-permission");
  await context.close();
}

// ---- 320px: composer + model sheet ------------------------------------------------
{
  const { page, context } = await open(320, 700, `/p/${P}`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  console.log("320 collapsed overflow:", await overflow(page));
  await page.locator(".composer textarea").first().click();
  await page.waitForTimeout(400);
  console.log("320 expanded overflow:", await overflow(page));
  await shot(page, "27-320-expanded");
  await page.locator(".model-picker-trigger").click();
  await page.waitForTimeout(500);
  console.log("320 sheet overflow:", await overflow(page));
  await shot(page, "28-320-model-sheet");
  await context.close();
}

// ---- phone 390: streaming stop state ----------------------------------------------
{
  const { page, context } = await open(390, 844, `/p/${P}/s/w3a-stream`);
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const input = page.locator(".composer textarea").first();
  await input.click();
  await input.fill("Phone streaming turn for stop/send QA.");
  await page.waitForTimeout(200);
  await shot(page, "29-phone-send-ready");
  await page.locator(".composer-rail .send").click();
  await page.waitForSelector(".composer-stop-primary, .composer-send-split", { timeout: 10000 });
  await page.locator(".model-picker-trigger").click();
  await page.locator(".sheet-search input").fill("fable legacy");
  await page.locator(".sheet-row-main").first().click();
  assert((await page.locator(".model-trigger-name").textContent())?.includes("Fable Legacy"),
    "model switch during streaming updates next-turn configuration");
  assert(await page.locator(".composer-stop-primary").isVisible(),
    "switching models does not interrupt the current stream");
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.body.dataset.keyboard = "open";
    document.documentElement.style.setProperty("--safe-bottom", "24px");
  });
  const safePadding = await page.locator(".composer-chat.composer-mobile").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingBottom));
  assert(safePadding >= 24, "streaming composer keeps the safe-bottom inset when navigation hides");
  await shot(page, "30-phone-streaming-stop");
  await page.waitForFunction(() => !document.querySelector(".composer-stop-primary"), { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot(page, "31-phone-stream-settled");
  await context.close();
}

await browser.close();
console.log("done ->", OUT);
