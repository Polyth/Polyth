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
  "/snap/bin/chromium",
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

async function openUsage(
  width: number,
  height = 900,
  productSettings: { theme: string; appearanceMode: "dark" | "light" } | null = null,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: width <= 700,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript((settings) => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
    localStorage.setItem("polyth.packageTours.v1", JSON.stringify({ skippedAll: true, completed: {} }));
    if (settings) localStorage.setItem("polyth.productSettings.v1", JSON.stringify(settings));
  }, productSettings);
  const page = await context.newPage();
  await page.goto(`${base}/p/${projectId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { state: "visible", timeout: 15_000 });
  await showUsage(page);
  return page;
}

test("usage surfaces follow contrasting app themes", async () => {
  const colors: string[][] = [];
  for (const settings of [
    { theme: "ocean", appearanceMode: "dark" as const },
    { theme: "rosewater", appearanceMode: "light" as const },
  ]) {
    const page = await openUsage(1280, 900, settings);
    colors.push(await page.evaluate(() => [
      getComputedStyle(document.querySelector<HTMLElement>(".usage-dashboard")!).backgroundColor,
      getComputedStyle(document.querySelector<HTMLElement>(".usage-dashboard-toolbar")!).backgroundColor,
      getComputedStyle(document.querySelector<HTMLElement>(".usage-dashboard-card")!).backgroundColor,
      getComputedStyle(document.querySelector<HTMLElement>(".usage-dashboard-card")!).color,
    ]));
    await page.screenshot({ path: join(artifacts, `theme-${settings.theme}.png`) });
    await closePage(page);
  }
  assert.notDeepEqual(colors[0], colors[1], "usage surfaces remain the same gray palette across app themes");
});

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
  const combinations: Array<{
    width: number;
    range: number;
    metric: string;
    bars: number;
    labels: string[];
    boundsOk: boolean;
    overflow: number;
  }> = [];
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

    for (const range of [7, 30, 90]) {
      await page.locator(".usage-range-control button", { hasText: `${range}d` }).click();
      for (const metric of ["Tokens", "Cost", "Sessions"]) {
        await page.locator('.usage-metric-toggle[aria-label="Chart metric"] button', { hasText: metric }).click();
        await page.waitForTimeout(40);
        const state = await auditPopulatedChart(page, width);
        combinations.push({
          width,
          range,
          metric,
          bars: state.bars,
          labels: state.axisLabels,
          boundsOk: state.boundsOk,
          overflow: Math.max(state.documentOverflow, state.paneOverflow, state.dashboardOverflow),
        });
        assert.ok(state.bars > 0, `${width}px ${range}d ${metric}: populated chart has no bars`);
        assert.equal(state.boundsOk, true, `${width}px ${range}d ${metric}: labels or legend escape their card`);
        assert.ok(
          Math.max(state.documentOverflow, state.paneOverflow, state.dashboardOverflow) <= 1,
          `${width}px ${range}d ${metric}: chart creates horizontal overflow`,
        );
        assert.equal(state.legend.length, 5, `${width}px ${range}d ${metric}: provider legend changed shape`);
        if (metric === "Cost") {
          assert.ok(state.axisLabels.some((label) => label.includes("$")), `${width}px ${range}d: cost axis is not formatted as currency`);
        }
      }
    }
    await closePage(page);
  }
  await writeFile(join(artifacts, "populated-chart-geometry.json"), JSON.stringify(reports, null, 2));
  await writeFile(join(artifacts, "populated-chart-combinations.json"), JSON.stringify(combinations, null, 2));
});

test("all usage controls update data, focus, hover, and provider visibility", async () => {
  const page = await openUsage(1280);

  const inactiveView = page.locator(".usage-view-tabs button:not(.ui-tab--selected)").first();
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

  await page.locator(".usage-range-control button", { hasText: "30d" }).click();
  await page.waitForFunction(() => document.querySelector(".usage-card-heading p")?.textContent?.includes("72 hours each"));
  await page.locator(".usage-range-control button", { hasText: "90d" }).click();
  await page.waitForFunction(() => document.querySelector(".usage-card-heading p")?.textContent?.includes("180 hours each"));

  await page.locator('.usage-metric-toggle[aria-label="Chart metric"] button', { hasText: "Cost" }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".usage-chart-y-label")).some((label) => label.textContent?.includes("$")));
  await page.locator('.usage-metric-toggle[aria-label="Chart metric"] button', { hasText: "Sessions" }).click();
  assert.ok(await page.locator(".usage-chart-bar").count() > 0, "sessions metric emptied a populated chart");

  const expandedCardHeight = await page.locator(".usage-stat-card").first().evaluate((element) => element.getBoundingClientRect().height);
  await page.locator(".usage-layout-control button", { hasText: "Compact" }).click();
  assert.equal(await page.locator(".usage-dashboard").evaluate((element) => element.classList.contains("usage-layout-compact")), true);
  const compactCardHeight = await page.locator(".usage-stat-card").first().evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(compactCardHeight < expandedCardHeight - 20, `compact density only changed a stat card from ${expandedCardHeight}px to ${compactCardHeight}px`);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".app", { state: "visible", timeout: 15_000 });
  await showUsage(page);
  await page.waitForSelector(".usage-dashboard.usage-layout-compact", { state: "visible", timeout: 15_000 });
  assert.equal(await page.locator(".usage-range-control button", { hasText: "90d" }).getAttribute("aria-selected"), "true");

  const overviewButton = page.locator(".usage-view-tabs button", { hasText: "Overview" });
  await overviewButton.focus();
  await page.keyboard.press("Tab");
  const keyboardFocusedView = page.locator(".usage-view-tabs button", { hasText: "Providers" });
  const focus = await keyboardFocusedView.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
  });
  assert.ok(focus.width >= 2 && focus.style !== "none", `focus ring is not visible: ${JSON.stringify(focus)}`);

  await page.locator(".settings-pane-body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.locator(".usage-view-tabs button", { hasText: "Providers" }).click();
  await page.waitForSelector(".usage-provider-view", { state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector<HTMLElement>(".settings-pane-body")?.scrollTop === 0);
  assert.equal(await page.locator(".usage-provider-detail-card").count(), 7);
  const fakeCard = page.locator(".usage-provider-detail-card", { hasText: "Fake Provider" });
  await fakeCard.locator("button", { hasText: "Refresh" }).click();
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".usage-provider-detail-card button"))
      .find((candidate) => candidate.textContent?.includes("Refresh") && candidate.closest(".usage-provider-detail-card")?.textContent?.includes("Fake Provider"));
    return button?.disabled === false;
  });
  await fakeCard.getByLabel("Pin Fake Provider to top").click();
  assert.match(await page.locator(".usage-provider-detail-card").first().textContent() ?? "", /Fake Provider/);
  assert.equal(await fakeCard.locator(".usage-provider-pin").getAttribute("aria-pressed"), "true");

  const anthropicCard = page.locator(".usage-provider-detail-card", { hasText: "Claude" });
  await anthropicCard.locator("button", { hasText: "Hide from breakdowns" }).click();
  await anthropicCard.locator("button", { hasText: "Show in breakdowns" }).waitFor();
  await page.locator(".usage-view-tabs button", { hasText: "Overview" }).click();
  await page.waitForSelector(".usage-providers-card");
  assert.equal(await page.locator(".usage-provider-cell", { hasText: "Claude" }).count(), 0, "hidden provider remains in breakdown table");
  assert.match(await page.locator(".usage-action-strip").textContent() ?? "", /1 provider is hidden/);

  await page.locator(".usage-spend-card .ui-icon-btn").click();
  await page.waitForSelector(".usage-provider-view", { state: "visible" });
  assert.equal(await page.locator(".usage-view-tabs button", { hasText: "Providers" }).getAttribute("aria-selected"), "true");

  await page.locator(".usage-provider-view-intro button", { hasText: "Add provider" }).click();
  await page.waitForSelector(".settings-page-models", { state: "visible", timeout: 15_000 });
  await closePage(page);
});

test("usage layout has no horizontal overflow or toolbar overlap across every responsive breakpoint", async () => {
  const widths = [1280, 1050, 821, 820, 761, 760, 701, 700, 601, 600, 481, 480, 400, 320];
  const reports: Array<{
    width: number;
    documentOverflow: number;
    paneOverflow: number;
    dashboardOverflow: number;
    toolbarContainsControls: boolean;
    contentStartsAfterToolbar: boolean;
  }> = [];
  for (const width of widths) {
    const page = await openUsage(width);
    const report = await page.evaluate((viewportWidth) => {
      const pane = document.querySelector<HTMLElement>(".settings-pane-body")!;
      pane.scrollTop = 0;
      const dashboard = document.querySelector<HTMLElement>(".usage-dashboard")!;
      const toolbar = document.querySelector<HTMLElement>(".usage-dashboard-toolbar")!.getBoundingClientRect();
      const controls = document.querySelector<HTMLElement>(".usage-toolbar-controls")!.getBoundingClientRect();
      const content = document.querySelector<HTMLElement>(".usage-dashboard-content")!.getBoundingClientRect();
      return {
        width: viewportWidth,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        dashboardOverflow: dashboard.scrollWidth - dashboard.clientWidth,
        toolbarContainsControls: controls.top >= toolbar.top - 1 && controls.bottom <= toolbar.bottom + 1,
        contentStartsAfterToolbar: content.top >= toolbar.bottom - 1,
      };
    }, width);
    reports.push(report);
    assert.ok(report.documentOverflow <= 1, `${width}px: document overflows by ${report.documentOverflow}px`);
    assert.ok(report.paneOverflow <= 1, `${width}px: settings pane overflows by ${report.paneOverflow}px`);
    assert.ok(report.dashboardOverflow <= 1, `${width}px: usage dashboard overflows by ${report.dashboardOverflow}px`);
    assert.equal(report.toolbarContainsControls, true, `${width}px: usage controls escape the toolbar`);
    assert.equal(report.contentStartsAfterToolbar, true, `${width}px: usage controls overlap dashboard content`);
    await closePage(page);
  }
  await writeFile(join(artifacts, "responsive-breakpoints.json"), JSON.stringify(reports, null, 2));
});

test("resizing an open usage page from desktop to mobile preserves the page", async () => {
  const page = await openUsage(1280);
  await page.setViewportSize({ width: 400, height: 900 });
  await page.waitForSelector(".settings-shell.settings-mobile-page .usage-dashboard", {
    state: "visible",
    timeout: 15_000,
  });

  const state = await page.evaluate(() => {
    const dashboard = document.querySelector<HTMLElement>(".usage-dashboard")!;
    const bounds = dashboard.getBoundingClientRect();
    return {
      width: bounds.width,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboardOverflow: dashboard.scrollWidth - dashboard.clientWidth,
    };
  });
  assert.ok(state.width > 0, "usage dashboard collapsed after crossing the mobile breakpoint");
  assert.ok(state.documentOverflow <= 1, `resized document overflows by ${state.documentOverflow}px`);
  assert.ok(state.dashboardOverflow <= 1, `resized dashboard overflows by ${state.dashboardOverflow}px`);

  await closePage(page);
});

test("usage labels expose valid names and meet AA text contrast", async () => {
  const page = await openUsage(1280);
  const contrastRatios = (selectors: string[]) => page.evaluate((targets) => {
    type Rgb = { r: number; g: number; b: number };
    type Rgba = Rgb & { a: number };
    const parse = (value: string): Rgba => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return {
        r: values[0] ?? 0,
        g: values[1] ?? 0,
        b: values[2] ?? 0,
        a: values[3] ?? 1,
      };
    };
    const luminance = ({ r, g, b }: Rgb) => {
      const channel = (value: number) => {
        const ratio = value / 255;
        return ratio <= .03928 ? ratio / 12.92 : ((ratio + .055) / 1.055) ** 2.4;
      };
      return .2126 * channel(r) + .7152 * channel(g) + .0722 * channel(b);
    };
    const background = (element: Element): Rgb => {
      const layers: Rgba[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color.a > 0) layers.push(color);
        if (color.a >= 1) break;
      }
      let result: Rgb = { r: 255, g: 255, b: 255 };
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index]!;
        result = {
          r: layer.r * layer.a + result.r * (1 - layer.a),
          g: layer.g * layer.a + result.g * (1 - layer.a),
          b: layer.b * layer.a + result.b * (1 - layer.a),
        };
      }
      return result;
    };
    return targets.flatMap((selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
        const foreground = parse(getComputedStyle(element).color);
        const light = luminance(foreground);
        const dark = luminance(background(element));
        return {
          selector,
          text: element.textContent?.trim() ?? "",
          ratio: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05),
        };
      }));
  }, selectors);

  assert.equal(await page.locator(".usage-trend[aria-label]").count(), 0);
  assert.equal(
    await page.locator(".usage-trend").count(),
    await page.locator(".usage-trend > .sr-only").count(),
    "every visual trend needs equivalent screen-reader text",
  );

  const overviewRatios = await contrastRatios([
    ".usage-view-tabs button.ui-tab--selected",
    ".usage-range-control button.ui-tab--selected",
    ".usage-layout-control button.ui-tab--selected",
    ".usage-metric-toggle button.ui-tab--selected",
    ".usage-trend-up > span:last-child",
    ".usage-trend-down > span:last-child",
  ]);
  for (const item of overviewRatios) {
    assert.ok(item.ratio >= 4.5, `${item.selector} "${item.text}" contrast is ${item.ratio.toFixed(2)}:1`);
  }

  await page.locator(".usage-view-tabs button", { hasText: "Providers" }).click();
  await page.waitForSelector(".usage-provider-detail-card", { state: "visible" });
  const providerRatios = await contrastRatios([
    ".usage-status-pill",
    ".usage-provider-view-intro button",
  ]);
  for (const item of providerRatios) {
    assert.ok(item.ratio >= 4.5, `${item.selector} "${item.text}" contrast is ${item.ratio.toFixed(2)}:1`);
  }

  await closePage(page);
});
