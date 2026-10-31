import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/", width: 1280, height: 800 });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "" }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const intro = await import("../src/shellIntro.ts");
const { applyProjectUpsert, getState, setOverlay } = await import("../src/store.ts");
const { wasAutoPickerOffered, resetAutoPickerEpisodeForTest } = await import("../src/projectOnboarding.ts");
const { default: ShellIntroTour } = await import("../src/components/ShellIntroTour.tsx");

const admission = (overrides: Partial<Parameters<typeof intro.decideShellIntroAdmission>[0]> = {}) =>
  intro.decideShellIntroAdmission({
    settingsSettled: true,
    seen: false,
    registryStatus: "ready",
    overlayOpen: false,
    offeredThisDocument: false,
    ...overrides,
  });

test("admission waits for the account snapshot and the registry, then opens once", () => {
  assert.equal(admission(), "open");
  assert.equal(admission({ settingsSettled: false }), "wait", "a second device must learn the account already saw it");
  assert.equal(admission({ registryStatus: "loading" }), "wait", "the rails are not painted yet");
  assert.equal(admission({ overlayOpen: true }), "wait", "never stacks over another overlay");
  assert.equal(admission({ seen: true }), "done");
  assert.equal(admission({ seen: true, settingsSettled: false }), "done", "a seen tour never holds the picker");
  assert.equal(admission({ offeredThisDocument: true }), "done");
  assert.equal(admission({ registryStatus: "failed" }), "done", "a registry failure is a recovery screen");
});

test("the seen record is validated, persisted and monotonic", () => {
  intro.resetShellIntroForTest();
  localStorage.removeItem(intro.SHELL_INTRO_PREFS_KEY);
  assert.deepEqual(intro.parseShellIntroPrefs(null), { seenVersion: 0 });
  assert.deepEqual(intro.parseShellIntroPrefs("{\"seenVersion\":\"1\"}"), { seenVersion: 0 });
  assert.deepEqual(intro.parseShellIntroPrefs("{\"seenVersion\":-3}"), { seenVersion: 0 });
  assert.deepEqual(intro.parseShellIntroPrefs("not json"), { seenVersion: 0 });
  assert.equal(intro.isShellIntroSeen(), false);

  intro.markShellIntroSeen();
  assert.equal(intro.isShellIntroSeen(), true);
  assert.deepEqual(JSON.parse(localStorage.getItem(intro.SHELL_INTRO_PREFS_KEY) ?? ""), { seenVersion: intro.SHELL_INTRO_VERSION });

  // A stale device syncing an older record cannot bring the tour back.
  intro.replaceShellIntroPrefs({ seenVersion: 0 });
  assert.equal(intro.isShellIntroSeen(), true);
  intro.replaceShellIntroPrefs({ seenVersion: intro.SHELL_INTRO_VERSION + 1 });
  assert.equal(intro.getShellIntroPrefs().seenVersion, intro.SHELL_INTRO_VERSION + 1);
  intro.resetShellIntroForTest();
  localStorage.removeItem(intro.SHELL_INTRO_PREFS_KEY);
});

test("the tour starts at the composer, then covers every rail, dragging, adding projects and both kinds of customization", () => {
  const ids = intro.SHELL_INTRO_STEPS.map((step) => step.id);
  assert.deepEqual(ids, ["welcome", "start", "projects", "add-project", "project-ready", "top-rail", "right-rail", "drag", "customize", "appearance"]);
  assert.equal(
    intro.shellIntroSteps({ canAddProject: true }).some((step) => step.id === "project-ready"),
    false,
    "the project-ready step only follows a project added from the tour",
  );
  const anchors = Object.fromEntries(intro.SHELL_INTRO_STEPS.map((step) => [step.id, step.anchors]));
  assert.equal(anchors.start?.[0], ".composer-chat .composer-card", "work starts right away, without choosing a folder");
  assert.equal(anchors.projects?.[0], ".sidebar:not(.collapsed) .sidebar-expanded-shell");
  assert.equal(anchors["add-project"]?.[0], "[data-intro-anchor=\"add-project\"]");
  assert.equal(anchors["top-rail"]?.[0], ".view-switcher-pill");
  assert.equal(anchors["right-rail"]?.[0], ".plugin-strip");
  assert.equal(anchors.appearance?.[0], "[data-intro-anchor=\"settings\"]");
  assert.deepEqual(
    intro.shellIntroSteps({ canAddProject: false }).map((step) => step.id).includes("add-project"),
    false,
    "an account that cannot add projects is not pointed at a missing button",
  );
});

test("the phone tour points at the phone shell and drops what it does not have", () => {
  const phone = intro.shellIntroSteps({ canAddProject: true, phone: true });
  assert.deepEqual(phone.map((step) => step.id), ["welcome", "start", "projects", "add-project", "top-rail", "customize", "appearance"],
    "no right rail and no drag between rails on a phone");
  const byId = Object.fromEntries(phone.map((step) => [step.id, step]));
  assert.equal(byId.projects?.title, "shellintro.projectsPhoneTitle");
  assert.deepEqual(byId.projects?.anchors, [".mobile-float-navigation"]);
  assert.equal(byId["top-rail"]?.title, "shellintro.toolsPhoneTitle");
  assert.equal(byId.customize?.body, "shellintro.customizePhoneBody");
  assert.deepEqual(byId.customize?.anchors, [], "there is no Edit mode menu to point at on a phone");
  assert.deepEqual(
    intro.shellIntroSteps({ canAddProject: true, projectAdded: true }).map((step) => step.title),
    intro.SHELL_INTRO_STEPS.map((step) => step.title),
  );
  const ready = intro.shellIntroSteps({ canAddProject: true, phone: true, projectAdded: true }).find((step) => step.id === "project-ready");
  assert.equal(ready?.body, "shellintro.projectReadyPhoneBody");
  assert.deepEqual(ready?.anchors, [".mobile-float-navigation"]);
});

test("a window without the top bar tours one Tools column and finds the docked Settings", () => {
  const barless = intro.shellIntroSteps({ canAddProject: true, barless: true });
  assert.deepEqual(barless.map((step) => step.id), ["welcome", "start", "projects", "add-project", "top-rail", "drag", "customize", "appearance"],
    "the launcher strip holds every tool, so there is no separate right-rail step");
  const byId = Object.fromEntries(barless.map((step) => [step.id, step]));
  assert.equal(byId["top-rail"]?.title, "shellintro.toolsTitle");
  assert.equal(byId["top-rail"]?.body, "shellintro.topRailBody");
  assert.deepEqual(byId["top-rail"]?.anchors, [
    ".plugin-strip:has(.shell-dock--tools [data-rail-item])",
    ".shell-dock--tools:has([data-rail-item])",
    ".plugin-strip",
  ], "the column holding the tools; never an empty dock's sliver");
  // Docked header actions hide the rail's own gear; the tour follows Settings.
  assert.ok(byId.appearance?.anchors.includes("[data-rail-item=\"widget:shell.settings\"]"));
  // Without any project (none could be made) there is no composer to start in.
  assert.equal(intro.shellIntroSteps({ canAddProject: true, hasProject: false }).some((step) => step.id === "start"), false);
  assert.equal(intro.shellIntroSteps({ canAddProject: true, hasProject: true }).some((step) => step.id === "start"), true);
  // The phone keeps its own variant even when the saved layout is bare.
  assert.deepEqual(
    intro.shellIntroSteps({ canAddProject: true, phone: true, barless: true }).map((step) => step.title),
    intro.shellIntroSteps({ canAddProject: true, phone: true }).map((step) => step.title),
  );
});

test("the card sits beside its target on the preferred side and stays on screen", () => {
  const viewport = { width: 1280, height: 800 };
  const card = { width: 360, height: 260 };
  const leftRail = { left: 0, top: 40, width: 49, height: 760 };
  const right = intro.placeIntroCard(leftRail, card, viewport, "right");
  assert.equal(right.side, "right");
  assert.equal(right.left, 49 + intro.INTRO_ARROW_GAP);
  assert.ok(right.top >= intro.INTRO_VIEWPORT_MARGIN && right.top + card.height <= viewport.height - intro.INTRO_VIEWPORT_MARGIN);

  const rightRail = { left: 1239, top: 40, width: 41, height: 760 };
  assert.equal(intro.placeIntroCard(rightRail, card, viewport, "left").side, "left");
  // Preferring right where there is no room falls back to the opposite side.
  assert.equal(intro.placeIntroCard(rightRail, card, viewport, "right").side, "left");

  const topRail = { left: 500, top: 6, width: 280, height: 34 };
  const below = intro.placeIntroCard(topRail, card, viewport, "bottom");
  assert.equal(below.side, "bottom");
  assert.equal(below.top, 40 + intro.INTRO_ARROW_GAP);
  assert.equal(below.left, Math.round(640 - 180));

  assert.equal(intro.placeIntroCard(null, card, viewport, "bottom").side, "center");

  // A phone: nothing fits beside a full-width bar near the top, so the card
  // takes the free band at the bottom instead of covering the target.
  const phone = { width: 390, height: 520 };
  const bar = { left: 0, top: 0, width: 390, height: 300 };
  const fallback = intro.placeIntroCard(bar, { width: 366, height: 200 }, phone, "bottom");
  assert.equal(fallback.side, "center");
  assert.equal(fallback.top, 520 - 200 - intro.INTRO_VIEWPORT_MARGIN);
});

test("the arrow runs from the card edge to just outside the target", () => {
  const card = { left: 105, top: 270, width: 360, height: 260 };
  const target = { left: 0, top: 380, width: 49, height: 40 };
  const arrow = intro.introArrowPath(card, target);
  assert.ok(arrow);
  const numbers = arrow.line.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const [sx, sy] = numbers;
  const [ex, ey] = numbers.slice(-2);
  assert.equal(sx, 105, "starts on the card's leading edge");
  assert.equal(sy, 400, "level with the target centre");
  assert.equal(ex, 59, "ends at the padded target edge");
  assert.ok(ey! >= 370 && ey! <= 430);
  assert.match(arrow.head, /^M [\d.-]+ [\d.-]+ L 59 [\d.]+ L [\d.-]+ [\d.-]+$/);
  assert.equal(intro.introArrowPath(card, { left: 120, top: 300, width: 40, height: 40 }), null, "no arrow when they overlap");
});

function stubRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => rect,
    }),
  });
}

async function mountTour() {
  // A new account's Personal project: the composer is there to start in.
  applyProjectUpsert({ id: "tour-personal", path: "/spaces/s/personal/p", name: "Personal", createdAt: 1, personal: true });
  intro.resetShellIntroForTest();
  localStorage.removeItem(intro.SHELL_INTRO_PREFS_KEY);
  resetAutoPickerEpisodeForTest();
  setOverlay(null);
  const app = document.createElement("div");
  app.className = "app";
  const shell = document.createElement("div");
  shell.className = "app-shell";
  const sidebar = document.createElement("nav");
  sidebar.className = "sidebar";
  const navigator = document.createElement("div");
  navigator.className = "sidebar-expanded-shell";
  stubRect(navigator, { left: 0, top: 40, width: 49, height: 760 });
  const add = document.createElement("button");
  add.dataset.introAnchor = "add-project";
  stubRect(add, { left: 6, top: 700, width: 36, height: 36 });
  navigator.append(add);
  sidebar.append(navigator);
  const composer = document.createElement("div");
  composer.className = "composer composer-chat";
  stubRect(composer, { left: 340, top: 610, width: 1100, height: 180 });
  const composerCard = document.createElement("div");
  composerCard.className = "composer-card";
  stubRect(composerCard, { left: 400, top: 620, width: 640, height: 160 });
  composer.append(composerCard);
  shell.append(sidebar, composer);
  const host = document.createElement("div");
  app.append(shell, host);
  document.body.appendChild(app);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(ShellIntroTour)); });
  return {
    async cleanup() {
      await act(async () => { root.unmount(); });
      app.remove();
      intro.resetShellIntroForTest();
      localStorage.removeItem(intro.SHELL_INTRO_PREFS_KEY);
      setOverlay(null);
    },
  };
}

const card = () => document.querySelector<HTMLElement>(".shell-intro-card");
const button = (pattern: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>(".shell-intro-card button")].find((b) => pattern.test(b.textContent ?? ""));

test("mounted tour walks the steps with a spotlight and arrow, then records that it was seen", async () => {
  const mounted = await mountTour();
  try {
    assert.equal(card(), null, "nothing renders until the tour opens");
    await act(async () => { intro.openShellIntro({ auto: true }); });
    assert.equal(getState().overlay, "onboarding", "the tour owns the overlay so no other modal stacks with it");
    const dialog = card();
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(dialog.textContent ?? "", /Welcome to Polyth/);
    assert.ok(document.querySelector(".shell-intro-scrim"), "the welcome step has no target: full scrim, centred card");
    assert.equal(document.querySelector(".shell-intro-arrow"), null);
    assert.ok(document.querySelector(".shell-intro-media svg"), "the welcome step shows the shell schematic");

    await act(async () => { button(/Show me around/)!.click(); });
    assert.match(card()!.textContent ?? "", /Start right here/);
    assert.equal(document.querySelectorAll(".shell-intro-media").length, 0, "only illustrated steps show art");
    assert.equal(document.querySelector<HTMLElement>(".shell-intro-spotlight")?.style.left, "394px", "the composer is framed");
    assert.equal(document.querySelector(".shell-intro")?.getAttribute("data-placement"), "top");

    await act(async () => { button(/^Next$/)!.click(); });
    assert.match(card()!.textContent ?? "", /Chats and projects/);
    const spotlight = document.querySelector<HTMLElement>(".shell-intro-spotlight");
    assert.ok(spotlight, "the Navigator is framed");
    assert.equal(spotlight.style.left, "-6px");
    assert.equal(spotlight.style.width, "61px");
    assert.equal(document.querySelector(".shell-intro")?.getAttribute("data-placement"), "right");
    assert.ok(document.querySelector(".shell-intro-arrow-line")?.getAttribute("d")?.startsWith("M "), "an arrow points at the rail");

    await act(async () => { button(/^Next$/)!.click(); });
    assert.match(card()!.textContent ?? "", /Projects, when you need them/);
    assert.equal(document.querySelector<HTMLElement>(".shell-intro-spotlight")?.style.top, "694px");

    // Arrow keys move through the tour as well.
    await act(async () => {
      card()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    });
    // A fresh window has no top bar: one Tools step stands for both rails.
    assert.match(card()!.textContent ?? "", /Tools/);
    assert.doesNotMatch(card()!.textContent ?? "", /Tools at the top/);
    assert.ok(document.querySelector(".shell-intro-scrim"), "a rail that is not on screen centres the card instead of pointing at nothing");

    const dots = document.querySelectorAll(".shell-intro-dot");
    assert.equal(dots.length, intro.SHELL_INTRO_STEPS.length - 2, "no separate right-rail step, no project-ready step");
    await act(async () => { (dots[dots.length - 1] as HTMLButtonElement).click(); });
    assert.match(card()!.textContent ?? "", /Make it look your way/);
    assert.ok(button(/Open Appearance/));
    assert.equal(intro.isShellIntroSeen(), false);

    await act(async () => { button(/Start working/)!.click(); });
    assert.equal(card(), null);
    assert.equal(intro.isShellIntroSeen(), true, "finishing records the tour for the account");
    assert.equal(getState().overlay, null, "the overlay is released for the first-run picker");
  } finally {
    await mounted.cleanup();
  }
});

test("every step offers the interface language, and switching it keeps the tour on its step", async () => {
  const i18n = await import("../src/i18n/index.ts");
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro({ auto: true }); });
    const languageButton = () => card()!.querySelector<HTMLButtonElement>(".shell-intro-language");
    assert.ok(languageButton(), "the welcome step already has the language picker");
    assert.equal(languageButton()!.textContent, "English", "it names the current language");
    assert.equal(languageButton()!.getAttribute("aria-label"), "Language: English");
    await act(async () => { button(/Show me around/)!.click(); });
    assert.ok(languageButton(), "later steps keep it");

    await act(async () => { languageButton()!.click(); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
    assert.deepEqual(
      items.map((item) => item.textContent?.trim()),
      [`System (${i18n.LOCALE_NAMES[i18n.systemLocale()]})`, ...i18n.LOCALES.map((locale) => i18n.LOCALE_NAMES[locale])],
    );
    assert.equal(items[0]!.getAttribute("aria-checked"), "true", "the system language is the default");

    // Arrow keys inside the menu belong to the menu, not to the tour.
    await act(async () => {
      items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    });
    assert.equal(intro.getShellIntroState()?.step, 1);

    const ukrainian = items.find((item) => item.textContent?.trim() === i18n.LOCALE_NAMES.uk)!;
    await act(async () => { ukrainian.click(); });
    await act(async () => { await i18n.ensureLocale("uk"); });
    assert.equal(i18n.getLocale(), "uk");
    assert.equal(localStorage.getItem("polyth.locale"), "uk", "an explicit pick is remembered");
    assert.equal(intro.getShellIntroState()?.step, 1, "the tour stays on the step it was on");
    assert.equal(languageButton()!.textContent, i18n.LOCALE_NAMES.uk);
    assert.equal(getState().overlay, "onboarding");
  } finally {
    await act(async () => { await i18n.setLocale("system"); });
    await mounted.cleanup();
  }
});

test("Escape dismisses the tour for good", async () => {
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro({ auto: true }); });
    await act(async () => {
      card()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    assert.equal(card(), null);
    assert.equal(intro.isShellIntroSeen(), true);
    assert.equal(intro.wasShellIntroOffered(), true);
  } finally {
    await mounted.cleanup();
  }
});

test("the add-project step hands over to the picker exactly once", async () => {
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro({ auto: true }); });
    await act(async () => { intro.setShellIntroStep(3, intro.SHELL_INTRO_STEPS.length); });
    assert.match(card()!.textContent ?? "", /The tour continues when you’re done/);
    await act(async () => { button(/Add a project now/)!.click(); });
    assert.equal(card(), null);
    assert.equal(getState().overlay, "project-picker");
    assert.equal(wasAutoPickerOffered(), true, "cancelling that picker does not reopen it automatically");
    assert.equal(intro.isShellIntroSeen(), true, "a reload does not restart the tour");
    assert.equal(intro.isShellIntroSuspended(), true, "the tour waits for the dialog instead of ending");
  } finally {
    await mounted.cleanup();
  }
});

test("adding a project from the tour continues it on a project-ready step", async () => {
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro({ auto: true }); });
    await act(async () => { intro.setShellIntroStep(3, intro.SHELL_INTRO_STEPS.length); });
    await act(async () => { button(/Add a project now/)!.click(); });
    // The project dialog adds and activates a project, then closes.
    applyProjectUpsert({ id: "tour-added", path: "/home/me/site", name: "Site", createdAt: 2 });
    await act(async () => { setOverlay(null); });
    await act(async () => { intro.resumeShellIntro(getState().projectRegistry.projects.map((project) => project.id)); });
    assert.equal(intro.isShellIntroSuspended(), false);
    assert.equal(getState().overlay, "onboarding", "the resumed tour owns the overlay again");
    assert.match(card()!.textContent ?? "", /Your project is ready/);
    const dots = [...document.querySelectorAll(".shell-intro-dot")];
    assert.equal(dots.findIndex((dot) => dot.getAttribute("aria-current") === "step"), 4, "right after the add-project step");
    await act(async () => { button(/^Next$/)!.click(); });
    assert.match(card()!.textContent ?? "", /Tools/, "and the tour goes on from there");
    await act(async () => { button(/^Back$/)!.click(); });
    await act(async () => { button(/^Back$/)!.click(); });
    assert.match(card()!.textContent ?? "", /Projects, when you need them/, "earlier steps stay reachable");
  } finally {
    await mounted.cleanup();
  }
});

test("closing the project dialog without adding one continues with the next step", async () => {
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro({ auto: true }); });
    await act(async () => { intro.setShellIntroStep(3, intro.SHELL_INTRO_STEPS.length); });
    await act(async () => { button(/Add a project now/)!.click(); });
    await act(async () => { setOverlay(null); });
    await act(async () => { intro.resumeShellIntro(getState().projectRegistry.projects.map((project) => project.id)); });
    assert.doesNotMatch(card()!.textContent ?? "", /Your project is ready/);
    assert.match(card()!.textContent ?? "", /Tools/);
    const dots = [...document.querySelectorAll(".shell-intro-dot")];
    assert.equal(dots.length, intro.SHELL_INTRO_STEPS.length - 2);
    assert.equal(dots.findIndex((dot) => dot.getAttribute("aria-current") === "step"), 4);
  } finally {
    await mounted.cleanup();
  }
});

test("a resume lands by step id, and replaying the tour drops a pending resume", () => {
  intro.resetShellIntroForTest();
  const withReady = intro.shellIntroSteps({ canAddProject: true, projectAdded: true });
  assert.equal(withReady[intro.shellIntroResumeIndex(withReady, "add-project")]?.id, "project-ready");
  const phone = intro.shellIntroSteps({ canAddProject: true, phone: true });
  assert.equal(phone[intro.shellIntroResumeIndex(phone, "add-project")]?.id, "top-rail");
  const last = intro.shellIntroSteps({ canAddProject: true });
  assert.equal(intro.shellIntroResumeIndex(last, "appearance"), last.length - 1, "past the end clamps to the last step");

  intro.openShellIntro({ auto: true });
  intro.suspendShellIntro("add-project", []);
  intro.openShellIntro();
  assert.equal(intro.isShellIntroSuspended(), false);
  assert.equal(intro.getShellIntroState()?.resumeAfter, undefined);
  intro.resumeShellIntro(["x"]);
  assert.equal(intro.getShellIntroState()?.projectAdded, undefined, "a stale resume cannot replace a replay");
  intro.resetShellIntroForTest();
});

test("another overlay taking over ends the tour instead of stacking", async () => {
  const mounted = await mountTour();
  try {
    await act(async () => { intro.openShellIntro(); });
    assert.equal(getState().overlay, "onboarding");
    await act(async () => { setOverlay("settings"); });
    assert.equal(card(), null);
    assert.equal(getState().overlay, "settings");
    assert.equal(intro.isShellIntroSeen(), true);
  } finally {
    await mounted.cleanup();
  }
});

test("the shell runs the tour before the first-run picker and syncs it with the account", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(introAdmission === "open"\) openShellIntro\(\{ auto: true \}\)/);
  assert.match(app, /surface === "project-picker" && overlay === null && introAdmission === "done"/,
    "the automatic picker waits for the tour");
  assert.match(app, /<ShellIntroTour \/>/);
  assert.match(app, /if \(!introSuspended \|\| overlay !== null\) return;/,
    "a tour paused for the project dialog resumes once no overlay is open");
  assert.match(app, /resumeShellIntro\(getState\(\)\.projectRegistry\.projects\.map/);
  const sync = await readFile(new URL("../src/settingsSync.ts", import.meta.url), "utf8");
  assert.match(sync, /register\(SHELL_INTRO_PREFERENCE_ID, \{/);
  assert.match(sync, /markSettled\(\);\n    \}\)\n    \.catch\(\(\) => \{\n      markSettled\(\);/);
  const header = await readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8");
  assert.match(header, /id: "interface-tour".*openShellIntro\(\)/, "the tour can be replayed from the user menu");
  const shell = await readFile(new URL("../src/shell.ts", import.meta.url), "utf8");
  assert.match(shell, /id: "cmd\.interfaceTour"/, "and from the command palette");
});
