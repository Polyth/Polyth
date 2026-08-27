// Dev-only verification of the Wave 3 header primitive migrations.
// Usage: node scripts/ui-header-check.mjs <outdir> <path>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-header";
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
    if (pid) localStorage.setItem(`polyth.projectSetup.v1.${decodeURIComponent(pid)}`, "completed");
  });
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);
  return { ctx, page };
}

// --- desktop 1280: user menu opens as ui-menu, Escape closes, focus restores --
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.locator(".header-profile").click();
  await page.waitForTimeout(400);
  const menu = page.locator(".ui-popover.ui-menu");
  const visible = await menu.isVisible().catch(() => false);
  const items = await menu.locator("[role=menuitem]").allTextContents().catch(() => []);
  const box = visible ? await menu.boundingBox() : null;
  console.log("desktop user menu:", { visible, items, box });
  await page.screenshot({ path: `${outDir}/desktop-user-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const closedAndFocused = await page.evaluate(() =>
    document.activeElement?.className?.includes?.("header-profile"));
  console.log("escape closed + focus restored to trigger:", closedAndFocused,
    "menu still visible:", await menu.isVisible().catch(() => false));
  // menu item navigation: open again, select All settings
  await page.locator(".header-profile").click();
  await page.waitForTimeout(300);
  await page.locator(".ui-menu [role=menuitem]", { hasText: "All settings" }).click().catch(async () => {
    await page.locator(".ui-menu [role=menuitem]").last().click();
  });
  await page.waitForTimeout(500);
  console.log("settings overlay opened:", await page.locator(".settings-overlay, [role=dialog]").first().isVisible().catch(() => false));
  await page.screenshot({ path: `${outDir}/desktop-settings-from-menu.png` });
  await ctx.close();
}

// --- tablet 768: drawer trigger geometry + drawer opens ------------------------
{
  const { ctx, page } = await ctxPage(768, 1024, true);
  const btn = page.locator(".ui-icon-btn.header-drawer-btn").first();
  if (await btn.count()) {
    const info = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, "::after");
      return {
        classes: el.className,
        rect: { w: r.width, h: r.height },
        hitAfter: { w: after.width, h: after.height },
        expanded: el.getAttribute("aria-expanded"),
        controls: el.getAttribute("aria-controls"),
      };
    });
    console.log("tablet drawer trigger:", info);
    await btn.click();
    await page.waitForTimeout(600);
    console.log("drawer open:", await page.locator("#polyth-session-drawer, .sidebar").first().isVisible().catch(() => false));
    await page.screenshot({ path: `${outDir}/tablet-drawer-open.png` });
  } else {
    console.log("tablet: drawer trigger not found");
    await page.screenshot({ path: `${outDir}/tablet-no-drawer.png` });
  }
  await ctx.close();
}

// --- tablet 768: project button tint --------------------------------------------
{
  const { ctx, page } = await ctxPage(768, 1024, true);
  const btn = page.locator(".ui-icon-btn.header-project-btn").first();
  if (await btn.count()) {
    const info = await btn.evaluate((el) => ({
      rect: { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height },
      color: getComputedStyle(el).color,
      bg: getComputedStyle(el).backgroundColor,
    }));
    console.log("tablet project button:", info);
  } else {
    console.log("tablet: project button not rendered (needs chat surface)");
  }
  await ctx.close();
}

// --- desktop nav pill hit-floor sanity (coarse simulation not possible on fine) --
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  const pill = page.locator(".view-switcher-pill .view-icon").first();
  if (await pill.count()) {
    const info = await pill.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return { position: getComputedStyle(el).position, afterContent: after.content, afterW: after.width };
    });
    console.log("nav pill ::after (fine pointer, hit-min=0):", info);
  }
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
