// Phase 1 Wave 3 evidence set: representative screenshots of the redesigned
// shell + composer across breakpoints, themes, and interaction states.
// Usage: node scripts/ui-evidence.mjs <outdir> <projectId> <sessionId>
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? "docs/ui-redesign/phase-1-evidence";
const projectId = process.argv[3];
const sessionId = process.argv[4];
const base = process.env.POLYTH_URL ?? "http://127.0.0.1:4400";
const sessionPath = `/p/${projectId}/s/${sessionId}`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

async function shoot({ name, width, height, mobile = false, dark = false, path = sessionPath, act }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(900);
  if (act) await act(page);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  await ctx.close();
  console.log(name);
}

// Breakpoints, light theme, active conversation.
await shoot({ name: "shell-320-light", width: 320, height: 700, mobile: true });
await shoot({ name: "shell-360-light", width: 360, height: 780, mobile: true });
await shoot({ name: "shell-390-light", width: 390, height: 844, mobile: true });
await shoot({ name: "shell-430-light", width: 430, height: 932, mobile: true });
await shoot({ name: "shell-768-light", width: 768, height: 1024, mobile: true });
await shoot({ name: "shell-1024-light", width: 1024, height: 768 });
await shoot({ name: "shell-1280-light", width: 1280, height: 800 });

// Dark theme.
await shoot({ name: "shell-390-dark", width: 390, height: 844, mobile: true, dark: true });
await shoot({ name: "shell-1280-dark", width: 1280, height: 800, dark: true });

// Landscape phone.
await shoot({ name: "shell-844x390-landscape", width: 844, height: 390, mobile: true });

// Empty state (project root, no session).
await shoot({ name: "empty-state-390", width: 390, height: 844, mobile: true, path: `/p/${projectId}` });
await shoot({ name: "empty-state-1280", width: 1280, height: 800, path: `/p/${projectId}` });

// Drawer (progressive disclosure) on phone.
await shoot({
  name: "phone-drawer-long-titles",
  width: 390,
  height: 844,
  mobile: true,
  act: async (page) => {
    await page.locator(".session-nav-current").first().click().catch(() => {});
    await page.waitForTimeout(600);
  },
});

// Sheet: sidebar sort menu on phone (ui/Menu -> Sheet).
await shoot({
  name: "phone-menu-sheet",
  width: 390,
  height: 844,
  mobile: true,
  act: async (page) => {
    await page.locator(".session-nav-current").first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator(".sidebar-sort-trigger").click().catch(() => {});
    await page.waitForTimeout(600);
  },
});

// Model picker sheet on phone.
await shoot({
  name: "phone-model-picker",
  width: 390,
  height: 844,
  mobile: true,
  act: async (page) => {
    await page.locator(".model-picker-trigger").first().click().catch(() => {});
    await page.waitForTimeout(700);
  },
});

// Popover + menu on desktop: user menu and connection popover.
await shoot({
  name: "desktop-user-menu",
  width: 1280,
  height: 800,
  act: async (page) => {
    await page.locator(".header-profile").click().catch(() => {});
    await page.waitForTimeout(400);
  },
});
await shoot({
  name: "desktop-connection-popover",
  width: 1280,
  height: 800,
  act: async (page) => {
    await page.locator(".sidebar-connection-dot").click().catch(() => {});
    await page.waitForTimeout(400);
  },
});

// Dialog: settings overlay on desktop.
await shoot({
  name: "desktop-settings-dialog",
  width: 1280,
  height: 800,
  act: async (page) => {
    await page.locator(".header-profile").click().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator(".ui-menu [role=menuitem]").last().click().catch(() => {});
    await page.waitForTimeout(600);
  },
});

// Keyboard-up phone composer (visual viewport contract).
await shoot({
  name: "phone-keyboard-open",
  width: 390,
  height: 844,
  mobile: true,
  act: async (page) => {
    await page.locator("[data-composer-input]").click().catch(() => {});
    await page.evaluate(() => {
      const h = 844 - 320;
      const root = document.documentElement;
      root.style.setProperty("--visual-vh", `${h}px`);
      root.style.setProperty("--visual-bottom", `${h}px`);
      root.style.setProperty("--keyboard-inset", "320px");
      document.body.dataset.keyboard = "open";
      document.body.dataset.band = "tall";
    });
    await page.waitForTimeout(500);
  },
});

// Composer typed (send enabled) on desktop.
await shoot({
  name: "desktop-composer-typed",
  width: 1280,
  height: 800,
  act: async (page) => {
    await page.locator("[data-composer-input]").click().catch(() => {});
    await page.keyboard.type("Refactor the shell layout so panels collapse gracefully");
    await page.waitForTimeout(400);
  },
});

await browser.close();
console.log(`evidence saved to ${outDir}`);
