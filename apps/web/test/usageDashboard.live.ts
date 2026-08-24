// Real-browser live gate for populated Usage settings. The isolated fixture is
// created by usageDashboardFixtureSetup.mjs; this file is outside *.test.ts so
// the default unit suite never depends on a running server or Chromium.
//
//   node --test apps/web/test/usageDashboard.live.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

const base = (process.env.POLYTH_USAGE_URL ?? "http://127.0.0.1:4458").replace(/\/$/, "");
const projectId = process.env.POLYTH_USAGE_PROJECT_ID ?? "usage-audit-project";
const artifacts = process.env.POLYTH_USAGE_ARTIFACTS ?? "/tmp/polyth-usage-audit-artifacts";
const chromiumCandidates = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter((path): path is string => typeof path === "string");

let browser: Browser;
const contexts: BrowserContext[] = [];

async function chromiumPath(): Promise<string> {
  for (const path of chromiumCandidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch { /* try the next well-known executable */ }
  }
  throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH.");
}

before(async () => {
  await mkdir(artifacts, { recursive: true });
  const health = await fetch(`${base}/api/health`).then((response) => response.json()) as { ok?: boolean };
  assert.equal(health.ok, true, `${base} is not a healthy Polyth runtime`);
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

async function showUsage(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("polyth:open-settings")));
  await page.waitForSelector(".settings-shell", { state: "visible", timeout: 15_000 });
  const usageNav = page.locator(".settings-nav-item", { hasText: "Usage" });
  await usageNav.waitFor({ state: "visible", timeout: 15_000 });
  await usageNav.click();
  await page.waitForSelector(".usage-dashboard", { state: "visible", timeout: 15_000 });
  await page.waitForSelector(".usage-cohort-chart svg", { state: "visible", timeout: 15_000 });
  await page.waitForFunction(() =>
    document.querySelector(".usage-dashboard")?.getAttribute("aria-busy") === "false");
  await page.waitForTimeout(120);
}

async function openUsage(width: number, height = 900): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: width <= 700,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript(() => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
    localStorage.setItem("polyth.packageTours.v1", JSON.stringify({ skippedAll: true, completed: {} }));
  });
  const page = await context.newPage();
  await page.goto(`${base}/p/${projectId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { state: "visible", timeout: 15_000 });
  await showUsage(page);
  return page;
}

async function closePage(page: Page): Promise<void> {
  const context = page.context();
  await context.close();
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
}

interface ChartAudit {
  width: number;
  documentOverflow: number;
  paneOverflow: number;
  dashboardOverflow: number;
  bars: number;
  colors: string[];
  legend: string[];
  axisLabels: string[];
  boundsOk: boolean;
  buttons: Array<{ name: string; width: number; height: number; inViewport: boolean }>;
}

async function auditPopulatedChart(page: Page, width: number): Promise<ChartAudit> {
  return page.evaluate((expectedWidth) => {
    const chart = document.querySelector<HTMLElement>(".usage-cohort-chart")!;
    const svg = chart.querySelector<SVGSVGElement>("svg")!;
    const chartRect = chart.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const bars = Array.from(svg.querySelectorAll<SVGRectElement>(".usage-chart-bar"));
    const labels = Array.from(svg.querySelectorAll<SVGTextElement>(".usage-chart-x-label, .usage-chart-y-label"));
    const legendItems = Array.from(document.querySelectorAll<HTMLElement>(".usage-chart-legend > span"));
    const controls = Array.from(document.querySelectorAll<HTMLElement>(".settings-page-usage button"))
      .filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute("aria-label") || button.textContent?.trim() || button.title,
          width: rect.width,
          height: rect.height,
          inViewport: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5,
        };
      });
    const inside = (rect: DOMRect, outer: DOMRect, allowance = 1) =>
      rect.left >= outer.left - allowance
      && rect.right <= outer.right + allowance
      && rect.top >= outer.top - allowance
      && rect.bottom <= outer.bottom + allowance;
    return {
      width: expectedWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      paneOverflow: document.querySelector<HTMLElement>(".settings-pane-body")!.scrollWidth
        - document.querySelector<HTMLElement>(".settings-pane-body")!.clientWidth,
      dashboardOverflow: document.querySelector<HTMLElement>(".usage-dashboard")!.scrollWidth
        - document.querySelector<HTMLElement>(".usage-dashboard")!.clientWidth,
      bars: bars.length,
      colors: [...new Set(bars.map((bar) => getComputedStyle(bar).fill))],
      legend: legendItems.map((item) => item.textContent?.trim() ?? ""),
      axisLabels: labels.map((label) => label.textContent?.trim() ?? ""),
      boundsOk: inside(svgRect, chartRect)
        && labels.every((label) => inside(label.getBoundingClientRect(), chartRect, 2))
        && legendItems.every((item) => {
          const rect = item.getBoundingClientRect();
          const parent = item.parentElement!.getBoundingClientRect();
          return inside(rect, parent, 1);
        }),
      buttons: controls,
    };
  }, width);
}

test("populated charts render cleanly at desktop and 400px mobile", async () => {
  const reports: ChartAudit[] = [];
  for (const width of [1280, 400]) {
    const page = await openUsage(width);
    const report = await auditPopulatedChart(page, width);
    reports.push(report);

    assert.ok(report.bars >= 30, `${width}px: expected a populated stacked chart, got ${report.bars} bars`);
    assert.ok(report.colors.length >= 5, `${width}px: provider series colors collapsed to ${report.colors.length}`);
    assert.equal(report.legend.length, 5, `${width}px: expected four providers plus Other`);
    assert.ok(report.legend.some((label) => label.endsWith("Other (3)")), `${width}px: collapsed Other legend is missing`);
    assert.ok(report.axisLabels.length >= 7, `${width}px: chart axis labels are missing`);
    assert.equal(report.documentOverflow <= 1, true, `${width}px: document overflows by ${report.documentOverflow}px`);
    assert.equal(report.paneOverflow <= 1, true, `${width}px: settings pane overflows by ${report.paneOverflow}px`);
    assert.equal(report.dashboardOverflow <= 1, true, `${width}px: dashboard overflows by ${report.dashboardOverflow}px`);
    assert.equal(report.boundsOk, true, `${width}px: chart labels or legend escape their card`);
    assert.ok(report.buttons.every((button) => button.name), `${width}px: visible button lacks an accessible name`);
    assert.ok(report.buttons.every((button) => button.inViewport), `${width}px: visible button escapes the viewport`);
    if (width === 400) {
      assert.ok(
        report.buttons.every((button) => button.width >= 44 && button.height >= 44),
        `400px: a touch control is smaller than 44×44: ${JSON.stringify(report.buttons.filter((button) => button.width < 44 || button.height < 44))}`,
      );
    }

    await page.locator(".usage-time-card").scrollIntoViewIfNeeded();
    await page.locator(".usage-time-card").screenshot({
      path: join(artifacts, width === 1280 ? "populated-chart-desktop.png" : "populated-chart-mobile-400.png"),
    });
    await closePage(page);
  }
  await writeFile(join(artifacts, "populated-chart-geometry.json"), JSON.stringify(reports, null, 2));
});

test("all usage controls update data, focus, hover, and provider visibility", async () => {
  const page = await openUsage(1280);

  const inactiveView = page.locator(".usage-view-tabs button:not(.active)").first();
  const resting = await inactiveView.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.color}|${style.backgroundColor}|${style.borderColor}`;
  });
  await inactiveView.hover();
  const hovered = await inactiveView.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.color}|${style.backgroundColor}|${style.borderColor}`;
  });
  assert.notEqual(hovered, resting, "view-tab hover has no visual feedback");

  await page.locator('.usage-range-control button[aria-label="30 day range"]').click();
  await page.waitForFunction(() => document.querySelector(".usage-card-heading p")?.textContent?.includes("72 hours each"));
  await page.locator('.usage-range-control button[aria-label="90 day range"]').click();
  await page.waitForFunction(() => document.querySelector(".usage-card-heading p")?.textContent?.includes("180 hours each"));

  await page.locator('.usage-metric-toggle[aria-label="Chart metric"] button', { hasText: "Cost" }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".usage-chart-y-label")).some((label) => label.textContent?.includes("$")));
  await page.locator('.usage-metric-toggle[aria-label="Chart metric"] button', { hasText: "Sessions" }).click();
  assert.ok(await page.locator(".usage-chart-bar").count() > 0, "sessions metric emptied a populated chart");

  await page.locator('.usage-layout-control button[aria-label="Compact widgets"]').click();
  assert.equal(await page.locator(".usage-dashboard").evaluate((element) => element.classList.contains("usage-layout-compact")), true);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".app", { state: "visible", timeout: 15_000 });
  await showUsage(page);
  await page.waitForSelector(".usage-dashboard.usage-layout-compact", { state: "visible", timeout: 15_000 });
  assert.equal(await page.locator('.usage-range-control button[aria-label="90 day range"]').getAttribute("aria-pressed"), "true");

  const overviewButton = page.locator(".usage-view-tabs button", { hasText: "Overview" });
  await overviewButton.focus();
  const focus = await overviewButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
  });
  assert.ok(focus.width >= 2 && focus.style !== "none", `focus ring is not visible: ${JSON.stringify(focus)}`);

  await page.locator(".usage-view-tabs button", { hasText: "Providers" }).click();
  await page.waitForSelector(".usage-provider-view", { state: "visible" });
  assert.equal(await page.locator(".usage-provider-detail-card").count(), 7);
  const fakeCard = page.locator(".usage-provider-detail-card", { hasText: "Fake Provider" });
  await fakeCard.locator("button", { hasText: "Refresh" }).click();
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".usage-provider-detail-card button"))
      .find((candidate) => candidate.textContent?.includes("Refresh") && candidate.closest(".usage-provider-detail-card")?.textContent?.includes("Fake Provider"));
    return button?.disabled === false;
  });

  const anthropicCard = page.locator(".usage-provider-detail-card", { hasText: "Claude" });
  await anthropicCard.locator("button", { hasText: "Hide from breakdowns" }).click();
  await anthropicCard.locator("button", { hasText: "Show in breakdowns" }).waitFor();
  await page.locator(".usage-view-tabs button", { hasText: "Overview" }).click();
  await page.waitForSelector(".usage-providers-card");
  assert.equal(await page.locator(".usage-provider-cell", { hasText: "Claude" }).count(), 0, "hidden provider remains in breakdown table");
  assert.match(await page.locator(".usage-action-strip").textContent() ?? "", /1 provider is hidden/);

  await page.locator(".usage-spend-card .usage-icon-button").click();
  await page.waitForSelector(".usage-provider-view", { state: "visible" });
  assert.equal(await page.locator(".usage-view-tabs button", { hasText: "Providers" }).getAttribute("aria-pressed"), "true");

  await page.locator(".usage-provider-view-intro button", { hasText: "Add provider" }).click();
  await page.waitForSelector(".settings-page-models", { state: "visible", timeout: 15_000 });
  await closePage(page);
});

test("usage layout has no horizontal overflow across every responsive breakpoint", async () => {
  const widths = [1280, 1050, 821, 820, 761, 760, 701, 700, 601, 600, 481, 480, 400, 320];
  const reports: Array<{ width: number; documentOverflow: number; paneOverflow: number; dashboardOverflow: number }> = [];
  for (const width of widths) {
    const page = await openUsage(width);
    const report = await page.evaluate((viewportWidth) => ({
      width: viewportWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      paneOverflow: document.querySelector<HTMLElement>(".settings-pane-body")!.scrollWidth
        - document.querySelector<HTMLElement>(".settings-pane-body")!.clientWidth,
      dashboardOverflow: document.querySelector<HTMLElement>(".usage-dashboard")!.scrollWidth
        - document.querySelector<HTMLElement>(".usage-dashboard")!.clientWidth,
    }), width);
    reports.push(report);
    assert.ok(report.documentOverflow <= 1, `${width}px: document overflows by ${report.documentOverflow}px`);
    assert.ok(report.paneOverflow <= 1, `${width}px: settings pane overflows by ${report.paneOverflow}px`);
    assert.ok(report.dashboardOverflow <= 1, `${width}px: usage dashboard overflows by ${report.dashboardOverflow}px`);
    await closePage(page);
  }
  await writeFile(join(artifacts, "responsive-breakpoints.json"), JSON.stringify(reports, null, 2));
});
