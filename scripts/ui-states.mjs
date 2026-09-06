// Dev-only interaction-state screenshot helper for the Phase 1 redesign.
// Usage: node scripts/ui-states.mjs <outdir> <label> <path>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-states";
const label = process.argv[3] ?? "state";
const path = process.argv[4] ?? "/";
const base = process.env.POLYTH_URL ?? "http://127.0.0.1:4400";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

async function ctxPage(width, height, mobile) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);
  return { ctx, page };
}

const shot = (page, name) => page.screenshot({ path: `${outDir}/${label}-${name}.png` });

// --- phone drawer (projects & sessions) --------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator(".session-nav-current").click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, "phone-drawer");
  await ctx.close();
}

// --- phone composer engaged (tap input) --------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, "phone-composer-engaged");
  await ctx.close();
}

// --- phone keyboard simulation: shrink visual band --------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.waitForTimeout(400);
  // Simulate a 320px software keyboard by resizing the viewport (Chromium
  // resizes the layout viewport, which is the resizes-content behavior).
  await page.setViewportSize({ width: 390, height: 844 - 320 });
  await page.waitForTimeout(700);
  await shot(page, "phone-keyboard");
  await ctx.close();
}

// --- phone model picker sheet -------------------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator(".model-picker-trigger").first().click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, "phone-model-picker");
  await ctx.close();
}

// --- phone agent picker -------------------------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator(".composer-agent-chip .picker-chip").first().click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, "phone-agent-picker");
  await ctx.close();
}

// --- desktop model picker ------------------------------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.locator(".model-picker-trigger").first().click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, "desktop-model-picker");
  await ctx.close();
}

// --- desktop user menu ----------------------------------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.locator(".header-profile").click().catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, "desktop-user-menu");
  await ctx.close();
}

// --- desktop sidebar project menu -----------------------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.locator(".project-menu-btn").first().click().catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, "desktop-project-menu");
  await ctx.close();
}

// --- desktop composer typed (send enabled) --------------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.keyboard.type("Refactor the shell layout");
  await page.waitForTimeout(500);
  await shot(page, "desktop-composer-typed");
  await ctx.close();
}

// --- landscape phone -------------------------------------------------------------
{
  const { ctx, page } = await ctxPage(844, 390, true);
  await shot(page, "phone-landscape");
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
