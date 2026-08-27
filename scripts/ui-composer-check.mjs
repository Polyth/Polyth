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
    // Power composer (model/context/agent pickers) only shows outside chat mode.
    localStorage.setItem(`polyth.workspaceMode.v1.${id}`, "widgets");
  });
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);
  return { ctx, page };
}

// --- desktop: context window popover (now ui/Popover) -------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  const chip = page.locator(".context-window-chip").first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(400);
    const pop = page.locator(".ui-popover.context-window-pop");
    const visible = await pop.isVisible().catch(() => false);
    const box = visible ? await pop.boundingBox() : null;
    const chipBox = await chip.boundingBox();
    console.log("context-window popover:", { visible, box, chipBox });
    await page.screenshot({ path: `${outDir}/desktop-context-popover.png` });
    // Escape closes it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    console.log("after Escape visible:", await pop.isVisible().catch(() => false));
  } else {
    console.log("context-window chip not found");
  }
  await ctx.close();
}

// --- desktop: add-files icon button geometry ----------------------------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  const btn = page.locator(".ui-icon-btn.composer-add-files").first();
  if (await btn.count()) {
    const info = await btn.evaluate((el) => ({
      classes: el.className,
      rect: el.getBoundingClientRect().toJSON(),
      color: getComputedStyle(el).color,
    }));
    console.log("add-files button:", info);
  } else {
    console.log("add-files ui-icon-btn NOT found");
  }
  await page.screenshot({ path: `${outDir}/desktop-composer.png` });
  await ctx.close();
}

// --- phone 390: context popover + add menu --------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  const chip = page.locator(".context-window-chip").first();
  if (await chip.count() && await chip.isVisible()) {
    await chip.click();
    await page.waitForTimeout(400);
    const pop = page.locator(".ui-popover.context-window-pop");
    console.log("phone context popover visible:", await pop.isVisible().catch(() => false));
    await page.screenshot({ path: `${outDir}/phone-context-popover.png` });
  } else {
    console.log("phone: context-window chip hidden (expected if phone hides it)");
    await page.screenshot({ path: `${outDir}/phone-composer.png` });
  }
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
