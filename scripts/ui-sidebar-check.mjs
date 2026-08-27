// Dev-only verification of the Wave 3 sidebar primitive migrations.
// Usage: node scripts/ui-sidebar-check.mjs <outdir> <path>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-sidebar";
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

// --- desktop 1280: sort menu, filter menu, connection popover -----------------
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  // sort menu
  await page.locator(".sidebar-sort-trigger").click();
  await page.waitForTimeout(350);
  const sortItems = await page.locator(".ui-menu [role=menuitem]").allTextContents();
  console.log("sort menu items:", sortItems);
  await page.screenshot({ path: `${outDir}/desktop-sort-menu.png` });
  // pick "Project name"
  await page.locator(".ui-menu [role=menuitem]").nth(1).click();
  await page.waitForTimeout(300);
  console.log("sort trigger now:", await page.locator(".sidebar-sort-trigger span").first().textContent());
  // filter menu
  await page.locator(".sidebar-filter > button").click();
  await page.waitForTimeout(350);
  console.log("filter items:", await page.locator(".ui-menu [role=menuitem]").allTextContents());
  await page.screenshot({ path: `${outDir}/desktop-filter-menu.png` });
  await page.locator(".ui-menu [role=menuitem]").first().click();
  await page.waitForTimeout(300);
  console.log("filter active:", await page.locator(".sidebar-filter > button").getAttribute("aria-pressed"));
  // toggle back off
  await page.locator(".sidebar-filter > button").click();
  await page.waitForTimeout(250);
  await page.locator(".ui-menu [role=menuitem]").first().click();
  await page.waitForTimeout(200);
  // connection popover
  await page.locator(".sidebar-connection-dot").click();
  await page.waitForTimeout(350);
  const pop = page.locator(".ui-popover.sidebar-connection-popover");
  console.log("connection popover visible:", await pop.isVisible().catch(() => false),
    "text:", (await pop.textContent().catch(() => "")).slice(0, 60));
  await page.screenshot({ path: `${outDir}/desktop-connection-popover.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  console.log("popover closed on Escape:", !(await pop.isVisible().catch(() => false)));
  await ctx.close();
}

// --- phone 390: drawer sort menu becomes a sheet --------------------------------
{
  const { ctx, page } = await ctxPage(390, 844, true);
  // open drawer via the session context bar / drawer trigger
  await page.locator(".session-nav-current").first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator(".sidebar-sort-trigger").click().catch(() => {});
  await page.waitForTimeout(600);
  const sheet = page.locator(".ui-menu-sheet");
  console.log("phone sort menu as sheet:", await sheet.isVisible().catch(() => false));
  await page.screenshot({ path: `${outDir}/phone-sort-sheet.png` });
  await ctx.close();
}

// --- tablet 768: session-row time clip measurement -------------------------------
{
  const { ctx, page } = await ctxPage(768, 1024, true);
  await page.locator(".ui-icon-btn.header-drawer-btn").first().click().catch(() => {});
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const time = document.querySelector(".session-time");
    const menuBtn = document.querySelector(".session-menu-btn");
    const btn = document.querySelector(".session-btn");
    if (!time || !btn) return { found: false };
    const t = time.getBoundingClientRect();
    const m = menuBtn?.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      found: true,
      timeRect: { left: t.left, right: t.right, w: t.width },
      timeText: time.textContent,
      clippedByMenu: m ? t.right > m.left : false,
      menuLeft: m?.left,
      btnPaddingRight: getComputedStyle(btn).paddingRight,
      timeVisibleWidth: time.scrollWidth <= time.clientWidth,
    };
  });
  console.log("tablet session-row time:", info);
  await page.screenshot({ path: `${outDir}/tablet-session-rows.png` });
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
