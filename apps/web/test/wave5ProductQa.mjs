// Phase 2 Wave 5 full-product browser QA driver (manual; not part of
// `npm test`). It exercises the built application rather than component
// mocks and writes representative evidence screenshots to OUT.
//
// Usage:
//   OUT=/tmp/wave5-product node apps/web/test/wave5ProductQa.mjs
// Optional:
//   POLYTH_URL=http://127.0.0.1:4400
//   POLYTH_CHAT_URL=http://127.0.0.1:4471
//   POLYTH_PICKER_URL=http://127.0.0.1:4473
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const APP = process.env.POLYTH_URL ?? "http://127.0.0.1:4400";
const CHAT = process.env.POLYTH_CHAT_URL ?? "http://127.0.0.1:4471";
const PICKER = process.env.POLYTH_PICKER_URL ?? "http://127.0.0.1:4473";
const OUT = process.env.OUT ?? "/tmp/wave5-product";
const CHROME = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });

const assert = (condition, message) => {
  if (!condition) throw new Error(`QA assertion failed: ${message}`);
};

const projects = await (await fetch(`${APP}/api/projects`)).json();
const sessions = await (await fetch(`${APP}/api/sessions`)).json();
const project = projects.find((candidate) => sessions.some((session) => session.projectId === candidate.id))
  ?? projects[0];
const session = sessions.find((candidate) => candidate.projectId === project?.id);
assert(project && session, "the application fixture has a project and session");

const appPath = `/p/${project.id}/s/${session.id}`;
const prefs = JSON.stringify({ persona: "engineer", plugins: [] });
const tourPrefs = JSON.stringify({ skippedAll: true, completed: {} });
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
});
const diagnostics = [];

async function open({
  base = APP,
  path = appPath,
  width,
  height,
  touch = width <= 480,
  locale = "en",
  reducedMotion = "reduce",
  routes,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch,
    reducedMotion,
    serviceWorkers: "block",
  });
  await context.addInitScript(({ locale, prefs, tourPrefs }) => {
    localStorage.setItem("polyth.prefs", prefs);
    localStorage.setItem("polyth.packageTours.v1", tourPrefs);
    localStorage.setItem("polyth.locale", locale);
  }, {
    locale,
    prefs,
    tourPrefs,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  if (routes) await routes(page);
  await page.goto(base + path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForTimeout(700);
  return { context, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function assertNoPageOverflow(page, label) {
  const result = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    duplicateIds: [...document.querySelectorAll("[id]")]
      .map((element) => element.id)
      .filter((id, index, all) => id && all.indexOf(id) !== index),
  }));
  assert(result.document <= result.viewport + 1,
    `${label} has horizontal overflow (${result.document} > ${result.viewport})`);
  assert(result.duplicateIds.length === 0,
    `${label} has duplicate ids: ${result.duplicateIds.join(", ")}`);
}

async function closePane(page, label) {
  const opener = page.locator(`button[aria-label="${label}"]`).first();
  if (await opener.getAttribute("aria-pressed") === "true") await opener.click();
  await page.waitForTimeout(150);
}

// Required viewport and orientation matrix over a dense conversation. Every
// size checks root overflow; selected sizes become evidence.
const matrix = [
  ["phone-320x568", 320, 568, true],
  ["phone-360x800", 360, 800, true],
  ["phone-375x812", 375, 812, true],
  ["phone-390x844", 390, 844, true],
  ["phone-430x932", 430, 932, true],
  ["phone-landscape-568x320", 568, 320, true],
  ["phone-landscape-844x390", 844, 390, true],
  ["tablet-768x1024", 768, 1024, true],
  ["tablet-landscape-1024x768", 1024, 768, true],
  ["desktop-1280x800", 1280, 800, false],
  ["desktop-1440x900", 1440, 900, false],
  ["desktop-wide-1920x1080", 1920, 1080, false],
];
for (const [name, width, height, touch] of matrix) {
  const { context, page } = await open({
    base: CHAT,
    path: "/p/w2-project/s/w2-tools",
    width,
    height,
    touch,
  });
  await page.waitForSelector(".execution-summary, .execution-group", { timeout: 15_000 });
  await assertNoPageOverflow(page, name);
  if (["phone-320x568", "phone-390x844", "phone-landscape-844x390", "tablet-768x1024", "tablet-landscape-1024x768", "desktop-1440x900", "desktop-wide-1920x1080"].includes(name)) {
    await shot(page, `matrix-${name}`);
  }
  await context.close();
}

// Tablet orientation/responsive-mode transitions hand focus between the drawer
// launcher and the equivalent visible sidebar control instead of leaving it
// on hidden legacy chrome.
{
  const { context, page } = await open({
    base: CHAT,
    path: "/p/w2-project/s/w2-tools",
    width: 768,
    height: 1024,
    touch: true,
  });
  const drawer = page.locator(".header-drawer-btn");
  await drawer.focus();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(250);
  assert(await page.evaluate(() =>
    document.activeElement?.matches(".sidebar .sidebar-expand, .sidebar .sidebar-search input")),
  "tablet-to-wide resize moves focus into the visible sidebar");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(250);
  assert(await drawer.evaluate((element) => document.activeElement === element),
    "wide-to-tablet resize returns focus to the drawer launcher");
  await context.close();
}

// Navigation scale and state taxonomy: 100 sessions, long labels, every
// attention state, touch drawer, and a keyboard-open row menu.
{
  const manySessions = async (page) => {
    await page.route(`**/api/sessions?projectId=${project.id}`, async (route) => {
      const response = await route.fetch();
      const source = await response.json();
      const seed = source[0] ?? session;
      const now = Date.now();
      const items = Array.from({ length: 100 }, (_, index) => ({
        ...seed,
        id: `wave5-session-${index}`,
        title: index === 3
          ? "Refactor the extraordinarily long authentication and authorization pipeline across every deployment target"
          : `Production session ${String(index + 1).padStart(3, "0")}`,
        status: index % 9 === 0 ? "working" : "idle",
        updatedAt: now - index * 60_000,
        lastTurnAt: index % 9 === 0 ? now - index * 1_000 : undefined,
        attention: index % 11 === 0
          ? { questions: 1, permissions: 0, unread: 0 }
          : index % 13 === 0
            ? { questions: 0, permissions: 1, unread: 0 }
            : index % 7 === 0
              ? { questions: 0, permissions: 0, unread: 2 }
              : { questions: 0, permissions: 0, unread: 0 },
      }));
      await route.fulfill({ response, json: items });
    });
  };
  const started = Date.now();
  const { context, page } = await open({
    width: 390,
    height: 844,
    touch: true,
    routes: manySessions,
  });
  await page.locator(".session-nav-current").click();
  await page.waitForSelector(".session-row");
  const initialRows = await page.locator(".session-row").count();
  assert(initialRows < 100, "the 100-session drawer initially bounds mounted rows");
  while (await page.locator(".show-more-sessions").count()) {
    await page.locator(".show-more-sessions").click();
  }
  const loadMs = Date.now() - started;
  assert(await page.locator(".session-row").count() === 100, "the drawer renders all 100 fixture sessions");
  assert(loadMs < 5_000, `the 100-session drawer opens promptly (${loadMs}ms)`);
  await assertNoPageOverflow(page, "100-session phone drawer");
  await shot(page, "navigation-phone-100-sessions");
  const menuTrigger = page.locator(".session-menu-trigger").first();
  await menuTrigger.click();
  await page.waitForSelector(".ui-menu-sheet");
  assert(await page.locator(".ui-menu-sheet button").count() >= 6, "phone session actions use the complete sheet");
  await page.keyboard.press("Escape");
  assert(await menuTrigger.evaluate((element) => document.activeElement === element),
    "closing the phone row menu restores focus");
  await context.close();
  console.log("100-session drawer:", initialRows, "initially mounted; expanded in", loadMs, "ms");
}

// Add-project flow: the full-screen phone picker uses shared controls, keeps
// all icon actions reachable, and exposes validation before a folder mutation.
{
  const { context, page } = await open({ width: 320, height: 568, touch: true });
  await page.locator(".session-nav-current").click();
  await page.locator(".sidebar-add-project").click();
  const dialog = page.locator(".folder-dialog");
  await dialog.waitFor();
  const close = dialog.getByRole("button", { name: "Close" });
  const closeHit = await close.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element, "::after").width));
  assert(closeHit >= 44, "the phone project picker close action has a 44px hit target");
  assert(await dialog.locator(".folder-path.ui-input").count() === 1,
    "the project path uses the shared text-input primitive");
  await assertNoPageOverflow(page, "phone add-project picker");
  await shot(page, "navigation-phone-add-project");
  await dialog.getByRole("button", { name: "New folder" }).click();
  assert(await dialog.locator(".folder-newname .ui-btn").isDisabled(),
    "new-folder creation stays disabled until its name is valid");
  await shot(page, "navigation-phone-new-folder-validation");
  await close.click();
  await context.close();
}

// Secondary core dialogs that previously carried legacy button/input chrome.
// They are opened through their production entry points so shared headers,
// form controls, footer actions, overflow, and Escape dismissal are exercised.
{
  const { context, page } = await open({ width: 1280, height: 800, touch: false });
  const composerInput = page.locator(".composer textarea");
  await composerInput.focus();
  await page.keyboard.press("Control+Shift+Enter");
  const focusDialog = page.locator(".composer-focus-dialog.ui-dialog");
  await focusDialog.waitFor();
  assert(await focusDialog.locator(".ui-dialog-head").count() === 1,
    "the focus editor uses shared dialog chrome");
  await assertNoPageOverflow(page, "focused composer dialog");
  await shot(page, "composer-focus-desktop");
  await page.keyboard.press("Escape");
  assert(await composerInput.evaluate((element) => document.activeElement === element),
    "the focus editor restores the composer focus");
  await context.close();
}
{
  const { context, page } = await open({ width: 1440, height: 900, touch: false });
  const activeProjectCard = page.locator(".project-card-shell", {
    has: page.locator(".project-card.active"),
  });
  const openProjectAction = async (label) => {
    await activeProjectCard.hover();
    await activeProjectCard.locator(".project-menu-btn").click();
    await page.locator('[role="menuitem"]', { hasText: label }).click();
  };

  await openProjectAction("Project appearance");
  const appearance = page.locator(".project-appearance-dialog.ui-dialog");
  await appearance.waitFor();
  assert(await appearance.locator(".ui-input").count() >= 2,
    "project appearance uses shared text inputs");
  assert(await appearance.locator(".ui-dialog-foot .ui-btn").count() === 2,
    "project appearance uses shared footer actions");
  await shot(page, "navigation-desktop-project-appearance");
  await page.keyboard.press("Escape");

  await openProjectAction("Import sessions");
  const sessionImport = page.locator(".import-sessions-dialog.ui-dialog");
  await sessionImport.waitFor();
  assert(await sessionImport.locator(".ui-dialog-foot .ui-btn").count() === 2,
    "session import uses shared footer actions");
  await shot(page, "navigation-desktop-session-import");
  await page.keyboard.press("Escape");

  await openProjectAction("New session in worktree");
  const worktree = page.locator(".worktree-session-dialog.ui-dialog");
  await worktree.waitFor();
  await worktree.locator(".ui-input").nth(1).waitFor({ timeout: 10_000 });
  assert(await worktree.locator(".ui-input").count() >= 2,
    "the worktree flow uses shared text inputs");
  assert(await worktree.locator(".ui-dialog-foot .ui-btn").count() === 2,
    "the worktree flow uses shared footer actions");
  await assertNoPageOverflow(page, "worktree session dialog");
  await shot(page, "navigation-desktop-worktree-dialog");
  await page.keyboard.press("Escape");
  await context.close();
}

// Desktop feature surfaces against the real project/server. These are the
// representative Files, Git, Terminal, Browser, Goals, Usage, Knowledge,
// GitHub, Multirun, and Fusion interactions requested by the phase brief.
{
  const { context, page } = await open({ width: 1440, height: 900, touch: false });
  const feature = async (label, selector, name) => {
    const trigger = page.locator(`button[aria-label="${label}"]`).first();
    assert(await trigger.count() === 1, `${label} has a discoverable launcher`);
    await trigger.click();
    await page.waitForSelector(selector, { timeout: 10_000 });
    await page.waitForTimeout(450);
    await assertNoPageOverflow(page, name);
    await shot(page, `feature-desktop-${name}`);
    await closePane(page, label);
  };
  await feature("Project files", ".editor-view", "files");
  await feature("Open Terminal (Ctrl+`)", ".term-view", "terminal");
  await feature("Browser", ".preview-view", "browser");
  await feature("Goals & progress", ".goals-page", "goals");

  const railFeature = async (label, selector, name) => {
    const trigger = page.locator(`.rail-icon[aria-label="${label}"]`).first();
    assert(await trigger.count() === 1, `${label} has a discoverable rail launcher`);
    await trigger.click();
    await page.waitForSelector(selector, { timeout: 10_000 });
    await page.waitForTimeout(450);
    await assertNoPageOverflow(page, name);
    await shot(page, `feature-desktop-${name}`);
    await trigger.click();
  };
  await railFeature("Usage", ".usage-dashboard", "usage");
  await railFeature("Knowledge", ".knowledge-panel", "knowledge");
  await railFeature("GitHub", ".github-page", "github");
  await railFeature("Compare responses", ".multirun-page, .view-page", "multirun");
  await railFeature("Combine drafts", ".fusion-page, .view-page", "fusion");

  // Git is launched contextually from the project menu.
  const activeProjectCard = page.locator(".project-card-shell", {
    has: page.locator(`.project-card.active`),
  });
  await activeProjectCard.hover();
  const projectMenu = activeProjectCard.locator(".project-menu-btn");
  await projectMenu.click();
  await page.locator('[role="menuitem"]', { hasText: "Source control" }).click();
  await page.waitForSelector(".git-page", { timeout: 10_000 });
  await assertNoPageOverflow(page, "git");
  await shot(page, "feature-desktop-git");
  await context.close();
}

// Mobile feature panels exercise the full-screen/panel adaptation rather than
// merely shrinking desktop screenshots.
for (const [label, selector, name] of [
  ["Project files", ".editor-view", "files"],
  ["Browser", ".preview-view", "browser"],
  ["Terminal", ".term-view", "terminal"],
]) {
  const { context, page } = await open({ width: 390, height: 844, touch: true });
  const trigger = page.locator(`button[aria-label="${label}"]`).first();
  await trigger.click();
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.waitForTimeout(450);
  await assertNoPageOverflow(page, `${name} phone`);
  await shot(page, `feature-phone-${name}`);
  await context.close();
}

// Settings: every visible page, item-search keyboard navigation, long German
// copy, RTL direction, and the explicit mobile nav -> detail interaction.
{
  const { context, page } = await open({ width: 1440, height: 900, touch: false, locale: "de" });
  await page.locator('button[aria-label="Einstellungen"], button[aria-label="Settings"]').first().click();
  await page.waitForSelector(".settings-shell");
  const items = page.locator(".settings-nav-item");
  const count = await items.count();
  assert(count >= 9, "settings exposes built-in and package pages");
  for (let index = 0; index < count; index++) {
    await items.nth(index).click();
    await page.waitForTimeout(80);
    await assertNoPageOverflow(page, `settings page ${index + 1}`);
  }
  await items.first().click();
  await shot(page, "settings-desktop-long-labels");
  const search = page.locator(".settings-nav-search");
  await search.fill("Modell");
  await search.press("ArrowDown");
  await search.press("Enter");
  await page.waitForTimeout(250);
  assert(await page.locator(".settings-pane-body :focus").count() === 1,
    "settings search moves focus to the selected control");
  await page.evaluate(() => { document.documentElement.dir = "rtl"; });
  await assertNoPageOverflow(page, "settings RTL");
  await shot(page, "settings-desktop-rtl");
  await context.close();
}
{
  const { context, page } = await open({ width: 320, height: 568, touch: true });
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.waitForSelector(".settings-mobile-nav");
  assert(await page.locator(".settings-shell").evaluate((element) => getComputedStyle(element).borderRadius) === "0px",
    "full-screen phone settings does not inherit the user-selected sheet radius");
  await assertNoPageOverflow(page, "settings navigation at 320");
  await shot(page, "settings-phone-navigation");
  await page.locator(".settings-nav-item").first().click();
  await page.waitForSelector(".settings-mobile-page");
  await assertNoPageOverflow(page, "settings detail at 320");
  await shot(page, "settings-phone-detail");
  const back = page.locator(".settings-mobile-back");
  await back.click();
  assert(await page.locator(".settings-mobile-nav").count() === 1, "settings Back returns to page navigation");
  await page.keyboard.press("Escape");
  assert(await page.locator(".settings-shell").count() === 0, "Escape closes mobile settings from navigation");
  await context.close();
}

// Destructive Settings actions stay behind the shared confirmation dialog,
// whose Escape path restores focus without mutating project data.
{
  const { context, page } = await open({ width: 1440, height: 900, touch: false });
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".settings-nav-item", { hasText: "Projects" }).click();
  const remove = page.locator(".settings-pane .ui-btn--danger", { hasText: "Remove" }).first();
  await remove.click();
  const dialog = page.locator(".alert-dialog");
  await dialog.waitFor();
  assert(await dialog.locator(".ui-dialog-head").count() === 1,
    "destructive confirmation uses shared dialog chrome");
  assert(await dialog.locator(".alert-confirm.ui-btn--danger").count() === 1,
    "the destructive confirmation is visually and programmatically distinct");
  await shot(page, "settings-desktop-danger-confirmation");
  await page.keyboard.press("Escape");
  assert(await remove.evaluate((element) => document.activeElement === element),
    "closing a destructive confirmation restores focus to its trigger");
  await context.close();
}

// Agent questions: card presentation, native option semantics, roving tab
// keyboard behavior, and touch geometry at the narrowest supported phone.
{
  const { context, page } = await open({
    base: CHAT,
    path: "/p/w2-project/s/w2-questions",
    width: 320,
    height: 568,
    touch: true,
  });
  const card = page.locator(".question-card");
  await card.waitFor();
  const tabs = card.getByRole("tab");
  assert(await tabs.count() === 3, "the complete multi-question stepper is available");
  const cardBox = await card.boundingBox();
  assert(cardBox && cardBox.width >= 290, "the question card does not double-apply phone gutters");
  const cards = page.locator(".question-cards");
  assert(await cards.evaluate((element) => element.scrollHeight > element.clientHeight),
    "long agent questions use a bounded internal scroll region");
  await shot(page, "questions-phone");
  const firstOption = card.getByRole("radio", { name: "Internal team" });
  await firstOption.check();
  assert(await firstOption.isChecked(), "single-choice questions retain native radio behavior");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  assert(await tabs.nth(1).getAttribute("aria-selected") === "true", "ArrowRight selects the next question");
  assert(await tabs.nth(1).evaluate((element) => document.activeElement === element),
    "question tab keyboard navigation keeps focus with the selected tab");
  const tabBox = await tabs.nth(1).boundingBox();
  assert(tabBox && tabBox.width >= 44 && tabBox.height >= 44, "question tabs retain 44px touch targets");
  const actions = page.locator(".question-actions");
  await actions.scrollIntoViewIfNeeded();
  const [actionsBox, composerBox] = await Promise.all([
    actions.boundingBox(),
    page.locator(".composer").boundingBox(),
  ]);
  assert(actionsBox && composerBox && actionsBox.y + actionsBox.height <= composerBox.y,
    "question decisions remain reachable above the fixed composer");
  await assertNoPageOverflow(page, "agent questions at 320");
  await shot(page, "questions-phone-actions");
  await context.close();
}
{
  const { context, page } = await open({
    base: CHAT,
    path: "/p/w2-project/s/w2-questions",
    width: 1440,
    height: 900,
    touch: false,
  });
  await page.waitForSelector(".question-card");
  await assertNoPageOverflow(page, "agent questions desktop");
  await shot(page, "questions-desktop");
  await context.close();
}

// Tablet picker behavior is validated separately from phone-sheet and
// desktop-popover paths so the 768px interaction band cannot regress unseen.
{
  const { context, page } = await open({
    base: PICKER,
    path: "/p/w3a-project",
    width: 768,
    height: 1024,
    touch: true,
  });
  await page.locator(".composer textarea").click();
  await page.locator(".model-picker-trigger").click();
  await page.waitForSelector(".sheet, .model-pop");
  await assertNoPageOverflow(page, "model picker tablet");
  await shot(page, "picker-tablet");
  await context.close();
}

// Model picker while the visual keyboard is active. The primary action must
// stay in the visual band and Escape must restore focus to the trigger.
{
  const { context, page } = await open({
    base: PICKER,
    path: "/p/w3a-project",
    width: 390,
    height: 844,
    touch: true,
  });
  const input = page.locator(".composer textarea");
  await input.click();
  const trigger = page.locator(".model-picker-trigger");
  await trigger.click();
  await page.waitForSelector(".sheet");
  await page.locator(".sheet-search input").focus();
  await page.evaluate(() => {
    document.body.dataset.keyboard = "open";
    document.body.dataset.band = "short";
    document.documentElement.style.setProperty("--visual-vh", "524px");
    document.documentElement.style.setProperty("--visual-bottom", "524px");
    document.documentElement.style.setProperty("--keyboard-inset", "320px");
  });
  await page.waitForTimeout(250);
  const sheet = await page.locator(".sheet").boundingBox();
  assert(sheet && sheet.y + sheet.height <= 524, "the model sheet stays above the keyboard");
  await assertNoPageOverflow(page, "model picker with keyboard");
  await shot(page, "picker-phone-keyboard");
  await page.keyboard.press("Escape");
  assert(await trigger.evaluate((element) => document.activeElement === element),
    "picker Escape restores focus to its trigger");
  await context.close();
}

await browser.close();
assert(diagnostics.length === 0, `browser diagnostics were emitted:\n${diagnostics.join("\n")}`);
console.log("Wave 5 product QA passed ->", OUT);
