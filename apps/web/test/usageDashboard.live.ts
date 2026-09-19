// Real-browser production gate for the compact Usage surface.
// Fixture/server lifecycle is owned by the validation workflow (or run manually
// with usageDashboardFixtureSetup.mjs + build:web + PORT=4458 npm start).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

const BASE = (process.env.POLYTH_USAGE_URL ?? "http://127.0.0.1:4458").replace(/\/$/, "");
const PROJECT_ID = process.env.POLYTH_USAGE_PROJECT_ID ?? "usage-audit-project";
const SESSION_ID = process.env.POLYTH_USAGE_SESSION_ID ?? "usage-audit-0001";
const ARTIFACTS = process.env.POLYTH_USAGE_ARTIFACTS ?? "/tmp/polyth-usage-audit-artifacts";
const OWNER_USAGE_PREFS_KEY = "polyth.usagePrefs.account.usr_owner";
const chromiumCandidates = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter((path): path is string => typeof path === "string" && path.length > 0);

let browser: Browser;
const contexts: BrowserContext[] = [];

async function chromiumPath(): Promise<string> {
  for (const path of chromiumCandidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch { /* next */ }
  }
  const { chromium } = await import("playwright-core");
  const bundled = chromium.executablePath();
  await access(bundled, constants.X_OK);
  return bundled;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((response) => response.json()) as { ok?: boolean };
      if (health.ok) break;
    } catch { /* server still starting */ }
    if (Date.now() > deadline) throw new Error(`${BASE} did not become healthy`);
    await sleep(150);
  }
  const playwright = await import("playwright-core");
  browser = await playwright.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
});

async function closePage(page: Page): Promise<void> {
  const context = page.context();
  await context.close();
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
}

interface OpenOptions {
  width: number;
  height?: number;
  seedUsagePrefs?: boolean;
  appearance?: "dark" | "light";
  theme?: string;
}

async function openApp(options: OpenOptions): Promise<Page> {
  const height = options.height ?? 900;
  const context = await browser.newContext({
    viewport: { width: options.width, height },
    hasTouch: options.width <= 700,
    reducedMotion: "reduce",
    colorScheme: options.appearance ?? "dark",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript((input: {
    projectId: string;
    usageKey: string;
    seedUsagePrefs: boolean;
    appearance?: string;
    theme?: string;
  }) => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
    localStorage.setItem("polyth.packageTours.v1", JSON.stringify({ skippedAll: true, completed: {} }));
    localStorage.setItem(`polyth.workspaceMode.v1.${input.projectId}`, "chat");
    localStorage.setItem(`polyth.capabilityLayout.v1.${input.projectId}`, JSON.stringify({
      version: 1,
      placements: { usage: { tier: "primary", rank: 4 } },
    }));
    localStorage.setItem(`polyth.workspacePanel.v1.${input.projectId}`, JSON.stringify({
      version: 1,
      items: [{
        id: "launcher:usage",
        definitionId: "launcher:usage",
        type: "launcher",
        size: "compact",
        config: {},
      }],
    }));
    if (input.seedUsagePrefs) {
      localStorage.setItem(input.usageKey, JSON.stringify({
        providerCosts: {
          anthropic: { billing: "subscription", monthlyCost: 20, monthlyBudget: null },
          openrouter: { billing: "api", monthlyCost: null, monthlyBudget: 100 },
        },
        dashboard: {
          view: "providers",
          layout: "compact",
          rangeDays: 7,
          rangeMode: "preset",
          chartStyle: "bar",
          chartMetric: "tokens",
          chartGrouping: "provider",
          distributionGrouping: "model",
          showChartLegend: true,
          providerSort: "quota",
          cardMetrics: ["cost", "tokens", "sessions", "ttft", "tps", "cache"],
          performanceStatistic: "p50",
          showApiEquivalent: true,
          showValueMultiplier: true,
          showQuotaDetails: true,
          overviewOrder: [],
          providerOrder: [],
        },
      }));
    }
    if (input.appearance || input.theme) {
      localStorage.setItem("polyth.productSettings.v1", JSON.stringify({
        ...(input.appearance ? { appearanceMode: input.appearance } : {}),
        ...(input.theme ? { theme: input.theme } : {}),
      }));
    }
  }, {
    projectId: PROJECT_ID,
    usageKey: OWNER_USAGE_PREFS_KEY,
    seedUsagePrefs: options.seedUsagePrefs === true,
    ...(options.appearance ? { appearance: options.appearance } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${SESSION_ID}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { state: "visible", timeout: 15_000 });
  return page;
}

async function openUsage(page: Page): Promise<void> {
  if (await page.locator(".usage-dashboard").isVisible().catch(() => false)) return;
  const width = await page.evaluate(() => innerWidth);
  if (width > 820) {
    const button = page.locator(".view-switcher").getByRole("button", { name: /Usage/i });
    await button.waitFor({ state: "visible", timeout: 15_000 });
    await button.click();
  } else if (width > 480) {
    const button = page.locator(".mobile-shortcut-rail").getByRole("button", { name: /Usage/i });
    await button.waitFor({ state: "visible", timeout: 15_000 });
    await button.click();
  } else {
    const tools = page.getByRole("button", { name: "Open tools" });
    await tools.waitFor({ state: "visible", timeout: 15_000 });
    await tools.click();
    const workspace = page.getByRole("dialog", { name: "Workspace" });
    await workspace.waitFor({ state: "visible", timeout: 15_000 });
    await workspace.getByRole("button", { name: /Usage/i }).click();
  }
  await page.waitForSelector(".usage-dashboard", { state: "visible", timeout: 15_000 });
  await page.waitForSelector(".usage-provider-card", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(100);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const dashboard = document.querySelector<HTMLElement>(".usage-dashboard")!;
    const cards = [...document.querySelectorAll<HTMLElement>(".usage-provider-card")];
    const viewportBottom = innerHeight;
    return {
      width: innerWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboardOverflow: dashboard.scrollWidth - dashboard.clientWidth,
      cardCount: cards.length,
      cardHeights: cards.slice(0, 3).map((card) => Math.round(card.getBoundingClientRect().height)),
      cardsAtLeastPartiallyVisible: cards.filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.top < viewportBottom && rect.bottom > 0;
      }).length,
      controls: [...dashboard.querySelectorAll<HTMLElement>("button, input")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      }).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          inside: rect.left >= -1 && rect.right <= innerWidth + 1,
        };
      }),
    };
  });
}

test("Providers is compact, operational, persistent, and settings stay inside Usage", async () => {
  const page = await openApp({ width: 390, height: 844, seedUsagePrefs: true });
  await openUsage(page);

  const providers = page.getByRole("tab", { name: "Providers" });
  assert.equal(await providers.getAttribute("aria-selected"), "true", "Providers must be the default");
  assert.ok(await page.locator(".usage-provider-card").count() >= 5, "fixture provider cards are missing");
  assert.match(await page.locator(".usage-provider-card").first().textContent() ?? "", /Tokens/);
  assert.match(await page.locator(".usage-provider-card").first().textContent() ?? "", /Sessions/);
  assert.equal(await page.getByText(/Resets \d+\/\d+\/|Resets .*AM|Resets .*PM/).count(), 0, "verbose reset timestamps leaked into cards");

  const report = await geometry(page);
  assert.ok(report.documentOverflow <= 1, `document overflows by ${report.documentOverflow}px`);
  assert.ok(report.dashboardOverflow <= 1, `dashboard overflows by ${report.dashboardOverflow}px`);
  assert.ok(report.cardsAtLeastPartiallyVisible >= 2, `only ${report.cardsAtLeastPartiallyVisible} provider card is visible`);
  assert.ok(report.cardHeights.every((height) => height <= 210), `provider cards are oversized: ${report.cardHeights.join(", ")}`);
  assert.ok(report.controls.every((control) => control.label), "a visible Usage control lacks an accessible name");
  assert.ok(report.controls.every((control) => control.inside), "a Usage control escapes the mobile viewport");
  assert.ok(
    report.controls.filter((control) => control.width < 44 || control.height < 44)
      .every((control) => /Claude|OpenAI|Google|OpenRouter|xAI|Mistral|Fake/i.test(control.label)),
    `interactive toolbar/range controls are below the touch target: ${JSON.stringify(report.controls)}`,
  );

  const claude = page.locator(".usage-provider-card", { hasText: "Claude" });
  assert.match(await claude.textContent() ?? "", /Subscription/, "subscription semantics are missing");

  await page.getByRole("tab", { name: "Overview" }).click();
  assert.equal(await page.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true");
  await page.reload({ waitUntil: "load" });
  await openUsage(page);
  assert.equal(await page.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true", "last Usage tab was not restored");
  await page.getByRole("tab", { name: "Providers" }).click();

  await page.getByRole("button", { name: "Usage settings" }).click();
  await page.waitForSelector(".usage-settings-page", { state: "visible" });
  assert.equal(await page.locator(".settings-shell").count(), 0, "Usage settings incorrectly opened the global Settings shell");
  assert.match(await page.locator(".usage-settings-page").textContent() ?? "", /Provider cards/);
  await page.screenshot({ path: join(ARTIFACTS, "usage-mobile-390.png"), fullPage: true });

  // Keep canonical server prefs provider-first for the remaining isolated contexts.
  await page.getByRole("button", { name: "Usage" }).click();
  await page.getByRole("tab", { name: "Providers" }).click();
  await page.waitForTimeout(650);
  await closePage(page);
});

test("Overview exposes useful grouping and populated charts without horizontal overflow", async () => {
  const page = await openApp({ width: 1280, height: 900 });
  await openUsage(page);
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.waitForSelector(".usage-time-chart canvas", { state: "visible" });

  assert.ok(await page.locator(".usage-summary-strip .usage-kpi").count() >= 3);
  assert.ok(await page.locator(".usage-distribution-row").count() >= 4, "top consumers are not populated");

  for (const metric of ["Cost", "Tokens", "Sessions"]) {
    await page.locator('.usage-segmented[aria-label="Usage metric"]').getByRole("button", { name: metric }).click();
    await page.waitForTimeout(80);
    const canvas = page.locator(".usage-time-chart canvas");
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 300 && box.height > 150, `${metric} chart did not render`);
  }
  for (const group of ["Provider", "Model", "Harness", "Project"]) {
    await page.locator('.usage-segmented[aria-label="Usage grouping"]').getByRole("button", { name: group, exact: true }).click();
    await page.waitForTimeout(50);
    assert.ok(await page.locator(".usage-time-chart canvas").count() === 1, `${group} grouping lost the chart`);
  }

  const report = await geometry(page);
  assert.ok(report.documentOverflow <= 1, `desktop document overflows by ${report.documentOverflow}px`);
  assert.ok(report.dashboardOverflow <= 1, `desktop dashboard overflows by ${report.dashboardOverflow}px`);
  await page.screenshot({ path: join(ARTIFACTS, "usage-overview-desktop.png"), fullPage: true });
  await closePage(page);
});

test("compact surface survives iPhone, tablet, desktop, light/dark and long content", async () => {
  const reports: unknown[] = [];
  for (const options of [
    { width: 375, height: 812, appearance: "dark" as const, theme: "ocean" },
    { width: 768, height: 900, appearance: "light" as const, theme: "rosewater" },
    { width: 1440, height: 1000, appearance: "dark" as const, theme: "ocean" },
  ]) {
    const page = await openApp(options);
    await openUsage(page);
    const report = await geometry(page);
    reports.push({ ...options, ...report });
    assert.ok(report.documentOverflow <= 1, `${options.width}px document overflows`);
    assert.ok(report.dashboardOverflow <= 1, `${options.width}px dashboard overflows`);
    assert.ok(report.controls.every((control) => control.inside), `${options.width}px control escapes viewport`);
    await page.screenshot({
      path: join(ARTIFACTS, `usage-${options.width}-${options.appearance}.png`),
      fullPage: true,
    });
    await closePage(page);
  }
  await writeFile(join(ARTIFACTS, "usage-responsive-geometry.json"), JSON.stringify(reports, null, 2));
});
