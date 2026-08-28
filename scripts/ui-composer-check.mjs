// Dev-only verification of the Wave 3 composer primitive migrations.
// Usage: node scripts/ui-composer-check.mjs <outdir> <path>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-composer";
const path = process.argv[3] ?? "/";
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
  await page.addInitScript(() => {
    const pid = location.pathname.match(/^\/p\/([^/]+)/)?.[1];
    if (!pid) return;
    const id = decodeURIComponent(pid);
    localStorage.setItem(`polyth.projectSetup.v1.${id}`, "completed");
  });
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);
  return { ctx, page };
}

// --- desktop: model picker responsive overlay ----------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  const chip = page.locator(".model-picker-trigger").first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(400);
    const pop = page.locator(".model-pop");
    const visible = await pop.isVisible().catch(() => false);
    const box = visible ? await pop.boundingBox() : null;
    const chipBox = await chip.boundingBox();
    console.log("model picker popover:", { visible, box, chipBox });
    await page.screenshot({ path: `${outDir}/desktop-model-picker.png` });
    // Escape closes it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    console.log("after Escape visible:", await pop.isVisible().catch(() => false));
  } else {
    console.log("model picker trigger not found");
  }
  await ctx.close();
}

// --- desktop: Add menu trigger geometry ----------------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  const btn = page.locator(".composer-add-trigger").first();
  if (await btn.count()) {
    const info = await btn.evaluate((el) => ({
      classes: el.className,
      rect: el.getBoundingClientRect().toJSON(),
      color: getComputedStyle(el).color,
    }));
    console.log("Add menu trigger:", info);
  } else {
    console.log("Add menu trigger not found");
  }
  await page.screenshot({ path: `${outDir}/desktop-composer.png` });
  await ctx.close();
}

// --- phone 390: responsive model picker -----------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await page.waitForTimeout(200);
  const chip = page.locator(".model-picker-trigger").first();
  if (await chip.count() && await chip.isVisible()) {
    await chip.click();
    await page.waitForTimeout(400);
    const overlay = page.locator(".model-sheet, .model-pop");
    console.log("phone model picker visible:", await overlay.isVisible().catch(() => false));
    await page.screenshot({ path: `${outDir}/phone-model-picker.png` });
  } else {
    console.log("phone: model picker trigger hidden");
    await page.screenshot({ path: `${outDir}/phone-composer.png` });
  }
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
