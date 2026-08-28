// Dev-only verification of the P2-W1 navigation surfaces: session-row states
// and the unified row menu, contextual project actions, the merged sort/filter
// menu, density, and phone/tablet drawer behavior.
// Usage: node scripts/ui-nav-check.mjs <outdir>
// Requires a running server (npm start) with at least one project + sessions.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp/ui-nav";
const base = process.env.POLYTH_URL ?? "http://127.0.0.1:4400";
mkdirSync(outDir, { recursive: true });

const projects = await (await fetch(`${base}/api/projects`)).json();
const pid = process.env.POLYTH_QA_PID ?? projects[0]?.id;
const projectIds = projects.map((p) => p.id);
if (!pid) { console.error("no projects — seed one first"); process.exit(1); }

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

// Patch statuses onto the first sessions so every row state renders.
async function patchStatuses(page) {
  await page.route(`**/api/sessions?projectId=${pid}`, async (route) => {
    const res = await route.fetch();
    const sessions = await res.json();
    const now = Date.now();
    const patch = [
      (s) => { s.status = "working"; s.lastTurnAt = now - 154000; },
      (s) => { s.attention = { questions: 1 }; },
      (s) => { s.attention = { permissions: 1 }; },
      (s) => { s.attention = { unread: 2 }; },
    ];
    sessions.slice(0, 4).forEach((s, i) => patch[i](s));
    await route.fulfill({ json: sessions });
  });
}

async function ctxPage(width, height, mobile, { statuses = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await ctx.newPage();
  await page.addInitScript((ids) => {
    for (const id of ids) localStorage.setItem(`polyth.projectSetup.v1.${id}`, "completed");
  }, projectIds);
  if (statuses) await patchStatuses(page);
  await page.goto(base + "/", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1200);
  return { ctx, page };
}

const log = (...a) => console.log(...a);

// ---- desktop 1280: hover reveal, row menu, project actions, list options ----
{
  const { ctx, page } = await ctxPage(1280, 800, false);
  await page.screenshot({ path: `${outDir}/desktop-rest.png` });

  const row = page.locator(".session-row").first();
  await row.hover();
  await page.waitForTimeout(250);
  const trig = row.locator(".session-menu-trigger");
  log("hover trigger opacity:", await trig.evaluate((el) => getComputedStyle(el).opacity));
  log("hover status-zone opacity:", await row.locator(".session-status-zone").evaluate((el) => getComputedStyle(el).opacity));

  await trig.click();
  await page.waitForTimeout(350);
  const menu = page.locator('[role="menu"]');
  log("row menu items:", (await menu.locator('[role^="menuitem"]').allTextContents()).join(" | "));
  await page.screenshot({ path: `${outDir}/desktop-row-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  const card = page.locator(".project-card-shell").first();
  await card.hover();
  await page.waitForTimeout(250);
  log("project actions opacity on hover:", await card.locator(".project-actions").evaluate((el) => getComputedStyle(el).opacity));
  await card.locator(".project-menu-btn").click();
  await page.waitForTimeout(350);
  log("project menu items:", (await menu.locator('[role^="menuitem"]').allTextContents()).join(" | "));
  await page.screenshot({ path: `${outDir}/desktop-project-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  await page.locator(".sidebar-list-options").click();
  await page.waitForTimeout(350);
  log("list options roles:", await menu.locator('[role^="menuitem"]').evaluateAll(
    (els) => els.map((e) => `${e.getAttribute("role")}:${e.getAttribute("aria-checked")}`)));
  await page.screenshot({ path: `${outDir}/desktop-list-options.png` });
  await menu.locator('[role="menuitemcheckbox"]').click();
  log("menu stays open after checkbox toggle:", await menu.isVisible());
  await menu.locator('[role="menuitemcheckbox"]').click();
  await page.keyboard.press("Escape");
  await ctx.close();
}

// ---- phone 390: drawer with persistent triggers, sheet menus ----
{
  const { ctx, page } = await ctxPage(390, 844, true);
  await page.locator(".session-nav-current").first().click().catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/phone-drawer.png` });
  log("phone project actions opacity:", await page.locator(".project-actions").first()
    .evaluate((el) => getComputedStyle(el).opacity).catch(() => "?"));
  await page.locator(".session-menu-trigger").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  log("phone session menu as sheet:", await page.locator(".ui-menu-sheet").isVisible().catch(() => false));
  await page.screenshot({ path: `${outDir}/phone-session-sheet.png` });
  await ctx.close();
}

// ---- tablet 768 (touch): persistent trigger, no timestamp clipping ----
{
  const { ctx, page } = await ctxPage(768, 1024, true);
  await page.locator(".session-nav-current, .header-drawer-btn").first().click().catch(() => {});
  await page.waitForTimeout(700);
  log("tablet row:", await page.evaluate(() => {
    const time = document.querySelector(".session-time");
    const trig = document.querySelector(".session-menu-trigger");
    const btn = document.querySelector(".session-btn");
    if (!btn) return { found: false };
    const t = time?.getBoundingClientRect();
    const m = trig?.getBoundingClientRect();
    return {
      found: true,
      clippedByTrigger: t && m ? t.right > m.left : false,
      btnPaddingRight: getComputedStyle(btn).paddingRight,
      trigSize: m ? `${m.width}x${m.height}` : "?",
    };
  }));
  await page.screenshot({ path: `${outDir}/tablet-drawer.png` });
  await ctx.close();
}

await browser.close();
log(`saved to ${outDir}`);
