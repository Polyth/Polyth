// Dev-only verification of safe-area + keyboard CSS contracts (Wave 3).
// Headless Chrome cannot shrink the visual viewport independently or emulate
// notches, so this publishes the exact custom properties / body attributes
// that mobileViewport.ts would publish and asserts the resulting geometry.
// Usage: node scripts/ui-safearea-check.mjs <outdir> <path>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-safearea";
const path = process.argv[3] ?? "/";
const base = process.env.POLYTH_URL ?? "http://127.0.0.1:4400";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

async function ctxPage(width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
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

const simulateSafeArea = (page, { top = 0, right = 0, bottom = 0, left = 0 }) =>
  page.addStyleTag({
    content: `:root { --safe-top: ${top}px !important; --safe-right: ${right}px !important;
      --safe-bottom: ${bottom}px !important; --safe-left: ${left}px !important; }`,
  });

const simulateKeyboard = (page, inset, viewportH) =>
  page.evaluate(({ inset, viewportH }) => {
    const h = viewportH - inset;
    const root = document.documentElement;
    root.style.setProperty("--visual-vh", `${h}px`);
    root.style.setProperty("--visual-bottom", `${h}px`);
    root.style.setProperty("--keyboard-inset", `${inset}px`);
    root.style.setProperty("--visual-offset", "0px");
    document.body.dataset.keyboard = inset > 0 ? "open" : "closed";
    document.body.dataset.band = h < 420 ? "short" : "tall";
  }, { inset, viewportH });

// --- phone portrait 390x844: notch safe areas ---------------------------------
{
  const { ctx, page } = await ctxPage(390, 844);
  await simulateSafeArea(page, { top: 47, bottom: 34 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const header = document.querySelector(".mobile-chat-header");
    const nav = document.querySelector(".workspace-bottom-nav, .session-bottom-nav");
    const h = header?.getBoundingClientRect();
    const n = nav ? getComputedStyle(nav) : null;
    return {
      headerHeight: h?.height,
      headerPaddingTop: header ? getComputedStyle(header).paddingTop : null,
      navHeight: nav?.getBoundingClientRect().height,
      navPaddingBottom: n?.paddingBottom,
      navClass: nav?.className,
    };
  });
  console.log("phone notch (top 47 / bottom 34):", info);
  await page.screenshot({ path: `${outDir}/phone-notch.png` });
  await ctx.close();
}

// --- phone portrait: 320px keyboard -------------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844);
  await page.locator("[data-composer-input]").click().catch(() => {});
  await simulateKeyboard(page, 320, 844);
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const nav = document.querySelector(".workspace-bottom-nav, .session-bottom-nav");
    const composer = document.querySelector(".composer");
    const a = app?.getBoundingClientRect();
    const c = composer?.getBoundingClientRect();
    const navStyle = nav ? getComputedStyle(nav) : null;
    return {
      appHeight: a?.height,
      appBottom: a?.bottom,
      composerBottom: c?.bottom,
      visibleLine: 844 - 320,
      navHidden: navStyle ? (navStyle.display === "none" || navStyle.visibility === "hidden") : "no nav",
      keyboardAttr: document.body.dataset.keyboard,
    };
  });
  console.log("phone keyboard open (inset 320):", info);
  await page.screenshot({ path: `${outDir}/phone-keyboard-open.png` });
  await ctx.close();
}

// --- phone: sheet with keyboard up ---------------------------------------------
{
  const { ctx, page } = await ctxPage(390, 844);
  await page.locator(".session-nav-current").first().click().catch(() => {});
  await page.waitForTimeout(500);
  await simulateKeyboard(page, 320, 844);
  await page.locator(".sidebar-sort-trigger").click().catch(() => {});
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const sheet = document.querySelector(".sheet");
    if (!sheet) return { found: false };
    const r = sheet.getBoundingClientRect();
    const cs = getComputedStyle(sheet);
    return { found: true, bottom: r.bottom, top: r.top, marginBottom: cs.marginBottom, visibleLine: 844 - 320 };
  });
  console.log("sheet with keyboard (bottom should be <= 524):", info);
  await page.screenshot({ path: `${outDir}/phone-sheet-keyboard.png` });
  await ctx.close();
}

// --- landscape phone 844x390: left/right safe areas -----------------------------
{
  const { ctx, page } = await ctxPage(844, 390);
  await simulateSafeArea(page, { left: 47, right: 47, bottom: 21 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const nav = document.querySelector(".workspace-bottom-nav, .session-bottom-nav");
    const header = document.querySelector(".mobile-chat-header, .header");
    const n = nav ? getComputedStyle(nav) : null;
    const h = header ? getComputedStyle(header) : null;
    return {
      navPadding: n ? `${n.paddingLeft} / ${n.paddingRight} / bottom ${n.paddingBottom}` : null,
      headerPadding: h ? `${h.paddingLeft} / ${h.paddingRight}` : null,
    };
  });
  console.log("landscape safe areas (l/r 47, bottom 21):", info);
  await page.screenshot({ path: `${outDir}/landscape-safearea.png` });
  await ctx.close();
}

await browser.close();
console.log(`saved to ${outDir}`);
